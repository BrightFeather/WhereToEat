import SwiftUI

struct AddRestaurantView: View {
    @ObservedObject var viewModel: CustomListViewModel
    @State private var urlText = ""
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            VStack(spacing: 24) {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Paste a link").font(.headline)
                    Text("Supports Google Maps, Yelp, Xiaohongshu, or any restaurant website.")
                        .font(.subheadline).foregroundColor(.secondary)

                    HStack {
                        TextField("https://", text: $urlText)
                            .keyboardType(.URL)
                            .autocapitalization(.none)
                            .padding()
                            .background(Color(.systemGray6))
                            .clipShape(RoundedRectangle(cornerRadius: 10))
                        if !urlText.isEmpty {
                            Button { urlText = "" } label: {
                                Image(systemName: "xmark.circle.fill").foregroundColor(.secondary)
                            }
                        }
                    }
                }

                if viewModel.isImporting {
                    ProgressView("Fetching restaurant info…")
                }

                if let error = viewModel.importError {
                    HStack {
                        Image(systemName: "exclamationmark.circle").foregroundColor(.red)
                        Text(error).font(.subheadline).foregroundColor(.red)
                    }
                }

                Button {
                    Task {
                        await viewModel.importURL(urlText)
                        if viewModel.showImportPreview { dismiss() }
                    }
                } label: {
                    Text("Import")
                        .font(.headline).foregroundColor(.white)
                        .frame(maxWidth: .infinity).padding()
                        .background(urlText.isEmpty ? Color.secondary : Color.accentColor)
                        .clipShape(RoundedRectangle(cornerRadius: 14))
                }
                .disabled(urlText.isEmpty || viewModel.isImporting)

                Divider()

                VStack(alignment: .leading, spacing: 8) {
                    Text("Or share from another app").font(.headline)
                    Text("Tap the share button in Google Maps, Yelp, or Xiaohongshu → tap WhereToEat.")
                        .font(.subheadline).foregroundColor(.secondary)
                }

                Spacer()
            }
            .padding()
            .navigationTitle("Add Restaurant")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
    }
}
