import Foundation
import Combine

@MainActor
final class HomeViewModel: ObservableObject {
    @Published var weeklySession: WeeklySession
    @Published var showCuisinePrompt: Bool = false
    @Published var navigateToDiscovery: Bool = false
    @Published var showBookingDetail: Bool = false
    @Published var weeklyCount: Int = 0
    @Published var previewPhotoURLs: [URL] = []
    @Published var previewRestaurants: [WeeklyRestaurant] = []
    @Published var neighborhoodCount: Int = 0

    // Cuisine filter (top row)
    @Published var availableCuisines: [String] = []
    @Published var selectedCuisine: String? = nil

    // Borough filter (middle row — the existing row in the screenshot)
    @Published var availableBoroughs: [String] = []
    @Published var selectedBorough: String? = nil

    // Neighborhood filter (sub-row — revealed when a borough is selected)
    @Published var availableNeighborhoods: [String] = []
    @Published var selectedNeighborhood: String? = nil

    /// Mirrors UserProfile.showOnlyReservable. Kept as state so toggles in
    /// Settings push through to the Home feed without a view re-mount.
    @Published var showOnlyReservable: Bool = UserProfile.load().showOnlyReservable

    /// Mirrors UserProfile.discoverySources. A restaurant qualifies for the
    /// home feed iff it has ≥1 source row whose `source_type` is in this set.
    /// Empty set = block everything (matches the toggle "no sources" UX).
    @Published var enabledSources: Set<String> = UserProfile.load().discoverySources

    /// Restaurant ids the server reports as already reserved / blocked by
    /// this user. Used to filter them out of the home picks (same filter
    /// the Discovery deck uses). Fetched on init; silent failure is OK —
    /// worst case the user sees a restaurant they've already booked at the
    /// top, which the Reservations row directly above them will disambiguate.
    @Published private var remoteReservedIds: Set<UUID> = []
    @Published private var remoteBlockedIds: Set<UUID> = []

    private let notificationService = NotificationService.shared
    private let weeklyService = WeeklyRestaurantService.shared
    private let regionsService = CityRegionsService.shared
    private let city: String = "nyc"
    private var allRestaurants: [WeeklyRestaurant] = []
    private var cancellables = Set<AnyCancellable>()

