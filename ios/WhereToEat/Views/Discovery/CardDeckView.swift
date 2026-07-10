import SwiftUI

struct CardDeckView: View {
    @ObservedObject var viewModel: DiscoveryViewModel
    @GestureState private var dragTranslation: CGFloat = 0
    @State private var swipeOffset: CGFloat = 0
    @State private var showDetail: Bool = false
    @State private var showSavedToast: Bool = false
    @State private var bookmarkScale: CGFloat = 1.0
    @State private var lookedAtIds: Set<UUID> = []

    private let swipeThreshold: CGFloat = 120

    var body: some View {
        GeometryReader { geo in
            VStack(spacing: 0) {
                if viewModel.isLoading {
                    Spacer()
                    VStack(spacing: 12) {
                        ProgressView()
                            .scaleEffect(1.2)
                        Text("finding the vibes...")
                            .font(.subheadline).foregroundColor(.secondary)
                    }
                    Spacer()
                } else if viewModel.isDeckEmpty {
                    Spacer()
                    emptyDeckView
                    Spacer()
                } else if !visibleCards.isEmpty {
                    // Designer pass: tighter horizontal margin so the card
                    // breathes more horizontally, and a slightly taller
                    // card-height fraction so the deck dominates the screen
                    // (was a hero with awkward whitespace below; now a hero
                    // that earns its space).
                    let cardW = geo.size.width - 32
                    let cardH = geo.size.height * 0.74

                    ZStack {
                        ForEach(Array(visibleCards.enumerated().reversed()), id: \.element.id) { index, restaurant in
                            let isTop = index == 0
                            RestaurantCardView(
                                restaurant: restaurant,
                                swipeOffset: isTop ? (dragTranslation + swipeOffset) : 0,
                                lookedAt: lookedAtIds.contains(restaurant.id),
                                onOpenDetail: isTop ? {
                                    lookedAtIds.insert(restaurant.id)
                                    showDetail = true
                                } : nil
                            )
                                .frame(width: cardW, height: cardH)
                                .clipped()
                                .offset(x: isTop ? (dragTranslation + swipeOffset) : 0)
                                .scaleEffect(isTop ? 1.0 : (1.0 - CGFloat(index) * 0.03))
                                .offset(y: isTop ? 0 : CGFloat(index) * 12)
                                .zIndex(Double(visibleCards.count - index))
                                .gesture(isTop ? dragGesture : nil)
                                .contextMenu {
                                    if isTop {
                                        if restaurant.isCustom {
                                            Button { viewModel.skipForOneMonth() } label: {
                                                Label("skip for a month", systemImage: "moon.zzz")
                                            }
                                        }
                                        Button(role: .destructive) { viewModel.block() } label: {
                                            Label("nah, block this", systemImage: "hand.raised")
                                        }
                                    }
                                }
                        }
                    }
                    .frame(width: cardW, height: cardH)

                    Spacer()

                    // Toast
                    if showSavedToast {
                        HStack(spacing: 6) {
                            Text("saved")
                                .font(.subheadline).fontWeight(.semibold)
                        }
                        .foregroundColor(.white)
                        .padding(.horizontal, 20)
                        .padding(.vertical, 10)
                        .background(
                            LinearGradient(
                                colors: [Color.accentColor, Color(red: 0.45, green: 0.30, blue: 1.0)],
                                startPoint: .leading, endPoint: .trailing
                            )
                        )
                        .clipShape(Capsule())
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                    }

                    actionButtons

                    Spacer()
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .sheet(isPresented: $showDetail) {
            if let card = viewModel.currentCard {
                RestaurantDetailView(
                    restaurant: card,
                    onLike: {
                        showDetail = false
                        lookedAtIds.insert(card.id)
                        viewModel.swipeRight()
                    },
                    onDislike: { showDetail = false; viewModel.swipeLeft() },
                    onBlock: { showDetail = false; viewModel.block() }
                )
            }
        }
        .task { await viewModel.loadCards() }
    }

    private var visibleCards: [Restaurant] {
        let start = viewModel.currentIndex
        let end = min(start + 3, viewModel.cards.count)
        guard start < viewModel.cards.count else { return [] }
        return Array(viewModel.cards[start..<end])
    }

    private var dragGesture: some Gesture {
        DragGesture()
            .updating($dragTranslation) { value, state, _ in
                state = value.translation.width
            }
            .onEnded { value in
                let velocity = value.predictedEndTranslation.width
                let totalOffset = value.translation.width + velocity * 0.3
                if totalOffset > swipeThreshold {
                    withAnimation(.spring(response: 0.3, dampingFraction: 0.6)) {
                        swipeOffset = 600
                    }
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                        swipeOffset = 0
                        viewModel.swipeRight()
                    }
                } else if totalOffset < -swipeThreshold {
                    withAnimation(.spring(response: 0.3, dampingFraction: 0.6)) {
                        swipeOffset = -600
                    }
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                        swipeOffset = 0
                        viewModel.swipeLeft()
                    }
                }
            }
    }

    private var actionButtons: some View {
        // Layered layout:
        //   - Rewind floats far-left, Reset floats far-right — they're
        //     utility actions that shouldn't break the like/dislike rhythm.
        //   - Pass / Like / Save sit in a centered HStack, equidistant from
        //     the midline. Like is the visual focal point; pass and save
        //     mirror each other across it.
        ZStack {
            HStack {
                rewindButton
                Spacer()
                resetButton
            }
            .padding(.horizontal, 24)

            HStack(spacing: 14) {
                passButton
                likeButton
                saveButton
            }
        }
        .frame(maxWidth: .infinity)
    }

    /// Caption font + color used for every action-bar label so the row
    /// reads as one set of buttons.
    private var actionLabelStyle: (font: Font, color: Color) {
        (.caption2, .secondary)
    }

    /// Press feedback for the action-bar circles. While the user has their
    /// finger down on a button we scale it up and draw an accent ring; on
    /// release everything snaps back. Replaces SwiftUI's default Button
    /// highlight (which was rendering an always-on blue rim on the Like
    /// circle on iOS 17 because `.tint(.accentColor)` propagates from the
    /// TabView root).
    private struct PressFeedbackButtonStyle: ButtonStyle {
        func makeBody(configuration: Configuration) -> some View {
            configuration.label
                .scaleEffect(configuration.isPressed ? 1.12 : 1.0)
                .overlay(
                    Circle()
                        .stroke(Color.accentColor.opacity(configuration.isPressed ? 0.7 : 0),
                                lineWidth: 3)
                )
                .animation(.spring(response: 0.25, dampingFraction: 0.6),
                           value: configuration.isPressed)
        }
    }

    private var resetButton: some View {
        // Reset — clears today's seen set + this week's dislikes/skips/blocks
        // so previously filtered-out restaurants come back into the deck.
        // Server-side blocks (4-week) and reservations are NOT touched.
        // Sized 42pt — smaller than the primary trio (60pt) so the visual
        // hierarchy reads as "primary actions, secondary utility".
        VStack(spacing: 4) {
            Button {
                withAnimation(.spring(response: 0.35, dampingFraction: 0.75)) {
                    viewModel.resetSeenAndDisliked()
                    lookedAtIds.removeAll()
                }
            } label: {
                Image(systemName: "arrow.clockwise")
                    .font(.subheadline).fontWeight(.semibold)
                    .foregroundColor(Color(red: 0.20, green: 0.55, blue: 0.95).opacity(0.85))
                    .frame(width: 42, height: 42)
                    .background(Color(.systemBackground))
                    .clipShape(Circle())
                    .overlay(
                        Circle()
                            .strokeBorder(Color(red: 0.20, green: 0.55, blue: 0.95).opacity(0.45),
                                          lineWidth: 1)
                    )
            }
            .buttonStyle(PressFeedbackButtonStyle())
            .accessibilityLabel("Reset seen and disliked restaurants")

            Text("reset")
                .font(actionLabelStyle.font)
                .foregroundColor(actionLabelStyle.color)
        }
    }

    private var rewindButton: some View {
        // Rewind — Tinder-style undo of the most recent swipe. Sized 42pt to
        // visually subordinate it to the primary pass/like/save trio (60pt).
        VStack(spacing: 4) {
            Button {
                withAnimation(.spring(response: 0.35, dampingFraction: 0.75)) {
                    viewModel.undoLast()
                }
                if let restored = viewModel.currentCard {
                    lookedAtIds.remove(restored.id)
                }
            } label: {
                Image(systemName: "arrow.uturn.backward")
                    .font(.subheadline).fontWeight(.semibold)
                    .foregroundColor(viewModel.canUndo
                                     ? Color(red: 0.95, green: 0.75, blue: 0.10).opacity(0.85)
                                     : Color.secondary.opacity(0.4))
                    .frame(width: 42, height: 42)
                    .background(Color(.systemBackground))
                    .clipShape(Circle())
                    .overlay(
                        Circle()
                            .strokeBorder(viewModel.canUndo
                                          ? Color(red: 0.95, green: 0.75, blue: 0.10).opacity(0.45)
                                          : Color.secondary.opacity(0.2),
                                          lineWidth: 1)
                    )
            }
            .disabled(!viewModel.canUndo)
            .buttonStyle(PressFeedbackButtonStyle())
            .accessibilityLabel("Undo last swipe")

            Text("undo")
                .font(actionLabelStyle.font)
                .foregroundColor(viewModel.canUndo ? actionLabelStyle.color : Color.secondary.opacity(0.5))
        }
    }

    /// Pass / Like / Save share the same circular base — same diameter,
    /// same systemBackground fill, same shadow. Only the emoji differs so
    /// they read as one row of equal-weight actions. Like used to be larger
    /// with a gradient border; flattening the styling to match pass + save
    /// makes the trio feel like a set.
    private var passButton: some View {
        VStack(spacing: 4) {
            Button {
                withAnimation(.spring()) {
                    swipeOffset = -600
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                        swipeOffset = 0
                        viewModel.swipeLeft()
                    }
                }
            } label: {
                Text("👎")
                    .font(.title2)
                    .frame(width: 60, height: 60)
                    .background(Color(.systemBackground))
                    .clipShape(Circle())
                    .overlay(Circle().strokeBorder(Color.cardBorder, lineWidth: 1))
                    .shadow(color: .black.opacity(0.08), radius: 6, y: 3)
            }
            .buttonStyle(PressFeedbackButtonStyle())
            .accessibilityLabel("Pass")

            Text("pass")
                .font(actionLabelStyle.font)
                .foregroundColor(actionLabelStyle.color)
        }
    }

