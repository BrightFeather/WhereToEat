# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# WhereToEat

Personal restaurant discovery + reservation iOS app with a Vercel serverless backend. Single user (the owner), NYC only for now.

> **Source of truth hierarchy**
> - `SPEC.md` — product spec (full detail, screen-by-screen)
> - `TASKS.md` — active work queue
> - This file — product tour + dev rules (start here)
> - `ios/CLAUDE.md` and `backend/CLAUDE.md` — per-stack guidance
> - `~/.claude/projects/…-WhereToEat/memory/` — cross-session memory (architectural decisions, open workstreams)

## What the app does

Every Monday the backend scrapes Xiaohongshu (`#纽约美食`) for creator-recommended restaurants, enriches each one with Google Places (address, photos, reservation URL) and Resy / OpenTable booking links, and serves the result as a city-scoped weekly deck. The iOS client surfaces this deck three ways: a curated home view, a swipe-to-decide Discovery deck, and a browser-based booking handoff with local reminders.

## Screens

### Home

First surface the user sees on open. Layout reacts to whether there are any upcoming reservations.

- **Headline** — time-of-day aware greeting (`"Good morning" | "Good afternoon" | "Good evening"`) + a subhead that shows the upcoming-reservation count (`"You have N upcoming reservations."` / `"No upcoming reservations yet."`).
- **Upcoming reservations** (when any) — stacked `BookingHeroCard`s sorted soonest-first. Tap → My Bookings. Aggregated across every saved `WeeklySession` bucket, not just the current week.
- **This week's picks** — three curated cards, each with its own selection rule + color label:
  - **TOP PICK** (orange) — highest-ranked restaurant passing the filter set.
  - **NEW THIS WEEK** (green) — highest-ranked with `post_created_at` < 14 days.
  - **HIDDEN GEM** (purple) — mid-ranked (20–60% percentile) with a bookable link; deterministic per day + user id so the slot stays stable through the day and refreshes tomorrow.
- **Single gradient CTA** — `"Swipe through all N picks →"` or `"Swipe through N more picks →"` when bookings exist. Opens Discovery.
- **Stats row** — `🍽 N picks` (tap → Discovery) · `📍 N saved` (tap → My List via `.switchToMyList` bus).
- **Toolbar** — calendar icon (top-right) → My Bookings · gear icon → Settings.

All picks share the Discovery filter set: server-side `user_reservations`, server-side `user_blocked_restaurants`, on-device `SeenService.seenToday()`, local `WeeklySession.swipedCards`. If `UserProfile.showOnlyReservable` is true, non-bookable restaurants are also dropped.

### Discovery

Tinder-style swipe deck over the weekly pool + the user's custom list (custom list always sorts first).

- **Card face** — photo, name, neighborhood, price, cuisine tags, XHS creator quote (tappable to open 小红书 / Xiaohongshu app via `xhsdiscover://item/{noteId}` with Safari fallback).
- **Actions** — swipe right → open the unified detail / booking sheet · swipe left → hide this week · long-press → "Block for 4 weeks" (server + local) · bookmark button → save to My List + mark seen + advance deck.
- **Filter row** — cuisine (alphabetical), borough (canonical NYC list), neighborhood (revealed when a borough is selected, multi-select). "Midtown" in the borough slot is normalized to "Other" — a borough is a borough, not a neighborhood.
- **Deck filter** — built at `loadCards` time from: reserved ∪ blocked ∪ seen-today ∪ local swipe history. A card dropped from the pool won't come back today; reserved/blocked persist cross-device.

### Restaurant detail (unified browse + booking)

Single surface presented from Home picks, Discovery card tap, Discovery swipe-right, or My List row tap. Replaces an older split between a "detail" view and a dedicated pre-browser screen.

- **Content** — photo carousel → name + bookmark → tags → address + 小红书 recommendation (tap to open XHS app) + inline "Open in Google Maps" + map → reviews → sources (non-XHS).
- **Bookmark** (outline → filled yellow) — tap toggles against `CustomListViewModel` + stamps `SeenService.markSeen`. Stays on the page; never dismisses the sheet.
- **Bottom bar** — Pass + Book this one (in swipe context) · single Book this one (standalone). Tapping Book opens SFSafariViewController via `SafariPresenter` (UIKit-direct to avoid SwiftUI modal cascade), then the view's own state machine drives `ConfirmBookingForm` (sheet) → `ReservationSuccessView` (full-screen cover).
- **Top overlay** — X (close) · `…` (Block for 4 weeks, swipe context only).

