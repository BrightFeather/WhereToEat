import Foundation
import Combine
import CoreLocation
import MapKit

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

    /// Free-text search over the bottom-panel list and map. Matches name +
    /// neighborhood + borough + address + cuisine + top XHS quote, all
    /// case-insensitive and accent-folded. While non-empty, the bbox clip
    /// (pan/zoom-driven) is bypassed so users can find a restaurant without
    /// panning the camera there first; the matching pins also stay on the
    /// map regardless of camera, so the user can tap one to fly to it.
    @Published var searchQuery: String = "" {
        didSet { applyFilter() }
    }

    var hasSearch: Bool {
        !searchQuery.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// The map's currently-visible region. Updated by `FindView` on every
    /// camera change end. When set, both `mappable` (pins on the map) and
    /// `visibleFiltered` (rows in the bottom panel) are clipped to this bbox
    /// so a tight zoom near the user shows fewer dots; zooming out widens
    /// the bbox and progressively reveals more.
    @Published var visibleRegion: MKCoordinateRegion? = nil

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

    /// Rows that actually have coordinates AND fall inside the map's
    /// current visible region. Without `visibleRegion` set (initial frame
    /// before the map reports its first camera change), every coord-bearing
    /// row is returned — the view is responsible for seeding `visibleRegion`
    /// from `cameraPosition` on appear so the initial render is already
    /// region-clipped.
    var mappable: [WeeklyRestaurant] {
        let withCoords = filtered.filter { ($0.latitude ?? 0) != 0 && ($0.longitude ?? 0) != 0 }
        // Search overrides bbox: keep every matched pin on the map so the
        // user can pan/tap to fly there. Without search → standard bbox clip.
        if hasSearch { return withCoords }
        guard let region = visibleRegion else { return withCoords }
        return withCoords.filter { regionContains(region, lat: $0.latitude!, lng: $0.longitude!) }
    }

    /// Rows shown in the bottom panel. We show:
    ///   - coord-bearing rows whose pin falls inside the visible region
    ///   - rows without coords (always — they can't be filtered geographically
    ///     and dropping them would silently hide them everywhere on Find)
    /// When `visibleRegion` is nil, behaves like `filtered`.
    ///
    /// **Selected-row pinning:** if the user tapped a map marker, that
    /// restaurant is hoisted to the top of the list (and inserted there even
    /// if its pin sits outside the current bbox — e.g. tapping a marker near
    /// the camera edge before `onMapCameraChange` lands its post-`centerOn`
    /// region). Without this, tapping a pin and looking down to the list
    /// would either show no obvious change (selected was already in-view) or
    /// hide the row entirely (selected just outside bbox). Pinning makes
    /// the tap → row association unambiguous.
    var visibleFiltered: [WeeklyRestaurant] {
        var base: [WeeklyRestaurant]
        // Search overrides bbox so users can find restaurants regardless of
        // where the map is pointed. Cuisine + source filters still apply
        // (they're already baked into `filtered`).
        if hasSearch {
            base = filtered
        } else if let region = visibleRegion {
            base = filtered.filter { r in
                let lat = r.latitude ?? 0
                let lng = r.longitude ?? 0
                if lat == 0 && lng == 0 { return true }
                return regionContains(region, lat: lat, lng: lng)
            }
        } else {
            base = filtered
        }

        if let selectedId = selectedRestaurantId {
            if let idx = base.firstIndex(where: { $0.id == selectedId }) {
                let selected = base.remove(at: idx)
                base.insert(selected, at: 0)
            } else if let selected = filtered.first(where: { $0.id == selectedId }) {
                // Selected row was filtered out by the bbox — re-insert at
                // the top so it doesn't vanish from the list when tapped.
                base.insert(selected, at: 0)
            }
        }
        return base
    }

    var resultCount: Int { visibleFiltered.count }

    private func regionContains(_ region: MKCoordinateRegion, lat: Double, lng: Double) -> Bool {
        let halfLat = region.span.latitudeDelta / 2
        let halfLng = region.span.longitudeDelta / 2
        return lat >= region.center.latitude - halfLat
            && lat <= region.center.latitude + halfLat
            && lng >= region.center.longitude - halfLng
            && lng <= region.center.longitude + halfLng
    }

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
        let q = normalizedQuery(searchQuery)
        filtered = allRestaurants.filter { r in
            if !matchesEnabledSources(r) { return false }
            if let c = selectedCuisine, normalizedCuisine(r.cuisineType) != c { return false }
            if !q.isEmpty, !matchesQuery(r, q: q) { return false }
            return true
        }
    }

    /// Lowercased + diacritic-folded + whitespace-trimmed query string. Used
    /// once per `applyFilter` so we don't re-fold per row in the inner loop.
    private func normalizedQuery(_ raw: String) -> String {
        raw.trimmingCharacters(in: .whitespacesAndNewlines)
            .folding(options: .diacriticInsensitive, locale: .current)
            .lowercased()
    }

    /// Substring match across name + neighborhood + borough + address +
    /// cuisine + top XHS quote. All comparisons are case- and
    /// diacritic-insensitive (so "cafe" finds "Café").
    private func matchesQuery(_ r: WeeklyRestaurant, q: String) -> Bool {
        let cuisineDisplay = r.cuisineType.flatMap { CuisineTag(rawValue: $0.lowercased())?.displayName }
        let candidates: [String?] = [
            r.googleDisplayName,
            r.restaurantName,
            r.neighborhood,
            r.borough,
            r.address,
            r.cuisineType,
            cuisineDisplay,
            excerpt(for: r),
        ]
        return candidates
            .compactMap { $0 }
            .map { $0.folding(options: .diacriticInsensitive, locale: .current).lowercased() }
            .contains { $0.contains(q) }
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
