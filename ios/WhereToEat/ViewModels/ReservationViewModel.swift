import Foundation
import EventKit

enum ReservationFlowState {
    case preBrowser
    case confirming        // "Did your booking go through?"
    case success(Reservation)
    case failed(String)
}

@MainActor
final class ReservationViewModel: ObservableObject {
    @Published var state: ReservationFlowState = .preBrowser
    @Published var showSafari: Bool = false
    @Published var showManualEntry: Bool = false

    let restaurant: Restaurant
    private let notificationService = NotificationService.shared
    private let eventStore = EKEventStore()

    init(restaurant: Restaurant) {
        self.restaurant = restaurant
    }

    // Called when SFSafariViewController is dismissed
    func handleBrowserDismissed() {
        showSafari = false
        state = .confirming
    }

    // Called after user confirms booking in ManualBookingEntryView
    func saveManualBooking(datetime: Date, partySize: Int) async {
        var reservation = Reservation(
            restaurantId: restaurant.id,
            restaurantName: restaurant.name,
            restaurantPhotoUrl: restaurant.primaryPhotoURL,
            datetime: datetime,
            partySize: partySize,
            confirmationCode: "—",   // user completed booking in browser; no code extracted
            platform: .other,
            status: .confirmed
        )

        // Schedule reminder (day before)
        let notifId = await notificationService.scheduleReservationReminder(
            for: reservation,
            restaurantAddress: restaurant.address
        )
        reservation.reminderNotificationId = notifId

        // Add to calendar
        reservation.calendarEventId = await addToCalendar(reservation: reservation)

        // Persist in weekly session (local cache — server is source of truth)
        var session = WeeklySession.load()
        session.addReservation(reservation)
        session.save()

        // Fire-and-forget push to backend so Home on another device / re-install
        // can still show the reservation. Local save already succeeded, so we
        // don't block the UI on this round-trip.
        Task { await ReservationService.shared.pushReservation(reservation) }

        // Tell Home + Bookings list to refresh
        NotificationCenter.default.post(name: .weeklySessionUpdated, object: nil)

        state = .success(reservation)
    }

    // MARK: - Calendar

    private func addToCalendar(reservation: Reservation) async -> String? {
        let status = EKEventStore.authorizationStatus(for: .event)
        if status != .authorized {
            guard let _ = try? await eventStore.requestWriteOnlyAccessToEvents() else { return nil }
        }
        let event = EKEvent(eventStore: eventStore)
        event.title = reservation.restaurantName
        event.startDate = reservation.datetime
        event.endDate = Calendar.current.date(byAdding: .hour, value: 2, to: reservation.datetime)
        event.location = restaurant.address
        event.notes = "Party of \(reservation.partySize)"
        event.calendar = eventStore.defaultCalendarForNewEvents
        try? eventStore.save(event, span: .thisEvent)
        return event.eventIdentifier
    }
}
