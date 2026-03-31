import SwiftUI

struct CityOverrideView: View {
    @ObservedObject var viewModel: SettingsViewModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Image(systemName: "magnifyingglass").foregroundColor(.secondary)
                TextField("Search city…", text: $viewModel.citySearchQuery)
                    .autocapitalization(.words)
                    .onChange(of: viewModel.citySearchQuery) { _, query in
                        Task { await viewModel.searchCity(query) }
                    }
                if !viewModel.citySearchQuery.isEmpty {
                    Button { viewModel.citySearchQuery = ""; viewModel.citySearchResults = [] } label: {
                        Image(systemName: "xmark.circle.fill").foregroundColor(.secondary)
                    }
                }
            }
            .padding()
            .background(Color(.systemGray6))
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .padding()

            if viewModel.isSearchingCity {
                ProgressView().padding()
            }

            List(viewModel.citySearchResults, id: \.name) { city in
                Button {
                    viewModel.selectCity(city)
                    dismiss()
                } label: {
                    HStack {
                        Image(systemName: "mappin.circle").foregroundColor(.accentColor)
                        Text(city.name)
                    }
                }
                .foregroundColor(.primary)
            }
        }
        .navigationTitle("Set City")
    }
}
