import Foundation
import Combine

@MainActor
final class DiscoveryViewModel: ObservableObject {
    @Published var cards: [Restaurant] = []
    @Published var isLoading: Bool = false
    @Published var buildingMessage: String? = nil
    @Published var errorMessage: String?
    @Published var currentIndex: Int = 0
    @Published var likedRestaurant: Restaurant?
    @Published var isDeckEmpty: Bool = false
    @Published var availableNeighborhoods: [String] = []
    /// Multi-select: user can pick any number of neighborhoods within the
    /// currently-selected borough. Empty set means "all neighborhoods".
    @Published var selectedNeighborhoods: Set<String> = [] {
        didSet { applyFilter() }
    }
    @Published var availableBoroughs: [String] = []
    @Published var selectedBorough: String? = nil
    @Published var availableCuisines: [String] = []
    @Published var selectedCuisine: String? = nil {
        didSet { applyFilter() }
    }

    /// Mirrors UserProfile.showOnlyReservable. When true we drop any card that
    /// doesn't have a Resy/OpenTable booking link.
    @Published var showOnlyReservable: Bool = UserProfile.load().showOnlyReservable

    /// Mirrors UserProfile.discoverySources — the set of `source_type` values
    /// the user has opted into. Same semantics as Home: a card is in the deck
    /// iff it has ≥1 source row whose type is enabled. Empty set drops everything.
    @Published var enabledSources: Set<String> = UserProfile.load().discoverySources

    private let weeklyService = WeeklyRestaurantService.shared
    private let reservationService = ReservationService.shared
    private var weeklySession: WeeklySession
    private var customList: [Restaurant] = []
    private var allCards: [Restaurant] = []  // unfiltered
    /// Restaurant ids the server says this user has already booked — filtered
    /// out of the deck. Fetched on `loadCards`; empty until then so we don't
    /// block the first render.
    private var remoteReservedIds: Set<UUID> = []
    /// Restaurant ids the server says this user has blocked — filtered out.
    private var remoteBlockedIds: Set<UUID> = []
    private var cancellables = Set<AnyCancellable>()