    init() {
        self.weeklySession = WeeklySession.load()
        weeklyService.$status
            .receive(on: DispatchQueue.main)
            .sink { [weak self] status in
                let list: [WeeklyRestaurant]
                switch status {
                case .ready(let l), .stale(let l):
                    list = l
                default:
                    list = []
                }
                self?.allRestaurants = list
                self?.rebuildFilterOptions()
                self?.applyFilter()
            }
            .store(in: &cancellables)
        regionsService.$regions
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in
                self?.rebuildFilterOptions()
            }
            .store(in: &cancellables)
        // Recompute the greeting whenever AuthService transitions between
        // anonymous / authenticated — `greeting` reads `AuthService.state`
        // synchronously, so without this subscription the new first name
        // wouldn't show until something else nudged the view to re-render.
        AuthService.shared.$state
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in
                self?.objectWillChange.send()
            }
            .store(in: &cancellables)
        NotificationCenter.default.publisher(for: .userProfileUpdated)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in
                guard let self else { return }
                let profile = UserProfile.load()
                let reservableChanged = self.showOnlyReservable != profile.showOnlyReservable
                let sourcesChanged = self.enabledSources != profile.discoverySources
                if reservableChanged || sourcesChanged {
                    self.showOnlyReservable = profile.showOnlyReservable
                    self.enabledSources = profile.discoverySources
                    self.rebuildFilterOptions()
                    self.applyFilter()
                }
                // Always nudge the view — the greeting reads
                // `UserProfile.displayName`, which can change without
                // touching the filter set.
                self.objectWillChange.send()
            }
            .store(in: &cancellables)
        Task { await regionsService.load(city: city) }
        Task { await weeklyService.bootstrap(city: city) }
        Task { await loadRemoteFilters() }
    }

    @MainActor
    private func loadRemoteFilters() async {
        async let reserved = ReservationService.shared.fetchReservedRestaurantIds()
        async let blocked  = ReservationService.shared.fetchBlockedRestaurantIds()
        self.remoteReservedIds = await reserved
        self.remoteBlockedIds  = await blocked
    }

    var confirmedReservationThisWeek: Reservation? {
        weeklySession.reservations.first {
            $0.status == .confirmed && $0.datetime > Date()
        }
    }

    /// Every confirmed reservation in the future, across all persisted weekly
    /// sessions. We scan UserDefaults directly since bookings can live in any
    /// week — e.g. a booking made today for next Saturday. Sorted by
    /// `datetime` ascending so the *next-up* reservation sits on top.
    var upcomingReservations: [Reservation] {
        WeeklySession.allReservations().filter {
            $0.status == .confirmed && $0.datetime > Date()
        }.sorted { $0.datetime < $1.datetime }
    }

    var hasUpcomingReservations: Bool { !upcomingReservations.isEmpty }

    /// Time-of-day aware greeting. Buckets: 5-11 morning, 12-16 afternoon,
    /// 17-4 evening. Personalises with the signed-in user's first name from
    /// Apple / Google when available; otherwise falls back to the bare
    /// "Good morning" form so guests don't see a trailing comma.
    var greeting: String {
        let hour = Calendar.current.component(.hour, from: Date())
        let timeOfDay: String
        switch hour {
        case 5..<12:  timeOfDay = "Good morning"
        case 12..<17: timeOfDay = "Good afternoon"
        default:      timeOfDay = "Good evening"
        }
        if let firstName = signedInFirstName() {
            return "\(timeOfDay), \(firstName)!"
        }
        return timeOfDay
    }

    /// Pulls the user's first name in priority order:
    ///   1. `AuthService.state.authenticated.displayName` — set by Apple /
    ///      Google Sign-In on the first sign-in for that account.
    ///   2. `UserProfile.displayName` — manually entered in Settings →
    ///      "Your name". Guest-mode fallback used while the Apple Sign-In
    ///      entitlement is still off (TASKS § P5).
    /// Take the first whitespace-separated token so "Weijia Chen" → "Weijia".
    private func signedInFirstName() -> String? {
        let authName: String? = {
            if case let .authenticated(_, displayName, _) = AuthService.shared.state {
                return displayName
            }
            return nil
        }()
        let profileName = UserProfile.load().displayName
        let candidates: [String?] = [authName, profileName]
        for candidate in candidates {
            let trimmed = candidate?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if !trimmed.isEmpty {
                return trimmed.split(separator: " ").first.map(String.init)
            }
        }
        return nil
    }

    // MARK: - Home picks (3 curated slots)

    enum PickLabel: String {
        case topPick      = "TOP PICK"
        case newThisWeek  = "NEW THIS WEEK"
        case hiddenGem    = "HIDDEN GEM"
    }

    struct HomePick: Identifiable {
        let label: PickLabel
        let restaurant: WeeklyRestaurant
        var id: String { label.rawValue + ":" + restaurant.id }
    }

    /// Curated picks for the home page.
    ///
    /// - Without an upcoming reservation: three slots — TOP PICK (daily-
    ///   rotated within the top 25%), NEW THIS WEEK, HIDDEN GEM.
    /// - With at least one upcoming reservation: only TOP PICK. Picks live
    ///   below the reservation cards on Home, so a single follow-up pick
    ///   keeps the section short instead of competing with the booking row.
    ///
    /// TOP PICK uses a daily-deterministic draw from the top-ranked slice so
    /// the same user sees a different restaurant tomorrow.
    ///
    /// All slots share the Discovery deck's filter set: server-side reserved,
    /// server-side blocked, on-device seen-today, plus local swipe history.
    var homePicks: [HomePick] {
        let seen = SeenService.shared.seenToday()
        let today = Date()
        let pool = allRestaurants.filter { r in
            if showOnlyReservable, !Self.isReservable(r) { return false }
            if !Self.matchesEnabledSources(r, enabled: enabledSources) { return false }
            guard let uuid = UUID(uuidString: r.id) else { return false }
            if remoteReservedIds.contains(uuid) { return false }
            if remoteBlockedIds.contains(uuid)  { return false }
            if seen.contains(uuid)              { return false }
            if let record = weeklySession.swipedCards.first(where: { $0.restaurantId == uuid }) {
                if record.decision == .blocked,
                   let until = record.blockedUntil, today < until { return false }
                if record.decision == .disliked,
                   Calendar.current.isDate(record.timestamp, equalTo: today, toGranularity: .weekOfYear) {
                    return false
                }
            }
            return true
        }

        guard !pool.isEmpty else { return [] }

        var picks: [HomePick] = []
        var usedIds = Set<String>()

        // Slot 1 — TOP PICK. We pin the choice for the day so opening a card
        // (which marks it seen → drops it from `pool`) doesn't shift the
        // ranking and surface a different "TOP PICK" later in the session.
        // The cached id is reused as long as it's still in `allRestaurants`
        // and not server-side reserved/blocked. Tomorrow's `dailyKey`
        // invalidates the cache and a fresh draw runs.
        let userId = IdentityService.shared.userId
        let dailyKey = Self.dailyKey()
        let dailySeed = Self.dailySeed(dateKey: dailyKey, userId: userId)
        let topCount = max(1, pool.count / 4)
        let topSlice = Array(pool.prefix(topCount))
        let top: WeeklyRestaurant? = {
            // 1. Stickied id from earlier today, if it's still valid.
            if let cachedId = Self.cachedTopPickId(dateKey: dailyKey, userId: userId),
               let candidate = allRestaurants.first(where: { $0.id == cachedId }),
               Self.isStickyTopPickValid(candidate,
                                         showOnlyReservable: showOnlyReservable,
                                         enabledSources: enabledSources,
                                         remoteReservedIds: remoteReservedIds,
                                         remoteBlockedIds: remoteBlockedIds) {
                return candidate
            }
            // 2. Fresh deterministic draw — and persist for the rest of the day.
            let chosen = Self.pickStable(from: topSlice, seed: dailySeed)
            if let chosen { Self.setCachedTopPickId(chosen.id, dateKey: dailyKey, userId: userId) }
            return chosen
        }()
        if let top {
            picks.append(HomePick(label: .topPick, restaurant: top))
            usedIds.insert(top.id)
        }

        // When the user has an upcoming reservation, the picks section sits
        // below it — a single follow-up suggestion is plenty.
        if hasUpcomingReservations { return picks }

        // Slot 2 — NEW THIS WEEK: highest-ranked with post_created_at < 14 days.
        let twoWeeksAgo = Calendar.current.date(byAdding: .day, value: -14, to: today) ?? today
        let iso = ISO8601DateFormatter()
        let freshCandidate = pool.first { r in
            !usedIds.contains(r.id) &&
            (r.postCreatedAt.flatMap { iso.date(from: $0) }.map { $0 >= twoWeeksAgo } ?? false)
        } ?? pool.first { !usedIds.contains($0.id) }
        if let fresh = freshCandidate {
            picks.append(HomePick(label: .newThisWeek, restaurant: fresh))
            usedIds.insert(fresh.id)
        }

        // Slot 3 — HIDDEN GEM: mid-ranked (20%–60% slice) with a booking URL,
        // daily-deterministic per user.
        let lower = max(0, pool.count / 5)
        let upper = min(pool.count - 1, (pool.count * 3) / 5)
        let midSlice = lower <= upper ? Array(pool[lower...upper]) : pool
        let gemPool = midSlice.filter { r in
            !usedIds.contains(r.id) && Self.isReservable(r)
        }
        let finalGemPool = gemPool.isEmpty
            ? pool.filter { !usedIds.contains($0.id) }
            : gemPool
        if let gem = Self.pickStable(from: finalGemPool, seed: dailySeed) {
            picks.append(HomePick(label: .hiddenGem, restaurant: gem))
        }

        return picks
    }

    private static func pickStable(from pool: [WeeklyRestaurant], seed: UInt64) -> WeeklyRestaurant? {
        guard !pool.isEmpty else { return nil }
        let index = Int(seed % UInt64(pool.count))
        return pool[index]
    }

    /// Local-time `yyyy-MM-dd`. Used as the cache key for sticky TOP PICK +
    /// the seed input so the daily rotation flips at midnight in the user's
    /// timezone (not UTC).
    private static func dailyKey() -> String {
        let fmt = DateFormatter()
        fmt.calendar = Calendar(identifier: .gregorian)
        fmt.locale = Locale(identifier: "en_US_POSIX")
        fmt.timeZone = TimeZone.current
        fmt.dateFormat = "yyyy-MM-dd"
        return fmt.string(from: Date())
    }

    /// Day-stable, user-stable seed. `String.hashValue` is randomized per app
    /// launch (hash-flooding protection), so we roll our own simple FNV-style
    /// combine over the unicode scalars of `yyyy-MM-dd + userId`.
    private static func dailySeed(dateKey: String, userId: String) -> UInt64 {
        let key = dateKey + "|" + userId
        var h: UInt64 = 14_695_981_039_346_656_037
        for scalar in key.unicodeScalars {
            h ^= UInt64(scalar.value)
            h &*= 1_099_511_628_211
        }
        return h
    }

    /// Sticky TOP PICK cache — persists the chosen restaurant id for the
    /// current `(dailyKey, userId)` so a single session that views the card
    /// (and thus marks it seen) doesn't shift the choice when Home re-renders.
    /// The cache is read once per render via `cachedTopPickId`; tomorrow's
    /// dailyKey changes the UserDefaults key so yesterday's pin is ignored.
    private static func topPickStorageKey(dateKey: String, userId: String) -> String {
        "home.topPick.\(dateKey).\(userId)"
    }

    private static func cachedTopPickId(dateKey: String, userId: String) -> String? {
        UserDefaults.standard.string(forKey: topPickStorageKey(dateKey: dateKey, userId: userId))
    }

    private static func setCachedTopPickId(_ id: String, dateKey: String, userId: String) {
        UserDefaults.standard.set(id, forKey: topPickStorageKey(dateKey: dateKey, userId: userId))
    }

    /// A sticky TOP PICK is still valid if it would have passed the durable
    /// part of the home filter — sources / reservable / reserved / blocked.
    /// We deliberately don't test seen-today or local swipe history here: the
    /// whole point of pinning is that *transient* signals like "I just opened
    /// this card" shouldn't reshuffle today's TOP PICK.
    private static func isStickyTopPickValid(_ r: WeeklyRestaurant,
                                             showOnlyReservable: Bool,
                                             enabledSources: Set<String>,
                                             remoteReservedIds: Set<UUID>,
                                             remoteBlockedIds: Set<UUID>) -> Bool {
        if showOnlyReservable, !isReservable(r) { return false }
        if !matchesEnabledSources(r, enabled: enabledSources) { return false }
        guard let uuid = UUID(uuidString: r.id) else { return false }
        if remoteReservedIds.contains(uuid) { return false }
        if remoteBlockedIds.contains(uuid)  { return false }
        return true
    }

    var upcomingSubheadline: String {
        let count = upcomingReservations.count
        if count == 0 { return "No upcoming reservations yet." }
        if count == 1 { return "You have 1 upcoming reservation." }
        return "You have \(count) upcoming reservations."
    }

    func startDiscovery() {
        navigateToDiscovery = true
    }

    func setCuisinesAndStartDiscovery(_ cuisines: [CuisineTag]) {
        weeklySession.cuisinePreferences = cuisines
        weeklySession.save()
        showCuisinePrompt = false
        navigateToDiscovery = true
    }

    func refresh() {
        weeklySession = WeeklySession.load()
    }

    // MARK: - Selection

    func selectCuisine(_ cuisine: String?) {
        selectedCuisine = cuisine
        applyFilter()
    }

    func selectBorough(_ borough: String?) {
        // Tapping the currently-selected borough deselects it (collapses neighborhood row).
        if let newValue = borough, newValue == selectedBorough {
            selectedBorough = nil
        } else {
            selectedBorough = borough
        }
        // Reset neighborhood when borough changes or clears.
        selectedNeighborhood = nil
        rebuildNeighborhoodOptions()
        applyFilter()
    }

    func selectNeighborhood(_ hood: String?) {
        selectedNeighborhood = hood
        applyFilter()
    }

    // MARK: - Option lists

    private func rebuildFilterOptions() {
        let pool = allRestaurants.filter { r in
            if showOnlyReservable, !Self.isReservable(r) { return false }
            return Self.matchesEnabledSources(r, enabled: enabledSources)
        }

        // Cuisines (normalized, unique, sorted by count desc)
        var cuisineCounts: [String: Int] = [:]
        for r in pool {
            guard let c = normalizedCuisine(r.cuisineType) else { continue }
            cuisineCounts[c, default: 0] += 1
        }
        // Alphabetical — predictable ordering beats frequency-biased ordering
        // once the cuisine set is stable across weeks.
        availableCuisines = cuisineCounts.keys.sorted { $0.localizedCompare($1) == .orderedAscending }

        // Boroughs: prefer the canonical list from the server when loaded, so
        // the chip order is stable and covers empty boroughs too. Fall back to
        // boroughs actually present in the data.
        var boroughCounts: [String: Int] = [:]
        for r in pool {
            let b = normalizedBorough(r.borough)
            boroughCounts[b, default: 0] += 1
        }

        if let canonical = regionsService.regions?.boroughNames, !canonical.isEmpty {
            // Keep canonical order; surface only boroughs with data. This
            // also drops any non-NYC labels that slipped past backend filters.
            availableBoroughs = canonical.filter { boroughCounts[$0, default: 0] > 0 }
        } else {
            availableBoroughs = boroughCounts
                .sorted { $0.value == $1.value ? $0.key < $1.key : $0.value > $1.value }
                .map(\.key)
        }

        rebuildNeighborhoodOptions()

        // Total distinct neighborhoods for the stats pill
        let hoods = Set(pool.compactMap { normalizedNeighborhood($0.neighborhood) })
        neighborhoodCount = hoods.count
    }

    private func rebuildNeighborhoodOptions() {
        guard let borough = selectedBorough, borough != "all" else {
            availableNeighborhoods = []
            return
        }
        // Counts of neighborhoods actually represented in the data for this borough.
        var counts: [String: Int] = [:]
        for r in allRestaurants where normalizedBorough(r.borough) == borough {
            if showOnlyReservable, !Self.isReservable(r) { continue }
            guard let hood = normalizedNeighborhood(r.neighborhood) else { continue }
            counts[hood, default: 0] += 1
        }

        // When the canonical mapping has neighborhoods for this borough, use
        // that order and only surface chips that have data (>0 restaurants).
        if let canonicalHoods = regionsService.regions?.neighborhoods(in: borough),
           !canonicalHoods.isEmpty {
            let canonicalSet = Set(canonicalHoods)
            let ordered = canonicalHoods.filter { counts[$0, default: 0] > 0 }
            // Any neighborhoods with data that weren't in the canonical list
            // (e.g. new/unseen names) appear last, alphabetically.
            let extras = counts.keys
                .filter { !canonicalSet.contains($0) }
                .sorted()
            availableNeighborhoods = ordered + extras
        } else {
            availableNeighborhoods = counts
                .sorted { $0.value == $1.value ? $0.key < $1.key : $0.value > $1.value }
                .map(\.key)
        }
    }

    // MARK: - Filtering

    private func applyFilter() {
        let filtered = allRestaurants.filter { r in
            if showOnlyReservable, !Self.isReservable(r) { return false }
            if !Self.matchesEnabledSources(r, enabled: enabledSources) { return false }
            if let cuisine = selectedCuisine,
               normalizedCuisine(r.cuisineType) != cuisine { return false }
            if let borough = selectedBorough,
               normalizedBorough(r.borough) != borough { return false }
            if let hood = selectedNeighborhood,
               normalizedNeighborhood(r.neighborhood) != hood { return false }
            return true
        }
        weeklyCount = filtered.count
        previewRestaurants = filtered
        previewPhotoURLs = filtered.prefix(6).compactMap { $0.photoUrl.flatMap { URL(string: $0) } }
    }

    /// True if the restaurant has at least one source row whose `source_type`
    /// is in the user's enabled set. When the user has no sources enabled,
    /// nothing matches (graceful "empty state" rather than a confusing fallback
    /// to all-on). Restaurants with an empty `sources` array fall back to
    /// `xiaohongshu` since that's the legacy default for pre-multi-source rows.
    static func matchesEnabledSources(_ r: WeeklyRestaurant, enabled: Set<String>) -> Bool {
        if enabled.isEmpty { return false }
        let types: [String]
        if let sources = r.sources, !sources.isEmpty {
            types = sources.map(\.resolvedType)
        } else {
            types = ["xiaohongshu"]
        }
        return types.contains { enabled.contains($0) }
    }

    /// A weekly card is "reservable" iff the pipeline resolved a Resy or OpenTable
    /// booking URL. Empty strings count as missing.
    private static func isReservable(_ r: WeeklyRestaurant) -> Bool {
        let resy = r.resyBookingUrl?.trimmingCharacters(in: .whitespaces) ?? ""
        let ot = r.opentableBookingUrl?.trimmingCharacters(in: .whitespaces) ?? ""
        return !resy.isEmpty || !ot.isEmpty
    }

    // MARK: - Normalization helpers

    /// Backend now sends `cuisine_type` as a canonical CuisineTag rawValue
    /// (chinese, japanese, middle_eastern, …) or null. Reject anything that
    /// isn't in the closed vocabulary so stale free-form strings ("Coffee",
    /// "Hotel") from older caches / imports never surface as chips.
    func normalizedCuisine(_ raw: String?) -> String? {
        guard let s = raw?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
              !s.isEmpty else {
            return nil
        }
        return CuisineTag(rawValue: s)?.rawValue
    }

    /// Pretty display label for a normalized key — "middle_eastern" → "Middle Eastern".
    func cuisineDisplayLabel(_ key: String) -> String {
        CuisineTag(rawValue: key)?.displayName ?? key.capitalized
    }

    /// Whitelist of valid borough/region values. Any non-matching string
    /// (typically a neighborhood like "Midtown" that snuck into the borough
    /// column from a custom list import or bad data) maps to "Other".
    private static let knownBoroughs: Set<String> = [
        "Manhattan", "Brooklyn", "Queens", "Bronx", "The Bronx",
        "Staten Island", "New Jersey", "Hong Kong", "China", "Outside NYC"
    ]

    func normalizedBorough(_ raw: String?) -> String {
        let s = raw?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if s.isEmpty { return "Other" }
        return Self.knownBoroughs.contains(s) ? s : "Other"
    }

    func normalizedNeighborhood(_ raw: String?) -> String? {
        guard let s = raw?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty else {
            return nil
        }
        return s
    }
}
