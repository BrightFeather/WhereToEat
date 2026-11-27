# Multi-city expansion: top 10 US cities by population

Started 2026-11-27. Owner's request: scrape restaurants for the **10 biggest US cities by population**, spread over several days so no quota gets exhausted.

## Cities (Census Vintage 2025 estimates)

| # | City | Key | Status |
|---|---|---|---|
| 1 | New York | `nyc` | live |
| 2 | Los Angeles | `la` | queued |
| 3 | Chicago | `chi` | queued |
| 4 | Houston | `hou` | queued |
| 5 | Phoenix | `phx` | queued |
| 6 | Philadelphia | `phl` | queued |
| 7 | San Antonio | `sat` | queued |
| 8 | San Diego | `sd` | queued |
| 9 + 10 | Dallas + Fort Worth | `dfw` | queued (one metro; XHS posts treat DFW as one area, incl. Plano) |
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

The scheduled task `multi-city-ingest` runs at 09:00 and 15:00 local. Each run does the **first unchecked step**, then checks it off here, commits and pushes. If a step fails (captcha, Chrome logged out, error), leave it unchecked, add a note under "Log", and stop.

- [ ] **S1** Backend city configs for `la chi hou phx phl sat sd dfw` in `backend/api/_lib/cityRegions.ts`:
  - regions ("boroughs") with localities, `CITY_META` (displayName, Places suffixes, bounds), plus an "Other" catch-all region for in-bounds but unmapped localities.
  - Keyword lists + ambiguity markers in `backend/scripts/xhs-browser-ingest.ts`.
  - A `MAX_NEW_READS` cap in the read phase.
  - Unit-check `regionForLocality` for each city. **No scraping in this step.**
- [ ] **S2** Count phase for `la chi hou phx`: `CITY=<key> MAX_SCROLLS=15 npx ts-node -T scripts/xhs-browser-ingest.ts`, one city after another. Record per-city counts in the Log.
- [ ] **S3** Count phase for `phl sat sd dfw`.
- [ ] **S4** Read `la`: `CITY=la MODE=read MAX_POSTS=150`.
- [ ] **S5** Read `chi` (≤150) · pipeline `la` (`CITY=la POSTS_FILE=data/xhs-raw/posts-la.json EXTRACT_CONCURRENCY=10 npx ts-node scripts/test-pipeline.ts`).
- [ ] **S6** Read `hou` · pipeline `chi`.
- [ ] **S7** Read `phx` · pipeline `hou`.
- [ ] **S8** Read `phl` · pipeline `phx`.
- [ ] **S9** Read `sat` + `sd` (top 75 each, since they're smaller) · pipeline `phl`.
- [ ] **S10** Read `dfw` · pipelines `sat`, `sd`.
- [ ] **S11** Pipeline `dfw`, then the iOS side:
  - add the new cities to `WeeklyRestaurantService.cities` + `cityBounds`, `CityPickerCard` styles (emoji + subtitle), and the iOS `knownBoroughs` region whitelists (Discovery + Home);
  - build and verify in the simulator; TestFlight; commit + push.
  - Then **ask the owner** to approve the Neon sync (`scripts/sync-runs-to-neon.ts`), `npm run mirror-photos`, and the prod deploy.

## Log

- 2026-11-27 — Plan written; scheduled task `multi-city-ingest` created (09:00 + 15:00 daily). Same day, shipped separately: "This week's picks" follows GPS unless a city is picked on the Pick page (TestFlight build 37).
