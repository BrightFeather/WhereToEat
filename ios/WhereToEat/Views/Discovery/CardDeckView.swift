import SwiftUI

struct CardDeckView: View {
    @ObservedObject var viewModel: DiscoveryViewModel
    @State private var dragOffset: CGFloat = 0
    @State private var isDragging: Bool = false
    @State private var showDetail: Bool = false

    private let swipeThreshold: CGFloat = 120

    var body: some View {
        ZStack {
            if viewModel.isLoading {
                ProgressView("Finding restaurants…")
            } else if viewModel.isDeckEmpty {
                emptyDeckView
            } else {
                // Show up to 3 cards stacked, current on top
                ForEach(Array(visibleCards.enumerated().reversed()), id: \.element.id) { index, restaurant in
                    let isTop = index == 0
                    RestaurantCardView(
                        restaurant: restaurant,
                        swipeOffset: isTop ? dragOffset : 0
                    )
                    .scaleEffect(isTop ? 1.0 : (1.0 - CGFloat(index) * 0.03))
                    .offset(y: isTop ? 0 : CGFloat(index) * 12)
                    .zIndex(Double(visibleCards.count - index))
                    .gesture(isTop ? dragGesture : nil)
                    .onTapGesture { if isTop { showDetail = true } }
                    .contextMenu {
                        if isTop {
                            Button(role: .destructive) { viewModel.block() } label: {
                                Label("Block for 4 weeks", systemImage: "nosign")
                            }
                        }
                    }
                }

                // Action buttons
                VStack {
                    Spacer()
                    actionButtons
                        .padding(.bottom, 32)
                }
            }
        }
        .padding(.horizontal, 20)
        .sheet(isPresented: $showDetail) {
            if let card = viewModel.currentCard {
                RestaurantDetailView(restaurant: card,
                                     onLike: { showDetail = false; viewModel.swipeRight() },
                                     onDislike: { showDetail = false; viewModel.swipeLeft() },
                                     onBlock: { showDetail = false; viewModel.block() })
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
            .onChanged { value in
                isDragging = true
                dragOffset = value.translation.width
            }
            .onEnded { value in
                isDragging = false
                let velocity = value.predictedEndTranslation.width
                let totalOffset = dragOffset + velocity * 0.3
                withAnimation(.spring(response: 0.3, dampingFraction: 0.6)) {
                    if totalOffset > swipeThreshold {
                        dragOffset = 600
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                            dragOffset = 0
                            viewModel.swipeRight()
                        }
                    } else if totalOffset < -swipeThreshold {
                        dragOffset = -600
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                            dragOffset = 0
                            viewModel.swipeLeft()
                        }
                    } else {
                        dragOffset = 0
                    }
                }
            }
    }

    private var actionButtons: some View {
        HStack(spacing: 40) {
            // Dislike
            Button {
                withAnimation(.spring()) {
                    dragOffset = -600
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                        dragOffset = 0
                        viewModel.swipeLeft()
                    }
                }
            } label: {
                Image(systemName: "xmark")
                    .font(.title2).fontWeight(.bold)
                    .foregroundColor(.red)
                    .frame(width: 64, height: 64)
                    .background(Color(.systemBackground))
                    .clipShape(Circle())
                    .shadow(radius: 6)
            }

            // Like
            Button {
                withAnimation(.spring()) {
                    dragOffset = 600
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                        dragOffset = 0
                        viewModel.swipeRight()
                    }
                }
            } label: {
                Image(systemName: "heart.fill")
                    .font(.title2)
                    .foregroundColor(.green)
                    .frame(width: 64, height: 64)
                    .background(Color(.systemBackground))
                    .clipShape(Circle())
                    .shadow(radius: 6)
            }
        }
    }

    private var emptyDeckView: some View {
        VStack(spacing: 20) {
            Image(systemName: "tray").font(.system(size: 60)).foregroundColor(.secondary)
            Text("No more restaurants").font(.title3).fontWeight(.semibold)
            Text("Try expanding your search radius or add restaurants to your custom list.")
                .font(.subheadline).foregroundColor(.secondary).multilineTextAlignment(.center)
            Button("Add a restaurant") {
                // Navigate to custom list add flow
            }
            .buttonStyle(.bordered)
        }
        .padding(40)
    }
}
