import Foundation
import Combine
import CoreLocation

enum WeeklyStatus {
    case ready([WeeklyRestaurant])
    case stale([WeeklyRestaurant])   // old data, pipeline rebuilding
    case building                    // no data yet, pipeline running
    case error(String)
}

@MainActor
final class WeeklyRestaurantService: ObservableObject {
    static let shared = WeeklyRestaurantService()

    @Published var status: WeeklyStatus = .building {
        didSet { prefetchTopPhotos() }
    }
    /// Discovery deals its first card from a shuffle of the top 25 (its
    /// band size), so warming these makes the first card's photo instant.
    private static let prefetchCount = 25
    /// Cities the deck can show: backend key → label for the Pick-page picker.
    /// Only cities with live data belong here (new cities are added once their
    /// first ingest is synced; see agent_docs/multi-city-expansion.md).
    static let cities: [(key: String, label: String)] = [("nyc", "New York"), ("bay", "Bay Area"), ("la", "Los Angeles")]
    /// Bounding box per city (matches backend `CITY_META` bounds). Used to turn
    /// a GPS fix into a city key and by Find to ignore mis-geocoded pins.
    static let cityBounds: [String: (minLat: Double, maxLat: Double, minLng: Double, maxLng: Double)] = [
        "nyc": (40.45, 41.0, -74.3, -73.65),
        "bay": (36.95, 38.65, -123.15, -121.45),
        "la": (33.40, 34.45, -118.95, -117.40),  // LA County + Orange County
    ]
    private static let selectedCityKey = "selected_city"
    private static let defaultCity = "nyc"

    /// City key whose box contains `coord`, or nil when outside every city.
    static func cityKey(for coord: CLLocationCoordinate2D?) -> String? {
        guard let c = coord else { return nil }
        return cities.first { city in
            guard let b = cityBounds[city.key] else { return false }
            return c.latitude >= b.minLat && c.latitude <= b.maxLat
                && c.longitude >= b.minLng && c.longitude <= b.maxLng
        }?.key
    }

    /// True while the deck follows GPS ("Current location" on the Pick-page
    /// picker). False once the user picks a city explicitly.
    @Published private(set) var isAutoCity: Bool =
        UserDefaults.standard.string(forKey: WeeklyRestaurantService.selectedCityKey) == nil
    /// City detected from the latest GPS fix (nil = no fix, or not in a supported city).
    @Published private(set) var gpsCity: String? = WeeklyRestaurantService.cityKey(for: LocationService.shared.currentLocation)

    /// Backend city key the deck (Home's "This week's picks", Pick, Find) shows:
    /// the city picked on the Pick page, else the GPS city, else New York.
    @Published private(set) var activeCity: String =
        WeeklyRestaurantService.storedSelectedCity
        ?? WeeklyRestaurantService.cityKey(for: LocationService.shared.currentLocation)
        ?? WeeklyRestaurantService.defaultCity

    /// Cities whose deck came back `building` with no restaurants and nothing
    /// cached: the city is in the app but has no data in prod yet (Los
    /// Angeles after build 48). The app falls back to another city instead
    /// of polling forever, and Settings shows the city as "Coming soon".
    /// Session-only, so a city comes back on the next launch once its data
    /// lands.
    @Published private(set) var unavailableCities: Set<String> = []

    /// The saved explicit pick, ignored if it's no longer a supported city.
    private static var storedSelectedCity: String? {
        guard let key = UserDefaults.standard.string(forKey: selectedCityKey),
              cities.contains(where: { $0.key == key }) else { return nil }
        return key
    }

    private let api = APIClient.shared
    private let cache = WeeklyCache.shared
    private var pollTask: Task<Void, Never>?
    private var cancellables = Set<AnyCancellable>()

