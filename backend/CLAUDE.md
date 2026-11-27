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
- **rednote split (2026-11-26):** from a US IP `www.xiaohongshu.com` 302-redirects to `www.rednote.com`, so a browser login yields `.rednote.com` cookies. The `xhs` CLI only reads `.xiaohongshu.com` cookies and calls `edith.xiaohongshu.com`, which kills a rednote session. Copying the cookies across does not work. Use the browser ingest below (or `xhs login --qrcode` as a stopgap).
- HTTP fallback (`xhsScraper.ts → readNoteViaHttp / searchViaHttp`) parses `window.__INITIAL_STATE__` and requires session cookies (`XHS_WEB_SESSION` / `XHS_A1` / `XHS_WEBID`) in env.
- LLM extraction runs `EXTRACT_CONCURRENCY` (default 5) workers with a per-note cache (`data/xhs-raw/extract/<city>-v1/`). The legacy `extractBatch` (sequential, 200 ms delay) is still exported for other callers.
- Dedup uses `googlePlaceId` as the canonical key; falls back to normalized name when Places returns nothing.
- `pipeline/run.ts` requires the `CRON_SECRET` header (same value as the cron). Don't remove that check.
- `vercel.json` sets `maxDuration: 300` for `pipeline/run.ts` (Pro-tier capability) — full runs take longer than the Hobby 60s cap, so testing pipeline changes on Hobby means running locally.

## XHS browser ingest (replaces the `xhs` CLI, 2026-11-26)

The scraper is a real Chrome driven over CDP. The site signs its own requests, so there's no reverse-engineered signing, and it works with the xiaohongshu → rednote.com redirect.

1. **Start the long-lived Chrome once and leave it open.** It uses a dedicated profile, not your everyday one:
   ```bash
   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9333 \
     --remote-debugging-address=127.0.0.1 --user-data-dir="$HOME/.wheretoeat/xhs-browser-profile" --no-first-run
   ```
   Log in once in that window with the RedNote QR code. Scripts attach to it, open their own tab and detach without closing it (`XHS_CDP_URL`, default `http://127.0.0.1:9333`). Don't log in with a Playwright-launched browser: Playwright uses a mock keychain, so its cookies can't be read by normal Chrome.
2. **Count:** `CITY=nyc npx ts-node -T scripts/xhs-browser-ingest.ts` searches each city keyword with the server-side filters **最多点赞 (most liked) + 半年内 (last 6 months)** and scrolls until likes drop below `MIN_LIKES` (50). It writes `data/xhs-raw/candidates-<city>.json`. Expect about 120 results per query before the platform stops returning more.
3. **Read:** `CITY=nyc MODE=read MAX_POSTS=300 npx ts-node -T scripts/xhs-browser-ingest.ts` opens the top-N notes by likes and parses SSR `__INITIAL_STATE__`. Each note is cached at `data/xhs-raw/notes/<id>.json`, so re-runs and larger `MAX_POSTS` don't re-fetch. Output is `data/xhs-raw/posts-<city>.json`. About 6–7 s per note.
4. **Pipeline:** `CITY=nyc POSTS_FILE=data/xhs-raw/posts-nyc.json npx ts-node scripts/test-pipeline.ts` runs DeepSeek extraction → Places → merge → upsert into local SQLite.

Gotchas:
- **Honeypots:** the search filter panel renders an invisible decoy twin before each real tag (`button-hp-installed`, `data-hp-kind`, `aria-hidden="true"`, opacity 1e-05). Never select by text alone. `xhsBrowser.clickFilterTag` excludes the decoys.
- The filter panel opens on **hover** of `div.filter`. After hovering, move the mouse back over the feed before scrolling, or the wheel scrolls the panel.
- On a captcha or verify page the script pauses (up to 10 min) for a human to solve it in the window. Five failed reads in a row abort the read phase.
- Code lives in `api/_lib/xhsBrowser.ts` (local only; never import it from a deployed route) and `scripts/xhs-browser-ingest.ts`. `scripts/xhs-browser-probe.ts` is the original feasibility probe.

## Syncing a pipeline run to Neon (2026-11-26)

Use `SINCE=<date> [DRY_RUN=1] npx ts-node -T scripts/sync-runs-to-neon.ts` (or `RUN_IDS=…`), **not** `npm run push-data`. push-data also copies local users / reservations / favorites into prod, can't update existing rows, and its INSERT drops features / rating / IG / coords / price / source_type. The sync script upserts the runs, then their restaurants and sources. Existing prod rows keep `is_available_this_week`, booking links and Blob photo URLs; the pipeline's own fields (counts, recency, run ID, rating) come from local.

