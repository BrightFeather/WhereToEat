import Foundation
import Combine

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
        let endpoint: Endpoint
        switch source.platform {
        case .resy:
            endpoint = .resySearch(venueId: source.venueId, dates: dateStrings, partySize: partySize)
        case .opentable:
            endpoint = .opentableSearch(venueId: source.venueId, dates: dateStrings, partySize: partySize)
        case .tock:
            endpoint = .tockSearch(venueId: source.venueId, dates: dateStrings, partySize: partySize)
        case .other:
            throw ReservationError.noReservationSource
        }

        let response: SlotSearchResponse = try await api.request(endpoint)
        return response.slots.compactMap { dto -> TimeSlot? in
            guard let date = isoFormatter.date(from: dto.datetime) else { return nil }
            let deposit: Decimal? = dto.depositAmount.map { Decimal($0) }
            return TimeSlot(
                id: dto.id,
                datetime: date,
                partySize: dto.partySize,
                platform: source.platform,
                depositRequired: dto.depositRequired,
                depositAmount: deposit,
                depositPolicy: dto.depositPolicy
            )
        }
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

        let endpoint: Endpoint
        switch source.platform {
        case .resy:
            endpoint = .resyBook(venueId: source.venueId, configId: slot.id,
                                 paymentMethodId: stripePaymentMethodId)
        case .opentable:
            endpoint = .opentableBook(venueId: source.venueId, slotToken: slot.id,
                                       partySize: slot.partySize,
                                       datetime: isoFormatter.string(from: slot.datetime))
        case .tock:
            endpoint = .tockBook(venueId: source.venueId, slotId: slot.id, partySize: slot.partySize)
        case .other:
            throw ReservationError.noReservationSource
        }

        let response: BookingResponse = try await api.request(endpoint)

        return Reservation(
            restaurantId: restaurant.id,
            restaurantName: restaurant.name,
            datetime: slot.datetime,
            partySize: slot.partySize,
            confirmationCode: response.confirmationCode,
            platform: source.platform,
            depositAmount: slot.depositAmount,
            depositPaid: response.depositCharged,
            status: .confirmed
        )
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
