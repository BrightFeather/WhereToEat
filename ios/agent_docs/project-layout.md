# iOS Project Layout

The Xcode project file is **one level up** from the Swift sources:

```
WhereToEat/                         ← Xcode project lives here
├── WhereToEat.xcodeproj
└── WhereToEat/                     ← target wrapper (entitlements, Info plist keys)
    └── WhereToEat.entitlements

ios/WhereToEat/                     ← Swift sources (this is where new files go)
├── App/
├── Models/
├── Networking/
├── Services/
├── ViewModels/
└── Views/
```

Adding a Swift file means editing both the file system and `project.pbxproj` (PBXBuildFile + PBXFileReference + group child + Sources phase) using hex-only 24-char IDs in the `5FBAD0*` range.

## `App/`

- `App/WhereToEatApp.swift` — `@main` entry. Boots services, presents `RootView`.
- `App/AppDelegate.swift` — UIKit hookups (push notifications, Apple sign-in delegate hooks).

## `Models/`

Plain Swift structs, all `Codable + Equatable`.

- `Restaurant.swift` — primary client model (`:49`). `SourceOrigin` enum at `:24`. `Coordinates`/`DayHours` helpers above.
- `Reservation.swift` — booking model (`:19`); `ReservationStatus` enum at `:3`; `TimeSlot` at `:9`.
- `WeeklySession.swift` — per-Monday session bucket (`:10`); `mondayOf(date:)` helper at `:29`.
- `WeeklyRestaurant.swift` — API mirror of `backend/api/restaurants/weekly.ts:23` for the deck.
- `SwipeRecord.swift` — Discovery swipe history.
- `SourceLink.swift` — multi-source link rendering DTO.
- `CuisineTag.swift`, `DietaryTag.swift` — tag enums for filters and onboarding.
- `Review.swift` — review DTO (used by detail view).
- `UserProfile.swift` — settings preferences (default party size, show-only-reservable, dietary tags).
- `ReservationSource.swift` — Resy / OpenTable / Tock platform enum.
- `CityRegions.swift` — DTO for `/api/locations`.
- `CoreData/` — legacy CoreData stack (`PersistenceController` in Services). Most state is `UserDefaults`.

## `Networking/`

- `APIClient.swift` (`:30`) — singleton; base URL resolution at `:49-57`; `request(_:as:)` at `:60`; `X-User-Id` injection at `:71`. Standard envelope decoded as `APIResponse<T>` at `:23`.
- `Endpoints.swift` (`:3-115`) — all endpoint cases, paths, methods, query items, request bodies.

## `Services/`

`@MainActor`-where-relevant; long-lived state owners. All API calls funnel through `APIClient`.

- `IdentityService.swift` — Keychain UUID provider (`com.wheretoeat.identity`), the source of `X-User-Id`.
- `AuthService.swift` — Apple/Google sign-in flow + `signedIn` publisher driving login gate.
- `WeeklyRestaurantService.swift` — single source of truth for the weekly deck (`:11`); `fetch(city:)` at `:21`. Polls when `stale`/`building`.
- `DiscoveryService.swift` — combines weekly + custom-list rows for the Pick deck.
- `ReservationService.swift` — booking persistence, calendar/reminder sync.
- `LocationService.swift` — `WhenInUse` Core Location wrapper; re-kicks `startMonitoring()` from init.
- `SeenService.swift` — local "seen today" set.
- `NotificationService.swift` — `UNUserNotification` for T-24h booking reminders.
- `CityRegionsService.swift` — caches `/api/locations` response.
- `XhsURLOpener.swift` + `XHSURLParser.swift` — open `xhsdiscover://item/{noteId}` with HTTPS fallback.
- `CustomListImportService.swift` — paste-link → Restaurant draft.
- `GoogleSignInIntegration.swift` — stub awaiting GCP iOS OAuth client + `GoogleSignIn-iOS` SPM package.
- `PaymentService.swift` — Stripe stub (deferred).
- `PersistenceController.swift` — CoreData stack (legacy / minimal use).

## `ViewModels/`

`@MainActor` `ObservableObject`s; one per major view.

- `HomeViewModel.swift` — Home tab state (greeting, picks, stats).
- `DiscoveryViewModel.swift` — Pick tab deck position, filters, swipe recording.
- `FindViewModel.swift` — Find tab map state, filter chips, panel selection.
- `CustomListViewModel.swift` — My List CRUD, idempotent add.
- `ReservationViewModel.swift` — booking state machine driver (Safari → Confirm → Success).
- `SettingsViewModel.swift` — user preference editing.
- `OnboardingViewModel.swift` — initial dietary + city selection (currently bypassed).

## `Views/`

- `Home/` — `HomeView.swift` (`:11`) is the 4-tab `TabView` root: 0 Home, 1 Pick, 2 Find, 3 My List. `WeeklyCuisinePromptView.swift` for the cuisine prompt sheet.
- `Discovery/` — `CardDeckView.swift`, `RestaurantCardView.swift`, `RestaurantDetailView.swift` (the unified browse + booking surface).
- `Find/` — `FindView.swift` (full-bleed Map + draggable bottom panel), `FindRestaurantRowView.swift`.
- `Reservation/` — `AvailabilityView.swift`, `ReservationConfirmView.swift`, `ReservationSuccessView.swift`.
- `Bookings/` — `BookingsListView.swift` (Upcoming / Past sections + leading-Cancel + trailing-Save-to-list swipes).
- `CustomList/` — `CustomListView.swift`, `AddRestaurantView.swift`, `ImportPreviewView.swift`, `XHSImportPreviewView.swift`.
- `Auth/` — `LoginView.swift`. Apple shipped pending entitlement; Google deprioritised (P2).
- `Onboarding/` — `OnboardingContainerView.swift`, `WelcomeView.swift` (currently bypassed).
- `Settings/` — `SettingsView.swift`, `CityOverrideView.swift`.
- `Shared/` — `PhotoCarouselView.swift`, `PlatformBadgeView.swift`, `TagChipView.swift`.

## Cross-tab signaling

NotificationCenter buses (avoid reaching into other tabs' VMs): `.switchToPick`, `.switchToFind`, `.switchToMyList`, `.userProfileUpdated`, `.weeklySessionUpdated`. See `ios/CLAUDE.md` for the convention.
