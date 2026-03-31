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

struct Restaurant: Codable, Identifiable, Equatable {
    var id: UUID
    var name: String
    var address: String
    var neighborhood: String?
    var coordinates: Coordinates
    var cuisineTags: [CuisineTag]
    var dietaryTags: [DietaryTag]
    var priceRange: Int? // 1–4
    var photos: [URL]
    var rating: Double?
    var reviewCount: Int?
    var reviewSnippets: [Review]
    var hours: [DayHours]
    var sourceLinks: [SourceLink]
    var reservationSource: ReservationSource?
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
        coordinates: Coordinates,
        cuisineTags: [CuisineTag] = [],
        dietaryTags: [DietaryTag] = [],
        priceRange: Int? = nil,
        photos: [URL] = [],
        rating: Double? = nil,
        reviewCount: Int? = nil,
        reviewSnippets: [Review] = [],
        hours: [DayHours] = [],
        sourceLinks: [SourceLink] = [],
        reservationSource: ReservationSource? = nil,
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
        self.coordinates = coordinates
        self.cuisineTags = cuisineTags
        self.dietaryTags = dietaryTags
        self.priceRange = priceRange
        self.photos = photos
        self.rating = rating
        self.reviewCount = reviewCount
        self.reviewSnippets = reviewSnippets
        self.hours = hours
        self.sourceLinks = sourceLinks
        self.reservationSource = reservationSource
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

    func distanceMeters(from coord: CLLocationCoordinate2D) -> Double {
        let from = CLLocation(latitude: coord.latitude, longitude: coord.longitude)
        let to = CLLocation(latitude: coordinates.latitude, longitude: coordinates.longitude)
        return from.distance(from: to)
    }
}
