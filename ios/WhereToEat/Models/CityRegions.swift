import Foundation

/// Matches the shape returned by GET /api/locations?city=<city>
struct CityRegions: Codable {
    let city: String
    let boroughs: [Borough]

    struct Borough: Codable, Identifiable {
        let name: String
        let neighborhoods: [String]

        var id: String { name }
    }

    /// Flat list of every borough name, in server order.
    var boroughNames: [String] { boroughs.map(\.name) }

    /// Neighborhoods for a given borough (empty if unknown).
    func neighborhoods(in borough: String) -> [String] {
        boroughs.first(where: { $0.name == borough })?.neighborhoods ?? []
    }

    /// The canonical borough for a neighborhood, if it's in the mapping.
    func borough(for neighborhood: String) -> String? {
        for b in boroughs where b.neighborhoods.contains(neighborhood) {
            return b.name
        }
        return nil
    }
}
