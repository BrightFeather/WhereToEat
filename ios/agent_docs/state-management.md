# iOS State Management

SwiftUI + `@MainActor ObservableObject` ViewModels. State is owned by services + view models; views stay declarative. No Redux / TCA / Combine framework.

## Models

Plain `Codable + Equatable` structs under `ios/WhereToEat/Models/`. The load-bearing ones:

- `Restaurant` — `Models/Restaurant.swift:49`. Mandatory fields per SPEC: `id`, `name`, `googleMapsLink`. Photos always come from Google Places.
- `Reservation` — `Models/Reservation.swift:19`. Carries `calendarEventId` + `reminderNotificationId` so cancel can clean up both.
- `WeeklySession` — `Models/WeeklySession.swift:10`. One per Monday-of-week, persisted to `UserDefaults`. `mondayOf(date:)` helper at `:29`. `recordSwipe(_:)` at `:53`.
- `WeeklyRestaurant` — API mirror used by the deck.
- `SwipeRecord` — like / dislike history.

## Services (long-lived state owners)

Singletons or `@StateObject`s that outlive any one view. All are `@MainActor` where they touch `@Published` state.

- `WeeklyRestaurantService.shared` — `Services/WeeklyRestaurantService.swift:11`. Single source of truth for the deck. Home, Pick, Find all subscribe to its `$status` publisher rather than hitting `APIClient` independently. Status enum at `:3-8` (`ready` / `stale` / `building` / `error`). `fetch(city:)` at `:21`; polls when stale.
- `IdentityService.shared` — Keychain UUID provider; produces `userId` for `X-User-Id`.
- `AuthService.shared` — Apple/Google sign-in flow + `@Published var signedIn` driving the `LoginView` gate.
- `LocationService` — `WhenInUse` Core Location wrapper; injected via `@EnvironmentObject` from `WhereToEatApp`. Re-kicks `startMonitoring()` from `init` if already authorized (silent-failure-on-relaunch fix).
- `SeenService` — Discovery deck deduplication: `seenToday()` set + `markSeen(id:)`. State persists in `UserDefaults` keyed by date.
- `ReservationService` — `user_reservations` round-tripping + EventKit + `UNUserNotificationCenter`.
- `NotificationService` — schedules T-24h booking reminders.
- `CityRegionsService` — caches `/api/locations` per city.
- `CustomListImportService` — converts a pasted XHS / Maps / Yelp link to a `Restaurant` draft.
- `PersistenceController` — CoreData stack (legacy / minimal use).

## ViewModels

`@MainActor final class … : ObservableObject`. One per major screen, owned via `@StateObject` at the screen's root and forwarded down via `@ObservedObject` or `@EnvironmentObject` (for `CustomListViewModel`). Convention: views stay structural; VMs hold all `@Published` state and run all async work.

- `HomeViewModel` — picks-of-the-week (TOP PICK / NEW THIS WEEK / HIDDEN GEM), upcoming reservation count, "swipe through N picks" CTA copy.
- `DiscoveryViewModel` — Pick-tab deck. Lifted onto `HomeView` as an `@StateObject` (`Views/Home/HomeView.swift:14, :22-24`) so deck position survives tab switches.
- `FindViewModel` — Find-tab map state, filter chips, `mappable` vs `filtered` (rows without lat/lng are dropped from `mappable` only).
- `CustomListViewModel` — My List CRUD + idempotent `addFromDiscovery`. Lifted onto `HomeView`.
- `ReservationViewModel` — booking state machine: `effectiveBookingUrl` → `SafariPresenter` → `ConfirmBookingForm` (sheet) → `ReservationSuccessView` (full-screen cover).
- `SettingsViewModel`, `OnboardingViewModel` — straightforward `@Published` field bindings.

## Cross-tab signaling

NotificationCenter buses (don't reach into other tabs' VMs):

- `.switchToPick`, `.switchToFind`, `.switchToMyList` — selected-tab driver.
- `.weeklySessionUpdated` — emitted on reservation save / cancel.
- `.userProfileUpdated` — emitted from Settings.

`HomeView` listens via `.onReceive(NotificationCenter.default.publisher(for:))` and updates `selectedTab`.

## Persistence layers

| Layer | What lives here |
|---|---|
| `UserDefaults` | `WeeklySession` history, dietary tags, default party size, custom list, `dev_api_base_url`, seen-today. |
| Keychain (`com.wheretoeat.identity`) | Anonymous user UUID — survives reinstalls. |
| Backend (Neon via API) | `user_reservations`, `user_blocks`. Mirrored locally in `WeeklySession.reservations` for offline UI. |
| EventKit | 2-hour calendar event per booking. |
| `UNUserNotificationCenter` | T-24h booking reminders. |

## Conventions

- **API calls go through `APIClient` only.** It logs `[API] →` / `[API] ←` / `[API] ✗`.
- **VMs are `@MainActor`** and hold `@Published` state.
- **For complex `switch` in views**, extract into a `@ViewBuilder private var` to dodge Swift compiler crashes (bit us in `AvailabilityView`).
- **`private let` properties make the synthesized init private** — write an explicit `init` if a parent constructor breaks.
- **Trust `BUILD SUCCEEDED`**, not SourceKit transient errors during fast Edit cycles.
