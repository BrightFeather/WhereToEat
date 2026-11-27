import Foundation
import UIKit
import GoogleSignIn

/// Thin wrapper around the GoogleSignIn SDK so `AuthService` stays SDK-agnostic.
///
/// Configuration lives in `WhereToEat/WhereToEat/Info.plist` (merged into the
/// generated plist):
///   - `GIDClientID` — the iOS OAuth client id from Google Cloud Console.
///   - `CFBundleURLTypes` — the *reversed* client id as a URL scheme, so
///     Google's OAuth redirect lands back in the app (handled by
///     `.onOpenURL` in `WhereToEatApp`).
/// The backend verifies the token's `aud` against `GOOGLE_IOS_CLIENT_IDS`
/// (Vercel env), which must contain the same client id.
enum GoogleSignInIntegration {
    /// Presents Google's OAuth consent screen and returns the identity token.
    @MainActor
    static func signIn(presenting: UIViewController) async throws -> (idToken: String, displayName: String?) {
        let result = try await GIDSignIn.sharedInstance.signIn(withPresenting: presenting)
        guard let token = result.user.idToken?.tokenString else {
            throw AuthError.missingGoogleToken
        }
        return (token, result.user.profile?.name)
    }

    /// Forwards the OAuth redirect URL to the SDK. Returns `true` if handled.
    @discardableResult
    static func handle(_ url: URL) -> Bool {
        GIDSignIn.sharedInstance.handle(url)
    }

    /// Drops the SDK's cached Google session so the next sign-in shows the
    /// account picker instead of silently reusing the previous account.
    static func signOut() {
        GIDSignIn.sharedInstance.signOut()
    }

    /// True when the user cancelled the Google sheet — not worth an error banner.
    static func isCancellation(_ error: Error) -> Bool {
        let ns = error as NSError
        return ns.domain == kGIDSignInErrorDomain && ns.code == GIDSignInError.canceled.rawValue
    }
}
