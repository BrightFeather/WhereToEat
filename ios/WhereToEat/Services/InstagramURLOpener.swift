import UIKit

/// Opens an Instagram profile URL, preferring the native Instagram app
/// when it's installed and falling back to Safari otherwise.
///
/// Mirrors `XhsURLOpener`'s strategy: extract the username from a typical
/// `https://www.instagram.com/<username>/` URL, build the
/// `instagram://user?username=<username>` deep link, and rely on
/// `UIApplication.open(_:options:completionHandler:)`'s `success` flag to
/// fall back to the original HTTPS URL when no app handles the scheme.
///
/// We deliberately do NOT call `canOpenURL` — that would require declaring
/// `instagram` in `LSApplicationQueriesSchemes`, which means an `Info.plist`
/// edit. The `open` completion's `false` branch is enough.
enum InstagramURLOpener {
    static func open(_ webURL: URL) {
        guard let username = username(from: webURL),
              let appURL = URL(string: "instagram://user?username=\(username)") else {
            UIApplication.shared.open(webURL)
            return
        }
        UIApplication.shared.open(appURL, options: [:]) { success in
            if !success {
                DispatchQueue.main.async {
                    UIApplication.shared.open(webURL)
                }
            }
        }
    }

    /// `https://(www.|m.)?instagram.com/<username>(/...)?` → `<username>`.
    /// Returns nil when the URL points at a non-profile path (`/p/`, `/reel/`,
    /// `/explore/`, `/accounts/`, etc.) — we open those in Safari since the
    /// `instagram://user` scheme is profile-only.
    private static func username(from url: URL) -> String? {
        guard let host = url.host?.lowercased(),
              host == "instagram.com" || host == "www.instagram.com" || host == "m.instagram.com"
        else { return nil }

        let segments = url.path
            .split(separator: "/", omittingEmptySubsequences: true)
            .map(String.init)
        guard let first = segments.first else { return nil }

        // Reserved IG path roots that aren't usernames.
        let nonProfilePaths: Set<String> = [
            "p", "reel", "reels", "tv", "explore", "accounts",
            "stories", "direct", "developer", "about", "legal",
            "privacy", "terms", "press"
        ]
        if nonProfilePaths.contains(first.lowercased()) { return nil }

        // Usernames are 1-30 chars: letters, digits, '.', '_'.
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._")
        guard !first.isEmpty,
              first.count <= 30,
              first.unicodeScalars.allSatisfy(allowed.contains) else {
            return nil
        }
        return first
    }
}
