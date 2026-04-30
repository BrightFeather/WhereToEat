import Foundation
import Combine
import PassKit

final class PaymentService: NSObject, ObservableObject {
    static let shared = PaymentService()

    private let api = APIClient.shared

    struct PaymentIntentResponse: Decodable {
        var clientSecret: String
        var publishableKey: String
    }

    enum PaymentResult {
        case success(paymentMethodId: String)
        case cancelled
        case failed(Error)
    }

    // MARK: - Apple Pay support check

    var canUseApplePay: Bool {
        PKPaymentAuthorizationViewController.canMakePayments(usingNetworks: supportedNetworks)
    }

    private let supportedNetworks: [PKPaymentNetwork] = [.visa, .masterCard, .amex, .discover]

    private let merchantId = "merchant.com.wheretoeat.app" // Set in Xcode Signing & Capabilities

    // MARK: - Apple Pay sheet

    func requestApplePayment(
        amount: Decimal,
        restaurantName: String,
        completion: @escaping (PaymentResult) -> Void
    ) {
        guard canUseApplePay else {
            completion(.failed(PaymentError.applePayUnavailable))
            return
        }

        let request = PKPaymentRequest()
        request.merchantIdentifier = merchantId
        request.supportedNetworks = supportedNetworks
        request.merchantCapabilities = [.capability3DS]
        request.countryCode = "US"
        request.currencyCode = "USD"

        let amountNumber = NSDecimalNumber(decimal: amount)
        request.paymentSummaryItems = [
            PKPaymentSummaryItem(label: "Deposit — \(restaurantName)", amount: amountNumber),
            PKPaymentSummaryItem(label: "WhereToEat", amount: amountNumber)
        ]

        self.applePayCompletion = completion

        guard let vc = PKPaymentAuthorizationViewController(paymentRequest: request) else {
            completion(.failed(PaymentError.applePayUnavailable))
            return
        }
        vc.delegate = self

        // Present from key window's root view controller
        if let rootVC = UIApplication.shared.connectedScenes
            .compactMap({ $0 as? UIWindowScene })
            .flatMap({ $0.windows })
            .first(where: { $0.isKeyWindow })?.rootViewController {
            rootVC.present(vc, animated: true)
        }
    }

    // Stored temporarily during Apple Pay flow
    private var applePayCompletion: ((PaymentResult) -> Void)?
    private var applePayController: PKPaymentAuthorizationViewController?
}

extension PaymentService: PKPaymentAuthorizationViewControllerDelegate {
    nonisolated func paymentAuthorizationViewControllerDidFinish(
        _ controller: PKPaymentAuthorizationViewController
    ) {
        controller.dismiss(animated: true)
        Task { @MainActor in
            self.applePayCompletion?(.cancelled)
            self.applePayCompletion = nil
        }
    }

    nonisolated func paymentAuthorizationViewController(
        _ controller: PKPaymentAuthorizationViewController,
        didAuthorizePayment payment: PKPayment,
        handler completion: @escaping (PKPaymentAuthorizationResult) -> Void
    ) {
        // In a real integration, pass payment.token.paymentData to Stripe
        // to confirm the PaymentIntent server-side, then call completion.
        Task { @MainActor in
            do {
                // payment.token.paymentData is the Stripe-compatible Apple Pay token
                let tokenData = payment.token.paymentData
                let tokenString = tokenData.base64EncodedString()

                // TODO: Send tokenString to Stripe to confirm PaymentIntent
                // For now we simulate success
                self.applePayCompletion?(.success(paymentMethodId: tokenString))
                self.applePayCompletion = nil
                completion(PKPaymentAuthorizationResult(status: .success, errors: nil))
            }
        }
    }
}

enum PaymentError: LocalizedError {
    case applePayUnavailable
    case stripeError(String)

    var errorDescription: String? {
        switch self {
        case .applePayUnavailable: return "Apple Pay is not available on this device"
        case .stripeError(let msg): return "Payment error: \(msg)"
        }
    }
}
