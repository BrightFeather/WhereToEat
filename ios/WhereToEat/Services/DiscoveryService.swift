import Foundation
import Combine
import CoreLocation

struct DiscoveryResult {
    var restaurants: [Restaurant]
    var errors: [String]  // non-fatal source errors
}

final class DiscoveryService: ObservableObject {
    static let shared = DiscoveryService()

    private let api = APIClient.shared

    struct ScrapeYelpItem: Decodable {
        var id: String
        var name: String
        var address: String
        var latitude: Double
        var longitude: Double
        var rating: Double?
        var reviewCount: Int?
        var categories: [String]
        var photos: [String]
        var phone: String?
        var url: String
    }

    struct ScrapeEaterItem: Decodable {
        var name: String
        var address: String?
        var sourceUrl: String
        var description: String?
        var imageUrl: String?
    }

    struct ScrapeXhsItem: Decodable {
        var name: String
        var address: String?
        var postUrl: String
        var imageUrls: [String]
        var content: String
        var likes: Int?
    }

    struct EnrichedRestaurant: Decodable {
        var name: String
        var address: String
        var neighborhood: String?
        var latitude: Double
        var longitude: Double
        var cuisineTags: [String]
        var dietaryTags: [String]
        var priceRange: Int?
        var photos: [String]
        var rating: Double?
        var reviewCount: Int?
        var reviews: [ReviewDTO]
        var hours: [DayHoursDTO]
        var phone: String?
        var website: String?
        var reservationSource: ReservationSourceDTO?

        struct ReviewDTO: Decodable {
            var platform: String
            var text: String
            var rating: Double?
            var date: String?
            var authorName: String?
        }

        struct DayHoursDTO: Decodable {
            var day: Int
            var openTime: String
            var closeTime: String
            var isClosed: Bool
        }

        struct ReservationSourceDTO: Decodable {
            var platform: String
            var venueId: String
            var directBookingURL: String?
        }
    }

    // MARK: - Main discovery entry point

    func fetchRestaurants(
        coordinates: CLLocationCoordinate2D,
        city: String,
        cuisines: [CuisineTag],
        dietaryPrefs: [DietaryTag],
        customList: [Restaurant],
        swipeHistory: [SwipeRecord]
    ) async -> DiscoveryResult {
        var all: [Restaurant] = []
        var errors: [String] = []

        // 1. Custom list (always first)
        all.append(contentsOf: customList)

        // 2. Yelp
        async let yelpTask = fetchYelp(coordinates: coordinates, cuisines: cuisines, dietaryPrefs: dietaryPrefs)
        // 3. Eater
        async let eaterTask = fetchEater(city: city)
        // 4. Xiaohongshu (best-effort)
        async let xhsTask = fetchXiaohongshu(coordinates: coordinates, cuisines: cuisines)

        let (yelpResult, eaterResult, xhsResult) = await (yelpTask, eaterTask, xhsTask)

        switch yelpResult {
        case .success(let items): all.append(contentsOf: items)
        case .failure(let e): errors.append("Yelp: \(e.localizedDescription)")
        }
        switch eaterResult {
        case .success(let items): all.append(contentsOf: items)
        case .failure(let e): errors.append("Eater: \(e.localizedDescription)")
        }
        switch xhsResult {
        case .success(let items): all.append(contentsOf: items)
        case .failure: break  // silently skip xhs failures
        }

        // Deduplicate
        let deduped = deduplicate(all)

        // Filter out blocked / already swiped this week
        let today = Date()
        let filtered = deduped.filter { restaurant in
            let record = swipeHistory.first { $0.restaurantId == restaurant.id }
            if let record {
                if record.decision == .blocked, let until = record.blockedUntil, today < until {
                    return false
                }
                if record.decision == .disliked {
                    // Resurface next week — only hide if swiped this week
                    let sameWeek = Calendar.current.isDate(record.timestamp,
                                                           equalTo: today, toGranularity: .weekOfYear)
                    return !sameWeek
                }
                if record.decision == .liked {
                    // If booked, hide for 4 weeks (handled via block); if not booked, show at top
                    return true
                }
            }
            return true
        }

        // Rank: custom first, then liked-not-booked, then yelp popularity
        let ranked = rank(filtered, swipeHistory: swipeHistory)
        return DiscoveryResult(restaurants: ranked, errors: errors)
    }

