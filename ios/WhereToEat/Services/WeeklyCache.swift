import Foundation

/// Disk-backed cache for the `/api/restaurants/weekly` response.
///
/// Why this exists: every cold start used to fan out to ~600 Neon queries
/// (one per `xhs_sources` row). With this cache the client renders the last
/// payload immediately and only goes back to the server when the 24h TTL
/// expires — and even then sends `If-None-Match` so unchanged data costs a
/// single indexed `MAX(updated_at)` read on the server.
///
/// See `DESIGN-CACHING.md` for the full rationale + freshness tiers.
struct WeeklyCacheEntry: Codable {
    let savedAt: Date
    let etag: String?
    let weekStart: Date
    let city: String
    var restaurants: [WeeklyRestaurant]
}

@MainActor
final class WeeklyCache {
    static let shared = WeeklyCache()

    // Bump the suffix when the cached payload shape changes so old caches
    // are dropped on next launch. v1 → v2 added `priceLevel` (D23/D23c).
    // v2 → v3 (2026-05-03) busted on a fresh DB import so users pick up the
    // new pool immediately instead of sitting on the 24h-warm cached payload.
    private static let fileName = "weekly_v3.json"

    private(set) var cached: WeeklyCacheEntry?

    private init() {
        // Best-effort cleanup of legacy cache files. Cheap on cold start.
        for legacy in ["weekly_v1.json", "weekly_v2.json"] {
            let url = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
                .appendingPathComponent(legacy)
            if FileManager.default.fileExists(atPath: url.path) {
                try? FileManager.default.removeItem(at: url)
            }
        }
        cached = loadFromDisk()
    }

    // MARK: - Freshness

    /// 0–6h. Cold-start path skips the network entirely.
    var isFresh: Bool { ageHours.map { $0 < 6 } ?? false }
    /// 6–24h. Cold-start renders cache immediately + kicks invisible refresh.
    var isWarm:  Bool { ageHours.map { $0 < 24 } ?? false }

    var ageHours: Double? {
        guard let saved = cached?.savedAt else { return nil }
        return Date().timeIntervalSince(saved) / 3600
    }

    // MARK: - Mutations

    func save(_ entry: WeeklyCacheEntry) {
        cached = entry
        writeToDisk(entry)
    }

    /// Caller already has the same etag from the server (304 path) — just
    /// reset the 24h timer so we don't re-check on every cold start.
    func bumpSavedAt() {
        guard var entry = cached else { return }
        entry = WeeklyCacheEntry(
            savedAt: .now,
            etag: entry.etag,
            weekStart: entry.weekStart,
            city: entry.city,
            restaurants: entry.restaurants
        )
        save(entry)
    }

    /// Mirrors `WeeklyRestaurantService.markUnavailable` so the row stays gone
    /// after an app restart instead of zombie-ing back into the deck.
    func removeRestaurant(id: String) {
        guard var entry = cached else { return }
        entry.restaurants.removeAll { $0.id == id }
        save(entry)
    }

    func invalidate() {
        cached = nil
        try? FileManager.default.removeItem(at: fileURL())
    }

    // MARK: - Disk IO

    private func loadFromDisk() -> WeeklyCacheEntry? {
        let url = fileURL()
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        do {
            let data = try Data(contentsOf: url)
            let decoder = JSONDecoder()
            decoder.dateDecodingStrategy = .iso8601
            return try decoder.decode(WeeklyCacheEntry.self, from: data)
        } catch {
            print("[WeeklyCache] decode failed: \(error.localizedDescription) — discarding")
            try? FileManager.default.removeItem(at: url)
            return nil
        }
    }

    private func writeToDisk(_ entry: WeeklyCacheEntry) {
        let url = fileURL()
        do {
            let encoder = JSONEncoder()
            encoder.dateEncodingStrategy = .iso8601
            let data = try encoder.encode(entry)
            try data.write(to: url, options: .atomic)
        } catch {
            print("[WeeklyCache] write failed: \(error.localizedDescription)")
        }
    }

    private func fileURL() -> URL {
        let dir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        return dir.appendingPathComponent(Self.fileName)
    }
}

/// Monday 00:00 in the user's local time zone — used to detect deck rollover
/// independent of the 24h savedAt TTL. The pipeline runs Mondays at 10:00,
/// so a cache from last Monday should always force a fresh fetch.
func currentWeekStart(now: Date = .now, calendar: Calendar = .current) -> Date {
    var cal = calendar
    cal.firstWeekday = 2 // Monday
    let comps = cal.dateComponents([.yearForWeekOfYear, .weekOfYear], from: now)
    return cal.date(from: comps) ?? now
}
