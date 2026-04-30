import SwiftUI

extension Notification.Name {
    static let saveRestaurant = Notification.Name("saveRestaurant")
    static let switchToMyList = Notification.Name("switchToMyList")
    /// Fired by Home pills / CTAs that want to jump the user into the Pick
    /// (Discovery) tab without driving a NavigationStack push.
    static let switchToPick = Notification.Name("switchToPick")
    /// Mirror of `switchToPick` for the Find map tab — used by Home's
    /// "Find another restaurant" surface when we want to send the user to
    /// the map instead of the swipe deck.
    static let switchToFind = Notification.Name("switchToFind")
    static let snoozeRestaurant = Notification.Name("snoozeRestaurant")
    static let userProfileUpdated = Notification.Name("userProfileUpdated")
}

@main
struct WhereToEatApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) var appDelegate

    private let persistence = PersistenceController.shared
    private let locationService = LocationService.shared
    private let notificationService = NotificationService.shared

    init() {
        // Disk-backed image cache for AsyncImage. See `Networking/ImageCache.swift`
        // and `DESIGN-CACHING.md` § Image caching for sizing rationale.
        ImageCache.install()
        // Register Fraunces (variable serif) so headlines / restaurant names
        // can use `Font.fraunces(...)`.
        AppFonts.register()
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(\.managedObjectContext, persistence.context)
                .environmentObject(locationService)
                .environmentObject(notificationService)
        }
    }
}

struct RootView: View {
    @AppStorage("has_seen_welcome")    private var hasSeenWelcome: Bool = false
    @AppStorage("auth_gate_dismissed") private var authGateDismissed: Bool = false
    @StateObject private var auth = AuthService.shared

    /// Gate order:
    ///   1. Welcome — shown once on first launch (`has_seen_welcome`).
    ///   2. Login — unless the user signed in previously or explicitly chose
    ///      "Continue as guest" (flag sticks so they aren't re-prompted).
    ///   3. Home.
    ///
    /// Multi-page onboarding (party size / dietary prefs) is intentionally
    /// skipped — new users see the Welcome screen, then land on Home.
    /// `UserProfile.load()` supplies sane defaults (party size 2, no dietary
    /// restrictions) that surface in the `ConfirmBookingForm` stepper. The
    /// user can change them later in Settings. `OnboardingContainerView` is
    /// kept in the project so the old multi-page flow can be re-enabled by
    /// restoring an `@AppStorage("onboarding_complete")` gate here.
    var body: some View {
        Group {
            if !hasSeenWelcome {
                WelcomeView(onContinue: {
                    withAnimation(.easeInOut(duration: 0.35)) {
                        hasSeenWelcome = true
                    }
                })
                .transition(.opacity.combined(with: .scale(scale: 1.02)))
            } else if !isAuthenticated && !authGateDismissed {
                LoginView(onContinueAsGuest: { authGateDismissed = true })
            } else {
                HomeView()
            }
        }
        .task {
            _ = IdentityService.shared.userId
            await ReservationService.shared.syncFromServer()
        }
    }

    private var isAuthenticated: Bool {
        if case .authenticated = auth.state { return true }
        return false
    }
}