    // MARK: - Enrichment

    func enrich(_ restaurant: Restaurant) async -> Restaurant {
        do {
            let enriched: EnrichedRestaurant = try await api.request(
                .enrichRestaurant(name: restaurant.name,
                                  lat: restaurant.coordinates.latitude,
                                  lng: restaurant.coordinates.longitude)
            )
            return mergeEnrichment(enriched, into: restaurant)
        } catch {
            return restaurant
        }
    }

    // MARK: - Private fetch helpers

    private func fetchYelp(
        coordinates: CLLocationCoordinate2D,
        cuisines: [CuisineTag],
        dietaryPrefs: [DietaryTag]
    ) async -> Result<[Restaurant], Error> {
        // Yelp search via backend
        struct YelpSearchResponse: Decodable { var businesses: [ScrapeYelpItem] }
        do {
            // We use the enrich endpoint which calls Yelp internally;
            // for discovery we call scrapeEater with yelp context via the enrich chain.
            // In practice, the iOS app calls the backend /places/enrich for each candidate.
            // For batch discovery, we treat Yelp results from the backend scrape endpoint.
            let response: [ScrapeYelpItem] = try await api.request(
                .scrapeXiaohongshu(lat: coordinates.latitude, lng: coordinates.longitude,
                                   cuisines: cuisines.map(\.rawValue))
            )
            return .success(response.map { yelpItemToRestaurant($0) })
        } catch {
            return .failure(error)
        }
    }

    private func fetchEater(city: String) async -> Result<[Restaurant], Error> {
        do {
            let items: [ScrapeEaterItem] = try await api.request(.scrapeEater(city: city))
            return .success(items.map { eaterItemToRestaurant($0) })
        } catch {
            return .failure(error)
        }
    }

    private func fetchXiaohongshu(
        coordinates: CLLocationCoordinate2D,
        cuisines: [CuisineTag]
    ) async -> Result<[Restaurant], Error> {
        do {
            let items: [ScrapeXhsItem] = try await api.request(
                .scrapeXiaohongshu(lat: coordinates.latitude, lng: coordinates.longitude,
                                   cuisines: cuisines.map(\.rawValue))
            )
            return .success(items.map { xhsItemToRestaurant($0) })
        } catch {
            return .failure(error)
        }
    }

    // MARK: - Deduplication

    /// Fuzzy dedup: same name (case-insensitive, stripped) + within 50m
    private func deduplicate(_ restaurants: [Restaurant]) -> [Restaurant] {
        var result: [Restaurant] = []
        for restaurant in restaurants {
            if let existingIndex = result.firstIndex(where: { isDuplicate($0, restaurant) }) {
                // Merge source links
                var merged = result[existingIndex]
                let newLinks = restaurant.sourceLinks.filter { link in
                    !merged.sourceLinks.contains(where: { $0.url == link.url })
                }
                merged.sourceLinks.append(contentsOf: newLinks)
                result[existingIndex] = merged
            } else {
                result.append(restaurant)
            }
        }
        return result
    }

    private func isDuplicate(_ a: Restaurant, _ b: Restaurant) -> Bool {
        let nameMatch = normalize(a.name) == normalize(b.name)
        let loc1 = CLLocation(latitude: a.coordinates.latitude, longitude: a.coordinates.longitude)
        let loc2 = CLLocation(latitude: b.coordinates.latitude, longitude: b.coordinates.longitude)
        let distanceMatch = loc1.distance(from: loc2) < 50
        return nameMatch && distanceMatch
    }

    private func normalize(_ name: String) -> String {
        name.lowercased()
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .components(separatedBy: .punctuationCharacters).joined()
    }

    // MARK: - Ranking