    private init() {
        // `$currentLocation` emits before the property is set: use the value.
        LocationService.shared.$currentLocation
            .map { WeeklyRestaurantService.cityKey(for: $0) }
            .removeDuplicates()
            .receive(on: DispatchQueue.main)
            .sink { [weak self] detected in
                guard let self else { return }
                self.gpsCity = detected
                if self.isAutoCity { self.switchTo(self.availableGPSCity ?? Self.defaultCity) }
            }
            .store(in: &cancellables)
    }

    /// Pick-page picker: show `key` regardless of GPS (persisted).
    func selectCity(_ key: String) {
        guard Self.cities.contains(where: { $0.key == key }),
              !unavailableCities.contains(key) else { return }
        UserDefaults.standard.set(key, forKey: Self.selectedCityKey)
        isAutoCity = false
        switchTo(key)
    }

    /// Pick-page picker "Current location": follow GPS again.
    func useCurrentLocation() {
        UserDefaults.standard.removeObject(forKey: Self.selectedCityKey)
        isAutoCity = true
        switchTo(availableGPSCity ?? Self.defaultCity)
    }

    /// The GPS city, unless it has no data yet.
    private var availableGPSCity: String? {
        guard let gpsCity, !unavailableCities.contains(gpsCity) else { return nil }
        return gpsCity
    }

    /// A city answered `building` with nothing to show: remember it and, if
    /// it's the one on screen, go back to GPS (or New York) instead of
    /// leaving Home / Pick / Find on an endless spinner.
    private func markCityUnavailable(_ city: String) {
        unavailableCities.insert(city)
        print("[WeeklyRestaurantService] \(city) has no data yet; falling back")
        guard city == activeCity else { return }
        if !isAutoCity {
            UserDefaults.standard.removeObject(forKey: Self.selectedCityKey)
            isAutoCity = true
        }
        switchTo(availableGPSCity ?? Self.defaultCity)
    }

    private func switchTo(_ key: String) {
        guard key != activeCity else { return }
        activeCity = key
        pollTask?.cancel()  // polling for the previous city must not overwrite the new deck
        status = .building
        Task { await bootstrap(city: key) }
    }

    /// False when no restaurant in the current deck has a Resy / OpenTable link
    /// (e.g. Bay Area before its booking backfill). Callers then skip the
    /// "only bookable" filter instead of showing an empty deck.
    var activeCityHasBookable: Bool {
        switch status {
        case .ready(let list), .stale(let list):
            return list.contains(where: \.isBookable)
        case .building, .error:
            return true
        }
    }

    /// Cold-start entry point. Replaces the old `fetch()` call from `RootView`.
    /// Decision tree (see DESIGN-CACHING.md § Freshness model):
    ///   - cache fresh (< 6h, same weekStart): publish, **no network**
    ///   - cache warm  (6–72h):                 publish, kick invisible refresh
    ///   - cache stale or missing:              fall through to foreground fetch
    func bootstrap(city: String = "nyc") async {
        if let entry = cache.cached, entry.city == city {
            let weekRolledOver = entry.weekStart != currentWeekStart()
            // Always render cache first — UI never sees an empty state.
            status = weekRolledOver ? .stale(entry.restaurants) : .ready(entry.restaurants)

            if !weekRolledOver && cache.isFresh { return }
            if !weekRolledOver && cache.isWarm {
                Task { await refreshIfChanged(city: city) }
                return
            }
            // > 72h or week rolled over → fall through to foreground fetch.
        }
        await fetch(city: city)
    }

