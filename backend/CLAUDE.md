# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Backend — WhereToEat

Vercel serverless functions (TypeScript, `@vercel/node` runtime). Deployed to `https://wheretoeat-red.vercel.app`. See `../CLAUDE.md` for the product picture and `../SPEC.md` for the data model.

## Run

```bash
npm run migrate     # one-time: creates SQLite/Postgres tables
npm run start       # local dev — hand-rolled Node server reusing the handler modules (preferred)
vercel dev          # alternative — full Vercel routing emulation
```

`npm run start` is the default per the project's house rules — `vercel dev` is only needed when you specifically need the routing emulation.

## Deploy

```bash
vercel --prod       # deploys to wheretoeat-red.vercel.app
```

iOS clients pick up the new URL via `APIClient.swift` (`dev_api_base_url` UserDefaults → `API_BASE_URL` Info.plist → vercel URL).

## Active vs. archived endpoints

The deployed bundle is **capped at 12 functions** on the Hobby plan. Routes that aren't currently load-bearing live in `api-archive/` and are not deployed. Today's split:

- **`api/` (deployed)** — `auth/login`, `restaurants/{weekly,import-xhs,pipeline/run,[id]/unavailable}`, `user/{ensure,reservations,blocks}`, `locations`
- **`api-archive/` (not deployed)** — `places/enrich`, `reservations/{resy,opentable,tock}/{search,book}`, `scrape/{eater,xiaohongshu}`, `stripe/create-payment-intent`, `user/favorites`

When you add a new endpoint, decide what to swap out — don't push past 12. To re-activate something, move the file from `api-archive/` back into `api/` and redeploy.

## Auth (`api/auth/login.ts`)

`POST /api/auth/login` exchanges an Apple or Google identity token for the verified user id, then mirrors the anonymous-id row's reservations + favorites onto the verified id. JWKS verification lives in `_lib/{appleAuth,googleAuth,jwtVerify}.ts`.

Two env vars are load-bearing and easy to miss:

- `APPLE_BUNDLE_IDS` — comma-separated list of accepted `aud` values. **Must be `com.weijia.wheretoeat`** (the iOS bundle id), not the placeholder `com.wheretoeat.app` that the verifier defaults to. Without this, every Apple sign-in returns 401.
- `GOOGLE_IOS_CLIENT_IDS` — comma-separated list of accepted Google iOS OAuth client ids (audiences for `verifyGoogleIdToken`).

## Logging convention

All handlers wrap with `withRequestLogging(handler)` from `_lib/logger.ts`. This auto-emits `http.request` / `http.response` events. Inside handlers use `logger.request()` / `success()` / `error()` / `warn()` — don't `console.log` directly.

## Pipeline notes (XHS weekly job)

- The `xhs` CLI is **not installed in the Vercel runtime**. The pipeline runs locally and writes to Neon (hybrid model). Don't try to bundle xhs.
- HTTP fallback (`xhsScraper.ts → readNoteViaHttp / searchViaHttp`) parses `window.__INITIAL_STATE__` and requires session cookies (`XHS_WEB_SESSION` / `XHS_A1` / `XHS_WEBID`) in env.
- LLM extraction batches posts in groups of 10 with a delay — keep this if you change the loop.
- Dedup uses `googlePlaceId` as the canonical key; falls back to normalized name when Places returns nothing.
- `pipeline/run.ts` requires the `CRON_SECRET` header (same value as the cron). Don't remove that check.
- `vercel.json` sets `maxDuration: 300` for `pipeline/run.ts` (Pro-tier capability) — full runs take longer than the Hobby 60s cap, so testing pipeline changes on Hobby means running locally.

## Stack

- TypeScript on `@vercel/node` (Node functions, not Edge — child processes need a real runtime).
- DB: `better-sqlite3` locally, `@neondatabase/serverless` in prod. `_lib/db.ts` abstracts the dialect; the same tagged-template `sql\`...\`` works in both.
- LLM: Gemini 2.5 Flash via `@google/generative-ai` (`LLM_API_KEY` / `LLM_MODEL`). The Anthropic SDK is installed but unused.
- Scraping: `axios` + `cheerio` for HTML; `xhs` CLI as subprocess for Xiaohongshu (local only).
- Storage: `@vercel/blob` for Places photo mirroring.
- Payments: `stripe` (deferred — currently archived).

## Env vars

`.env.local` (gitignored). Production values in Vercel dashboard. Currently required:

- `DATABASE_URL` — Neon Postgres (auto-provisioned by integration)
- `GOOGLE_PLACES_API_KEY` — Places + Geocoding
- `LLM_API_KEY` + `LLM_MODEL` — Gemini
- `CRON_SECRET` — pipeline auth
- `APPLE_BUNDLE_IDS` — see Auth section above
- `GOOGLE_IOS_CLIENT_IDS` — see Auth section above
- `BLOB_READ_WRITE_TOKEN` — Vercel Blob (photo mirror)
- `XHS_WEB_SESSION` / `XHS_A1` / `XHS_WEBID` — XHS HTTP scraper cookies

Pull live values into `.env.local` with `vercel env pull .env.local --yes`.

## Scripts

```bash
npm run migrate              # SQLite local schema
npm run migrate:cloud        # Neon prod schema
npm run push-data            # one-shot SQLite → Neon dump (sqlite-to-neon.ts)
npm run push-photos          # mirror Places photos to Vercel Blob
npm run migrate-places-photos # update photo URLs to Blob URLs
npm run backfill-coords      # backfill lat/lng on existing rows
npm run reset-deck           # local-only: wipe weekly deck + restart pipeline
```

## House rules from the parent

- Only edit code when explicitly asked. Markdown edits (CLAUDE.md, SPEC.md, TASKS.md) are always fine.
- Keep `SPEC.md` and `TASKS.md` in sync the same turn a feature ships.
- If you add an endpoint, run `find api -name "*.ts" -not -path "*/_lib/*" | wc -l` before deploying — it must be ≤ 12.
