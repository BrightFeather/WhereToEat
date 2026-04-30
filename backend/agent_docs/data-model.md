# Backend Data Model

Schema is defined in `backend/scripts/migrate.ts` (local SQLite) and the cloud equivalent invoked by `npm run migrate:cloud`. Both run idempotently via `CREATE TABLE IF NOT EXISTS` + repeat-safe `ALTER TABLE ADD COLUMN`.

## Tables

### `pipeline_runs`

`backend/scripts/migrate.ts:27-37`

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | UUID |
| `city` | TEXT | e.g. `nyc` |
| `status` | TEXT | `running` / `completed` / `failed` |
| `started_at` | TEXT | ISO string |
| `completed_at` | TEXT | ISO string when status flips to `completed` |
| `post_count` | INTEGER | XHS posts seen |
| `restaurant_count` | INTEGER | canonical rows produced |
| `error_message` | TEXT | populated when `status='failed'` |

Index: `idx_pipeline_runs_city_status (city, status, started_at)` (`:71-75`).

`weekly.ts:184-190` reaps stale `running` rows older than 10 minutes (Hobby-cap survivors).

### `xhs_restaurants` — canonical restaurant

`migrate.ts:41-62` + idempotent column adds at `:117-137`.

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | UUID |
| `city` | TEXT NOT NULL | dedup axis |
| `restaurant_name` | TEXT NOT NULL | canonical name |
| `address` | TEXT | from Places |
| `borough` | TEXT | Manhattan / Brooklyn / Queens / Bronx / Staten Island |
| `neighborhood` | TEXT | Places `neighborhood` / sublocality |
| `cuisine_type` | TEXT | one `CuisineKey` |
| `recommendation` | TEXT | denormalised "best snippet" |
| `post_url` | TEXT | denormalised "best post URL" |
| `post_created_at` | TEXT | ISO |
| `mention_count` | INTEGER | from `xhs_sources.COUNT(*)` |
| `total_likes` | INTEGER | sum across sources |
| `google_place_id` | TEXT | dedup axis |
| `google_maps_url` | TEXT | required field for "available this week" |
| `google_display_name` | TEXT | Places display name |
| `website_url` | TEXT | Places `websiteUri` |
| `photo_url` | TEXT | first photo (back-compat) |
| `is_available_this_week` | INTEGER | 0/1; flipped to 0 by `[id]/unavailable.ts` |
| `pipeline_run_id` | TEXT FK | the run that produced this row |
| `created_at` | TEXT | |
| `photo_urls` | TEXT (JSON) | up to 5 |
| `resy_venue_id`, `resy_booking_url` | TEXT | Resy match |
| `opentable_rid`, `opentable_booking_url` | TEXT | OpenTable match |
| `features` | TEXT (JSON) | array of `FeatureKey` |
| `google_rating` | REAL | Places `rating` |
| `google_user_rating_count` | INTEGER | Places `userRatingCount` |
| `instagram_url` | TEXT | best-effort website scrape |
| `latitude`, `longitude` | REAL | WGS84 |
| `price_level` | TEXT | Places New API enum (`PRICE_LEVEL_INEXPENSIVE`/`MODERATE`/`EXPENSIVE`/`VERY_EXPENSIVE`); iOS maps to $/$$/$$$/$$$$ |

**Canonical dedup key:** `(city, google_place_id)` under partial UNIQUE index `idx_xhs_restaurants_city_placeid` where `google_place_id IS NOT NULL` (`migrate.ts:110-114`). Rows without a place id fall back to `INSERT` and are deduped on next merge by normalised name.

Index: `idx_xhs_restaurants_city_run (city, pipeline_run_id)` (`:65-68`).

### `xhs_sources` — multi-source attribution

`migrate.ts:78-87` + idempotent column adds at `:143-153`.

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | UUID |
| `restaurant_id` | TEXT FK | → `xhs_restaurants.id` |
| `post_url` | TEXT NOT NULL | the source post |
| `recommendation` | TEXT | verbatim creator quote / editor blurb |
| `likes` | INTEGER | 0 for editorial sources |
| `post_created_at` | TEXT | ISO |
| `created_at` | TEXT | |
| `source_type` | TEXT NOT NULL | `xiaohongshu` / `eater` / `resy_blog` (default `'xiaohongshu'`) |
| `source_title` | TEXT | post / article headline |
| `author` | TEXT | creator handle / editor byline |

