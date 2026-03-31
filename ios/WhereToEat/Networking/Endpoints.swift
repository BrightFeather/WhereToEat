import Foundation

enum Endpoint {
    // Places
    case enrichRestaurant(name: String, lat: Double, lng: Double)

    // Reservations
    case resySearch(venueId: String, dates: [String], partySize: Int)
    case resyBook(venueId: String, configId: String, paymentMethodId: String?)
    case opentableSearch(venueId: String, dates: [String], partySize: Int)
    case opentableBook(venueId: String, slotToken: String, partySize: Int, datetime: String)
    case tockSearch(venueId: String, dates: [String], partySize: Int)
    case tockBook(venueId: String, slotId: String, partySize: Int)

    // Scrape
    case scrapeXiaohongshu(lat: Double, lng: Double, cuisines: [String])
    case scrapeEater(city: String)

    // Stripe
    case createPaymentIntent(amount: Int, currency: String, restaurantName: String)

    var path: String {
        switch self {
        case .enrichRestaurant: return "/api/places/enrich"
        case .resySearch: return "/api/reservations/resy/search"
        case .resyBook: return "/api/reservations/resy/book"
        case .opentableSearch: return "/api/reservations/opentable/search"
        case .opentableBook: return "/api/reservations/opentable/book"
        case .tockSearch: return "/api/reservations/tock/search"
        case .tockBook: return "/api/reservations/tock/book"
        case .scrapeXiaohongshu: return "/api/scrape/xiaohongshu"
        case .scrapeEater: return "/api/scrape/eater"
        case .createPaymentIntent: return "/api/stripe/create-payment-intent"
        }
    }

    var method: String {
        switch self {
        case .enrichRestaurant, .resySearch, .opentableSearch, .tockSearch,
             .scrapeXiaohongshu, .scrapeEater:
            return "GET"
        case .resyBook, .opentableBook, .tockBook, .createPaymentIntent:
            return "POST"
        }
    }

    var queryItems: [URLQueryItem]? {
        switch self {
        case .enrichRestaurant(let name, let lat, let lng):
            return [
                URLQueryItem(name: "name", value: name),
                URLQueryItem(name: "lat", value: "\(lat)"),
                URLQueryItem(name: "lng", value: "\(lng)")
            ]
        case .resySearch(let venueId, let dates, let partySize):
            var items = [URLQueryItem(name: "venueId", value: venueId),
                         URLQueryItem(name: "partySize", value: "\(partySize)")]
            dates.forEach { items.append(URLQueryItem(name: "dates[]", value: $0)) }
            return items
        case .opentableSearch(let venueId, let dates, let partySize):
            var items = [URLQueryItem(name: "venueId", value: venueId),
                         URLQueryItem(name: "partySize", value: "\(partySize)")]
            dates.forEach { items.append(URLQueryItem(name: "dates[]", value: $0)) }
            return items
        case .tockSearch(let venueId, let dates, let partySize):
            var items = [URLQueryItem(name: "venueId", value: venueId),
                         URLQueryItem(name: "partySize", value: "\(partySize)")]
            dates.forEach { items.append(URLQueryItem(name: "dates[]", value: $0)) }
            return items
        case .scrapeXiaohongshu(let lat, let lng, let cuisines):
            var items = [URLQueryItem(name: "lat", value: "\(lat)"),
                         URLQueryItem(name: "lng", value: "\(lng)")]
            cuisines.forEach { items.append(URLQueryItem(name: "cuisines[]", value: $0)) }
            return items
        case .scrapeEater(let city):
            return [URLQueryItem(name: "city", value: city)]
        default:
            return nil
        }
    }

    var body: [String: Any]? {
        switch self {
        case .resyBook(let venueId, let configId, let paymentMethodId):
            var d: [String: Any] = ["venueId": venueId, "configId": configId]
            if let pm = paymentMethodId { d["paymentMethodId"] = pm }
            return d
        case .opentableBook(let venueId, let slotToken, let partySize, let datetime):
            return ["venueId": venueId, "slotToken": slotToken,
                    "partySize": partySize, "datetime": datetime]
        case .tockBook(let venueId, let slotId, let partySize):
            return ["venueId": venueId, "slotId": slotId, "partySize": partySize]
        case .createPaymentIntent(let amount, let currency, let restaurantName):
            return ["amount": amount, "currency": currency, "restaurantName": restaurantName]
        default:
            return nil
        }
    }
}