### Booking flow (Task 2 in SPEC)

Browser-based. No scraping of confirmation pages.

1. User taps Book → `SFSafariViewController` opens at `effectiveBookingUrl` (Resy / OpenTable / website, in that priority).
2. User books on the platform's own site. Safari's Done button triggers `safariViewControllerDidFinish`.
3. `ConfirmBookingForm` sheet appears prefilled with next-Saturday 7:30 PM + user's default party size. User edits and taps Save, or taps "I didn't end up booking" to bail.
4. On save: persist to `WeeklySession`, schedule a T-24h local `UNUserNotification`, write a 2-hour EventKit calendar event, fire-and-forget `POST /api/user/reservations`, broadcast `.weeklySessionUpdated`.
5. `ReservationSuccessView` full-screen cover — spring-scale checkmark + confetti + `"You're all set! for your reservation at {name} on {date}"`. Done dismisses both.

### My List (custom restaurants)

User's own saved restaurants via share-sheet import, paste-a-link, or the Discovery bookmark.

- **Input** — paste a Google Maps / Yelp / Xiaohongshu URL (`POST /api/restaurants/import-xhs` parses XHS posts, returns all mentioned restaurants, user picks which to add).
- **Row** — thumbnail, name, address, source-link badges.
- **Swipe actions** — leading full-swipe → Remove (red) · trailing → Book (opens detail / booking sheet).
- Storage: `UserDefaults`.

### My Bookings

- **Sections** — Upcoming (ascending by datetime) + Past (reversed).
- **Row** — photo, name, day+time, party size, "Cancelled" tag.
- **Swipe right (leading) → Cancel** — confirmation alert → removes from every saved `WeeklySession` bucket, cancels the UNUserNotification reminder, removes the EventKit event, fire-and-forget `DELETE /api/user/reservations/{id}`. Platform-aware copy ("You might still need to cancel on Resy") when the booking lives on a third party. `allowsFullSwipe: false`.
- **Swipe left (trailing) → Save to list** — accent-tinted bookmark action. Builds a minimal `Restaurant` from the reservation (id, name, photo, platform-as-`ReservationSource`) and calls `CustomListViewModel.addFromDiscovery`. Idempotent: re-saving shows "Already in your list", new saves show "Saved to your list". `allowsFullSwipe: true`.

### Settings

- Location override (pin a specific city; off by default).
- Dietary preferences + default party size.
- Show-only-reservable toggle.
- **Account** section — provider + display name when signed in · Sign Out (clears Keychain to a fresh anonymous id + re-enables the login gate) · Sign in button for guests.

### Auth (gated feature — see `TASKS.md § P5/P6`)

- **Apple Sign-In** — iOS code + backend `POST /api/auth/login` + JWKS verification all shipped. Entitlement is commented out in `WhereToEat.entitlements` until the Developer Portal capability is enabled — flipping it on takes one minute in Xcode's Signing & Capabilities tab.
- **Google Sign-In** — `GoogleSignInIntegration.swift` is a stub; needs GCP iOS OAuth client id + `GoogleSignIn-iOS` SPM package + reversed-client-id URL scheme + `GOOGLE_IOS_CLIENT_IDS` Vercel env var, then 3-line `GIDSignIn.sharedInstance.signIn(...)` swap.
- **Anonymous fallback** — until either ships, every device gets a Keychain UUID (`com.wheretoeat.identity`) that's attached as `X-User-Id` on every backend request. The `/api/auth/login` migration will rewrite `user_reservations` + `user_favorites` rows from the anonymous id to the verified subject id on first real sign-in.

## Data model (sketch)

See `SPEC.md § Full Data Model` for the complete schema. The load-bearing tables on the backend:

- `xhs_restaurants` — one row per canonical restaurant. Dedupes via `(city, google_place_id)` so the same id survives across weekly runs and across data sources.
- `xhs_sources` — multi-source attribution table; one row per (restaurant, post_url). `source_type` ∈ `xiaohongshu` / `eater` / `resy_blog`. Unique on `(restaurant_id, post_url)` so backfills are idempotent. Editorial sources (eater/resy_blog) often skip rating/location enrichment — see `scripts/backfill-rating-location.ts`.
- `pipeline_runs` — one row per weekly scrape with `status` / counts.
- `users` — one row per `X-User-Id`; columns cover anonymous + Apple + Google.
- `user_reservations` — mirrors iOS `Reservation`, keyed by `user_id`.
- `user_favorites` — future-facing; endpoints ship, UI not wired to them yet (My List uses local storage).
- `user_blocked_restaurants` — active blocks with a `blocked_until TIMESTAMPTZ` (null = forever).

