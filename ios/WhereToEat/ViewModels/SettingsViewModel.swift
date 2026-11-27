import Foundation
import Combine

final class SettingsViewModel: ObservableObject {
    @Published var profile: UserProfile

    init() {
        self.profile = UserProfile.load()
    }

    func saveProfile() {
        profile.save()
    }

    func clearCityOverride() {
        profile.locationOverride = nil
        saveProfile()
    }
}
