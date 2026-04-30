import Foundation

/// Extracts a Xiaohongshu post URL from arbitrary user-pasted text.
///
/// XHS share text on iOS looks like one of:
///   `98 【小红书】 我的纽约美食指南 📍 http://xhslink.com/a/AbC123`
///   `52 … https://www.xiaohongshu.com/explore/67ab…cdef0?xsec_token=AB-…&xsec_source=pc_share`
///   `https://www.xiaohongshu.com/discovery/item/67ab…cdef0`
///   `67ab…cdef0`  (bare 24-char note id — what you get from some clipboards)
///
/// `NSDataDetector` handles most raw URLs, but when the paste mixes multiple
/// links or strips the scheme, the detector picks the wrong one. This parser
/// is XHS-aware: it scans for every candidate, ranks them (full XHS URL >
/// short link > bare note id), and returns the best match preserving
/// `xsec_token` which the backend needs to read the note.
enum XHSURLParser {

    /// Return the best XHS URL in the text, or nil if none looks like one.
    static func extract(from text: String) -> URL? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return nil }

        // 1. Full xiaohongshu.com URL (explore or discovery/item).
        if let full = firstMatch(in: trimmed, pattern: fullPostPattern) {
            return URL(string: normalizeScheme(full))
        }

        // 2. xhslink.com short link.
        if let short = firstMatch(in: trimmed, pattern: shortLinkPattern) {
            return URL(string: normalizeScheme(short))
        }

        // 3. Bare 24-hex note id the user might have copied alone.
        if let bare = firstMatch(in: trimmed, pattern: bareNoteIdPattern) {
            return URL(string: "https://www.xiaohongshu.com/explore/\(bare)")
        }

        return nil
    }

    /// True when the URL's host looks like a Xiaohongshu-owned domain.
    static func isXHSHost(_ url: URL) -> Bool {
        let host = url.host?.lowercased() ?? ""
        return host.contains("xiaohongshu.com")
            || host.contains("xhslink.com")
            || host == "xhs.link"
    }

    // MARK: - Patterns

    // Capture full xhs URL up to a whitespace/Chinese-punctuation boundary.
    // Allows query string (xsec_token etc.) and mixed punctuation around it.
    private static let fullPostPattern =
        #"https?://(?:www\.|m\.)?xiaohongshu\.com/(?:explore|discovery/item|user/profile)/[^\s，。、】\]<>"'""'']+"#

    private static let shortLinkPattern =
        #"https?://(?:www\.)?(?:xhslink\.com|xhs\.link)/[A-Za-z0-9/_\-]+"#

    // 24-hex ObjectId-style note id, isolated by word boundaries so we don't
    // match inside an already-captured URL.
    private static let bareNoteIdPattern = #"(?<![A-Za-z0-9])[a-f0-9]{24}(?![A-Za-z0-9])"#

    // MARK: - Helpers

    private static func firstMatch(in text: String, pattern: String) -> String? {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: .caseInsensitive) else {
            return nil
        }
        let range = NSRange(text.startIndex..., in: text)
        guard let match = regex.firstMatch(in: text, range: range),
              let r = Range(match.range, in: text) else {
            return nil
        }
        return String(text[r])
            .trimmingCharacters(in: CharacterSet(charactersIn: ".,;!?）)】]"))
    }

    /// Some pasted links drop the scheme (`xhslink.com/a/abc`). Force https://.
    private static func normalizeScheme(_ url: String) -> String {
        if url.lowercased().hasPrefix("http://") || url.lowercased().hasPrefix("https://") {
            return url
        }
        return "https://\(url)"
    }
}
