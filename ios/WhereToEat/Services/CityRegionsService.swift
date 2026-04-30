import Foundation
import Combine

/// Loads and caches the city → borough → neighborhood mapping from the backend.
/// One instance per app; published `regions` drives filter-chip options.
@MainActor
final class CityRegionsService: ObservableObject {
    static let shared = CityRegionsService()

    @Published private(set) var regions: CityRegions?

    private let api = APIClient.shared
    private var loadedCity: String?

    private init() {}

    func load(city: String = "nyc", force: Bool = false) async {
        if !force, loadedCity == city, regions != nil { return }
        do {
            let value = try await api.request(.cityRegions(city: city), as: CityRegions.self)
            self.regions = value
            self.loadedCity = city
        } catch {
            // Non-fatal — filter chips will fall back to values derived from
            // the restaurants payload.
            self.regions = nil
        }
    }
}
