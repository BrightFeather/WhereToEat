import UIKit
import UserNotifications

class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {

    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    // Handle notification tap while app is in foreground
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound, .badge])
    }

    // Handle notification action taps
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let actionId = response.actionIdentifier
        let userInfo = response.notification.request.content.userInfo

        switch actionId {
        case NotificationService.actionSkipWeek:
            Task { @MainActor in
                var session = WeeklySession.load()
                session.status = .skipped
                session.save()
                NotificationService.shared.cancelWeeklyTriggers()
            }

        case NotificationService.actionCancelReservation:
            if let reservationId = userInfo["reservationId"] as? String,
               let uuid = UUID(uuidString: reservationId) {
                Task { @MainActor in
                    var session = WeeklySession.load()
                    if let idx = session.reservations.firstIndex(where: { $0.id == uuid }) {
                        session.reservations[idx].status = .cancelled
                        session.save()
                    }
                }
            }

        default:
            break
        }

        completionHandler()
    }
}
