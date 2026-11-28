# WhereToEat — Task Tracker

Status legend: ✅ Done · 🔄 In progress · ⏳ Blocked · 📋 Todo

---

## Active priorities (as of 2026-04-29)

The next wave of work, ranked. Pick from the top.

> **Top of the queue today:** P3 (Favorites UI — slot 12 is open, ~1h to wire up) → P4 (weekly auto-run launchd, ~30min) → P7 (device test M10/M13, needs a real iPhone for a day). Everything past P4 is a "want", not a "need".

### Recently shipped (2026-11-27)

| # | Task | Done | Notes |
|---|------|------|-------|
| ASC-1 | Prepare and submit WhereToEat for public App Store release | ✅ 2026-11-27 | App Store Connect app `6764465411` ("WhereToEat NYC"). Filled in everything the "Add for Review" flow required: subtitle + Food & Drink/Lifestyle category, Content Rights (contains third-party content, rights held), fixed a version mismatch (ASC was 1.0, builds were 1.1 — bumped ASC to 1.1 and attached build 38), Age Ratings questionnaire (→ 16+, driven by Unrestricted Web Access + infrequent alcohol mentions), Pricing (Free) + Availability (174/175 countries, China mainland excluded to dodge its Security Assessment/AIGC filing requirements), a Privacy Policy published as a Claude Artifact page + the App Privacy data-nutrition-label questionnaire (5 data types, all App Functionality, none used for tracking), and 4 App Store screenshots (Home/Discovery/Detail/Find) captured from the iPhone 15 Pro simulator and uploaded via Asset Library. See SPEC § App Store Release for the full declaration. User clicked "Add for Review" themselves; submitted to Apple 2026-11-27. **Follow-up once Apple responds:** if rejected, re-check this section; if approved, decide manual vs automatic release (currently unset). The privacy policy lives on claude.ai, not an owned domain — fine for now, but revisit if that ever becomes a concern. |
| TF-EXPIRED | App inaccessible on iPhone — TestFlight build expired | 2026-11-26 | No code changes; last upload was build 27 (2026-05-05), ~205 days ago — well past TestFlight's 90-day auto-expiry window, which is why the app stopped opening. Fix was a plain re-release (build 28) via `scripts/ios/testflight.sh`, resumed manually after export (archive doesn't need to be redone — see `~/.claude/projects/.../memory/project_testflight_pipeline.md`). **Found two Apple-account blockers along the way, both needing the Account Holder to act in a browser — not fixable from the CLI:** (1) `exportArchive` failed with "Unable to process request - PLA Update available" / "No signing certificate iOS Distribution found" — fixed by accepting the pending Program License Agreement at developer.apple.com/account. (2) After that, `altool --validate-app` failed with "Cannot determine the Apple ID from Bundle ID" and `altool --list-apps` returned zero apps for the API key — turned out to be a **second, separate** agreement (Paid Apps / Agreements, Tax and Banking) still pending; accepting that one unblocked both the API key and the upload. **Takeaway:** "TestFlight build expired" and "an Apple agreement needs re-signing" can compound — if a re-release hasn't happened in months, check Agreements, Tax, and Banking for pending items before assuming the pipeline itself is broken. Build 28 uploaded successfully, now processing in App Store Connect. |
| LAT-1 | First-card latency: cache + prefetch pass | 2026-11-26 (iOS in TestFlight build 30; backend deployed as `whereto-ph3orpehf`, prod verified nyc 162 / bay 133) | **iOS:** (1) `DiscoveryViewModel.loadCards` no longer awaits `/api/user/reservations` + `/api/user/blocks` before building the deck. It builds from the last-known ids (`ReservationService.lastKnownReservedIds/BlockedIds`, persisted per user id) and `applyRemoteFilters` prunes only cards the user hasn't reached once the fresh answers land. The fetchers fall back to last-known instead of `[]` on failure. (2) `ImageCache.data(for:)` / `prefetch(_:)`: shared loader with in-flight dedup, used by `CachedAsyncImage`. It prefetches the top 25 photos whenever `WeeklyRestaurantService.status` publishes, plus the 3 Home picks and the current + next 3 Discovery cards. (3) `WeeklyCache.isWarm` is now 72h (was 24h), so `bootstrap` blocks on the network only after 72h or a Monday rollover. **Backend (`weekly.ts`):** 8 sequential DB round-trips → 2 on a cache miss. Removed the debug-only full-table `allForDebug` scan, ran the etag pair in parallel, and moved latest-run / running-run / stale-run reap / restaurants / sources into one `Promise.all`. `fetchSources` replaces `hydrateSources` and uses a city subquery, so it no longer waits for row ids. Verified locally against SQLite: identical restaurants for nyc (162) and bay (133), and the 304 path still works. Deployed from a snapshot (previous prod + `weekly.ts` only). Prod checks: same ids and source counts as the old code, 304 on `If-None-Match` for both cities. |
| LAT-2 | Mirror Places photos to Vercel Blob | 2026-11-26 | New `npm run mirror-photos` (`backend/scripts/mirror-photos.ts`). Prod now serves 1,468/1,468 deck photos from Blob, all HTTP 200, and no Places API key in `/weekly` (one bay row has no photo at all). Expired Places photo names are re-read from Place Details (236 rows recovered that way). `RestaurantCardView` shows the fork-and-knife placeholder when a photo fails, not a gray box. **Incident:** the first full run (CONCURRENCY=6) treated Places 429s as expired and nulled photos on 286 rows for ~10 min. Restored from local SQLite, script fixed (only 400/404 = gone; 429/5xx retried, otherwise the row is untouched), and the re-run fixed all 312 affected rows with 0 drops. **Ongoing:** run `npm run mirror-photos` after every `sync-runs-to-neon.ts` (documented in `backend/CLAUDE.md`). |
| HOME-1 | Home: Trending now rail + I'm feeling lucky | ✅ Built 2026-11-27 on branch `claude/home-trending-lucky` (not merged to main) | Client-only. Trending rail under This week's picks (`TrendingRail.swift`, `HomeViewModel.trendingPicks`): log-likes × 14-day half-life ÷ √(restaurants per post), 30→60→90 d window, hidden under 4, ≤2/cuisine, ≤1/post, cards stay once shown today. Swipe-through CTA removed. Lucky card last on Home, **Peach card** palette chosen by the user (light peach / dark cocoa), inline CRAVING / WHERE chips, live match count, 3 rolls/day, full-screen roll (`LuckyCard.swift`, `LuckyRollView.swift`). Verified in the iPhone 15 Pro simulator (NYC + Bay, light + dark). Design + spec: `agent_docs/home-trending-and-lucky.md`, SPEC § Home. |
| SET-CITY | City picker moves from Pick page to Settings | ✅ 2026-11-27 on branch `claude/home-trending-lucky` | Pick toolbar city chip + `CityPickerCard` removed. Settings → City lists Current location + `WeeklyRestaurantService.cities` (New York, Bay Area = the cities with rows in prod; LA has 0 rows so it's not listed). Free-form `CityOverrideView` geocoder search deleted; a legacy `locationOverride` shows with Clear and any city pick clears it. |
| SET-APPEAR | Settings → Appearance (Light default / Dark / Match system) | ✅ 2026-11-27 on branch `claude/home-trending-lucky` | `AppAppearance` in `WhereToEatApp.swift`, `UserDefaults["app_appearance"]`, applied via window `overrideUserInterfaceStyle`. **Behavior change:** the app used to follow iOS dark mode; now it's light unless the user picks Dark / Match system. Other screens' dark styling wasn't re-reviewed (Pick's borough chips render black in dark mode). |
| HOME-1b | Home stat pills + Lucky widen button polish | ✅ 2026-11-27 on branch `claude/home-trending-lucky` | `StatPill` now matches the pick cards (cream fill, `cardBorder` hairline, shadow, chevron) instead of flat `systemGray6`. Lucky hides its meta line at 0 matches so "Widen to all of New York" isn't truncated. Follow-up done 2026-11-27: selected chips scroll into view; WHERE hides regions with no match for the cuisine instead of dimming them (dimmed chips looked broken). |
| DARK-1 | Redesign the dark theme | ✅ 2026-11-27 on branch `claude/home-trending-lucky` | User picked **A · Warm charcoal**. Dark values of `homeBg*`, `detailBg*`, `discoveryBg*`, `cardBorder` and the tab bar changed (`HomeView.swift` Color extension); new `Color.surface` / `Color.surfaceMuted` replace 25 `systemBackground` / `systemGray6` fills across Views (white / gray6 unchanged in light mode). Lucky card dark palette updated. Checked Home, Pick, Find, My List and detail in dark in the simulator. Not re-checked in dark: Settings form rows, Bookings, the booking confirm sheets, Login/Welcome. |
| DARK-2 | Dark mode: dark page, bright cards (tab bar part superseded by DARK-3) | ✅ 2026-11-27 on branch `claude/home-trending-lucky` | User: "make only the background dark and the cards and tabs bright". `View.brightCard()` (HomeView.swift) forces the light color scheme on cards, chips and buttons; tab bar fixed cream with gray items. Checked Home, Pick, My List, detail in dark. Detail-page gray tab bar fixed in FIND-1 (`creamTabBar()`). Settings form rows still follow the dark scheme. |
| FIND-1 | Find map looks cluttered | ✅ 2026-11-27 on branch `claude/home-trending-lucky` | Greedy screen-space clustering (~60 pt) into orange count bubbles, tap to zoom in; names only on the selected pin. Also pinned the cream tab bar per tab (`View.creamTabBar()`), which fixes the gray tab bar on Find and on the restaurant detail page (Map / pushed views were replacing the UIKit appearance). Re-applied the detail-page `brightCard()` edits that a revert had dropped from the DARK-2 commit. Not done: a bubble can sit under the floating cuisine chip row at the top edge. |
| DARK-3 | Tab bar dark in dark mode | ✅ 2026-11-27 on branch `claude/home-trending-lucky` | User: tab bar background should be dark in dark mode (DARK-2 had kept it cream; "tabs" there meant something else). Tab bar now uses `homeBgMid` (cream / charcoal) via UIKit appearance + `View.themedTabBar()` (renamed from `creamTabBar`), which still stops Map / detail from turning it system gray. |
| DARK-4 | Dark theme redesign, round 3 + consistent tabs | ✅ 2026-11-27 on branch `claude/home-trending-lucky` | User picked **A · Low light** and asked for consistent theme/colors across the four tabs. Tonal warm grays (#14110F page / #1F1A17 card / #241C17 raised / #2E2621 inset / #1A1613 tab bar), off-white nav titles, photos 8% dimmer in dark, softened slot labels, Lucky dark palette restored. `AccentColor` asset set to orange (#FA7A1A / #F0843C), so tab tint, buttons, toggles and Pick's borough chips (was purple) and Reset (was blue) share one accent in light and dark. Removed `.brightCard()`. Checked Home, Pick, Find, My List, Settings in dark and Home in light. Body text in dark is still system white (an app-wide text color also recolored button tints, so it was dropped). Login screen still has its own blue/purple buttons. |
| DARK-5 | Brighter restaurant cards and lists in dark | ✅ 2026-11-27 on branch `claude/home-trending-lucky` | Dark card #1F1A17 → #2A231E (pick/Trending cards, stat pills, My List and Bookings rows, quote cards), raised #312822, inset #3A302A. New `Color.listPanel` gives Find's bottom list the card color in dark (light unchanged). |
| MERGE-1 | Merge home-trending-lucky + google-signin into main | ✅ 2026-11-27 | Merged both (no conflicts) on `claude/merge-home-google` over latest main (incl. LA pipeline + App Store submission commits), built and smoke-tested, fast-forwarded main. HOME-3 done. |
| HOME-4 | Lucky: boroughs expand to neighborhoods | ✅ 2026-11-27 on main | `LuckyPlace.neighborhood(region:name:)`, NEIGHBORHOOD chip row under WHERE, widen-to-region at 0 matches; chip rows re-center when options load/reorder; Lucky button label no longer truncates. Verified chips + selection in the simulator; a roll inside a neighborhood wasn't exercised (today's 3 rolls were used up). |
| HOME-2 | NEW THIS WEEK never matches recent posts | 🔲 Found 2026-11-27, not fixed | `HomeViewModel.homePicks` parses `postCreatedAt` with a default `ISO8601DateFormatter`, which rejects the `.000Z` fractional seconds the API sends, so the slot always falls back to the next top-ranked restaurant. Fix: use `HomeViewModel.parsePostDate` (added for Trending). |
| HOME-3 | Merge `claude/home-trending-lucky` into main | ✅ 2026-11-27 (MERGE-1) | Branch carries a TestFlight build-number bump; merge it (or bump past it) before the next release from main, or ASC rejects the duplicate build number. |
| LAT-4 | Gray photo tiles everywhere: Vercel Blob stores suspended | ✅ 2026-11-27 | **Cause:** Vercel suspended both Blob stores (`restaurant_photos_public` 740 MB / 4.1k files, and the empty `restaurant-photos`), so every photo returned `403 Your store is blocked`. Storage was under the Hobby 1 GB cap. The likely trigger is Hobby Blob operation limits after the LAT-2 mirror runs (~4k `put`s on 2026-11-26). Photos the phone had already cached kept rendering, which hid the outage. **Fix:** the owner upgraded the Vercel plan. Both stores are `Active` again, and all 4,056 deck photo URLs (nyc + bay) return 200. **Home guard:** pick slots skip restaurants with no photo URL (3 nyc rows, 1 bay row) or whose photo fails with an HTTP error or a non-image (`HomeViewModel.verifyPickPhotos`, `ImageCache.HTTPStatusError`), capped at 30 swaps. Verified in the simulator by pointing two picks at 404 URLs: both were swapped, no gray tile. Discovery cards / Find rows still show the fork-and-knife placeholder for a dead photo (not changed). |
| LAT-3 | Deck shrank to the latest run only (NYC ~690 → 162) | ✅ 2026-11-26 | The user chose to restore the full deck. `weekly.ts` now serves every `is_available_this_week = 1` row for the city, and the latest completed run decides only `ready` vs `stale`. Deployed `whereto-4r05tq1tz`. Prod: nyc 684 (Manhattan 499, Brooklyn 138, Queens 40, Bronx 5, Staten Island 2), bay 133, 304 OK, all 4,056 photo URLs on Blob and HTTP 200. Simulator shows the Queens / Bronx / Staten Island chips again. Response is ~1.9 MB for nyc (was ~0.8 MB at 162 rows; gzip'd on the wire, and the device cache means it's fetched at most every 6–72h). |
| BAY-BOOK-1 | Bay deck is empty for default users | ✅ 2026-11-26 (data + iOS; backend deploy pending approval) | New `scripts/backfill-booking-links.ts` renders each restaurant's website in headless Chrome and collects every link, iframe and network request (OpenTable `rid=`, Resy widget venue ids, Tock iframes). It also searches Resy's public venue search (no login) within 400 m with a name match, and rejects Resy venues outside the city. Bay result, written to SQLite and Neon: **23 of 133 deck rows bookable** (OpenTable 16, Resy 5, Tock 3; R&G Lounge has OT + Tock). The other 116 are mostly cafés, bakeries, tea shops and casual noodle/hot-pot places with no online booking. A few real restaurants are still missing (Cotogna, San Ho Won, Terra, ROOH, Limón, Skates on the Bay, Chef Chu's); see BAY-BOOK-2. **Tock:** new `xhs_restaurants.tock_booking_url` (SQLite + Neon, both migrations) and `tockBookingUrl` in `/weekly` (row SELECT + etag projection). iOS maps it to `ReservationSource(.tock)` with a shared `WeeklyRestaurant.isBookable`. Verified in the simulator against a local backend: the Bay deck shows 23 picks with "only bookable" on. Deployed 2026-11-26 after the user approved it. Prod bay: 23 bookable (Resy 5, OpenTable 16, Tock 3); NYC unchanged (684, 308 bookable). |
| BAY-BOOK-2 | Recover the remaining bookable Bay restaurants | ⏳ Blocked, needs a sanctioned source | The user asked for links for all remaining Bay restaurants (2026-11-26). No automated path is allowed. OpenTable (Akamai) and Tock (Cloudflare) block plain HTTP and headless browsers. Searching them by driving a real Chrome to get past that is bot-detection evasion, so it was dropped, and the code was not committed. Resy's public search and each restaurant's own website were already used (23 found). Options: (a) the user adds links by hand for the few real sit-down restaurants (Cotogna, San Ho Won, Sushi Sho, Kodawari, Terra, ROOH SF, Limón, Skates on the Bay, Chef Chu's, Orchard City Kitchen, RH Rooftop, HL Peninsula); (b) an official partner API (OpenTable affiliate program, Tock partner access). Most of the other ~100 are cafés, bakeries, tea shops and casual noodle/hot-pot places with no online booking. Note: the pre-existing `backfill-opentable.ts` also works by beating Akamai with a headed persistent-profile Chrome (its own comment says so), and it returns 0 results now anyway. Treat it as retired. |

### Active queue (Todo / Blocked / Partial)

| Rank | # | Task | Status | Why now |
|---|---|------|--------|---------|
| 1 | **P3** | Favorites UI (heart toggle + "Favorites" section in My List) | 📋 Todo — needs route swap | **Slot 12 is open** (post-D22 archive). Restore `backend/api-archive/user/favorites/{index,[restaurantId]}.ts` → `backend/api/user/favorites/`, wire heart on `RestaurantCardView` + `RestaurantDetailView` (POST/DELETE), list in My List under a separate section above local saves. Demonstrates real cross-device state — currently My List is `UserDefaults`-only. |
| 2 | **P4** | Weekly pipeline auto-run (macOS launchd) | 📋 Todo | Today the deck only refreshes when you run `bash backend/scripts/run-pipeline.sh && cd backend && npm run push-data`. Cheapest unblock: a `~/Library/LaunchAgents/com.weijia.wheretoeat.pipeline.plist` that fires every Monday at 9am local + writes to `data/pipeline.log`. Removes the manual step entirely. |
| 3 | **P7** | Verify M10 notification-permission prompt + M13 T-24h reminder on device | 📋 Todo | Device-day test (simulator can't time-shift `UNUserNotificationCenter` reliably). Validates the booking → reminder loop end-to-end and is a release-readiness gate for TestFlight. |
| 4 | **N1** | Re-run `npm run backfill-price` periodically | 📋 Todo | 40 of 592 rows still null after the priceRange fallback (Google hasn't classified them). Either fold a `--refresh` pass into the local pipeline run, or schedule monthly. Also re-run after every ingest because new restaurants land without `price_level`. |
| 5 | **N2** | Verify a domain on Resend → switch `FEEDBACK_FROM` to branded sender | 📋 Optional | Today's `from` is `WhereToEat <onboarding@resend.dev>` (Resend sandbox sender). Verify a domain at `resend.com/domains` (3 DNS records, ~5min wait), then `vercel env add FEEDBACK_FROM production` = `WhereToEat <feedback@<your-domain>>`. Lets feedback emails go to any recipient (not just the Resend account owner) and brands the from address. Currently working without this. |
| 6 | **MS9** | Archive paperwork — confirm `api/scrape/eater.ts` is gone | 📋 Todo (5min) | Already moved to `backend/api-archive/scrape/eater.ts`; just close the task. |
| 7 | **N3** | Resy badge on My List rows | 📋 Todo | `SourcePlatform` enum has no `.resy` case yet — synthesize a chip from `restaurant.reservationSource.platform == .resy` instead of stretching the enum. Tiny polish; My List already shows the Xiaohongshu / Eater badges via `distinctPlatforms`. |
| 8 | **X9–X19** | XHS link import — async redesign | 📋 Todo (sizable, ~2-4h) | Fully designed in SPEC § XHS link import — async flow. Today's `POST /api/restaurants/import-xhs` blocks for ~17s on a fresh post; new flow returns `pending` instantly, processes in `event.waitUntil()`, polls from iOS. Adds `import_jobs` table, rewrites the route as a fast-path, plus iOS pending-row UI + foreground polling + done-notification. Tracked as 11 sub-tasks (X9–X19) further down. |
| 9 | **P6b** | Google Sign-In: set `GOOGLE_IOS_CLIENT_IDS` on Vercel + first real sign-in | ⏳ Blocked on user | iOS side shipped (P6, branch `claude/google-signin`). Prod `/api/auth/login` currently answers Google tokens with `401 GOOGLE_IOS_CLIENT_IDS env var is not set`. User: `vercel env add GOOGLE_IOS_CLIENT_IDS production` = `617615737877-0pdsb8nrjnosdhnsebn794501t1o5m52.apps.googleusercontent.com`, then redeploy the current prod deployment (env changes need a redeploy). Then sign in once on device and confirm Settings → Account shows "Google" and pre-login bookings are still there (anonymous → Google migration). Also confirm the GCP OAuth client's bundle id is `com.weijia.wheretoeat` (the old setup note said `com.wheretoeat.app`). |
| 10 | **P2b** | Restore `backend/.env.local` secrets wiped by `vercel env pull` | 🔄 Partial | Still missing locally: `RESY_PASSWORD`. Only matters if the archived reservation backfill scripts are revived. `ANTHROPIC_API_KEY` is droppable (Gemini-only path). |
| 11 | **P2** | Ship the weekly XHS pipeline on Vercel | 📋 Deferred | Was P0; demoted because local-only works fine and Pro upgrade isn't budgeted. To reactivate: see SPEC § XHS pipeline (2026-04-29 model). |
| 12 | **N4** | gstack upgrade 0.15.5 → 1.20.0 | 📋 Optional | Major bump available; `/gstack-upgrade` when convenient. Not blocking. |

### Follow-ups from 2026-05-03 LLM migration

| # | Task | Notes |
|---|------|-------|
| TOPUP-RESUME | Re-run `npm run topup-asian` after XHS rate-limit cools (≥4h) | Should pick up the remaining ~165 restaurants; idempotent. Consider lowering `MAX_SEARCH_PAGES` to 1 + adding inter-restaurant sleep to stay under captcha threshold over a longer wall-clock. |
| PIPELINE-RESUME | Re-run weekly pipeline after XHS cooldown | 0 new posts harvested today due to captcha. Once XHS cooled, `bash scripts/run-pipeline.sh && npm run push-data`. |
| LLM-API-KEY-CLEANUP | Remove `LLM_API_KEY` + `LLM_MODEL` env vars from Vercel + `.env.local` | Kept for now in case `scripts/reclassify-other-cuisines.ts` (one-off) needs them. Drop once we confirm no consumer remains in active code. |
| MISENRICH-BACKFILL | Backfill scan: re-enrich existing rows whose Places match was a non-food venue | Done: Oti + Bibliotheque (was "Office of Technology and Innovation" + "NYPL Schwarzman"). The fix in `placesEnricher.ts` uses `includedType` over a food-type fallback list with `strictTypeFiltering: true`, so future ingests can't repeat this. **Backfill TODO:** scan all 591 rows by re-querying Places by current `google_place_id` to fetch `primaryType`; flag any whose primaryType isn't in `FOOD_PRIMARY_TYPES` and re-enrich from the original recommendation text. Possibly small (we caught 2 manually). |
| MISENRICH-EXAMPLES | Public Display of Affection looked suspicious but is real (Park Slope vegan pizza) | Notable false alarm — kept as a reminder that some "weird" restaurant names ARE real. Always cross-reference against the recommendation text + address before deleting. |

### XHS parser improvement plan (audit 2026-11-26, nothing implemented yet)

Audit of `xhsScraper.ts` → `llmExtractor.ts` → `placesEnricher.ts` → `restaurantMerger.ts` → `scripts/test-pipeline.ts`. No schema changes needed for any item. Ordered by impact on "fresh + quality".

**State at audit time:** last real harvest = `pipeline_runs` 2026-04-19 (280 posts → 138 restaurants). The 2026-05-03 run hit captcha and got 0 posts. `data/pipeline.log` has no entries after 2026-05-03, so the Monday 6am crontab isn't firing (likely the Mac is asleep; cron doesn't catch up on missed runs). 137 of 358 XHS source rows are >1 year old (oldest 2020-06), 30 have an empty recommendation, and 73 of 594 restaurants have a null cuisine (several aren't restaurants: `1 Hotel Brooklyn Bridge`, `M&M Grocery Corp.`, Starbucks Reserve).

| # | Task | Notes |
|---|------|-------|
| PARSE-0 | Make the pipeline actually run (folds in **P4**) | launchd `StartCalendarInterval` runs on wake, unlike cron. Spread the captcha budget (~70 searches/session, ≥4h cooldown) over the week, e.g. ~15 searches per day, instead of one Monday burst. Log `xhs.search.cli.failed` captcha counts so a silent 0-post run is visible. |
| PARSE-1 | Search for fresh posts, not evergreen ones | ✅ via browser ingest. The server-side 半年内 filter plus most-liked sort, with no wasted reads on old posts. The legacy CLI path still uses `--sort popular`. |
| PARSE-2 | Fix fake-fresh fallback | `searchXhsPosts`: when `readNote` fails, the search-metadata fallback sets `body: ''` and `createdAt: now`, so an old post looks brand-new and the LLM extracts from the title alone. Drop these posts. Also, a note with no `time` currently skips the age filter; drop those too. |
| PARSE-3 | Refresh recency on existing restaurants | 🔄 Partial (2026-11-26). The upsert moves `post_created_at` forward to the newest post. **Not done:** evicting the oldest or weakest source at the 5-source cap. New posts are still skipped once a restaurant has 5. |
| PARSE-4 | Write every source and make re-runs idempotent | ✅ 2026-11-26 (`scripts/test-pipeline.ts`). Each source is written with its own likes and date; counts are bumped only by sources actually added. New rows also get `features` / rating / IG / lat-lng / `price_level`, which the old INSERT dropped. Existing rows have those filled when empty. |
| PARSE-5 | Per-restaurant sentiment instead of whole-post drop | `extractRestaurantData` drops the whole post on `hasComplaint`, so one gripe in a 10-place listicle loses 9 good places. Ask for `sentiment ∈ {positive, mixed, negative, passing_mention}` per restaurant and keep only `positive`. The "drop on any complaint" rule is unchanged, and yield goes up. `passing_mention` also removes "hotel we stayed at" noise. |
| PARSE-6 | Venue + geography guards | Reject Places `primaryType` of lodging, grocery, supermarket, etc. Restrict Places search with a `locationRestriction` rectangle around the 5 boroughs and drop results with a null borough. This catches #纽约美食 posts about NJ, Long Island, Boston, etc. |
| PARSE-7 | Name grounding + English alias | Extractor returns `nameEvidence` (an exact substring of the post; drop if it isn't really there) and `englishName` (used only in the Places query, not stored). Verify Places `displayName` similarity before adopting the match. This helps Chinese-only names that match poorly or not at all today. |
| PARSE-8 | Cleaner recommendation text | Strip `#…[话题]#`, emoji-only lines, and address/hotel boilerplate. Ask for dish-specific praise ("what to order"). If the cleaned quote is empty, fall back to the next-best source rather than storing null. |
| PARSE-9 | Sponsored / giveaway filter | Add `isSponsored` (合作, 广告, 探店邀请, 品牌合作, 抽奖, 粉丝福利) to the extractor output and drop those posts. |
| PARSE-10 | Better query set | Replace the 3 generic hashtags with a rotating list: 纽约新店 / 纽约新开 / 纽约探店 / 曼哈顿美食 / 法拉盛美食 / 布鲁克林美食 / 纽约brunch / 纽约约会餐厅 + cuisine terms. "新店/新开" queries are the main freshness lever. |
| PARSE-11 | Engagement + creator dedup in ranking | Use saves (`collected_count`) and comments as well as likes, and likes-per-day rather than raw likes. Count one creator posting the same place several times as one mention (`xhs_sources.author` exists). **Unverified:** whether `xhs read` returns `collected_count` / `tag_list` / a POI tag. Check one note's JSON before building on it. |
| PARSE-12 | Golden eval set — 🔄 harness written, baseline NOT run | `backend/scripts/eval-extractor.ts` + `backend/scripts/eval/extractor-cases.json` (18 hand-written regression posts: listicle-with-one-gripe, hotel, sponsored, giveaway, lukewarm, X-not-as-good-as-Y, grocery, Chinese-only name, passing mention, boilerplate rec, hedges, …). Run: `npx ts-node -T scripts/eval-extractor.ts`. The baseline run was interrupted on 2026-11-26 when work switched to scraper stability. Next steps: run the baseline, then apply PARSE-5/7/8/9 to the prompt and re-run. Add real posts as a second fixture file once scraping works again (see XHS-BROWSER below); target ~50 labelled real posts. After any prompt change, re-run `npm run scrub-negative`: the DB still holds a hedge ("它的缺点是…" on Hirohisa) that slipped through topup. |

### XHS scraping stability — rednote split (diagnosed 2026-11-26)

**Root cause of "logged in but parser can't get a token":** from a US IP, `www.xiaohongshu.com` now 302-redirects to `www.rednote.com`. A browser login therefore produces `.rednote.com` cookies. The `xhs` CLI (v0.6.4) reads only `.xiaohongshu.com` cookies and calls `edith.xiaohongshu.com`, which answers a rednote session with `Set-Cookie: web_session=; Max-Age=0`. Copying the rednote cookies into the CLI store was tried and fails the same way. Under XHS's 2025-12-08 user agreement, accounts registered with a non-+86 number after that date are "Rednote users", a separate product line. rednote uses `webapi.rednote.com` (API) and `as.rednote.com` (security) but the same URL paths, API paths (`/api/sns/web/v1/search/notes`, …), response schema and xsec_token mechanism. Anonymous rednote `search_result` SSR contains no notes, so search needs a login on either domain. Refs: xpzouying/xiaohongshu-mcp#579, jackwener/OpenCLI#1136.

| # | Task | Status / notes |
|---|------|----------------|
| XHS-BROWSER-0 | Stopgap: try `xhs login --qrcode` | 📋 30-second test. QR login authenticates against xiaohongshu.com directly. It may work if the account is +86 and registered before 2025-12-08. It is still fragile because it relies on reverse-engineered signing plus cookie TTL. |
| XHS-BROWSER-1 | Probe: does logged-in rednote.com search return the NYC posts we need? | ✅ 2026-11-26. Yes: Chinese NYC food posts, fresh dates, full bodies, likes, saves and comments. `scripts/xhs-browser-probe.ts`. |
| XHS-BROWSER-2 | Browser scraper module | ✅ 2026-11-26. `api/_lib/xhsBrowser.ts` (attaches to a long-lived Chrome over CDP on :9333, with a launch fallback) + `scripts/xhs-browser-ingest.ts` (count / read phases, `CITY` env). Uses the server-side 最多点赞 + 半年内 filters. Runbook: `backend/CLAUDE.md § XHS browser ingest`. The `xhs` CLI path in `xhsScraper.ts` is untouched; it is still used by `import-xhs` and the legacy `test-pipeline` path without `POSTS_FILE`. |
| XHS-BROWSER-3 | Session health check + loud failure | 🔄 Partial. `ensureLoggedIn()` waits for a non-guest `/user/me`, captcha pages pause for a human, and 5 failed reads in a row abort. **Still TODO:** macOS notification on failure, and making `run-pipeline.sh` use the browser ingest. |
| XHS-BROWSER-4 | Raw post cache on disk | ✅ 2026-11-26. `data/xhs-raw/notes/<id>.json` (note + its search card); reads skip cached ids. |

### NYC 6-month browser ingest — 2026-11-26

| # | Task | Status |
|---|------|--------|
| NYC-INGEST-1 | Ingest NYC posts from the last 6 months with ≥50 likes | 🔄 Partial. Count: **940** unique posts across 15 keywords (lower bound; 4 keywords hit the ~120-result cap). Read the top 300 (≥175 likes): **151 read**, then a captcha at about 150 reads went unsolved. Those 151 → DeepSeek → **190 restaurants → 167 merged → 106 new + 61 updated rows** in local SQLite (backup: `backend/data/wheretoeat.db.pre-browser-ingest-20261126`). **Remaining:** `CITY=nyc MODE=read MAX_POSTS=300` reads the rest (cached notes are skipped), then re-run the pipeline with the same `POSTS_FILE`. Extraction is cached, so only new posts hit DeepSeek. |
| NYC-INGEST-2 | Note: the NYC deck is all available rows, not just this run | ℹ️ Superseded by LAT-3 (2026-11-26). Briefly, after the `NULLS LAST` deploy, `weekly.ts` served only this run's 162 rows. It now serves every available NYC row (684), and the latest run decides only ready vs stale. |
| NYC-INGEST-3 | Sync to Neon + deploy | ✅ 2026-11-26 (see BA-P1-4). **Incident:** prod `/api/restaurants/weekly` returned 500 for ~3 min (about 20:54–20:57 local). The first deploy snapshot picked up another session's half-finished `weekly.ts` rewrite (`ReferenceError: latestCompleted`). Fixed by redeploying HEAD's `weekly.ts` plus only this session's hunks. That session's rewrite is still undeployed in the working tree. |

### GPS-driven picks + multi-city expansion — 2026-11-27

| # | Task | Status |
|---|------|--------|
| GPS-CITY-1 | "This week's picks" always uses the user's GPS city, or the one chosen on the Pick page | ✅ `WeeklyRestaurantService`: explicit pick (persisted) → else GPS city (supported city whose box contains the fix) → else New York. The picker card gains a "Current location" row that returns to GPS mode (shows "Near <city>"), and the chip shows a location icon while following GPS. `LocationService` requests a fresh fix on every foreground (significant-change updates alone lag). Verified in the simulator: GPS SF + Current location → Bay picks; GPS back to Manhattan + background/foreground → NYC picks. In TestFlight build 37. |
| MULTI-CITY-1 | Top 10 US cities by population → scrape restaurants, spread over several days for quota | 🔄 **Scope narrowed by the owner (2026-11-27): Los Angeles only for now.** The other cities (Chicago, Houston, Phoenix, Philadelphia, San Antonio, San Diego, Dallas–Fort Worth) are on hold until the owner gives instructions. The plan and the LA step queue (L1 config + count → L2 read ≤150 → L3 pipeline → L4 iOS + ask for prod approval) are in **`agent_docs/multi-city-expansion.md`**. The scheduled task `multi-city-ingest` ("WhereToEat: LA ingest", 09:00 + 15:00 local, Auto mode) runs one step per run; prod sync / deploy stays gated on the owner. **L1 ✅ (2026-11-27):** backend `la` config (regions incl. Orange County + "Other", bounds, keywords, `MAX_NEW_READS` read cap) + count = 542 unique candidates (≥100❤ 335). Local only, not deployed. **L2 ✅ (2026-11-27, run early at the owner's request):** top 150 LA notes read → `posts-la.json` (0 failed; 1 captcha, cleared). **L3 ✅ (2026-11-27, run early):** 166 LA rows in local SQLite, 163 served by local `weekly?city=la` (LA 53 · SGV 42 · OC 33 · Westside 29 · Other 5 · South Bay 1); 0 bookable until a booking-link backfill runs. Next run: L4 iOS enablement + TestFlight, then owner approval for Neon sync / mirror-photos / deploy. |
| LIKES-COMMA-1 | Repair NYC + Bay likes hit by the comma-parsing bug | ✅ **Done 2026-11-27 (owner approved local + prod).** rednote's English UI shows note likes as "6,809"; `xhsBrowser.parseCount` stopped at the comma (→ 6). Fixed in `parseCount` + cached-note re-derive. `scripts/repair-source-likes.ts` (`CITY=… [NEON=1] [DRY_RUN=1]`) takes the true count from each note's cached raw state (no RedNote reads), fixes `posts-<city>.json`, local `xhs_sources.likes` + `total_likes` deltas, and Neon matched by (restaurant_id, post_url). Result: NYC 26 posts → 15 source rows / 14 restaurants; Bay 4 posts → 4 rows / 4 restaurants; LA 12 posts → 17 rows (local only, not in prod yet). Local and Neon fixed identically; re-check finds 0 left. Prod weekly verified (nyc 684, bay 133, ready; e.g. Bao's Pastry top source 4 → 4064). |

### Find framing + city picker polish — 2026-11-26

| # | Task | Status |
|---|------|--------|
| FIND-FIT-1 | "Get geo info so Bay restaurants show on Find" | ✅ No geo was missing: all 133 served Bay rows already have lat/lng in prod. The problem was framing. Find lists only pins inside the camera, and the fixed Bay region cut off 6 (four in San Jose, Pleasanton, San Rafael). `FindView.fittedRegion` now fits the selected city's restaurants (coordinates outside a per-city plausibility box are ignored, so a mis-geocoded row can't zoom out to the world) and stretches the latitude span so pins sit above the 45% bottom panel. It runs on first appear (when the user isn't inside the city) and after each city switch once the list loads. Verified in the simulator: Bay Area → "133 restaurants", San Rafael → San Jose framed. |
| PICKER-2 | "Make the city picker prettier", then "too big, pick a better city photo" | ✅ The system `Menu` was replaced by a compact popover card (`CityPickerCard`, 220pt): 🗽 New York · 5 boroughs / 🌉 Bay Area · SF & the Bay on soft tinted tiles, with a tinted row + check on the current city. The trigger is a chip (pin + name + chevron), 50% opacity at rest. Landmark emoji instead of photos: no asset downloads or licensing. Real skyline photos (e.g. Unsplash) are possible if wanted, but need the owner's OK to download. In TestFlight build 36. |

### Website booking fallback + OpenTable source research — 2026-11-26

| # | Task | Status |
|---|------|--------|
| WEB-BOOK-1 | "Book on website" when a restaurant has no Resy / OpenTable / Tock link (owner chose option 3) | ✅ `RestaurantDetailView`: `websiteBookingUrl` (the restaurant's own site; Google / Apple Maps links excluded) → a globe "Book on website" CTA in both the deck (Pass + Book) and standalone layouts. It runs the same flow: Safari → Confirm form ("I didn't end up booking" as an out) → reservation saved with platform `.other`. Covers **100 of 133 Bay** restaurants (23 have a platform, 10 have neither). The "only show bookable" filter is unchanged: website-only restaurants don't count as bookable there. Verified in the simulator: Tony's Pizza Napoletana → Book on website → tonyspizzanapoletana.com → Done → Confirm form. In TestFlight build 35. |
| BAY-BOOK-3 | Sanctioned OpenTable link source | 📋 Research 2026-11-26. **No maintained GitHub library.** What exists: reverse-engineered mobile-API code (e.g. a 2021 "Building an OpenTable bot" write-up, euforic/opentable in Go), a PyPI client that calls a third-party hosted endpoint, and many paid Apify scraper actors. All of them violate OpenTable's terms and/or depend on getting past bot protection, so none were adopted. **Sanctioned route:** the OpenTable **Affiliate** program (dev.opentable.com partner portal) gives restaurant data + per-restaurant booking deeplinks (must show "Powered by OpenTable"; approval reportedly ~3–4 weeks). The full Partner API (availability / reservations) needs a signed contract. Next step if wanted: the owner applies for affiliate access; then replace `backfill-opentable.ts` (BAY-BOOK-2, broken) with the affiliate data feed. **Application draft:** `agent_docs/opentable-affiliate-application.md` (form answers with [FILL IN] placeholders, an honest fit assessment, and an integration plan). The portal blocks headless browsers, so its terms aren't verified yet; the owner should open it in a normal browser. |

### City picker + Bay Area in the app — 2026-11-26

| # | Task | Status |
|---|------|--------|
| CITY-1 | Bay Area picks didn't show in the app | ✅ Root cause, reproduced in the simulator with SF GPS: the app started on `nyc` and sent a background NYC refresh; the GPS fix switched to `bay`; then the **late NYC response overwrote the Bay deck and cache**. `WeeklyRestaurantService` now drops responses for a city that's no longer active (fetch, refresh, polling), cancels polling on switch, and sends the cached etag only for the same city. |
| CITY-2 | City picker at the top left of the Pick page (owner request) | ✅ `DiscoveryContainerView.cityPicker`: a `Menu` of New York / Bay Area, 50% opacity, default New York, persisted (`selected_city`). It's now the **single source** of the deck city; GPS no longer switches cities (the `LocationService.cityKey` helpers were removed). Home, Pick and Find all follow; chips reset on switch; Find recenters on the city. Verified in the simulator: NYC → Bay Area (deck, Home picks, 133 picks, region chips, Find map with 128 pins) → relaunch (persisted) → NYC. In TestFlight build 33. |
| CITY-3 | Bay Area region chips showed only "Other" | ✅ The iOS `knownBoroughs` whitelist (Discovery + Home) was NYC-only; added San Francisco / East Bay / Peninsula / South Bay / North Bay. |
| CITY-4 | BAY-BOOK-1 iOS fallback | ✅ "Only show bookable" is skipped when the current city has zero bookable restaurants (`WeeklyRestaurantService.activeCityHasBookable`), so Bay Area isn't empty before its booking backfill. The other session is doing the data backfill (`backfill-booking-links.ts`). Once some Bay rows have links, the normal filter applies again automatically. |

### Sources per restaurant: 10, ranked by popularity × freshness — 2026-11-26

| # | Task | Status |
|---|------|--------|
| SRC-10-1 | Raise the per-restaurant XHS post limit 5 → 10, ranked by popularity × freshness | ✅ 2026-11-26. Deployed `whereto-gl9fgco6p` (`weekly.ts` + `restaurantMerger.ts` only, diffed against the previous prod snapshot). Prod verified: nyc 200 / 162, bay 200 / 133, sources in score order, 304 OK. `restaurantMerger.sourceScore = likes × recencyWeight(postCreatedAt)` (1.0 for ≤7 days → 0.2 at 60+ days) + `MAX_XHS_SOURCES_PER_RESTAURANT = 10`. The pipeline admits a post when the restaurant has <10, or when the post would rank in its top 10; nothing is deleted. `weekly.ts` serves the top 10 XHS posts by score, then editorial sources. The merger's card-face `recommendation` comes from the best-scoring post (new rows only). iOS `RestaurantDetailView.sortedSources` keeps the server's order (it used to sort by quote length); shipped in TestFlight build 31. Verified locally: score-ordered for both cities. |
| SRC-10-2 | Backfill posts dropped by the old cap of 5 | ✅ Only one in this run (Yamada, 1-like post). Synced to Neon 2026-11-26 (Yamada has 6 sources on prod). `sync-runs-to-neon.ts` no longer touches `photo_url` / `photo_urls` on existing rows: prod owns photos after `mirror-photos`, which NULLs dead ones on purpose. Verified prod photo hash unchanged (0 Places URLs, 12 intentional NULLs kept). |
| SRC-10-3 | Top-up script fill targets | ℹ️ `topup-xhs-sources.ts` (3) and `topup-asian-xhs.ts` (5) are fill targets, not caps. Left as is; set `TARGET_PER_RESTAURANT=10` on the next run if more depth is wanted. Older top-up data already has restaurants with up to 38 XHS posts; the API now trims those to the top 10. |

### LLM provider benchmark — 2026-11-26

| # | Task | Status |
|---|------|--------|
| LLM-FW-1 | Try DeepSeek Flash on Fireworks for speed | ✅ Done; **not adopted**. `LLM_PROVIDER=fireworks` switch in `_lib/deepseek.ts`; `scripts/bench-llm.ts`. Flash runs at 0.9 s/call (ultrafast 0.4 s) vs about 2 s for V4-Pro, but finds only 54–64% of Pro's restaurants (missed Okawa Sushi, Chef Chu's, Jean-Georges, Nubeluz). Revisit if Fireworks lists a V4-Pro model, or for the low-stakes classifier calls. |
| LLM-FW-2 | Store the Fireworks key properly | 📋 Today the benchmark reads it from a Downloads file via `FIREWORKS_API_KEY_FILE`. If Fireworks is ever used for real, add `FIREWORKS_API_KEY` to `~/.config/wte-feedback-agent/secrets.env`. |

### Bay Area expansion (city `bay`) — started 2026-11-26

Full plan, decisions and status: **`agent_docs/bay-area-expansion.md`**. Summary:

| # | Task | Status |
|---|------|--------|
| BA-P0-1..5 | City-aware regions, Places, extractor prompt, ingest keywords, pipeline `CITY` | ✅ 2026-11-26 (NYC behaviour unchanged) |
| BA-P0-6 | Count → read → pipeline for `bay` into local SQLite | ✅ 139 rows (133 served) across SF 67 / South Bay 37 / Peninsula 17 / East Bay 12 / North Bay 1 |
| BA-P1-1 | `weekly.ts` city filter for deck + etag | ✅ 2026-11-26 |
| BA-P1-2 | `/api/locations?city=bay` | ✅ (automatic from `cityRegions.ts`) |
| BA-P1-3 | iOS city key from override / GPS (`LocationService.cityKey`, `WeeklyRestaurantService.activeCity`) | ✅ shipped in TestFlight build 29 |
| BA-P1-4 | Sync `bay` + new NYC rows to Neon, and deploy the `weekly.ts` change | ✅ 2026-11-26. `scripts/sync-runs-to-neon.ts`: Neon now has nyc 700 / bay 139 rows and +338 sources. Deployed `whereto-esffy7jmh` (city filter + `NULLS LAST`). Prod verified: nyc 200 / ready / 162, bay 200 / ready / 133. |

### Smaller polish backlog (post-MVP "wants")

| # | Task | Notes |
|---|------|-------|
| N5 | Settings → Clear Cache button | `WeeklyCache.invalidate()` exists; just needs a Settings row. Per `DESIGN-CACHING.md` § Open follow-ups. |
| N6 | Photo prefetch on weekly fetch | ✅ 2026-11-26. Shipped as part of **LAT-1** (see Recently shipped). |
| N7 | Map-pin clustering on Find tab | Currently shows N individual pins; cluster when zoomed out. |
| N8 | Tap a price chip → filter the deck to that tier | Cheap UX win once Favorites and the active queue are out of the way. |
| U3–U8 | Smaller iOS polish items (card counter, copy pass, button hierarchy, etc.) | See § iOS — UI Polish further below. |

### Recently shipped (week of 2026-04-28 / 2026-04-29)

| # | Task | Done | Notes |
|---|------|------|-------|
| PICK-FILTER-SPACING | Breathing room between Pick filter chips and the card | 2026-05-04 | `DiscoveryContainerView` filter VStack changed from `.padding(.vertical, 3)` to `.padding(.top, 3) + .padding(.bottom, 14)` so cuisine/borough chips don't sit flush against the photo. TestFlight build 25 uploaded. |
| LOGIN-REDESIGN | Login page redesigned off the plain-white default | 2026-05-05 | `LoginView` rebuilt: warm gradient page bg (matches Home/Settings/etc.), gradient orb hero with sunset orange→purple fill + soft halo + `fork.knife` glyph, two floating accent pills ("🗽 NYC" purple, "✨ weekly" blue), Fraunces "WhereToEat" wordmark, evocative tagline ("Your weekly NYC dining radar — curated, bookable, yours."), three-row value-prop list (Curated weekly / One-tap booking / Synced across devices) with tinted icon tiles, Apple button gets a 14pt corner + drop shadow, "Continue as guest" upgraded from flat gray text → ghost capsule. TestFlight build 26 uploaded. **Build 27 follow-up (2026-05-05):** restructured the hero from a fragile `.overlay(alignment:).offset(y: 110)` hack into a clean `VStack { orb; titleBlock }`, swapped the title from `.largeTitle.bold` to Fraunces 38pt semibold for typographic consistency with Home/Find/Detail. |
| LLM-MIGRATE | Switch parser from Gemini 2.5 Flash → DeepSeek-V4-Pro | 2026-05-02 | New `backend/api/_lib/deepseek.ts` (OpenAI SDK pointed at `api.deepseek.com`, mandatory `thinking: { type: 'disabled' }`). `llmExtractor.ts::{extractRestaurantData, classifyMention, classifyMentionsBatch}` all migrated; behavior preserved (closed-vocab post-validation already drops invalid keys). Secret reuses `DEEP_SEEK_API` from `~/.config/wte-feedback-agent/secrets.env` (or env). Override model with `DEEPSEEK_MODEL`. `LLM_API_KEY` / `LLM_MODEL` no longer needed for the active path; one-off `scripts/reclassify-other-cuisines.ts` still on Gemini (not in pipeline). |
| LLM-NEG-FILTER | Drop XHS posts with any complaint about the target restaurant | 2026-05-02 | Hard rule documented in `CLAUDE.md` + `backend/CLAUDE.md § LLM parser` + `SPEC.md § Author quote contract`. `extractRestaurantData` adds `hasComplaint: boolean` — true → entire post returns []. Standalone `classifyComplaint({title, body, restaurantName})` is target-aware so a praise-A-trash-B post drops only the (B, post) row. Fail-closed (LLM error → drop). New `npm run scrub-negative` (one-shot backfill on SQLite + Neon) and the topup script also gates each candidate. Triggered by Shiki Omakase (`人均两百的omakase…再也不会去`) showing in deck. |
| ASIAN-TOPUP | Asian restaurants (chinese/japanese/korean) — partial top-up toward ≥5 XHS posts | 2026-05-03 | `npm run topup-asian` shipped. Searches `xhs search "<name>" --sort latest` (newest first), then `--sort popular` for remainder. Each candidate gets a fast CLI-only read (6s timeout, no HTTP fallback) → name/NYC/age filter → DeepSeek `classifyComplaint` → upsert. Idempotent on `(restaurant_id, post_url)`; bails after 8 consecutive read fails per restaurant. **Caveat:** XHS captcha throttled the search after ~70 restaurants (combined session burned through the rate budget). Net adds: japanese 89→97, korean 21→30; 4 restaurants now ≥5 sources. Re-run after a few hours of cooldown to finish the rest — the script picks up where it left off. Env knobs: `TARGET_PER_RESTAURANT=5`, `CUISINES`, `MAX_SEARCH_PAGES`, `READNOTE_TIMEOUT_MS`, `DRY_RUN`. |
| WEEKLY-PIPELINE-RERUN | Weekly XHS pipeline re-run with DeepSeek + complaint filter | 2026-05-03 | Ran `bash scripts/run-pipeline.sh` after the parser swap. Pipeline executed cleanly (DeepSeek path verified end-to-end) but **0 new posts harvested** — XHS captcha returned 0 results on all 3 hashtag searches (`#纽约美食`, `#NewYorkRestaurant`, `#NYCEats`) due to topup-asian burning the rate budget. Re-run after cooldown. Side fix: stale `import { db, sql } from '_lib/db'` in `test-pipeline.ts` (db no longer exported) replaced with direct `Database(...)`; `r.cuisineType` → `r.cuisineKey`. |
| NEON-PUSH | Push SQLite → Neon | 2026-05-03 | `npm run push-data`: pipeline_runs +2, xhs_restaurants 591/591, xhs_sources 891 (was 870 — net +21 from topup adds, partially offset by 15 scrub deletes). Scrub deletes were synced live during the run (Neon DELETE per row). |
| VERCEL-DEPLOY | Deploy backend with DeepSeek extractor | 2026-05-03 | `vercel --prod --yes` → ready. New env vars `DEEP_SEEK_API` + `DEEPSEEK_MODEL=deepseek-v4-pro` already in production. `/api/restaurants/weekly?city=nyc` smoke-tested 200 in 1.07s. `/api/restaurants/import-xhs` now routes through the DeepSeek-V4-Pro extractor with the complaint filter applied per-post. |
| P0 | `/api/restaurants/import-xhs` working on prod (Hobby tier) | 2026-04-28 | XHS cookies pushed to Vercel; smoke-tested 200 in ~17s. **Caveat:** `xsec_token` is single-use — `/404` after one read. Real share-sheet flow always carries fresh tokens; smoke-test scripts must pull fresh per attempt via `xhs search --json`. |
| P6 | Sign in with Google — iOS wiring | 2026-11-27 | `GoogleSignIn` SPM product linked to the app target (package was referenced but not linked). New `WhereToEat/WhereToEat/Info.plist` (merged via `INFOPLIST_FILE`) carries `GIDClientID` + reversed-client-id URL scheme; the existing GCP iOS client `617615737877-…` was verified live (Google shows "Sign in to continue to WhereToEat App"). `GoogleSignInIntegration` now calls `GIDSignIn.signIn(withPresenting:)`; `.onOpenURL` forwards the redirect; cancel is silent; sign out also clears the GIDSignIn session. `googleButton` re-enabled on `LoginView`; Settings guest row reads "Sign in with Apple or Google". Backend needed no code change: `/api/auth/login` was already deployed and does the anon → Google migration. **Not verified end-to-end**: no real Google credentials in the simulator, and prod lacks `GOOGLE_IOS_CLIENT_IDS` (see P6b). **TestFlight skipped on purpose:** build 39/40 came from the unmerged `claude/home-trending-lucky` branch, so a build from this branch would have collided on 40 and dropped that Home work for testers. The next combined release from main (after both branches merge; they merge cleanly) carries Google Sign-In. `CURRENT_PROJECT_VERSION` was left untouched. |
| P5 | Sign in with Apple — Developer Portal capability + entitlement (Debug + Release) | 2026-04-28 | Both `WhereToEatDebug.entitlements` and `WhereToEat.entitlements` carry `<string>Default</string>`. Live JWKS verifier reaches `com.weijia.wheretoeat` audience. |
| P5b | Home greeting shows the user's name after Apple sign-in | 2026-04-29 | Resolved via 3-tier `displayName` fallback (D-AUTH-NAME) + Settings "Your name" override + `HomeViewModel` subscription to `$state` and `.userProfileUpdated`. Debug `[Auth]`/`[Greeting]` logs stripped. |
| P9 | On-device weekly cache + image cache | 2026-04-28 | `xhs_restaurants.updated_at` + ETag conditional → 304 path; `WeeklyCache.swift` 0–6h fresh / 6–24h warm / >24h stale tiers; `URLCache.shared` 150MB disk for photos. Cold start no longer fans out to ~600 Neon queries. |
| P9.1 | Cache: stability + edge + N+1 fix | 2026-04-29 | Content-hash etag (no longer cascade-invalidates on `updated_at`-only writes); `Cache-Control: public, s-maxage=300, stale-while-revalidate=86400` (Vercel edge HIT verified); `hydrateSources` collapsed from N+1 to single `IN (...)` (~4× faster). |
| D14 | Multi-source review stack on detail view + Discovery sources selector | 2026-04-28 | All sources rendered as `SourceQuoteCard`s; cross-source accent capsule; Settings → Recommendation Sources toggle for `xiaohongshu` / `eater` / `resy_blog`. |
| D15 | Find + Pick tabs (4-tab nav: Home / Pick / Find / My List) | 2026-04-28 | New Find tab (full-bleed Map + bottom panel); Pick lifted out of NavigationStack push to a tab root. Coordinates plumbed end-to-end (`xhs_restaurants.{latitude,longitude}` + Places `places.location` + `npm run backfill-coords`). |
| D16 | Restore `/api/auth/login` to deployed bundle | 2026-04-28 | Was archived for cap; favorites swapped out (UI doesn't call them). `APPLE_BUNDLE_IDS=com.weijia.wheretoeat` set in prod env. |
| D17 | Home picks redesign — daily-rotated TOP PICK + reservation-aware count | 2026-04-28 | 0 reservations → 3 slots (TOP PICK / NEW / HIDDEN GEM); ≥1 reservation → 1 slot. TOP PICK is a daily-deterministic draw from the top 25%. |
| D18 | Interactive inline map on RestaurantDetailView | 2026-04-28 | Map owns its full gesture stack; Apple Maps handoff lives on a separate floating button. |
| D19 | XHS mention copy: cap displayed count at "3+" | 2026-04-28 | "Mentioned 3+ times on 小红书" reads cleanly vs the precise "Mentioned 5 times". |
| D20 | Backfill XHS mentions for Hirohisa | 2026-04-28 | `xhs search Hirohisa --sort popular` × 2 pages → 40 notes upserted via `(restaurant_id, post_url)` unique index. Pattern worth keeping for single-restaurant top-ups. |
| D21 | Settings → Send Feedback (Resend → prompt.and.ship@gmail.com) | 2026-04-29 | New `FeedbackView` + `POST /api/feedback`. Initial Resend wiring failed because the sandbox sender requires the recipient = account owner; user rotated `RESEND_API_KEY` to the `prompt.and.ship@gmail.com`-owned key, smoke-tested 200. `FEEDBACK_TO` / `FEEDBACK_FROM` now env-driven. |
| D22 | Archive `restaurants/pipeline/run.ts` from deployed bundle | 2026-04-28 | Pipeline runs locally only; deployed function count 11/12. Cron + maxDuration stripped from `vercel.json`. Re-activation path documented. |
| D23 | Price tier ($/$$/$$$/$$$$) from Google Places `priceLevel` | 2026-04-28 | New `xhs_restaurants.price_level` column; enricher requests `places.priceLevel`; `priceTier` maps enum→1/2/3/4 → existing `priceRange` UI. Inline with rating row (`★ 4.7 (1.2k) · $$$`). New `npm run backfill-price`. **Side fix:** SQLite `updated_at` schema-drift bug (non-constant default rejected; trigger created anyway → broken UPDATEs) patched. |
| D23c | Price chip etag projection + priceRange fallback | 2026-04-29 | Etag projection missed `price_level` → 304-with-stale; added. ~46% of NYC rows expose price only via `priceRange.startPrice` (HYUN's "$100+"); added fallback synthesising a tier from numeric range. Coverage 317 → 552 / 592 (54% → 93%). |
| D-AUTH-NAME | 3-tier displayName fallback + manual override in Settings | 2026-04-28 | Backend echo → fresh Apple credential → cached UserDefaults; never overwrites a non-nil cache with nil. Settings "Your name" TextField as the manual escape hatch. |
| AGENT-DOCS | `agent_docs/` reference scaffold | 2026-04-28 | Architecture, API contract, glossary at root; project-layout / networking / state-management / build-and-run on iOS side; project-layout / parsing-pipeline / data-model / build-and-run on backend side. Each ≤200 lines, file:line pointers. |
| TYPO-1 | Fraunces variable serif registered + applied to nav titles, greeting, section headers | 2026-04-29 | New `Services/AppFonts.swift` runtime-registers `Fraunces-VF.ttf` + italic via `CTFontManagerRegisterFontsForURL` (Info.plist UIAppFonts not usable in build-setting-driven projects). `Font.fraunces(_:weight:)` helper. Global `UINavigationBar.appearance()` config (inline 17pt + large 34pt) — `ToolbarItem(placement: .principal)` per-screen path crashed iOS 17.4 with `EXC_BAD_ACCESS` in `_UIAccessibilityBroadcastNotificationFunction`. Fraunces also applied to "This week's picks" / "580 restaurants" headers + greeting + reservation subhead. |
| TYPO-2 | Restaurant-name typography unified across Pick / Find / My List / Detail | 2026-04-29 | All restaurant-name `Text`s now use `.font(.body).fontWeight(.medium)` (no `.fontWidth(.condensed)`). Applies to: Home pick cards, FindRestaurantRowView, CustomRestaurantRowView (My List), RestaurantCardView (Discovery deck), RestaurantDetailView header. Find header label uses `.fraunces(.title3, weight: .semibold)`. |
| TYPO-3 | Dollar-sign price tier light + condensed (no truncation) | 2026-04-29 | `Text(String(repeating: "$", count: price))` styled with `.fontWeight(.light) + .fontWidth(.condensed) + .tracking(-0.5)` in both RestaurantCardView and RestaurantDetailView. Earlier `tracking(-1.5)` over-clamped glyphs. |
| TYPO-4 | Settings nav title large + Settings list rows warm cream | 2026-04-29 | `.navigationBarTitleDisplayMode(.large)` so Settings inherits the global 34pt Fraunces large title. Every Section gets `.listRowBackground(Color.homeBgBottom)` so rows blend with `WarmGradientBackground` instead of the iOS 17.4 stark white grouped-list rows. |
| TYPO-5 | Pick + My List card backgrounds switched from `systemBackground` to `homeBgBottom` | 2026-04-29 | Cards on Home pick rows + My List rows now render in `Color.homeBgBottom` (warm off-white #FFFAEC) so they blend with the cream gradient instead of contrasting as stark white. Find tab bottom panel kept on `Color.homeBgMid` to match the `WarmGradientBackground` used on Home / My List / Settings (the two creams are intentionally adjacent: cards = `homeBgBottom`, page bg = `homeBgMid`). |
| TYPO-6 | My Bookings warm theme | 2026-04-29 | `WarmGradientBackground` lifted to the parent ZStack so the empty state ("No bookings yet") inherits the cream wash; list rows switched to `Color.homeBgBottom`. Page now reads consistently with Settings / My List / Home. |

### Obsoleted

| # | Task | Why |
|---|------|-----|
| P1 | DEBUG base URL fallback chain | ✅ Done in D-base-url; now standard pattern in `APIClient`. |
| P8 | Onboarding party-size + dietary round-trip | ✅ Obsoleted by D11 (welcome screen replaced multi-page onboarding). Resurrect if onboarding is re-enabled. |
| D9 | Function count >12 cap | Resolved iteratively across D16/D21/D22; current bundle is 11/12. |

### Recently shipped (this session, 2026-04-21)

| # | Task | Status | Notes |
|---|------|--------|-------|
| D1 | Discovery filters out reserved + blocked + seen-today cards | ✅ Done | New table `user_blocked_restaurants(user_id, restaurant_id, blocked_until, created_at)`; endpoints `GET|POST /api/user/blocks`, `DELETE /api/user/blocks/{restaurantId}`; iOS `ReservationService.fetch{Reserved,Blocked}RestaurantIds()`; `DiscoveryViewModel.loadCards` parallels the weekly fetch with the two id sets; `buildDeck` filters `id ∈ reserved ∪ blocked ∪ seenToday`. |
| D2 | Seen-today tracking on-device | ✅ Done | `Services/SeenService.swift` — UserDefaults keyed `seen_yyyy-MM-dd`, `Set<UUID>`; lazy GC drops older keys on read. `DiscoveryViewModel.advance()` is the single funnel that stamps the leaving card. |
| D3 | Block button pushes server-side with 28-day TTL | ✅ Done | `DiscoveryViewModel.block()` calls `ReservationService.pushBlock(restaurantId:blockedUntil:)`; blockedUntil defaults to +28 days matching the "Block for 4 weeks" UI copy. |
| D4 | XHS comment → tap opens Xiaohongshu / Rednote app (Safari fallback) | ✅ Done | `Services/XhsURLOpener.swift` extracts 24-hex noteId from `xiaohongshu.com/explore/…`, tries `xhsdiscover://item/{noteId}`, falls back to HTTPS via `UIApplication.open(_:completionHandler:)` when no app handles the scheme. No `LSApplicationQueriesSchemes` change needed. Wired on both `RestaurantCardView` swipe card and `RestaurantDetailView`. Duplicate "Xiaohongshu" row hidden from the Sources section on the detail page. |
| D5 | Swipe-to-cancel on My Bookings + swipe tint fix | ✅ Done | `BookingsListView` trailing swipe with confirmation alert → `ReservationService.cancelReservation(id:)` (drops from every WeeklySession bucket, cancels UNUserNotification reminder, removes EventKit event, DELETEs backend). All destructive swipes now `.tint(.red)` so the TabView's accent color doesn't bleed through. |
| D6 | Home UI polish | ✅ Done | "N picks" pill → Discovery; "N saved" pill → My List via `.switchToMyList`. Removed the "This week" preview carousel. Latest booking card(s) stacked soonest-first on Home; compact gradient "Find another restaurant" CTA replaces the big photo-grid when at least one booking exists. |
| D7 | App icon swap (sushi + chopsticks NYC design) | ✅ Done | `Assets.xcassets/AppIcon.appiconset` converted from macOS-only to iOS universal 1024x1024 PNG with alpha stripped (JPEG round-trip). |
| D8 | Backend XHS import — HTTP fallback for Vercel | ✅ Done | `backend/api/_lib/xhsScraper.ts::readNoteViaHttp` fetches the SSR `window.__INITIAL_STATE__`, walks `state.note.noteDetailMap[noteId].note`. Env-branched: HTTP-first on Vercel, CLI-first locally, each falls back to the other. `buildXhsCookieHeader()` attaches `web_session`/`a1`/`webId` from env vars when set — needed when a user hits a post without `xsec_token`. See memory `project_xhs_vercel_auth.md`. |
| D10 | Fix "Book swaps detail layout" stacked-sheet bug | ✅ Done | Tapping Book in the swipe-deck detail (Pass + green-Book variant) used to run `{ onLike(); openBrowser() }`. `onLike` dismissed the current sheet and set `DiscoveryViewModel.likedRestaurant`, which re-presented the detail view in the standalone single-Book layout via `DiscoveryContainerView.sheet(item:)`. Safari then opened on top of the *second* sheet, and the user returned to a different-looking screen. Fix in `RestaurantDetailView.primaryActions`: the swipe-deck Book button now only calls `openBrowser()`. The view owns the full Safari → ConfirmBookingForm → Success state machine itself, so there's no reason to hand control back to the deck mid-flow. Completed reservations still filter correctly from future decks because `user_reservations` is the server-side signal. |
| D11 | Skip onboarding on entry — new users land on Home | ✅ Done | `RootView` no longer gates on `@AppStorage("onboarding_complete")`. Login is still shown for unauthenticated users who haven't tapped "Continue as guest"; past that, straight to Home. Party size / dietary defaults come from `UserProfile.load()` (party size 2, no dietary restrictions); the Stepper in `ConfirmBookingForm` pre-fills with the profile's current value. `OnboardingContainerView` source is kept in the project for easy re-enable — restore the `onboardingComplete` branch in `RootView.body` to turn it back on. SPEC.md § Onboarding updated to reflect the deferred status + where defaults now surface. |
| D12 | My List background matches Home — shared `WarmGradientBackground` | ✅ Done | Promoted `Color.homeBg{Top,Mid,Bottom}` from `private` to internal and wrapped them in a reusable `WarmGradientBackground` view (in `HomeView.swift`). Applied via `.background(WarmGradientBackground().ignoresSafeArea())` + `.scrollContentBackground(.hidden)` on both the Home `ScrollView` and the `CustomListView` `List`. Each List row keeps `.listRowBackground(Color(.systemBackground))` so rows still read as raised cards over the warm wash. |
| D13 | Fancy first-launch welcome screen | ✅ Done | New `Views/Onboarding/WelcomeView.swift` — warm-gradient background, breathing `fork.knife.circle.fill` logo, serif wordmark "WhereToEat", 3 cuisine polaroids (🍣 Japanese / 🍝 Italian / 🌮 Mexican) fanned -10°/0°/+10° with a spring-staggered entrance, purple→orange gradient "Let's eat →" CTA. Gated by `@AppStorage("has_seen_welcome")` — shown once, dismissed permanently by the CTA. `RootView` order is now Welcome → Login → Home. The old multi-page onboarding (party/dietary) stays deferred. SPEC.md § Welcome screen documents the full composition + animation timeline. |
| D14 | Multi-source review stack on detail view + Discovery sources selector | ✅ Done | **Backend:** `weekly.ts::hydrateSources` SELECT now also returns `source_type`, `author`, `source_title` from `xhs_sources` (already polymorphic per memory `project_source_overlap_counts.md`). **iOS model:** `XHSSource` gains `sourceType`/`author`/`sourceTitle` (all optional for legacy decode); `resolvedType` defaults to `"xiaohongshu"` for older cached rows; `displayPlatform` maps to `小红书` / `Eater` / `Resy`. **iOS UI:** `RestaurantDetailView.xhsSourcesBlock` renders all sources as `SourceQuoteCard`s — platform-coloured badge + verbatim quote + `author · sourceTitle` byline + likes (XHS only). Collapsed to **3 rows by default** with a `See all N reviews` button; tapping a row opens XHS via `XhsURLOpener` for `xiaohongshu` rows and Safari directly for `eater` / `resy_blog`. Header above the stack mirrors the new accent rule (`"3 mentions on 小红书"` / `"Featured in Eater + Resy"` / combinations). **Discovery card accent:** `RestaurantCardView` now shows a small dark capsule next to the source badge — XHS count ≥ 3 → `"N mentions on 小红书"`; else any non-XHS source → `"Featured in <names>"`; else nothing. **Settings selector:** new `Section("Recommendation Sources")` with a `Toggle` per `DiscoverySource` enum case (xiaohongshu / eater / resy_blog); persisted on `UserProfile.discoverySources: Set<String>` (defaults all-3-on; legacy cached profiles also default to all-on). Filter is wired into both `HomeViewModel.homePicks`/`applyFilter`/`rebuildFilterOptions` and `DiscoveryViewModel.applyFilter` — restaurants must have ≥1 source row whose `source_type` is in the user's enabled set; restaurants with empty `sources` arrays fall back to `"xiaohongshu"`. Custom-list restaurants bypass this filter. SPEC § This week's picks, § Card UI, § Cross-source accent label, § Deck filter sources, and § Restaurant detail all updated. |
| D15 | Find + Pick tabs (4-tab nav: Home / Pick / Find / My List) | ✅ Done (2026-04-28, branch `feat/find-tab-and-pick`) | **Pick:** lifted `DiscoveryContainerView` out of Home's NavigationStack push into its own tab root (`@StateObject pickVM: DiscoveryViewModel` in HomeView). Home's "Find another restaurant" CTA + 🍽 picks pill now post `.switchToPick`. **Find:** new tab with full-bleed Apple `Map` (NYC region, custom red `FindMapMarker` pins) + floating cuisine chip row (`ultraThinMaterial` background) + bottom sheet (`.presentationDetents([.height(96), .medium, .large])`) listing `FindRestaurantRowView` rows (title + cuisine·neighborhood + 2-line italic XHS excerpt + 88×88 photo). Tap row → map centers + scrolls list; tap photo → opens `RestaurantDetailView`. Honors `UserProfile.discoverySources`. **Backend:** `xhs_restaurants.latitude` / `longitude` (additive migration on Neon + SQLite); `placesEnricher.FIELDS` requests `places.location`; pipeline + import-xhs UPSERT writes coords. **Backfill:** `npm run backfill-coords` (`scripts/backfill-coords.ts`) walks rows missing coords and calls Places Details. **iOS files:** `Views/Find/FindView.swift`, `FindRestaurantRowView.swift`, `ViewModels/FindViewModel.swift`. New IDs `5FBAD0900-5FBAD0C00` in pbxproj, Find group under Views. |
| D9 | Function count exceeds Hobby 12-cap after adding blocks + auth | ⏳ Blocked on plan | Deployed count: 15 (weekly, import-xhs, unavailable, places/enrich, locations, scrape×2, user/ensure, user/reservations, user/reservations/[id], user/favorites, user/favorites/[restaurantId], user/blocks, user/blocks/[restaurantId], auth/login). Either upgrade to Pro (also unblocks P0's `maxDuration: 300`) or archive low-priority endpoints (e.g. `scrape/eater`, legacy `scrape/xiaohongshu`) back into `api-archive/`. |

---

## Stage 1 — Local Server (single user, laptop)

> Goal: fully working end-to-end on `localhost`. No Vercel account, no cloud DB, no auth.
> iOS simulator points to `http://localhost:3000`.

### Database — switch to SQLite

| # | Task | Status | Notes |
|---|------|--------|-------|
| B1 | Swap `db.ts` from Neon to SQLite (`better-sqlite3`) | ✅ Done | `backend/data/wheretoeat.db`; `sql` tagged-template wrapper keeps Neon-compatible API |
| B2 | Update `scripts/migrate.ts` for SQLite dialect | ✅ Done | UUID→TEXT, TIMESTAMPTZ→TEXT, all new columns included |
| B3 | Run migration to create local tables | ✅ Done | `backend/data/wheretoeat.db` created |

### XHS Pipeline

| # | Task | Status | Notes |
|---|------|--------|-------|
| B4 | End-to-end test: `POST /api/restaurants/pipeline/run` → verify DB rows | ✅ Done | 3/3 restaurants scraped, enriched, inserted; `scripts/test-pipeline.ts` |
| B5 | Check `/api/restaurants/weekly?city=nyc` returns correct shape | ✅ Done | Verified via `scripts/test-weekly.ts`; all fields correct |
| B6 | Debug + tune: scraper pagination, LLM extraction quality, dedup accuracy | ✅ Done | Fixed: LLM batch changed to sequential (13s delay) to stay under Gemini free-tier 5 RPM limit |
| B7 | Set up local cron (macOS `crontab`) to run pipeline every Monday | ✅ Done | `crontab` entry: `0 6 * * 1 …/scripts/run-pipeline.sh`; logs to `data/pipeline.log` |
| B8 | Build `placesEnricher.ts`: given `restaurantName` + `address`/`approximateLocation`, call Places API (New) `searchText` and return `googlePlaceId`, `googleMapsUrl`, `googleDisplayName`, confirmed `address` | ✅ Done | Search query strategy: name+address → name+neighborhood → name+NYC |
| B9 | Update XHS pipeline: insert Step 3b (Places enrichment) between LLM extraction and dedup; update dedup to group by `googlePlaceId` first | ✅ Done | |
| B10 | Update DB migration: add `google_place_id`, `google_maps_url`, `google_display_name`, `is_available_this_week` columns to `xhs_restaurants` | ✅ Done | `is_available_this_week INTEGER DEFAULT 1` |
| B11 | Update `llmExtractor.ts`: add `address` to prompt + schema; remove translation instructions for `restaurantName` and `creatorRecommendation` | ✅ Done | Chinese text stored as-is |
| B12 | Weekly endpoint: filter on `is_available_this_week = true AND google_maps_url IS NOT NULL` | ✅ Done | |
| B13 | Add `PATCH /api/restaurants/:id/unavailable` endpoint — called by iOS when user swipes/blocks/books a restaurant | ✅ Done | `api/restaurants/[id]/unavailable.ts` |

### iOS — Home Screen

| # | Task | Status | Notes |
|---|------|--------|-------|
| I0a | Home screen State A: hero card with Google Maps photo, restaurant name, time, party size | ✅ Done | `BookingHeroCard` redesigned with full photo background + gradient overlay |
| I0b | Home screen State B: big "Book your restaurant for this week!" CTA | ✅ Done | stateBView in HomeView.swift |
| I0c | Tapping hero card → booking confirmation screen | ✅ Done | `BookingDetailView` sheet |
| I0d | "Find another restaurant" button below hero card → launches discovery | ✅ Done | |

### iOS — Weekly Restaurant Integration

| # | Task | Status | Notes |
|---|------|--------|-------|
| I1 | Add `WeeklyRestaurant` Swift model | ✅ Done | `Models/WeeklyRestaurant.swift`; `toRestaurant()` maps to unified model |
| I2 | Add `GET /api/restaurants/weekly?city=nyc` call in networking layer | ✅ Done | `Endpoints.weeklyRestaurants` + `markUnavailable` |
| I3 | Handle three states: `ready` / `building` / `stale` | ✅ Done | `WeeklyRestaurantService` polls every 30s on building/stale |
| I4 | Surface XHS restaurants in card deck with source badge | ✅ Done | `SourceBadgeView` in RestaurantCardView.swift; `SourceOrigin` enum on Restaurant |

### iOS — Unified Restaurant Schema & Custom List

| # | Task | Status | Notes |
|---|------|--------|-------|
| I16 | Define unified `Restaurant` Core Data entity with mandatory `restaurantName` + `googleMapsLink` | 📋 Todo | All sources use same entity |
| I17 | Custom list import: Google Maps link → auto-fills both mandatory fields immediately | 📋 Todo | |
| I18 | Custom list import: Yelp link → call Yelp API by business alias to get name, rating, review count, price, categories, phone; search Places API by name+address to resolve `googleMapsLink`; prompt user to confirm if ambiguous | 📋 Todo | Store all Yelp fields on the restaurant record |
| I19 | Custom list import: XHS link → backend-powered extraction (LLM + Google Places + Resy/OpenTable) with multi-restaurant support | ✅ Done | `POST /api/restaurants/import-xhs`; iOS `XHSImportPreviewView` for multi-select |
| I20 | Mandatory field validation gate: if `restaurantName` missing → prompt "What's the name?"; if `googleMapsLink` missing → in-app Google Maps search → user selects result | 📋 Todo | Cannot save without both |
| I21 | Deduplication on add: check `googlePlaceId`; offer merge if duplicate found | ✅ Done | `CustomListViewModel.addRestaurantFromDraft()` skips if googlePlaceId already exists |

### iOS — Discovery UX

| # | Task | Status | Notes |
|---|------|--------|-------|
| I5 | Source picker UI (Xiaohongshu on by default; Eater + Yelp off) | 📋 Todo | Persisted setting; "Sources" button in top bar |
| I6 | User's own list always fetched and shown first, regardless of source toggle | 📋 Todo | |
| I7 | "Skip for 1 month" action on own-list cards | 📋 Todo | Snooze 30 days; shown as "Snoozed until [date]" in list view with un-snooze option |
| I8 | Bookmark action on all cards → saves to user's own list | 📋 Todo | Toast confirmation; card stays in current deck session |
| I9 | "← Back to restaurants" always visible on pre-browser booking screen | 📋 Todo | Returning does not count as dislike/skip; show "You looked at this" indicator on card |
| I10 | Fetch booking link from Google Places | ✅ Done | `restaurant.effectiveBookingUrl` = `websiteUri ?? googleMapsUrl` (no reservation deep-link in Places API) |
| I11 | Open booking URL in `SFSafariViewController` | ✅ Done | `SafariView` wrapper in AvailabilityView.swift |
| I12 | On browser dismiss: screenshot → Gemini Vision | ⏳ Stage 2 | SFSafariViewController sandbox prevents reliable screenshot; using Yes/No fallback for Stage 1 |
| I13 | If confirmed: save booking, show confirmation, schedule reminder | ✅ Done | `saveManualBooking()` in ReservationViewModel; EventKit + NotificationService wired |
| I14 | If not confirmed: return to card deck | ✅ Done | "No" dismisses sheet, returns to deck |
| I15 | Fallback: "Did your booking go through?" Yes/No | ✅ Done | This IS the Stage 1 implementation; Gemini Vision is Stage 2 |

### iOS — UI Polish

| # | Task | Status | Notes |
|---|------|--------|-------|
| U1 | BookingHeroCard: photo background with gradient overlay | ✅ Done | Added `restaurantPhotoUrl` to `Reservation`; set on `saveManualBooking()`; full-bleed 200pt photo card |
| U2 | Swipe indicators: replace LIKE/NOPE text with icon circles | ✅ Done | Green heart + red X in filled circles; fade in on drag |
| U3 | Home screen State B: make it feel more exciting with restaurant teaser | 📋 Todo | Show count + blurred photo preview to build anticipation |
| U4 | Card counter in deck ("4 of 14") | 📋 Todo | Reduces swipe anxiety |
| U5 | Empty deck state: warmer copy + clear next action | 📋 Todo | "You've seen everything this week" + CTA |
| U6 | Booking success celebration | 📋 Todo | Confetti or animation on confirmation |
| U7 | Copy pass: personality throughout | 📋 Todo | "Finding restaurants…" → "Pulling this week's picks…" etc. |
| U8 | Action button hierarchy: heart slightly larger than X | 📋 Todo | |

### Restaurant Photos

| # | Task | Status | Notes |
|---|------|--------|-------|
| P1 | Add `photo_url` column to `xhs_restaurants` DB table | ✅ Done | ALTER TABLE on existing DB + added to `migrate.ts` |
| P2 | Fetch photo URL in `placesEnricher.ts` | ✅ Done | `photos[0].name` → `https://places.googleapis.com/v1/{name}/media?maxWidthPx=800&key=...` |
| P3 | Store `photo_url` in pipeline INSERT | ✅ Done | Flows through `PlacesResult` → `MergedRestaurant` → INSERT |
| P4 | Expose `photoUrl` in `/api/restaurants/weekly` response | ✅ Done | Added to SELECT + `WeeklyRestaurant` interface |
| P5 | iOS: map `photoUrl` in `WeeklyRestaurant.toRestaurant()` | ✅ Done | Set as `photos: [URL]` on `Restaurant` model |
| P6 | Restaurant card shows Google Places photo | ✅ Done | `RestaurantCardView` uses `restaurant.primaryPhotoURL`; works now that P5 is done |
| P7 | Download photo at pipeline time, serve from local server | ✅ Done | Saved to `data/photos/{placeId}.jpg`; served at `/photos/:filename`; `photo_url` stores `http://localhost:3000/photos/...` |
| P8 | Stage 2: replace local file storage with Vercel Blob | ⏳ Stage 2 | Vercel serverless has ephemeral filesystem; upload to Blob on enrichment, store Blob URL |

### Booking Flow

| # | Task | Status | Notes |
|---|------|--------|-------|
| BK1 | "Book Now" button → opens `websiteUri` in SFSafariViewController | ✅ Done | `AvailabilityView.swift` |
| BK2 | "Open in Google Maps" secondary button on pre-browser screen | 📋 Todo | Opens `googleMapsUrl` in SFSafariViewController; shown below "Book Now" |
| BK3 | Stage 2: direct Resy / OpenTable booking (no browser) | ⏳ Stage 2 | Requires reservation API credentials + Stripe for deposits |

### Dev Infrastructure

| # | Task | Status | Notes |
|---|------|--------|-------|
| D1 | iOS build fixed (4 compiler errors) | ✅ Done | `DiscoveryViewModel` @MainActor; removed dead `createPaymentIntent`; stubbed Resy/OT/Tock; fixed `ReservationConfirmView` |
| D2 | Local dev server (`scripts/local-server.ts`) | ✅ Done | Bypasses `vercel dev`; routes to handler files directly; `npm run start` |
| D3 | iOS default API URL → `http://localhost:3000` | ✅ Done | `APIClient.swift` fallback changed; set `API_BASE_URL` in Info.plist for production |
| D4 | Weekly endpoint logs top 10 DB restaurants on each request | ✅ Done | `weekly.ts`; shows score, availability flag, Maps URL status |

### XHS Link Import (add restaurant from XHS share text)

| # | Task | Status | Notes |
|---|------|--------|-------|
| X1 | Backend: `POST /api/restaurants/import-xhs` — resolve short link, scrape post, LLM extract, enrich with Places + Resy + OpenTable | ✅ Done | `api/restaurants/import-xhs.ts`; reuses existing xhsScraper, llmExtractor, placesEnricher, resy, opentable |
| X2 | Backend: export `readNote()` from xhsScraper.ts | ✅ Done | Was module-private, now exported |
| X3 | iOS: extract HTTP URL from arbitrary pasted text (XHS share text contains Chinese + link) | ✅ Done | `NSDataDetector` in `AddRestaurantView.extractURL(from:)` |
| X4 | iOS: `.importXhs(url:)` endpoint case (POST with JSON body) | ✅ Done | `Endpoints.swift` |
| X5 | iOS: `CustomListImportService` calls backend for XHS (multi-restaurant), client-side for others | ✅ Done | Returns `[ImportedRestaurantDraft]` array |
| X6 | iOS: `CustomListViewModel` supports multi-draft selection + `confirmXhsImport()` | ✅ Done | `importDrafts`, `selectedDraftIndices`, `showXhsImportPreview` |
| X7 | iOS: `XHSImportPreviewView` — multi-restaurant selection UI with photos, badges, checkmarks | ✅ Done | `Views/CustomList/XHSImportPreviewView.swift` |
| X8 | iOS: `CuisineTag.from(string:)` helper for parsing cuisine strings | ✅ Done | |

### XHS link import — async redesign (2026-04-28)

> Full design in `SPEC.md § XHS link import — async flow (revised 2026-04-28)`. Goal: paste should never block the user; cached posts add instantly; new posts stream in over a background job.

| # | Task | Status | Notes |
|---|------|--------|-------|
| X9 | Backend schema: `import_jobs` table | 📋 Todo | Add to `scripts/migrate.ts` (SQLite) and `scripts/migrate-cloud.ts` (Neon). Columns + index per spec. Idempotent `IF NOT EXISTS`. |
| X10 | Backend: rewrite `POST /api/restaurants/import-xhs` as fast-path | 📋 Todo | Resolve URL → 24-hex noteId → `SELECT … xhs_sources WHERE post_url LIKE '%<noteId>%'`. Hits → return `status:ready` + hydrated restaurants synchronously (reuse `weekly.ts::hydrate`). Misses → INSERT `import_jobs(status='queued')` + return `status:pending` + `job_id`. Ceiling 2s wall clock. |
| X11 | Backend: `processJob()` worker | 📋 Todo | Extract from existing `import-xhs.ts` body; wire into `event.waitUntil()`. Six-step state machine (queued → reading → extracting → matching → enriching → done/failed). Each step writes its own `updated_at` checkpoint. Cases 3a (place_id hit → just insert source) and 3b (full enrich) branch inside step 4. |
| X12 | Backend: `GET /api/restaurants/import-xhs?job_id=…` | 📋 Todo | Same handler file as POST (no new function — Hobby cap is 12). Returns `{status, resolved, pending_count, error}`. Refuses cross-user reads via `withUser`. |
| X13 | Backend: cron sweeper for stuck jobs | 📋 Todo (deferred) | Only needed if `waitUntil` doesn't reliably hold the function alive on our plan. 1-min cron picks `import_jobs` whose `status NOT IN ('done','failed')` AND `updated_at < NOW() - 60s` and re-enters `processJob`. Skip until we see real stuck jobs in prod. |
| X14 | iOS: `XHSImportService` — paste, optimistic dismiss, switch on response | 📋 Todo | Replace existing `CustomListImportService` XHS branch. Three outcomes: `ready` (write to list + toast), `pending` (write any `restaurants_known`, save job stub to `UserDefaults`, kick off poller), error (toast). |
| X15 | iOS: pending-import row in `CustomListView` | 📋 Todo | Special row above resolved restaurants. Title = `note_title ?? "Importing from 小红书…"`, subtitle = `"N of M restaurants ready"`, thin progress bar, 小红书 glyph. Tap on a `failed` row → retry. |
| X16 | iOS: foreground polling loop | 📋 Todo | 3s interval, exp-backoff to 15s after 60s, hard cap 5min foreground / 10min after relaunch. Diff `resolved` vs current list, append new restaurants, drop stub on done/failed. Persists in `UserDefaults` so kill-and-relaunch resumes. |
| X17 | iOS: local notification on done | 📋 Todo | `UNUserNotificationCenter` banner-only, no sound. Suppressed when My List is the active screen. Single permission prompt reuses the booking-reminder permission grant from M10. |
| X18 | iOS: remove `XHSImportPreviewView` selection UI | 📋 Todo | New flow imports everything in the post by default. Delete the file + remove the `showXhsImportPreview` / `selectedDraftIndices` plumbing from `CustomListViewModel`. Keep the file in git history in case we want it back for low-confidence Places matches. |
| X19 | Update SPEC + memory after deploy | 📋 Todo | Mark the "before/after" table done, capture the cache-hit ratio after a week of real usage in `project_xhs_import_async.md`. |

### Restaurant Recommendation (next feature)

> Design TBD — discuss before implementation.

| # | Task | Status | Notes |
|---|------|--------|-------|
| R1 | Spec the recommendation algorithm | 📋 Todo | Inputs: XHS list + user prefs (dietary, cuisine, swipe history) |
| R2 | Implement recommendation endpoint | 📋 Todo | Depends on R1 |
| R3 | iOS: recommendation UI | 📋 Todo | Depends on R2 |

### Multi-source ingest (Resy blog + Eater NY)

> Goal: expand the weekly restaurant ingest beyond Xiaohongshu. Two new sources feed the same canonical `xhs_restaurants` table (dedup axis: `googlePlaceId`). Pipeline stays local-only (same as XHS today). Author's *verbatim* paragraph is stored per-source on `xhs_sources.recommendation` (semantically `author_quote`) so the iOS app can surface the real editorial voice, not an LLM summary.
>
> **Status (2026-04-28):** MS1–MS6 + MS8 ✅ shipped. Full crawl complete: **592 canonical restaurants in Neon (was 291), 839 source rows (xiaohongshu 303 · resy_blog 326 · eater 210), 87 multi-source canonicals (22.5%, up from 1.7%).** See run notes below.

| # | Task | Status | Notes |
|---|------|--------|-------|
| MS1 | Additive migration: `source_type`/`source_title`/`author` on `xhs_sources` | ✅ Done | Backwards-compatible ALTER TABLEs in `migrate.ts` + `migrate-cloud.ts`. `source_type` defaults to `'xiaohongshu'` so existing XHS writer stays correct. `recommendation` column unchanged — it already holds verbatim author text per B11. |
| MS2 | `api/_lib/resyBlogScraper.ts` — category listing + post reader | ✅ Done | Two post types handled: listicle (`article.teaser2` x N → `.venue2-name` + `.venue2-lead`) and single-post (one dominant Resy anchor → page-scoped paragraph walk). Pagination walker `listResyBlogCategory(slug, {cutoffDate, maxPages})` walks `/category/<slug>/page/N/` and `/city/<slug>/page/N/`; stops when pageNew=0 or every URL on a page is older than cutoff. |
| MS3 | `api/_lib/eaterScraper.ts` — heatmap reader + index walker | ✅ Done | Iterates `.duet--article--map-card` (each card has `h2` + `p.duet--article--standard-paragraph` + `ul` with NYC-borough address). Pub date uses `max(datePublished, dateModified)` because heatmaps get republished annually. Pagination walker `listEaterMaps()` reads the `/maps` index for every `/maps/<slug>` link. RSS / category archive walking deferred — `/maps` covered the editorial we care about (took 11 unique heatmaps in this crawl). |
| MS4 | Generalize `llmExtractor.ts` to accept multi-source mentions + return verbatim `authorQuote` | ✅ Done | Verbatim quote is now extracted *structurally* by the scrapers (`venue2-lead`, `duet--article--standard-paragraph`) — the LLM never paraphrases it. `classifyMention(name, authorQuote, address)` returns `MentionClassification` with cuisine + features only. New `classifyMentionsBatch(mentions, batchSize=10, delayMs=7000)` does 10 mentions per Gemini call with array-schema response — same `format: 'enum'` constraints, same thinkingBudget=0. ~7.5× faster than per-mention; 54 batches for 536 mentions ran in 8 min in the live crawl with zero `batch.failed` / `batch.fallback_per_mention` warnings. |
| MS5 | `scripts/ingest-multi-source.ts` — orchestrator | ✅ Done | Orchestrator wired with `--paginate` (NYC-only via `/city/new-york/`), `--all-categories` (opts into `the-hit-list`/`guides`/`new-on-resy` — produces ~370 mostly non-NYC URLs, use only when needed), `--from-cache` (re-run from `data/ingest-cache.json` for fast iteration), `--dry-run`, `--no-enrich`, `--no-classify`, `--no-batch-classify`. Cutoff filter (`CUTOFF_DAYS`, default 365) drops mentions whose post is older than the threshold using authoritative JSON-LD `publishedAt`. Discovery progress persists at `data/ingest-progress.json` so a crash mid-fetch can `--resume`. |
| MS6 | Rate-limit + resume semantics | ✅ Done | Each scraper enforces 1.5s polite delay + honors HTTP 429 `Retry-After` (else 60s) with up to 3 retries. Gemini 2.5 Flash 429s caught in `generateJson` with exponential backoff (`MAX_LLM_ATTEMPTS=5`). Live crawl finished without a single 429 from any of the three providers. |
| MS7 | Validate verbatim-quote integrity | 📋 Deferred | Quote is now extracted structurally (no LLM paraphrase risk), so the substring-validator that this task envisioned is moot. Will revisit if we ever add an LLM fallback path for posts that don't fit the structural extractor. |
| MS8 | iOS: source badges on Discovery cards + attribution line on RestaurantDetail | ✅ Done (D14) | Implemented as part of D14: cross-source accent capsule on `RestaurantCardView` + multi-source quote stack on `RestaurantDetailView` with `author · sourceTitle` byline + tappable links to the source post. `Settings → Recommendation Sources` lets the user pick which source types feed Home + Discovery. |
| MS9 | Archive the shallow `api/scrape/eater.ts` endpoint | 📋 Todo | Already moved to `backend/api-archive/scrape/eater.ts` (verified during 2026-04-28 crawl). The deployed bundle no longer includes it. Task remains as a paperwork item to confirm and close. |

#### Live-crawl run notes (2026-04-28)

- **Discovery:** Resy `/city/new-york/` walked 14+ pages (capped early — was still finding posts when killed); 141 unique NYC post URLs. Eater `/maps` index returned 11 heatmaps. The 3 mixed-city Resy categories (hit-list/guides/new-on-resy) are gated behind `--all-categories` because their page-1 posts are mostly non-NYC (Detroit, DC, Chicago, LA) and would waste classifier quota.
- **Throughput:** 536 raw mentions after cutoff (-63 dropped >365d). Classify: 54 batches × ~9s = 8 min. Places enrich: 536 × ~1s = 9 min. Total wall-clock: ~25 min including HTTP polite delays. **All 386 canonicals resolved a `googlePlaceId`** and zero non-NYC addresses leaked through.
- **Cross-source jump:** 87/386 canonicals are multi-source (22.5%, up from 1.7% pre-pagination). Top: **Lei (7)**, **Golden Diner (6)**, **The Four Horsemen (6)**. Validates the cross-source UI design D14 already shipped.
- **Future revisit:** if we want even better coverage, opt into `--all-categories` and add a city-pre-filter (drop Resy URLs whose slug contains `-detroit/`, `-dc/`, etc.) before walking. Today's NYC-only path already gets the editorial picks the user cares about.
- **Memory `project_source_overlap_counts.md` is now stale** — it described the 5-cross-source / 12-multi-XHS state from 2026-04-22. Pre-pagination assumptions (e.g. "design Discovery card around single-source default") need re-evaluation now that 22.5% of canonicals are multi-source.

### MVP Gate — app entry → booking → reminder

> Focus: everything needed for the core loop to work end-to-end on a physical device.
> Most of this is DONE. The only hard blocker is backend reachability from the phone.

| # | Task | Status | Notes |
|---|------|--------|-------|
| M1 | App launches → HomeView renders greeting + filters | ✅ Done | |
| M2 | Home fetches weekly list → cuisine + borough tags populate | ✅ Done (code) / ⏳ Blocked on device | Works in simulator; fails on physical device because `localhost:3000` isn't reachable from phone. See M8. |
| M3 | "Let's go" → DiscoveryView with card deck | ✅ Done | Cuisine prompt popup removed this session |
| M4 | Swipe right → AvailabilityView sheet opens | ✅ Done | `likedRestaurant` triggers `.sheet(item:)` |
| M5 | "Book Now" → SFSafariViewController with effective booking URL | ✅ Done | `effectiveBookingUrl = bookingUrl ?? googleMapsLink` |
| M6 | Browser dismiss → "Did your booking go through?" Yes/No | ✅ Done | `handleBrowserDismissed()` → state = `.confirming` |
| M7 | Yes → ManualBookingEntryView (pick datetime + party size) → save | ✅ Done | `saveManualBooking()` persists to `WeeklySession` |
| M8 | Backend reachable from physical device | 📋 Todo | Pick one: (a) LAN IP + ATS exception for dev, (b) ngrok HTTPS tunnel, (c) redeploy to Vercel (prod URL returns 404 today) |
| M9 | Local reminder scheduled 24h before reservation | ✅ Done | `NotificationService.scheduleReservationReminder` via `UNNotificationCenter` |
| M10 | Notification permission prompt shown on first use | ⚠️ Verify | `requestAuthorization` is in NotificationService init path; confirm it triggers on fresh install before booking attempt |
| M11 | Calendar event created alongside reminder | ✅ Done | `EKEventStore.requestWriteOnlyAccessToEvents()` called lazily in `addToCalendar` |
| M12 | Booking appears as State-A hero card on Home after save | ✅ Done | `confirmedReservationThisWeek` computed from session reservations |
| M13 | Reservation reminder fires at T-24h with correct copy | ⚠️ Verify on device | Needs a device-day test (can't verify in simulator without time-shift) |

### Deferred — Auth + User Accounts

> Sign in with Apple + Sign in with Google, with backend user/saved-restaurants storage.
> Decision: defer until MVP loop is solid. Tracking here so we don't lose the plan.

| # | Task | Status | Notes |
|---|------|--------|-------|
| A1 | Backend: add `users` table (id, apple_sub, google_sub, email, name, avatar_url, created_at) | 📋 Todo | SQLite migration; one of apple_sub/google_sub required |
| A2 | Backend: add `saved_restaurants` table (id, user_id, google_place_id UNIQUE per user, snapshot_json, snoozed_until, saved_at) | 📋 Todo | Snapshot the restaurant so XHS churn doesn't orphan saves |
| A3 | Backend lib: verify Apple identity token via Apple JWKS | 📋 Todo | `appleid.apple.com/auth/keys`; validate `iss`, `aud` (bundle id), `exp`, `nonce` |
| A4 | Backend lib: verify Google identity token via Google JWKS | 📋 Todo | `www.googleapis.com/oauth2/v3/certs`; validate `iss`, `aud` (iOS client id), `exp` |
| A5 | Backend lib: session JWT — sign with server secret, 30-day expiry | 📋 Todo | `jsonwebtoken` or Node crypto.subtle |
| A6 | Backend middleware: `withAuth(handler)` — reads `Authorization: Bearer <token>`, loads user, attaches `req.user` | 📋 Todo | Matches existing `withRequestLogging` wrapper pattern |
| A7 | `POST /api/auth/apple` — body { identityToken, name? } → verify → upsert user → return { token, user } | 📋 Todo | |
| A8 | `POST /api/auth/google` — body { identityToken } → verify → upsert user → return { token, user } | 📋 Todo | |
| A9 | `GET /api/users/me` — returns current user | 📋 Todo | Uses withAuth |
| A10 | `GET /api/users/me/saved` — list saved restaurants for current user | 📋 Todo | |
| A11 | `POST /api/users/me/saved` — body { googlePlaceId, snapshot } → upsert | 📋 Todo | |
| A12 | `DELETE /api/users/me/saved/:id` — remove saved restaurant | 📋 Todo | |
| A13 | iOS: `AuthService` with Keychain-backed token storage | 📋 Todo | Use `kSecAttrAccessibleAfterFirstUnlock` |
| A14 | iOS: `User` model + `AuthState` (signedOut / signedIn(User)) in app-wide EnvironmentObject | 📋 Todo | |
| A15 | iOS: LoginView — Sign in with Apple button (`AuthenticationServices` `ASAuthorizationAppleIDButton`) | 📋 Todo | Capture identityToken + optional name on first sign-in |
| A16 | iOS: LoginView — Sign in with Google button (SPM: `google/GoogleSignIn-iOS`) | ✅ Done 2026-11-27 | See P6 in Recently shipped. |
| A17 | iOS: `APIClient` injects `Authorization: Bearer <token>` on every request when signed in | 📋 Todo | |
| A18 | iOS: Gate Home behind auth — unauthed user sees LoginView on launch | 📋 Todo | Or allow guest mode with save prompt when they first tap heart |
| A19 | iOS: Rewrite `CustomListViewModel` — fetch/mutate via backend, local cache as fallback | 📋 Todo | Replaces local-only persistence |
| A20 | iOS: Settings → Sign out clears Keychain + resets state | 📋 Todo | |
| A21 | Config: Apple Sign In capability in Xcode + services ID at developer.apple.com | 📋 Todo | Need Team ID, Services ID, Key ID, .p8 private key |
| A22 | Config: Google OAuth iOS client at console.cloud.google.com | ✅ Done | Client `617615737877-0pdsb8nrjnosdhnsebn794501t1o5m52` exists and is live; double-check its bundle id is `com.weijia.wheretoeat` (P6b). |
| A23 | Env vars: `APPLE_TEAM_ID`, `APPLE_SERVICES_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY` (base64), `GOOGLE_IOS_CLIENT_ID`, `SESSION_JWT_SECRET` | 📋 Todo | |

---

## Stage 2 — Vercel + Cloud (partially deployed)

> Goal: backend deployed to Vercel, DB on Neon, iOS uses production URL.
> Backend + DB are live. Photos and the iOS host swap remain.

### Infrastructure

| # | Task | Status | Notes |
|---|------|--------|-------|
| S1 | Provision Neon Postgres via Vercel Marketplace | ✅ Done | Connection string auto-injected as `WHERE_TO_EAT_DATABASE_URL` |
| S2 | Make `db.ts` dual-backend (SQLite local, Neon cloud) | ✅ Done | Switches on `process.env.VERCEL`; SQL kept dialect-portable |
| S3 | XHS pipeline strategy decision | ✅ Done — **Hybrid** | Pipeline runs locally and writes to Neon; deployed bundle excludes the pipeline endpoint (501 guard kept in source) |
| S4 | Deploy backend: `vercel --prod` | ✅ Done | Live at `https://wheretoeat-red.vercel.app`; smoke-tested 233 restaurants returned |
| S4a | Archive non-Stage-1 endpoints to fit 12-function Hobby cap | ✅ Done | Reservation/Stripe/pipeline endpoints moved to `backend/api-archive/` |
| S4b | Migrate local SQLite data → Neon (`npm run push-data`) | ✅ Done | 20 pipeline_runs + 243 xhs_restaurants + 249 xhs_sources copied |
| S5 | Update iOS base URL to `https://wheretoeat-red.vercel.app` | ✅ Done | `APIClient.swift` now picks base URL by build config: `#if DEBUG` → `http://localhost:3000`, Release → `https://wheretoeat-red.vercel.app`. `API_BASE_URL` in Info.plist still wins as an override if set. Build verified. Xcode Run (⌘R) still hits localhost; Archive / Release builds hit Vercel. |
| S6 | Add cron config to `vercel.json` (Monday midnight UTC) — or external scheduler | 📋 Todo | Pipeline runs locally on demand for now; needs macOS launchd / cron, or a VPS-hosted runner |
| S7 | Push restaurant photos to Vercel Blob and rewrite Neon photo columns | ✅ Done | 58 local files + 1,081 Places photos migrated via `npm run push-photos` and `npm run migrate-places-photos`. All 233 restaurants now serve from `*.public.blob.vercel-storage.com`. Zero localhost or Places URLs remain in prod. |
| S8 | Patch the (archived) pipeline code to upload to Vercel Blob instead of writing to local disk | ✅ Done | `api-archive/restaurants-pipeline/run.ts` now uploads each Places photo to Blob during enrichment (`uploadPhotos` → `put({ access: 'public', addRandomSuffix: false, allowOverwrite: true })`) using `RESTAURANT_PHOTOS_READ_WRITE_TOKEN`. Blob URLs are stored directly in `photo_url` / `photo_urls`. Per-photo fallback to the original Places URL if a Blob upload fails, so data is never worse than before. `npm run push-photos` is no longer part of the normal loop — only needed if backfilling legacy rows. |
| S9 | Restore lost local secrets in `backend/.env.local` | 📋 Todo | `vercel env pull` wiped `LLM_API_KEY`, `LLM_MODEL`, `CRON_SECRET`, `RESY_PASSWORD`, `ANTHROPIC_API_KEY` from the local file (they weren't in Vercel cloud). Need to paste them back in for `npm run start` and the local pipeline to work. |
| S10 | Delete the stale private Blob store | 📋 Todo | The original attempt left a private store with a `BLOB_READ_WRITE_TOKEN` env var in Vercel. The upload script now explicitly prefers `RESTAURANT_PHOTOS_READ_WRITE_TOKEN` so it's harmless, but the old store should be removed to avoid confusion. |

### API Keys & Credentials (all for Stage 2)

| # | Key | Purpose | Status |
|---|-----|---------|--------|
| K1 | `GOOGLE_PLACES_API_KEY` | Enrichment + geocoding | ✅ Set in Vercel |
| K2 | `YELP_API_KEY` | Discovery + reviews | ✅ Set in Vercel |
| K3 | ~~Stripe, Resy, OpenTable, Tock~~ | ~~Reservation APIs~~ | ✅ Not needed — browser-based booking |
| K4 | `RESY_EMAIL` | Resy auth (used if reservation endpoints restored from archive) | ✅ Set in Vercel |
| K5 | `RESY_PASSWORD` | Resy auth | 📋 Todo — push to Vercel when reservation endpoints come back |
| K6 | `LLM_API_KEY` + `LLM_MODEL` | Gemini for `/api/restaurants/import-xhs` | 📋 Todo — `import-xhs` will 500 in prod until pushed |
| K7 | `CRON_SECRET` | Auth for pipeline cron endpoint | 📋 Todo — only needed if/when pipeline endpoint is re-deployed |
| K8 | `RESTAURANT_PHOTOS_READ_WRITE_TOKEN` | Vercel Blob photo store | ✅ Auto-injected (but store is currently private — see S7) |

### Core App Features (after Stage 2 is stable)

| # | Task | Status | Notes |
|---|------|--------|-------|
| L1 | Onboarding flow (dietary prefs, party size, Apple Pay, location) | 📋 Todo | |
| L2 | Weekly push notifications (Mon/Tue/Wed 6pm trigger) | 📋 Todo | |
| L3 | Custom restaurant list: paste-link (Google Maps, Yelp, XHS only) + share sheet + bookmark-from-card | 📋 Todo | |
| L4 | Reservation via browser (SFSafariViewController + Gemini Vision confirmation) | 📋 Todo | See Task 2 spec |
| L6 | Day-before reminder notification | 📋 Todo | |
| L7 | Calendar integration (EventKit) | 📋 Todo | |
| L8 | Swipe history-based ranking | 📋 Todo | |
| L9 | Cancellation flow (Resy, OpenTable) | 📋 Todo | |
| L10 | San Francisco support (`#旧金山美食`) | 📋 Todo | After NYC stable |

---

## Done ✅

| Task | Notes |
|------|-------|
| iOS builds successfully (Xcode, iPhone 16 Simulator) | |
| Location permission + Settings city detection | |
| Card deck navigation (Pick restaurants button) | |
| API client with `[API] →` / `[API] ←` logging | |
| Backend structured logging (`logger.ts`) | |
| Backend endpoints: `/api/places/enrich`, `/api/scrape/xiaohongshu`, `/api/scrape/eater` | |
| Backend endpoints: Resy/OpenTable/Tock search + book stubs | |
| Backend endpoint: `/api/stripe/create-payment-intent` | |
| XHS link import: backend endpoint + iOS multi-restaurant import flow | `POST /api/restaurants/import-xhs`; `XHSImportPreviewView`; URL extraction from share text |
| XHS pipeline spec + SPEC.md | |
| `xhs` CLI output format confirmed (YAML; search returns IDs, `read` returns full body + ms timestamp) | |
| `api/_lib/xhsScraper.ts` — CLI subprocess, YAML parser, age filter | |
| `api/_lib/llmExtractor.ts` — Gemini 2.5 Flash, structured JSON output | |
| `api/_lib/restaurantMerger.ts` — dedup by normalized name, rank by mentions × likes | |
| `api/_lib/db.ts` — Neon client (will be swapped to SQLite for Stage 1) | |
| `api/restaurants/pipeline/run.ts` — pipeline orchestrator | |
| `api/restaurants/weekly.ts` — weekly endpoint (ready/building/stale) | |
| `scripts/migrate.ts` — DB table creation script (needs SQLite update for Stage 1) | |
| Gemini API key + model set in `.env.local` | `gemini-2.5-flash` |
| `.gitignore` updated (`.env.local`, `node_modules`) | |
