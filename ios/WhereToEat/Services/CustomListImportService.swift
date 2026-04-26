import Foundation
import Combine

enum ImportSource {
    case googleMaps, yelp, xiaohongshu, generic
}

struct ImportedRestaurantDraft {
    var name: String
    var address: String?
    var latitude: Double?
    var longitude: Double?
    var phone: String?
    var website: URL?
    var photos: [URL]
    var rating: Double?
    var reviewCount: Int?
    var cuisineTags: [CuisineTag]
    var notes: String?
    var sourceLink: SourceLink
    /// All XHS posts that mentioned this restaurant. For an import flow
    /// today this is always the single pasted post, but the shape is
    /// future-proof for batch / multi-post imports.
    var xhsSources: [XHSSource]?
    // Enrichment data from backend (XHS imports)
    var googlePlaceId: String?
    var googleMapsUrl: URL?
    var instagramUrl: URL?
    var resyBookingUrl: URL?
    var opentableBookingUrl: URL?
}

// MARK: - XHS Import Response Models

struct XHSImportRestaurant: Codable {
    var name: String
    var address: String?
    var neighborhood: String?
    var cuisineType: String?
    var recommendation: String?
    /// Per-post evidence — mirrors `weekly.ts → sources[]`. Optional so older
    /// cached responses still decode; the synthesised single source from
    /// `recommendation` is used as a fallback in `importXiaohongshu`.
    var sources: [XHSSource]?
    var googlePlaceId: String?
    var googleMapsUrl: String?
    var photoUrls: [String]?
    var websiteUrl: String?
    var googleRating: Double?
    var googleUserRatingCount: Int?
    var instagramUrl: String?
    var resyBookingUrl: String?
    var opentableBookingUrl: String?
}

struct XHSImportData: Codable {
    var postTitle: String
    var postUrl: String
    var restaurants: [XHSImportRestaurant]
}

final class CustomListImportService: ObservableObject {

    func detectSource(from url: URL) -> ImportSource {
        if XHSURLParser.isXHSHost(url) { return .xiaohongshu }
        let host = url.host?.lowercased() ?? ""
        if host.contains("maps.app.goo.gl") || host.contains("goo.gl") ||
           host.contains("maps.google.com") || host.contains("google.com/maps") {
            return .googleMaps
        } else if host.contains("yelp.com") {
            return .yelp
        } else {
            return .generic
        }
    }

    func importURL(_ rawURL: String) async throws -> [ImportedRestaurantDraft] {
        guard let url = URL(string: rawURL) else {
            throw ImportError.invalidURL
        }

        let source = detectSource(from: url)

        switch source {
        case .xiaohongshu:
            return try await importXiaohongshu(url)
        case .googleMaps:
            return [try await importGoogleMaps(url)]
        case .yelp:
            return [try await importYelp(url)]
        case .generic:
            return [try await importGenericWebsite(url)]
        }
    }

    // MARK: - XHS (backend-powered, multi-restaurant)

    private func importXiaohongshu(_ url: URL) async throws -> [ImportedRestaurantDraft] {
        let response = try await APIClient.shared.request(
            .importXhs(url: url.absoluteString),
            as: XHSImportData.self
        )

        let postUrl = URL(string: response.postUrl) ?? url

        return response.restaurants.map { r in
            // Backend always sends `sources[]` now (single-element for an
            // import flow). Synthesise from `recommendation` when an older
            // backend response is cached without it.
            let sources: [XHSSource] = r.sources ?? [
                XHSSource(
                    postUrl: response.postUrl,
                    recommendation: r.recommendation,
                    likes: 0,
                    postCreatedAt: nil,
                    sourceType: "xiaohongshu",
                    author: nil,
                    sourceTitle: response.postTitle
                )
            ]
            return ImportedRestaurantDraft(
                name: r.name,
                address: r.address,
                photos: (r.photoUrls ?? []).compactMap { URL(string: $0) },
                rating: r.googleRating,
                reviewCount: r.googleUserRatingCount,
                cuisineTags: CuisineTag.from(string: r.cuisineType),
                notes: r.recommendation,
                sourceLink: SourceLink(platform: .xiaohongshu, url: postUrl),
                xhsSources: sources,
                googlePlaceId: r.googlePlaceId,
                googleMapsUrl: r.googleMapsUrl.flatMap { URL(string: $0) },
                instagramUrl: r.instagramUrl.flatMap { URL(string: $0) },
                resyBookingUrl: r.resyBookingUrl.flatMap { URL(string: $0) },
                opentableBookingUrl: r.opentableBookingUrl.flatMap { URL(string: $0) }
            )
        }
    }