**After every sync, run `npm run mirror-photos`** (targets Neon). The pipeline stores raw `places.googleapis.com/.../media?key=…` photo URLs, and the sync keeps prod's existing `photo_url`, so new rows reach prod with Places URLs. Those cost a billed Places call plus a 302 on every app load, expose the API key in `/weekly`, and turn into permanent gray cards once Google expires the photo name (400). The script uploads each photo to Blob (`photos/<place_id>_<i>.jpg`), re-reads expired photo names from Place Details, and drops photos it can't recover. It's idempotent, and `DRY_RUN=1` / `CITY` / `LIMIT` / `TARGET=sqlite` are available.

`weekly.ts` picks the latest run with `ORDER BY completed_at DESC NULLS LAST`. Postgres sorts NULL first under DESC, and Neon has a legacy `completed` run with NULL `completed_at` that otherwise shadows every real run. SQLite sorts NULL last, so this only shows up in prod.

**Deploying while another session edits the tree:** deploy from a snapshot copy, and **diff the snapshot against `git HEAD`** before `vercel --prod`. A SHA match against the live working file proves nothing: on 2026-11-26 that let another session's half-finished `weekly.ts` ship and 500 prod for ~3 min. After any deploy, curl `/api/restaurants/weekly?city=nyc` and `?city=bay` and check for 200 and non-zero counts.

## Sources per restaurant (2026-11-26)

`restaurantMerger.ts` exports `MAX_XHS_SOURCES_PER_RESTAURANT` (10) and `sourceScore` (likes × recency weight). `test-pipeline.ts` admits a new XHS source only if the restaurant has <10 or the post ranks in its top 10 (override with `MAX_SOURCES_PER_RESTAURANT`). It never deletes. `weekly.ts → attachSources` sorts by score and trims XHS to 10. Editorial sources are appended, untrimmed.

## Cities (`nyc`, `bay`)

`xhs_restaurants.city` is the city key. `borough` holds the city's region: NYC boroughs, or for `bay` one of San Francisco / East Bay / Peninsula / South Bay / North Bay, assigned from Places `locality` via `cityRegions.regionForLocality`. `cityRegions.ts → CITY_META` holds the per-city Places query suffixes and, for `bay`, a bounds rectangle used for `locationBias` and to drop out-of-area matches (`places.rejected_out_of_area`). NYC has no bounds and keeps its original query strings. `extractRestaurantData` / `extractBatch` / `enrichWithPlaces` take an optional `city` (default `nyc`), and `test-pipeline.ts` reads `CITY`. `weekly.ts` filters the deck and etag by `city`. Plan and status: `agent_docs/bay-area-expansion.md`.

## LLM parser (DeepSeek-V4-Pro)

The XHS post → restaurant extractor and the per-mention classifier both run on **DeepSeek-V4-Pro** via the OpenAI-compatible SDK pointed at `https://api.deepseek.com`. Same pattern as `feedback-agent/src/llm.ts` — secret is `DEEP_SEEK_API` from `~/.config/wte-feedback-agent/secrets.env` (or env var). Model id override: `DEEPSEEK_MODEL` env var.

**Hard rule**: every DeepSeek call passes `thinking: { type: 'disabled' }`. V4 defaults to thinking-on which silently eats `max_tokens` — chokepoint is `_lib/deepseek.ts`. Don't bypass.

**Provider switch (2026-11-26):** set `LLM_PROVIDER=fireworks` to send the same prompts to Fireworks. The default model is `accounts/fireworks/models/deepseek-v4p1-flash`; override with `FIREWORKS_MODEL`. The key comes from the `FIREWORKS_API_KEY` env var or secrets.env, or from a file path in `FIREWORKS_API_KEY_FILE`. Fireworks honours the same `thinking` field. Benchmark (`scripts/bench-llm.ts`, 20 posts): Flash ran at 0.9 s/call (ultrafast router 0.4 s) vs about 2 s for V4-Pro, but **found only 54–64% of the restaurants Pro finds** and returned nothing for 10–13 of 20 posts vs Pro's 8. **Extraction stays on DeepSeek V4-Pro.** Pro is slow under heavy concurrency (about 50–60 s per call at 15 parallel on long posts), so `test-pipeline.ts` runs extraction with `EXTRACT_CONCURRENCY` (default 5) and caches per note in `data/xhs-raw/extract/<city>-v1/`. Bump the suffix whenever the prompt changes.

