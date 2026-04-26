import Foundation
import CoreLocation

struct DayHours: Codable, Equatable {
    var day: Int // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
    var openTime: String  // "HH:mm"
    var closeTime: String // "HH:mm"
    var isClosed: Bool
}

struct Coordinates: Codable, Equatable {
    var latitude: Double
    var longitude: Double

    var clLocation: CLLocationCoordinate2D {
        CLLocationCoordinate2D(latitude: latitude, longitude: longitude)
    }

    static func from(_ coord: CLLocationCoordinate2D) -> Coordinates {
        Coordinates(latitude: coord.latitude, longitude: coord.longitude)
    }
}

enum SourceOrigin: String, Codable, CaseIterable {
    case xhs = "xhs"
    case yelp = "yelp"
    case eater = "eater"
    case custom = "custom"

    var displayName: String {
        switch self {
        case .xhs: return "小红书"
        case .yelp: return "Yelp"
        case .eater: return "Eater"
        case .custom: return "My List"
        }
    }

    var badgeColor: String {
        switch self {
        case .xhs: return "#FF2442"
        case .yelp: return "#D32323"
        case .eater: return "#E8341B"
        case .custom: return "#34C759"
        }
    }
}

struct Restaurant: Codable, Identifiable, Equatable {
    var id: UUID
    var name: String
    var address: String
    var neighborhood: String?
    var borough: String?
    var coordinates: Coordinates
    // Google Maps fields (mandatory for XHS-sourced; optional for custom/early-stage)
    var googleMapsLink: URL?
    var googlePlaceId: String?
    var bookingUrl: URL?          // websiteUri from Places API; used in SFSafariViewController
    var sourceOrigin: SourceOrigin
    var xhsRecommendation: String? // creator's words as-is (Chinese or English)
    var snoozedUntil: Date?        // set when user taps "Skip for 1 month"
    // Enrichment fields
    var cuisineTags: [CuisineTag]
    /// Raw cuisine string from the source (e.g. "Japanese Omakase") — used for
    /// filter chips that work outside the closed CuisineTag enum.
    var rawCuisineType: String?
    /// Feature keys from backend `features.ts` registry — sub-cuisines
    /// (sichuan, cantonese), formats (omakase, pizza, hot_pot), venues
    /// (coffee, bar, cafe), occasions (brunch, breakfast, late_night),
    /// modifiers (fusion, halal). Used for filter chips + detail-page badges.
    /// Optional so old UserDefaults rows without the field still decode.
    var features: [String]?
    /// XHS posts that mentioned this restaurant, sorted by likes desc. Drives
    /// the multi-quote creator carousel on the card / detail view. Optional
    /// so older cached records still decode.
    var xhsSources: [XHSSource]?
    var dietaryTags: [DietaryTag]
    var priceRange: Int?           // 1–4
    var photos: [URL]
    var rating: Double?
    var reviewCount: Int?
    var reviewSnippets: [Review]
    var hours: [DayHours]
    var sourceLinks: [SourceLink]
    var reservationSource: ReservationSource?
    /// Best-effort Instagram profile URL — populated by the backend when the
    /// restaurant's Google-Places-listed website links to one. Optional so
    /// older cached records still decode.
    var instagramUrl: URL?
    var phone: String?
    var website: URL?
    var isCustom: Bool
    var notes: String?
    var enrichedAt: Date?
    var addedAt: Date

    init(
        id: UUID = UUID(),
        name: String,
        address: String,
        neighborhood: String? = nil,
        borough: String? = nil,
        coordinates: Coordinates,
        googleMapsLink: URL? = nil,
        googlePlaceId: String? = nil,
        bookingUrl: URL? = nil,
        sourceOrigin: SourceOrigin = .custom,
        xhsRecommendation: String? = nil,
        snoozedUntil: Date? = nil,
        cuisineTags: [CuisineTag] = [],
        rawCuisineType: String? = nil,
        features: [String]? = nil,
        xhsSources: [XHSSource]? = nil,
        dietaryTags: [DietaryTag] = [],
        priceRange: Int? = nil,
        photos: [URL] = [],
        rating: Double? = nil,
        reviewCount: Int? = nil,
        reviewSnippets: [Review] = [],
        hours: [DayHours] = [],
        sourceLinks: [SourceLink] = [],
        reservationSource: ReservationSource? = nil,
        instagramUrl: URL? = nil,
        phone: String? = nil,
        website: URL? = nil,
        isCustom: Bool = false,
        notes: String? = nil,
        enrichedAt: Date? = nil,
        addedAt: Date = Date()
    ) {
        self.id = id
        self.name = name
        self.address = address
        self.neighborhood = neighborhood
        self.borough = borough
        self.coordinates = coordinates
        self.googleMapsLink = googleMapsLink
        self.googlePlaceId = googlePlaceId
        self.bookingUrl = bookingUrl
        self.sourceOrigin = sourceOrigin
        self.xhsRecommendation = xhsRecommendation
        self.snoozedUntil = snoozedUntil
        self.cuisineTags = cuisineTags
        self.rawCuisineType = rawCuisineType
        self.features = features
        self.xhsSources = xhsSources
        self.dietaryTags = dietaryTags
        self.priceRange = priceRange
        self.photos = photos
        self.rating = rating
        self.reviewCount = reviewCount
        self.reviewSnippets = reviewSnippets
        self.hours = hours
        self.sourceLinks = sourceLinks
        self.reservationSource = reservationSource
        self.instagramUrl = instagramUrl
        self.phone = phone
        self.website = website
        self.isCustom = isCustom
        self.notes = notes
        self.enrichedAt = enrichedAt
        self.addedAt = addedAt
    }

    var priceRangeDisplay: String {
        guard let range = priceRange else { return "" }
        return String(repeating: "$", count: range)
    }

    var primaryPhotoURL: URL? { photos.first }

    /// URL to open for booking — website first, then Google Maps link as fallback
    var effectiveBookingUrl: URL? { bookingUrl ?? googleMapsLink }

    var isSnoozed: Bool {
        guard let until = snoozedUntil else { return false }
        return until > Date()
    }

    func distanceMeters(from coord: CLLocationCoordinate2D) -> Double {
        let from = CLLocation(latitude: coord.latitude, longitude: coord.longitude)
        let to = CLLocation(latitude: coordinates.latitude, longitude: coordinates.longitude)
        return from.distance(from: to)
    }
}
