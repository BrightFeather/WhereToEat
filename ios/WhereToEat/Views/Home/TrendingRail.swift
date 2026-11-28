import SwiftUI

/// One card in Home's "Trending now" rail: photo, name, neighborhood and the
/// heat line of the post that ranked it ("🔥 2.3k · 4d ago").
struct TrendingCard: View {
    let pick: HomeViewModel.TrendingPick

    private var restaurant: WeeklyRestaurant { pick.restaurant }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            CachedAsyncImage(url: HomeViewModel.homePhotoURL(restaurant)) { phase in
                switch phase {
                case .success(let img): img.resizable().scaledToFill()
                default:
                    Color.detailBgTop
                        .overlay(Image(systemName: "fork.knife").foregroundColor(.secondary))
                }
            }
            .frame(width: 160, height: 124)
            .clipped()

            VStack(alignment: .leading, spacing: 3) {
                Text(restaurant.googleDisplayName ?? restaurant.restaurantName)
                    .font(.subheadline).fontWeight(.semibold)
                    .foregroundColor(.primary)
                    .lineLimit(1)
                if let hood = restaurant.neighborhood, !hood.isEmpty {
                    Text(hood)
                        .font(.caption)
                        .foregroundColor(.secondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
                Text("🔥 \(Self.likesLabel(pick.likes)) · \(Self.ageLabel(pick.postDate))")
                    .font(.caption).fontWeight(.semibold)
                    .foregroundColor(Color(red: 0.75, green: 0.38, blue: 0.05))
            }
            .padding(10)
        }
        .frame(width: 160, height: 210, alignment: .top)
        .background(Color.homeBgBottom)
        .clipShape(RoundedRectangle(cornerRadius: 16))
        .shadow(color: .black.opacity(0.06), radius: 8, y: 2)
    }

    /// 842 → "842", 2_310 → "2.3k", 90_300 → "90k".
    static func likesLabel(_ likes: Int) -> String {
        if likes < 1_000 { return "\(likes)" }
        if likes < 10_000 { return String(format: "%.1fk", Double(likes) / 1_000) }
        return "\(likes / 1_000)k"
    }

    static func ageLabel(_ date: Date) -> String {
        let days = max(0, Int(Date().timeIntervalSince(date) / 86_400))
        if days == 0 { return "today" }
        if days < 14 { return "\(days)d ago" }
        return "\(days / 7)w ago"
    }
}
