import Foundation
import Combine
import EventKit

final class ReservationService: ObservableObject {
    static let shared = ReservationService()

    private let api = APIClient.shared

    struct SlotSearchResponse: Decodable {
        var slots: [SlotDTO]
    }

    struct SlotDTO: Decodable {
        var id: String
        var datetime: String   // ISO8601
        var partySize: Int
        var depositRequired: Bool
        var depositAmount: Double?
        var depositPolicy: String?
    }

    struct BookingResponse: Decodable {
        var confirmationCode: String
        var platform: String
        var depositCharged: Bool
    }

    private let isoFormatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    private let dateOnlyFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    // MARK: - Search availability

    func searchAvailability(
        restaurant: Restaurant,
        dates: [Date],
        partySize: Int
    ) async throws -> [TimeSlot] {
        guard let source = restaurant.reservationSource else {
            throw ReservationError.noReservationSource
        }

        let dateStrings = dates.map { dateOnlyFormatter.string(from: $0) }
        // Stage 2: direct API booking via Resy/OpenTable/Tock
        _ = source
        _ = dateStrings
        throw ReservationError.noReservationSource
    }

    // MARK: - Book slot

    func bookSlot(
        slot: TimeSlot,
        restaurant: Restaurant,
        stripePaymentMethodId: String?
    ) async throws -> Reservation {
        guard let source = restaurant.reservationSource else {
            throw ReservationError.noReservationSource
        }

        // Stage 2: direct API booking via Resy/OpenTable/Tock
        _ = slot
        _ = stripePaymentMethodId
        throw ReservationError.noReservationSource
    }

    // MARK: - Remote user-reservation sync

    struct RemoteReservation: Decodable {
        var id: String
        var restaurantId: String
        var restaurantName: String
        var restaurantPhotoUrl: String?
        var datetime: String         // ISO8601
        var partySize: Int
        var confirmationCode: String?
        var platform: String?
        var status: String
        var calendarEventId: String?
        var reminderNotificationId: String?
    }

    struct RemoteReservationsResponse: Decodable {
        var reservations: [RemoteReservation]
    }

    struct RemoteIdResponse: Decodable { var id: String }

    struct RemoteBlock: Decodable {
        var restaurantId: String
        var blockedUntil: String?
    }
    struct RemoteBlocksResponse: Decodable { var blocks: [RemoteBlock] }

    /// Ids of restaurants the current user has booked or blocked. Used by
    /// Discovery to drop them from the card deck.
    func fetchReservedRestaurantIds() async -> Set<UUID> {
        do {
            let resp = try await api.request(Endpoint.userReservationsList,
                                             as: RemoteReservationsResponse.self)
            return Set(resp.reservations.compactMap { UUID(uuidString: $0.restaurantId) })
        } catch {
            print("[ReservationService] fetchReservedRestaurantIds failed: \(error.localizedDescription)")
            return []
        }
    }

    func fetchBlockedRestaurantIds() async -> Set<UUID> {
        do {
            let resp = try await api.request(Endpoint.userBlocksList,
                                             as: RemoteBlocksResponse.self)
            return Set(resp.blocks.compactMap { UUID(uuidString: $0.restaurantId) })
        } catch {
            print("[ReservationService] fetchBlockedRestaurantIds failed: \(error.localizedDescription)")
            return []
        }
    }

    struct RemoteBlockAck: Decodable {
        var restaurantId: String
        var blockedUntil: String?
    }
    struct RemoteRestaurantIdAck: Decodable { var restaurantId: String }

    /// Block a restaurant on the backend. `blockedUntil` nil = block forever.
    func pushBlock(restaurantId: UUID, blockedUntil: Date? = nil) async {
        let iso: String? = blockedUntil.map(Self.isoString(from:))
        do {
            _ = try await api.request(
                Endpoint.userBlockAdd(restaurantId: restaurantId.uuidString, blockedUntil: iso),
                as: RemoteBlockAck.self
            )
        } catch {
            print("[ReservationService] pushBlock failed: \(error.localizedDescription)")
        }
    }

    func removeBlock(restaurantId: UUID) async {
        do {
            _ = try await api.request(
                Endpoint.userBlockRemove(restaurantId: restaurantId.uuidString),
                as: RemoteRestaurantIdAck.self
            )
        } catch {
            print("[ReservationService] removeBlock failed: \(error.localizedDescription)")
        }
    }

    /// Pulls remote reservations for the current user and merges them into the
    /// on-disk WeeklySession cache. Called on app launch and on pull-to-refresh.
    @discardableResult
    func syncFromServer() async -> [Reservation] {
        do {
            let resp = try await api.request(Endpoint.userReservationsList,
                                             as: RemoteReservationsResponse.self)
            let mapped = resp.reservations.compactMap { Self.toLocal($0) }
            mergeIntoWeeklySession(mapped)
            return mapped
        } catch {
            print("[ReservationService] syncFromServer failed: \(error.localizedDescription)")
            return []
        }
    }

