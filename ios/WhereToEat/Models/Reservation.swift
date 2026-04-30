import Foundation

enum ReservationStatus: String, Codable {
    case confirmed = "confirmed"
    case cancelled = "cancelled"
    case pending = "pending"
}

struct TimeSlot: Codable, Identifiable, Equatable {
    var id: String  // platform-specific config id (e.g. Resy config_id)
    var datetime: Date
    var partySize: Int
    var platform: ReservationPlatform
    var depositRequired: Bool
    var depositAmount: Decimal?
    var depositPolicy: String?
}

struct Reservation: Codable, Identifiable, Equatable {
    var id: UUID
    var restaurantId: UUID
    var restaurantName: String
    var restaurantPhotoUrl: URL?
    var datetime: Date
    var partySize: Int
    var confirmationCode: String
    var platform: ReservationPlatform
    var depositAmount: Decimal?
    var depositPaid: Bool
    var stripePaymentIntentId: String?
    var reminderNotificationId: String?
    var calendarEventId: String?
    var status: ReservationStatus
    var createdAt: Date

    init(
        id: UUID = UUID(),
        restaurantId: UUID,
        restaurantName: String,
        restaurantPhotoUrl: URL? = nil,
        datetime: Date,
        partySize: Int,
        confirmationCode: String,
        platform: ReservationPlatform,
        depositAmount: Decimal? = nil,
        depositPaid: Bool = false,
        stripePaymentIntentId: String? = nil,
        reminderNotificationId: String? = nil,
        calendarEventId: String? = nil,
        status: ReservationStatus = .confirmed,
        createdAt: Date = Date()
    ) {
        self.id = id
        self.restaurantId = restaurantId
        self.restaurantName = restaurantName
        self.restaurantPhotoUrl = restaurantPhotoUrl
        self.datetime = datetime
        self.partySize = partySize
        self.confirmationCode = confirmationCode
        self.platform = platform
        self.depositAmount = depositAmount
        self.depositPaid = depositPaid
        self.stripePaymentIntentId = stripePaymentIntentId
        self.reminderNotificationId = reminderNotificationId
        self.calendarEventId = calendarEventId
        self.status = status
        self.createdAt = createdAt
    }
}
