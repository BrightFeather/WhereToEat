# WhereToEat — iOS App Spec (v3, Final)

## Overview

A weekly-cadence restaurant discovery and reservation iOS app. Every Monday at 6am it curates a swipeable list of restaurants for the upcoming weekend, handles reservations end-to-end with native payment, and sends day-before reminders.

---

## Welcome screen (first launch only)

`Views/Onboarding/WelcomeView.swift`, gated by `@AppStorage("has_seen_welcome")`. Shown once on first launch before login; a single "Let's eat →" CTA dismisses it permanently.

**Composition (animated in on appear):**
- Warm gradient background (shared `WarmGradientBackground` — matches Home + My List).
- Logo: `fork.knife.circle.fill` SF Symbol, dual-tone orange + peach, with a soft breathing scale loop (`1.0 ↔ 1.04`, 2.4s, repeats forever).
- Serif wordmark "WhereToEat" (`.system(size: 44, weight: .black, design: .serif)`) + two-line secondary copy "Curated NYC picks, fresh from Xiaohongshu creators."
- Three polaroid-style cuisine cards (🍣 Japanese, 🍝 Italian, 🌮 Mexican) fanned with `-10° / 0° / +10°` rotations, each a gradient tile + white caption. Spring-scale in with a staggered delay so they "deal" onto the page.
- Purple → orange gradient CTA "Let's eat →" (mirrors the Home "Find another restaurant" palette).
- Tagline "Over 100 spots · bookable on Resy & OpenTable".

**Animation timeline** (driven by `onAppear`):
1. `0.00s` — logo spring-scales from 0.6 → 1.0 and fades in.
2. `0.20s` — wordmark slides up (offset 24 → 0) + fades in over 0.5s.
3. `0.40s` — subtitle fades in.
4. `0.55s – 0.91s` — polaroids fan in one at a time (spring, 0.12s stagger).
5. `1.15s` — CTA + fineprint slide up + fade in.
6. From mount onward — logo breathes on a 2.4s loop.

**Routing** — `RootView` order is now: `WelcomeView` (first launch only) → `LoginView` (unless signed in or "Continue as guest") → `HomeView`. Tapping "Let's eat" sets `has_seen_welcome = true` with a 0.35s opacity+scale transition into the next screen.

## Multi-page onboarding (deferred)

The old multi-page onboarding flow (party size / dietary prefs / payment / permissions) is **skipped on entry**. `UserProfile.load()` supplies the defaults that would have been collected (party size 2, no dietary restrictions); those surface wherever they matter — notably the `ConfirmBookingForm` stepper. Users can change them later in Settings. `OnboardingContainerView` is kept in the project for easy re-enable.

Defaults for the fields an onboarding flow would have collected come from `UserProfile.load()`:

| Field | Default | Where it surfaces today |
|---|---|---|
| Dietary preferences | None | Settings → Dietary Preferences (editable any time) |
| Default party size | 2 | `ConfirmBookingForm` Stepper pre-fill; editable per-booking |
| Default payment method | None | Not asked — deposit flow is deferred (see Task 2) |
| Notification permission | Prompted lazily | On first `ReservationViewModel.saveManualBooking` when we schedule the T-24h reminder |
| Location permission | Prompted lazily | On first Discovery load if the user opted into geo-filtered picks |

**Dietary preference options** (when surfaced in Settings): No restrictions · Vegetarian · Vegan · Halal · Kosher · Gluten-free · Dairy-free · Nut-free · No shellfish · No pork.

**Cuisine preferences** — not collected up front. Instead, Home + Discovery infer them from what the user swipes right on / books over time. Filtering is done per-view via the cuisine chip row on Discovery.

---

## Location Configuration

- **Default:** device's current location (CoreLocation significant-change, updated daily)
- **Override:** user pins a specific city in Settings → persists until cleared
- **Eater city:** auto-resolved from current location or city override (no separate config)
- Active override shown as banner in-app: *"Showing restaurants in New York, NY"*

---

## User Identity & Per-User Data

Real Apple / Google Sign-In is deferred (see `TASKS.md` § A1–A23). Until it lands, the backend identifies each client by an **anonymous device-scoped UUID**. This is enough to persist reservations and favorites server-side without a login screen, and it leaves a clean upgrade path — swap the anonymous id for the real Apple/Google subject id during sign-in.

### iOS: `IdentityService`

- `ios/WhereToEat/Services/IdentityService.swift`
- Generates a UUID the first time it's accessed and stores it in the Keychain:
  - `kSecClass = kSecClassGenericPassword`
  - `kSecAttrService = "com.wheretoeat.identity"`
  - `kSecAttrAccount = "anonymous-user-id"`
  - `kSecAttrAccessible = kSecAttrAccessibleAfterFirstUnlock`
- The id survives app reinstalls on the same iCloud device.
- `APIClient` attaches `request.setValue(IdentityService.shared.userId, forHTTPHeaderField: "X-User-Id")` to **every** outbound request.
- `RootView.task` touches the id on launch and then calls `ReservationService.shared.syncFromServer()` so a fresh install / second device can hydrate its local `WeeklySession` cache from the backend.

### Backend: `withUser` middleware

- `backend/api/_lib/withUser.ts` wraps every user-scoped handler.
- Reads `X-User-Id`. Responds `400 MISSING_USER_ID` if absent or shorter than 8 characters.
- Upserts the `users` row (Postgres):
  ```sql
  INSERT INTO users (id) VALUES ($1)
  ON CONFLICT(id) DO UPDATE SET last_seen_at = now()
  ```
- Forwards the id to the handler as a third argument.

### Schema

User-scoped tables are defined in `backend/scripts/migrate.ts` (SQLite) and `backend/scripts/migrate-cloud.ts` (Neon). They are: `users` (id, display_name, created_at, last_seen_at), `user_reservations` (one row per booking, FK `user_id`, indexed on `(user_id, datetime)`), `user_favorites` (PK `(user_id, restaurant_id)`), `user_blocked_restaurants` (PK `(user_id, restaurant_id)` + optional `blocked_until` for time-limited blocks; null = block forever). Check the migrate scripts for the live column list.

### Source of truth + sync contract

