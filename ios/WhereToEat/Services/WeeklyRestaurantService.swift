import Foundation

enum WeeklyStatus {
    case ready([WeeklyRestaurant])
    case stale([WeeklyRestaurant])   // old data, pipeline rebuilding
    case building                    // no data yet, pipeline running
    case error(String)
}

@MainActor
final class WeeklyRestaurantService: ObservableObject {
    static let shared = WeeklyRestaurantService()

    @Published var status: WeeklyStatus = .building

    private let api = APIClient.shared
    private let cache = WeeklyCache.shared
    private var pollTask: Task<Void, Never>?

    private init() {}

    /// Cold-start entry point. Replaces the old `fetch()` call from `RootView`.
    /// Decision tree (see DESIGN-CACHING.md § Freshness model):
    ///   - cache fresh (< 6h, same weekStart): publish, **no network**
    ///   - cache warm  (6–24h):                 publish, kick invisible refresh
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
            // > 24h or week rolled over → fall through to foreground fetch.
        }
        await fetch(city: city)
    }

    func fetch(city: String = "nyc") async {
        do {
            let result = try await api.requestConditional(
                .weeklyRestaurants(city: city),
                ifNoneMatch: cache.cached?.etag,
                as: WeeklyResponse.self
            )
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
            status = .error(error.localizedDescription)
        }
    }

    /// Background refresh for the warm-cache path. Failures are intentionally
    /// silent — the user is already looking at the cached deck.
    private func refreshIfChanged(city: String) async {
        do {
            let result = try await api.requestConditional(
                .weeklyRestaurants(city: city),
                ifNoneMatch: cache.cached?.etag,
                as: WeeklyResponse.self
            )
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

    private func apply(_ wrapper: WeeklyResponse, city: String) {
        pollTask?.cancel()

        switch wrapper.status {
        case "ready":
            status = .ready(wrapper.restaurants ?? [])
        case "stale":
            status = .stale(wrapper.restaurants ?? [])
            startPolling(city: city)
        case "building":
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
