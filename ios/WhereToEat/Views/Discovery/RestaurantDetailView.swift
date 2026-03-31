import SwiftUI
import MapKit

struct RestaurantDetailView: View {
    let restaurant: Restaurant
    var onLike: (() -> Void)?
    var onDislike: (() -> Void)?
    var onBlock: (() -> Void)?

    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                // Photo carousel
                PhotoCarouselView(photoURLs: restaurant.photos, height: 300)

                VStack(alignment: .leading, spacing: 16) {
                    // Header
                    HStack(alignment: .top) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(restaurant.name)
                                .font(.title2).fontWeight(.bold)
                            if let neighborhood = restaurant.neighborhood {
                                Text(neighborhood)
                                    .font(.subheadline).foregroundColor(.secondary)
                            }
                        }
                        Spacer()
                        VStack(alignment: .trailing, spacing: 4) {
                            if let rating = restaurant.rating {
                                HStack(spacing: 2) {
                                    Image(systemName: "star.fill").foregroundColor(.yellow)
                                    Text(String(format: "%.1f", rating)).fontWeight(.semibold)
                                    if let count = restaurant.reviewCount {
                                        Text("(\(count))").foregroundColor(.secondary)
                                    }
                                }
                                .font(.subheadline)
                            }
                            if let source = restaurant.reservationSource {
                                PlatformBadgeView(platform: source.platform)
                            }
                        }
                    }

                    // Tags
                    FlowLayout(spacing: 6) {
                        ForEach(restaurant.cuisineTags) { tag in
                            TagChipView(label: tag.displayName)
                        }
                        if let price = restaurant.priceRange {
                            TagChipView(label: String(repeating: "$", count: price))
                        }
                    }

                    Divider()

                    // Address + map
                    VStack(alignment: .leading, spacing: 8) {
                        Label(restaurant.address, systemImage: "mappin.circle.fill")
                            .font(.subheadline)
                        if restaurant.coordinates.latitude != 0 {
                            Map(position: .constant(
                                MapCameraPosition.region(MKCoordinateRegion(
                                    center: restaurant.coordinates.clLocation,
                                    span: MKCoordinateSpan(latitudeDelta: 0.005, longitudeDelta: 0.005)
                                ))
                            )) {
                                Marker(restaurant.name, coordinate: restaurant.coordinates.clLocation)
                            }
                            .frame(height: 140)
                            .clipShape(RoundedRectangle(cornerRadius: 12))
                        }
                    }

                    Divider()

                    // Reviews
                    if !restaurant.reviewSnippets.isEmpty {
                        VStack(alignment: .leading, spacing: 10) {
                            Text("Reviews").font(.headline)
                            ForEach(restaurant.reviewSnippets.prefix(3)) { review in
                                ReviewSnippetView(review: review)
                            }
                        }
                    }

                    // Source links
                    if !restaurant.sourceLinks.isEmpty {
                        Divider()
                        VStack(alignment: .leading, spacing: 8) {
                            Text("Sources").font(.headline)
                            ForEach(restaurant.sourceLinks) { link in
                                Link(destination: link.url) {
                                    HStack {
                                        Image(systemName: "link")
                                        Text(link.platform.displayName)
                                        Spacer()
                                        Image(systemName: "arrow.up.right")
                                    }
                                    .font(.subheadline)
                                    .foregroundColor(.accentColor)
                                }
                            }
                        }
                    }
                }
                .padding()
            }
        }
        .ignoresSafeArea(edges: .top)
        .overlay(alignment: .top) {
            HStack {
                Button { dismiss() } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.title2)
                        .foregroundStyle(.white, .black.opacity(0.4))
                }
                .padding()
                Spacer()
                if let onBlock {
                    Menu {
                        Button(role: .destructive, action: onBlock) {
                            Label("Block for 4 weeks", systemImage: "nosign")
                        }
                    } label: {
                        Image(systemName: "ellipsis.circle.fill")
                            .font(.title2)
                            .foregroundStyle(.white, .black.opacity(0.4))
                    }
                    .padding()
                }
            }
        }
        .safeAreaInset(edge: .bottom) {
            if onLike != nil || onDislike != nil {
                HStack(spacing: 40) {
                    if let onDislike {
                        Button(action: onDislike) {
                            Label("Pass", systemImage: "xmark")
                                .font(.headline)
                                .foregroundColor(.red)
                                .frame(maxWidth: .infinity)
                                .padding()
                                .background(Color(.systemGray6))
                                .clipShape(RoundedRectangle(cornerRadius: 14))
                        }
                    }
                    if let onLike {
                        Button(action: onLike) {
                            Label("Book this", systemImage: "heart.fill")
                                .font(.headline)
                                .foregroundColor(.white)
                                .frame(maxWidth: .infinity)
                                .padding()
                                .background(Color.green)
                                .clipShape(RoundedRectangle(cornerRadius: 14))
                        }
                    }
                }
                .padding()
                .background(.ultraThinMaterial)
            }
        }
    }
}

struct ReviewSnippetView: View {
    let review: Review
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(review.platform.displayName)
                    .font(.caption).fontWeight(.semibold)
                    .foregroundColor(.secondary)
                Spacer()
                if let rating = review.rating {
                    HStack(spacing: 2) {
                        Image(systemName: "star.fill").font(.caption2).foregroundColor(.yellow)
                        Text(String(format: "%.1f", rating)).font(.caption).foregroundColor(.secondary)
                    }
                }
            }
            Text(review.text)
                .font(.subheadline)
                .lineLimit(3)
        }
        .padding(10)
        .background(Color(.systemGray6))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }
}

// Simple flow layout for tags
struct FlowLayout: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxWidth = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, rowHeight: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x + size.width > maxWidth && x > 0 { x = 0; y += rowHeight + spacing; rowHeight = 0 }
            rowHeight = max(rowHeight, size.height)
            x += size.width + spacing
        }
        return CGSize(width: maxWidth, height: y + rowHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, rowHeight: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x + size.width > bounds.maxX && x > bounds.minX { x = bounds.minX; y += rowHeight + spacing; rowHeight = 0 }
            view.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            rowHeight = max(rowHeight, size.height)
            x += size.width + spacing
        }
    }
}