    // MARK: - Private parsers (single-restaurant, client-side)

    private func importGoogleMaps(_ url: URL) async throws -> ImportedRestaurantDraft {
        let resolvedURL = try await resolveRedirects(url)
        let html = try await fetchHTML(resolvedURL)
        let og = parseOpenGraph(html)
        let schema = parseSchemaOrg(html)

        var name = og["og:title"] ?? schema["name"] ?? "Unknown"
        name = name.replacingOccurrences(of: " - Google Maps", with: "")
                   .replacingOccurrences(of: " – Google Maps", with: "")

        let address = schema["address"] ?? og["og:description"]
        let imageURL = (og["og:image"]).flatMap { URL(string: $0) }

        var lat: Double?
        var lng: Double?
        if let query = URLComponents(url: resolvedURL, resolvingAgainstBaseURL: false)?.queryItems {
            if let q = query.first(where: { $0.name == "q" })?.value {
                let parts = q.split(separator: ",")
                if parts.count == 2 {
                    lat = Double(parts[0])
                    lng = Double(parts[1])
                }
            }
        }
        if lat == nil, let path = URLComponents(url: resolvedURL, resolvingAgainstBaseURL: false)?.path {
            if let range = path.range(of: #"@(-?\d+\.\d+),(-?\d+\.\d+)"#, options: .regularExpression) {
                let matched = String(path[range]).dropFirst()
                let parts = matched.split(separator: ",")
                if parts.count >= 2 { lat = Double(parts[0]); lng = Double(parts[1]) }
            }
        }

        return ImportedRestaurantDraft(
            name: name.trimmingCharacters(in: .whitespaces),
            address: address,
            latitude: lat,
            longitude: lng,
            photos: [imageURL].compactMap { $0 },
            cuisineTags: [],
            sourceLink: SourceLink(platform: .google, url: resolvedURL)
        )
    }

    private func importYelp(_ url: URL) async throws -> ImportedRestaurantDraft {
        let resolvedURL = try await resolveRedirects(url)
        let html = try await fetchHTML(resolvedURL)
        let og = parseOpenGraph(html)
        let schema = parseSchemaOrg(html)

        var name = og["og:title"] ?? schema["name"] ?? "Unknown"
        name = name.components(separatedBy: " - Yelp").first ?? name

        let address = schema["address"]
        let imageURL = og["og:image"].flatMap { URL(string: $0) }
        let ratingStr = schema["ratingValue"]
        let rating = ratingStr.flatMap { Double($0) }

        return ImportedRestaurantDraft(
            name: name.trimmingCharacters(in: .whitespaces),
            address: address,
            photos: [imageURL].compactMap { $0 },
            rating: rating,
            cuisineTags: [],
            sourceLink: SourceLink(platform: .yelp, url: resolvedURL)
        )
    }

    private func importGenericWebsite(_ url: URL) async throws -> ImportedRestaurantDraft {
        let resolvedURL = try await resolveRedirects(url)
        let html = try await fetchHTML(resolvedURL)
        let og = parseOpenGraph(html)
        let schema = parseSchemaOrg(html)

        let name = og["og:title"] ?? schema["name"] ?? url.host ?? "Unknown"
        let address = schema["address"]
        let imageURL = og["og:image"].flatMap { URL(string: $0) }
        let description = og["og:description"] ?? schema["description"]

        return ImportedRestaurantDraft(
            name: name.trimmingCharacters(in: .whitespaces),
            address: address,
            website: resolvedURL,
            photos: [imageURL].compactMap { $0 },
            cuisineTags: [],
            notes: description,
            sourceLink: SourceLink(platform: .website, url: resolvedURL, rawContent: html)
        )
    }

