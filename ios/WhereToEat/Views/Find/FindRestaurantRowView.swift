import SwiftUI

/// One row in the Find tab's bottom-sheet list. Layout mirrors the Resy /
/// OpenTable reference designs: name (title3 bold), cuisine + neighborhood
/// secondary line, italic XHS-excerpt clamp, and a 88×88 photo on the right.
///
/// Tapping the row body selects the restaurant on the map (centers + zooms);
/// tapping the photo opens the full detail sheet. Selection is reflected by
/// a tan card-border tint matching the rest of the design system.
struct FindRestaurantRowView: View {
    let restaurant: WeeklyRestaurant
    let excerpt: String?
    let isSelected: Bool
    /// Tapping anywhere on the row opens the full `RestaurantDetailView`. The
    /// map-center side-effect runs alongside the open via the closure passed
    /// in by `FindView`.
    let onOpen: () -> Void

    var body: some View {
        Button(action: onOpen) {
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(restaurant.googleDisplayName ?? restaurant.restaurantName)
                            .font(.body).fontWeight(.medium)
                            .foregroundColor(.primary)
                            .lineLimit(1)
                        if let rating = restaurant.googleRating {
                            HStack(spacing: 2) {
                                Image(systemName: "star.fill")
                                    .font(.caption)
                                    .foregroundColor(.yellow)
                                Text(String(format: "%.1f", rating))
                                    .font(.subheadline).fontWeight(.semibold)
                                    .foregroundColor(.primary)
                                if let count = restaurant.googleUserRatingCount, count > 0 {
                                    Text("(\(formatRatingCount(count)))")
                                        .font(.caption)
                                        .foregroundColor(.secondary)
                                }
                            }
                        }
                    }

                    Text(metaLine)
                        .font(.subheadline)
                        .foregroundColor(.secondary)
                        .lineLimit(1)

                    if let excerpt {
                        Text("\u{201C}\(excerpt)\u{201D}")
                            .font(.subheadline)
                            .italic()
                            .foregroundColor(.secondary)
                            .lineLimit(2)
                            .padding(.top, 2)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                photoView
            }
            .contentShape(Rectangle())
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .background(
                RoundedRectangle(cornerRadius: 0)
                    .fill(isSelected ? Color.cardBorder.opacity(0.18) : Color.clear)
            )
        }
        .buttonStyle(.plain)
    }

    /// "1.2k" / "12k" abbreviations for rating counts. Mirror of the helper
    /// in `RestaurantDetailView` — kept private here so the row file stays
    /// self-contained.
    private func formatRatingCount(_ n: Int) -> String {
        if n >= 1_000_000 { return String(format: "%.1fM", Double(n) / 1_000_000) }
        if n >= 1_000     { return String(format: "%.1fk", Double(n) / 1_000) }
        return String(n)
    }

    /// "Cuisine · Neighborhood" with em-dash fallback when one is missing.
    private var metaLine: String {
        let cuisine: String? = {
            guard let raw = restaurant.cuisineType?.lowercased(),
                  let tag = CuisineTag(rawValue: raw) else { return nil }
            return tag.displayName
        }()
        let hood = restaurant.neighborhood ?? restaurant.borough
        let parts = [cuisine, hood].compactMap { $0?.isEmpty == false ? $0 : nil }
        return parts.joined(separator: " · ")
    }

    @ViewBuilder
    private var photoView: some View {
        let url: URL? = {
            if let urls = restaurant.photoUrls, let first = urls.first {
                return URL(string: first)
            }
            return restaurant.photoUrl.flatMap { URL(string: $0) }
        }()
        CachedAsyncImage(url: url) { phase in
            switch phase {
            case .success(let img): img.resizable().scaledToFill()
            default: Color(.systemGray5)
                .overlay(
                    Image(systemName: "fork.knife")
                        .foregroundColor(.secondary)
                )
            }
        }
        .frame(width: 88, height: 88)
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .stroke(Color.cardBorder, lineWidth: 1)
        )
    }
}