## Repo layout

```
WhereToEat/
├── SPEC.md                  # Product spec (v3, final)
├── TASKS.md                 # Active task list
├── CLAUDE.md                # This file
├── WhereToEat/              # Xcode project (note: NOT under ios/)
│   ├── WhereToEat.xcodeproj
│   └── WhereToEat/          # App target wrapper, entitlements, Info plist keys
├── ios/WhereToEat/          # Swift source
│   ├── App/                 # @main, RootView, AppDelegate
│   ├── Models/              # Restaurant, Reservation, WeeklySession, etc.
│   ├── Networking/          # APIClient, Endpoints (X-User-Id attached on every request)
│   ├── Services/            # Identity, Auth, Reservation, Seen, XhsURLOpener, ...
│   ├── ViewModels/          # @MainActor ObservableObjects, one per major view
│   └── Views/{Home, Discovery, Reservation, Bookings, Auth, CustomList, Settings, Shared, Onboarding}
└── backend/
    ├── api/                 # Vercel serverless routes
    ├── api/_lib/            # Shared: db (dual SQLite/Neon), logger, withUser, appleAuth, googleAuth, jwtVerify, xhsScraper (HTTP + CLI), placesEnricher, restaurantMerger
    ├── data/                # SQLite file (Stage 1)
    └── scripts/             # migrate, local-server, backfill-*, push-data
```

The split between `WhereToEat/` (Xcode project) and `ios/WhereToEat/` (Swift sources) is intentional — the project file points into `ios/` for sources. Keep new Swift files under `ios/WhereToEat/`.

## Build & run

**iOS** — open `WhereToEat/WhereToEat.xcodeproj` in Xcode and run on an iPhone simulator. From the CLI:

```
xcodebuild -project WhereToEat/WhereToEat.xcodeproj \
  -scheme WhereToEat -destination 'platform=iOS Simulator,name=iPhone 15' \
  CODE_SIGN_IDENTITY="" CODE_SIGNING_REQUIRED=NO build
```

**Backend (local)** — `cd backend && npm run start` runs a hand-rolled Node server at `localhost:3000` that reuses the Vercel handler modules. Use this instead of `vercel dev` unless you need the Vercel routing emulation.

**Backend (prod)** — deployed at `https://wheretoeat-red.vercel.app`. Redeploy with `cd backend && vercel --prod --yes`. Required env vars are in `SPEC.md § Step 9`.

**iOS → backend wiring** — `ios/WhereToEat/Networking/APIClient.swift` resolves in this order: `dev_api_base_url` UserDefaults key → `API_BASE_URL` Info.plist key → `https://wheretoeat-red.vercel.app`. Localhost is not a default — a physical iPhone's loopback can't reach the Mac.

## Data sync (SQLite ↔ Neon)

Local SQLite (`backend/data/wheretoeat.db`) is the working copy; Neon Postgres backs the deployed functions. They're kept in sync **manually**, not automatically:

1. Pipeline / backfill scripts (`scripts/backfill-*.ts`, `scripts/topup-xhs-sources.ts`) write to local SQLite.
2. `npx ts-node scripts/_sync-fields-to-neon.ts` does explicit per-row `UPDATE`s on Neon for the new-column fields and re-pushes `xhs_sources`. The cousin `npm run push-data` uses `ON CONFLICT DO NOTHING` and **cannot update existing rows** — use the sync script for any backfill that touches columns already present.
3. Schema drift can happen in either direction. Neon has had `latitude`/`longitude` longer than SQLite did; new scripts that need columns absent locally should `ALTER TABLE … ADD COLUMN IF NOT EXISTS` before reading. Keep `scripts/migrate.ts` in lock-step.

## House rules

