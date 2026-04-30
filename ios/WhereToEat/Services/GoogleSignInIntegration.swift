import Foundation
import UIKit

/// Thin seam where the real GoogleSignIn SDK will plug in.
///
/// To finish the wiring:
///
///  1. In Google Cloud Console → APIs & Services → Credentials, create an
///     **iOS OAuth client ID** for bundle id `com.wheretoeat.app`. Copy the
///     client id (…`.apps.googleusercontent.com`) *and* the reversed client id.
///
///  2. Add the GoogleSignIn-iOS package via SPM:
///        File → Add Package Dependencies
///        URL: https://github.com/google/GoogleSignIn-iOS
///        Products: GoogleSignIn, GoogleSignInSwift
///
///  3. In the app target's Info tab add a URL Type whose URL Schemes is the
///     reversed client id (e.g. `com.googleusercontent.apps.123456-abc…`).
///
///  4. Set env var `GOOGLE_IOS_CLIENT_IDS=<client-id>` in `backend/.env.local`
///     (comma-separate if you have more than one). This is what the backend
///     checks the identity token's `aud` against.
///
///  5. Replace the `#error` below with the SDK call shown in the comment.
enum GoogleSignInIntegration {
    /// Presents Google's OAuth consent screen and returns the identity token.
    /// Wired by the UI layer to `AuthService.completeGoogleSignIn`.
    static func signIn(presenting: UIViewController) async throws -> (idToken: String, displayName: String?) {
        // === Replace the two lines below with the real call once the SDK is added: ===
        //
        // import GoogleSignIn
        // let result = try await GIDSignIn.sharedInstance.signIn(withPresenting: presenting)
        // guard let token = result.user.idToken?.tokenString else { throw AuthError.missingToken }
        // let name = result.user.profile?.name
        // return (token, name)
        //
        // ==========================================================================
        throw NSError(
            domain: "WhereToEat.GoogleSignIn",
            code: -1,
            userInfo: [NSLocalizedDescriptionKey: "Google Sign-In SDK not yet integrated. See GoogleSignInIntegration.swift for setup steps."]
        )
    }
}