    // MARK: - HTML utilities

    private func fetchHTML(_ url: URL) async throws -> String {
        var request = URLRequest(url: url)
        request.setValue("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) "
                       + "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
                         forHTTPHeaderField: "User-Agent")
        request.timeoutInterval = 15
        let (data, _) = try await URLSession.shared.data(for: request)
        return String(data: data, encoding: .utf8) ?? ""
    }

    private func resolveRedirects(_ url: URL) async throws -> URL {
        var request = URLRequest(url: url)
        request.setValue("Mozilla/5.0", forHTTPHeaderField: "User-Agent")
        let (_, response) = try await URLSession.shared.data(for: request)
        return (response as? HTTPURLResponse)?.url ?? url
    }

    /// Parse Open Graph meta tags from HTML string
    private func parseOpenGraph(_ html: String) -> [String: String] {
        var result: [String: String] = [:]
        let pattern = #"<meta[^>]+property="(og:[^"]+)"[^>]+content="([^"]*)"[^>]*/?>|<meta[^>]+content="([^"]*)"[^>]+property="(og:[^"]+)"[^>]*/?>"#
        guard let regex = try? NSRegularExpression(pattern: pattern, options: .caseInsensitive) else {
            return result
        }
        let range = NSRange(html.startIndex..., in: html)
        let matches = regex.matches(in: html, range: range)
        for match in matches {
            let groups = (1...4).compactMap { i -> String? in
                let r = match.range(at: i)
                guard r.location != NSNotFound, let range = Range(r, in: html) else { return nil }
                return String(html[range])
            }
            if groups.count >= 2 {
                if groups[0].hasPrefix("og:") {
                    result[groups[0]] = groups[1]
                } else if groups.count == 4 && groups[3].hasPrefix("og:") {
                    result[groups[3]] = groups[2]
                }
            }
        }
        return result
    }

    /// Parse basic schema.org JSON-LD from HTML string
    private func parseSchemaOrg(_ html: String) -> [String: String] {
        var result: [String: String] = [:]
        let pattern = #"<script[^>]+type="application/ld\+json"[^>]*>(.*?)</script>"#
        guard let regex = try? NSRegularExpression(pattern: pattern,
                                                    options: [.caseInsensitive, .dotMatchesLineSeparators]) else {
            return result
        }
        let range = NSRange(html.startIndex..., in: html)
        for match in regex.matches(in: html, range: range) {
            guard let jsonRange = Range(match.range(at: 1), in: html) else { continue }
            let json = String(html[jsonRange])
            guard let data = json.data(using: .utf8),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { continue }

            if let name = obj["name"] as? String { result["name"] = name }
            if let rating = (obj["aggregateRating"] as? [String: Any])?["ratingValue"] {
                result["ratingValue"] = "\(rating)"
            }
            if let addr = obj["address"] as? [String: Any] {
                let street = addr["streetAddress"] as? String ?? ""
                let city = addr["addressLocality"] as? String ?? ""
                let state = addr["addressRegion"] as? String ?? ""
                result["address"] = [street, city, state].filter { !$0.isEmpty }.joined(separator: ", ")
            } else if let addr = obj["address"] as? String {
                result["address"] = addr
            }
            if let desc = obj["description"] as? String { result["description"] = desc }
        }
        return result
    }
}

enum ImportError: LocalizedError {
    case invalidURL
    case fetchFailed
    case parseError

    var errorDescription: String? {
        switch self {
        case .invalidURL: return "Invalid URL"
        case .fetchFailed: return "Failed to fetch page"
        case .parseError: return "Could not parse restaurant info"
        }
    }
}
