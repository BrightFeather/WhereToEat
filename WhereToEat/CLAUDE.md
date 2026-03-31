# WhereToEat — Claude Code Context

## What this app does
iOS app (Swift/SwiftUI, iOS 16+) for picking and booking weekend restaurants. Weekly Monday 6pm trigger prompts the user to swipe Tinder-style through restaurant cards. Swipe right = like/book, swipe left = dislike (resurfaces next week), long-press = block 4 weeks. Supports native reservations via Resy, OpenTable, and Tock with Apple Pay + Stripe for deposits.

## Project structure
```
WhereToEat/
├── App/
│   ├── WhereToEatApp.swift       # Entry point. RootView routes to Onboarding vs Home via @AppStorage("onboarding_complete")
│   └── AppDelegate.swift
├── Models/
│   ├── Restaurant.swift          # Core model. Has cuisineTags, dietaryTags, priceRange, photos, reservationSource, etc.
│   ├── WeeklySession.swift       # Persisted per-week state (swipes, reservations, cuisinePreferences, status)
│   ├── UserProfile.swift         # Persisted user preferences (dietaryPreferences, defaultPartySize, locationOverride)
│   ├── MockData.swift            # 8 hardcoded SF restaurants used while backend is not deployed
│   └── ...other models
├── Networking/
│   ├── APIClient.swift           # URLSession wrapper. Reads API_BASE_URL from Info.plist
│   └── Endpoints.swift           # All backend endpoint definitions
├── Services/
│   ├── DiscoveryService.swift    # Fetches/ranks restaurants. Currently returns MockData.restaurants directly (no backend)
│   ├── LocationService.swift     # CLLocationManager wrapper. Uses delegate bridge pattern (see Swift 6 notes below)
│   ├── NotificationService.swift # Schedules Mon/Tue/Wed 6pm weekly UNCalendarNotificationTrigger
│   ├── ReservationService.swift  # Resy / OpenTable / Tock booking via backend
│   └── PaymentService.swift      # Stripe + Apple Pay for deposits
├── ViewModels/
│   ├── HomeViewModel.swift       # Weekly session state, startDiscovery(), skipThisWeek()
│   ├── DiscoveryViewModel.swift  # Card deck state, swipeLeft/Right/block, loadCards()
│   ├── OnboardingViewModel.swift # Multi-step onboarding flow
│   ├── ReservationViewModel.swift
│   ├── CustomListViewModel.swift
│   └── SettingsViewModel.swift
└── Views/
    ├── Home/HomeView.swift        # TabView with Home + My List tabs
    ├── Discovery/CardDeckView.swift
    ├── Discovery/RestaurantCardView.swift
    ├── Onboarding/OnboardingContainerView.swift
    ├── Reservation/
    ├── CustomList/
    └── Settings/
```

## Backend (not yet deployed)
Vercel serverless TypeScript backend at `/Users/weijchen/Documents/what_to_eat/backend/`.
Holds all API keys server-side. Required env vars:
- `YELP_API_KEY` — Yelp Fusion API
- `GOOGLE_PLACES_API_KEY` — Google Places enrichment
- `RESY_EMAIL` / `RESY_PASSWORD` — reverse-engineered Resy API
- `TOCK_EMAIL` / `TOCK_PASSWORD` — reverse-engineered Tock API
- `STRIPE_SECRET_KEY` — deposit payment intents (optional, only needed for deposit restaurants)
- OpenTable needs no credentials (unauthenticated reverse-engineered API)

## Current state: mock data mode
`DiscoveryService.fetchRestaurants()` returns `MockData.restaurants` directly instead of calling the backend. `enrich()` is a no-op pass-through. To switch to live data, replace those two sections in `DiscoveryService.swift` with the real Yelp/Eater/XHS calls and restore the `enrich()` backend call.

## Key Swift 6 gotchas fixed in this project

**LocationService delegate bridge**: `CLLocationManagerDelegate` requires `NSObject`, but `NSObject` is incompatible with `ObservableObject` synthesis in Swift 6. Fix: split into a private `LocationManagerDelegate: NSObject` bridge that forwards via closures, and a clean `LocationService: ObservableObject` that owns it.

**@MainActor on ObservableObject classes**: Causes synthesis failure in Swift 6. Removed from all Services and ViewModels.

**import SwiftUI in non-View files**: Causes "Ambiguous implicit access level for import" cascade warnings. Never import SwiftUI in ViewModels or Services.

**@StateObject with singletons**: Use plain `let` in `WhereToEatApp`, not `@StateObject`, for singleton services.

**ReservationConfirmView explicit init**: Private stored properties make the synthesized memberwise init private in Swift 6. Added explicit `init(slot:viewModel:)`.

**navigationDestination placement**: Must be inside a `NavigationStack`, not on a `TabView`. Currently placed on `.navigationDestination(isPresented:)` modifier on the `mainTab` content inside the `NavigationStack` in `HomeView`.

## Onboarding completion flow
`OnboardingViewModel.complete()` writes both:
1. `UserProfile` (key `"user_profile"`) for app data
2. `UserDefaults.standard.set(true, forKey: "onboarding_complete")` for the `@AppStorage` binding in `RootView`

`RootView` uses `@AppStorage("onboarding_complete")` — branching on that var (not re-reading UserProfile) is what makes it reactive.

## Build & run
```bash
# Build
xcodebuild -scheme WhereToEat -destination 'platform=iOS Simulator,name=iPhone 17' build

# Or just press Cmd+R in Xcode
```
Xcode project uses directory-based source inclusion — all `.swift` files in the project folder are compiled automatically without needing explicit project file references.
