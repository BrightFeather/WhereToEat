import Foundation
import AuthenticationServices
import Combine

/// Sign-in state exposed to the UI.
enum AuthState: Equatable {
    case anonymous                // Keychain UUID only, no provider bound
    case authenticated(userId: String, displayName: String?, provider: String)
}

/// Wraps native Apple Sign-In (and Google Sign-In once SDK is added) and
/// exchanges the resulting identity token with the backend via
/// `POST /api/auth/login`. On success, stores the verified user id back into
/// the Keychain so every future `X-User-Id` header is the real subject id.
@MainActor
final class AuthService: NSObject, ObservableObject {
    static let shared = AuthService()

    @Published private(set) var state: AuthState
    @Published var isSigningIn: Bool = false
    @Published var lastError: String?

    private let api = APIClient.shared
    private var appleContinuation: CheckedContinuation<AppleCredential, Error>?

    private override init() {
        // Recover persisted state from UserDefaults (cheap flag — truth is
        // still the id in Keychain, which APIClient uses on every call).
        let defaults = UserDefaults.standard
        if let uid = defaults.string(forKey: Self.k_userId),
           let provider = defaults.string(forKey: Self.k_provider),
           provider != "anonymous" {
            let name = defaults.string(forKey: Self.k_displayName)
            self.state = .authenticated(userId: uid, displayName: name, provider: provider)
        } else {
            self.state = .anonymous
        }
        super.init()
    }

    // MARK: - Apple

    func signInWithApple() async {
        lastError = nil
        isSigningIn = true
        defer { isSigningIn = false }

        do {
            let credential = try await requestAppleCredential()
            try await exchange(
                provider: "apple",
                idToken: credential.identityToken,
                displayName: credential.fullName
            )
        } catch {
            handle(error)
        }
    }

    // MARK: - Google (stub — SDK integration follows)

    /// Exchanges a Google ID token obtained from the GoogleSignIn SDK. The
    /// UI layer is responsible for presenting GIDSignIn and passing the raw
    /// token here, so this service stays SDK-agnostic and testable.
    func completeGoogleSignIn(idToken: String, displayName: String?) async {
        lastError = nil
        isSigningIn = true
        defer { isSigningIn = false }
        do {
            try await exchange(provider: "google", idToken: idToken, displayName: displayName)
        } catch {
            handle(error)
        }
    }

    // MARK: - Sign out

    func signOut() {
        UserDefaults.standard.removeObject(forKey: Self.k_userId)
        UserDefaults.standard.removeObject(forKey: Self.k_provider)
        UserDefaults.standard.removeObject(forKey: Self.k_displayName)
        UserDefaults.standard.removeObject(forKey: Self.k_email)
        IdentityService.shared.resetAnonymous()
        state = .anonymous
    }

    // MARK: - Exchange

    private struct LoginResponse: Decodable {
        var userId: String
        var displayName: String?
        var email: String?
        var emailVerified: Bool?
        var provider: String
    }

    private func exchange(provider: String, idToken: String, displayName: String?) async throws {
        let defaults = UserDefaults.standard
        let cachedName = defaults.string(forKey: Self.k_displayName)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .nilIfEmpty

        var body: [String: Any] = [
            "provider": provider,
            "idToken": idToken,
            "anonymousUserId": IdentityService.shared.userId
        ]
        // Send the freshly-captured Apple/Google name *or* a previously-cached
        // copy. Apple only returns `fullName` on the very first sign-in for
        // an Apple ID; if the backend's stored row also has display_name=null
        // (e.g. created before name capture shipped), without this nothing
        // would ever land server-side.
        let nameForBackend = displayName?.nilIfEmpty ?? cachedName
        if let nameForBackend { body["displayName"] = nameForBackend }

        let resp = try await api.request(
            Endpoint.authLogin(body: body),
            as: LoginResponse.self
        )

        // Resolve the final name from three fallbacks, in priority order:
        //   1. Backend echo (authoritative — survives device restore)
        //   2. The name we just captured from Apple/Google this session
        //   3. The previously-persisted UserDefaults cache
        // We deliberately never overwrite a non-nil cache with nil — earlier
        // versions of this code did, which silently erased the greeting on
        // every subsequent sign-in.
        let resolvedName: String? =
            resp.displayName?.nilIfEmpty
            ?? displayName?.nilIfEmpty
            ?? cachedName

        // Swap Keychain id so every future X-User-Id header is the verified id.
        IdentityService.shared.overrideUserId(resp.userId)
        defaults.set(resp.userId, forKey: Self.k_userId)
        defaults.set(resp.provider, forKey: Self.k_provider)
        if let email = resp.email?.nilIfEmpty {
            defaults.set(email, forKey: Self.k_email)
        }
        if let resolvedName {
            defaults.set(resolvedName, forKey: Self.k_displayName)
        }
        state = .authenticated(userId: resp.userId, displayName: resolvedName, provider: resp.provider)

        // Pull reservations owned by the freshly-minted identity so the UI
        // reflects anything saved server-side (e.g. from another device).
        Task { await ReservationService.shared.syncFromServer() }
    }

