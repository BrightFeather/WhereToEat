import Foundation
import Combine
import CoreLocation

/// View model for the Find tab — a map-of-NYC + bottom-sheet list of every
/// available restaurant in this week's weekly deck. Reuses the same
/// `WeeklyRestaurantService` cache that powers Home + Discovery, so opening
/// Find never triggers a duplicate fetch.
///
/// Find is a **browse** surface, not a swipe deck — it deliberately skips
/// the reserved/blocked/seen-today filters that Discovery applies. The user
/// is here to look at the map of NYC restaurants, not to be paced.
@MainActor
final class FindViewModel: ObservableObject {
    @Published var allRestaurants: [WeeklyRestaurant] = []
    @Published var availableCuisines: [String] = []
    @Published var selectedCuisine: String? = nil {
        didSet { applyFilter() }
    }
    @Published var filtered: [WeeklyRestaurant] = []
    @Published var selectedRestaurantId: String? = nil

    /// Mirrors UserProfile.discoverySources so the Find map respects the
    /// same source-toggle the user set in Settings.
    @Published var enabledSources: Set<String> = UserProfile.load().discoverySources

    private let weeklyService = WeeklyRestaurantService.shared
    private var cancellables = Set<AnyCancellable>()

    init() {
        weeklyService.$status
            .receive(on: DispatchQueue.main)
            .sink { [weak self] status in
                let list: [WeeklyRestaurant]
                switch status {
                case .ready(let l), .stale(let l): list = l
                default: list = []
                }
                self?.allRestaurants = list
                self?.rebuildCuisines()
                self?.applyFilter()
            }
            .store(in: &cancellables)

        NotificationCenter.default.publisher(for: .userProfileUpdated)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in
                guard let self else { return }
                let updated = UserProfile.load().discoverySources
                guard self.enabledSources != updated else { return }
                self.enabledSources = updated
                self.rebuildCuisines()
                self.applyFilter()
            }
            .store(in: &cancellables)

        Task { await weeklyService.bootstrap(city: "nyc") }
    }

    /// Rows that actually have coordinates, used for map pins.
    var mappable: [WeeklyRestaurant] {
        filtered.filter { ($0.latitude ?? 0) != 0 && ($0.longitude ?? 0) != 0 }
    }

    var resultCount: Int { filtered.count }

    func selectCuisine(_ cuisine: String?) {
        selectedCuisine = cuisine
    }

    func select(_ restaurant: WeeklyRestaurant) {
        selectedRestaurantId = restaurant.id
    }

    /// Highest-likes XHS post excerpt — drives the row's italic quote line.
    /// Falls back to the legacy `recommendation` field when no `sources`
    /// array is present (older cached rows).
    func excerpt(for r: WeeklyRestaurant) -> String? {
        if let sources = r.sources, !sources.isEmpty {
            let xhs = sources.filter { $0.resolvedType == "xiaohongshu" }
            if let top = xhs.max(by: { $0.likes < $1.likes }),
               let text = top.recommendation, !text.isEmpty {
                return text
            }
        }
        return r.recommendation
    }

    // MARK: - Private

    private func rebuildCuisines() {
        var set: Set<String> = []
        for r in allRestaurants {
            guard matchesEnabledSources(r) else { continue }
            if let c = normalizedCuisine(r.cuisineType) { set.insert(c) }
        }
        availableCuisines = set.sorted { $0.localizedCompare($1) == .orderedAscending }
    }

    private func applyFilter() {
        filtered = allRestaurants.filter { r in
            if !matchesEnabledSources(r) { return false }
            if let c = selectedCuisine, normalizedCuisine(r.cuisineType) != c { return false }
            return true
        }
    }

    private func matchesEnabledSources(_ r: WeeklyRestaurant) -> Bool {
        if enabledSources.isEmpty { return false }
        let types: [String]
        if let sources = r.sources, !sources.isEmpty {
            types = sources.map(\.resolvedType)
        } else {
            types = ["xiaohongshu"]
        }
        return types.contains { enabledSources.contains($0) }
    }

    private func normalizedCuisine(_ raw: String?) -> String? {
        guard let s = raw?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
              !s.isEmpty else { return nil }
        return CuisineTag(rawValue: s)?.rawValue
    }

    func cuisineDisplayLabel(_ key: String) -> String {
        CuisineTag(rawValue: key)?.displayName ?? key.capitalized
    }
}
