# Parsing Pipeline

WhereToEat ingests three source types — XHS posts (`xiaohongshu`), Eater heatmaps (`eater`), Resy blog posts (`resy_blog`) — into the canonical `xhs_restaurants` table with per-source rows in `xhs_sources`.

## Entry points

There are three ways to run the pipeline:

1. **Single-link import** — user paste path. `POST /api/restaurants/import-xhs` (`backend/api/restaurants/import-xhs.ts:83`). Reads one XHS note → LLM extract → Places enrich → opportunistic Resy/OpenTable lookup. Fits under Hobby's 60s function cap.
2. **Weekly pipeline** — full XHS hashtag crawl. `POST /api/restaurants/pipeline/run` (`backend/api/restaurants/pipeline/run.ts:55`). Auth via `CRON_SECRET`. Has `maxDuration: 300` in `vercel.json` but **times out under Hobby**; intended for Pro tier or local execution.
3. **Multi-source ingest** — local-only paginated crawl of Resy + Eater. `npx ts-node backend/scripts/ingest-multi-source.ts [flags]` (`backend/scripts/ingest-multi-source.ts:1`). The current production path for filling the deck.

Today's actual production loop: (3) runs locally, then `npm run push-data` (or `_sync-fields-to-neon.ts` for column updates) ships rows to Neon.

## Stages

### 1. Scrape

Each scraper produces a list of mentions or a parsed note.

- **XHS HTTP** — `backend/api/_lib/xhsScraper.ts`. `readNoteViaHttp(noteId, xsecToken?)`, `searchViaHttp(...)`. Parses `window.__INITIAL_STATE__` from the post page. Requires session cookies (`XHS_WEB_SESSION` / `XHS_A1` / `XHS_WEBID`). Note: `xsec_token` is **single-use** — see memory `project_xhs_xsec_token_singleuse.md`.
- **XHS CLI** — local-only subprocess (`xhs` CLI). Used by the local pipeline runner.
- **Resy blog** — `backend/api/_lib/resyBlogScraper.ts`. `readResyBlogPost(url)` returns mentions with venue anchors when present; `listResyBlogCategory(slug, options)` walks `/category/<slug>/page/N/` (or `/city/<slug>/page/N/`) for URL discovery.
- **Eater** — `backend/api/_lib/eaterScraper.ts`. `readEaterArticle(url)` parses Vox CMS heatmaps (`.duet--article--map-card`); `listEaterMaps(options)` reads the `/maps` index for URL discovery.

### 2. Cutoff filter

Multi-source ingest drops mentions older than `CUTOFF_DAYS` (default 365) using JSON-LD `datePublished` / `dateModified`. Republished heatmaps use `max(published, modified)`.

### 3. Classify (cuisine + features)

Gemini 2.5 Flash with structured output via `responseSchema` + `format: 'enum'` + `thinkingConfig: { thinkingBudget: 0 }` — omitting any of these breaks reliability.

- `extractRestaurantData(post)` — `backend/api/_lib/llmExtractor.ts`. Used by `import-xhs.ts` for whole-post extraction (returns N restaurants from one XHS note).
- `extractBatch(posts)` — used by `pipeline/run.ts` for hashtag-deck batching.
- `classifyMention(mention)` — single-mention cuisine + features classification.
- `classifyMentionsBatch(mentions, batchSize=10, interBatchDelayMs=7000)` — array-schema batch classification (~7.5× throughput vs per-mention). Falls back to `classifyMention` per slot when a batch fails the schema. Used by `ingest-multi-source.ts` (`CLASSIFY_BATCH_SIZE` env, default 10).

`CuisineKey` and `FeatureKey` are closed-vocabulary enums (`backend/api/_lib/cuisines.ts`, `backend/api/_lib/features.ts`). The LLM never returns free-form values.

### 4. Places enrich

`enrichWithPlaces(extracted)` at `backend/api/_lib/placesEnricher.ts`. Uses Google Places New API (`textSearch` → `place details`) to find a `googlePlaceId`, address, borough, neighborhood (extractor at `placesEnricher.ts:55-60`), website, photos (up to 5), rating + user count, and lat/lng.

The result includes Places-derived `cuisineKey` (when `primaryType` is a `<foo>_restaurant`) and feature signals (`featuresFromPlacesType`, `featuresFromPlacesServes`). The merge rule:

- **Cuisine**: trust Places when it gave us one; else use the LLM's pick.
- **Features**: union Places + LLM, then `canonicalizeFeatures(...)` to dedupe.

Best-effort Instagram URL is scraped from the website. Never blocks enrichment — purely additive.

### 5. Opportunistic reservation links

For each enriched restaurant, look up Resy + OpenTable bookings (8s timeout each, skip on error):

- `resy.findVenue(name, lat, lng)` — `backend/api/_lib/resy.ts`. Used in `import-xhs.ts:144-148`.
- `opentable.findVenue(name)` — `backend/api/_lib/opentable.ts`. Used in `import-xhs.ts:151-154`.

### 6. Dedup + canonicalise

The canonical key is `(city, google_place_id)` under a partial UNIQUE index (`backend/scripts/migrate.ts:110-114`). When Places returns nothing, fall back to a normalized name match (`normName(s)` strips non-alphanumerics — `ingest-multi-source.ts:116-118`).

`MergedRestaurant` shape at `backend/api/_lib/restaurantMerger.ts:10-49`. The merger picks the highest-liked post's `recommendation` + `postUrl` as the denormalised "best snippet" but keeps the full per-post `sources[]` array for the multi-quote UI.

### 7. Write canonical + sources

Writers live in `ingest-multi-source.ts` (multi-source path) and `pipeline/run.ts` (XHS hashtag path). Both:

- Upsert one row into `xhs_restaurants` using the partial UNIQUE index (`(city, google_place_id)`) — `ON CONFLICT DO UPDATE` for places-mapped rows; `INSERT` for unmapped fallbacks.
- Insert one row per (restaurant, post_url) into `xhs_sources` — idempotent under the `(restaurant_id, post_url)` UNIQUE index (`migrate.ts:99-101`).
- Stamp `pipeline_run_id` so the deck reader can scope to the most recent completed run.

## Pagination flow (`ingest-multi-source.ts`)

`--paginate` flag enables URL discovery; without it the script uses hardcoded URLs (`RESY_URLS` / `EATER_URLS` at `:58-66`).

- Default Resy categories: `RESY_CATEGORIES_NYC = ['city/new-york']` — exhaustive for NYC, zero non-NYC noise. (`:78`)
- Opt-in `--all-categories` adds the-hit-list / guides / new-on-resy — pollutes with ~370 non-NYC URLs. (`:79-87`)
- Eater walker: single fetch of `https://ny.eater.com/maps`, extracts heatmap slugs.
- Persists URL queue to `data/ingest-progress.json` for crash-resume (`--resume`).

Other flags / env vars:

- `--dry-run` — print only, no DB writes.
- `--no-enrich` — skip Places.
- `--no-classify` — skip Gemini.
- `--no-batch-classify` — fall back to per-mention classification.
- `--from-cache` — re-run from `data/ingest-cache.json` without re-scraping.
- `CLASSIFY_DELAY_MS` (default 7000), `PLACES_DELAY_MS` (default 200), `CLASSIFY_BATCH_SIZE` (default 10), `CUTOFF_DAYS` (default 365).

## Author quote contract

For non-XHS sources (`eater`, `resy_blog`), the `recommendation` field on `xhs_sources` is a **structurally extracted** verbatim editor blurb — pulled directly from `<p class="duet--article--standard-paragraph">` (Eater) or `.venue2-lead` (Resy listicles). It is **not** LLM-generated. The LLM only does cuisine + feature classification on these sources.

For XHS, `recommendation` is the highest-liked creator quote about the venue from the post body, extracted by `extractRestaurantData`.

## Sync to Neon

Local SQLite is the working copy; Neon backs the deployed functions. They are kept in sync **manually**:

```bash
npm run push-data                                  # ON CONFLICT DO NOTHING — won't update existing
npx ts-node scripts/_sync-fields-to-neon.ts        # explicit per-row UPDATEs + re-pushes xhs_sources
```

Schema drift can happen in either direction — Neon has had `latitude`/`longitude` longer than SQLite. New scripts that need columns absent locally should `ALTER TABLE … ADD COLUMN IF NOT EXISTS` before reading. Keep `scripts/migrate.ts` in lock-step with `migrate-cloud.ts`.

## 2026-04-28 production state

Single live ingest run produced 592 canonicals + 839 source rows (303 XHS + 326 Resy + 210 Eater). 87/386 net-new canonicals (22.5%) are multi-source. See memory `project_source_overlap_counts.md`.