### Negative-post filter (drop on any complaint)

Posts that contain **any** complaint, criticism, or hedged endorsement about the target restaurant are dropped at ingest. Implemented in `_lib/llmExtractor.ts`:

- `extractRestaurantData()` adds `hasComplaint: boolean` to its DeepSeek output. If true, the entire post returns `[]` — no restaurants harvested from it. Applied automatically by the weekly pipeline (`scripts/test-pipeline.ts`).
- `classifyComplaint({ title, body, restaurantName })` is the standalone target-aware classifier used by topup + scrub scripts. It is **target-focused**: only flags complaints aimed at `restaurantName`, not other restaurants in the same post (so a post that praises A and trashes B will keep the (A, post) source row and drop the (B, post) row).
- Failure mode: if the classifier errors out, it returns `hasComplaint: true` (fail closed — better to drop a borderline post than ingest a bad one).

What counts as a complaint (be aggressive — the rule is "drop on any complains"):
- Direct criticism (`不好吃`, `踩雷`, `难吃`, `失望`, "wouldn't go back", "skip it", "overrated", "underwhelming", "not great", "service was bad", "wasn't worth it")
- Mixed reviews about the target ("food great but service bad")
- Lukewarm endorsement ("just okay", "fine", "nothing special", "alright")
- "X is not as good as Y" where the target is X
- Warnings, venting about wait/prices/attitude/hygiene

Pure positive recommendations (`超推荐`, "loved it", "must-try") → kept.

### Ops scripts

- `npm run scrub-negative` — backfill: walks every `xhs_sources` row, classifies via DeepSeek, deletes negatives in SQLite + mirrors the delete to Neon. Env knobs: `ONLY_CUISINES`, `LIMIT`, `DRY_RUN=1`, `SKIP_NEON=1`. Run any time the prompt changes — it's idempotent.
- `npm run topup-asian` — for `cuisine_type ∈ {chinese, japanese, korean}` with `<5` XHS sources, searches `xhs search "<name>" --sort time` (newest first, then `--sort popular`), passes each candidate through `classifyComplaint`, drops negatives, upserts up to TARGET. Env knobs: `TARGET_PER_RESTAURANT` (default 5), `CUISINES`, `MAX_SEARCH_PAGES`, `DRY_RUN=1`.

## Places enrichment — food-type guard

`_lib/placesEnricher.ts` constrains every Places search to food establishments. The first-pass loop tries `includedType` ∈ `[restaurant, bar, cafe, bakery, meal_takeaway, meal_delivery]` with `strictTypeFiltering: true`. If every food type returns nothing, an unfiltered fallback search runs but is **post-filtered by `FOOD_PRIMARY_TYPES`** — non-food top hits are rejected with `places.rejected_non_food` instead of being adopted.

This guard exists because Places will happily match unrelated NYC landmarks when a venue name is a common abbreviation or word: "Oti" → Office of Technology and Innovation, "Bibliotheque" → New York Public Library — Schwarzman Building, etc. Editorial sources (Resy, Eater) are particularly susceptible because their venue names are short and frequently dictionary words.

If you add a new food-establishment type that Places returns (e.g. a regional cuisine type), append it to `FOOD_PRIMARY_TYPES` so the unfiltered fallback path doesn't reject it. The `FOOD_TYPE_FALLBACKS` array is intentionally small — it's only the broad categories Places accepts as `includedType`.

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
npm run push-photos          # legacy: upload localhost-served photos to Blob
npm run migrate-places-photos # legacy: superseded by mirror-photos (can't recover expired photos)
npm run mirror-photos        # Places photo URLs → Blob on Neon, refreshing expired ones; run after every sync
npm run backfill-coords      # backfill lat/lng on existing rows
npm run reset-deck           # local-only: wipe weekly deck + restart pipeline
```

## House rules from the parent

- Only edit code when explicitly asked. Markdown edits (CLAUDE.md, SPEC.md, TASKS.md) are always fine.
- Keep `SPEC.md` and `TASKS.md` in sync the same turn a feature ships.
- If you add an endpoint, run `find api -name "*.ts" -not -path "*/_lib/*" | wc -l` before deploying — it must be ≤ 12.