    func fetch(city: String = "nyc") async {
        do {
            let result = try await api.requestConditional(
                .weeklyRestaurants(city: city),
                ifNoneMatch: etag(for: city),
                as: WeeklyResponse.self
            )
            // The city may have switched while this request was in flight
            // (e.g. the GPS fix arrived). A late response for the old city
            // must not overwrite the new city's deck or cache.
            guard city == activeCity else { return }
            switch result {
            case .notModified:
                if let entry = cache.cached, entry.city == city {
                    cache.bumpSavedAt()
                    status = .ready(entry.restaurants)
                }
            case .ok(let wrapper, let headerEtag):
                apply(wrapper, city: city)
                if let list = wrapper.restaurants, !list.isEmpty {
                    cache.save(.init(
                        savedAt: .now,
                        etag: wrapper.etag ?? headerEtag,
                        weekStart: currentWeekStart(),
                        city: city,
                        restaurants: list
                    ))
                }
            }
        } catch {
            guard city == activeCity else { return }
            status = .error(error.localizedDescription)
        }
    }

    /// Background refresh for the warm-cache path. Failures are intentionally
    /// silent — the user is already looking at the cached deck.
    private func refreshIfChanged(city: String) async {
        do {
            let result = try await api.requestConditional(
                .weeklyRestaurants(city: city),
                ifNoneMatch: etag(for: city),
                as: WeeklyResponse.self
            )
            guard city == activeCity else { return }  // stale: city switched mid-flight
            switch result {
            case .notModified:
                cache.bumpSavedAt()
            case .ok(let wrapper, let headerEtag):
                apply(wrapper, city: city)
                if let list = wrapper.restaurants, !list.isEmpty {
                    cache.save(.init(
                        savedAt: .now,
                        etag: wrapper.etag ?? headerEtag,
                        weekStart: currentWeekStart(),
                        city: city,
                        restaurants: list
                    ))
                }
            }
        } catch {
            print("[WeeklyRestaurantService] background refresh failed: \(error.localizedDescription)")
        }
    }

    func markUnavailable(id: String) async {
        _ = try? await api.request(.markUnavailable(id: id), as: EmptyResponse.self)
        // Remove from in-memory state for instant UI feedback.
        if case .ready(let list) = status {
            status = .ready(list.filter { $0.id != id })
        } else if case .stale(let list) = status {
            status = .stale(list.filter { $0.id != id })
        }
        // Mirror to disk so the row stays gone after restart.
        cache.removeRestaurant(id: id)
    }

    // MARK: - Private

    /// The cache holds one city; its etag is only meaningful for that city.
    private func etag(for city: String) -> String? {
        cache.cached?.city == city ? cache.cached?.etag : nil
    }

    private func prefetchTopPhotos() {
        switch status {
        case .ready(let list), .stale(let list):
            ImageCache.prefetch(list.prefix(Self.prefetchCount).compactMap {
                $0.photoUrl.flatMap { URL(string: $0) }
            })
        case .building, .error:
            break
        }
    }

    private func apply(_ wrapper: WeeklyResponse, city: String) {
        pollTask?.cancel()

        switch wrapper.status {
        case "ready":
            status = .ready(wrapper.restaurants ?? [])
        case "stale":
            status = .stale(wrapper.restaurants ?? [])
            startPolling(city: city)
        case "building":
            // No rows at all and nothing cached for this city = the city
            // isn't live in prod yet. Never applies to the default city, so
            // a fresh install during a pipeline run still waits for NYC.
            let hasCache = cache.cached?.city == city
            if (wrapper.restaurants ?? []).isEmpty, !hasCache, city != Self.defaultCity {
                markCityUnavailable(city)
                return
            }
            status = .building
            startPolling(city: city)
        default:
            status = .error("Unknown status: \(wrapper.status)")
        }
    }

    private func startPolling(city: String) {
        pollTask = Task {
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 30_000_000_000) // 30s
                guard !Task.isCancelled else { return }
                do {
                    let wrapper = try await api.request(.weeklyRestaurants(city: city), as: WeeklyResponse.self)
                    guard city == activeCity else { return }
                    if wrapper.status == "ready" {
                        status = .ready(wrapper.restaurants ?? [])
                        return  // stop polling once we have fresh data
                    }
                } catch { /* keep polling on error */ }
            }
        }
    }
}

private struct EmptyResponse: Decodable {}
