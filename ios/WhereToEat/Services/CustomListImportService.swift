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
    var cuisineTags: [CuisineTag]
    var notes: String?
    var sourceLink: SourceLink
}

final class CustomListImportService: ObservableObject {

    func detectSource(from url: URL) -> ImportSource {
        let host = url.host?.lowercased() ?? ""
        if host.contains("maps.app.goo.gl") || host.contains("goo.gl") ||
           host.contains("maps.google.com") || host.contains("google.com/maps") {
            return .googleMaps
        } else if host.contains("yelp.com") {
            return .yelp
        } else if host.contains("xiaohongshu.com") || host.contains("xhslink.com") {
            return .xiaohongshu
        } else {
            return .generic
        }
    }

    func importURL(_ rawURL: String) async throws -> ImportedRestaurantDraft {
        guard let url = URL(string: rawURL) else {
            throw ImportError.invalidURL
        }

        // Resolve redirects (goo.gl / xhslink short links)
        let resolvedURL = try await resolveRedirects(url)
        let source = detectSource(from: resolvedURL)

        switch source {
        case .googleMaps:
            return try await importGoogleMaps(resolvedURL)
        case .yelp:
            return try await importYelp(resolvedURL)
        case .xiaohongshu:
            return try await importXiaohongshu(resolvedURL)
        case .generic:
            return try await importGenericWebsite(resolvedURL)
        }
    }

    // MARK: - Private parsers

    private func importGoogleMaps(_ url: URL) async throws -> ImportedRestaurantDraft {
        // Fetch the page HTML and parse Open Graph / schema.org data
        let html = try await fetchHTML(url)
        let og = parseOpenGraph(html)
        let schema = parseSchemaOrg(html)

        // Extract place name from og:title (usually "Name - Google Maps")
        var name = og["og:title"] ?? schema["name"] ?? "Unknown"
        name = name.replacingOccurrences(of: " - Google Maps", with: "")
                   .replacingOccurrences(of: " – Google Maps", with: "")

        let address = schema["address"] ?? og["og:description"]
        let imageURL = (og["og:image"]).flatMap { URL(string: $0) }

        // Extract coordinates from URL if present (?q=lat,lng or @lat,lng)
        var lat: Double?
        var lng: Double?
        if let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems {
            if let q = query.first(where: { $0.name == "q" })?.value {
                let parts = q.split(separator: ",")
                if parts.count == 2 {
                    lat = Double(parts[0])
                    lng = Double(parts[1])
                }
            }
        }
        if lat == nil, let path = URLComponents(url: url, resolvingAgainstBaseURL: false)?.path {
            // @lat,lng,zoom pattern
            if let range = path.range(of: #"@(-?\d+\.\d+),(-?\d+\.\d+)"#, options: .regularExpression) {
                let matched = String(path[range]).dropFirst() // remove @
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
            sourceLink: SourceLink(platform: .google, url: url)
        )
    }

    private func importYelp(_ url: URL) async throws -> ImportedRestaurantDraft {
        let html = try await fetchHTML(url)
        let og = parseOpenGraph(html)
        let schema = parseSchemaOrg(html)

        var name = og["og:title"] ?? schema["name"] ?? "Unknown"
        // Yelp og:title is usually just the restaurant name
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
            sourceLink: SourceLink(platform: .yelp, url: url)
        )
    }

    private func importXiaohongshu(_ url: URL) async throws -> ImportedRestaurantDraft {
        let html = try await fetchHTML(url)
        let og = parseOpenGraph(html)

        let title = og["og:title"] ?? "Unknown"
        let description = og["og:description"] ?? ""
        let imageURL = og["og:image"].flatMap { URL(string: $0) }

        // Best-effort: use post title as name, description as notes
        return ImportedRestaurantDraft(
            name: title.trimmingCharacters(in: .whitespaces),
            photos: [imageURL].compactMap { $0 },
            cuisineTags: [],
            notes: description,
            sourceLink: SourceLink(platform: .xiaohongshu, url: url, rawContent: html)
        )
    }

    private func importGenericWebsite(_ url: URL) async throws -> ImportedRestaurantDraft {
        let html = try await fetchHTML(url)
        let og = parseOpenGraph(html)
        let schema = parseSchemaOrg(html)

        let name = og["og:title"] ?? schema["name"] ?? url.host ?? "Unknown"
        let address = schema["address"]
        let imageURL = og["og:image"].flatMap { URL(string: $0) }
        let description = og["og:description"] ?? schema["description"]

        return ImportedRestaurantDraft(
            name: name.trimmingCharacters(in: .whitespaces),
            address: address,
            website: url,
            photos: [imageURL].compactMap { $0 },
            cuisineTags: [],
            notes: description,
            sourceLink: SourceLink(platform: .website, url: url, rawContent: html)
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
        // Only follow redirects, don't load body
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
