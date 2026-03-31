import Foundation
import Combine
import EventKit

enum ReservationFlowState {
    case selectingSlot
    case confirming(TimeSlot)
    case processingPayment
    case success(Reservation)
    case failed(String)
    case noAvailability
}

final class ReservationViewModel: ObservableObject {
    @Published var state: ReservationFlowState = .selectingSlot
    @Published var availableSlots: [TimeSlot] = []
    @Published var isLoadingSlots: Bool = false
    @Published var selectedDates: [Date]
    @Published var partySize: Int
    @Published var completedReservation: Reservation?

    let restaurant: Restaurant
    private let reservationService = ReservationService.shared
    private let paymentService = PaymentService.shared
    private let notificationService = NotificationService.shared
    private let eventStore = EKEventStore()

    init(restaurant: Restaurant) {
        self.restaurant = restaurant
        self.selectedDates = ReservationService.upcomingWeekendDates()
        self.partySize = UserProfile.load().defaultPartySize
    }

    var slotsByDay: [(date: Date, slots: [TimeSlot])] {
        let cal = Calendar.current
        let grouped = Dictionary(grouping: availableSlots) { slot in
            cal.startOfDay(for: slot.datetime)
        }
        return grouped.sorted { $0.key < $1.key }.map { (date: $0.key, slots: $0.value.sorted { $0.datetime < $1.datetime }) }
    }

    // MARK: - Load availability

    func loadAvailability() async {
        isLoadingSlots = true
        do {
            availableSlots = try await reservationService.searchAvailability(
                restaurant: restaurant,
                dates: selectedDates,
                partySize: partySize
            )
            if availableSlots.isEmpty { state = .noAvailability }
        } catch {
            state = .failed(error.localizedDescription)
        }
        isLoadingSlots = false
    }

    // MARK: - Select slot

    func selectSlot(_ slot: TimeSlot) {
        state = .confirming(slot)
    }

    // MARK: - Confirm and book

    func confirmBooking(slot: TimeSlot) async {
        if slot.depositRequired {
            await handleDepositAndBook(slot: slot)
        } else {
            await bookSlot(slot: slot, paymentMethodId: nil)
        }
    }

    private func handleDepositAndBook(slot: TimeSlot) async {
        guard let amount = slot.depositAmount else {
            await bookSlot(slot: slot, paymentMethodId: nil)
            return
        }

        state = .processingPayment

        // Request Apple Pay sheet
        await withCheckedContinuation { continuation in
            paymentService.requestApplePayment(amount: amount, restaurantName: restaurant.name) { [weak self] result in
                Task { @MainActor [weak self] in
                    switch result {
                    case .success(let methodId):
                        await self?.bookSlot(slot: slot, paymentMethodId: methodId)
                    case .cancelled:
                        self?.state = .confirming(slot)
                    case .failed(let error):
                        self?.state = .failed(error.localizedDescription)
                    }
                    continuation.resume()
                }
            }
        }
    }

    private func bookSlot(slot: TimeSlot, paymentMethodId: String?) async {
        do {
            var reservation = try await reservationService.bookSlot(
                slot: slot,
                restaurant: restaurant,
                stripePaymentMethodId: paymentMethodId
            )

            // Schedule reminder
            let notifId = await notificationService.scheduleReservationReminder(
                for: reservation,
                restaurantAddress: restaurant.address
            )
            reservation.reminderNotificationId = notifId

            // Add to calendar
            let calEventId = await addToCalendar(reservation: reservation)
            reservation.calendarEventId = calEventId

            // Persist
            var session = WeeklySession.load()
            session.addReservation(reservation)
            session.save()

            completedReservation = reservation
            state = .success(reservation)
        } catch {
            state = .failed(error.localizedDescription)
        }
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
        event.notes = "Confirmation: \(reservation.confirmationCode)\nParty of \(reservation.partySize)"
        event.calendar = eventStore.defaultCalendarForNewEvents

        do {
            try eventStore.save(event, span: .thisEvent)
            return event.eventIdentifier
        } catch {
            return nil
        }
    }
}
