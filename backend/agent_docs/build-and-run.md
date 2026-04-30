# Backend Build & Run

TypeScript on `@vercel/node`. All commands run from `backend/`.

## Install

```bash
cd backend
npm install
```

## First-time setup

```bash
npm run migrate          # creates local SQLite at backend/data/wheretoeat.db
npm run migrate:cloud    # creates Neon Postgres schema (uses DATABASE_URL)
vercel env pull .env.local --yes   # mirror prod env vars locally
```

## Run locally

```bash
npm run start            # default — hand-rolled Node server reusing the handler modules at scripts/local-server.ts
vercel dev               # alternative — full Vercel routing emulation (only when you specifically need it)
```

`npm run start` listens on `localhost:3000` by default. iOS clients can point at it via:

```bash
xcrun simctl spawn <UDID> defaults write com.weijia.wheretoeat dev_api_base_url "http://<MAC-LAN-IP>:3000"
```

(`localhost` won't work from a physical iPhone — see `ios/agent_docs/networking.md`.)

## Deploy

```bash
vercel --prod --yes      # deploys to wheretoeat-red.vercel.app
```

iOS picks up the new URL automatically (`dev_api_base_url` UserDefaults → `API_BASE_URL` Info.plist → vercel URL).

**Function-count cap:** Hobby plan caps at 12 deployed routes. Before adding a new `api/*.ts` route, check:

```bash
find api -name "*.ts" -not -path "*/_lib/*" | wc -l
```

If at the cap, archive an existing route by moving it into `backend/api-archive/`.

## Scripts (all `ts-node`)

| Command | What it does |
|---|---|
| `npm run start` | Local dev server (`scripts/local-server.ts`) |
| `npm run migrate` | Local SQLite schema (`scripts/migrate.ts`) |
| `npm run migrate:cloud` | Neon Postgres schema (`scripts/migrate-cloud.ts`) |
| `npm run push-data` | Bulk SQLite → Neon dump using `ON CONFLICT DO NOTHING` (won't update existing rows) |
| `npm run push-photos` | Mirror Places photos to Vercel Blob |
| `npm run migrate-places-photos` | Update photo URLs to Blob URLs |
| `npm run backfill-coords` | Backfill lat/lng on existing rows |
| `npm run backfill-price` | Backfill `price_level` from Google Places `priceLevel` (writes SQLite + Neon). Flags: `--dry-run`, `--limit N`, `--refresh`. |
| `npm run reset-deck` | Local-only: wipe weekly deck + restart pipeline |

Direct `ts-node` invocations (no npm script):

```bash
npx ts-node scripts/_sync-fields-to-neon.ts        # per-row UPDATEs to Neon for column-level backfills
npx ts-node scripts/_probe-neon.ts                  # quick row-count sanity check on Neon
npx ts-node scripts/ingest-multi-source.ts --paginate
npx ts-node scripts/probe-multi-source.ts
npx ts-node scripts/topup-xhs-sources.ts
npx ts-node scripts/backfill-rating-ig.ts
npx ts-node scripts/backfill-rating-location.ts
npx ts-node scripts/backfill-photos.ts
npx ts-node scripts/backfill-photos-db.ts
npx ts-node scripts/backfill-opentable.ts
npx ts-node scripts/backfill-resy.ts
npx ts-node scripts/backfill-borough.ts
npx ts-node scripts/backfill-neighborhoods.ts
npx ts-node scripts/refine-neighborhoods.ts
npx ts-node scripts/backfill-xhs-sources.ts
npx ts-node scripts/reclassify-cuisines.ts
npx ts-node scripts/fix-source-types.ts
npx ts-node scripts/verify-opentable.ts
npx ts-node scripts/test-pipeline.ts
npx ts-node scripts/test-weekly.ts
```

## Tests

There is **no formal test target** for the backend. Smoke-test scripts in `scripts/test-*.ts` exercise specific paths against the local DB. The QA loop today is:

1. Run pipeline locally (`scripts/ingest-multi-source.ts` or `test-pipeline.ts`).
2. Inspect SQLite via `sqlite3 data/wheretoeat.db`.
3. `npm run push-data` once results look right.
4. Probe Neon with `_probe-neon.ts`.

## Env vars

`.env.local` is gitignored. Pull live values:

```bash
vercel env pull .env.local --yes
```

Required variables (see `backend/CLAUDE.md` § Env vars for the load-bearing notes):

- `DATABASE_URL` — Neon Postgres
- `GOOGLE_PLACES_API_KEY` — Places + Geocoding
- `LLM_API_KEY` + `LLM_MODEL` — Gemini
- `CRON_SECRET` — pipeline auth
- `APPLE_BUNDLE_IDS` — must include `com.weijia.wheretoeat`
- `GOOGLE_IOS_CLIENT_IDS` — Google iOS OAuth client ids (audience for verifier)
- `BLOB_READ_WRITE_TOKEN` (or `RESTAURANT_PHOTOS_READ_WRITE_TOKEN`) — Vercel Blob
- `XHS_WEB_SESSION` / `XHS_A1` / `XHS_WEBID` — XHS HTTP scraper cookies (sourceable from `~/.xiaohongshu-cli/cookies.json`)
- `RESEND_API_KEY` — Resend API key for `/api/feedback`. Optional `FEEDBACK_FROM` overrides the default `WhereToEat <onboarding@resend.dev>` once a domain is verified on Resend.

## House rules

- Only edit code when explicitly asked. Markdown edits (`CLAUDE.md`, `SPEC.md`, `TASKS.md`, the agent_docs) are always fine.
- All handlers wrap with `withRequestLogging(handler)` — don't `console.log` directly. Use `logger.request()` / `success()` / `error()` / `warn()` from `_lib/logger.ts`.
- The XHS CLI is **not installed in the Vercel runtime**. Pipeline runs locally; the HTTP fallback in `_lib/xhsScraper.ts` (cookie-based) is the prod path for `import-xhs`.
- LLM extraction batches in groups of 10 with a delay — keep this if you change the loop.
- Don't remove the `CRON_SECRET` check on `pipeline/run.ts`.

## Stack reference

- TypeScript on `@vercel/node` (Node functions, not Edge — child processes need a real runtime).
- DB: `better-sqlite3` locally, `@neondatabase/serverless` in prod. `_lib/db.ts` abstracts the dialect.
- LLM: Gemini 2.5 Flash via `@google/generative-ai` (`LLM_API_KEY` / `LLM_MODEL`). Anthropic SDK is installed but unused.
- Scraping: `axios` + `cheerio` for HTML; `xhs` CLI subprocess for Xiaohongshu (local only).
- Storage: `@vercel/blob` for Places photo mirroring.
- Payments: `stripe` (deferred — currently archived).
