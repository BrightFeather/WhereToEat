import SwiftUI

struct RestaurantCardView: View {
    let restaurant: Restaurant
    var swipeOffset: CGFloat = 0
    var lookedAt: Bool = false      // "You looked at this" indicator

    private var rotation: Double { Double(swipeOffset / 20) }
    private var likeOpacity: Double { max(0, Double(swipeOffset / 80)) }
    private var nopeOpacity: Double { max(0, Double(-swipeOffset / 80)) }

    @State private var photoIndex: Int = 0

    /// Cross-source accent shown next to the source badge. Mirrors the rule
    /// in `RestaurantDetailView.sourcesHeaderLabel`:
    ///   1. ≥ 2 source types → "Mentioned on 小红书 and Resy" (extends to
    ///      "A, B, and C" for any future source).
    ///   2. Only 小红书, count == 2 → "Mentioned 2 times on 小红书"
    ///   3. Only 小红书, count ≥ 3 → "Mentioned 3+ times on 小红书"
    ///   4. Only one non-XHS type → "Featured in Eater" / "Featured in Resy"
    ///   5. Else nil — single-source single-mention card stays clean.
    private var sourceAccentLabel: String? {
        guard let sources = restaurant.xhsSources, !sources.isEmpty else { return nil }
        let typeCounts = Dictionary(grouping: sources, by: \.resolvedType)
            .mapValues(\.count)
        let presentTypes = Array(typeCounts.keys)

        if presentTypes.count >= 2 {
            let names = presentTypes
                .map(displayLabel(for:))
                .sorted()
            return "Mentioned on \(joinWithAnd(names))"
        }
        if let only = presentTypes.first {
            let count = typeCounts[only] ?? 0
            if only == "xiaohongshu" {
                if count >= 3 { return "Mentioned 3+ times on 小红书" }
                if count == 2 { return "Mentioned 2 times on 小红书" }
                return nil
            }
            return "Featured in \(displayLabel(for: only))"
        }
        return nil
    }

    private func displayLabel(for type: String) -> String {
        switch type {
        case "xiaohongshu": return "小红书"
        case "eater":       return "Eater"
        case "resy_blog":   return "Resy"
        default:            return DiscoverySource(rawValue: type)?.shortName ?? type.capitalized
        }
    }

