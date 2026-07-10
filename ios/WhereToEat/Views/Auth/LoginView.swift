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
        ZStack {
            WarmGradientBackground().ignoresSafeArea()

            VStack(spacing: 0) {
                Spacer(minLength: 24)

                hero

                Spacer(minLength: 24)

                valueProps
                    .padding(.horizontal, 28)

                Spacer(minLength: 28)

                authButtons
                    .padding(.horizontal, 24)

                if auth.isSigningIn {
                    ProgressView().padding(.top, 8)
                }
                if let err = auth.lastError {
                    Text(err)
                        .font(.caption).foregroundColor(.red)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal, 24)
                        .padding(.top, 6)
                }

                Text("We'll only use your account to sync bookings. You can sign out any time in Settings.")
                    .font(.caption2).foregroundColor(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 32)
                    .padding(.top, 14)
                    .padding(.bottom, 24)
            }
        }
    }

    // Hero — gradient orb with the fork.knife glyph + two floating accent
    // pills (NYC purple, weekly blue), then the brand wordmark in Fraunces so
    // the login page shares typographic DNA with Home / Find / Detail.
    private var hero: some View {
        VStack(spacing: 22) {
            orb
            VStack(spacing: 8) {
                Text("WhereToEat")
                    .font(.custom("Fraunces", size: 38))
                    .fontWeight(.semibold)
                    .foregroundColor(.primary)
                Text("Your weekly NYC dining radar — curated, bookable, yours.")
                    .font(.subheadline).foregroundColor(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 32)
            }
        }
    }

    private var orb: some View {
        ZStack {
            // Outer soft halo
            Circle()
                .fill(
                    RadialGradient(
                        colors: [
                            Color(red: 0.98, green: 0.48, blue: 0.10).opacity(0.22),
                            Color.clear
                        ],
                        center: .center, startRadius: 10, endRadius: 120
                    )
                )
                .frame(width: 220, height: 220)
                .blur(radius: 4)

            // Main orb — orange → purple sunset, mirroring the accent system
            // used by Pick chips and borough pills.
            Circle()
                .fill(
                    LinearGradient(
                        colors: [
                            Color(red: 1.0, green: 0.62, blue: 0.20),
                            Color(red: 0.98, green: 0.42, blue: 0.10),
                            Color(red: 0.55, green: 0.28, blue: 0.95)
                        ],
                        startPoint: .topLeading, endPoint: .bottomTrailing
                    )
                )
                .frame(width: 124, height: 124)
                .overlay(
                    Circle().strokeBorder(Color.white.opacity(0.35), lineWidth: 1.5)
                )
                .shadow(color: Color(red: 0.98, green: 0.42, blue: 0.10).opacity(0.35),
                        radius: 22, y: 12)

            Image(systemName: "fork.knife")
                .font(.system(size: 48, weight: .semibold))
                .foregroundColor(.white)

            // Floating "NYC" pill — top-right of orb
            Text("🗽 NYC")
                .font(.caption).fontWeight(.bold)
                .foregroundColor(.white)
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
                .background(Capsule().fill(Color(red: 0.45, green: 0.20, blue: 0.95)))
                .overlay(Capsule().strokeBorder(Color.white.opacity(0.5), lineWidth: 1))
                .shadow(color: .black.opacity(0.15), radius: 6, y: 3)
                .offset(x: 70, y: -54)

            // Floating "weekly" badge — bottom-left
            HStack(spacing: 4) {
                Image(systemName: "sparkles")
                    .font(.caption2).fontWeight(.bold)
                Text("weekly")
                    .font(.caption2).fontWeight(.bold)
            }
            .foregroundColor(.white)
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(Capsule().fill(Color(red: 0.20, green: 0.55, blue: 0.95)))
            .overlay(Capsule().strokeBorder(Color.white.opacity(0.5), lineWidth: 1))
            .shadow(color: .black.opacity(0.15), radius: 6, y: 3)
            .offset(x: -70, y: 56)
        }
        .frame(width: 220, height: 220)
    }

    private var valueProps: some View {
        VStack(spacing: 14) {
            valuePropRow(
                icon: "flame.fill",
                tint: Color(red: 0.98, green: 0.48, blue: 0.10),
                title: "Curated weekly",
                subtitle: "Fresh picks from 小红书 every Monday."
            )
            valuePropRow(
                icon: "calendar.badge.checkmark",
                tint: Color(red: 0.20, green: 0.55, blue: 0.95),
                title: "One-tap booking",
                subtitle: "Resy and OpenTable, no copy-paste."
            )
            valuePropRow(
                icon: "icloud.fill",
                tint: Color(red: 0.45, green: 0.20, blue: 0.95),
                title: "Synced across devices",
                subtitle: "Your bookings and saves follow you."
            )
        }
    }

    private func valuePropRow(icon: String, tint: Color, title: String, subtitle: String) -> some View {
        HStack(spacing: 14) {
            ZStack {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(tint.opacity(0.15))
                    .frame(width: 40, height: 40)
                Image(systemName: icon)
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundColor(tint)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.subheadline).fontWeight(.semibold)
                    .foregroundColor(.primary)
                Text(subtitle)
                    .font(.caption).foregroundColor(.secondary)
            }
            Spacer(minLength: 0)
        }
    }

    private var authButtons: some View {
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
            .frame(height: 52)
            .clipShape(RoundedRectangle(cornerRadius: 14))
            .shadow(color: .black.opacity(0.18), radius: 10, y: 5)
            .overlay(
                Color.clear.contentShape(Rectangle())
                    .onTapGesture { Task { await auth.signInWithApple() } }
            )

            // googleButton — hidden until Google Sign-In ships (P2).
            // Restore by uncommenting once GIDSignIn is wired up.
            // googleButton

            Button(action: onContinueAsGuest) {
                Text("Continue as guest")
                    .font(.subheadline).fontWeight(.medium)
                    .foregroundColor(.primary.opacity(0.75))
                    .padding(.horizontal, 20)
                    .padding(.vertical, 10)
                    .background(
                        Capsule().fill(Color.white.opacity(0.6))
                    )
                    .overlay(
                        Capsule().strokeBorder(Color.primary.opacity(0.12), lineWidth: 1)
                    )
            }
            .padding(.top, 2)
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
