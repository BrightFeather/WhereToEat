import SwiftUI

struct RestaurantCardView: View {
    let restaurant: Restaurant
    var swipeOffset: CGFloat = 0

    private var rotation: Double { Double(swipeOffset / 20) }
    private var likeOpacity: Double { max(0, Double(swipeOffset / 80)) }
    private var nopeOpacity: Double { max(0, Double(-swipeOffset / 80)) }

    var body: some View {
        ZStack(alignment: .bottom) {
            // Hero image
            AsyncImage(url: restaurant.primaryPhotoURL) { phase in
                switch phase {
                case .success(let img):
                    img.resizable().scaledToFill()
                case .failure, .empty:
                    Color(.systemGray5)
                        .overlay(Image(systemName: "fork.knife").font(.system(size: 60)).foregroundColor(.secondary))
                @unknown default:
                    Color(.systemGray5)
                }
            }
            .clipped()

            // Gradient + info overlay
            VStack(alignment: .leading, spacing: 8) {
                Spacer()
                HStack(alignment: .bottom) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(restaurant.name)
                            .font(.title2).fontWeight(.bold).foregroundColor(.white)

                        HStack(spacing: 6) {
                            if let neighborhood = restaurant.neighborhood {
                                Label(neighborhood, systemImage: "mappin")
                                    .font(.subheadline).foregroundColor(.white.opacity(0.9))
                            }
                            if let price = restaurant.priceRange {
                                Text(String(repeating: "$", count: price))
                                    .font(.subheadline).foregroundColor(.white.opacity(0.9))
                            }
                        }

                        // Cuisine tags
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
                    VStack(alignment: .trailing, spacing: 6) {
                        if let rating = restaurant.rating {
                            HStack(spacing: 2) {
                                Image(systemName: "star.fill").foregroundColor(.yellow).font(.caption)
                                Text(String(format: "%.1f", rating))
                                    .font(.subheadline).fontWeight(.semibold).foregroundColor(.white)
                            }
                        }
                        if let source = restaurant.reservationSource {
                            PlatformBadgeView(platform: source.platform)
                        }
                    }
                }
                .padding()
                .background(LinearGradient(
                    colors: [.clear, .black.opacity(0.75)],
                    startPoint: .top, endPoint: .bottom
                ))
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 20))
        .shadow(radius: 8, y: 4)
        .overlay(swipeIndicatorOverlay)
        .rotationEffect(.degrees(rotation))
        .offset(x: swipeOffset)
        .animation(.interactiveSpring(), value: swipeOffset)
    }

    @ViewBuilder
    private var swipeIndicatorOverlay: some View {
        ZStack {
            // LIKE badge
            Text("LIKE")
                .font(.title).fontWeight(.heavy)
                .foregroundColor(.green)
                .padding(8)
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.green, lineWidth: 3))
                .rotationEffect(.degrees(-15))
                .opacity(likeOpacity)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .padding(24)

            // NOPE badge
            Text("NOPE")
                .font(.title).fontWeight(.heavy)
                .foregroundColor(.red)
                .padding(8)
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.red, lineWidth: 3))
                .rotationEffect(.degrees(15))
                .opacity(nopeOpacity)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
                .padding(24)
        }
    }
}
