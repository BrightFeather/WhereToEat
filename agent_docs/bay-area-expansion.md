# Bay Area expansion (city key `bay`)

Started 2026-11-26. Goal: harvest good SF Bay Area restaurant recommendations from Xiaohongshu / RedNote (湾区美食 and related keywords), then put them through the same extractor → Places → merge pipeline as NYC, stored in the same tables with `city = 'bay'`. No schema changes.

## Decisions

| Topic | Decision | Why |
|---|---|---|
| City key | `bay` | One key for the whole metro. XHS creators post about "湾区" as a single area, and SF-only would drop the South Bay and Peninsula, where much of the Chinese-community dining is. |
| Regions (stored in `borough`) | San Francisco · East Bay · Peninsula · South Bay · North Bay | `borough` is the region slot that `filterToCity` and `/api/locations` already use. Bay Area "boroughs" are regions, assigned from the Places `locality` (city name). |
| Neighborhood | SF: Places neighborhood / sublocality. Elsewhere: the city name (Cupertino, Oakland, …). | Outside SF, people pick by city, not neighborhood. |
| Scraper | Browser ingest (`scripts/xhs-browser-ingest.ts`, `api/_lib/xhsBrowser.ts`) attached to the long-lived Chrome on port 9333 | Same reasons as NYC (see TASKS § XHS scraping stability). |
| Popularity bar | Same as NYC: ≥50 likes, published within 6 months (server-side filters 最多点赞 + 半年内) | XHS web doesn't expose view counts. |
| Geo guard | Places search restricted to a Bay Area rectangle; results outside it are dropped | Stops "湾区" posts about LA, Seattle or Sacramento getting attached to Bay Area rows. |

## Keywords (v1)

湾区美食, 旧金山美食, 湾区探店, 湾区新店, 湾区餐厅, 湾区必吃, 硅谷美食, 南湾美食*, 东湾美食*, 半岛美食*, 旧金山探店, 圣何塞美食, 湾区约会餐厅, 湾区brunch, 湾区漂亮饭, 湾区日料, 湾区中餐, 湾区火锅

\* Ambiguous: results found only via these keywords need a Bay Area place name in the title (see Findings). 奥克兰美食 was used in the first count and then removed (Auckland).

## Tasks

### P0 — get correct Bay Area data into the DB

| # | Task | Status |
|---|---|---|
| BA-P0-1 | `cityRegions.ts`: add `bay` with 5 regions + neighborhoods/cities | ✅ plus `CITY_META` (query suffixes, bounds) and `regionForLocality` |
| BA-P0-2 | City-aware Places enrichment: query suffix, `locationBias` rectangle + out-of-bounds rejection, region from `locality`, neighborhood rules above. NYC behaviour unchanged. | ✅ The guard rejected 3 matches on the first run (Commerce CA, Long Beach, Guangzhou). |
| BA-P0-3 | City-aware extractor prompt | ✅ `extractRestaurantData(post, city)`; NYC prompt text unchanged |
| BA-P0-4 | City-aware ingest: `CITY=bay` → Bay Area keyword list, per-city `candidates-<city>.json` / `posts-<city>.json` | ✅ plus an ambiguous-keyword relevance filter (see Findings) |
| BA-P0-5 | City-aware pipeline (`CITY` env in `test-pipeline.ts`, was hardcoded `nyc`) | ✅ |
| BA-P0-6 | Run count → read → pipeline for `bay` into local SQLite; verify field fill rates | ✅ 2026-11-26: 690 candidates → 511 relevant → top 150 read (≥152 likes) → 154 extracted → 143 merged → **139 rows, 133 served**. Fill rates: Maps 133, cuisine 112, features 136, coords 134, price 117, rating 133, region 134, quote 127. |

### P1 — serve it

| # | Task | Status |
|---|---|---|
| BA-P1-1 | `weekly.ts`: filter by `city` in SQL and make the etag per city | ✅ verified locally: `city=bay` → ready, 133 rows; `city=nyc` → ready, 162 rows |
| BA-P1-2 | `/api/locations?city=bay` returns the regions | ✅ verified locally |
| BA-P1-3 | iOS: choose the city in the app | ✅ First shipped as GPS-based switching (build 29). Replaced 2026-11-26 by an explicit **city picker** at the top left of the Pick page (New York / Bay Area, default New York, persisted), plus a fix for a race where a late NYC response overwrote the Bay deck. See TASKS § City picker (CITY-1..4). |
| BA-P1-4 | Sync `bay` + new NYC rows to Neon and `vercel --prod` for the `weekly.ts` city filter | ✅ 2026-11-26 via the new `scripts/sync-runs-to-neon.ts` (not push-data). Prod: `city=bay` → ready, 133 rows. |

### P2 — polish

| # | Task |
|---|---|
| BA-P2-1 | Resy / OpenTable booking-link backfill for `bay` rows (scripts assume NYC coordinates) |
| BA-P2-2 | Mirror photos to Blob; price-level backfill for `bay` |
| BA-P2-3 | Editorial sources: Eater SF, Resy SF blog |
| BA-P2-4 | UI copy: "Borough" filter label → "Region" when city = bay |
| BA-P2-5 | Weekly scheduled run covering both cities (launchd; see PARSE-0) |

## Findings (2026-11-26)

- **Ambiguous keywords.** 奥克兰 = Auckland (all 116 posts found only via 奥克兰美食 were NZ), so it was removed from the list. 半岛 = Macau Peninsula / Hainan 神州半岛; 南湾 / 东湾 also name places in Macau, Hong Kong, Shenzhen and LA. Candidates found *only* via 半岛美食 / 南湾美食 / 东湾美食 are kept only if the title names a Bay Area place (`TITLE_MARKERS.bay` in `xhs-browser-ingest.ts`). That rescued 14 and dropped 179 of 193.
- **Volume:** 690 posts with ≥50 likes in 6 months across 19 keywords (NYC: 940 across 15). Search returns about 120 posts per query before the platform stops.
- **Captcha:** none during the Bay Area count or the 150 reads. NYC hit one at about 150 reads, so ~150 reads per session is the working budget.

## Log

- 2026-11-26 — Bay Area wasn't showing in the app: a stale-response race, the NYC-only borough whitelist, and the "only bookable" filter (0 Bay rows bookable). All fixed in iOS, and the city is now picked explicitly on the Pick page.
- 2026-11-26 — P1-4 done: synced to Neon and deployed; prod serves both cities. P2 untouched.
- 2026-11-26 — P0 done and P1-1..3 done; data in local SQLite only.
- 2026-11-26 — plan written. NYC browser ingest is running first; Bay Area work starts after it, because both share the single logged-in Chrome.
