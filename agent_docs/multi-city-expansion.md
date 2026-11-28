# Multi-city expansion: top 10 US cities by population

Started 2026-11-27. Owner's request: scrape restaurants for the **10 biggest US cities by population**, spread over several days so no quota gets exhausted.

## Cities (Census Vintage 2025 estimates)

| # | City | Key | Status |
|---|---|---|---|
| 1 | New York | `nyc` | live |
| 2 | Los Angeles | `la` | **next** (owner: LA only for now) |
| 3 | Chicago | `chi` | on hold (awaiting owner) |
| 4 | Houston | `hou` | on hold (awaiting owner) |
| 5 | Phoenix | `phx` | on hold (awaiting owner) |
| 6 | Philadelphia | `phl` | on hold (awaiting owner) |
| 7 | San Antonio | `sat` | on hold (awaiting owner) |
| 8 | San Diego | `sd` | on hold (awaiting owner) |
| 9 + 10 | Dallas + Fort Worth | `dfw` | on hold (awaiting owner). One metro: XHS posts treat DFW as one area, incl. Plano |
| — | SF Bay Area (not top 10; San Jose is #13) | `bay` | live, kept |

Sources: Census population clock (Vintage 2025) and Wikipedia's list of US cities by population. Fort Worth (1.03M) edges out Jacksonville (1.02M) for #10.

## XHS keywords per city (draft; finalize in step S1)

Ambiguous keywords (marked \*) only count a post if its title also names the city. This uses the same `AMBIGUOUS_KEYWORDS` / `TITLE_MARKERS` mechanism as `bay` in `backend/scripts/xhs-browser-ingest.ts`.

| Key | Keywords | Ambiguity notes / title markers |
|---|---|---|
| la | 洛杉矶美食, 洛杉矶探店, 洛杉矶新店, 洛杉矶餐厅, 洛杉矶必吃, 尔湾美食, 圣盖博美食, 洛杉矶约会餐厅 | Include Orange County (尔湾 / Irvine) in bounds |
| chi | 芝加哥美食, 芝加哥探店, 芝加哥新店, 芝加哥餐厅, 芝加哥必吃 | — |
| hou | 休斯顿美食, 休斯敦美食, 休斯顿探店, 休斯顿新店, 休斯顿餐厅 | two spellings (顿/敦) |
| phx | 凤凰城美食\*, 凤凰城探店\*, 凤凰城餐厅\*, 斯科茨代尔美食 | 凤凰城 also matches Chinese places (凤凰古城); markers: 亚利桑那, AZ, Phoenix, Scottsdale, Tempe, Chandler, Mesa |
| phl | 费城美食, 费城探店, 费城新店, 费城餐厅 | — |
| sat | 圣安东尼奥美食\*, 圣安东尼奥探店\* | markers: 德州, Texas, TX, San Antonio. Expect a small volume |
| sd | 圣迭戈美食, 圣地亚哥美食\*, 圣地亚哥探店\* | 圣地亚哥 = also Santiago (Chile); markers: 加州, San Diego, SD, La Jolla, 拉霍亚 |
| dfw | 达拉斯美食, 达拉斯探店, 达拉斯新店, 沃斯堡美食, 普莱诺美食 | — |

## Quotas (why this runs in steps)

- **XHS / RedNote:** a captcha appeared after ~150 note reads in one session; searches were fine at ~100 per session. Rule: **≤150 note reads per run, runs ≥4h apart**. A captcha means stop, keep the partial results, and retry at the next run.
- **DeepSeek V4-Pro:** no hard limit seen; it slows under heavy concurrency. Keep `EXTRACT_CONCURRENCY` at 5–15. Extraction is cached per note.
- **Google Places:** ~3–6 calls per restaurant, so ~150 posts ≈ 600 calls per city. Run **at most 2 city pipelines per run** to spread billing.
- **Prod (Neon sync, Vercel deploy):** never automatic. The final step asks the owner.

## Step queue (one step per scheduled run, in order)

**Scope (owner, 2026-11-27): Los Angeles only.** The other cities (chi, hou, phx, phl, sat, sd, dfw) are **on hold** until the owner gives instructions. Don't configure, count, read or pipeline them.

The scheduled task `multi-city-ingest` runs at 09:00 and 15:00 local. Each run does the **first unchecked step**, then checks it off here, commits and pushes. If a step fails (captcha, Chrome logged out, error), leave it unchecked, add a note under "Log", and stop. When every step is checked, report that LA is ready and recommend disabling the task until the owner names the next city.

- [x] **L1** Backend config for `la` + count:
  - In `backend/api/_lib/cityRegions.ts`, add LA regions ("boroughs") with localities. Suggested: Los Angeles (city neighborhoods: Koreatown, Downtown, Hollywood, Silver Lake, Echo Park, West LA…), San Gabriel Valley (Alhambra, San Gabriel, Monterey Park, Arcadia, Rosemead, Temple City, El Monte, Rowland Heights, Diamond Bar, Walnut, Hacienda Heights, Pasadena), Westside (Santa Monica, Culver City, Beverly Hills, West Hollywood, Venice/Marina del Rey), South Bay (Torrance, Gardena, Redondo/Manhattan/Hermosa Beach, Long Beach), Orange County (Irvine, Costa Mesa, Newport Beach, Anaheim, Fullerton, Tustin, Garden Grove, Huntington Beach), plus an "Other" catch-all for in-bounds but unmapped localities.
  - Add `CITY_META.la`: displayName "Los Angeles", Places suffixes ("CA" / "Los Angeles, CA"), bounds covering LA County + Orange County ≈ lat 33.40–34.45, lng −118.95…−117.40.
  - Keywords + markers in `backend/scripts/xhs-browser-ingest.ts`: see the keyword table (la row).
  - Add a `MAX_NEW_READS` cap in the read phase.
  - Unit-check `regionForLocality('la', …)` for a few localities.
  - Then run the count: `CITY=la MAX_SCROLLS=15 npx ts-node -T scripts/xhs-browser-ingest.ts`. Log per-keyword counts and the total.
- [x] **L2** Read `la`: `CITY=la MODE=read MAX_POSTS=150` (≤150 new reads). Log read/failed/too-old counts.
- [x] **L3** Pipeline `la`: `CITY=la POSTS_FILE=data/xhs-raw/posts-la.json EXTRACT_CONCURRENCY=10 npx ts-node scripts/test-pipeline.ts`.
  - Verify in local SQLite: rows, region distribution, fill rates (maps, cuisine, features, coords, price, rating), out-of-area rejections.
  - Check the local API: `npx ts-node scripts/local-server.ts`, then GET `/api/restaurants/weekly?city=la` and `/api/locations?city=la`.
- [ ] **L4** iOS enablement for `la`:
  - Add LA to `WeeklyRestaurantService.cities` + `cityBounds`, the `CityPickerCard` style (e.g. 🌴 "LA & Orange County"), and the region names in the iOS `knownBoroughs` whitelists (Discovery + Home).
  - Build, verify in the simulator against a local backend, release to TestFlight, commit + push.
  - **Ask the owner** to approve: the Neon sync (`SINCE=<date> npx ts-node -T scripts/sync-runs-to-neon.ts`), then `npm run mirror-photos`, then the prod deploy of the backend config (snapshot diffed against HEAD; curl `weekly?city=la` afterwards).

### On hold (owner will instruct)

chi, hou, phx, phl, sat, sd, dfw. Their keyword drafts are in the table above. When the owner names a city, add L-style steps for it here.

## Log

- 2026-11-27 (manual, owner asked to run early) — **L3 done.** Pipeline on 150 LA posts (EXTRACT_CONCURRENCY=10, ~1 min extraction): 32 posts dropped by the complaint filter; Places 185 enriched / 8 out-of-area rejected / 3 non-food rejected / 3 not found → **166 rows** in local SQLite, 183 XHS sources. Regions: Los Angeles 53 · San Gabriel Valley 42 · Orange County 33 · Westside 29 · Other 5 · South Bay 1 · blank 3 (no Places match). Fill: maps/coords/rating/photo 163, features 161, website 144, price 142, cuisine 133 (top: chinese 39, american 29, japanese 22, korean 13); **bookable 0** (booking-link backfill not run yet, same as bay before BAY-BOOK). Local `/api/restaurants/weekly?city=la` → ready, **163 served**; `/api/locations?city=la` lists the regions. **Bug found + fixed:** rednote's English UI formats note likes as "6,809" and `parseCount` stopped at the comma (→ 6), so the most-liked posts got the lowest likes (12/150 LA posts; also 26/151 NYC and 4/150 Bay, already in prod). `parseCount` now strips commas, cached notes re-derive likes from `raw.interactInfo`, `posts-la.json` was regenerated (0 new reads), and `scripts/repair-source-likes.ts` fixed 17 LA source rows (+ total_likes deltas). NYC/Bay repair (local + Neon) done the same day after owner approval (LIKES-COMMA-1). Next: L4 iOS.
- 2026-11-27 (manual, owner asked to run early) — **L2 done.** Read the top 150 of 542 LA candidates (search ❤ ≥198) → `data/xhs-raw/posts-la.json`: 150 ok, 0 failed, 0 older than 6 months. The first attempt (17:00) read 143 new notes; it hit one captcha around note 20, which cleared within the wait window, then the process was killed when the session ended at note ~143 before writing the posts file. The 21:54 re-run served 143 from the note cache and read 7 new → 150 new reads total for L2. Next: L3 pipeline.
- 2026-11-27 (15:00 run) — **L1 done.** `cityRegions.ts`: `la` regions Los Angeles / San Gabriel Valley / Westside / South Bay / Orange County / Other (catch-all for in-bounds unmapped localities, so `weekly.ts → filterToCity` keeps them); locality "Los Angeles" is split by Places neighborhood (Venice/Westwood/Sawtelle… → Westside, San Pedro/Wilmington/Harbor City → South Bay, else Los Angeles). `CITY_META.la`: displayName "Los Angeles (including Orange County)" (so the LLM doesn't treat Irvine posts as off-topic), suffixes "CA" / "Los Angeles, CA", bounds lat 33.40–34.45, lng −118.95…−117.40. `placesEnricher` now uses the locality→region path for every non-NYC city (bay behaviour unchanged). Ingest script: `la` keywords + `MAX_NEW_READS` (default 150, cached notes don't count). No LA keyword needed the ambiguity filter. Region unit check: 11/11 LA cases + bay spot checks OK. **Count** (`MAX_SCROLLS=15`, ≥50❤, last 6 months): 洛杉矶美食 100 (scroll cap, lowest ❤137) · 洛杉矶探店 100 (cap, ❤100) · 洛杉矶新店 120 · 洛杉矶餐厅 161 · 洛杉矶必吃 80 (cap, ❤137) · 尔湾美食 120 (first attempt timed out clicking the 最多点赞 filter tag; retried alone and merged into the file) · 圣盖博美食 83 · 洛杉矶约会餐厅 80 → **542 unique** (≥100❤ 335, ≥500❤ 35, ≥1000❤ 13; 0 older than the cutoff). The 150th candidate has ❤198, so L2's 150 reads cover everything above that. No captcha; 9 searches, 0 note reads.
- 2026-11-27 — Owner narrowed scope to **Los Angeles only**; other cities on hold. Queue rewritten as L1–L4.
- 2026-11-27 — Plan written; scheduled task `multi-city-ingest` created (09:00 + 15:00 daily). Same day, shipped separately: "This week's picks" follows GPS unless a city is picked on the Pick page (TestFlight build 37).
