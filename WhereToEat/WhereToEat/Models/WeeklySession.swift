import Foundation

enum WeeklySessionStatus: String, Codable {
    case pending = "pending"
    case inProgress = "in_progress"
    case completed = "completed"
    case skipped = "skipped"
}

struct WeeklySession: Codable, Identifiable {
    var id: UUID = UUID()
    var weekOf: Date          // Monday 00:00 local time
    var cuisinePreferences: [CuisineTag]
    var status: WeeklySessionStatus
    var triggersSent: [Date]
    var swipedCards: [SwipeRecord]
    var reservations: [Reservation]

    init(weekOf: Date) {
        self.weekOf = weekOf
        self.cuisinePreferences = []
        self.status = .pending
        self.triggersSent = []
        self.swipedCards = []
        self.reservations = []
    }

    // Returns the Monday date of the week containing the given date
    static func mondayOf(date: Date = Date()) -> Date {
        var cal = Calendar.current
        cal.firstWeekday = 2 // Monday
        let components = cal.dateComponents([.yearForWeekOfYear, .weekOfYear], from: date)
        return cal.date(from: components) ?? date
    }

    var isCurrentWeek: Bool {
        let thisMonday = WeeklySession.mondayOf()
        return Calendar.current.isDate(weekOf, inSameDayAs: thisMonday)
    }

    var isComplete: Bool {
        status == .completed || status == .skipped
    }

    var likedRestaurantIds: [UUID] {
        swipedCards.filter { $0.decision == .liked }.map(\.restaurantId)
    }

    var dislikedRestaurantIds: [UUID] {
        swipedCards.filter { $0.decision == .disliked }.map(\.restaurantId)
    }

    mutating func recordSwipe(_ record: SwipeRecord) {
        swipedCards.removeAll { $0.restaurantId == record.restaurantId }
        swipedCards.append(record)
        if status == .pending { status = .inProgress }
    }

    mutating func addReservation(_ reservation: Reservation) {
        reservations.append(reservation)
        status = .completed
    }

    // Persistence via UserDefaults (keyed by weekOf ISO string)
    private static let keyPrefix = "weekly_session_"

    static func load(for date: Date = Date()) -> WeeklySession {
        let monday = mondayOf(date: date)
        let key = keyPrefix + iso(monday)
        guard let data = UserDefaults.standard.data(forKey: key),
              let session = try? JSONDecoder().decode(WeeklySession.self, from: data) else {
            return WeeklySession(weekOf: monday)
        }
        return session
    }

    func save() {
        guard let data = try? JSONEncoder().encode(self) else { return }
        UserDefaults.standard.set(data, forKey: WeeklySession.keyPrefix + WeeklySession.iso(weekOf))
    }

    private static func iso(_ date: Date) -> String {
        let fmt = ISO8601DateFormatter()
        fmt.formatOptions = [.withFullDate]
        return fmt.string(from: date)
    }
}
