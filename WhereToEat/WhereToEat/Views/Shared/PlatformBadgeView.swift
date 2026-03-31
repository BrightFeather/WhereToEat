import SwiftUI

struct PlatformBadgeView: View {
    let platform: ReservationPlatform

    var body: some View {
        Text(platform.displayName)
            .font(.caption2)
            .fontWeight(.semibold)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(color.opacity(0.12))
            .foregroundColor(color)
            .clipShape(Capsule())
    }

    private var color: Color {
        switch platform {
        case .resy: return Color(hex: "#E63946") ?? .red
        case .opentable: return Color(hex: "#DA3743") ?? .red
        case .tock: return .primary
        case .other: return .secondary
        }
    }
}

extension Color {
    init?(hex: String) {
        var hex = hex.trimmingCharacters(in: .whitespacesAndNewlines)
        if hex.hasPrefix("#") { hex = String(hex.dropFirst()) }
        guard hex.count == 6, let value = UInt64(hex, radix: 16) else { return nil }
        self.init(
            red: Double((value >> 16) & 0xFF) / 255,
            green: Double((value >> 8) & 0xFF) / 255,
            blue: Double(value & 0xFF) / 255
        )
    }
}