    private func handle(_ error: Error) {
        lastError = error.localizedDescription
    }

    // MARK: - Apple request

    private struct AppleCredential {
        let identityToken: String
        let fullName: String?
    }

    private func requestAppleCredential() async throws -> AppleCredential {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<AppleCredential, Error>) in
            self.appleContinuation = cont
            let provider = ASAuthorizationAppleIDProvider()
            let request = provider.createRequest()
            request.requestedScopes = [.fullName, .email]
            let controller = ASAuthorizationController(authorizationRequests: [request])
            controller.delegate = self
            controller.presentationContextProvider = self
            controller.performRequests()
        }
    }

    // MARK: - Keys

    private static let k_userId      = "auth.userId"
    private static let k_provider    = "auth.provider"
    private static let k_displayName = "auth.displayName"
    private static let k_email       = "auth.email"
}

// MARK: - ASAuthorizationControllerDelegate

extension AuthService: ASAuthorizationControllerDelegate {
    nonisolated func authorizationController(
        controller: ASAuthorizationController,
        didCompleteWithAuthorization authorization: ASAuthorization
    ) {
        guard
            let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
            let tokenData = credential.identityToken,
            let token = String(data: tokenData, encoding: .utf8)
        else {
            Task { @MainActor in
                self.appleContinuation?.resume(throwing: AuthError.missingToken)
                self.appleContinuation = nil
            }
            return
        }
        let full = credential.fullName
        let given = full?.givenName ?? ""
        let family = full?.familyName ?? ""
        let combined = [given, family].filter { !$0.isEmpty }.joined(separator: " ")
        let name: String? = combined.isEmpty ? nil : combined
        // Apple returns `fullName` only on the *first* sign-in for an Apple
        // ID; subsequent sign-ins yield nil. The exchange() resolver handles
        // that fallback chain (Apple credential → backend echo → cached).
        Task { @MainActor in
            self.appleContinuation?.resume(returning: AppleCredential(identityToken: token, fullName: name))
            self.appleContinuation = nil
        }
    }

    nonisolated func authorizationController(
        controller: ASAuthorizationController,
        didCompleteWithError error: Error
    ) {
        Task { @MainActor in
            self.appleContinuation?.resume(throwing: error)
            self.appleContinuation = nil
        }
    }
}

// MARK: - ASAuthorizationControllerPresentationContextProviding

extension AuthService: ASAuthorizationControllerPresentationContextProviding {
    nonisolated func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        // ASAuthorizationController requires a UIWindow to anchor its sheet on.
        // We hop to the main actor only for the read — returning the first
        // foreground-active window is safe.
        MainActor.assumeIsolated {
            let scene = UIApplication.shared.connectedScenes
                .compactMap { $0 as? UIWindowScene }
                .first(where: { $0.activationState == .foregroundActive })
                ?? UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
            return scene?.windows.first(where: \.isKeyWindow)
                ?? scene?.windows.first
                ?? ASPresentationAnchor()
        }
    }
}

// MARK: - Errors

enum AuthError: LocalizedError {
    case missingToken

    var errorDescription: String? {
        switch self {
        case .missingToken: return "Apple did not return an identity token."
        }
    }
}

private extension String {
    /// Returns `nil` for empty strings so optional-chaining + `??` fallbacks
    /// can treat "" the same as absent.
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
