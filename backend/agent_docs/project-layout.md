# Backend Project Layout

Vercel serverless TypeScript on `@vercel/node` (Node functions, not Edge — child processes need a real runtime). Deployed to `https://wheretoeat-red.vercel.app`.

```
backend/
├── api/                  # Deployed routes (≤12 — Hobby tier cap)
│   ├── _lib/             # Shared modules (not deployed as routes)
│   ├── auth/login.ts
│   ├── feedback.ts
│   ├── locations/index.ts
│   ├── restaurants/
│   │   ├── [id]/unavailable.ts
│   │   ├── import-xhs.ts
│   │   └── weekly.ts
│   └── user/
│       ├── ensure.ts
│       ├── blocks/{index.ts,[restaurantId].ts}
│       └── reservations/{index.ts,[id].ts}
├── api-archive/          # Parked routes (NOT deployed; swap in to re-activate)
│   ├── places/enrich.ts
│   ├── reservations/{resy,opentable,tock}/{search,book}.ts
│   ├── restaurants-pipeline/run.ts
│   ├── scrape/{eater,xiaohongshu}.ts
│   ├── stripe/create-payment-intent.ts
│   └── user/favorites/...
├── data/                 # Local SQLite + ingest cache + progress files
├── scripts/              # CLI entry points (migrate, push-data, ingest, backfills)
├── package.json
├── tsconfig.json
├── vercel.json           # cron + maxDuration for pipeline/run
└── .env.local            # gitignored
```

## `api/` (deployed)

Today's 12-function bundle:

- `auth/login.ts` — Apple/Google JWT verification + anonymous-id migration.
- `feedback.ts` — POST user feedback → Resend email to `prompt.and.ship@gmail.com`. Requires `RESEND_API_KEY`.
- `locations/index.ts` — city → borough → neighborhood mapping.
- `restaurants/weekly.ts` — deck reader, status state machine.
- `restaurants/import-xhs.ts` — single-link XHS importer.
- `restaurants/[id]/unavailable.ts` — mark a card hidden this week.
- `user/ensure.ts` — user-row upsert.
- `user/blocks/index.ts`, `user/blocks/[restaurantId].ts` — block list.
- `user/reservations/index.ts`, `user/reservations/[id].ts` — reservation list/cancel.

Adding a route past 12 means swapping something into `api-archive/`. As of 2026-04-28: 11 deployed, 1 free slot.

## `api/_lib/` (shared modules)

Not deployed as routes. Imported by handlers and scripts.

| File | Purpose |
|---|---|
| `db.ts` | Dual-backend SQL helper (SQLite local, Neon prod). `sql\`...\`` template. (`db.ts:1`) |
| `types.ts` | Response envelope + DTO types. `ok()` / `err()` builders at `:14-20`. |
| `logger.ts` | Structured logger + `withRequestLogging(handler)` wrapper. |
| `withUser.ts` | `X-User-Id` validator + `users` upsert middleware. (`withUser.ts:18`) |
| `appleAuth.ts` / `googleAuth.ts` / `jwtVerify.ts` | JWKS verification for Apple / Google identity tokens. |
| `xhsScraper.ts` | XHS HTTP scraper (`readNoteViaHttp`, `searchViaHttp`) + CLI shim (local only). Cookies via `XHS_WEB_SESSION` / `XHS_A1` / `XHS_WEBID`. |
| `eaterScraper.ts` | Eater article + heatmap-index walker (`listEaterMaps`). |
| `resyBlogScraper.ts` | Resy blog article + category-page walker (`listResyBlogCategory`). |
| `llmExtractor.ts` | Gemini structured-output: `extractRestaurantData`, `extractBatch`, `classifyMention`, `classifyMentionsBatch`. (`llmExtractor.ts:1-80`) |
| `placesEnricher.ts` | Google Places New API wrapper. Returns `PlacesResult` (`placesEnricher.ts:12-43`). |
| `restaurantMerger.ts` | XHS dedup + ranking — `MergedRestaurant` shape at `:10-49`. |
| `cuisines.ts` / `features.ts` | Closed-vocabulary registries + canonicalisation. |
| `cityRegions.ts` | NYC borough + neighborhood lookup. |
| `googlePlaces.ts` | Lower-level Places API client used by enricher. |
| `resy.ts` / `opentable.ts` / `opentableSearch.ts` / `tock.ts` | Reservation-platform clients (Resy active; OpenTable + Tock parked). |
| `scraper.ts` / `yelp.ts` | Legacy generic scraping helpers. |

## `api-archive/` (parked)

Out of the deployed bundle to stay under the Hobby 12-function cap. Move back into `api/` and redeploy to re-activate.

## `scripts/`

CLI entry points (`ts-node` / `tsx`). All read `.env.local` from `backend/`.

- `migrate.ts` (`migrate.ts:1`) — local SQLite schema. `npm run migrate`.
- `migrate-cloud.ts` — Neon Postgres schema. `npm run migrate:cloud`.
- `local-server.ts` — hand-rolled Node server reusing the handler modules. `npm run start`.
- `sqlite-to-neon.ts` — bulk SQLite → Neon push. `npm run push-data`. **Cannot update existing rows** — uses `ON CONFLICT DO NOTHING`.
- `_sync-fields-to-neon.ts` — explicit per-row `UPDATE`s + re-pushes `xhs_sources`. Use this for backfills that touch existing columns.
- `_probe-neon.ts` — sanity-check Neon connection / counts.
- `ingest-multi-source.ts` — multi-source ingest (Resy + Eater) with paginated discovery. (`ingest-multi-source.ts:1-110`)
- `probe-multi-source.ts` — dry-run probe for the ingest.
- `topup-xhs-sources.ts` — backfill `xhs_sources` rows for existing canonicals.
- `backfill-*.ts` — column-specific backfills (rating-ig, photos, opentable, resy, neighborhoods, borough, coords, rating-location, xhs-sources).
- `migrate-places-photos.ts`, `upload-photos.ts` — mirror Places photos to Vercel Blob.
- `reclassify-cuisines.ts` — re-run LLM classifier on existing rows.
- `refine-neighborhoods.ts` — fix-up for Places neighborhood gaps.
- `fix-source-types.ts` — one-off `xhs_sources.source_type` cleanup.
- `verify-opentable.ts`, `test-pipeline.ts`, `test-weekly.ts` — manual smoke tests.
- `reset-deck.sh` — local-only: wipe weekly deck + restart pipeline.
- `run-pipeline.sh` — invokes `pipeline/run.ts` against local server.

## `data/`

- `wheretoeat.db` — local SQLite (working copy).
- `wheretoeat.db.pre-*` — automatic backups before destructive backfills.
- `ingest-cache.json` — multi-source ingest cache (lets `--from-cache` re-run without re-fetching).
- `ingest-progress.json` — multi-source URL queue (lets `--resume` continue after a crash).

## Env vars (`.env.local`)

Pull live values with `vercel env pull .env.local --yes`. See `backend/CLAUDE.md` § Env vars for the load-bearing list.