- **After every iOS update, release to TestFlight before ending the turn — but bundle the whole turn into ONE build, not one per edit.** Run `./scripts/ios/testflight.sh` from the repo root, exactly once, after the last iOS edit of the turn. If the user sends a follow-up message with more iOS work mid-turn (via the "user sent a new message while you were working" interrupt), keep editing — defer the release until after that new message is also addressed. Each `testflight.sh` run burns a build number on App Store Connect (numbers are append-only), so three releases in a row for three sequential edits in the same turn waste two slots. The script auto-bumps `CURRENT_PROJECT_VERSION` (build number) by 1 and uploads via App Store Connect API key — that's the desired behavior. **Never bump `MARKETING_VERSION`** as part of this; the script enforces this with a before/after snapshot and aborts if the marketing version changes. If a release step fails after the build-number bump, re-run only the failed step manually so the next attempt doesn't burn another build slot — see `~/.claude/projects/.../memory/project_testflight_pipeline.md`.
- **After finishing any task, update `TASKS.md` and `SPEC.md` before ending the turn — no exceptions.** This is a hard rule, not a guideline:
  - `TASKS.md` — flip the completed task to ✅ Done with a 1-3 line note (what shipped, where, any caveats). Add new TODOs / follow-ups that surfaced during the work (including items the user explicitly asked to defer) with enough context that they're actionable without replaying the conversation. If you skipped or partially completed something, say so explicitly in the entry.
  - `SPEC.md` — if the task changed any user-visible behavior, data shape, endpoint, or screen, update the relevant section in the same turn. `SPEC.md` is the product spec, not a snapshot — stale copy there is worse than no copy. Over-document rather than let it drift.
  - This applies to code edits, doc edits, schema migrations, ingest runs, and infra/env changes alike. "Finished" includes deferred or aborted work — record what was attempted and why it stopped.
  - If a task touched memory worth keeping cross-session, also update `~/.claude/projects/-Users-chenweijia-Documents-code-WhereToEat/memory/`.
- **Edits** — only change code when explicitly asked. For planning / spec work, edit markdown (`SPEC.md`, `TASKS.md`, `CLAUDE.md`) — don't touch Swift or TypeScript without an explicit ask.
- **iOS build fixes** — don't re-apply fixes that are already in place (the project moved from a macOS scaffold to iOS targeting; those fixes are settled). If a build breaks, diagnose first.
- **Simulator has no GPS** by default. If Discovery returns nothing in the simulator, set **Features → Location → Apple** in the simulator menu before assuming a code bug.
- **`xhs` CLI** is installed and authenticated on this machine. If it errors with auth, ask the user to re-login rather than trying to fix it in code.
- **XHS on Vercel** — the CLI is NOT installed in the Vercel runtime; the HTTP fallback in `xhsScraper.ts` (`readNoteViaHttp`, `searchViaHttp`) parses `window.__INITIAL_STATE__` and requires session cookies in env (`XHS_WEB_SESSION` / `XHS_A1` / `XHS_WEBID`). See memory `project_xhs_vercel_auth.md`.
- **LLM parser is DeepSeek-V4-Pro** (was Gemini 2.5 Flash). Reuses the `DEEP_SEEK_API` secret from `feedback-agent` (file at `~/.config/wte-feedback-agent/secrets.env`). Implementation in `backend/api/_lib/deepseek.ts` + `llmExtractor.ts`; override model with `DEEPSEEK_MODEL` env var. Always pass `thinking: { type: 'disabled' }` (V4 default-on thinking eats `max_tokens`).
- **Drop on any complaint when ingesting XHS posts.** The DeepSeek extractor + standalone `classifyComplaint()` are aggressive: any criticism, lukewarm endorsement ("just okay", "fine"), mixed review, or "X not as good as Y" (where X is the target) → drop. Pure positive only is kept. Failure mode is fail-closed (errors → drop). Backfill via `npm run scrub-negative`; topup via `npm run topup-asian`. See `backend/CLAUDE.md § LLM parser` for the full filter spec.
- **Xcode project IDs** — when adding a new Swift file, pick hex-only 24-char IDs that don't collide with existing ones under `5FBAD0*`. Linters have re-added colliding entries for `XHSURLParser.swift`; grep the pbxproj before inventing IDs.
- **Function count on Vercel** — the Hobby plan caps at 12 routes. The deployed bundle currently sits at the cap; `auth/login`, `scrape/eater`, `scrape/xiaohongshu`, `places/enrich`, `stripe/create-payment-intent`, and the `reservations/{resy,opentable,tock}` handlers are parked under `backend/api-archive/`. Adding any new `api/*.ts` route means archiving an existing one or moving the project to Pro.
