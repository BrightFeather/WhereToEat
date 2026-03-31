import Foundation
import Combine

final class HomeViewModel: ObservableObject {
    @Published var weeklySession: WeeklySession
    @Published var showCuisinePrompt: Bool = false
    @Published var navigateToDiscovery: Bool = false

    private let notificationService = NotificationService.shared

    init() {
        self.weeklySession = WeeklySession.load()
    }

    var bannerMessage: String? {
        guard !weeklySession.isComplete else { return nil }
        switch weeklySession.status {
        case .pending:
            return "Pick your weekend restaurants"
        case .inProgress:
            let count = weeklySession.likedRestaurantIds.count
            return count > 0 ? "You liked \(count) restaurant\(count == 1 ? "" : "s") — book one!" : "Keep swiping"
        default:
            return nil
        }
    }

    var hasUpcomingReservations: Bool {
        weeklySession.reservations.contains { $0.datetime > Date() && $0.status == .confirmed }
    }

    var upcomingReservations: [Reservation] {
        weeklySession.reservations
            .filter { $0.datetime > Date() && $0.status == .confirmed }
            .sorted { $0.datetime < $1.datetime }
    }

    func startDiscovery() {
        // Un-skip the session if it was skipped
        if weeklySession.status == .skipped {
            weeklySession.status = .inProgress
            weeklySession.save()
        }
        if weeklySession.cuisinePreferences.isEmpty {
            showCuisinePrompt = true
        } else {
            navigateToDiscovery = true
        }
    }

    func setCuisinesAndStartDiscovery(_ cuisines: [CuisineTag]) {
        weeklySession.cuisinePreferences = cuisines
        weeklySession.save()
        showCuisinePrompt = false
        navigateToDiscovery = true
    }

    func skipThisWeek() {
        weeklySession.status = .skipped
        weeklySession.save()
        notificationService.cancelWeeklyTriggers()
    }

    func refresh() {
        weeklySession = WeeklySession.load()
    }
}
