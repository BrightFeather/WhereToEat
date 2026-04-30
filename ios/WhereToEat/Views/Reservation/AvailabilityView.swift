import SwiftUI
import SafariServices

// MARK: - Safari presenter (UIKit-direct, bypasses SwiftUI modal stack)

/// Presents SFSafariViewController directly on the topmost UIViewController.
/// Why: presenting Safari via SwiftUI .sheet/.fullScreenCover *inside* another
/// .sheet causes iOS to cascade-dismiss the outer sheet when Safari closes,
/// wiping the ConfirmBookingForm. Routing through UIKit keeps the SwiftUI
/// modal hierarchy untouched.
enum SafariPresenter {
    private static var activeDelegate: SafariDelegate?

    static func present(url: URL, onDismiss: @escaping () -> Void) {
        guard let top = topViewController() else { return }
        let vc = SFSafariViewController(url: url)
        let delegate = SafariDelegate {
            activeDelegate = nil
            onDismiss()
        }
        activeDelegate = delegate
        vc.delegate = delegate
        vc.modalPresentationStyle = .fullScreen
        top.present(vc, animated: true)
    }

    private static func topViewController() -> UIViewController? {
        let scene = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .first { $0.activationState == .foregroundActive }
            ?? UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        guard let window = scene?.windows.first(where: \.isKeyWindow) ?? scene?.windows.first,
              var top = window.rootViewController else { return nil }
        while let presented = top.presentedViewController {
            top = presented
        }
        return top
    }

    private final class SafariDelegate: NSObject, SFSafariViewControllerDelegate {
        let onDismiss: () -> Void
        init(onDismiss: @escaping () -> Void) { self.onDismiss = onDismiss }
        func safariViewControllerDidFinish(_ controller: SFSafariViewController) {
            onDismiss()
        }
    }
}

// MARK: - Unified confirm-booking form (date + party size inline)

/// Shown after the user closes Safari. Pre-fills the restaurant name and
/// asks for date + party size; tapping Save persists locally, pushes to the
/// backend, and transitions `ReservationViewModel.state` to `.success`.
struct ConfirmBookingForm: View {
    @ObservedObject var viewModel: ReservationViewModel
    var onDismiss: () -> Void

    @State private var date: Date = ConfirmBookingForm.defaultDate()
    @State private var partySize: Int = UserProfile.load().defaultPartySize
    @State private var isSaving: Bool = false

    /// Default reservation datetime: next Saturday at 7:30 PM.
    private static func defaultDate() -> Date {
        let cal = Calendar.current
        var components = cal.dateComponents([.year, .month, .day, .weekday], from: Date())
        let daysUntilSaturday = (7 - (components.weekday ?? 1) + 7) % 7
        let days = daysUntilSaturday == 0 ? 7 : daysUntilSaturday
        let base = cal.date(byAdding: .day, value: days, to: Date()) ?? Date()
        components = cal.dateComponents([.year, .month, .day], from: base)
        components.hour = 19
        components.minute = 30
        return cal.date(from: components) ?? Date()
    }

    var body: some View {
        Form {
            Section {
                HStack {
                    Image(systemName: "fork.knife")
                        .foregroundColor(.accentColor)
                    Text(viewModel.restaurant.name)
                        .font(.headline)
                    Spacer()
                }
            } header: {
                Text("Restaurant")
            } footer: {
                Text("Set the date, time, and party size for your reservation. We'll save it and remind you the day before.")
            }
            .listRowBackground(Color.homeBgBottom)

            Section("Reservation details") {
                DatePicker(
                    "Date & Time",
                    selection: $date,
                    in: Date()...,
                    displayedComponents: [.date, .hourAndMinute]
                )
                Stepper("Party size: \(partySize)", value: $partySize, in: 1...20)
            }
            .listRowBackground(Color.homeBgBottom)

            Section {
                Button(action: save) {
                    HStack {
                        Spacer()
                        if isSaving {
                            ProgressView().tint(.white)
                        } else {
                            Text("Save booking")
                                .fontWeight(.semibold)
                                .foregroundColor(.white)
                        }
                        Spacer()
                    }
                }
                .listRowBackground(Color.green)
                .disabled(isSaving)

                Button(role: .destructive) {
                    onDismiss()
                } label: {
                    HStack {
                        Spacer()
                        Text("I didn't end up booking")
                        Spacer()
                    }
                }
                .listRowBackground(Color.homeBgBottom)
                .disabled(isSaving)
            }
        }
        .scrollContentBackground(.hidden)
        .background(WarmGradientBackground().ignoresSafeArea())
    }

    private func save() {
        isSaving = true
        Task {
            await viewModel.saveManualBooking(datetime: date, partySize: partySize)
            isSaving = false
        }
    }
}