    init(session: WeeklySession, customList: [Restaurant] = [], initialNeighborhood: String? = nil) {
        self.weeklySession = session
        self.customList = customList
        // `initialNeighborhood` may actually be a borough from the Home screen.
        // Decide where to stash it once cards load (see `resolveInitialFilter`).
        self.pendingInitialFilter = initialNeighborhood
        NotificationCenter.default.publisher(for: .userProfileUpdated)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] _ in
                guard let self else { return }
                let profile = UserProfile.load()
                let reservableChanged = self.showOnlyReservable != profile.showOnlyReservable
                let sourcesChanged = self.enabledSources != profile.discoverySources
                guard reservableChanged || sourcesChanged else { return }
                self.showOnlyReservable = profile.showOnlyReservable
                self.enabledSources = profile.discoverySources
                self.buildBoroughs()
                self.buildCuisines()
                self.rebuildNeighborhoodOptions()
                self.applyFilter()
            }
            .store(in: &cancellables)
    }

    private var pendingInitialFilter: String?

    var currentCard: Restaurant? {
        guard currentIndex < cards.count else { return nil }
        return cards[currentIndex]
    }

    var remainingCount: Int { max(0, cards.count - currentIndex) }

    // MARK: - Load

    func loadCards() async {
        isLoading = true
        errorMessage = nil
        buildingMessage = nil

        // Pull the user's server-side reserved + blocked ids in parallel with
        // the weekly fetch. A failure on either is non-fatal — we just end up
        // with an empty filter set and show the full deck (safe fallback).
        async let reservedTask = reservationService.fetchReservedRestaurantIds()
        async let blockedTask  = reservationService.fetchBlockedRestaurantIds()
        await weeklyService.bootstrap(city: "nyc")
        remoteReservedIds = await reservedTask
        remoteBlockedIds  = await blockedTask

        switch weeklyService.status {
        case .ready(let weekly), .stale(let weekly):
            if case .stale = weeklyService.status {
                buildingMessage = "Refreshing this week's list…"
            }
            buildDeck(from: weekly)

        case .building:
            buildingMessage = "Building this week's list…"
            isDeckEmpty = true
            weeklyService.$status
                .receive(on: DispatchQueue.main)
                .sink { [weak self] newStatus in
                    if case .ready(let weekly) = newStatus {
                        self?.buildDeck(from: weekly)
                        self?.buildingMessage = nil
                    }
                }
                .store(in: &cancellables)

        case .error(let msg):
            errorMessage = msg
            isDeckEmpty = true
        }

        isLoading = false
    }

    private func buildDeck(from weekly: [WeeklyRestaurant]) {
        let today = Date()
        var restaurants = customList + weekly.map { $0.toRestaurant() }

        let seenTodayIds = SeenService.shared.seenToday()

        // Filter snoozed + blocked (local swipedCards + server-side blocks) +
        // reserved (server) + already-seen-today (on-device).
        restaurants = restaurants.filter { restaurant in
            if restaurant.isSnoozed { return false }
            if remoteReservedIds.contains(restaurant.id) { return false }
            if remoteBlockedIds.contains(restaurant.id)  { return false }
            if seenTodayIds.contains(restaurant.id)      { return false }

            let record = weeklySession.swipedCards.first { $0.restaurantId == restaurant.id }
            guard let record else { return true }
            if record.decision == .blocked, let until = record.blockedUntil, today < until { return false }
            if record.decision == .disliked {
                let sameWeek = Calendar.current.isDate(record.timestamp, equalTo: today, toGranularity: .weekOfYear)
                return !sameWeek
            }
            return true
        }

        // Custom list first; within the XHS pool we band-shuffle so the top
        // of the deck doesn't always show the same 5 restaurants. The
        // backend already sorted by score; we keep that score order at the
        // band level (first 25 stay near the top, next 25 in the middle,
        // etc.) and shuffle WITHIN each band each time `loadCards` runs.
        // Net effect: top picks still come first, but the user sees a
        // different mix of those top picks every session.
        let custom = restaurants.filter { $0.isCustom }
        let xhs    = restaurants.filter { !$0.isCustom }
        let bandSize = 25
        var shuffledXHS: [Restaurant] = []
        shuffledXHS.reserveCapacity(xhs.count)
        var idx = 0
        while idx < xhs.count {
            let end = min(idx + bandSize, xhs.count)
            shuffledXHS.append(contentsOf: xhs[idx..<end].shuffled())
            idx = end
        }
        restaurants = custom + shuffledXHS

        allCards = restaurants
        buildBoroughs()
        buildCuisines()
        resolveInitialFilter()
        rebuildNeighborhoodOptions()
        applyFilter()
    }

    /// Treat the incoming `initialNeighborhood` as either a borough or a neighborhood.
    private func resolveInitialFilter() {
        guard let value = pendingInitialFilter else { return }
        pendingInitialFilter = nil
        if availableBoroughs.contains(value) {
            selectedBorough = value
        } else {
            selectedNeighborhoods = [value]
        }
    }

    /// Toggle a neighborhood in the multi-select set. Tapping the same one deselects.
    func toggleNeighborhood(_ hood: String) {
        if selectedNeighborhoods.contains(hood) {
            selectedNeighborhoods.remove(hood)
        } else {
            selectedNeighborhoods.insert(hood)
        }
    }

    /// Clear all neighborhood picks (returns to "All neighborhoods" within current borough).
    func clearNeighborhoods() {
        selectedNeighborhoods.removeAll()
    }

    private func buildBoroughs() {
        var counts: [String: Int] = [:]
        for card in allCards {
            if showOnlyReservable, card.reservationSource == nil { continue }
            let b = normalizedBorough(card.borough)
            counts[b, default: 0] += 1
        }
        availableBoroughs = counts
            .sorted { $0.value == $1.value ? $0.key < $1.key : $0.value > $1.value }
            .map(\.key)
    }

    func selectBorough(_ borough: String?) {
        if let newValue = borough, newValue == selectedBorough {
            selectedBorough = nil
        } else {
            selectedBorough = borough
        }
        selectedNeighborhoods.removeAll()
        rebuildNeighborhoodOptions()
        applyFilter()
    }

    private func rebuildNeighborhoodOptions() {
        guard let borough = selectedBorough else {
            availableNeighborhoods = []
            return
        }
        var counts: [String: Int] = [:]
        for card in allCards where normalizedBorough(card.borough) == borough {
            if showOnlyReservable, card.reservationSource == nil { continue }
            guard let hood = card.neighborhood?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !hood.isEmpty else { continue }
            counts[hood, default: 0] += 1
        }
        availableNeighborhoods = counts
            .sorted { $0.value == $1.value ? $0.key < $1.key : $0.value > $1.value }
            .map(\.key)
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

    private func buildCuisines() {
        var counts: [String: Int] = [:]
        for card in allCards {
            if showOnlyReservable, card.reservationSource == nil { continue }
            guard let c = normalizedCuisine(card.rawCuisineType) else { continue }
            counts[c, default: 0] += 1
        }
        // Alphabetical — predictable ordering beats frequency-biased ordering
        // once the cuisine set is stable across weeks.
        availableCuisines = counts.keys.sorted { $0.localizedCompare($1) == .orderedAscending }
    }

    /// Backend cuisine keys are canonical CuisineTag rawValues now. Reject
    /// anything outside the closed enum so legacy free-form strings like
    /// "Coffee" or "Hotel" don't surface as filter chips.
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

    private func applyFilter() {
        cards = allCards.filter { card in
            if showOnlyReservable, card.reservationSource == nil { return false }
            if !Self.matchesEnabledSources(card, enabled: enabledSources) { return false }
            if let borough = selectedBorough, normalizedBorough(card.borough) != borough { return false }
            if !selectedNeighborhoods.isEmpty {
                let hood = card.neighborhood?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                if !selectedNeighborhoods.contains(hood) { return false }
            }
            if let cuisine = selectedCuisine, normalizedCuisine(card.rawCuisineType) != cuisine { return false }
            return true
        }
        currentIndex = 0
        isDeckEmpty = cards.isEmpty
    }

    /// Mirror of `HomeViewModel.matchesEnabledSources` for the unified
    /// `Restaurant` model. Custom-list restaurants always pass — they were
    /// added by the user directly and aren't gated by Discovery sources.
    private static func matchesEnabledSources(_ r: Restaurant, enabled: Set<String>) -> Bool {
        if r.isCustom { return true }
        if enabled.isEmpty { return false }
        let types: [String]
        if let sources = r.xhsSources, !sources.isEmpty {
            types = sources.map(\.resolvedType)
        } else {
            types = ["xiaohongshu"]
        }
        return types.contains { enabled.contains($0) }
    }

    // MARK: - Swipe actions

    func swipeRight() {
        guard let card = currentCard else { return }
        record(SwipeRecord(restaurantId: card.id, decision: .liked))
        likedRestaurant = card
        advance()
    }

    func swipeLeft() {
        guard let card = currentCard else { return }
        record(SwipeRecord(restaurantId: card.id, decision: .disliked))
        Task { await weeklyService.markUnavailable(id: card.id.uuidString) }
        advance()
    }

    func block() {
        guard let card = currentCard else { return }
        record(SwipeRecord(restaurantId: card.id, decision: .blocked))
        // Server-side block with a 28-day TTL to match the UI copy
        // ("Block for 4 weeks"). A long-press "block forever" can pass nil
        // later; this default keeps casual blocks from gating good spots
        // from the deck permanently.
        let blockedUntil = Calendar.current.date(byAdding: .day, value: 28, to: Date())
        Task {
            await reservationService.pushBlock(restaurantId: card.id, blockedUntil: blockedUntil)
            await weeklyService.markUnavailable(id: card.id.uuidString)
        }
        remoteBlockedIds.insert(card.id)
        advance()
    }

    func save() {
        guard let card = currentCard else { return }
        record(SwipeRecord(restaurantId: card.id, decision: .skipped))
        NotificationCenter.default.post(name: .saveRestaurant, object: card)
        // Move on. `advance()` also stamps the card in SeenService so it
        // won't come back today.
        advance()
    }

    func skip() {
        guard let card = currentCard else { return }
        record(SwipeRecord(restaurantId: card.id, decision: .skipped))
        advance()
    }

    func skipForOneMonth() {
        guard let card = currentCard else { return }
        if let idx = cards.firstIndex(where: { $0.id == card.id }) {
            cards[idx].snoozedUntil = Calendar.current.date(byAdding: .day, value: 30, to: Date())
        }
        NotificationCenter.default.post(name: .snoozeRestaurant, object: card.id)
        advance()
    }

    private func advance() {
        // Stamp the card we're leaving as "seen today" before advancing so a
        // reload or tab-switch later in the day doesn't re-deal it. Call
        // before the index bump since `currentCard` reads the current index.
        if let leaving = currentCard {
            SeenService.shared.markSeen(leaving.id)
        }
        currentIndex += 1
        isDeckEmpty = currentIndex >= cards.count
    }

    /// True when there's at least one card behind the current position to
    /// rewind to. Drives the enable/disable state of the Discovery rewind
    /// button.
    var canUndo: Bool { currentIndex > 0 }

    /// Tinder-style "undo last swipe": rolls the deck back one card, removes
    /// the card from today's seen-set, pops the latest swipe record, and
    /// reverses any side effects (server-side block, liked-restaurant sheet).
    /// No-op when the user is already on the first card. Best-effort: a
    /// failed server DELETE on a block is logged but doesn't gate the local
    /// rewind, since the user already sees the card again.
    func undoLast() {
        guard canUndo else { return }
        currentIndex -= 1

        guard let restoredCard = currentCard else {
            isDeckEmpty = false
            return
        }

        // Un-stamp from today's seen set so the deck-filter rebuild on next
        // loadCards doesn't drop it again. Cheap to call even when the id
        // isn't actually in the set.
        SeenService.shared.unmarkSeen(restoredCard.id)

        // Pop the matching swipe record (latest by timestamp). Defensive: if
        // multiple records exist for the same id this only removes the last.
        if let lastIdx = weeklySession.swipedCards.lastIndex(where: { $0.restaurantId == restoredCard.id }) {
            let popped = weeklySession.swipedCards.remove(at: lastIdx)
            weeklySession.save()

            // Reverse decision-specific side effects.
            switch popped.decision {
            case .blocked:
                remoteBlockedIds.remove(restoredCard.id)
                Task { await reservationService.removeBlock(restaurantId: restoredCard.id) }
            case .liked:
                if likedRestaurant?.id == restoredCard.id {
                    likedRestaurant = nil
                }
            case .disliked, .skipped:
                break
            }
        }

        isDeckEmpty = currentIndex >= cards.count
    }

    private func record(_ swipe: SwipeRecord) {
        weeklySession.recordSwipe(swipe)
        weeklySession.save()
    }

    func markReservationComplete(restaurantId: UUID) {
        let blockRecord = SwipeRecord(restaurantId: restaurantId, decision: .blocked)
        weeklySession.recordSwipe(blockRecord)
        weeklySession.save()
        Task { await weeklyService.markUnavailable(id: restaurantId.uuidString) }
        NotificationService.shared.cancelWeeklyTriggers()
    }
}