- **Local (iOS) is the source of truth for the write path.** `ReservationViewModel.saveManualBooking` persists to `WeeklySession` (UserDefaults) synchronously, then posts to `/api/user/reservations` fire-and-forget. If the push fails, nothing is rolled back — the user's booking is already saved. Blocks follow the same pattern (`DiscoveryViewModel.block()` updates local `swipedCards` + `remoteBlockedIds` immediately, then fire-and-forget POSTs to `/api/user/blocks`).
- **Backend is the source of truth for hydration.** On launch, `RootView.task` calls `ReservationService.shared.syncFromServer()`. Rows from `GET /api/user/reservations` are bucketed into their owning week-of-Monday `WeeklySession` and upserted by id, then `.weeklySessionUpdated` is posted so `HomeView` and `BookingsListView` re-render. The Discovery deck additionally pulls `GET /api/user/reservations` + `GET /api/user/blocks` in parallel on each `loadCards` so the filter set stays fresh.
- **Favorites** share the same pattern; only the storage endpoints ship today (UI for remote-synced favorites is deferred until auth lands).
- **Seen-today** is deliberately device-local (`SeenService` in `UserDefaults`) and is **not** synced — cross-device repeat cards within a single day are an acceptable tradeoff versus per-swipe DB writes. TTL is 1 day by construction (keys are stamped with the ISO date; older keys GC'd on next read).

### Why an anonymous id today

- Unblocks "cross-device booking list" + "backend-truth bookings" now, with zero auth UI surface.
- When Apple / Google Sign-In ships, the login flow performs:
  1. Verify the identity token (JWKS).
  2. `UPDATE users SET id = :subjectId WHERE id = :anonymousId` (single transaction, cascades via FK in Neon).
  3. Client swaps the Keychain id for the subject id, keeping future `X-User-Id` headers stable.

---

## Tab bar (4 tabs)

The app's bottom navigation has four root tabs, in this order:

| # | Tab | Icon | Root view | Purpose |
|---|---|---|---|---|
| 0 | **Home** | `house.fill` | `mainTab` (greeting + bookings + picks) | Overview surface — greeting, upcoming reservations, three curated picks, gradient CTA into Pick |
| 1 | **Pick** | `flame.fill` | `DiscoveryContainerView(viewModel: pickVM)` | The Tinder-style swipe deck (formerly reachable only via Home's CTA push). |
| 2 | **Find** | `map.fill` | `FindView` | Map of NYC restaurants + bottom-sheet list with cuisine filter chips. |
| 3 | **My List** | `heart.text.square` | `CustomListView` | User's saved restaurants. |

`HomeView` owns the `TabView` and lifts `pickVM: DiscoveryViewModel` + `customListVM: CustomListViewModel` as `@StateObject`s so Pick / Find / My List share the same custom-list cache and Pick keeps its deck position across tab switches. Tab-switch buses: `.switchToMyList`, `.switchToPick`, `.switchToFind` — Home's gradient CTA + stats pills now post `.switchToPick` instead of pushing a NavigationStack destination.

## Find tab

Map-of-NYC + bottom-sheet list, modeled on Resy / OpenTable's "Search" surface. No search bar, no date pill — pure browse.

**Layout:**
- Full-bleed `Map` (Apple Maps via SwiftUI `Map(position:selection:)`) centered on Manhattan (40.7308, -73.9973, 0.10° span). Each restaurant with non-zero coords renders as a `FindMapMarker` — red filled circle, 2pt white border, drop shadow. Selected pin scales 16→22pt and gains an orange glow ring.
- Floating `ScrollView(.horizontal)` of cuisine chips at the top (`ultraThinMaterial` background) — same `CuisineChip` palette as Discovery for visual consistency, but local to the Find file.
- Bottom sheet (`.presentationDetents([.height(96), .medium, .large])`, `presentationBackgroundInteraction(.enabled(upThrough: .medium))`):
  - Peek (96pt): `"N restaurants"` label + drag handle.
  - Medium / large: scrollable `LazyVStack` of `FindRestaurantRowView`. Each row shows name (title3 bold), `Cuisine · Neighborhood` line, italic XHS excerpt (2-line clamp), and an 88×88 photo on the right.
  - Tap on row body → centers + zooms the map on that restaurant + highlights its row (tan card-border tint).
  - Tap on photo → opens the unified `RestaurantDetailView` sheet (full booking flow available).
- Map and list are linked: tapping a pin scrolls its row into view; selecting a row centers the map on the pin.

**Excerpt selection** (per row): highest-likes `xhs_sources` row where `source_type = 'xiaohongshu'`. Falls back to the legacy `recommendation` denormalized field for older cached rows.

**Source filter parity:** Find honors `UserProfile.discoverySources` — same toggle that controls Home + Discovery. Cuisine chip set is alphabetical across known cuisines.

**Coordinates pipeline:**
- Backend: `xhs_restaurants.latitude` + `longitude` (DOUBLE PRECISION on Neon, REAL on SQLite). Populated by `placesEnricher.searchPlace` from the new-API `places.location` field. Pipeline + import-xhs both write coords on insert/upsert.
- iOS: `WeeklyRestaurant.latitude` / `longitude` are optional Doubles. `toRestaurant()` populates `Coordinates` with them or falls back to `(0, 0)` (which Find then drops from the map; the row still appears in the list).

**Backfill:** `npm run backfill-coords` (`scripts/backfill-coords.ts`) walks every `xhs_restaurants` row with a `google_place_id` but missing coords, calls Places "Place Details" with the `location` field mask (1.2s delay between calls), and writes lat/lng. Idempotent.

## Home Screen

The first screen the user sees every time they open the app. Layout reacts to whether any upcoming reservations exist.

### Headline

- **Greeting** (large title): `"Good morning" | "Good afternoon" | "Good evening"` — time-of-day aware (5–11 morning, 12–16 afternoon, 17–4 evening). When the user is signed in via Apple or Google, the greeting personalises to `"<TimeOfDay>, <FirstName>!"` using the first whitespace-separated token of `AuthService.shared.state.displayName`. Guests / unauthenticated users see the bare `"Good morning"` form (no trailing comma).
- **Subhead** (title3, secondary):
  - 0 bookings → `"No upcoming reservations yet."`
  - 1 booking → `"You have 1 upcoming reservation."`
  - 2+ bookings → `"You have N upcoming reservations."`

Top-right toolbar: calendar icon → My Bookings, gear → Settings.

**Background.** A warm peach-cream `WarmGradientBackground` is applied to the `TabView` root (not just the inner ScrollView) and the UITabBar is configured with a transparent appearance, so the gradient bleeds edge-to-edge — no white sliver above the tab strip.

### Upcoming reservations (shown at the top if any)

All upcoming reservations render as a vertical stack of full-bleed hero cards directly under the headline, sorted by reservation datetime ascending — soonest on top. Each card shows restaurant photo, name, day, time, party size; tap opens My Bookings.

### This week's picks (always-expanded, reservation-aware count)

Curated cards under a static `"This week's picks"` header. The section is **always expanded** — there is no longer a collapse chevron or tap-to-toggle (the previous reservation-aware default-collapse behavior was removed because the picks section now sizes itself to the booking context).

**Slot count** depends on whether the user has an upcoming reservation:

- **No upcoming reservation** → 3 slots (Top Pick / New This Week / Hidden Gem).
- **Has ≥1 upcoming reservation** → 1 slot (Top Pick only). The picks section sits below the booking cards on Home, so a single follow-up suggestion keeps the section short.

| Slot | Label color | Rule |
|------|-------------|------|
| **Top Pick** | orange | **Daily-deterministic draw from the top 25% of the filtered pool** (`hash(yyyy-MM-dd + userId)` via a stable FNV-style combine). Same user, same day → same restaurant; tomorrow → different restaurant. Quality stays high because the lottery is restricted to the top quartile, not the long tail. |
| **New This Week** | green | Highest-ranked restaurant with `post_created_at` in the last 14 days. Falls back to the next top-ranked restaurant when no recent posts exist. (3-slot mode only.) |
| **Hidden Gem** | purple | Mid-ranked (20–60% percentile) restaurant that has a bookable link (Resy / OpenTable). Chosen with the same daily seed as Top Pick. (3-slot mode only.) |

**Shared filter set** (same as the Discovery deck):
- Server-side `user_reservations` — drop anything the user has already booked.
- Server-side `user_blocked_restaurants` (with `blocked_until` in the future) — drop active blocks.
- On-device `SeenService.seenToday()` — drop anything already dealt today.
- Local `WeeklySession.swipedCards` — drop this-week's dislikes and unexpired local blocks.
- If the user has `UserProfile.showOnlyReservable = true`, drop non-bookable restaurants from the pool entirely.
- `UserProfile.discoverySources` — drop any restaurant that has zero source rows whose `source_type` is in the user's enabled set. Defaults to all-on (`xiaohongshu` + `eater` + `resy_blog`); if the user disables every source the feed empties out by design.

**Tap a pick** → `RestaurantDetailView` sheet (unified booking surface; see Task 2).

### Single CTA

One purple→orange gradient button labeled based on context:

- **No bookings yet** → `"Swipe through all N picks →"`
- **Has bookings** → `"Swipe through N more picks →"`
- **No weekly data** → `"Find another restaurant →"` (fallback)

Launches the Discovery deck (Task 1).

### Stats row

Two tap-through pills at the bottom: `🍽 N picks` opens the Discovery deck, `📍 N saved` switches to the My List tab (via a `.switchToMyList` NotificationCenter bus).

### Background

Home has a warm vertical gradient behind the scroll content — sets a "food app" tone on open without competing with the hero cards / pick rows (which keep their own white or photo backgrounds so they still pop). The same palette is reused on **My List** so both tabs share one visual signature.

- **Light mode** — flat cream `#FFF0D9` (the `homeBgMid` stop). The earlier three-stop gradient (peach `#FFDFBB` → cream `#FFF0D9` → near-white `#FFFAEE`) introduced a visible seam where the peach met the near-white that read as "weird" on the device, so the wash is a single calm cream now.
- **Dark mode** — flat cocoa `#1E1209` (the dark-mode `homeBgMid`), keeping the "kitchen at night" feel without a vertical band.

Implementation: a single shared `WarmGradientBackground` view (defined in `HomeView.swift` alongside the `Color.homeBg{Top,Mid,Bottom}` dynamic-color extension; the `Top`/`Bottom` shades are kept around for one-off accents but the background itself uses only `homeBgMid`). Each consumer applies `.background(WarmGradientBackground().ignoresSafeArea())` + `.scrollContentBackground(.hidden)` on its scrolling container so the wash shows through instead of the default `systemBackground`. On `CustomListView`'s `List`, each row explicitly keeps `.listRowBackground(Color(.systemBackground))` so rows still read as raised cards over the warm wash.

### Filter chips

Filter chips (cuisine, borough, neighborhood) are **not shown on Home**. They live on the Discovery screen (`DiscoveryContainerView`) — next to the card deck where they're useful. Home stays focused on greeting + reservations + the one "Find another restaurant" CTA.

### Data source

- Upcoming reservations are computed from **every** persisted `WeeklySession` (`WeeklySession.allReservations()` scans `UserDefaults` keys prefixed `weekly_session_`) and deduplicated by id. A booking made today for next Saturday is persisted under next Monday's key, so aggregating across buckets is mandatory — otherwise the subhead count and the cards under it would disagree.
- Local save is synchronous and unconditional; the backend push is fire-and-forget (see User Identity & Per-User Data).

### Photo Policy — always use Google Maps

Restaurant photos throughout the app (home screen hero, card face, expanded card) are always sourced from **Google Places API** only.

- Do not use Yelp photos, Xiaohongshu images, or scraper-sourced images as the primary photo
- Google Places photo URL is fetched during the XHS pipeline (Places enrichment step) and **stored directly in the `xhs_restaurants` DB table** as `photo_url TEXT`
- Photo URL format: `https://places.googleapis.com/v1/{photoName}/media?maxWidthPx=800&key={API_KEY}` — constructed from the `photos[0].name` field returned by `places:searchText`
- If Google Places returns no photo, show a neutral placeholder (no fallback to other sources)
- This applies to: home screen hero card, discovery card face, expanded card carousel, booking confirmation screen

---

## Weekly Trigger Schedule

| Day | Time | Action |
|---|---|---|
| Monday | 6pm | Push: "Pick your weekend restaurants" |
| Tuesday | 6pm | Re-notify if Task 1 incomplete |
| Wednesday | 6pm | Re-notify if Task 1 still incomplete |
| Thursday+ | — | No more triggers this week |

**Skip this week:** available on notification and in-app banner — suppresses further triggers until next Monday.

**Resume anytime:** home screen always shows "Pick this weekend's restaurants" Mon–Sun, allowing the user to start or continue Task 1 at any time.

**Use anytime:** even if the user has picked and booked a restaurant for the weekend. Still allow the user to use the functionality during any time of the day.

---

## Unified restaurant model

Every restaurant — whether sourced from XHS, Yelp, Eater, or the user's own list — uses one `Restaurant` shape with three mandatory fields: `id: UUID`, `restaurantName: String`, `googleMapsLink: URL`. The Google Maps link is the backbone: it's the key Places API uses to fetch the photo, address, hours, coordinates, and `websiteUri` (the Stage-1 booking fallback — Places has no reservation deep-link). A record without both `restaurantName` and `googleMapsLink` cannot be saved.

**Rating + social signals** (populated during Places enrichment, all nullable):
- `googleRating: Double?` and `googleUserRatingCount: Int?` — Google Maps overall rating (e.g. 4.7) plus the review count backing it. Read from Places `rating` + `userRatingCount`. `userRatingCount` matters because "5.0★ (3 reviews)" is not the same signal as "4.6★ (2k reviews)".
- `instagramUrl: URL?` — best-effort Instagram profile URL extracted from the restaurant's website. The enricher fetches `websiteUri` (8s timeout, 1.5MB cap), regex-matches `instagram.com/<handle>`, and rejects non-profile paths (`/p/`, `/reel/`, `/explore`, …). Failure is silent — never blocks enrichment; the field stays null.
- `priceLevel: String?` (column `price_level`) — Google Places New API `priceLevel` enum: `PRICE_LEVEL_INEXPENSIVE` / `MODERATE` / `EXPENSIVE` / `VERY_EXPENSIVE`. iOS's `WeeklyRestaurant.priceTier` maps these to the `Restaurant.priceRange` integer (1–4). **Render placement:** the `$`/`$$`/`$$$`/`$$$$` chip sits **inline with the rating row** on both the Discovery card (`RestaurantCardView` title line: `★ 4.7 (1.2k) · $$$`) and the restaurant detail page (`RestaurantDetailView.ratingBadge`, same shape). Null when Places didn't classify the listing — the chip just doesn't render, and the rating row degrades cleanly. The newer numeric `priceRange` field (with `startPrice`/`endPrice` money objects) is **not** persisted today; it's much sparser than `priceLevel` and the simple-tier UI doesn't need it.

See § Full Data Model for the full field list.

---

## Custom Restaurant List

### Input methods

**1. Share sheet (from other apps):**
User shares a Google Maps, Yelp, or Xiaohongshu link → WhereToEat appears as a share destination → import flow opens automatically.

**2. Paste-a-link (in-app):**
"+" button → "Add restaurant" → paste a URL. Supported: Google Maps, Yelp, Xiaohongshu links only.

### Parsing per source

| Source | Detected by | Auto-extracted |
|---|---|---|
| Google Maps | `maps.app.goo.gl`, `goo.gl/maps`, `maps.google.com` | `restaurantName` ✅, `googleMapsLink` ✅ — both mandatory fields resolved immediately |
| Yelp | `yelp.com/biz/` | `restaurantName` ✅ from Yelp API; `googleMapsLink` ⚠️ must be searched via Places API by name; also store: `yelpRating`, `yelpReviewCount`, `price`, `categories`, `phone` |
| Xiaohongshu | `xiaohongshu.com`, `xhslink.com` | **Backend-powered** via `POST /api/restaurants/import-xhs`. Extracts ALL restaurants from the post via LLM. Each enriched with Google Places (maps link, photos, address) + Resy/OpenTable booking URLs. Returns multiple restaurants; user selects which to add. |

### XHS link import — async flow (revised 2026-04-28)

The original flow blocked the user on a single, monolithic backend call (read post → LLM extract → Places enrich → Resy/OT lookup). On a fresh post that's ~10–30s; on a post the database has already seen, every byte of that work is wasted. The revised flow splits into a **fast synchronous path** (DB cache + light parse) and an **async background job** so the user is never blocked by enrichment they don't need.

#### Three cases, one entrypoint

**Case 2 — link is already in the DB.**
The post URL is in `xhs_sources` (we've seen it before, either via the weekly pipeline or a prior user import). Look up every `restaurant_id` joined to that post and add them to the user's list **synchronously, in the same response**. No LLM, no Places, no waiting. This is the common case for shared NYC food posts.

**Case 3a — link is new, but the restaurant already exists in `xhs_restaurants`.**
The post is new, but after a light extract (just enough to identify which canonical restaurants it references) we find them by `google_place_id`. Insert a fresh `xhs_sources` row for each match, bump `mention_count` + `total_likes`, return restaurant ids. The restaurant lands in the user's list quickly (single Places search per name, no full enrichment).

**Case 3b — link is new and at least one restaurant is new.**
Full pipeline: LLM extract → Places enrich → photo mirror → Resy/OT venue lookup → upsert into `xhs_restaurants` and `xhs_sources`. Slow, but the user already moved on.

#### Endpoint shape (one route, two verbs — stays under the 12-function cap)

`POST /api/restaurants/import-xhs` → returns immediately with one of:

```jsonc
// Case 2: full hit
{
  "status": "ready",
  "restaurants": [ /* hydrated weekly-restaurant rows */ ]
}

// Case 3a / 3b: kicked off a background job
{
  "status": "pending",
  "job_id": "imp_…",
  "note_title": "纽约之行的主线任务…",   // null until the read-note step lands
  "restaurants_known": [ /* any restaurants we matched in the synchronous slice */ ],
  "expected_total": 4                   // best-effort guess once we've parsed the post
}
```

`GET /api/restaurants/import-xhs?job_id=imp_…` → polls a single job:

```jsonc
{
  "status": "reading | extracting | matching | enriching | done | failed",
  "resolved": [ /* restaurants resolved so far, appended as we go */ ],
  "pending_count": 2,
  "error": null
}
```

Both verbs share the same handler file so we don't add another deployed function. The synchronous slice is bounded to <2s — it must fit in the iOS paste interaction.

#### Job state machine

```
queued → reading → extracting → matching → enriching → done
                                       └────► failed
```

Persisted in a new `import_jobs` table:

```sql
CREATE TABLE import_jobs (
  id              TEXT PRIMARY KEY,         -- imp_<ulid>
  user_id         TEXT NOT NULL,
  source_url      TEXT NOT NULL,            -- normalized xiaohongshu.com/explore/<id>
  note_id         TEXT,                     -- 24-hex, populated after URL resolution
  note_title      TEXT,                     -- best-effort, populated after readNote
  status          TEXT NOT NULL,            -- queued|reading|extracting|matching|enriching|done|failed
  resolved_ids    TEXT NOT NULL DEFAULT '[]',-- JSON array of restaurant ids the job has produced
  expected_total  INTEGER,                  -- known after extracting; null before
  error           TEXT,                     -- one-line message; null on success
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_import_jobs_user_status ON import_jobs(user_id, status);
```

`resolved_ids` is appended-to as each restaurant is resolved, so the client sees restaurants stream in (3a hits land within seconds; 3b hits trickle in over the full enrichment window).

#### Background execution

The handler returns the synchronous response, then keeps the function alive via `event.waitUntil(processJob(jobId))`. Inside `processJob`:

1. **read** — `readNote()` (CLI locally, HTTP fallback on Vercel). Update `note_title`, set `status = 'extracting'`. On captcha/auth failure → `status = 'failed'`, `error = 'xhs_blocked'`.
2. **extract** — DeepSeek-V4-Pro batch → array of `{ name, address?, recommendation }` plus a per-post `hasComplaint` flag. If `hasComplaint=true` the entire post is dropped (zero restaurants emitted) — see § Negative-post filter. Set `expected_total`, `status = 'matching'`.
3. **match** — for each name: Places search → look up `xhs_restaurants` by `google_place_id`. Hits → straight to step 5. Misses → step 4.
4. **enrich** (only for misses) — full `placesEnricher.enrichRestaurant` + Resy/OpenTable lookup + `@vercel/blob` photo mirror. Insert into `xhs_restaurants`.
5. **link** — `INSERT … ON CONFLICT (restaurant_id, post_url) DO NOTHING` into `xhs_sources` for every resolved restaurant; append id to `resolved_ids`; bump `mention_count` + `total_likes` on the canonical row.
6. Mark `status = 'done'` once every extracted restaurant is resolved or `'failed'` if Places couldn't ground any of them.

Steps 3–5 run per-restaurant, not as one transaction, so partial progress is observable. The total wall-clock budget is `maxDuration: 300` (Pro / Fluid Compute) — generous enough for the worst case (5 new restaurants × 8s of enrichment each).

If Vercel doesn't keep the function alive long enough on the current plan, the fallback is a sweeper: a 1-minute cron picks up `status IN ('queued','reading','extracting','matching','enriching')` rows whose `updated_at` is >60s old and re-enters `processJob`. Idempotent because every step writes its own checkpoint.

#### iOS client behavior

Paste flow (`AddRestaurantView` → `XHSImportService`):

1. User pastes a link, taps "Import". Sheet **dismisses immediately** (no spinner gating the modal).
2. The service POSTs to `/api/restaurants/import-xhs` and switches on the response:
   - `status: "ready"` → write the returned restaurants into `CustomListViewModel`, fire a toast `"Added N restaurants from 小红书"`. Done.
   - `status: "pending"` → store a stub in `CustomListViewModel.pendingImports[jobId]` containing `{ jobId, sourceUrl, noteTitle?, restaurantsKnown, expectedTotal }`. Any `restaurantsKnown` from the synchronous slice are written to the list right away.
3. `CustomListView` renders pending imports as a special row at the top: thumbnail = 小红书 glyph, title = `note_title ?? "Importing from 小红书…"`, subtitle = `"\(resolved.count) of \(expected_total ?? "?") restaurants ready"`, with a thin progress bar.
4. `XHSImportService` polls `GET /api/restaurants/import-xhs?job_id=…` every **3 seconds while the app is foreground**, exponential backoff to 15s after 60s, capped at 5 minutes total (10 min for backgrounded apps that just resumed). Each poll:
   - Diffs `resolved` against what's already in `CustomListViewModel` and adds the new restaurants (with the `sourceOrigin: .xhs`, recommendation pulled from the matching `xhs_sources` row).
   - On `status: "done"` → drops the pending row, fires a local notification `"N restaurants from your 小红书 post are ready 🍜"` (banner-only, no sound; suppressed if the app is foreground and My List is on screen).
   - On `status: "failed"` → drops the pending row, surfaces a toast with the `error` string (`xhs_blocked` → `"Couldn't read that post — try again in a few minutes"`; everything else → `"Import failed — tap to retry"`).
5. Pending imports persist in `UserDefaults` so a kill-and-relaunch keeps polling. iOS rehydrates the polling loop on app launch for any job younger than 1 hour.

#### State + storage rules

- **My List storage stays `UserDefaults`** for resolved restaurants. The `import_jobs` table is purely a backend coordination ledger; the iOS list of *resolved* restaurants is the same shape it is today.
- **Pending stubs** are `UserDefaults`-backed but distinct from the resolved list — they don't show in `📍 N saved` counts, don't appear in Discovery, and don't get filtered by the discovery-source preference.
- **Deduplication**: case 2 short-circuits before `xhs_sources` is touched. Case 3a relies on the unique `(restaurant_id, post_url)` index to swallow re-imports. The iOS layer checks `CustomListViewModel.contains(googlePlaceId:)` before adding so a hit on case 2 never creates a duplicate row in the user's list.
- **Multi-restaurant posts** still resolve to multiple cards (the LLM extract returns N restaurants), one per match — the client adds them all in one go without a selection sheet. The old `XHSImportPreviewView` checkmark UI is **removed**: the new flow defaults to "import everything in this post" because that matches what users actually want and the cost of an extra row is near zero.
- **Retry** on a failed job: tap the failed pending row → re-POSTs the same URL with `force=1`, which bypasses any cached partial state and starts a fresh job.

#### What this replaces

| Before | After |
|---|---|
| `import-xhs` always does the full pipeline | Cache check first; full pipeline only on cache miss |
| Sheet blocks on a 10–30s POST | Sheet dismisses in <1s |
| Selection UI on top of the result | No selection — everything in the post is imported |
| `import-xhs.ts` + Apple wait | Same handler with GET branch for status; `import_jobs` ledger |
| Errors surface as one big "Import failed" toast | Per-status toasts; transient errors retryable |

### Mandatory field validation

If either `restaurantName` or `googleMapsLink` cannot be resolved automatically, the app **must prompt the user** before saving:

- **Missing `restaurantName`:** show a text field pre-filled with the best guess (if any) → "What's the name of this restaurant?"
- **Missing `googleMapsLink`:** show a search field → "Find this restaurant on Google Maps" → in-app Google Maps search → user taps the correct result to confirm
- The restaurant **cannot be saved** until both fields are confirmed

### Deduplication

On add, check for an existing restaurant with the same `googlePlaceId`. If found, offer to merge (union notes + sourceOrigin) rather than create a duplicate.

---

## Task 1 — Discovery

### Step 0 — Weekly cuisine prompt
Before cards load: "What are you feeling this weekend?" → multi-select cuisine tags → "Show restaurants"

### Source picker

Before (or alongside) the cuisine prompt, the user can choose which discovery sources to pull from. This setting persists across sessions until changed.

| Source | Default | Notes |
|---|---|---|
| Xiaohongshu | ✅ On | Weekly pipeline; posts tagged `#纽约美食` |
| Eater | Off | RSS + HTML scrape for detected city |
| Yelp | Off | Yelp Fusion search API |

**User's own list is always included regardless of source picker.** It cannot be toggled off.

UI: a segmented toggle or checkbox group shown on the discovery setup screen. A "Sources" button in the top bar lets the user change it any time without restarting the flow.

### Restaurant sources

| Source | Method | Always shown |
|---|---|---|
| User's own list | Local DB | ✅ Yes — always first |
| Xiaohongshu | Weekly pipeline (`xhs` CLI/HTTP + Claude Haiku extraction) | When toggled on (default) |
| Resy blog | `api/_lib/resyBlogScraper.ts` — 4 category feeds, structural + LLM extraction | When toggled on |
| Eater NY | `api/_lib/eaterScraper.ts` — Atom RSS + heatmap archive, structural + LLM extraction | When toggled on |
| Yelp | Yelp Fusion search API | When toggled on |

**Deduplication:** all sources merge into one canonical `xhs_restaurants` row keyed by `googlePlaceId` (set during Places enrichment). When the same restaurant appears across multiple sources, a `xhs_sources` row is written per source mention, each with its own verbatim author quote — the card can then show "featured in Resy Hit List + Eater + Xiaohongshu" and the iOS detail view surfaces each quote with its byline.

**Author quote contract:** `xhs_sources.recommendation` stores the author's *verbatim* paragraph about the specific restaurant — not an LLM summary. Resy listicles and Eater heatmaps are extracted **structurally** (no LLM in the loop) — the quote is pulled directly from `.venue2-lead` (Resy) or `p.duet--article--standard-paragraph` (Eater). The LLM (DeepSeek-V4-Pro as of 2026-05-02; was Gemini 2.5 Flash) is only used downstream for cuisine + feature classification + sentiment.

**Negative-post filter (drop on any complaint).** Every XHS post passes through `classifyComplaint()` before its restaurants are admitted. The classifier is target-aware: a post that praises restaurant A and trashes restaurant B drops only the (B, post) source row — the (A, post) link survives. Aggressive: any criticism, mixed review, lukewarm endorsement ("just okay", "fine"), warning ("avoid"), or "X not as good as Y" (where target is X) → drop. Pure-positive only → keep. Failure mode is fail-closed (LLM error → drop). Same rule applies to:
- The weekly pipeline (`scripts/test-pipeline.ts`) via `extractRestaurantData()`'s `hasComplaint` field
- Per-restaurant top-up runs (`npm run topup-asian`)
- One-shot backfill (`npm run scrub-negative`) which deletes pre-existing negative source rows on both SQLite and Neon

This rule was introduced 2026-05-02 after a Shiki Omakase post (`人均两百的omakase，创作者表示以后再也不会去`) was found in the deck.

**Ranking:**
1. User's own list (always surfaced first)
2. Combined source score: `mention_count × 10 + Σ(likes × recency_weight)` — mention count is cross-source now (an Eater-only restaurant has `mention_count=1`; an XHS+Resy+Eater restaurant has `mention_count=3`).
3. Yelp rating × review count when selected

**Source-specific notes:**
- **Resy blog** — every mentioned restaurant is *by definition* bookable on Resy, and the post body contains `resy.com/cities/new-york-ny/venues/{slug}?venueId={id}` anchors. The scraper parses those anchors directly to populate `resy_venue_id` + `resy_booking_url`, skipping the `_lib/resy.ts::findVenue` API call for these entries.
- **Eater NY** — general editorial coverage with no booking link attached. After Places enrichment, the pipeline runs `findVenue(name, lat, lng)` opportunistically to see if the place happens to be on Resy.
- **Pipeline placement** — both new scrapers run in the *local-only* pipeline (same constraint as the XHS scrape; Vercel functions can't shell out and are capped at 60s). Cron / launchd on the Mac triggers it.

**Pagination + cross-source coverage (live as of 2026-04-28).** `scripts/ingest-multi-source.ts --paginate` walks Resy `/city/new-york/` (NYC-only — the other 3 categories are city-mixed national feeds, gated behind `--all-categories`) and the Eater `/maps` index. The full crawl writes to local SQLite and is then synced to Neon via `npm run push-data`. Most recent run produced **592 canonical restaurants** in `xhs_restaurants` (was 291 — 2× growth from XHS-only baseline) and **839 source rows** (xiaohongshu 303 · resy_blog 326 · eater 210). 87 of the 386 net-new mentions are multi-source (22.5% — up from 1.7% pre-pagination), with `Lei (7)`, `Golden Diner (6)`, `The Four Horsemen (6)` topping the cross-source list. Classification uses `classifyMentionsBatch` (10 mentions per Gemini call, ~7.5× faster than per-mention) — 54 batches for 536 mentions ran in 8 min with zero schema rejections. The `mention_count` JSON field on the iOS card model now reads cross-source and the Discovery accent capsule (`Featured in Eater + Resy`, `3 mentions on 小红书`, …) lands on a meaningful share of the deck.

### User's own list — skip option

For restaurants in the user's own list, each card has an additional action: **"Skip for 1 month"**.

- Tapping "Skip for 1 month" hides the restaurant from the deck until 30 days from today
- The restaurant remains in the user's list (not deleted); it just won't surface in discovery
- Visible in the list view as "Snoozed until [date]" with an option to un-snooze early
- Separate from the global dislike/block actions which apply to all sources

### Card enrichment (per restaurant)

| Data | Source |
|---|---|
| Name, address, hours, coordinates | Google Places API |
| Photos | **Google Places API only** (see Photo Policy) |
| Rating + review snippets | Google Places + Yelp Fusion |
| Xiaohongshu post excerpts | Scraped posts referencing this restaurant |
| Booking link | Google Places `websiteUri` (no dedicated reservation deep-link in Places API; `reservable` flag only) |
| Dietary / cuisine match indicator | Matched against user profile |
| Source badge | "小红书" / "Eater" / "Yelp" / "My List" |

### Card UI

- **Card face:** hero photo, name, cuisine tags, neighborhood, price range, dietary match indicator, source badge, **cross-source accent label** (when it earns one — see below)
- **Expanded (tap):** photo carousel, map pin, full address + hours, rating summary, 3 review snippets (source-labeled), Xiaohongshu excerpts, all source links
- **Actions on each card:**
  - **Swipe right / Like** → go to Task 2 (booking)
  - **Swipe left / Dislike** → next card; restaurant resurfaces next week by default
  - **Bookmark** (yellow `bookmark.fill` SF Symbol button below the card stack) → restaurant saved to user's own list; the bookmark scales to 1.4× then back via spring animation, a `"saved! 🔖"` toast appears for 1.8s, the card remains in the deck for this session.
  - **Long-press → "Block for 4 weeks"** → restaurant hidden for 4 weeks from today
  - **"Skip for 1 month"** (own-list cards only) → snooze for 30 days
- **Deck exhausted** → "No more restaurants. Expand radius?" or shortcut to add custom restaurant

### Cross-source accent label

A small dark capsule next to the source badge surfaces editor-pick signals without dominating the card. The label is computed from `restaurant.xhsSources` at render time:

1. **XHS-only, count ≥ 3** — `"Mentioned 3+ times on 小红书"`. We deliberately cap the displayed count at `3+` rather than spelling out the exact number — it reads as a "lots of buzz" signal instead of a precise tally, and keeps the capsule legible across long-tail counts.
2. **XHS-only, count == 2** — `"Mentioned 2 times on 小红书"`. The exact number still reads cleanly at this size.
3. **Multi-source** — `"Mentioned on <names>"` joining the distinct source short-names alphabetically (`"Mentioned on 小红书 and Resy"`, `"Mentioned on 小红书, Eater, and Resy"`).
4. **Non-XHS only** — `"Featured in <name>"` (e.g. `"Featured in Eater"`).
5. **Otherwise** — no label. Single-source single-mention cards stay clean.

The detail view's source-stack header (`sourcesHeaderLabel`) mirrors these exact rules so card and detail page never disagree.

### Swipe / action history rules

| Action | Effect |
|---|---|
| Swipe left (dislike) | Hidden this week; reappears next week |
| Block | Hidden for 4 weeks from today (server-side + local) |
| Swipe right (like) → booked | Hidden for 4 weeks post-booking (via `user_reservations`) |
| Swipe right (like) → not booked | Reappears at top of deck next week |
| Any swipe (left / right / block / skip) | Card added to today's seen set → won't re-deal in the same calendar day |
| Bookmark | Added to user's own list; card stays in current deck |
| Skip for 1 month (own list only) | Hidden for 30 days; restaurant stays in list |

### Deck filter sources

`DiscoveryViewModel.buildDeck` combines four signals and drops any card whose id matches:

1. **`user_reservations`** (server) — every restaurant the signed-in user has ever reserved. Queried on `loadCards` via `ReservationService.fetchReservedRestaurantIds()`. No TTL column — the natural `datetime` field is the expiry signal; if you revisit the same deck in a year the reservation history still protects you from re-seeing a place.
2. **`user_blocked_restaurants`** (server) — explicit blocks with an optional `blocked_until TIMESTAMPTZ`. iOS sets `blocked_until = now() + 28 days` when the user taps "Block" (matches the existing "Block for 4 weeks" UI copy). A future long-press "block forever" path can pass `null`. Active-blocks query is `WHERE blocked_until IS NULL OR blocked_until > now()`.
3. **`SeenService` (iOS `UserDefaults`)** — per-day set of restaurant ids already dealt in this device's current session. Key format `seen_yyyy-MM-dd`; older keys lazy-GC'd on next read. Per-device (not cross-device); acceptable tradeoff for a personal-use app. `DiscoveryViewModel.advance()` is the single funnel that stamps the leaving card.
4. **`WeeklySession.swipedCards` (iOS `UserDefaults`)** — existing per-week swipe history. Covers the "dislike reappears next week" and "bookmark stays in deck" rules above.
5. **`UserProfile.discoverySources`** (iOS `UserDefaults`) — the set of `xhs_sources.source_type` values the user has opted into in Settings → Recommendation Sources. A restaurant is in the deck iff it has ≥1 source row whose type is in the set; restaurants with an empty `sources` array fall back to `xiaohongshu` (legacy default). Custom-list restaurants bypass this filter entirely — the user added them on purpose. Default set: all three known sources (`xiaohongshu`, `eater`, `resy_blog`); same filter is applied in `HomeViewModel.homePicks`. Disabling every source empties the feed by design — Settings shows a footer warning when the set is empty.

### Xiaohongshu deep-link

When a card shows a 小红书 "Creator says" quote, tapping it calls `XhsURLOpener.open(postURL)`:

- Extracts the 24-hex `noteId` from the stored `xiaohongshu.com/explore/{noteId}` URL.
- Tries the custom scheme `xhsdiscover://item/{noteId}` via `UIApplication.open(_:completionHandler:)`.
- On `success == false` (no app handles the scheme), falls back to opening the HTTPS URL in Safari.
- No `LSApplicationQueriesSchemes` entry needed — the completion-handler fallback covers it without declaring the scheme.

This works both on the Discovery swipe card (`RestaurantCardView`) and the expanded `RestaurantDetailView`. The duplicate "Xiaohongshu" row under the detail view's "Sources" section is hidden — the tap-to-open quote is now the single entry point.

---

## Task 2 — Reservation

### Philosophy

**Stage 1 (current):** Browser-based booking only. The reservation screen picks a destination in this order — **Resy booking URL → OpenTable profile URL → Google Places `websiteUri`** — and opens it in `SFSafariViewController`. The user completes the booking on the platform's own page. A second button opens the restaurant's Google Maps page for directions and additional info.

**Stage 2 (future):** Direct API booking via Resy or OpenTable — no browser required.

### Provider resolution & backfill

Booking URLs live on the restaurant row itself (`resy_booking_url`, `opentable_booking_url`). They are populated by two background scripts — one per provider — and the resolution rule is **Resy-first**:

1. **Resy backfill** (`backend/scripts/backfill-resy.ts`) — runs first; fills `resy_venue_id` + `resy_booking_url` where a venue match exists.
2. **OpenTable backfill** (`backend/scripts/backfill-opentable.ts`) — runs only on rows that still have `resy_booking_url IS NULL`. Drives opentable.com's homepage autocomplete in a persistent headed Chromium (the HTTP `/dapi/*` endpoints are Akamai-blocked; see `api/_lib/opentableSearch.ts`). For each match it calls `verifyBookable(rid)` — navigates to `/restaurant/profile/<rid>` and rejects the match if the profile sidebar reads *"Not available on OpenTable / not on the OpenTable booking network"*. Only verified-bookable rows are persisted.
3. **OpenTable re-verification** (`backend/scripts/verify-opentable.ts`) — re-runs `verifyBookable` against every row already carrying an OT URL and clears stale ones. Safe to re-run periodically.

The matcher in `api/_lib/opentableSearch.ts` strips generic tokens (`restaurant`, `the`, `nyc`, …), requires the first core token to align, and hard-filters candidates by exact OT metro (`"New York City"`) to avoid cross-metro false positives like Red Bank NJ or Rochester NY. See that module's JSDoc for the full recipe.

Stage 1 approach:
- Works for any restaurant regardless of which reservation platform they use
- Requires zero reservation API credentials
- Handles deposits, captchas, and login natively in the browser
- Stays robust even as reservation platforms change their APIs

### Flow (Stage 1 — current implementation)

1. **Unified browse + booking surface** (`RestaurantDetailView`):
   - Replaces the old split between a "detail" view and a dedicated `AvailabilityView.preBrowserView`. A single sheet handles everything from first glance to booking handoff.
   - Opens from three places: swipe-right on a deck card, tap-on-card in the deck, tap-on-card on a Home "This week's picks" slot, or tap-on-row in My List.
   - Owns the `ReservationViewModel` as an `@StateObject` — the state machine lives in this view.
   - **Content (scrolling)**: photo carousel (300pt tall) → name + bookmark button → cuisine / price tags → address + multi-source quote stack (XHS + Eater + Resy; see "Source quotes" below) + **inline "Open in Google Maps"** card + **inline interactive Apple Map** (pinch / pan / zoom enabled; floating top-right `arrow.up.right.square.fill` button hands off to native Apple Maps with the restaurant pre-pinned via `MKMapItem`; camera re-centers on `onAppear` so previous pan/zoom doesn't leak across restaurants) → reviews → sources (non-XHS link list).
   - **Bookmark** (outline / filled yellow) next to the name — tap always toggles add/remove against `CustomListViewModel` in-place; on save, also `SeenService.markSeen(id)` so the card won't re-deal in the deck today. **Never dismisses the sheet**; user stays on the page.
   - **Top overlay**: close `X` (top-left) and a `…` menu (top-right, swipe context only) with "Block for 4 weeks".
   - **Bottom bar** (safe-area inset, ultra-thin material):
     - Swipe-deck context (`onLike` + `onDislike` wired): **Pass** + **Book this one** row.
     - Standalone context: single full-width **Book this one** CTA (falls back to "Go to Website" when no `reservationSource`).
     - Open in Google Maps and Open in Xiaohongshu are **not** in the bottom bar — Maps lives inline under the XHS quote, Xiaohongshu is reached by tapping the quote itself.
   - **Source quotes** (multi-source review stack): each `xhs_sources` row that mentioned this restaurant renders as its own quote card with a platform-coloured badge (`小红书` red / `Eater` orange / `Resy` red), the verbatim recommendation, and an `author · sourceTitle` byline when present. **Order:** 小红书 rows first, sorted by **word count desc** so the most substantive review sits on top (`max(whitespace-token-count, character-count)` — handles Chinese as well as English); non-XHS rows follow in the backend's likes-desc order. Collapsed to **3 rows by default**, with a `See all N reviews` button revealing the rest (and a `Show less` to re-collapse). Tap on a quote opens the post — XHS rows go through `XhsURLOpener` (deep-link → Safari fallback), Eater / Resy rows open in Safari directly. The header above the stack mirrors the swipe-card accent rule (e.g. `"Mentioned 3+ times on 小红书"`, `"Mentioned on 小红书 and Resy"`, `"Featured in Eater"`); single-source single-quote cards skip the header for visual quiet.

2. **Browser presentation** (`SafariPresenter`):
   - **Not** a SwiftUI `.fullScreenCover` or `.sheet`. A UIKit-direct presenter finds the topmost `UIViewController` and calls `present(_:animated:)` on `SFSafariViewController` with `modalPresentationStyle = .fullScreen`.
   - Rationale (hard lesson learned in-flight): presenting Safari from *inside* the detail sheet caused iOS to cascade-dismiss the outer sheet on Safari close, wiping the `ConfirmBookingForm`. Going direct through UIKit keeps the SwiftUI modal stack untouched.
   - The user completes booking on the restaurant's own site. When Safari's Done button fires `safariViewControllerDidFinish`, the delegate calls `reservationVM.handleBrowserDismissed()`, which transitions `ReservationFlowState → .confirming`.

3. **Confirm booking** (`ConfirmBookingForm`, state `.confirming`):
   - One unified screen — no Yes/No prompt. Presented as a `.sheet` from `RestaurantDetailView` when the VM state is `.confirming`.
   - Prefilled fields: restaurant name (header), `DatePicker` for date + time (default = next Saturday 7:30 PM), `Stepper` for party size (default from `UserProfile`).
   - "Save booking" (green) calls `viewModel.saveManualBooking(datetime:partySize:)`; "I didn't end up booking" resets state to `.preBrowser` (no save).
   - `interactiveDismissDisabled` is on while the form is open so a stray swipe won't wipe the user's input.
   - Screenshot analysis / Gemini Vision is **not used**. The user enters the booking manually because platform-specific confirmation pages are too heterogeneous to reliably parse.

4. **Save path** (`ReservationViewModel.saveManualBooking`):
   - Build a `Reservation` with `platform = .other`, `status = .confirmed`, `confirmationCode = "—"`.
   - `NotificationService.scheduleReservationReminder` → UNUserNotification 24h before `datetime`, stash `reminderNotificationId`.
   - EventKit: request write-only access, add a 2-hour calendar event at `reservation.datetime`, stash `calendarEventId`.
   - Local cache: append to current `WeeklySession` via `session.addReservation(reservation)` and `session.save()` (UserDefaults, keyed by week-of-Monday).
   - **Backend push** (fire-and-forget): `ReservationService.pushReservation(reservation)` → `POST /api/user/reservations` with the device's `X-User-Id`. Silent failure is acceptable — local save already succeeded.
   - Broadcast `.weeklySessionUpdated` via `NotificationCenter` so Home + My Bookings refresh.
   - Transition to `.success(reservation)`.

5. **Success screen** (`ReservationSuccessView`):
   - Presented as a `.fullScreenCover` from `RestaurantDetailView` when the VM state is `.success(reservation)`.
   - **Animation:** green `checkmark.circle.fill` scales from 0.3 → 1.0 with spring response 0.5 / damping 0.6. Content beneath slides up with offset 40 → 0 + opacity 0 → 1, delayed 0.25s. Confetti burst launches at 0.3s — 40 circles of varied colors drift down with `easeOut 1.5s`.
   - **Copy:** headline `"You're all set!"` (large title, bold), subline `"for your reservation at {name} on {EEE, MMM d 'at' h:mm a}"` with the name and formatted date bolded.
   - Detail card below: calendar row (full date + time), party row, address row.
   - Reminder note: `"A reminder has been set for the day before."`
   - "Done" resets state to `.preBrowser` and dismisses the detail sheet, returning to Home with the fresh reservation already visible.

### Fallback paths

| Scenario | Behavior |
|---|---|
| `effectiveBookingUrl` nil (no website + no Google Maps link) | "Book Now" button is disabled and greyed. |
| Safari self-dismisses before user books | User still lands on `ConfirmBookingForm`; they can tap "I didn't end up booking" to bail. |
| Backend push fails | Local reservation survives (source of truth is local); next `syncFromServer` attempt will retry but we don't block on it. |
| User wants a different time | Close Safari → ConfirmBookingForm → "I didn't end up booking" returns to deck. |

**"Back to restaurants" behavior:** closing the pre-browser screen before tapping "Book Now" is a no-op — no reservation is saved, the restaurant isn't marked in any way.

### My Bookings list — swipe actions

`BookingsListView` groups reservations into Upcoming / Past. Each row supports two swipes:

- **Swipe right (leading edge) → Cancel.** Red trash action. Opens a confirmation alert: `"Remove this reservation?"` with body `"{name} on {day} at {time} will be cancelled."`. For Resy/OpenTable bookings an extra sentence is appended: `"You might still need to cancel the reservation on {Resy|OpenTable} to avoid cancellation fee."` (We only clear the local + server-mirror record; the third-party platform enforces its own policy and we can't call their cancel API.) Buttons are "Remove" (destructive) / "Keep" (cancel). `allowsFullSwipe: false` so a careless full-swipe can't bypass confirm.
- **Swipe left (trailing edge) → Save to list.** Accent-tinted bookmark action. Builds a minimal `Restaurant` from the reservation's `restaurantId`, name, photo, and platform (as `ReservationSource`) and calls `CustomListViewModel.addFromDiscovery`. Idempotent by id — re-saving shows an "Already in your list" toast; new saves show "Saved to your list". `allowsFullSwipe: true`. Saved rows are intentionally sparse (no coords/address/cuisine) because the reservation payload doesn't carry them.

---

## Task 3 — Reminder

- **Trigger:** local push notification 24 hours before reservation time
- **Content:** "[Restaurant] tomorrow at [time] — [party size] people · [neighborhood]"
- **Actions:**
  - "Directions" → Apple Maps
  - "View Booking" → in-app confirmation screen
  - "Cancel" → opens the restaurant's booking website in browser so user can cancel directly; shows phone number as fallback

---

## Settings screen

Reachable from the Home toolbar's gear icon. Form sections in order:

1. **Your name** — manual `displayName` override on `UserProfile`. Used by Home's `"Good afternoon, {name}"` greeting until Apple Sign-In takes over.
2. **Location** — current-location indicator + "Change city" override (pins a city until cleared).
3. **Dietary Preferences** — toggle chips against `DietaryTag`. "No restrictions" is mutually exclusive with the rest.
4. **Reservations** — default party-size stepper + "Only show bookable restaurants" toggle.
5. **Recommendation Sources** — per-source toggles for `xiaohongshu` / `eater` / `resy_blog`; persisted on `UserProfile.discoverySources` (drives both Home picks and the Discovery deck — see § Deck filter sources).
6. **Display** — "Show Google ratings" toggle (when off, ratings hide from cards + detail).
7. **Account** — when signed in, shows provider + name + a destructive Sign Out button (resets the Keychain UUID, re-prompts the login gate). When anonymous, shows a Sign-in shortcut.
8. **Send Feedback** — dedicated row that pushes `FeedbackView` (multiline `TextEditor` + optional reply-to email field prefilled from `UserDefaults["auth.email"]`). Submits to `POST /api/feedback`, which sends an email to `prompt.and.ship@gmail.com` via Resend with the `users.email` row as the `reply_to` fallback. Body also carries `appVersion` / `deviceModel` / `iosVersion` for triage.
9. **About** — version (`CFBundleShortVersionString`).

---

## Technical Architecture

### iOS App Stack
- **Language:** Swift
- **UI:** SwiftUI (deployment target iOS 17.0)
- **Local storage:**
  - `UserDefaults` — `WeeklySession` (keyed per week-of-Monday) with embedded reservations, user profile, swipe history, My List.
  - `Keychain` — anonymous device user id (`com.wheretoeat.identity` / `anonymous-user-id`, accessibility `AfterFirstUnlock`). See User Identity & Per-User Data.
  - Core Data is scaffolded (`PersistenceController`) but not used for the reservation flow in Stage 1.
- **Networking:** async/await + `URLSession` via `APIClient`. Every request carries `X-User-Id` automatically.
- **Booking:** `SFSafariViewController` presented UIKit-direct via `SafariPresenter` (never inside a SwiftUI sheet — see Task 2).
- **Notifications:** `UserNotifications` (local, 24h-before reservation reminder).
- **Location:** CoreLocation (when-in-use).
- **Calendar:** EventKit (write-only access, 2-hour block added on save).
- **Payments:** PassKit (Apple Pay) + Stripe iOS SDK — **deferred** until Stage 2 deposit flow.

---

### Backend

One codebase, two homes. Locally, `vercel dev` against `backend/data/wheretoeat.db` (SQLite); in production, Vercel serverless functions at `https://wheretoeat-red.vercel.app` against Neon Postgres. `api/_lib/db.ts` picks the dialect at runtime based on `process.env.VERCEL`. SQL stays dialect-portable — no `julianday` / `datetime('now')` / Postgres-only `now()` inside queries; compute timestamps in JS and pass as parameters. INTEGER booleans and `ON CONFLICT (col) DO UPDATE/DO NOTHING` work on both.

**Storage.**
- Neon Postgres — connection string auto-injected as `WHERE_TO_EAT_DATABASE_URL`, with fallbacks through `DATABASE_URL` / `WHERE_TO_EAT_POSTGRES_URL`.
- Vercel Blob public store `restaurant_photos_public` — hero photos uploaded once per restaurant, served off the Vercel CDN. Keeps the Places API key off the iOS image path and bypasses the Places photo-quota on every load.

**iOS base URL.** Defaults to the prod Vercel URL. For active local backend dev, set `dev_api_base_url` in `UserDefaults` (or `API_BASE_URL` in Info.plist) to the Mac's LAN IP / ngrok / `localhost:3000`. A physical iPhone resolves `localhost` to its own loopback, so direct localhost only works in the iOS simulator.

**XHS pipeline (2026-04-29 model).** Runs **locally** via `bash backend/scripts/run-pipeline.sh` (which calls `scripts/test-pipeline.ts` directly), then `npm run push-data` syncs SQLite → Neon. The HTTP route `api/restaurants/pipeline/run.ts` was archived to `backend/api-archive/restaurants-pipeline/run.ts` in D22 to free a slot under the Hobby 12-function cap (currently 11/12) — the cron + `maxDuration` blocks were stripped from `vercel.json` at the same time. To re-activate on Vercel: move the file back into `api/`, restore the `crons` (`0 10 * * 1`) + `functions.maxDuration: 300` blocks, **upgrade to Pro / Fluid Compute** so the 300s cap actually applies (Hobby ignores it and times out at 60s), and re-confirm function count ≤12. Two pieces still need to work in prod:

1. **HTTP parser replaces the `xhs` CLI** when running on Vercel. `api/_lib/xhsScraper.ts::searchViaHttp` + `readNoteViaHttp` fetch `xiaohongshu.com` directly and parse the SSR `window.__INITIAL_STATE__` blob. `searchXhsPosts` and `readNote` env-branch on `VERCEL === '1'` — HTTP-first in prod, CLI-first locally, cross-fallback both ways.
2. **Cookie auth from env.** `buildXhsCookieHeader()` composes a `Cookie` from `XHS_WEB_SESSION` / `XHS_A1` / `XHS_WEBID` (copy from a signed-in browser's DevTools → Application → Cookies → `xiaohongshu.com`). Without these, anonymous XHS requests hit a login wall.

**Dev / deploy workflow.**

```
cd backend
npm run migrate        # local SQLite schema (idempotent)
npm run migrate:cloud  # Neon schema (idempotent)
npm run start          # local server + pipeline via .env.local
npm run push-data      # SQLite → Neon copy (ON CONFLICT DO NOTHING)
npm run push-photos    # data/photos/*.jpg → Vercel Blob + rewrites photo_url columns
vercel --prod --yes    # deploy
```

SQLite at `backend/data/wheretoeat.db` is the dev source of truth — write/test there first, then push.

**Vercel env vars.**
- Set (production, as of 2026-05-02): `GOOGLE_PLACES_API_KEY`, `YELP_API_KEY`, `RESY_EMAIL`; Neon `WHERE_TO_EAT_DATABASE_URL` + family (auto-injected); Blob `RESTAURANT_PHOTOS_READ_WRITE_TOKEN` (auto-injected); `DEEP_SEEK_API` (DeepSeek-V4-Pro — was Gemini's `LLM_API_KEY`); optional `DEEPSEEK_MODEL` override; `CRON_SECRET`; `XHS_WEB_SESSION` / `XHS_A1` / `XHS_WEBID` (sourced from `~/.xiaohongshu-cli/cookies.json` — see memory `project_xhs_vercel_auth.md`).
- **Still missing** (only needed if endpoints below are reactivated): `LLM_MODEL` (defaults to `gemini-2.5-flash` if unset), `RESY_PASSWORD` + `ANTHROPIC_API_KEY` (only if reservation/legacy paths come back). Stripe keys — deferred until the deposit flow is restored.
- **`xsec_token` is single-use.** Each XHS share link carries a token consumed on first read; testing the deployed `import-xhs` requires a fresh token per attempt (pull via `xhs search "纽约美食" --json`). See memory `project_xhs_xsec_token_singleuse.md`.

The 8 archived routes under `backend/api-archive/` (reservations + stripe) stay excluded from the build regardless of plan.

---

### API Endpoints

#### Deployed to Vercel (11 of 12 — fits Hobby plan as of 2026-04-28)

The routes the iOS client calls today. The weekly XHS pipeline is **archived from the deployed bundle** and runs locally only — see `restaurants-pipeline/run.ts` under § Archived.

| # | Method | Route | Purpose |
|---|---|---|---|
| 1 | `GET` | `/api/restaurants/weekly?city=nyc` | Main discovery feed. Returns `ready` / `building` / `stale` envelope with the weekly restaurant deck. ETag-conditional: returns 304 on `If-None-Match` match. |
| 2 | `POST` | `/api/restaurants/import-xhs` | Parses one XHS post link → multi-restaurant preview (Gemini extraction + Places enrichment). Returns array; iOS picks which to add. |
| 3 | `PATCH` | `/api/restaurants/{id}/unavailable` | Flips `is_available_this_week = 0` after dislike / book / snooze. |
| 4 | `GET` | `/api/locations` | City → borough → neighborhood mapping for the city banner. |
| 5 | `POST` | `/api/user/ensure` | Upserts the device's anonymous user row from the `X-User-Id` header. |
| 6 | `GET` / `POST` | `/api/user/reservations` | List + create user reservations. |
| 7 | `DELETE` | `/api/user/reservations/{id}` | Cancel / delete one reservation (scoped to the caller's `X-User-Id`). |
| 8 | `GET` / `POST` | `/api/user/blocks` | List / add blocked restaurants. Body: `{restaurantId, blockedUntil?}` — `blockedUntil` null = block forever. GET auto-filters expired blocks. |
| 9 | `DELETE` | `/api/user/blocks/{restaurantId}` | Remove a block. |
| 10 | `POST` | `/api/auth/login` | Verifies an Apple / Google identity token via JWKS, upserts the `users` row, migrates any anonymous `user_reservations` + `user_favorites` to the verified id, returns `{userId, displayName, email, emailVerified, provider}`. |
| 11 | `POST` | `/api/feedback` | Sends user feedback to `prompt.and.ship@gmail.com` via Resend. Body: `{message, email?, appVersion?, deviceModel?, iosVersion?}`. `withUser`-wrapped — server uses `users.email` as the `reply_to` fallback when the form-supplied email is empty. Requires `RESEND_API_KEY` env var; optional `FEEDBACK_FROM` (default `WhereToEat <onboarding@resend.dev>`). |

#### Archived (preserved at `backend/api-archive/`, not in deployed bundle)

Restorable by moving back into `backend/api/` and shipping a deploy.

| Path | Why archived |
|---|---|
| `restaurants-pipeline/run.ts` | Weekly XHS pipeline. Times out under Hobby's 60s function cap (full run 5–10 min); we run it locally via `bash scripts/run-pipeline.sh` (`scripts/test-pipeline.ts`) and `npm run push-data` to Neon. To re-activate: move back to `api/restaurants/pipeline/run.ts`, restore the `crons` + `functions.maxDuration` block in `vercel.json`, upgrade to Pro for the 300s cap. |
| `places/enrich.ts` | Direct Places enrichment endpoint — no iOS caller today. |
| `scrape/eater.ts`, `scrape/xiaohongshu.ts` | Per-request scrapers — superseded by the local multi-source ingest. |
| `user/favorites/*` | Favorites endpoints ship but UI uses local storage. |
| `reservations/{resy,opentable,tock}/{search,book}.ts` | Stage 1 booking is browser-based via `SFSafariViewController` — direct-API endpoints aren't called by iOS yet. |
| `stripe/create-payment-intent.ts` | Deposit flow deferred until Stage 2 native booking lands. |

### External APIs

| API | Purpose | Stage 1 | Stage 2 |
|---|---|---|---|
| DeepSeek-V4-Pro (was Gemini 2.5 Flash through 2026-05-01) | LLM extraction + cuisine/feature classification + complaint detection | ✅ Active | ✅ Active (`DEEP_SEEK_API`, base URL `api.deepseek.com`, `thinking: { type: 'disabled' }`) |
| `xhs` CLI | XHS scraping (subprocess) | ✅ Local default | ⚠️ Fallback only (HTTP scraper preferred on Vercel) |
| Custom XHS HTTP scraper | SSR `__INITIAL_STATE__` parse + cookie auth | ✅ Fallback | ✅ Default on Vercel — see `xhsScraper.ts::searchViaHttp / readNoteViaHttp` |
| Google Places API | Enrichment: name, photos, hours | ✅ Active | ✅ Active (`GOOGLE_PLACES_API_KEY`) |
| Yelp Fusion API | Discovery + reviews | 🔑 Key needed | ✅ Active (`YELP_API_KEY`) |
| `SFSafariViewController` | In-app browser for booking | ✅ Active | ✅ Active |
| Gemini Vision | Screenshot analysis for booking confirmation | ✅ Active | ✅ Active |
| Eater | Discovery via RSS + scrape | ✅ Active | ✅ Active |
| Neon Postgres | Cloud DB | — | ✅ Provisioned via Vercel Marketplace |
| Vercel Blob | Restaurant photo hosting (public store) | — | ✅ Provisioned (`restaurant_photos_public`) |

---

## Full Data Model

```swift
// User
UserProfile
  - dietaryPreferences: [DietaryTag]   // set once
  - defaultPartySize: Int
  - locationOverride: City?            // nil = device location

// Location
DailyLocation
  - date: Date
  - coordinates: CLLocationCoordinate2D
  - resolvedCity: String

// Restaurant (unified — all sources use this schema)
Restaurant
  - id: UUID                          // mandatory
  - restaurantName: String            // mandatory
  - googleMapsLink: URL               // mandatory — backbone for photos + booking
  - googlePlaceId: String?            // resolved from googleMapsLink
  - googlePhotoUrl: URL?              // from Places API; primary photo everywhere in app
  - address: String?
  - coordinates: CLLocationCoordinate2D?
  - cuisineType: String?
  - dietaryTags: [DietaryTag]
  - priceRange: 1...4?
  - rating: Double?
  - bookingUrl: URL?                  // Places API websiteUri; no dedicated reservation deep-link exists
  - hours: [DayHours]?
  - reviewSnippets: [Review]
  - sourceOrigin: xhs | yelp | eater | custom
  - xhsRecommendation: String?        // creator's words as-is (Chinese or English); XHS-sourced only
  - yelpId: String?                   // Yelp business ID; populated when added via Yelp URL
  - yelpRating: Double?               // populated when added via Yelp URL
  - yelpReviewCount: Int?             // populated when added via Yelp URL
  - yelpPrice: String?                // "$" / "$$" / "$$$" / "$$$$"; populated when added via Yelp URL
  - phone: String?                    // from Yelp or Google Places
  - notes: String?                    // user's personal notes
  - snoozedUntil: Date?               // set by "Skip for 1 month"
  - addedAt: Date
  - enrichedAt: Date?

Review
  - platform: google | yelp | xiaohongshu
  - text: String
  - rating: Double?
  - date: Date?

// Weekly session
WeeklySession
  - weekOf: Date                       // Monday date
  - cuisinePreferences: [CuisineTag]   // set this week
  - status: pending | inProgress | completed | skipped
  - triggersSent: [Date]
  - swipedCards: [SwipeRecord]
  - reservations: [Reservation]

SwipeRecord
  - restaurantId: UUID
  - decision: liked | disliked | skipped | blocked
  - blockedUntil: Date?                // set when decision == .blocked
  - timestamp: Date

// Reservation (stored on-device in WeeklySession; mirrored to user_reservations on the backend)
Reservation
  - id: UUID
  - restaurantId: UUID
  - restaurantName: String
  - restaurantPhotoUrl: URL?
  - datetime: Date
  - partySize: Int
  - confirmationCode: String            // "—" when the user completed booking in-browser
  - platform: resy | opentable | tock | other
  - depositAmount: Decimal?             // deferred until Stage 2 deposit flow
  - depositPaid: Bool
  - stripePaymentIntentId: String?      // deferred
  - reminderNotificationId: String?
  - calendarEventId: String?
  - status: confirmed | cancelled | pending
  - createdAt: Date

// Anonymous user id (device-scoped UUID). Server-side row mirrors this plus counters.
AnonymousUser
  - id: UUID                            // Keychain, service="com.wheretoeat.identity"
  - displayName: String?                // unused until auth ships

// Favorite (storage endpoints wired; UI deferred until auth ships)
UserFavorite
  - userId: String
  - restaurantId: UUID
  - savedAt: Date
```

---

<!-- Phased Rollout section removed — historical planning. Current work lives in TASKS.md. -->



## Weekly endpoint states

`GET /api/restaurants/weekly?city=nyc` returns one of three states. The iOS client chooses its UI from the envelope.

| State | When | Client behavior |
|---|---|---|
| `ready` | `pipeline_runs.status = 'completed'` within the last 7 days | Render the card deck immediately. |
| `building` | A `running` run exists, or no run yet + one was just fired async | Show loading banner; poll every 30s until `ready`. |
| `stale` | Last completed run is > 7 days old; a new async run is fired in the background | Render the old list with a subtle "Refreshing…" banner; the next poll/launch picks up the fresh data. |

Failures: a failing run writes `status = 'failed'` + `error_message`; the endpoint treats it like no run (falls back to stale or building). Manual recovery: `bash backend/scripts/run-pipeline.sh` locally + `npm run push-data` to push to Neon. Within a single week, repeat launches hit the cached run — no re-scraping.

**Pipeline execution model (as of 2026-04-29).** The weekly scrape runs **locally only** — see `XHS pipeline (2026-04-29 model)` above for the full setup. The deployed bundle no longer carries the pipeline route or the cron entry (D22, 2026-04-28). The only XHS-touching code path that runs in prod today is `POST /api/restaurants/import-xhs` (single-link share-sheet flow), which finishes end-to-end in ~17s under the Hobby 60s cap.

---

