import Foundation
import Combine
import UserNotifications

final class NotificationService: ObservableObject {
    static let shared = NotificationService()

    private let center = UNUserNotificationCenter.current()

    static let weeklyDiscoveryCategory = "WEEKLY_DISCOVERY"
    static let reservationReminderCategory = "RESERVATION_REMINDER"

    static let actionSkipWeek = "SKIP_WEEK"
    static let actionOpenApp = "OPEN_APP"
    static let actionDirections = "DIRECTIONS"
    static let actionViewBooking = "VIEW_BOOKING"
    static let actionCancelReservation = "CANCEL_RESERVATION"

    func requestPermission() async -> Bool {
        do {
            let granted = try await center.requestAuthorization(options: [.alert, .badge, .sound])
            if granted { registerCategories() }
            return granted
        } catch {
            return false
        }
    }

    private func registerCategories() {
        let skipAction = UNNotificationAction(identifier: Self.actionSkipWeek,
                                              title: "Skip this week", options: [])
        let openAction = UNNotificationAction(identifier: Self.actionOpenApp,
                                              title: "Pick restaurants", options: [.foreground])
        let discoveryCategory = UNNotificationCategory(
            identifier: Self.weeklyDiscoveryCategory,
            actions: [openAction, skipAction], intentIdentifiers: [])

        let directionsAction = UNNotificationAction(identifier: Self.actionDirections,
                                                    title: "Directions", options: [.foreground])
        let viewBookingAction = UNNotificationAction(identifier: Self.actionViewBooking,
                                                     title: "View Booking", options: [.foreground])
        let cancelAction = UNNotificationAction(identifier: Self.actionCancelReservation,
                                                title: "Cancel Reservation",
                                                options: [.destructive, .foreground])
        let reminderCategory = UNNotificationCategory(
            identifier: Self.reservationReminderCategory,
            actions: [directionsAction, viewBookingAction, cancelAction], intentIdentifiers: [])

        center.setNotificationCategories([discoveryCategory, reminderCategory])
    }

    func scheduleWeeklyTriggers() async {
        let session = WeeklySession.load()
        guard !session.isComplete else { return }

        for weekday in [2, 3, 4] {
            let id = "weekly_discovery_\(weekday)"
            center.removePendingNotificationRequests(withIdentifiers: [id])

            var comps = DateComponents()
            comps.weekday = weekday
            comps.hour = 18
            comps.minute = 0

            let content = UNMutableNotificationContent()
            content.title = "Time to pick your weekend restaurants"
            content.body = "Swipe through this week's picks and lock in a reservation."
            content.sound = .default
            content.categoryIdentifier = Self.weeklyDiscoveryCategory

            let request = UNNotificationRequest(
                identifier: id, content: content,
                trigger: UNCalendarNotificationTrigger(dateMatching: comps, repeats: true))
            try? await center.add(request)
        }
    }

    func cancelWeeklyTriggers() {
        center.removePendingNotificationRequests(withIdentifiers: [
            "weekly_discovery_2", "weekly_discovery_3", "weekly_discovery_4"
        ])
    }

    func scheduleReservationReminder(for reservation: Reservation, restaurantAddress: String) async -> String? {
        guard let reminderDate = Calendar.current.date(byAdding: .hour, value: -24,
                                                        to: reservation.datetime),
              reminderDate > Date() else { return nil }

        let id = "reservation_reminder_\(reservation.id.uuidString)"
        let formatter = DateFormatter()
        formatter.timeStyle = .short

        let content = UNMutableNotificationContent()
        content.title = "\(reservation.restaurantName) tomorrow at \(formatter.string(from: reservation.datetime))"
        content.body = "\(reservation.partySize) people · \(restaurantAddress)"
        content.sound = .default
        content.categoryIdentifier = Self.reservationReminderCategory
        content.userInfo = ["reservationId": reservation.id.uuidString,
                            "restaurantAddress": restaurantAddress]

        let trigger = UNTimeIntervalNotificationTrigger(
            timeInterval: reminderDate.timeIntervalSinceNow, repeats: false)
        let request = UNNotificationRequest(identifier: id, content: content, trigger: trigger)
        do {
            try await center.add(request)
            return id
        } catch {
            return nil
        }
    }

    func cancelReservationReminder(notificationId: String) {
        center.removePendingNotificationRequests(withIdentifiers: [notificationId])
    }
}