    private var likeButton: some View {
        VStack(spacing: 4) {
            Button {
                withAnimation(.spring()) {
                    swipeOffset = 600
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                        swipeOffset = 0
                        viewModel.swipeRight()
                    }
                }
            } label: {
                Text("❤️")
                    .font(.title2)
                    .frame(width: 60, height: 60)
                    .background(Color(.systemBackground))
                    .clipShape(Circle())
                    .overlay(Circle().strokeBorder(Color.cardBorder, lineWidth: 1))
                    .shadow(color: .black.opacity(0.08), radius: 6, y: 3)
            }
            .buttonStyle(PressFeedbackButtonStyle())
            .accessibilityLabel("Like")

            Text("like")
                .font(actionLabelStyle.font)
                .foregroundColor(actionLabelStyle.color)
        }
    }

    private var saveButton: some View {
        VStack(spacing: 4) {
            Button {
                viewModel.save()
                withAnimation(.spring(response: 0.3, dampingFraction: 0.4)) {
                    bookmarkScale = 1.4
                }
                withAnimation(.spring(response: 0.3, dampingFraction: 0.5).delay(0.15)) {
                    bookmarkScale = 1.0
                }
                withAnimation(.easeOut(duration: 0.2)) {
                    showSavedToast = true
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.8) {
                    withAnimation(.easeIn(duration: 0.25)) {
                        showSavedToast = false
                    }
                }
            } label: {
                Image(systemName: "bookmark.fill")
                    .font(.title2)
                    .foregroundColor(.yellow)
                    .frame(width: 60, height: 60)
                    .background(Color(.systemBackground))
                    .clipShape(Circle())
                    .overlay(Circle().strokeBorder(Color.cardBorder, lineWidth: 1))
                    .shadow(color: .black.opacity(0.08), radius: 6, y: 3)
                    .scaleEffect(bookmarkScale)
            }
            .buttonStyle(PressFeedbackButtonStyle())
            .accessibilityLabel("Save to My List")

            Text("save")
                .font(actionLabelStyle.font)
                .foregroundColor(actionLabelStyle.color)
        }
    }

    private var emptyDeckView: some View {
        VStack(spacing: 20) {
            if let error = viewModel.errorMessage {
                Text("😵").font(.system(size: 56))
                Text("can't load restaurants").font(.title3).fontWeight(.bold)
                Text(error)
                    .font(.subheadline).foregroundColor(.secondary).multilineTextAlignment(.center)
                Button("try again") {
                    Task { await viewModel.loadCards() }
                }
                .buttonStyle(.bordered)
            } else if viewModel.buildingMessage != nil {
                VStack(spacing: 12) {
                    ProgressView().scaleEffect(1.2)
                    Text("curating your picks...")
                        .font(.subheadline).foregroundColor(.secondary)
                }
            } else {
                Text("🫡").font(.system(size: 56))
                Text("you've seen\neverything!")
                    .font(.title3).fontWeight(.bold)
                    .multilineTextAlignment(.center)
                Text("new picks drop every monday.\nadd your own spots in the meantime!")
                    .font(.subheadline).foregroundColor(.secondary).multilineTextAlignment(.center)
                Button {
                    NotificationCenter.default.post(name: .switchToMyList, object: nil)
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "plus")
                        Text("add a spot")
                    }
                    .font(.subheadline).fontWeight(.semibold)
                    .foregroundColor(.white)
                    .padding(.horizontal, 20)
                    .padding(.vertical, 12)
                    .background(Color.accentColor)
                    .clipShape(Capsule())
                }
            }
        }
        .padding(40)
    }
}
