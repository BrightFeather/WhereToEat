import Foundation

struct City: Codable, Equatable {
    var name: String        // e.g. "New York, NY"
    var latitude: Double
    var longitude: Double
}

/// Recommendation source the user wants to see in the home / discovery feed.
///
/// Stored as raw strings (matching `xhs_sources.source_type`) so the registry
/// can grow without a model migration — adding e.g. `"infatuation"` is a
/// one-line change in the backend pipeline.
enum DiscoverySource: String, CaseIterable, Identifiable, Codable {
    case xiaohongshu = "xiaohongshu"
    case eater       = "eater"
    case resyBlog    = "resy_blog"

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .xiaohongshu: return "小红书 (Xiaohongshu)"
        case .eater:       return "Eater"
        case .resyBlog:    return "Resy"
        }
    }

    var shortName: String {
        switch self {
        case .xiaohongshu: return "小红书"
        case .eater:       return "Eater"
        case .resyBlog:    return "Resy"
        }
    }
}

struct UserProfile: Codable {
    var dietaryPreferences: [DietaryTag]
    var defaultPartySize: Int
    var locationOverride: City?
    var onboardingComplete: Bool
    /// When true, only restaurants bookable via Resy/OpenTable show up in the feed.
    /// When false, unreservable restaurants appear too and their card CTA becomes
    /// "Go to Website" instead of "Book on …".
    var showOnlyReservable: Bool
    /// Recommendation sources the user wants surfaced on Home + Discovery.
    /// Stored as raw strings to stay forward-compatible with new sources the
    /// pipeline learns about.
    var discoverySources: Set<String>
    /// Show Google Maps rating ("4.7★ · 1.2k") on cards + detail view.
    /// Defaults true; user can hide via Settings → Hide ratings.
    var showRatings: Bool

    /// Manually-entered name used by the Home greeting when no signed-in
    /// `AuthService.state.displayName` is available — e.g. while the Apple
    /// Sign-In entitlement is still off (TASKS § P5). Trimmed; nil when blank.
    var displayName: String?

    init(
        dietaryPreferences: [DietaryTag],
        defaultPartySize: Int,
        locationOverride: City?,
        onboardingComplete: Bool,
        showOnlyReservable: Bool = true,
        discoverySources: Set<String> = Self.defaultDiscoverySources,
        showRatings: Bool = true,
        displayName: String? = nil
    ) {
        self.dietaryPreferences = dietaryPreferences
        self.defaultPartySize = defaultPartySize
        self.locationOverride = locationOverride
        self.onboardingComplete = onboardingComplete
        self.showOnlyReservable = showOnlyReservable
        self.discoverySources = discoverySources
        self.showRatings = showRatings
        self.displayName = displayName
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        self.dietaryPreferences = try c.decodeIfPresent([DietaryTag].self, forKey: .dietaryPreferences) ?? [.noRestrictions]
        self.defaultPartySize = try c.decodeIfPresent(Int.self, forKey: .defaultPartySize) ?? 2
        self.locationOverride = try c.decodeIfPresent(City.self, forKey: .locationOverride)
        self.onboardingComplete = try c.decodeIfPresent(Bool.self, forKey: .onboardingComplete) ?? false
        // Default true for existing users: the "safe" feed is reservable-only.
        self.showOnlyReservable = try c.decodeIfPresent(Bool.self, forKey: .showOnlyReservable) ?? true
        // Default to all-three-on so existing users immediately benefit as
        // Eater + Resy pagination lands in the pipeline.
        self.discoverySources = try c.decodeIfPresent(Set<String>.self, forKey: .discoverySources)
            ?? Self.defaultDiscoverySources
        // Default true — most users want the rating signal. They can hide
        // via Settings if it feels noisy.
        self.showRatings = try c.decodeIfPresent(Bool.self, forKey: .showRatings) ?? true
        self.displayName = try c.decodeIfPresent(String.self, forKey: .displayName)
    }

    /// Default to all known sources on. As the pipeline learns about a new
    /// source, every existing user opts in automatically.
    static let defaultDiscoverySources: Set<String> = Set(
        DiscoverySource.allCases.map(\.rawValue)
    )

    static let defaultProfile = UserProfile(
        dietaryPreferences: [.noRestrictions],
        defaultPartySize: 2,
        locationOverride: nil,
        onboardingComplete: false,
        showOnlyReservable: true,
        discoverySources: defaultDiscoverySources,
        showRatings: true
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
        NotificationCenter.default.post(name: .userProfileUpdated, object: nil)
    }
}