    private func rank(_ restaurants: [Restaurant], swipeHistory: [SwipeRecord]) -> [Restaurant] {
        restaurants.sorted { a, b in
            let aIsCustom = a.isCustom
            let bIsCustom = b.isCustom
            if aIsCustom != bIsCustom { return aIsCustom }

            let aLikedNotBooked = swipeHistory.contains { $0.restaurantId == a.id && $0.decision == .liked }
            let bLikedNotBooked = swipeHistory.contains { $0.restaurantId == b.id && $0.decision == .liked }
            if aLikedNotBooked != bLikedNotBooked { return aLikedNotBooked }

            let aScore = (a.rating ?? 0) * Double(a.reviewCount ?? 0)
            let bScore = (b.rating ?? 0) * Double(b.reviewCount ?? 0)
            return aScore > bScore
        }
    }

    // MARK: - Model mapping

    private func yelpItemToRestaurant(_ item: ScrapeYelpItem) -> Restaurant {
        Restaurant(
            name: item.name,
            address: item.address,
            coordinates: Coordinates(latitude: item.latitude, longitude: item.longitude),
            sourceOrigin: .yelp,
            cuisineTags: item.categories.compactMap { CuisineTag(rawValue: $0.lowercased()) },
            photos: item.photos.compactMap { URL(string: $0) },
            rating: item.rating,
            reviewCount: item.reviewCount,
            sourceLinks: [SourceLink(platform: .yelp, url: URL(string: item.url)!)]
        )
    }

    private func eaterItemToRestaurant(_ item: ScrapeEaterItem) -> Restaurant {
        Restaurant(
            name: item.name,
            address: item.address ?? "",
            coordinates: Coordinates(latitude: 0, longitude: 0),
            sourceOrigin: .eater,
            photos: [item.imageUrl].compactMap { $0.flatMap { URL(string: $0) } },
            sourceLinks: [SourceLink(platform: .eater, url: URL(string: item.sourceUrl)!)],
            notes: item.description
        )
    }

    private func xhsItemToRestaurant(_ item: ScrapeXhsItem) -> Restaurant {
        Restaurant(
            name: item.name,
            address: item.address ?? "",
            coordinates: Coordinates(latitude: 0, longitude: 0),
            sourceOrigin: .xhs,
            photos: item.imageUrls.compactMap { URL(string: $0) },
            sourceLinks: [SourceLink(platform: .xiaohongshu, url: URL(string: item.postUrl)!,
                                     rawContent: item.content)],
            notes: item.content
        )
    }

    private func mergeEnrichment(_ enriched: EnrichedRestaurant, into restaurant: Restaurant) -> Restaurant {
        var updated = restaurant
        updated.address = enriched.address
        updated.neighborhood = enriched.neighborhood
        updated.coordinates = Coordinates(latitude: enriched.latitude, longitude: enriched.longitude)
        updated.cuisineTags = enriched.cuisineTags.compactMap { CuisineTag(rawValue: $0) }
        updated.dietaryTags = enriched.dietaryTags.compactMap { DietaryTag(rawValue: $0) }
        updated.priceRange = enriched.priceRange
        updated.photos = enriched.photos.compactMap { URL(string: $0) }
        updated.rating = enriched.rating
        updated.reviewCount = enriched.reviewCount
        updated.phone = enriched.phone
        updated.website = enriched.website.flatMap { URL(string: $0) }
        updated.enrichedAt = Date()

        updated.reviewSnippets = enriched.reviews.map {
            Review(platform: ReviewPlatform(rawValue: $0.platform) ?? .google,
                   text: $0.text, rating: $0.rating, authorName: $0.authorName)
        }
        updated.hours = enriched.hours.map {
            DayHours(day: $0.day, openTime: $0.openTime, closeTime: $0.closeTime, isClosed: $0.isClosed)
        }
        if let rs = enriched.reservationSource {
            updated.reservationSource = ReservationSource(
                platform: ReservationPlatform(rawValue: rs.platform) ?? .other,
                venueId: rs.venueId,
                directBookingURL: rs.directBookingURL.flatMap { URL(string: $0) }
            )
        }
        return updated
    }
}
