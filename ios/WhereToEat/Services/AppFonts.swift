import CoreText
import SwiftUI

/// Runtime-registers Fraunces (variable axis) so SwiftUI can resolve
/// `Font.custom("Fraunces", size:)`. Bundled .ttf files live under
/// `Resources/Fonts/`. Variable axes (wght, opsz, SOFT, WONK) are picked up
/// automatically when callers chain `.weight(...)` / `.italic()`.
///
/// Why register at runtime instead of UIAppFonts: the Xcode project uses
/// build-setting–driven Info.plist generation (no separate Info.plist file),
/// and INFOPLIST_KEY_UIAppFonts isn't a real build setting. Calling
/// `CTFontManagerRegisterFontsForURL` once at launch is the cleanest path.
enum AppFonts {
    private static let fontFiles: [String] = [
        "Fraunces-VF",
        "Fraunces-Italic-VF",
    ]

    static func register() {
        for name in fontFiles {
            guard let url = Bundle.main.url(forResource: name, withExtension: "ttf") else {
                print("[Fonts] Missing \(name).ttf in bundle")
                continue
            }
            var error: Unmanaged<CFError>?
            if !CTFontManagerRegisterFontsForURL(url as CFURL, .process, &error) {
                let cfErr = error?.takeRetainedValue()
                let code = cfErr.map { CFErrorGetCode($0) } ?? -1
                if code != 105 /* already registered */ {
                    print("[Fonts] Failed to register \(name): \(String(describing: cfErr))")
                }
            }
        }
    }
}

extension Font {
    /// Fraunces — warm editorial serif used for headlines, restaurant names,
    /// and other foodie hero text. Body copy stays on the system font.
    static func fraunces(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
        Font.custom("Fraunces", size: size).weight(weight)
    }

    /// Fraunces sized relative to a Dynamic Type style so the headline still
    /// scales with the user's text-size preference.
    static func fraunces(_ style: Font.TextStyle, weight: Font.Weight = .regular) -> Font {
        let size: CGFloat
        switch style {
        case .largeTitle:  size = 34
        case .title:       size = 28
        case .title2:      size = 22
        case .title3:      size = 20
        case .headline:    size = 17
        case .subheadline: size = 15
        case .body:        size = 17
        case .callout:     size = 16
        case .footnote:    size = 13
        case .caption:     size = 12
        case .caption2:    size = 11
        @unknown default:  size = 17
        }
        return Font.custom("Fraunces", size: size, relativeTo: style).weight(weight)
    }
}
