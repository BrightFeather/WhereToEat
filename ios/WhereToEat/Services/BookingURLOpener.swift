import UIKit

/// Opens a reservation URL, preferring the native Resy / OpenTable / Tock
/// app via Universal Links and falling back to the in-app
/// SFSafariViewController presenter when no app handler is installed.
///
/// Why this matters: tapping "Book this one" used to open every URL inside
/// SFSafariViewController, even when the user had Resy installed — losing
/// saved cards, contacts, and the native availability picker. iOS' Universal
/// Links route `https://resy.com/...` (and `https://www.opentable.com/...`,
/// `https://www.exploretock.com/...`) into the app when registered. Calling
/// `UIApplication.open(_, options: [.universalLinksOnly: true])` returns
/// `success == false` if no app claims the URL — that's our fallback signal.
///
/// Booking-flow continuity: the existing detail-view state machine fires
/// `ConfirmBookingForm` *after* the browser dismisses. When we hand off to
/// the native app instead, there's no `safariViewControllerDidFinish` to
/// observe. We listen for `UIApplication.didBecomeActiveNotification` and
/// fire `onReturn` once the user is back in WhereToEat — preserving the
/// "did you book?" prompt regardless of which surface they used.
enum BookingURLOpener {
    /// Hosts that have native iOS apps with Universal Links worth trying.
    /// Anything else (restaurant websites, Maps URLs, fallback links) goes
    /// straight to SFSafariViewController.
    private static let appHandledHosts: Set<String> = [
        "resy.com", "www.resy.com",
        "opentable.com", "www.opentable.com",
        "tock.com", "www.tock.com", "exploretock.com", "www.exploretock.com"
    ]

    /// Strong reference to the active foreground-return observer. Only one
    /// can be live at a time — overlapping bookings would confuse the
    /// user-facing state machine, so a new `open(_:)` cancels the previous
    /// pending observer before installing its own.
    private static var foregroundObserver: NSObjectProtocol?

    /// - Parameters:
    ///   - url: The booking URL to open.
    ///   - onReturn: Fired when the user returns to WhereToEat — either
    ///     dismissing SFSafariViewController, or backgrounding the
    ///     reservation app and switching back. Drives `ConfirmBookingForm`
    ///     in `RestaurantDetailView`.
    static func open(_ url: URL, onReturn: @escaping () -> Void) {
        let host = url.host?.lowercased() ?? ""
        guard appHandledHosts.contains(host) else {
            SafariPresenter.present(url: url, onDismiss: onReturn)
            return
        }

        UIApplication.shared.open(url, options: [.universalLinksOnly: true]) { success in
            if success {
                DispatchQueue.main.async {
                    installForegroundReturnObserver(onReturn: onReturn)
                }
            } else {
                DispatchQueue.main.async {
                    SafariPresenter.present(url: url, onDismiss: onReturn)
                }
            }
        }
    }

    private static func installForegroundReturnObserver(onReturn: @escaping () -> Void) {
        if let existing = foregroundObserver {
            NotificationCenter.default.removeObserver(existing)
            foregroundObserver = nil
        }
        foregroundObserver = NotificationCenter.default.addObserver(
            forName: UIApplication.didBecomeActiveNotification,
            object: nil,
            queue: .main
        ) { _ in
            if let observer = foregroundObserver {
                NotificationCenter.default.removeObserver(observer)
                foregroundObserver = nil
            }
            onReturn()
        }
    }
}
