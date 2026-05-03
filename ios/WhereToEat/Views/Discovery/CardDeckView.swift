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
                    let cardW = geo.size.width - 40
                    let cardH = geo.size.height * 0.70

                    // Card counter
                    HStack(spacing: 4) {
                        Text("\(viewModel.remainingCount)")
                            .fontWeight(.bold)
                        Text(viewModel.remainingCount == 1 ? "spot left" : "spots left")
                    }
                    .font(.caption)
                    .foregroundColor(.secondary)
                    .padding(.top, 8)

                    ZStack {
                        ForEach(Array(visibleCards.enumerated().reversed()), id: \.element.id) { index, restaurant in
                            let isTop = index == 0
                            RestaurantCardView(
                                restaurant: restaurant,
                                swipeOffset: isTop ? (dragTranslation + swipeOffset) : 0,
                                lookedAt: lookedAtIds.contains(restaurant.id)
                            )
                                .frame(width: cardW, height: cardH)
                                .clipped()
                                .offset(x: isTop ? (dragTranslation + swipeOffset) : 0)
                                .scaleEffect(isTop ? 1.0 : (1.0 - CGFloat(index) * 0.03))
                                .offset(y: isTop ? 0 : CGFloat(index) * 12)
                                .zIndex(Double(visibleCards.count - index))
                                .gesture(isTop ? dragGesture : nil)
                                .onTapGesture {
                                    if isTop {
                                        lookedAtIds.insert(restaurant.id)
                                        showDetail = true
                                    }
                                }
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
                            Text("saved! 🔖")
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
                        .padding(.bottom, 16 + 49)
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
        HStack(spacing: 18) {
            Spacer()

            // Rewind — Tinder-style undo of the most recent swipe.
            Button {
                withAnimation(.spring(response: 0.35, dampingFraction: 0.75)) {
                    viewModel.undoLast()
                }
                if let restored = viewModel.currentCard {
                    lookedAtIds.remove(restored.id)
                }
            } label: {
                Image(systemName: "arrow.uturn.backward")
                    .font(.title3).fontWeight(.semibold)
                    .foregroundColor(viewModel.canUndo ? Color(red: 0.95, green: 0.75, blue: 0.10) : Color.secondary.opacity(0.5))
                    .frame(width: 48, height: 48)
                    .background(Color(.systemBackground))
                    .clipShape(Circle())
                    .overlay(
                        Circle()
                            .strokeBorder(viewModel.canUndo
                                          ? Color(red: 0.95, green: 0.75, blue: 0.10).opacity(0.6)
                                          : Color.secondary.opacity(0.25),
                                          lineWidth: 1.5)
                    )
                    .shadow(color: .black.opacity(0.06), radius: 4, y: 2)
            }
            .disabled(!viewModel.canUndo)
            .accessibilityLabel("Undo last swipe")

            // Pass
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
                    .frame(width: 56, height: 56)
                    .background(Color(.systemGray6))
                    .clipShape(Circle())
                    .shadow(color: .black.opacity(0.08), radius: 6, y: 3)
            }

            // Like — bigger, gradient border
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
                    .font(.title)
                    .frame(width: 72, height: 72)
                    .background(
                        Circle()
                            .fill(Color(.systemBackground))
                            .shadow(color: .accentColor.opacity(0.3), radius: 8, y: 2)
                    )
                    .overlay(
                        Circle()
                            .strokeBorder(
                                LinearGradient(
                                    colors: [Color.accentColor, Color(red: 0.45, green: 0.30, blue: 1.0)],
                                    startPoint: .topLeading, endPoint: .bottomTrailing
                                ),
                                lineWidth: 3
                            )
                    )
            }

            // Save
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
                    .frame(width: 56, height: 56)
                    .background(Color(.systemGray6))
                    .clipShape(Circle())
                    .shadow(color: .black.opacity(0.08), radius: 6, y: 3)
                    .scaleEffect(bookmarkScale)
            }
            .accessibilityLabel("Save to My List")
            Spacer()
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
