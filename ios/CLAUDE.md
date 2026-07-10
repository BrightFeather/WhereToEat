# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## iOS — WhereToEat

SwiftUI iOS app. Sources live under `ios/WhereToEat/`; the Xcode project file is **one level up** at `../WhereToEat/WhereToEat.xcodeproj`. Adding a new Swift file means editing both the file system and `project.pbxproj` (PBXBuildFile + PBXFileReference + group child + Sources phase). Use hex-only 24-char IDs in the `5FBAD0*` range; grep before inventing one — linters have re-added colliding IDs in the past.

## Layout

```
ios/WhereToEat/
├── App/             # @main entry, RootView, AppDelegate
├── Models/          # Restaurant, Reservation, WeeklySession, WeeklyRestaurant, etc.
├── Networking/      # APIClient.swift — base URL resolution, X-User-Id header, [API] logging
├── Services/        # AuthService, IdentityService, LocationService, ReservationService,
│                    # SeenService, WeeklyRestaurantService, XhsURLOpener, …
├── ViewModels/      # @MainActor ObservableObjects, one per major view
└── Views/
    ├── Home/        # 4-tab TabView root (HomeView)
    ├── Discovery/   # Pick tab — CardDeckView + RestaurantCardView + RestaurantDetailView
    ├── Find/        # Find tab — map + bottom-panel list (added on feat/find-tab-and-pick)
    ├── Reservation/ # Confirm + success screens for the booking state machine
    ├── Bookings/    # My Bookings (upcoming + past)
    ├── CustomList/  # My List (paste-link import + bookmarked rows)
    ├── Auth/        # LoginView (Apple + guest; Google deprioritised to P2)
    ├── Onboarding/  # WelcomeView (currently bypassed)
    ├── Settings/    # Profile, dietary tags, sources, sign-out
    └── Shared/      # Cross-tab UI primitives
```

## Build & run

iPhone 15 Pro and iPhone 16 simulators are both used regularly:

```bash
xcodebuild -project ../WhereToEat/WhereToEat.xcodeproj \
  -scheme WhereToEat \
  -destination 'platform=iOS Simulator,id=F63B6CF3-D0C0-45DF-A6E0-B884F03A0072' \
  CODE_SIGN_IDENTITY="" CODE_SIGNING_REQUIRED=NO build
```

The fast iteration loop (no Xcode UI):
```bash
xcrun simctl install <UDID> ~/Library/Developer/Xcode/DerivedData/WhereToEat-*/Build/Products/Debug-iphonesimulator/WhereToEat.app
xcrun simctl terminate <UDID> com.weijia.wheretoeat
xcrun simctl launch    <UDID> com.weijia.wheretoeat
xcrun simctl io        <UDID> screenshot /tmp/out.png
```

There is no test target yet — visual validation in the simulator is the current QA loop.

## Release to TestFlight

One-command pipeline at `scripts/ios/testflight.sh` (run from the repo root):

```bash
./scripts/ios/testflight.sh
```

It bumps `CURRENT_PROJECT_VERSION` (build number), archives, exports `.ipa`, validates, and uploads via `xcrun altool`. **Never touches `MARKETING_VERSION`** — that's a deliberate human edit (in `project.pbxproj`).

Required env (auto-loaded from `scripts/ios/.env`, gitignored):
- `ASC_KEY_ID`, `ASC_ISSUER_ID` — App Store Connect API key
- `~/.appstoreconnect/private_keys/AuthKey_${ASC_KEY_ID}.p8` (the matching `.p8`, chmod 600)

The export step passes `-authenticationKeyPath` / `-authenticationKeyID` / `-authenticationKeyIssuerID` directly so it works without a logged-in Apple ID in Xcode (the cached Xcode-Token expires silently every few weeks). Don't drop those flags.

**If a step fails after the build-number bump,** re-run only the failed step (export or upload) manually — re-running the whole script burns another (skipped) build number on ASC. See `~/.claude/projects/.../memory/project_testflight_pipeline.md` for the failure recipes.

## Architecture — load-bearing flows

### App entry → Home

`@main → WhereToEatApp` → `RootView` → `HomeView`. `HomeView` is a `TabView` with **four tabs** (tag 0 Home, 1 Pick, 2 Find, 3 My List). The Pick tab's `DiscoveryViewModel` is lifted onto `HomeView` as an `@StateObject` so deck position and filters survive tab switches. Tab switching is also driven by NotificationCenter buses: `.switchToPick`, `.switchToFind`, `.switchToMyList`. Listening side does `selectedTab = N`.

### Weekly data cache

`WeeklyRestaurantService` is the single source of truth for the weekly deck. Home, Discovery, and Find all subscribe to its `$status` publisher rather than fetching independently — so opening Find never kicks a duplicate fetch. New views consuming the deck must wire through this service, not `APIClient` directly.

### Multi-source restaurant model

`xhs_sources` rows are polymorphic over `source_type` ∈ { `xiaohongshu`, `eater`, `resy_blog`, … }. The iOS model is `XHSSource` (legacy name; can carry any source). `resolvedType` defaults to `xiaohongshu` for older cached rows. Render via `displayPlatform` (`小红书` / `Eater` / `Resy`) and badge color in `SourceQuoteCard`. Cross-source header copy in `RestaurantDetailView.sourcesHeaderLabel` and `RestaurantCardView.sourceAccentLabel` follows: ≥2 source types → `Mentioned on A and B` (joins arbitrary count with `, … and …`); only 小红书 with count ≥2 → `Mentioned N times on 小红书`; one non-XHS only → `Featured in <name>`. Add new source types in *both* `displayLabel(for:)` switches.

### Restaurant detail = unified browse + booking

