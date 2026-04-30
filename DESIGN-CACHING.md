# Design — On-Device Weekly Cache

**Status:** Approved 2026-04-28. Ready to implement.
**Scope:** Reduce backend DB load by caching the weekly deck (and its photos) on-device. First implementation pass; covers JSON + image caching only — user-scoped data (reservations, blocks) is out of scope.

---

## Problem

Every cold start currently calls `GET /api/restaurants/weekly`, which fans out to:

1. One `pipeline_runs` lookup
2. One `SELECT *` from `xhs_restaurants`
3. **One `xhs_sources` query per restaurant** (~600 round-trips today, growing with the deck)

Every cold start. As the user base grows this saturates Neon and bills Vercel function-time for data the device already saw five minutes ago.

## Goals

1. Cold-start with no network call when the cache is fresh.
2. Daily background refresh — keep up with mid-week hotfixes (closed restaurants, photo swaps) without being chatty.
3. Cache the photos that actually get displayed so the second swipe through is instant and works offline.
4. Etag scheme that **doesn't depend on where the parse ran** — pipeline output may come from the Vercel cron, the user's laptop pushed via `npm run push-data`, or (future) a daily cron. Cache must invalidate correctly in all three.

## Non-goals

- User-scoped endpoints (`/api/user/reservations`, `/api/user/blocks`, `/api/user/ensure`) — already cached per-device by their own services. Out of scope.
- Custom-list `import-xhs` results — one-shot user action, not worth caching.
- Full offline mode for the rest of the app. We only handle "open the app within 24h, see content immediately."

---

## Freshness model

| age of cache | UI behavior on cold start | network behavior |
|---|---|---|
| 0–6 h | render cache, **no fetch** | none |
| 6–24 h (warm) | render cache immediately, status `.ready` | background `If-None-Match`; replace silently if 200, no-op if 304 |
| > 24 h or no cache | render cache if any (as `.stale`), else `.building` | foreground fetch + full hydrate |

Background refresh is **invisible** — no spinner, no banner. The user only sees a state change if the cache becomes empty (`.building`) or fetch errors when there's no fallback.

Pull-to-refresh always forces a foreground network call regardless of age.

---

## Etag — derived from data state

The etag is computed on the server from the data, not from `pipeline_run_id`. This keeps it correct whether the parse ran on Vercel cron or on the user's laptop + `npm run push-data`.

```
etag = max(xhs_restaurants.updated_at WHERE is_available_this_week = 1)
       || (fallback) max(pipeline_runs.completed_at)
```

