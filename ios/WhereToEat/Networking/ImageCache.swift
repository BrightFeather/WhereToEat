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
}
