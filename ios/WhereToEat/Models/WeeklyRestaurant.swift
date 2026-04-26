import Foundation

/// One source row that mentioned a restaurant — matches the `sources[]` array
/// element shape returned by `GET /api/restaurants/weekly` and by
/// `/api/restaurants/import-xhs`. Sorted by likes desc by the backend.
///
/// The struct is polymorphic over `xhs_sources.source_type` — despite the
/// historical `XHS*` name, rows can carry `xiaohongshu`, `eater`, or
/// `resy_blog`. The legacy name stays for source-compat with cached
/// UserDefaults payloads.
struct XHSSource: Codable, Identifiable, Hashable {
    var postUrl: String
    var recommendation: String?
    var likes: Int
    var postCreatedAt: String?
    /// Polymorphic source type. Optional so older cached rows still decode.
    /// Known values: `"xiaohongshu"`, `"eater"`, `"resy_blog"`.
    var sourceType: String?
    /// Creator / editor byline.
    var author: String?
    /// Article or post title — used as the secondary byline on detail quotes.
    var sourceTitle: String?

    /// Stable id for SwiftUI ForEach. Post URL uniquely identifies a source
    /// within a restaurant, which is all we need.
    var id: String { postUrl }

    /// Resolved source-type key. Defaults to xiaohongshu so older cached rows
    /// (when `sourceType` was absent) keep their existing rendering.
    var resolvedType: String { sourceType ?? "xiaohongshu" }

    var displayPlatform: String {
        switch resolvedType {
        case "xiaohongshu": return "小红书"
        case "eater":       return "Eater"
        case "resy_blog":   return "Resy"
        default:            return resolvedType.capitalized
        }
    }
}

/// Matches the shape returned by GET /api/restaurants/weekly
struct WeeklyRestaurant: Codable, Identifiable {
    var id: String
    var restaurantName: String
    var address: String?
    var borough: String?
    var neighborhood: String?
    var cuisineType: String?
    /// Canonical feature keys (see backend/api/_lib/features.ts). Keys like
    /// "sichuan", "omakase", "coffee", "brunch", "cocktails". Filters and
    /// card-surface chips render from this.
    var features: [String]?
    var recommendation: String?
    var postUrl: String?
    var postCreatedAt: String?
    var mentionCount: Int
    var totalLikes: Int
    var googlePlaceId: String?
    var googleMapsUrl: String?
    var googleDisplayName: String?
    var websiteUrl: String?
    var photoUrl: String?
    var photoUrls: [String]?
    /// Google Maps overall rating (e.g. 4.7) and review count.
    var googleRating: Double?
    var googleUserRatingCount: Int?
    /// Best-effort Instagram profile URL — null when no link found on the
    /// restaurant's Google-Places-listed website.
    var instagramUrl: String?
    var resyBookingUrl: String?
    var opentableBookingUrl: String?
    /// Every XHS post that mentioned this restaurant (dedupe by post URL,
    /// sorted by likes desc by the backend). Drives the multi-quote card.
    var sources: [XHSSource]?

    /// Convert to the unified Restaurant model used by the card deck
    func toRestaurant() -> Restaurant {
        let googleMapsLink = googleMapsUrl.flatMap { URL(string: $0) }
        let resyUrl = resyBookingUrl.flatMap { URL(string: $0) }
        let opentableUrl = opentableBookingUrl.flatMap { URL(string: $0) }
        let bookingUrl = resyUrl ?? opentableUrl ?? websiteUrl.flatMap { URL(string: $0) } ?? googleMapsLink

        // Use multi-photo array when available, fall back to single photoUrl
        let photos: [URL] = (photoUrls?.isEmpty == false ? photoUrls! : photoUrl.map { [$0] } ?? [])
            .compactMap { URL(string: $0) }

        let reservationSrc: ReservationSource?
        if let resyUrl {
            reservationSrc = ReservationSource(platform: .resy, venueId: "", directBookingURL: resyUrl)
        } else if let opentableUrl {
            reservationSrc = ReservationSource(platform: .opentable, venueId: "", directBookingURL: opentableUrl)
        } else {
            reservationSrc = nil
        }

        // Build sourceLinks from every XHS post, not just the top one.
        // Fallback to the denormalised `postUrl` when the backend didn't
        // return a sources array (older cached response).
        let sourceLinks: [SourceLink]
        if let sources, !sources.isEmpty {
            sourceLinks = sources.compactMap { src in
                URL(string: src.postUrl).map {
                    SourceLink(platform: .xiaohongshu, url: $0)
                }
            }
        } else if let postUrl, let url = URL(string: postUrl) {
            sourceLinks = [SourceLink(platform: .xiaohongshu, url: url)]
        } else {
            sourceLinks = []
        }

        return Restaurant(
            id: UUID(uuidString: id) ?? UUID(),
            name: googleDisplayName ?? restaurantName,
            address: address ?? neighborhood ?? borough ?? "",
            neighborhood: neighborhood,
            borough: borough,
            coordinates: Coordinates(latitude: 0, longitude: 0),
            googleMapsLink: googleMapsLink,
            googlePlaceId: googlePlaceId,
            bookingUrl: bookingUrl,
            sourceOrigin: .xhs,
            xhsRecommendation: recommendation,
            rawCuisineType: cuisineType,
            features: features,
            xhsSources: sources,
            photos: photos,
            rating: googleRating,
            reviewCount: googleUserRatingCount,
            sourceLinks: sourceLinks,
            reservationSource: reservationSrc,
            instagramUrl: instagramUrl.flatMap { URL(string: $0) }
        )
    }
}

/// Matches the wrapper returned by the weekly endpoint
struct WeeklyResponse: Codable {
    /// "ready", "building", or "stale"
    var status: String
    var restaurants: [WeeklyRestaurant]?
    var pipelineStartedAt: String?
}
