import Foundation

/// Tracks which restaurant cards the user has already seen **today**, so the
/// Discovery deck doesn't re-show them within the same day.
///
/// Storage: on-device `UserDefaults`, keyed per-day (`seen_yyyy-MM-dd`). This
/// sidesteps Vercel KV / DB writes in the swipe hot-path. Cross-device is out
/// of scope — opening the app on a second device may repeat a handful of
/// cards; for a personal-use app that's acceptable.
///
/// GC: yesterday's keys are dropped lazily the first time we access today's
/// key after midnight — no cron, no pruning job.
final class SeenService {
    static let shared = SeenService()

    private let defaults = UserDefaults.standard
    private let prefix = "seen_"

    private init() {}

    private var todayKey: String {
        prefix + SeenService.isoDay(Date())
    }

    private static let isoDayFormatter: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale   = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone.current
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    private static func isoDay(_ date: Date) -> String {
        isoDayFormatter.string(from: date)
    }

    /// All restaurant ids the user has seen on the current calendar day.
    /// Running this also trims any older `seen_*` keys still lying around.
    func seenToday() -> Set<UUID> {
        gcStaleKeys()
        return readSet(for: todayKey)
    }

    /// Mark a restaurant as seen today. Safe to call repeatedly.
    func markSeen(_ ids: [UUID]) {
        guard !ids.isEmpty else { return }
        var set = readSet(for: todayKey)
        for id in ids { set.insert(id) }
        writeSet(set, for: todayKey)
    }

    func markSeen(_ id: UUID) { markSeen([id]) }

    /// Wipe today's seen set entirely. Used by the Discovery deck's "reset"
    /// button so previously-seen restaurants come back into the pool.
    func clearToday() {
        defaults.removeObject(forKey: todayKey)
    }

    /// Drop a restaurant from today's seen-set. Used by the rewind button on
    /// Discovery so the previous card actually re-appears in the deck.
    func unmarkSeen(_ id: UUID) {
        var set = readSet(for: todayKey)
        guard set.remove(id) != nil else { return }
        writeSet(set, for: todayKey)
    }

    // MARK: - Persistence

    private func readSet(for key: String) -> Set<UUID> {
        guard let raw = defaults.array(forKey: key) as? [String] else { return [] }
        return Set(raw.compactMap { UUID(uuidString: $0) })
    }

    private func writeSet(_ set: Set<UUID>, for key: String) {
        defaults.set(set.map { $0.uuidString }, forKey: key)
    }

    /// Delete any `seen_yyyy-MM-dd` keys older than today so UserDefaults
    /// doesn't grow unbounded over months of use.
    private func gcStaleKeys() {
        let today = SeenService.isoDay(Date())
        for (key, _) in defaults.dictionaryRepresentation() where key.hasPrefix(prefix) {
            let day = String(key.dropFirst(prefix.count))
            if day != today {
                defaults.removeObject(forKey: key)
            }
        }
    }
}
