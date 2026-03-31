import Foundation

enum SwipeDecision: String, Codable {
    case liked = "liked"
    case disliked = "disliked"
    case skipped = "skipped"
    case blocked = "blocked"
}

struct SwipeRecord: Codable, Identifiable, Equatable {
    var id: UUID = UUID()
    var restaurantId: UUID
    var decision: SwipeDecision
    var blockedUntil: Date?
    var timestamp: Date

    init(restaurantId: UUID, decision: SwipeDecision, timestamp: Date = Date()) {
        self.restaurantId = restaurantId
        self.decision = decision
        self.timestamp = timestamp
        if decision == .blocked {
            self.blockedUntil = Calendar.current.date(byAdding: .weekOfYear, value: 4, to: timestamp)
        }
    }

    var isCurrentlyBlocked: Bool {
        guard decision == .blocked, let until = blockedUntil else { return false }
        return Date() < until
    }
}
