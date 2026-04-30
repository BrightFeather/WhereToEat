import Foundation

enum Endpoint {
    // Weekly restaurants (XHS pipeline)
    case weeklyRestaurants(city: String)
    case markUnavailable(id: String)

    // City → borough → neighborhood mapping
    case cityRegions(city: String)

    // Places
    case enrichRestaurant(name: String, lat: Double, lng: Double)

    // Scrape
    case scrapeXiaohongshu(lat: Double, lng: Double, cuisines: [String])
    case scrapeEater(city: String)

    // Import
    case importXhs(url: String)

    // Feedback
    case submitFeedback(body: [String: Any])

    // Auth — exchange a provider identity token for a verified user id
    case authLogin(body: [String: Any])

    // User — anonymous device id is attached as X-User-Id by APIClient
    case userEnsure
    case userReservationsList
    case userReservationCreate(body: [String: Any])
    case userReservationDelete(id: String)
    case userFavoritesList
    case userFavoriteAdd(restaurantId: String, snapshot: [String: Any]?)
    case userFavoriteRemove(restaurantId: String)
    case userBlocksList
    case userBlockAdd(restaurantId: String, blockedUntil: String?)
    case userBlockRemove(restaurantId: String)

    var path: String {
        switch self {
        case .weeklyRestaurants: return "/api/restaurants/weekly"
        case .markUnavailable(let id): return "/api/restaurants/\(id)/unavailable"
        case .cityRegions: return "/api/locations"
        case .enrichRestaurant: return "/api/places/enrich"
        case .scrapeXiaohongshu: return "/api/scrape/xiaohongshu"
        case .scrapeEater: return "/api/scrape/eater"
        case .importXhs: return "/api/restaurants/import-xhs"
        case .submitFeedback: return "/api/feedback"
        case .authLogin: return "/api/auth/login"
        case .userEnsure: return "/api/user/ensure"
        case .userReservationsList, .userReservationCreate: return "/api/user/reservations"
        case .userReservationDelete(let id): return "/api/user/reservations/\(id)"
        case .userFavoritesList, .userFavoriteAdd, .userFavoriteRemove: return "/api/user/favorites"
        case .userBlocksList, .userBlockAdd: return "/api/user/blocks"
        case .userBlockRemove(let rid): return "/api/user/blocks/\(rid)"
        }
    }

    var method: String {
        switch self {
        case .weeklyRestaurants, .enrichRestaurant, .scrapeXiaohongshu, .scrapeEater, .cityRegions:
            return "GET"
        case .userReservationsList, .userFavoritesList, .userBlocksList:
            return "GET"
        case .markUnavailable:
            return "PATCH"
        case .importXhs, .authLogin, .userEnsure, .userReservationCreate, .userFavoriteAdd, .userBlockAdd, .submitFeedback:
            return "POST"
        case .userReservationDelete, .userFavoriteRemove, .userBlockRemove:
            return "DELETE"
        }
    }

    var queryItems: [URLQueryItem]? {
        switch self {
        case .weeklyRestaurants(let city):
            return [URLQueryItem(name: "city", value: city)]
        case .cityRegions(let city):
            return [URLQueryItem(name: "city", value: city)]
        case .enrichRestaurant(let name, let lat, let lng):
            return [
                URLQueryItem(name: "name", value: name),
                URLQueryItem(name: "lat", value: "\(lat)"),
                URLQueryItem(name: "lng", value: "\(lng)")
            ]
        case .scrapeXiaohongshu(let lat, let lng, let cuisines):
            var items = [URLQueryItem(name: "lat", value: "\(lat)"),
                         URLQueryItem(name: "lng", value: "\(lng)")]
            cuisines.forEach { items.append(URLQueryItem(name: "cuisines[]", value: $0)) }
            return items
        case .scrapeEater(let city):
            return [URLQueryItem(name: "city", value: city)]
        case .userFavoriteRemove(let rid):
            // Backend `api/user/favorites.ts` reads `?restaurantId=…` so we
            // can keep GET / POST / DELETE on a single function (Hobby cap).
            return [URLQueryItem(name: "restaurantId", value: rid)]
        default:
            return nil
        }
    }

    var body: [String: Any]? {
        switch self {
        case .importXhs(let url):
            return ["url": url]
        case .submitFeedback(let body):
            return body
        case .authLogin(let body):
            return body
        case .userEnsure:
            return [:]
        case .userReservationCreate(let body):
            return body
        case .userFavoriteAdd(let rid, let snapshot):
            var b: [String: Any] = ["restaurantId": rid]
            if let snapshot { b["snapshot"] = snapshot }
            return b
        case .userBlockAdd(let rid, let until):
            var b: [String: Any] = ["restaurantId": rid]
            if let until { b["blockedUntil"] = until }
            return b
        default:
            return nil
        }
    }
}
