import Foundation

/// Server round-trip for the user's saved-restaurant list (My List).
///
/// Storage strategy: local UserDefaults remains the working copy
/// (`CustomListViewModel` holds the live array), but every mutation also
/// pushes to `/api/user/favorites` so the same list appears on a second
/// device or after a fresh install. `pullFromServer()` reconciles on
/// startup + after sign-in.
///
/// Custom-list imports (paste-link / share-sheet) don't exist in
/// `xhs_restaurants`, so we ship the entire iOS `Restaurant` JSON as a
/// `snapshot` field. Weekly-deck restaurants pass `snapshot: nil` and are
/// re-hydrated client-side from `WeeklyRestaurantService` when an id matches
/// — keeps the request bodies small and lets the deck stay authoritative
/// for shared rows.
final class FavoritesService {
    static let shared = FavoritesService()

    private let api = APIClient.shared
    private init() {}

    // MARK: - Wire format

    private struct ServerEnvelope: Decodable { let favorites: [ServerEntry] }
    private struct ServerEntry: Decodable {
        let restaurantId: String
        let savedAt: String?
        /// Server returns the iOS Restaurant payload as parsed JSON. We
        /// re-encode to Data and decode into `Restaurant` on the client so
        /// `Restaurant`'s own `Decodable` keeps owning shape evolution.
        let snapshot: AnyCodable?
    }

    // MARK: - Pull

    /// GET `/api/user/favorites` → array of (id, optional Restaurant snapshot,
    /// savedAt). Errors are swallowed — a network blip should not nuke the
    /// user's local list. Caller is responsible for merging the result.
    func pullFromServer() async -> [ServerSavedRestaurant] {
        do {
            let env = try await api.request(Endpoint.userFavoritesList, as: ServerEnvelope.self)
            return env.favorites.compactMap { entry -> ServerSavedRestaurant? in
                let restaurant: Restaurant? = entry.snapshot.flatMap { snapshot in
                    guard let data = try? JSONEncoder().encode(snapshot) else { return nil }
                    return try? JSONDecoder().decode(Restaurant.self, from: data)
                }
                return ServerSavedRestaurant(
                    restaurantId: entry.restaurantId,
                    snapshot: restaurant,
                    savedAt: entry.savedAt
                )
            }
        } catch {
            print("[Favorites] pullFromServer failed: \(error.localizedDescription)")
            return []
        }
    }

    // MARK: - Push

    /// POST `/api/user/favorites` with the restaurant id and a JSON snapshot
    /// of the iOS `Restaurant` model. Fire-and-forget — local state is the
    /// source of truth in this turn. Re-uses the existing `ON CONFLICT DO
    /// UPDATE` so calling `push` repeatedly is safe.
    func push(_ restaurant: Restaurant) async {
        do {
            let data = try JSONEncoder().encode(restaurant)
            // `Endpoint.userFavoriteAdd` expects `[String: Any]`. Decode
            // through JSONSerialization rather than mirroring every field
            // here — keeps the wire shape married to `Restaurant.Codable`.
            let snapshot = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            _ = try await api.request(
                Endpoint.userFavoriteAdd(
                    restaurantId: restaurant.id.uuidString,
                    snapshot: snapshot
                ),
                as: PushAck.self
            )
        } catch {
            print("[Favorites] push(\(restaurant.id)) failed: \(error.localizedDescription)")
        }
    }

    /// DELETE `/api/user/favorites?restaurantId=…`. Fire-and-forget; failures
    /// are logged but the local list has already been updated.
    func remove(restaurantId: UUID) async {
        do {
            _ = try await api.request(
                Endpoint.userFavoriteRemove(restaurantId: restaurantId.uuidString),
                as: PushAck.self
            )
        } catch {
            print("[Favorites] remove(\(restaurantId)) failed: \(error.localizedDescription)")
        }
    }

    private struct PushAck: Decodable { let restaurantId: String }
}

/// One row from the server, carried back to `CustomListViewModel` for
/// merging. `snapshot` is nil when the server stored the row without a
/// JSON snapshot (typically a weekly-deck restaurant whose id is enough).
struct ServerSavedRestaurant {
    let restaurantId: String
    let snapshot: Restaurant?
    let savedAt: String?
}

/// Tiny Codable wrapper that defers shape decisions to JSON's primitives.
/// Lets `ServerEntry.snapshot` round-trip arbitrary JSON without forcing
/// `FavoritesService` to know the `Restaurant` schema directly.
private struct AnyCodable: Decodable, Encodable {
    let value: Any

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() {
            value = NSNull()
        } else if let v = try? c.decode(Bool.self) {
            value = v
        } else if let v = try? c.decode(Int.self) {
            value = v
        } else if let v = try? c.decode(Double.self) {
            value = v
        } else if let v = try? c.decode(String.self) {
            value = v
        } else if let v = try? c.decode([AnyCodable].self) {
            value = v.map(\.value)
        } else if let v = try? c.decode([String: AnyCodable].self) {
            value = v.mapValues(\.value)
        } else {
            throw DecodingError.typeMismatch(
                AnyCodable.self,
                .init(codingPath: decoder.codingPath, debugDescription: "Unsupported JSON value")
            )
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch value {
        case is NSNull:                      try c.encodeNil()
        case let v as Bool:                  try c.encode(v)
        case let v as Int:                   try c.encode(v)
        case let v as Double:                try c.encode(v)
        case let v as String:                try c.encode(v)
        case let v as [Any]:                 try c.encode(v.map { AnyCodable(rawValue: $0) })
        case let v as [String: Any]:         try c.encode(v.mapValues { AnyCodable(rawValue: $0) })
        default:
            throw EncodingError.invalidValue(
                value,
                .init(codingPath: encoder.codingPath, debugDescription: "Unsupported value: \(type(of: value))")
            )
        }
    }

    init(rawValue: Any) { self.value = rawValue }
}
