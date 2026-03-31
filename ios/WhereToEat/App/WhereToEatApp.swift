import SwiftUI

@main
struct WhereToEatApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) var appDelegate

    private let persistence = PersistenceController.shared
    private let locationService = LocationService.shared
    private let notificationService = NotificationService.shared

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
    @AppStorage("onboarding_complete") private var onboardingComplete: Bool = false

    var body: some View {
        if UserProfile.load().onboardingComplete {
            HomeView()
        } else {
            OnboardingContainerView()
        }
    }
}
