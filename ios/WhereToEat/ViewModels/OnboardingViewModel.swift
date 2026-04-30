import Foundation
import Combine

enum OnboardingStep: Int, CaseIterable {
    case dietary, partySize, payment, notifications, location
}

final class OnboardingViewModel: ObservableObject {
    @Published var currentStep: OnboardingStep = .dietary
    @Published var selectedDietary: Set<DietaryTag> = [.noRestrictions]
    @Published var partySize: Int = 2
    @Published var notificationsGranted: Bool = false
    @Published var locationGranted: Bool = false

    private let notificationService = NotificationService.shared
    private let locationService = LocationService.shared

    func toggleDietary(_ tag: DietaryTag) {
        if tag == .noRestrictions {
            selectedDietary = [.noRestrictions]
        } else {
            selectedDietary.remove(.noRestrictions)
            if selectedDietary.contains(tag) {
                selectedDietary.remove(tag)
                if selectedDietary.isEmpty { selectedDietary = [.noRestrictions] }
            } else {
                selectedDietary.insert(tag)
            }
        }
    }

    func requestNotifications() async {
        notificationsGranted = await notificationService.requestPermission()
    }

    func requestLocation() {
        locationService.requestPermission()
        locationGranted = true
    }

    func advance() {
        let steps = OnboardingStep.allCases
        guard let idx = steps.firstIndex(of: currentStep), idx + 1 < steps.count else {
            complete()
            return
        }
        currentStep = steps[idx + 1]
    }

    func complete() {
        var profile = UserProfile.load()
        profile.dietaryPreferences = Array(selectedDietary)
        profile.defaultPartySize = partySize
        profile.onboardingComplete = true
        profile.save()
        UserDefaults.standard.set(true, forKey: "onboarding_complete")

        Task {
            await notificationService.scheduleWeeklyTriggers()
        }
    }
}