`RestaurantDetailView` is presented from Home picks, Discovery card tap, Discovery swipe-right, My List rows, and Find rows. It owns its own booking state machine: `effectiveBookingUrl` opens in `SafariPresenter` (UIKit-direct, not SwiftUI sheet) → `ConfirmBookingForm` (sheet) → `ReservationSuccessView` (full-screen cover). Don't route the deck's `onLike` back through `DiscoveryViewModel.swipeRight()` from here — that path used to swap layouts mid-flow. The completed reservation is the canonical "liked" signal.

The bottom CTA is gated on `reservationSource != nil` (Resy / OpenTable / Tock). Restaurants without a reservation platform get **no** Book / "Go to Website" button — bookmark + website-globe icon in the header are the only outbound actions.

### Find tab specifics

`FindView` builds a full-bleed `Map` (`pointsOfInterest: .excludingAll`) over which a draggable bottom panel lives. The bottom panel is **deliberately not** a `.sheet` — a permanent `.sheet(isPresented: .constant(true))` would (a) cover the iOS 26 floating tab bar and (b) block the detail-view `.sheet(item:)` from ever firing. Instead it's an in-ZStack overlay; row taps hand off to `presentedRestaurant`, which `.sheet(item:)` opens.

The panel's `.background(Color.homeBgMid)` is followed by a **second** `.background` with `.ignoresSafeArea(.container, edges: .bottom)` — without it, the iOS 26 floating tab bar shows the map terrain around its capsule because the safe-area inset isn't filled.

Mappable filter: rows without `latitude`/`longitude` (typically those that never matched a Google Place) are dropped from `mappable` but kept in `filtered`. The "no map locations" banner shows only when `filtered.count > 0 && mappable.isEmpty`.

### Auth gating

`AuthService.signedIn` drives whether `LoginView` is presented. Today: **Apple Sign-In code + backend ship**, but the entitlement is commented out in `WhereToEat.entitlements` until the Developer Portal capability is enabled. **Google Sign-In is deprioritised to P2** — `googleButton` and `runGoogleSignIn` stay in `LoginView.swift` (unreferenced) so re-enabling is a one-line uncomment. Until either ships, every device gets a Keychain UUID via `IdentityService`, attached as `X-User-Id` on every backend request.

### APIClient base URL resolution order

1. `dev_api_base_url` UserDefaults key (in-app override for testing)
2. `API_BASE_URL` Info.plist key
3. `https://wheretoeat-red.vercel.app` (default)

Localhost is **never** the default — a physical iPhone's loopback can't reach the Mac. Every request adds `X-User-Id`; signed-in users add `Authorization: Bearer <token>`.

## Conventions

- **API calls go through `APIClient` only.** It logs `[API] →` / `[API] ←` / `[API] ✗` — keep those when editing.
- **ViewModels are `@MainActor`** and own all state for their view; views stay declarative.
- **Restaurants always carry the three mandatory fields** from SPEC: `id`, `restaurantName`, `googleMapsLink`. Photos always come from Google Places — never Yelp / XHS images.
- **`LocationService` uses `WhenInUse`** (not Always) and re-kicks `startMonitoring()` from `init` if already authorized — fixes silent failure on relaunch.
- **For complex `switch` in views, extract into a `@ViewBuilder private var`** to avoid Swift compiler crashes — this has bitten us in `AvailabilityView`.
- **NotificationCenter buses for cross-tab signaling**: `.switchToPick`, `.switchToFind`, `.switchToMyList`, `.userProfileUpdated`, `.weeklySessionUpdated`. Prefer these over reaching into other tabs' view models.
- **Tap-to-Xiaohongshu**: use `XhsURLOpener.open(url)` — extracts a 24-hex `noteId`, tries `xhsdiscover://item/{noteId}`, falls back to HTTPS. No `LSApplicationQueriesSchemes` needed.

## Project settings already in place — don't change without reason

- `SDKROOT = iphoneos`, `TARGETED_DEVICE_FAMILY = "1,2"`, `IPHONEOS_DEPLOYMENT_TARGET = 17.0`
- `SWIFT_INSTALL_OBJC_HEADER = NO` (silences a build warning)
- Location usage strings set via `INFOPLIST_KEY_NSLocation*` build settings (no separate Info.plist)
- `WhereToEat.entitlements` has macOS sandbox keys cleared; `applesignin` is commented until the Developer Portal capability is flipped on

## Common gotchas

- **Simulator has no GPS by default** → **Features → Location → Apple** in simulator menu before assuming Discovery / Home is broken.
- **`.navigationDestination(...)` must be inside the `NavigationStack` it applies to** — placing it on the wrong tab silently breaks navigation.
- **`private let` properties in a struct make the synthesized initializer private** — if you add one and the parent breaks, write an explicit `init`.
- **Two installed app bundles**: if launching shows the iOS Home Screen, check `xcrun simctl listapps`. Stale `weijia.WhereToEat` from earlier scaffolding may still be installed alongside `com.weijia.wheretoeat`; uninstall the stale id.
- **Don't re-apply scaffolding fixes**: the project moved from a macOS scaffold to iOS targeting; those fixes are settled. Diagnose first if a build breaks.
- **SourceKit transient errors are normal** during fast Edit cycles ("Cannot find type Restaurant in scope") — trust `BUILD SUCCEEDED` from `xcodebuild`, not the editor diagnostic banner.

## Cross-references

Higher-level rules live up the tree:
- `../CLAUDE.md` — repo-level house rules (docs sync, edit-on-ask only, function count caveats)
- `../SPEC.md` — full product spec, single source of truth for screens + data model
- `../TASKS.md` — active work queue (P-numbered priorities, recently-shipped log)
- `../backend/CLAUDE.md` — backend-side conventions for endpoints we call