    private func joinWithAnd(_ items: [String]) -> String {
        switch items.count {
        case 0: return ""
        case 1: return items[0]
        case 2: return "\(items[0]) and \(items[1])"
        default:
            let head = items.dropLast().joined(separator: ", ")
            return "\(head), and \(items.last!)"
        }
    }

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .bottom) {
                // Photo carousel
                let urls = restaurant.photos.isEmpty ? [restaurant.primaryPhotoURL].compactMap { $0 } : restaurant.photos
                if urls.isEmpty {
                    Color(.systemGray5)
                        .overlay(Image(systemName: "fork.knife").font(.system(size: 60)).foregroundColor(.secondary))
                        .frame(width: geo.size.width, height: geo.size.height)
                } else if urls.count == 1 {
                    CachedAsyncImage(url: urls[0]) { phase in
                        switch phase {
                        case .success(let img): img.resizable().scaledToFill()
                        default: Color(.systemGray5)
                        }
                    }
                    .frame(width: geo.size.width, height: geo.size.height)
                    .clipped()
                } else {
                    // Show current photo (no TabView — its swipe gesture conflicts with card swiping)
                    CachedAsyncImage(url: urls[photoIndex % urls.count]) { phase in
                        switch phase {
                        case .success(let img): img.resizable().scaledToFill()
                        default: Color(.systemGray5)
                        }
                    }
                    .frame(width: geo.size.width, height: geo.size.height)
                    .clipped()
                    // Tap left/right halves to navigate photos
                    .overlay {
                        HStack(spacing: 0) {
                            Color.clear
                                .contentShape(Rectangle())
                                .onTapGesture {
                                    withAnimation(.easeInOut(duration: 0.2)) {
                                        photoIndex = max(0, photoIndex - 1)
                                    }
                                }
                            Color.clear
                                .contentShape(Rectangle())
                                .onTapGesture {
                                    withAnimation(.easeInOut(duration: 0.2)) {
                                        photoIndex = min(urls.count - 1, photoIndex + 1)
                                    }
                                }
                        }
                    }

                    // Photo dot indicators (top-right)
                    HStack(spacing: 4) {
                        ForEach(0..<urls.count, id: \.self) { i in
                            Circle()
                                .fill(i == photoIndex ? Color.white : Color.white.opacity(0.45))
                                .frame(width: 5, height: 5)
                        }
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 5)
                    .background(Color.black.opacity(0.3))
                    .clipShape(Capsule())
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
                    .padding(.top, 12)
                    .padding(.trailing, 12)
                }

                // Gradient + info overlay
                VStack(alignment: .leading, spacing: 0) {
                    Spacer()
                    VStack(alignment: .leading, spacing: 8) {
                        // Source badge + "looked at" indicator
                        HStack {
                            SourceBadgeView(origin: restaurant.sourceOrigin)
                            if let accent = sourceAccentLabel {
                                Text(accent)
                                    .font(.caption2).fontWeight(.semibold)
                                    .foregroundColor(.white)
                                    .padding(.horizontal, 8)
                                    .padding(.vertical, 3)
                                    .background(Color.black.opacity(0.35))
                                    .clipShape(Capsule())
                            }
                            if lookedAt {
                                Text("seen 👀")
                                    .font(.caption2).fontWeight(.medium)
                                    .foregroundColor(.white.opacity(0.8))
                                    .padding(.horizontal, 8)
                                    .padding(.vertical, 3)
                                    .background(Color.white.opacity(0.2))
                                    .clipShape(Capsule())
                            }
                            Spacer()
                        }

                        HStack(alignment: .bottom) {
                            VStack(alignment: .leading, spacing: 4) {
                                HStack(alignment: .firstTextBaseline, spacing: 8) {
                                    Text(restaurant.name)
                                        .font(.title2)
                                        .fontWeight(.medium)
                                        .foregroundColor(.white)
                                        .lineLimit(2)
                                    if UserProfile.load().showRatings, let rating = restaurant.rating {
                                        HStack(spacing: 3) {
                                            Image(systemName: "star.fill")
                                                .font(.caption)
                                                .foregroundColor(.yellow)
                                            Text(String(format: "%.1f", rating))
                                                .font(.subheadline).fontWeight(.semibold)
                                                .foregroundColor(.white)
                                            if let count = restaurant.reviewCount, count > 0 {
                                                Text("(\(formatRatingCount(count)))")
                                                    .font(.caption)
                                                    .foregroundColor(.white.opacity(0.8))
                                            }
                                            if let price = restaurant.priceRange {
                                                Text("·")
                                                    .font(.subheadline)
                                                    .foregroundColor(.white.opacity(0.7))
                                                Text(String(repeating: "$", count: price))
                                                    .font(.subheadline).fontWeight(.light)
                                                    .fontWidth(.condensed)
                                                    .tracking(-0.5)
                                                    .foregroundColor(.white)
                                            }
                                        }
                                    }
                                }

                                HStack(spacing: 6) {
                                    if let neighborhood = restaurant.neighborhood {
                                        Label(neighborhood, systemImage: "mappin")
                                            .font(.subheadline).foregroundColor(.white.opacity(0.9))
                                    }
                                }

                                if let rec = restaurant.xhsRecommendation {
                                    let xhsURL = restaurant.sourceLinks.first(where: { $0.platform == .xiaohongshu })?.url
                                    Button {
                                        if let xhsURL { XhsURLOpener.open(xhsURL) }
                                    } label: {
                                        Text("\u{201C}\(rec)\u{201D}")
                                            .font(.caption)
                                            .italic()
                                            .foregroundColor(.white.opacity(0.85))
                                            .lineLimit(2)
                                            .multilineTextAlignment(.leading)
                                    }
                                    .buttonStyle(.plain)
                                    .disabled(xhsURL == nil)
                                }

                                if !restaurant.cuisineTags.isEmpty {
                                    ScrollView(.horizontal, showsIndicators: false) {
                                        HStack(spacing: 6) {
                                            ForEach(restaurant.cuisineTags) { tag in
                                                TagChipView(label: tag.displayName, isSelected: true, color: .white)
                                            }
                                        }
                                    }
                                }
                            }
                            Spacer()
                        }
                    }
                    .padding()
                    .background(LinearGradient(
                        colors: [.clear, .black.opacity(0.8)],
                        startPoint: .top, endPoint: .bottom
                    ))
                }
                .frame(width: geo.size.width)
            }
            .clipShape(RoundedRectangle(cornerRadius: 20))
            .shadow(radius: 8, y: 4)
            .overlay(swipeIndicatorOverlay)
            .rotationEffect(.degrees(rotation))
            .animation(.interactiveSpring(), value: swipeOffset)
        }
    }

    @ViewBuilder
    private var swipeIndicatorOverlay: some View {
        ZStack {
            // Like — top-left
            Text("🔥")
                .font(.system(size: 52))
                .padding(12)
                .background(.ultraThinMaterial)
                .clipShape(Circle())
                .rotationEffect(.degrees(-12))
                .opacity(likeOpacity)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .padding(28)

            // Nope — top-right
            Text("👎")
                .font(.system(size: 52))
                .padding(12)
                .background(.ultraThinMaterial)
                .clipShape(Circle())
                .rotationEffect(.degrees(12))
                .opacity(nopeOpacity)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
                .padding(28)
        }
    }
}

struct SourceBadgeView: View {
    let origin: SourceOrigin

    var body: some View {
        Text(origin.displayName)
            .font(.caption).fontWeight(.semibold)
            .foregroundColor(.white)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(badgeColor.opacity(0.85))
            .clipShape(Capsule())
    }

    private var badgeColor: Color {
        switch origin {
        case .xhs: return Color(red: 1, green: 0.14, blue: 0.26)
        case .yelp: return Color(red: 0.83, green: 0.14, blue: 0.14)
        case .eater: return Color(red: 0.91, green: 0.20, blue: 0.11)
        case .custom: return Color(red: 0.20, green: 0.78, blue: 0.35)
        }
    }
}
