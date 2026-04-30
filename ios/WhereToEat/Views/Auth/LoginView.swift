import SwiftUI
import AuthenticationServices

/// Gate shown before Home when the user hasn't signed in with Apple.
/// "Continue as guest" lets the user keep using the app anonymously — in that
/// mode they stay keyed to the Keychain UUID and can upgrade later by signing
/// in, at which point their existing bookings migrate to the verified id.
///
/// Google Sign-In is deprioritised to P2 — UI removed below; the
/// `runGoogleSignIn` / `googleButton` helpers are kept (unreferenced) so
/// re-enabling later is a one-liner.
struct LoginView: View {
    @ObservedObject private var auth = AuthService.shared
    var onContinueAsGuest: () -> Void

    var body: some View {
        VStack(spacing: 24) {
            Spacer()

            VStack(spacing: 12) {
                Image(systemName: "fork.knife.circle.fill")
                    .font(.system(size: 64))
                    .foregroundStyle(Color.accentColor, Color(.systemGray5))
                Text("Welcome to WhereToEat")
                    .font(.largeTitle).fontWeight(.bold)
                    .multilineTextAlignment(.center)
                Text("Sign in so your reservations and favorites follow you across devices.")
                    .font(.subheadline).foregroundColor(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 24)
            }

            Spacer()

            VStack(spacing: 12) {
                SignInWithAppleButton(
                    onRequest: { request in
                        request.requestedScopes = [.fullName, .email]
                    },
                    onCompletion: { _ in
                        // AuthService runs its own ASAuthorizationController
                        // for the actual flow — this button just has to *look*
                        // native. Tap → trigger our service.
                    }
                )
                .signInWithAppleButtonStyle(.black)
                .frame(height: 50)
                .clipShape(RoundedRectangle(cornerRadius: 12))
                .overlay(
                    // Use our own tap gesture so we can reuse AuthService's
                    // wrapped continuation. SignInWithAppleButton exposes only
                    // a synchronous completion handler; we want async.
                    Color.clear.contentShape(Rectangle())
                        .onTapGesture { Task { await auth.signInWithApple() } }
                )

                // googleButton — hidden until Google Sign-In ships (P2).
                // Restore by uncommenting once GIDSignIn is wired up.
                // googleButton

                Button(action: onContinueAsGuest) {
                    Text("Continue as guest")
                        .font(.subheadline)
                        .foregroundColor(.secondary)
                }
                .padding(.top, 4)
            }
            .padding(.horizontal, 24)

            if auth.isSigningIn {
                ProgressView().padding(.top, 4)
            }
            if let err = auth.lastError {
                Text(err)
                    .font(.caption).foregroundColor(.red)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 24)
            }

            Text("We'll only use your account to sync bookings. You can sign out any time in Settings.")
                .font(.caption2).foregroundColor(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)
                .padding(.bottom, 24)
        }
    }

    @MainActor
    private func runGoogleSignIn() async {
        guard let presenter = topViewController() else { return }
        do {
            let (token, name) = try await GoogleSignInIntegration.signIn(presenting: presenter)
            await auth.completeGoogleSignIn(idToken: token, displayName: name)
        } catch {
            auth.lastError = error.localizedDescription
        }
    }

    private func topViewController() -> UIViewController? {
        let scene = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .first(where: { $0.activationState == .foregroundActive })
            ?? UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        guard let window = scene?.windows.first(where: \.isKeyWindow) ?? scene?.windows.first,
              var top = window.rootViewController else { return nil }
        while let presented = top.presentedViewController { top = presented }
        return top
    }

    private var googleButton: some View {
        Button {
            Task { await runGoogleSignIn() }
        } label: {
            HStack(spacing: 10) {
                Image(systemName: "g.circle.fill")
                    .font(.title3)
                Text("Continue with Google")
                    .font(.headline)
            }
            .foregroundColor(.primary)
            .frame(maxWidth: .infinity)
            .frame(height: 50)
            .background(Color(.systemGray6))
            .clipShape(RoundedRectangle(cornerRadius: 12))
        }
    }
}
