import SwiftUI

struct CustomListView: View {
    @EnvironmentObject var viewModel: CustomListViewModel
    @State private var showAddSheet = false
    @State private var urlInput = ""
    @State private var bookingRestaurant: Restaurant?
    @State private var showUnderDevelopmentAlert = false

    var body: some View {
        Group {
            if viewModel.restaurants.isEmpty {
                emptyState
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                List {
                    ForEach(viewModel.restaurants) { restaurant in
                        NavigationLink(destination: RestaurantDetailView(restaurant: restaurant)) {
                            CustomRestaurantRowView(restaurant: restaurant)
                        }
                        .listRowBackground(Color.homeBgBottom)
                        .swipeActions(edge: .trailing) {
                            if restaurant.reservationSource != nil || restaurant.effectiveBookingUrl != nil {
                                Button {
                                    bookingRestaurant = restaurant
                                } label: {
                                    Label("Book", systemImage: "calendar.badge.plus")
                                }
                                .tint(.accentColor)
                            }
                        }
                        .swipeActions(edge: .leading, allowsFullSwipe: true) {
                            Button(role: .destructive) {
                                if let idx = viewModel.restaurants.firstIndex(where: { $0.id == restaurant.id }) {
                                    viewModel.delete(at: IndexSet(integer: idx))
                                }
                            } label: {
                                Label("Remove", systemImage: "trash")
                            }
                            .tint(.red)
                        }
                    }
                    .onDelete(perform: viewModel.delete)
                }
                .listStyle(.insetGrouped)
                .scrollContentBackground(.hidden)
            }
        }
        // Warm gradient signature — matches the Home tab. Row backgrounds
        // stay `systemBackground` so the list rows still pop against the
        // gradient, same way booking cards pop on Home.
        .background(WarmGradientBackground().ignoresSafeArea())
        .sheet(item: $bookingRestaurant) { restaurant in
            NavigationStack {
                RestaurantDetailView(restaurant: restaurant)
                    .environmentObject(viewModel)
            }
        }
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Button { showAddSheet = true } label: {
                    Image(systemName: "plus")
                }
            }
        }
        .sheet(isPresented: $showAddSheet) {
            AddRestaurantView(viewModel: viewModel)
        }
        .sheet(isPresented: $viewModel.showImportPreview) {
            if let draft = viewModel.importDraft {
                ImportPreviewView(draft: draft, viewModel: viewModel)
            }
        }
        .sheet(isPresented: $viewModel.showXhsImportPreview) {
            XHSImportPreviewView(drafts: viewModel.importDrafts, viewModel: viewModel)
        }
        .onOpenURL { _ in
            // Share-sheet incoming URL — paste-link import is currently
            // disabled (see AddRestaurantView). Surface the same alert so
            // the user knows what happened instead of silently dropping the
            // share. Restore the original auto-import by deleting the line
            // below and uncommenting the Task call.
            showUnderDevelopmentAlert = true

            // Task { await viewModel.importURL(url.absoluteString) }
        }
        .alert("Coming soon", isPresented: $showUnderDevelopmentAlert) {
            Button("Got it", role: .cancel) { }
        } message: {
            Text("Saving restaurants by pasting a link is under development. For now, save spots by tapping the bookmark on any Pick or Find card.")
        }
    }

    private var emptyState: some View {
        VStack(spacing: 20) {
            Text("🍽").font(.system(size: 56))
            Text("no spots yet").font(.title3).fontWeight(.bold)
            Text("paste a link from google maps, yelp, or xiaohongshu to save your fav restaurants")
                .font(.subheadline).foregroundColor(.secondary).multilineTextAlignment(.center)
            Button { showAddSheet = true } label: {
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
        .padding(40)
    }
}

struct CustomRestaurantRowView: View {
    let restaurant: Restaurant

    /// Distinct platforms across `sourceLinks`, in stable display order:
    /// 小红书 first, then editorial sources, then generic web sources. The
    /// underlying array often holds many XHS posts for the same restaurant
    /// — we collapse them so the row shows each platform at most once.
    private var distinctPlatforms: [SourcePlatform] {
        let order: [SourcePlatform] = [.xiaohongshu, .eater, .yelp, .google, .website, .other]
        let present = Set(restaurant.sourceLinks.map(\.platform))
        return order.filter(present.contains)
    }

    var body: some View {
        HStack(spacing: 12) {
            CachedAsyncImage(url: restaurant.primaryPhotoURL) { phase in
                if case .success(let img) = phase {
                    img.resizable().scaledToFill()
                } else {
                    Color(.systemGray5).overlay(Image(systemName: "fork.knife").foregroundColor(.secondary))
                }
            }
            .frame(width: 56, height: 56)
            .clipShape(RoundedRectangle(cornerRadius: 10))

            VStack(alignment: .leading, spacing: 2) {
                Text(restaurant.name).font(.body).fontWeight(.medium)
                if !restaurant.address.isEmpty {
                    Text(restaurant.address).font(.caption).foregroundColor(.secondary).lineLimit(1)
                }
                // One badge per distinct platform — the underlying
                // `sourceLinks` array can carry many XHS posts for the same
                // restaurant; rendering each was wordy and identical-looking.
                HStack(spacing: 8) {
                    ForEach(distinctPlatforms, id: \.rawValue) { platform in
                        HStack(spacing: 3) {
                            Image(systemName: "link").font(.caption2).foregroundColor(.accentColor)
                            Text(platform.displayName).font(.caption2).foregroundColor(.secondary)
                        }
                    }
                }
            }
        }
    }
}
