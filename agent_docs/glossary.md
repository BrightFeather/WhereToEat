# Glossary

Domain terms that show up in both codebases. iOS uses Swift naming; backend uses snake_case in SQL and camelCase in TypeScript — entries below pair both where it matters.

## Restaurant model

**Canonical restaurant** — one row in `xhs_restaurants` (`backend/scripts/migrate.ts:41`). Identified by `(city, google_place_id)` under a partial UNIQUE index (`migrate.ts:110-114`). Survives across weekly pipeline runs so user state (`user_blocked_restaurants`, `user_reservations`) keeps matching.

**Source row** — one row in `xhs_sources` (`migrate.ts:78`). Polymorphic over `source_type ∈ {xiaohongshu, eater, resy_blog}`. Idempotent on `(restaurant_id, post_url)` (`migrate.ts:99-101`). Each row carries its own `recommendation` (verbatim creator quote / editorial blurb), `author`, `source_title`, `likes`, `post_created_at`.

**Mention** — pre-canonicalisation: a single (source_url, restaurant_name) candidate pulled from a Resy / Eater / XHS post. Becomes a `xhs_sources` row after dedup. Defined as `CandidateMention` at `backend/scripts/ingest-multi-source.ts:90-110`.

**WeeklyRestaurant** — the API response shape from `/api/restaurants/weekly` (`backend/api/restaurants/weekly.ts:23-53`). Mirror struct on iOS lives in `ios/WhereToEat/Models/WeeklyRestaurant.swift`.

**XHSSource** — legacy iOS name for a per-source attribution row. Now polymorphic; `resolvedType` defaults to `xiaohongshu` for older rows. Render via `displayPlatform`.

**Restaurant** (iOS only) — local model used by the Pick / My List / Find views. Defined at `ios/WhereToEat/Models/Restaurant.swift:49`. Carries `id`, `name`, `address`, `coordinates`, `googleMapsLink`, `googlePlaceId`, `bookingUrl`, `sourceOrigin` (`SourceOrigin` enum at `Restaurant.swift:24`).

## Cuisine + features

**CuisineKey** — closed-vocabulary 17-key enum at `backend/api/_lib/cuisines.ts`. Set by Places' `<foo>_restaurant` primary type when available, else the LLM picks from the same enum. Never free-form.

**FeatureKey** — closed-vocab tag registry at `backend/api/_lib/features.ts`. Sub-cuisines + venue-format flags (coffee, brunch, bakery, omakase, …). Computed as the union of Places-derived signals and LLM extractions, then `canonicalizeFeatures(...)` deduplicates (`features.ts`).

## Sessions + state

**WeeklySession** — iOS model at `ios/WhereToEat/Models/WeeklySession.swift:10`. One per Monday-of-week; tracks `swipedCards`, `reservations`, `cuisinePreferences`, `status`. Persisted to `UserDefaults`.

**SwipeRecord** — `ios/WhereToEat/Models/SwipeRecord.swift`. `decision` ∈ `liked` / `disliked`, restaurantId, swipedAt.

**SeenService** — `ios/WhereToEat/Services/SeenService.swift`. `seenToday()` set; deck cards seen today are dropped at `loadCards` time so they don't reappear.

**Reservation** — iOS model at `ios/WhereToEat/Models/Reservation.swift:19`. Mirror table is `user_reservations` in the backend (`migrate.ts:166`). Calendar event id + reminder notification id are stored on the same row so cancel can clean both up.

**Block** — entry in `user_blocked_restaurants` (`migrate.ts:228`). `blocked_until = NULL` means forever. Discovery filter treats null as "still blocked".

## Pipeline / scraping

**Pipeline run** — one row in `pipeline_runs` (`migrate.ts:27`). Status ∈ `running` / `completed` / `failed`. `weekly.ts:184-190` reaps stale `running` rows older than 10 minutes (Hobby-cap survivors).

**xsec_token** — XHS per-token capability handle in note URLs. **Single-use**: re-using it returns a `/404` redirect. See memory `project_xhs_xsec_token_singleuse.md`.

**XHS HTTP scraper** — `backend/api/_lib/xhsScraper.ts`. Runtime path on Vercel (CLI not installed); parses `window.__INITIAL_STATE__` from the post page. Requires session cookies (`XHS_WEB_SESSION` / `XHS_A1` / `XHS_WEBID`) set in env.

**xhs CLI** — local-only Node CLI (`xhs`) used by the local pipeline runner. Auth lives at `~/.xiaohongshu-cli/cookies.json`; ask the user to re-login if it errors.

## Auth

**X-User-Id** — Keychain UUID minted by `IdentityService` on first launch. Sent on every backend request. Backend `withUser` middleware (`backend/api/_lib/withUser.ts:18`) upserts into `users`.

**auth_provider** — column on `users` (`migrate.ts:214`) ∈ `anonymous` / `apple` / `google`. Provider-specific subject ids live in `apple_sub` / `google_sub` (UNIQUE indexes at `migrate.ts:220-221`).

## Cities + regions

**Borough** — Manhattan / Brooklyn / Queens / Bronx / Staten Island for NYC. Set in `backend/api/_lib/cityRegions.ts`. "Midtown" is normalised to "Other" — a borough is a borough, not a neighborhood.

**Neighborhood** — finer-grained label from Google Places `neighborhood` / `sublocality` address components (`backend/api/_lib/placesEnricher.ts:55-60`).

## API plumbing

**`ok(data)` / `err(message, code)`** — response builders at `backend/api/_lib/types.ts:14-20`.

**`withRequestLogging`** — wraps every handler; emits `http.request` / `http.response` events. Defined in `backend/api/_lib/logger.ts`.

**`withUser`** — wraps user-scoped routes; validates `X-User-Id`, upserts the user row, forwards id to the handler.
