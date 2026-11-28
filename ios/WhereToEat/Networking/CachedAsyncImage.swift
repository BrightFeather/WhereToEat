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
    @Environment(\.colorScheme) private var colorScheme

    init(url: URL?, @ViewBuilder content: @escaping (AsyncImagePhase) -> Content) {
        self.url = url
        self.content = content
    }

    var body: some View {
        content(phase)
            // Low light dark theme: photos ~8% dimmer so they don't glare.
            .brightness(colorScheme == .dark ? -0.08 : 0)
            .task(id: url) { await load() }
    }

    private func load() async {
        guard let url else {
            phase = .empty
            return
        }
        // 1) Synchronous cache hit. Instant; no async, no flicker.
        if let cached = ImageCache.cachedData(for: url),
           let img = UIImage(data: cached) {
            phase = .success(Image(uiImage: img))
            return
        }

        // 2) Cache miss. Joins an in-flight prefetch for the same URL if
        //    there is one. Layers 2–3 from the type doc live in
        //    `ImageCache.data(for:)`.
        do {
            let data = try await ImageCache.data(for: url)
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
