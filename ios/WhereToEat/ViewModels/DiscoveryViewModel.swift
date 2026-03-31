import Foundation
import Combine
import CoreLocation

final class DiscoveryViewModel: ObservableObject {
    @Published var cards: [Restaurant] = []
    @Published var isLoading: Bool = false
    @Published var errorMessage: String?
    @Published var currentIndex: Int = 0
    @Published var likedRestaurant: Restaurant?   // triggers navigation to Task 2
    @Published var isDeckEmpty: Bool = false

    private let discoveryService = DiscoveryService.shared
    private let locationService = LocationService.shared
    private var weeklySession: WeeklySession
    private var customList: [Restaurant] = []   // injected from CustomListViewModel

    init(session: WeeklySession, customList: [Restaurant] = []) {
        self.weeklySession = session
        self.customList = customList
    }

    var currentCard: Restaurant? {
        guard currentIndex < cards.count else { return nil }
        return cards[currentIndex]
    }

    var remainingCount: Int { max(0, cards.count - currentIndex) }

    // MARK: - Load

    func loadCards() async {
        guard let coords = locationService.effectiveCoordinates else {
            errorMessage = "Location unavailable"
            return
        }
        isLoading = true
        errorMessage = nil

        let profile = UserProfile.load()
        let result = await discoveryService.fetchRestaurants(
            coordinates: coords,
            city: locationService.effectiveCityName,
            cuisines: weeklySession.cuisinePreferences,
            dietaryPrefs: profile.dietaryPreferences,
            customList: customList,
            swipeHistory: weeklySession.swipedCards
        )

        if !result.errors.isEmpty {
            errorMessage = result.errors.joined(separator: "\n")
        }

        cards = result.restaurants
        currentIndex = 0
        isDeckEmpty = cards.isEmpty
        isLoading = false

        // Enrich first 3 cards eagerly
        await enrichVisibleCards()
    }

    private func enrichVisibleCards() async {
        let toEnrich = min(3, cards.count)
        for i in 0..<toEnrich {
            cards[i] = await discoveryService.enrich(cards[i])
        }
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
        advance()
    }

    func block() {
        guard let card = currentCard else { return }
        record(SwipeRecord(restaurantId: card.id, decision: .blocked))
        advance()
    }

    func skip() {
        guard let card = currentCard else { return }
        record(SwipeRecord(restaurantId: card.id, decision: .skipped))
        advance()
    }

    private func advance() {
        currentIndex += 1
        if currentIndex >= cards.count {
            isDeckEmpty = true
        } else {
            // Enrich next card ahead
            Task {
                let nextIndex = currentIndex + 2
                if nextIndex < cards.count {
                    cards[nextIndex] = await discoveryService.enrich(cards[nextIndex])
                }
            }
        }
    }

    private func record(_ swipe: SwipeRecord) {
        weeklySession.recordSwipe(swipe)
        weeklySession.save()
    }

    // Called when a reservation is completed for a restaurant
    func markReservationComplete(restaurantId: UUID) {
        let blockRecord = SwipeRecord(restaurantId: restaurantId, decision: .blocked)
        weeklySession.recordSwipe(blockRecord)
        weeklySession.save()
        NotificationService.shared.cancelWeeklyTriggers()
    }
}
