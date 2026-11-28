import SwiftUI

/// Full-screen roll for "I'm feeling lucky": ~1.2 s of photos flipping like a
/// slot machine (light haptic per tick, success haptic on landing), then the
/// result with Book this one / Roll again.
struct LuckyRollView: View {
    @ObservedObject var viewModel: HomeViewModel
    @State var result: HomeViewModel.LuckyResult

    @EnvironmentObject private var customListVM: CustomListViewModel
    @Environment(\.dismiss) private var dismiss

    @State private var shownPhoto: URL?
    @State private var landed = false

    private var restaurant: WeeklyRestaurant { result.restaurant }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 18) {
                    photo
                    if landed { details.transition(.opacity.combined(with: .move(edge: .bottom))) }
                }
                .padding(.horizontal, 20)
                .padding(.top, 8)
                .padding(.bottom, 32)
            }
            .background(WarmGradientBackground().ignoresSafeArea())
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button { dismiss() } label: {
                        Image(systemName: "xmark").foregroundColor(.secondary)
                    }
                }
                ToolbarItem(placement: .principal) {
                    Text(landed ? "Your lucky pick" : "Rolling…")
                        .font(.fraunces(.headline, weight: .semibold))
                }
            }
            .navigationBarTitleDisplayMode(.inline)
        }
        .task(id: result.id) { await shuffle() }
    }

    /// The photo sits in an overlay on a fixed-height frame so a wide
    /// `scaledToFill` image can't push the page wider than the screen.
    private var photo: some View {
        Color.detailBgTop
            .frame(maxWidth: .infinity)
            .frame(height: 320)
            .overlay {
                CachedAsyncImage(url: shownPhoto) { phase in
                    switch phase {
                    case .success(let img): img.resizable().scaledToFill()
                    default:
                        Image(systemName: "fork.knife").font(.largeTitle).foregroundColor(.secondary)
                    }
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: 24))
        .scaleEffect(landed ? 1 : 0.94)
        .animation(.spring(response: 0.35, dampingFraction: 0.6), value: landed)
    }

    private var subtitle: String {
        var parts = [restaurant.cuisineType.map { CuisineTag(rawValue: $0.lowercased())?.displayName ?? $0.capitalized },
                     restaurant.neighborhood].compactMap { $0?.isEmpty == false ? $0 : nil }
        if let d = result.distanceMeters { parts.append(LuckyCard.milesLabel(d)) }
        return parts.joined(separator: " · ")
    }

    private var quote: String? {
        let text = restaurant.sources?.first?.recommendation ?? restaurant.recommendation
        return text?.isEmpty == false ? text : nil
    }

    private var details: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(restaurant.googleDisplayName ?? restaurant.restaurantName)
                .font(.fraunces(.title, weight: .semibold))
            if !subtitle.isEmpty {
                Text(subtitle).font(.subheadline).foregroundColor(.secondary)
            }
            if let rating = restaurant.googleRating, UserProfile.load().showRatings {
                Label(String(format: "%.1f", rating), systemImage: "star.fill")
                    .font(.subheadline).fontWeight(.semibold)
                    .foregroundColor(Color(red: 0.75, green: 0.38, blue: 0.05))
            }
            if let quote {
                Text("“\(quote)”")
                    .font(.fraunces(.body))
                    .italic()
                    .foregroundColor(.primary.opacity(0.8))
                    .lineLimit(4)
            }

            NavigationLink {
                RestaurantDetailView(restaurant: restaurant.toRestaurant())
                    .environmentObject(customListVM)
            } label: {
                Text("Book this one")
                    .font(.headline)
                    .foregroundColor(.white)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
                    .background(Capsule().fill(LuckyCard.orange))
            }
            .buttonStyle(.plain)
            .padding(.top, 6)

            if viewModel.luckyRollsLeft > 0 {
                Button {
                    if let next = viewModel.rollLucky() { result = next }
                } label: {
                    Label("Roll again · \(viewModel.luckyRollsLeft) left", systemImage: "dice")
                        .font(.subheadline).fontWeight(.semibold)
                        .foregroundColor(Color(red: 0.75, green: 0.38, blue: 0.05))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                        .background(Capsule().strokeBorder(LuckyCard.orange.opacity(0.55), lineWidth: 1.5))
                }
                .buttonStyle(.plain)
            } else {
                Text("That's your lucky three for today — swipe the deck for more.")
                    .font(.footnote).foregroundColor(.secondary)
                    .frame(maxWidth: .infinity)
                    .multilineTextAlignment(.center)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Flip through the shuffle photos, slowing down, and land on the winner.
    private func shuffle() async {
        landed = false
        let photos = result.shufflePhotos
        ImageCache.prefetch(photos)
        let tick = UIImpactFeedbackGenerator(style: .light)
        tick.prepare()
        let steps = max(1, photos.count)
        for (i, url) in photos.enumerated() {
            shownPhoto = url
            if i < steps - 1 {
                tick.impactOccurred()
                // 80 ms → ~280 ms: about 1.2 s across 7 photos.
                let delay = 80 + 200 * Double(i) / Double(max(1, steps - 2))
                try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000))
                if Task.isCancelled { return }
            }
        }
        shownPhoto = HomeViewModel.homePhotoURL(restaurant)
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        withAnimation(.easeOut(duration: 0.3)) { landed = true }
    }
}
