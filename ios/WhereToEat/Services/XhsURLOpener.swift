import UIKit

/// Opens an XHS post URL, preferring the native Xiaohongshu / Rednote app
/// when it's installed and falling back to Safari otherwise.
///
/// Implementation:
/// - `UIApplication.open(appURL)` attempts the `xhsdiscover://item/<noteId>`
///   deep link. If no app on the device handles that scheme, the completion
///   handler receives `success == false` and we open the HTTPS URL instead.
/// - This path intentionally does NOT call `canOpenURL`, which would require
///   declaring `xhsdiscover` in `LSApplicationQueriesSchemes`. The
///   `open(_:completionHandler:)` failure fallback is enough.
enum XhsURLOpener {
    static func open(_ webURL: URL) {
        guard let noteId = noteId(from: webURL),
              let appURL = URL(string: "xhsdiscover://item/\(noteId)") else {
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

    /// `https://www.xiaohongshu.com/explore/<24 hex>` → `<24 hex>`.
    /// Also accepts `/discovery/item/<24 hex>`. Returns nil for `xhslink.com`
    /// short URLs (those already open the app via Universal Links on iOS).
    private static func noteId(from url: URL) -> String? {
        let path = url.path
        let pattern = #"(?:explore|discovery/item)/([a-f0-9]{24})"#
        guard let re = try? NSRegularExpression(pattern: pattern),
              let match = re.firstMatch(in: path, range: NSRange(path.startIndex..., in: path)),
              let group = Range(match.range(at: 1), in: path) else {
            return nil
        }
        return String(path[group])
    }
}
