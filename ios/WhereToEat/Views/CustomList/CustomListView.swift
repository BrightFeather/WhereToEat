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

    /// Distinct source-type keys for the row, in stable display order:
    /// 小红书 → Eater → Resy → other web sources. We dedupe across both the
    /// modern `xhsSources` array (which carries the multi-source schema with
    /// resolvedType keys like `eater`/`resy_blog`) and the legacy
    /// `sourceLinks` array (used by user-imported / custom restaurants),
    /// so a restaurant that appears in both still renders one badge per
    /// platform instead of two.
    private var distinctTypeKeys: [String] {
        let priority = ["xiaohongshu", "eater", "resy_blog", "yelp", "google", "website", "other"]
        var seen: Set<String> = []

        if let sources = restaurant.xhsSources {
            for s in sources { seen.insert(s.resolvedType) }
        }
        for link in restaurant.sourceLinks {
            seen.insert(link.platform.rawValue)
        }

        var ordered = priority.filter { seen.contains($0) }
        let extras = seen.subtracting(priority).sorted()
        ordered.append(contentsOf: extras)
        return ordered
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

            VStack(alignment: .leading, spacing: 4) {
                Text(restaurant.name).font(.body).fontWeight(.medium)
                if !restaurant.address.isEmpty {
                    Text(restaurant.address).font(.caption).foregroundColor(.secondary).lineLimit(1)
                }
                // One colored capsule per distinct platform — same visual
                // language as the detail page's source quotes (red 小红书,
                // red Eater, red Resy). Replaces the older "link icon +
                // platform name" treatment which read more like metadata
                // than provenance.
                HStack(spacing: 6) {
                    ForEach(distinctTypeKeys, id: \.self) { key in
                        SourceTypeBadgeView(typeKey: key)
                    }
                }
            }
        }
    }
}

/// Colored capsule badge for a source-type key. Mirrors the badge used
/// inside `SourceQuoteCard` on `RestaurantDetailView` so the same
/// platform reads as the same brand wherever it appears.
private struct SourceTypeBadgeView: View {
    let typeKey: String

    var body: some View {
        Text(label)
            .font(.caption2).fontWeight(.semibold)
            .foregroundColor(.white)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(color.opacity(0.9))
            .clipShape(Capsule())
    }

    private var label: String {
        switch typeKey {
        case "xiaohongshu":       return "小红书"
        case "eater":             return "Eater"
        case "resy_blog", "resy": return "Resy"
        case "yelp":              return "Yelp"
        case "google":            return "Google"
        case "website":           return "Web"
        case "other":             return "Other"
        default:                  return typeKey.capitalized
        }
    }

    private var color: Color {
        switch typeKey {
        case "xiaohongshu":       return Color(red: 1, green: 0.14, blue: 0.26)
        case "eater":             return Color(red: 0.91, green: 0.20, blue: 0.11)
        case "resy_blog", "resy": return Color(red: 0.83, green: 0.14, blue: 0.14)
        case "yelp":              return Color(red: 0.83, green: 0.14, blue: 0.14)
        case "google":            return Color(red: 0.20, green: 0.40, blue: 0.95)
        default:                  return .gray
        }
    }
}
