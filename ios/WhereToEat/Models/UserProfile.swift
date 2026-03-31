import Foundation

struct City: Codable, Equatable {
    var name: String        // e.g. "New York, NY"
    var latitude: Double
    var longitude: Double
}

struct UserProfile: Codable {
    var dietaryPreferences: [DietaryTag]
    var defaultPartySize: Int
    var locationOverride: City?
    var onboardingComplete: Bool

    static let defaultProfile = UserProfile(
        dietaryPreferences: [.noRestrictions],
        defaultPartySize: 2,
        locationOverride: nil,
        onboardingComplete: false
    )

    // Persistence via UserDefaults
    private static let key = "user_profile"

    static func load() -> UserProfile {
        guard let data = UserDefaults.standard.data(forKey: key),
              let profile = try? JSONDecoder().decode(UserProfile.self, from: data) else {
            return defaultProfile
        }
        return profile
    }

    func save() {
        guard let data = try? JSONEncoder().encode(self) else { return }
        UserDefaults.standard.set(data, forKey: UserProfile.key)
    }
}
