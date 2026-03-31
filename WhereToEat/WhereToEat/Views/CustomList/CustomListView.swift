import SwiftUI

struct CustomListView: View {
    @StateObject private var viewModel = CustomListViewModel()
    @State private var showAddSheet = false
    @State private var urlInput = ""

    var body: some View {
        Group {
            if viewModel.restaurants.isEmpty {
                emptyState
            } else {
                List {
                    ForEach(viewModel.restaurants) { restaurant in
                        NavigationLink(destination: RestaurantDetailView(restaurant: restaurant)) {
                            CustomRestaurantRowView(restaurant: restaurant)
                        }
                    }
                    .onDelete(perform: viewModel.delete)
                }
                .listStyle(.insetGrouped)
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
        .onOpenURL { url in
            // Handle share sheet incoming URL
            Task { await viewModel.importURL(url.absoluteString) }
        }
    }

    private var emptyState: some View {
        VStack(spacing: 20) {
            Image(systemName: "list.star").font(.system(size: 60)).foregroundColor(.secondary)
            Text("Your list is empty").font(.title3).fontWeight(.semibold)
            Text("Add restaurants from Google Maps, Yelp, Xiaohongshu, or any website.")
                .font(.subheadline).foregroundColor(.secondary).multilineTextAlignment(.center)
            Button("Add a restaurant") { showAddSheet = true }
                .buttonStyle(.bordered)
        }
        .padding(40)
    }
}

struct CustomRestaurantRowView: View {
    let restaurant: Restaurant

    var body: some View {
        HStack(spacing: 12) {
            AsyncImage(url: restaurant.primaryPhotoURL) { img in
                img.resizable().scaledToFill()
            } placeholder: {
                Color(.systemGray5).overlay(Image(systemName: "fork.knife").foregroundColor(.secondary))
            }
            .frame(width: 56, height: 56)
            .clipShape(RoundedRectangle(cornerRadius: 10))

            VStack(alignment: .leading, spacing: 2) {
                Text(restaurant.name).fontWeight(.semibold)
                if !restaurant.address.isEmpty {
                    Text(restaurant.address).font(.caption).foregroundColor(.secondary).lineLimit(1)
                }
                HStack(spacing: 4) {
                    ForEach(restaurant.sourceLinks.prefix(3)) { link in
                        Image(systemName: "link").font(.caption2).foregroundColor(.accentColor)
                        Text(link.platform.displayName).font(.caption2).foregroundColor(.secondary)
                    }
                }
            }
        }
    }
}