**Per-source idempotency:** `idx_xhs_sources_restaurant_post (restaurant_id, post_url)` UNIQUE (`migrate.ts:99-101`) — lets writers `ON CONFLICT (restaurant_id, post_url) DO UPDATE` for re-seen posts.

Index: `idx_xhs_sources_restaurant (restaurant_id)` (`:91-93`).

For non-XHS sources, `recommendation` is structurally extracted (not LLM-generated) — see `backend/agent_docs/parsing-pipeline.md` § Author quote contract.

### `users`

`migrate.ts:156-163` + idempotent auth columns at `:206-218`.

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | Keychain UUID for anonymous; verified subject id post-login |
| `display_name` | TEXT | from sign-in |
| `created_at`, `last_seen_at` | TEXT | upserted by `withUser` (`backend/api/_lib/withUser.ts:27-30`) |
| `auth_provider` | TEXT NOT NULL | `anonymous` / `apple` / `google` (default `'anonymous'`) |
| `apple_sub` | TEXT | Apple subject id |
| `google_sub` | TEXT | Google subject id |
| `email` | TEXT | from sign-in |
| `email_verified` | INTEGER | 0/1 |

UNIQUE indexes: `idx_users_apple_sub`, `idx_users_google_sub` — partial, `WHERE … IS NOT NULL` (`migrate.ts:220-221`). Prevents two WhereToEat users from binding the same provider subject.

### `user_reservations`

`migrate.ts:166-182`.

| Column | Notes |
|---|---|
| `id`, `user_id`, `restaurant_id`, `restaurant_name`, `restaurant_photo_url` | identity + denormalised display fields |
| `datetime` | ISO string of booking time |
| `party_size`, `confirmation_code`, `platform`, `status` | platform ∈ `resy` / `opentable` / `tock` / `other`; status defaults to `confirmed` |
| `calendar_event_id`, `reminder_notification_id` | iOS-side handles for cancel-cleanup |

Index: `idx_user_reservations_user_datetime (user_id, datetime)` (`:186-188`).

`POST /api/auth/login` (`backend/api/auth/login.ts`) rewrites these rows from the anonymous id to the verified subject id on first sign-in.

### `user_favorites`

`migrate.ts:191-198`. PK `(user_id, restaurant_id)`. Endpoints ship in `api-archive/`; UI uses local storage today.

### `user_blocked_restaurants`

`migrate.ts:228-236`. PK `(user_id, restaurant_id)`. `blocked_until` nullable — null = forever. Discovery filter treats null as still blocked.

## Dialect rules

`backend/api/_lib/db.ts:1-22` is the contract:

- No `julianday()` / `datetime()` / `now()` in queries — compute timestamps in JS, pass as parameters (`nowIso()` at `db.ts:75`).
- INTEGER booleans (0/1) work on both backends.
- `ON CONFLICT (col) DO UPDATE / DO NOTHING` works on both.
- JSON stored as TEXT works on both.

## SQLite ↔ Neon sync

| Tool | What it does |
|---|---|
| `npm run push-data` (`scripts/sqlite-to-neon.ts`) | bulk dump using `ON CONFLICT DO NOTHING` — **cannot update existing rows** |
| `npx ts-node scripts/_sync-fields-to-neon.ts` | explicit per-row `UPDATE`s + re-pushes `xhs_sources` |
| `npm run migrate` | local SQLite schema |
| `npm run migrate:cloud` | Neon Postgres schema |

Schema drift can happen in either direction. Scripts that need columns absent locally should `ALTER TABLE … ADD COLUMN IF NOT EXISTS` before reading.

## API ↔ DB column mapping

`weekly.ts:253-318` is the canonical example: snake_case columns → camelCase JSON keys via `AS "..."` aliases. Mirror struct on iOS lives in `ios/WhereToEat/Models/WeeklyRestaurant.swift`.
