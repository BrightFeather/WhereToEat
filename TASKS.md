# WhereToEat — Task Tracker

Status legend: ✅ Done · 🔄 In progress · ⏳ Blocked · 📋 Todo

---

## Active priorities (as of 2026-04-29)

The next wave of work, ranked. Pick from the top.

> **Top of the queue today:** P3 (Favorites UI — slot 12 is open, ~1h to wire up) → P4 (weekly auto-run launchd, ~30min) → P7 (device test M10/M13, needs a real iPhone for a day). Everything past P4 is a "want", not a "need".

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
| 9 | **P6** | Drop in the Google Sign-In SDK + client id | 📋 Deprioritised (P2) | Apple Sign-In covers MVP. Re-enable when needed: GCP iOS OAuth client → `GoogleSignIn-iOS` SPM → reverse-URL scheme → `vercel env add GOOGLE_IOS_CLIENT_IDS` → uncomment `googleButton` in `LoginView`. Backend `/api/auth/login` already verifies Google tokens. |
| 10 | **P2b** | Restore `backend/.env.local` secrets wiped by `vercel env pull` | 🔄 Partial | Still missing locally: `RESY_PASSWORD`. Only matters if the archived reservation backfill scripts are revived. `ANTHROPIC_API_KEY` is droppable (Gemini-only path). |
| 11 | **P2** | Ship the weekly XHS pipeline on Vercel | 📋 Deferred | Was P0; demoted because local-only works fine and Pro upgrade isn't budgeted. To reactivate: see SPEC § XHS pipeline (2026-04-29 model). |
| 12 | **N4** | gstack upgrade 0.15.5 → 1.20.0 | 📋 Optional | Major bump available; `/gstack-upgrade` when convenient. Not blocking. |

### Smaller polish backlog (post-MVP "wants")

| # | Task | Notes |
|---|------|-------|
| N5 | Settings → Clear Cache button | `WeeklyCache.invalidate()` exists; just needs a Settings row. Per `DESIGN-CACHING.md` § Open follow-ups. |
| N6 | Photo prefetch on weekly fetch | Pre-warm `URLCache` for the top-N restaurants so card photos render instantly on swipe. Per `DESIGN-CACHING.md` § Open follow-ups. |
| N7 | Map-pin clustering on Find tab | Currently shows N individual pins; cluster when zoomed out. |
| N8 | Tap a price chip → filter the deck to that tier | Cheap UX win once Favorites and the active queue are out of the way. |
| U3–U8 | Smaller iOS polish items (card counter, copy pass, button hierarchy, etc.) | See § iOS — UI Polish further below. |

### Recently shipped (week of 2026-04-28 / 2026-04-29)

| # | Task | Done | Notes |
|---|------|------|-------|
| P0 | `/api/restaurants/import-xhs` working on prod (Hobby tier) | 2026-04-28 | XHS cookies pushed to Vercel; smoke-tested 200 in ~17s. **Caveat:** `xsec_token` is single-use — `/404` after one read. Real share-sheet flow always carries fresh tokens; smoke-test scripts must pull fresh per attempt via `xhs search --json`. |
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
| A16 | iOS: LoginView — Sign in with Google button (SPM: `google/GoogleSignIn-iOS`) | 📋 Todo | Need iOS OAuth client ID + reverse-URL scheme |
| A17 | iOS: `APIClient` injects `Authorization: Bearer <token>` on every request when signed in | 📋 Todo | |
| A18 | iOS: Gate Home behind auth — unauthed user sees LoginView on launch | 📋 Todo | Or allow guest mode with save prompt when they first tap heart |
| A19 | iOS: Rewrite `CustomListViewModel` — fetch/mutate via backend, local cache as fallback | 📋 Todo | Replaces local-only persistence |
| A20 | iOS: Settings → Sign out clears Keychain + resets state | 📋 Todo | |
| A21 | Config: Apple Sign In capability in Xcode + services ID at developer.apple.com | 📋 Todo | Need Team ID, Services ID, Key ID, .p8 private key |
| A22 | Config: Google OAuth iOS client at console.cloud.google.com | 📋 Todo | Need iOS bundle ID match, reversed client ID URL scheme |
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