    /// Pushes a locally-created reservation to the server. Idempotent on id.
    func pushReservation(_ reservation: Reservation) async {
        let body: [String: Any] = [
            "id": reservation.id.uuidString,
            "restaurantId": reservation.restaurantId.uuidString,
            "restaurantName": reservation.restaurantName,
            "restaurantPhotoUrl": reservation.restaurantPhotoUrl?.absoluteString as Any,
            "datetime": Self.isoString(from: reservation.datetime),
            "partySize": reservation.partySize,
            "confirmationCode": reservation.confirmationCode,
            "platform": reservation.platform.rawValue,
            "status": reservation.status.rawValue,
            "calendarEventId": reservation.calendarEventId as Any,
            "reminderNotificationId": reservation.reminderNotificationId as Any
        ]
        do {
            _ = try await api.request(Endpoint.userReservationCreate(body: body),
                                      as: RemoteIdResponse.self)
        } catch {
            print("[ReservationService] pushReservation failed: \(error.localizedDescription)")
        }
    }

    func deleteReservation(id: UUID) async {
        do {
            _ = try await api.request(Endpoint.userReservationDelete(id: id.uuidString),
                                      as: RemoteIdResponse.self)
        } catch {
            print("[ReservationService] deleteReservation failed: \(error.localizedDescription)")
        }
    }

    /// End-to-end cancellation: drop the local reservation from every saved
    /// WeeklySession, cancel its day-before reminder, remove the calendar
    /// event, fire-and-forget the backend delete, and broadcast the session
    /// update so Home + My Bookings re-render. Safe to call for any id — a
    /// no-op if the id isn't tracked locally.
    @MainActor
    func cancelReservation(id: UUID) async {
        let removed = WeeklySession.removeReservation(id: id)

        if let reminderId = removed?.reminderNotificationId {
            NotificationService.shared.cancelReservationReminder(notificationId: reminderId)
        }
        if let eventId = removed?.calendarEventId {
            removeCalendarEvent(id: eventId)
        }

        NotificationCenter.default.post(name: .weeklySessionUpdated, object: nil)
        await deleteReservation(id: id)
    }

    private func removeCalendarEvent(id: String) {
        let store = EKEventStore()
        let status = EKEventStore.authorizationStatus(for: .event)
        guard status == .authorized || status == .fullAccess || status == .writeOnly else {
            return
        }
        guard let event = store.event(withIdentifier: id) else { return }
        try? store.remove(event, span: .thisEvent)
    }

    private static func toLocal(_ r: RemoteReservation) -> Reservation? {
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = iso.date(from: r.datetime)
            ?? ISO8601DateFormatter().date(from: r.datetime)
            ?? Self.fallbackSqliteDate(r.datetime)
        guard let datetime = date,
              let rid = UUID(uuidString: r.restaurantId),
              let sid = UUID(uuidString: r.id) else { return nil }
        return Reservation(
            id: sid,
            restaurantId: rid,
            restaurantName: r.restaurantName,
            restaurantPhotoUrl: r.restaurantPhotoUrl.flatMap(URL.init(string:)),
            datetime: datetime,
            partySize: r.partySize,
            confirmationCode: r.confirmationCode ?? "—",
            platform: ReservationPlatform(rawValue: r.platform ?? "other") ?? .other,
            reminderNotificationId: r.reminderNotificationId,
            calendarEventId: r.calendarEventId,
            status: ReservationStatus(rawValue: r.status) ?? .confirmed
        )
    }

    /// SQLite's datetime('now') stores like "2026-04-19 12:34:56" (no T / tz).
    private static func fallbackSqliteDate(_ s: String) -> Date? {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd HH:mm:ss"
        f.timeZone = TimeZone(identifier: "UTC")
        return f.date(from: s)
    }

    private static func isoString(from date: Date) -> String {
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime]
        return iso.string(from: date)
    }

    private func mergeIntoWeeklySession(_ remote: [Reservation]) {
        // Bucket remote reservations by their week-of-Monday so we update
        // each affected session in one pass.
        var byWeek: [Date: [Reservation]] = [:]
        for r in remote {
            let monday = WeeklySession.mondayOf(date: r.datetime)
            byWeek[monday, default: []].append(r)
        }
        for (monday, list) in byWeek {
            var session = WeeklySession.load(for: monday)
            var existing = session.reservations
            for r in list {
                if let idx = existing.firstIndex(where: { $0.id == r.id }) {
                    existing[idx] = r
                } else {
                    existing.append(r)
                }
            }
            session.reservations = existing
            session.save()
        }
        NotificationCenter.default.post(name: .weeklySessionUpdated, object: nil)
    }

    // MARK: - Weekend date helpers

    /// Returns Fri, Sat, Sun dates of the upcoming or current weekend
    static func upcomingWeekendDates() -> [Date] {
        var cal = Calendar.current
        cal.firstWeekday = 2  // Monday
        let today = Date()
        let weekday = cal.component(.weekday, from: today)

        // Find next Friday (weekday = 6 in Gregorian 1=Sun)
        var daysUntilFriday = (6 - weekday + 7) % 7
        if daysUntilFriday == 0 && cal.component(.hour, from: today) >= 18 {
            daysUntilFriday = 7  // if it's Friday evening, get next weekend
        }

        return (0...2).compactMap { offset in
            cal.date(byAdding: .day, value: daysUntilFriday + offset, to: today)
        }
    }
}

enum ReservationError: LocalizedError {
    case noReservationSource
    case noSlotsAvailable
    case bookingFailed(String)
    case paymentFailed(String)

    var errorDescription: String? {
        switch self {
        case .noReservationSource: return "No reservation system available for this restaurant"
        case .noSlotsAvailable: return "No available time slots"
        case .bookingFailed(let msg): return "Booking failed: \(msg)"
        case .paymentFailed(let msg): return "Payment failed: \(msg)"
        }
    }
}
