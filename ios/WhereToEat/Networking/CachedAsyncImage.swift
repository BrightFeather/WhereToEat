import SwiftUI
import UIKit

/// Drop-in replacement for `AsyncImage` that survives going offline.
///
/// SwiftUI's `AsyncImage` uses `URLSession.shared` with `.useProtocolCachePolicy`,
/// which means: when offline, it tries to revalidate against the origin and
/// falls back to **failure**, not to the cached bytes. So even though
/// `URLCache.shared` has the photo on disk, the user sees a placeholder.
///
/// This view fixes that with two layers:
///   1. Synchronous lookup against `URLCache.shared.cachedResponse(for:)` —
///      instant render on cache hit, no network request kicked at all.
///   2. Network fetch with `cachePolicy = .returnCacheDataElseLoad` so even if
///      the origin response wasn't naturally cacheable, we serve any stored
///      bytes when revalidation fails (the common offline case).
///   3. On every successful 200, we force-`storeCachedResponse(...)` so future
///      offline launches always have the bytes regardless of the origin's
///      Cache-Control directives. (Vercel Blob is well-behaved; some Google
///      Places photo redirects are not.)
///
/// API mirrors the phase-based `AsyncImage(url:content:)` form so swapping it
/// in is a one-token change at call sites.
struct CachedAsyncImage<Content: View>: View {
    let url: URL?
    @ViewBuilder let content: (AsyncImagePhase) -> Content

    @State private var phase: AsyncImagePhase = .empty

    init(url: URL?, @ViewBuilder content: @escaping (AsyncImagePhase) -> Content) {
        self.url = url
        self.content = content
    }

    var body: some View {
        content(phase).task(id: url) { await load() }
    }

    private func load() async {
        guard let url else {
            phase = .empty
            return
        }
        let request = URLRequest(url: url)

        // 1) Synchronous cache hit. Instant; no async, no flicker.
        if let cached = URLCache.shared.cachedResponse(for: request),
           let img = UIImage(data: cached.data) {
            phase = .success(Image(uiImage: img))
            return
        }

        // 2) Cache miss. Use returnCacheDataElseLoad so an offline relaunch
        //    after the bytes were stored will still serve from cache rather
        //    than throwing a network error.
        var fallbackRequest = request
        fallbackRequest.cachePolicy = .returnCacheDataElseLoad

        do {
            let (data, response) = try await URLSession.shared.data(for: fallbackRequest)
            // 3) Force-cache successful 200s so the next offline launch
            //    always has the bytes — even if the origin sent
            //    Cache-Control: no-store or omitted directives entirely.
            if let httpResp = response as? HTTPURLResponse, httpResp.statusCode == 200 {
                URLCache.shared.storeCachedResponse(
                    CachedURLResponse(response: response, data: data),
                    for: request
                )
            }
            if let img = UIImage(data: data) {
                phase = .success(Image(uiImage: img))
            } else {
                phase = .failure(URLError(.cannotDecodeContentData))
            }
        } catch {
            phase = .failure(error)
        }
    }
}
