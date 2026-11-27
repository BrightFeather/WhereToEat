import Foundation

/// Disk-backed `URLCache` for restaurant photos. `AsyncImage` uses
/// `URLSession.shared`, which respects `URLCache.shared` transparently — so
/// installing this once at app launch makes the second time we render a
/// photo come from disk instead of the network.
///
/// Capacity sized for ~2–3 typical sessions before LRU eviction kicks in:
///   - average Places photo at iOS render size: ~200 KB
///   - typical session: 50–100 restaurants × 3 photos = 30–60 MB
///   - 150 MB disk leaves comfortable headroom; the OS evicts least-
///     recently-used entries automatically when we approach the cap.
///
/// See `DESIGN-CACHING.md` § Image caching for the full sizing rationale.
enum ImageCache {
    static func install() {
        let memoryCapacity = 50 * 1_024 * 1_024
        let diskCapacity   = 150 * 1_024 * 1_024
        let cache = URLCache(
            memoryCapacity: memoryCapacity,
            diskCapacity: diskCapacity,
            directory: nil
        )
        URLCache.shared = cache
    }

    /// One download per URL at a time: a `CachedAsyncImage` that appears
    /// while a prefetch for the same photo is running awaits that prefetch
    /// instead of starting a second download.
    @MainActor private static var inFlight: [URL: Task<Data, Error>] = [:]

    static func cachedData(for url: URL) -> Data? {
        URLCache.shared.cachedResponse(for: URLRequest(url: url))?.data
    }

    @MainActor
    static func data(for url: URL) async throws -> Data {
        if let data = cachedData(for: url) { return data }
        if let task = inFlight[url] { return try await task.value }
        let task = Task { try await fetchAndStore(url) }
        inFlight[url] = task
        defer { inFlight[url] = nil }
        return try await task.value
    }

    /// Warm the cache for photos the user is about to see. Cache hits are
    /// skipped, so repeat calls cost nothing.
    @MainActor
    static func prefetch(_ urls: [URL]) {
        for url in urls where inFlight[url] == nil && cachedData(for: url) == nil {
            Task(priority: .utility) { _ = try? await data(for: url) }
        }
    }

    /// `returnCacheDataElseLoad` so an offline relaunch serves stored bytes
    /// instead of failing revalidation. Successful 200s are force-stored
    /// because some Google Places photo redirects send no-store / no
    /// Cache-Control at all.
    private static func fetchAndStore(_ url: URL) async throws -> Data {
        let request = URLRequest(url: url)
        var fallbackRequest = request
        fallbackRequest.cachePolicy = .returnCacheDataElseLoad
        let (data, response) = try await URLSession.shared.data(for: fallbackRequest)
        if let httpResp = response as? HTTPURLResponse {
            guard httpResp.statusCode == 200 else {
                throw HTTPStatusError(code: httpResp.statusCode)
            }
            URLCache.shared.storeCachedResponse(
                CachedURLResponse(response: response, data: data),
                for: request
            )
        }
        return data
    }

    /// The server answered, but not with the photo (404 expired, 403 blocked
    /// store, …). Distinct from `URLError` so callers can tell "this photo is
    /// dead" apart from "the phone is offline".
    struct HTTPStatusError: Error {
        let code: Int
    }
}