**Schema:** add `updated_at TIMESTAMPTZ NOT NULL DEFAULT now()` to `xhs_restaurants` and `xhs_sources` (with an `ON UPDATE` trigger or explicit `SET updated_at = now()` in every UPDATE — Postgres doesn't auto-update like MySQL). The push-data script already does INSERT or UPSERT, so as long as the column has `DEFAULT now()` and UPSERT sets it, this works for both ingestion paths.

The handler:

1. Reads `latestCompleted` (already does).
2. Reads `MAX(updated_at)` from `xhs_restaurants` (filtered to `is_available_this_week = 1`). One indexed query.
3. Computes `etag` = ISO string of that timestamp.
4. Compares `req.headers['if-none-match']` to the etag. If match → `304 Not Modified`, no body, no further work.
5. Else → does today's full hydration and returns 200 with `etag` in the response body **and** `ETag` response header.

**304 wins big**: skip the 600× `xhs_sources` round-trip when nothing has changed. The DB cost of an unchanged-deck request collapses to a single `MAX(updated_at)` indexed read.

## Optional: Vercel KV layer (Stage 2)

Once the etag is in place, add a single Vercel KV cache: key `weekly:{city}:{etag}`, value = the full JSON body, TTL 7d. The handler checks KV before hydrating. Even 200 responses then skip Neon entirely. **Not required for v1** — defer until Neon shows pressure.

---

## iOS surface area

```
ios/WhereToEat/Services/
├── WeeklyRestaurantService.swift        # MODIFIED — bootstrap() + cache wiring
└── WeeklyCache.swift                    # NEW — read/write/invalidate

ios/WhereToEat/Networking/
├── APIClient.swift                      # MODIFIED — If-None-Match support, 304 result
└── ImageCache.swift                     # NEW — URLCache config + cached AsyncImage

ios/WhereToEat/App/
└── WhereToEatApp.swift                  # MODIFIED — call bootstrap() instead of fetch()
```

Subscribers (`HomeView`, `DiscoveryViewModel`, `FindView`) read `WeeklyRestaurantService.$status` — no changes there.

### `WeeklyCache.swift` shape

```swift
struct WeeklyCacheEntry: Codable {
    let savedAt: Date
    let etag: String
    let weekStart: Date
    let city: String
    let restaurants: [WeeklyRestaurant]
}

@MainActor
final class WeeklyCache {
    static let shared = WeeklyCache()

    private let fileURL: URL  // Caches/weekly_v1.json
    private(set) var cached: WeeklyCacheEntry?

    func load() -> WeeklyCacheEntry?
    func save(_ entry: WeeklyCacheEntry) throws
    func invalidate()

    // Convenience age helpers
    var ageHours: Double? { ... }
    var isFresh: Bool   { ageHours.map { $0 < 6 }  ?? false }
    var isWarm:  Bool   { ageHours.map { $0 < 24 } ?? false }
}
```

### `WeeklyRestaurantService.bootstrap()`

```swift
func bootstrap(city: String = "nyc") async {
    if let entry = WeeklyCache.shared.load(), entry.city == city {
        // Always publish cache first — UI never sees an empty state on cold start.
        status = entry.weekStart == currentWeekStart()
                 ? .ready(entry.restaurants)
                 : .stale(entry.restaurants)

        if WeeklyCache.shared.isFresh { return }                  // 0–6h: stop
        if WeeklyCache.shared.isWarm  { Task { await refreshIfChanged(city: city) }; return }
        // > 24h: fall through to foreground fetch
    }
    await fetch(city: city)  // existing path
}

private func refreshIfChanged(city: String) async {
    do {
        let result = try await api.requestConditional(.weeklyRestaurants(city: city),
                                                      ifNoneMatch: WeeklyCache.shared.cached?.etag,
                                                      as: WeeklyResponse.self)
        switch result {
        case .notModified:
            try? WeeklyCache.shared.bumpSavedAt()                 // reset 24h timer
        case .ok(let wrapper, let etag):
            apply(wrapper, city: city)
            if let list = wrapper.restaurants {
                try? WeeklyCache.shared.save(.init(savedAt: .now,
                                                   etag: etag,
                                                   weekStart: currentWeekStart(),
                                                   city: city,
                                                   restaurants: list))
            }
        }
    } catch { /* invisible failure — keep showing cached deck */ }
}
```

### `markUnavailable(id:)` mutation

Already mutates in-memory `status`. Mirror the same edit to disk so the row stays gone after restart:

```swift
if var entry = WeeklyCache.shared.cached {
    entry.restaurants.removeAll { $0.id == id }
    try? WeeklyCache.shared.save(entry)
}
```

### `APIClient` change

Add a typed conditional-request helper:

```swift
enum ConditionalResult<T> { case notModified; case ok(T, etag: String) }

func requestConditional<T: Decodable>(
    _ endpoint: Endpoint,
    ifNoneMatch: String?,
    as type: T.Type
) async throws -> ConditionalResult<T>
```

Reads `ETag` from response headers; treats HTTP 304 as `.notModified`. All other endpoints continue to use the existing `request(...)` and ignore caching.

---

## Image caching

### Strategy

`URLCache.shared` configured at app launch — disk-backed, LRU eviction, transparent to `URLSession` and therefore transparent to `AsyncImage` (which uses URLSession under the hood).

### Capacity recommendation

- **Disk: 150 MB**
- **Memory: 50 MB**

Sizing rationale:

- ~600 canonical restaurants × ~3 photos average → ~1,800 photos in the deck.
- Typical iOS render-sized Places photo: ~150–300 KB. Average ~200 KB.
- Caching the entire deck would be ~360 MB. **Too big.**
- A typical session shows 50–100 restaurants × 3 photos = 150–300 photos = 30–60 MB. **Comfortably below 150 MB.**
- 150 MB leaves 2–3 sessions of headroom before LRU eviction kicks in. Past that, eviction silently drops least-recently-viewed photos and the cache is self-healing.

Recommendation: **150 MB / 50 MB**, no prefetch. First time a restaurant appears, photo downloads; every subsequent time it's instant. If we later want every restaurant's *first* photo to be instant from the start, add a one-shot post-deck-load prefetch (~600 × 200 KB ≈ 120 MB — still fits in 150 MB but bumps cold-start network usage). Defer that until we see evidence it matters.

### Implementation

```swift
// ios/WhereToEat/Networking/ImageCache.swift
enum ImageCache {
    static func install() {
        let cache = URLCache(memoryCapacity: 50 * 1_024 * 1_024,
                             diskCapacity: 150 * 1_024 * 1_024,
                             directory: nil)
        URLCache.shared = cache
    }
}
```

Called once from `WhereToEatApp.init()`. `AsyncImage(url:)` calls then transparently use the disk cache via `URLSession.shared`.

### Image sources to cache

Already pulled through `AsyncImage`:

- `WeeklyRestaurant.photoUrl` (single primary).
- `WeeklyRestaurant.photoUrls` (carousel on detail page).

Both are mirrored to Vercel Blob (`@vercel/blob`). Blob URLs are stable as long as a photo isn't re-uploaded by the pipeline — re-upload changes the URL, which means the old cached entry becomes orphaned and gets LRU-evicted naturally. No manual invalidation needed.

---

## Cache invalidation triggers (full list)

1. **24h TTL** — drives the daily background refresh.
2. **`weekStart` rollover** — when `currentWeekStart()` differs from `cached.weekStart` on bootstrap, force foreground fetch.
3. **Etag change** — server signals new content; client replaces and resets `savedAt`.
4. **`markUnavailable(id:)`** — mirror in-memory deletion to disk.
5. **Pull-to-refresh** — explicit user action; force network.
6. **Settings → Clear Cache** (debug toggle, optional v1) — wipe both `weekly_v1.*` and `URLCache.shared`.

---

## Future: daily parsing cadence

When the pipeline schedule moves from weekly to daily (TASKS.md follow-up), the only change is the `vercel.json` cron from `0 10 * * 1` → `0 10 * * *`. Everything in this design — TTL, etag, cache mechanics — already aligns with daily updates.

The path where the user runs parsing **on their laptop** and pushes via `npm run push-data` is supported by the etag-from-`max(updated_at)` design: the push updates `updated_at` (column default + UPSERT), the next iOS request sees a new etag, the cache rolls over. No special flag needed in the response — both ingestion paths look identical to the client.

---

## Implementation plan

Ordered so each step ships a working app. Each is a small, reviewable change.

### Step 1 — server etag + 304 ✅ Done (2026-04-28)

- Added `updated_at` column + AFTER-UPDATE trigger on both dialects.
- `weekly.ts` computes `etag = MAX(updated_at)`, sets `ETag` header, returns 304 on `If-None-Match`.

### Step 2 — iOS `WeeklyCache` + `bootstrap()` ✅ Done (2026-04-28)

- `WeeklyCache.swift` (Caches/weekly_v1.json), tiered freshness (0–6h / 6–24h / >24h).
- `WeeklyRestaurantService.bootstrap()` + `APIClient.requestConditional(...)`.
- `markUnavailable` mirrors disk deletion.

### Step 3 — image `URLCache` ✅ Done (2026-04-28)

- `ImageCache.install()` configures `URLCache.shared` (150 MB disk / 50 MB memory).
- `AsyncImage` rides `URLSession.shared` transparently.

### Step 4 — etag stability + edge cache + N+1 fix ✅ Done (2026-04-29)

Round-2 changes after profiling: (a) `MAX(updated_at)` etag flipped to a **content-hash etag** so backfills that touch internal-only columns don't cascade-invalidate every device; (b) cache headers switched from `private` to `public, s-maxage=300, stale-while-revalidate=86400` so Vercel's edge serves repeated 200s without function execution; (c) `hydrateSources` collapsed from N+1 (one query per restaurant, ~600 round-trips) into a single `IN (...)` query via a synthesized `TemplateStringsArray`.

**Etag projection (load-bearing):** every column the iOS client renders **must** appear in the etag projection in `weekly.ts`. If a column is omitted, a server-side backfill of just that column will be invisible to the client — the conditional cache returns 304 with stale data and the new field never propagates. The 2026-04-29 deploy initially missed `price_level`, which silently broke the $/$$/$$$/$$$$ chip after the price-level backfill until added. The current projection: `id, photo_url, google_rating, google_user_rating_count, recommendation, features, instagram_url, resy_booking_url, opentable_booking_url, mention_count, total_likes, post_created_at, latitude, longitude, price_level` plus a separate hash over `xhs_sources(restaurant_id, post_url, likes, source_type)`. Adding any new response-shape column to `WeeklyRestaurant` is a two-edit change: (1) include it in the row SELECT in `fetchAvailable`, (2) add it to the etag projection.

**Single-query hydrate gotcha:** the tagged-template doesn't accept a runtime-built `IN (...)` natively, so we synthesize a `TemplateStringsArray` (`[head, ',', ',', …, tail]`) and call `sql(tsa, ...ids)` directly. This produces a normal parameterized query — `$1, $2, …` on Neon, `?, ?, …` on SQLite. No raw-string interpolation, no injection surface. The `sqlRaw` helper added to `db.ts` was an early experiment using Neon's `sql.query(...)` — left in place for future use, but unused on the hot path.

### Step 5 — (deferred) Vercel KV layer

Only if Neon shows pressure after Step 4. Edge caching (Step 4) handles the bulk of repeated requests; KV would close the gap when an etag changes and the edge needs to pull a fresh body. Add a `weekly:{city}:{etag}` cache in front of the hydration step. Defer until measured.

---

## Open follow-ups (track in TASKS.md, not now)

- Vercel KV cache (Step 5 above) — defer until measured.
- Photo-prefetch-after-deck-load — defer until users complain about first-card lag.
- Etag-coordinated caching for `/api/user/reservations` + `/api/user/blocks` — same `If-None-Match` discipline as `/weekly`.
- Bootstrap-time prefetch of the 3 home-pick photos so the first home view is instant.
- iOS TTL bump (24h → 72h) — pipeline runs weekly, so 24h sends 7× more conditional requests than necessary.
- Settings → "Clear cache" debug button — nice-to-have for QA.
- Memory-pressure hook — `URLCache.shared.removeAllCachedResponses()` on `didReceiveMemoryWarning`.
- Hit/miss telemetry — `logger.success('weekly.{not_modified|served.ready|served.stale}')` rolled up in a daily Vercel log query, to decide whether KV is worth adding now or in three months.
- Migrate the cron from weekly to daily once the pipeline is reliable enough to run nightly without human supervision (separate discussion).
