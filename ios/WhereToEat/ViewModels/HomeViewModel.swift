import Foundation
import Combine
import UIKit
import CoreLocation

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
    /// The "only bookable" setting, skipped when the current city has no
    /// bookable restaurants at all (otherwise Home would show no picks).
    private var reservableFilterActive: Bool {
        showOnlyReservable && weeklyService.activeCityHasBookable
    }

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

    /// Restaurants whose Home photo came back as an HTTP error or a
    /// non-image. They're left out of the pick slots so Home never shows a
    /// gray placeholder tile. See `verifyPickPhotos()`.
    @Published private var deadPhotoIds: Set<String> = []
    private var probedPhotoURLs: Set<URL> = []
    /// Stops the swap-and-recheck chain if photos fail wholesale (e.g. the
    /// Blob store was suspended on 2026-11-27): past this, Home keeps the
    /// placeholder rather than walking the whole deck.
    private static let maxDeadPhotoSwaps = 30

    private let notificationService = NotificationService.shared
    private let weeklyService = WeeklyRestaurantService.shared
    private let regionsService = CityRegionsService.shared
    private var city: String { weeklyService.activeCity }
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
                guard let self else { return }
                self.allRestaurants = list
                self.rebuildFilterOptions()
                self.applyFilter()
                if !list.isEmpty, self.luckySelectionCity != self.city { self.loadLuckySelection() }
            }
            .store(in: &cancellables)
        // Lucky's "Near me" chip and distances depend on the GPS fix, which
        // can land after the deck does.
        LocationService.shared.$currentLocation
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in self?.objectWillChange.send() }
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
        // City switch (Pick-page picker): clear the old city's chip picks and
        // reload the region list. The deck itself is re-bootstrapped by
        // WeeklyRestaurantService.selectCity.
        weeklyService.$activeCity
            .dropFirst()
            .receive(on: DispatchQueue.main)
            .sink { [weak self] key in
                guard let self else { return }
                self.selectedBorough = nil
                self.selectedCuisine = nil
                Task { await self.regionsService.load(city: key) }
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
            hasUsablePhoto(r) && isEligible(r, seen: seen, today: today)
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
               hasUsablePhoto(candidate),
               Self.isStickyTopPickValid(candidate,
                                         showOnlyReservable: reservableFilterActive,
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

    /// The photo the Home pick card renders (`HomeView` uses the same rule).
    static func homePhotoURL(_ r: WeeklyRestaurant) -> URL? {
        guard let raw = r.photoUrls?.first ?? r.photoUrl, !raw.isEmpty else { return nil }
        return URL(string: raw)
    }

    private func hasUsablePhoto(_ r: WeeklyRestaurant) -> Bool {
        Self.homePhotoURL(r) != nil && !deadPhotoIds.contains(r.id)
    }

    /// The filter set every Home section shares (same as the Discovery deck):
    /// sources, reservable, server-side reserved / blocked, seen-today and this
    /// week's local swipe history. `ignoreSeen` keeps an already-rendered
    /// Trending card from vanishing after the user opens it.
    private func isEligible(_ r: WeeklyRestaurant, seen: Set<UUID>, today: Date,
                            ignoreSeen: Bool = false) -> Bool {
        if reservableFilterActive, !Self.isReservable(r) { return false }
        if !Self.matchesEnabledSources(r, enabled: enabledSources) { return false }
        guard let uuid = UUID(uuidString: r.id) else { return false }
        if remoteReservedIds.contains(uuid) { return false }
        if remoteBlockedIds.contains(uuid)  { return false }
        if !ignoreSeen, seen.contains(uuid) { return false }
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

    // MARK: - Trending now

    struct TrendingPick: Identifiable {
        let restaurant: WeeklyRestaurant
        /// Likes and date of the post that ranked this restaurant.
        let likes: Int
        let postDate: Date
        var id: String { restaurant.id }
    }

    private static let trendingMinimum = 4
    private static let trendingMaximum = 8

    /// Restaurants from the most recent popular 小红书 posts. Each post scores
    /// `log10(1 + likes) × 0.5^(ageDays / 14) / √(restaurants in that post)`
    /// and a restaurant takes its best post. The window starts at 30 days and
    /// widens to 60 / 90 until at least 4 qualify; otherwise the rail hides.
    /// At most 2 per cuisine and 1 per post. Same filters as the picks, minus
    /// restaurants already in This week's picks.
    var trendingPicks: [TrendingPick] {
        let seen = SeenService.shared.seenToday()
        let today = Date()
        let dayKey = Self.dailyKey()
        let userId = IdentityService.shared.userId
        let shown = Self.trendingShownIds(dateKey: dayKey, userId: userId)
        let inPicks = Set(homePicks.map(\.restaurant.id))
        let pool = allRestaurants.filter { r in
            !inPicks.contains(r.id) && hasUsablePhoto(r)
                && isEligible(r, seen: seen, today: today, ignoreSeen: shown.contains(r.id))
        }
        guard pool.count >= Self.trendingMinimum else { return [] }

        var postShare: [String: Int] = [:]
        for r in allRestaurants {
            for s in r.sources ?? [] where s.resolvedType == "xiaohongshu" {
                postShare[s.postUrl, default: 0] += 1
            }
        }
        for windowDays in [30, 60, 90] {
            let picks = Self.rankTrending(pool, postShare: postShare,
                                          windowDays: windowDays, now: today)
            if picks.count >= Self.trendingMinimum {
                let ids = picks.map(\.id)
                if !Set(ids).isSubset(of: shown) {
                    Self.setTrendingShownIds(shown.union(ids), dateKey: dayKey, userId: userId)
                }
                return picks
            }
        }
        return []
    }

    private static func rankTrending(_ pool: [WeeklyRestaurant], postShare: [String: Int],
                                     windowDays: Int, now: Date) -> [TrendingPick] {
        var scored: [(pick: TrendingPick, score: Double, post: String)] = []
        for r in pool {
            var best: (score: Double, source: XHSSource, date: Date)?
            for s in r.sources ?? [] where s.resolvedType == "xiaohongshu" {
                guard let date = parsePostDate(s.postCreatedAt) else { continue }
                let ageDays = max(0, now.timeIntervalSince(date) / 86_400)
                guard ageDays <= Double(windowDays) else { continue }
                let sharedBy = Double(max(1, postShare[s.postUrl] ?? 1))
                let score = log10(1 + Double(max(0, s.likes)))
                    * pow(0.5, ageDays / 14) / sharedBy.squareRoot()
                if score > (best?.score ?? -1) { best = (score, s, date) }
            }
            if let best {
                scored.append((TrendingPick(restaurant: r, likes: best.source.likes,
                                            postDate: best.date),
                               best.score, best.source.postUrl))
            }
        }
        scored.sort { $0.score > $1.score }

        var perCuisine: [String: Int] = [:]
        var usedPosts = Set<String>()
        var picks: [TrendingPick] = []
        for entry in scored {
            let cuisine = CuisineTag(rawValue: (entry.pick.restaurant.cuisineType ?? "").lowercased())?.rawValue ?? "other"
            if perCuisine[cuisine, default: 0] >= 2 || usedPosts.contains(entry.post) { continue }
            perCuisine[cuisine, default: 0] += 1
            usedPosts.insert(entry.post)
            picks.append(entry.pick)
            if picks.count == trendingMaximum { break }
        }
        return picks
    }

    /// Post dates come as `2026-10-15T10:45:51.000Z`; the default
    /// `ISO8601DateFormatter` rejects the fractional seconds.
    private static let isoFractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let isoPlain = ISO8601DateFormatter()

    static func parsePostDate(_ raw: String?) -> Date? {
        guard let raw, !raw.isEmpty else { return nil }
        return isoFractional.date(from: raw) ?? isoPlain.date(from: raw)
    }

    private static func trendingShownKey(dateKey: String, userId: String) -> String {
        "home.trendingShown.\(dateKey).\(userId)"
    }

    private static func trendingShownIds(dateKey: String, userId: String) -> Set<String> {
        Set(UserDefaults.standard.stringArray(forKey: trendingShownKey(dateKey: dateKey, userId: userId)) ?? [])
    }

    private static func setTrendingShownIds(_ ids: Set<String>, dateKey: String, userId: String) {
        UserDefaults.standard.set(Array(ids), forKey: trendingShownKey(dateKey: dateKey, userId: userId))
    }

    // MARK: - I'm feeling lucky

    enum LuckyPlace: Equatable, Hashable {
        case nearMe
        case region(String)
        case wholeCity

        var storageValue: String {
            switch self {
            case .nearMe: return "near"
            case .wholeCity: return "all"
            case .region(let name): return "region:" + name
            }
        }

        init?(storageValue: String) {
            switch storageValue {
            case "near": self = .nearMe
            case "all": self = .wholeCity
            default:
                guard storageValue.hasPrefix("region:") else { return nil }
                self = .region(String(storageValue.dropFirst("region:".count)))
            }
        }
    }

    struct LuckyResult: Identifiable {
        let restaurant: WeeklyRestaurant
        let distanceMeters: Double?
        /// Photos the roll animation flips through; the winner's photo is last.
        let shufflePhotos: [URL]
        let rollId = UUID()
        var id: UUID { rollId }
    }

    /// nil = "Surprise me".
    @Published private(set) var luckyCuisine: String?
    @Published private(set) var luckyPlace: LuckyPlace = .wholeCity
    /// My List rows, pushed in from `HomeView` (CustomListViewModel lives there).
    @Published var savedRestaurants: [Restaurant] = []
    private var luckySelectionCity: String?

    static let luckyDailyRolls = 3

    var luckyAvailable: Bool { !allRestaurants.isEmpty }

    var luckyCityLabel: String {
        WeeklyRestaurantService.cities.first { $0.key == city }?.label ?? "the city"
    }

    func selectLuckyCuisine(_ cuisine: String?) {
        luckyCuisine = cuisine
        UserDefaults.standard.set(cuisine ?? "any", forKey: "lucky.cuisine.\(city)")
    }

    func selectLuckyPlace(_ place: LuckyPlace) {
        luckyPlace = place
        UserDefaults.standard.set(place.storageValue, forKey: "lucky.place.\(city)")
    }

    /// Restores the city's last Lucky choice, or the first-run default:
    /// the inferred cuisine (else Surprise me) and Near me (else the whole city).
    private func loadLuckySelection() {
        luckySelectionCity = city
        let defaults = UserDefaults.standard
        if let stored = defaults.string(forKey: "lucky.cuisine.\(city)") {
            luckyCuisine = stored == "any" ? nil : stored
        } else {
            luckyCuisine = luckyInferredCuisine
        }
        if let stored = defaults.string(forKey: "lucky.place.\(city)"),
           let place = LuckyPlace(storageValue: stored) {
            luckyPlace = place
        } else {
            luckyPlace = nearMeAvailable ? .nearMe : .wholeCity
        }
    }

    private var userLocation: CLLocation? {
        LocationService.shared.effectiveCoordinates.map {
            CLLocation(latitude: $0.latitude, longitude: $0.longitude)
        }
    }

    private static func location(of r: WeeklyRestaurant) -> CLLocation? {
        guard let lat = r.latitude, let lng = r.longitude else { return nil }
        return CLLocation(latitude: lat, longitude: lng)
    }

    /// "Near me" only makes sense when the phone is inside the city: some
    /// restaurant in the deck has to be within ~10 miles.
    var nearMeAvailable: Bool {
        guard let me = userLocation else { return false }
        return allRestaurants.contains { r in
            Self.location(of: r).map { me.distance(from: $0) < 16_000 } ?? false
        }
    }

    /// The selection actually applied: a stored Near me falls back to the
    /// whole city when GPS is outside the city, and a region with no data
    /// (e.g. after a city switch) does too.
    private var effectiveLuckyPlace: LuckyPlace {
        switch luckyPlace {
        case .nearMe: return nearMeAvailable ? .nearMe : .wholeCity
        case .region(let name): return availableBoroughs.contains(name) ? luckyPlace : .wholeCity
        case .wholeCity: return .wholeCity
        }
    }

    private var luckyRolledToday: [String] {
        UserDefaults.standard.stringArray(forKey: luckyRolledKey) ?? []
    }

    private var luckyRolledKey: String {
        "lucky.rolled.\(Self.dailyKey()).\(IdentityService.shared.userId)"
    }

    var luckyRollsLeft: Int { max(0, Self.luckyDailyRolls - luckyRolledToday.count) }

    /// Everything Lucky can land on before the cuisine / place chips: the
    /// shared filters, a working photo, and nothing already rolled today.
    private var luckyBasePool: [WeeklyRestaurant] {
        let seen = SeenService.shared.seenToday()
        let today = Date()
        let rolled = Set(luckyRolledToday)
        return allRestaurants.filter { r in
            !rolled.contains(r.id) && hasUsablePhoto(r) && isEligible(r, seen: seen, today: today)
        }
    }

    /// CRAVING chips: cuisines with at least one candidate, the inferred
    /// "usual" first, then by candidate count.
    var luckyCuisineOptions: [String] {
        var counts: [String: Int] = [:]
        for r in luckyBasePool {
            if let c = normalizedCuisine(r.cuisineType) { counts[c, default: 0] += 1 }
        }
        let usual = luckyInferredCuisine
        return counts.keys.sorted { a, b in
            if a == usual { return true }
            if b == usual { return false }
            if counts[a] != counts[b] { return counts[a, default: 0] > counts[b, default: 0] }
            return a < b
        }
    }

    /// WHERE chips: Near me (when inside the city), the whole city, then the
    /// regions that have a match for the chosen cuisine. A region with no
    /// match is left out (like cuisines with no candidates), except the one
    /// currently selected, so the selection never disappears.
    var luckyPlaceOptions: [LuckyPlace] {
        let counts = Dictionary(grouping: luckyBasePool.filter(matchesLuckyCuisine)) {
            normalizedBorough($0.borough)
        }.mapValues(\.count)
        let regions = availableBoroughs.filter { name in
            counts[name, default: 0] > 0 || luckyPlace == .region(name)
        }
        return (nearMeAvailable ? [.nearMe] : []) + [.wholeCity] + regions.map { .region($0) }
    }

    private func matchesLuckyCuisine(_ r: WeeklyRestaurant) -> Bool {
        guard let luckyCuisine else { return true }
        return normalizedCuisine(r.cuisineType) == luckyCuisine
    }

    struct LuckyMatch {
        let restaurants: [WeeklyRestaurant]
        /// Search radius in meters when Near me found enough nearby spots.
        let radiusMeters: Double?
    }

    /// Near me starts at 1 mi (NYC) / 3 mi (other cities) and doubles up to
    /// three times until there are 3 candidates, then uses the whole city.
    var luckyMatch: LuckyMatch {
        let base = luckyBasePool.filter(matchesLuckyCuisine)
        switch effectiveLuckyPlace {
        case .region(let name):
            return LuckyMatch(restaurants: base.filter { normalizedBorough($0.borough) == name },
                              radiusMeters: nil)
        case .wholeCity:
            return LuckyMatch(restaurants: base, radiusMeters: nil)
        case .nearMe:
            guard let me = userLocation else { return LuckyMatch(restaurants: base, radiusMeters: nil) }
            var radius = city == "nyc" ? 1_609.0 : 4_828.0
            for _ in 0...3 {
                let nearby = base.filter { r in
                    Self.location(of: r).map { me.distance(from: $0) <= radius } ?? false
                }
                if nearby.count >= 3 { return LuckyMatch(restaurants: nearby, radiusMeters: radius) }
                radius *= 2
            }
            return LuckyMatch(restaurants: base, radiusMeters: nil)
        }
    }

    /// The fanned photos on the card: the best-ranked current candidates.
    var luckyFanPhotos: [URL] {
        luckyMatch.restaurants.prefix(2).compactMap(Self.homePhotoURL)
    }

    /// The user's usual cuisine: confirmed bookings weigh 3, My List saves 2,
    /// right-swipes in the last 30 days 1. Needs at least 2 signals, and the
    /// cuisine has to exist in the current city.
    var luckyInferredCuisine: String? {
        let byId = Dictionary(allRestaurants.map { ($0.id.lowercased(), $0) },
                              uniquingKeysWith: { first, _ in first })
        var weights: [String: Int] = [:]
        var signals = 0
        func add(_ raw: String?, _ weight: Int) {
            guard let key = normalizedCuisine(raw) else { return }
            weights[key, default: 0] += weight
            signals += 1
        }
        for res in WeeklySession.allReservations() where res.status == .confirmed {
            add(byId[res.restaurantId.uuidString.lowercased()]?.cuisineType, 3)
        }
        for r in savedRestaurants {
            add(r.rawCuisineType ?? r.cuisineTags.first?.rawValue, 2)
        }
        let monthAgo = Date().addingTimeInterval(-30 * 86_400)
        for rec in weeklySession.swipedCards where rec.decision == .liked && rec.timestamp > monthAgo {
            add(byId[rec.restaurantId.uuidString.lowercased()]?.cuisineType, 1)
        }
        guard signals >= 2 else { return nil }
        let present = Set(allRestaurants.compactMap { normalizedCuisine($0.cuisineType) })
        return weights
            .filter { present.contains($0.key) }
            .max { $0.value == $1.value ? $0.key > $1.key : $0.value < $1.value }?
            .key
    }

    /// Weighted random pick from the current match: deck rank, Google rating
    /// (≥4.5 ×1.3, <4.0 ×0.6) and bookable ×1.5. Uses one of today's rolls.
    func rollLucky() -> LuckyResult? {
        guard luckyRollsLeft > 0 else { return nil }
        let candidates = luckyMatch.restaurants
        guard !candidates.isEmpty else { return nil }

        let rank = Dictionary(allRestaurants.enumerated().map { ($1.id, $0) },
                              uniquingKeysWith: { first, _ in first })
        let total = Double(max(1, allRestaurants.count))
        let weights: [Double] = candidates.map { r in
            let rankWeight = max(0.2, 1 - Double(rank[r.id] ?? 0) / total)
            let ratingWeight: Double = {
                guard let rating = r.googleRating else { return 1 }
                if rating >= 4.5 { return 1.3 }
                if rating < 4.0 { return 0.6 }
                return 1
            }()
            return rankWeight * ratingWeight * (Self.isReservable(r) ? 1.5 : 1)
        }
        var target = Double.random(in: 0..<weights.reduce(0, +))
        var chosen = candidates[candidates.count - 1]
        for (r, w) in zip(candidates, weights) {
            if target < w { chosen = r; break }
            target -= w
        }

        UserDefaults.standard.set(luckyRolledToday + [chosen.id], forKey: luckyRolledKey)
        objectWillChange.send()

        let others = candidates.filter { $0.id != chosen.id }.shuffled().prefix(6)
        let photos = others.compactMap(Self.homePhotoURL) + [Self.homePhotoURL(chosen)].compactMap { $0 }
        let distance = userLocation.flatMap { me in Self.location(of: chosen).map { me.distance(from: $0) } }
        return LuckyResult(restaurant: chosen,
                           distanceMeters: effectiveLuckyPlace == .wholeCity ? nil : distance,
                           shufflePhotos: photos)
    }

    /// Loads each pick's and Trending card's photo (sharing `ImageCache`'s download, so this also
    /// warms it for the card). If the server refuses it or it isn't an image,
    /// the restaurant is marked dead, `homePicks` recomputes without it, and
    /// the replacement gets the same check. Offline errors are ignored: the
    /// photo may be fine, and it is re-checked on the next filter pass.
    private func verifyPickPhotos() {
        for restaurant in homePicks.map(\.restaurant) + trendingPicks.map(\.restaurant) {
            guard let url = Self.homePhotoURL(restaurant),
                  !probedPhotoURLs.contains(url) else { continue }
            probedPhotoURLs.insert(url)
            let id = restaurant.id
            Task { [weak self] in
                do {
                    let data = try await ImageCache.data(for: url)
                    if UIImage(data: data) == nil { self?.markPhotoDead(id) }
                } catch is ImageCache.HTTPStatusError {
                    self?.markPhotoDead(id)
                } catch {
                    self?.probedPhotoURLs.remove(url)
                }
            }
        }
    }

    private func markPhotoDead(_ id: String) {
        guard deadPhotoIds.count < Self.maxDeadPhotoSwaps else { return }
        deadPhotoIds.insert(id)
        verifyPickPhotos()
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
        // Re-run the home filter pipeline whenever Home re-appears so
        // `weeklyCount` ("🍽 N picks") reflects the current seen-today /
        // swipe-history state. Without this the stat freezes at whatever
        // value it had when the weekly cache last published — every card
        // the user views afterward shrinks the underlying pool but the
        // pill stays stuck on the original number.
        applyFilter()
    }

    /// Pull-to-refresh entry point. Forces a fresh `/api/restaurants/weekly`
    /// fetch (conditional ETag — server replies 304 if nothing changed, so
    /// it's cheap), re-pulls server-side reserved + blocked sets, then
    /// re-runs the local filter pipeline so the count + picks reflect the
    /// new pool. The `WeeklyRestaurantService.$status` sink rewires
    /// `allRestaurants` automatically when fresh data lands.
    func pullToRefresh() async {
        async let weekly: Void = WeeklyRestaurantService.shared.fetch(city: city)
        async let reserved = ReservationService.shared.fetchReservedRestaurantIds()
        async let blocked  = ReservationService.shared.fetchBlockedRestaurantIds()
        _ = await weekly
        remoteReservedIds = await reserved
        remoteBlockedIds  = await blocked
        weeklySession = WeeklySession.load()
        applyFilter()
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
            if reservableFilterActive, !Self.isReservable(r) { return false }
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
            if reservableFilterActive, !Self.isReservable(r) { continue }
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
        // Mirror the Discovery deck's filter pipeline so the count Home
        // surfaces ("N picks") matches the count Discovery surfaces
        // ("N spots left"). Without these subtractions Home reports the
        // backend pool size (~308) while Discovery reports the post-filter
        // pool (~244 once the user has seen/disliked/blocked/booked rows).
        let today = Date()
        let seen = SeenService.shared.seenToday()

        let filtered = allRestaurants.filter { r in
            if reservableFilterActive, !Self.isReservable(r) { return false }
            if !Self.matchesEnabledSources(r, enabled: enabledSources) { return false }
            if let cuisine = selectedCuisine,
               normalizedCuisine(r.cuisineType) != cuisine { return false }
            if let borough = selectedBorough,
               normalizedBorough(r.borough) != borough { return false }
            if let hood = selectedNeighborhood,
               normalizedNeighborhood(r.neighborhood) != hood { return false }

            // Same exclusions Discovery applies: reserved + blocked
            // (server-side), seen-today (on-device), and swipe history
            // for this week (local).
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
        weeklyCount = filtered.count
        previewRestaurants = filtered
        previewPhotoURLs = filtered.prefix(6).compactMap { $0.photoUrl.flatMap { URL(string: $0) } }
        // HIDDEN GEM is drawn from the mid-ranked slice, outside the top-25
        // photos WeeklyRestaurantService already warms; this also prefetches.
        verifyPickPhotos()
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

    private static func isReservable(_ r: WeeklyRestaurant) -> Bool { r.isBookable }

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
        "Staten Island", "New Jersey", "Hong Kong", "China", "Outside NYC",
        // Bay Area regions (city `bay`; backend cityRegions.ts)
        "San Francisco", "East Bay", "Peninsula", "South Bay", "North Bay"
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
