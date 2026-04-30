import SwiftUI

struct XHSImportPreviewView: View {
    let drafts: [ImportedRestaurantDraft]
    @ObservedObject var viewModel: CustomListViewModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if drafts.isEmpty {
                    emptyState
                } else {
                    ScrollView {
                        VStack(spacing: 12) {
                            Text("\(drafts.count) restaurant\(drafts.count == 1 ? "" : "s") found")
                                .font(.subheadline).foregroundColor(.secondary)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.horizontal)
                                .padding(.top, 8)

                            ForEach(Array(drafts.enumerated()), id: \.offset) { index, draft in
                                XHSImportCardView(
                                    draft: draft,
                                    isSelected: viewModel.selectedDraftIndices.contains(index),
                                    onToggle: {
                                        if viewModel.selectedDraftIndices.contains(index) {
                                            viewModel.selectedDraftIndices.remove(index)
                                        } else {
                                            viewModel.selectedDraftIndices.insert(index)
                                        }
                                    }
                                )
                            }
                        }
                        .padding(.bottom, 80)
                    }
                }

                if !drafts.isEmpty {
                    addBar
                }
            }
            .navigationTitle("Import from XHS")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button("Cancel") { viewModel.cancelImport(); dismiss() }
                }
            }
        }
    }

    private var emptyState: some View {
        VStack(spacing: 16) {
            Spacer()
            Image(systemName: "magnifyingglass").font(.system(size: 40)).foregroundColor(.secondary)
            Text("No restaurants found").font(.title3).fontWeight(.semibold)
            Text("This post doesn't seem to mention any restaurants.")
                .font(.subheadline).foregroundColor(.secondary).multilineTextAlignment(.center)
            Spacer()
        }
        .padding(40)
    }

    private var addBar: some View {
        VStack(spacing: 0) {
            Divider()
            Button {
                viewModel.confirmXhsImport()
                dismiss()
            } label: {
                let count = viewModel.selectedDraftIndices.count
                Text("Add \(count) restaurant\(count == 1 ? "" : "s")")
                    .font(.headline).foregroundColor(.white)
                    .frame(maxWidth: .infinity).padding()
                    .background(count == 0 ? Color.secondary : Color.accentColor)
                    .clipShape(RoundedRectangle(cornerRadius: 14))
            }
            .disabled(viewModel.selectedDraftIndices.isEmpty)
            .padding()
        }
        .background(.ultraThinMaterial)
    }
}

struct XHSImportCardView: View {
    let draft: ImportedRestaurantDraft
    let isSelected: Bool
    let onToggle: () -> Void

    var body: some View {
        Button(action: onToggle) {
            HStack(spacing: 12) {
                // Photo
                CachedAsyncImage(url: draft.photos.first) { phase in
                    if case .success(let img) = phase {
                        img.resizable().scaledToFill()
                    } else {
                        Color(.systemGray5)
                            .overlay(Image(systemName: "fork.knife").foregroundColor(.secondary))
                    }
                }
                .frame(width: 64, height: 64)
                .clipShape(RoundedRectangle(cornerRadius: 10))

                // Info
                VStack(alignment: .leading, spacing: 4) {
                    Text(draft.name)
                        .font(.body).fontWeight(.semibold)
                        .foregroundColor(.primary)
                        .lineLimit(1)

                    if let address = draft.address, !address.isEmpty {
                        Text(address)
                            .font(.caption).foregroundColor(.secondary)
                            .lineLimit(1)
                    }

                    HStack(spacing: 6) {
                        if !draft.cuisineTags.isEmpty {
                            Text(draft.cuisineTags.map(\.displayName).joined(separator: ", "))
                                .font(.caption2).foregroundColor(.secondary)
                        }
                        if draft.resyBookingUrl != nil {
                            BadgePill(text: "Resy", color: Color(hex: "#DA4F49") ?? .red)
                        }
                        if draft.opentableBookingUrl != nil {
                            BadgePill(text: "OpenTable", color: Color(hex: "#DA3743") ?? .red)
                        }
                    }

                    if let rec = draft.notes, !rec.isEmpty {
                        Text(rec)
                            .font(.caption2).foregroundColor(.secondary)
                            .lineLimit(2)
                            .italic()
                    }
                }

                Spacer()

                // Checkmark
                Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                    .font(.title3)
                    .foregroundColor(isSelected ? .accentColor : .secondary)
            }
            .padding(12)
            .background(Color(.systemBackground))
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .shadow(color: .black.opacity(0.06), radius: 4, y: 2)
        }
        .buttonStyle(.plain)
        .padding(.horizontal)
    }
}

private struct BadgePill: View {
    let text: String
    let color: Color

    var body: some View {
        Text(text)
            .font(.system(size: 9, weight: .semibold))
            .foregroundColor(.white)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(color)
            .clipShape(Capsule())
    }
}
