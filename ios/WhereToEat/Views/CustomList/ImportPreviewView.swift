import SwiftUI

struct ImportPreviewView: View {
    let draft: ImportedRestaurantDraft
    @ObservedObject var viewModel: CustomListViewModel

    @State private var editedName: String
    @State private var editedAddress: String
    @State private var notes: String
    @State private var selectedCuisines: Set<CuisineTag>

    @Environment(\.dismiss) private var dismiss

    init(draft: ImportedRestaurantDraft, viewModel: CustomListViewModel) {
        self.draft = draft
        self.viewModel = viewModel
        _editedName = State(initialValue: draft.name)
        _editedAddress = State(initialValue: draft.address ?? "")
        _notes = State(initialValue: draft.notes ?? "")
        _selectedCuisines = State(initialValue: Set(draft.cuisineTags))
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Restaurant Info") {
                    if let url = draft.photos.first {
                        AsyncImage(url: url) { img in img.resizable().scaledToFill() }
                        placeholder: { Color(.systemGray5) }
                        .frame(height: 160).clipShape(RoundedRectangle(cornerRadius: 10))
                        .listRowInsets(EdgeInsets())
                    }
                    LabeledContent("Name") {
                        TextField("Restaurant name", text: $editedName)
                            .multilineTextAlignment(.trailing)
                    }
                    LabeledContent("Address") {
                        TextField("Address", text: $editedAddress)
                            .multilineTextAlignment(.trailing)
                    }
                }

                Section("Cuisine") {
                    FlowLayout(spacing: 8) {
                        ForEach(CuisineTag.allCases) { tag in
                            Button {
                                if selectedCuisines.contains(tag) { selectedCuisines.remove(tag) }
                                else { selectedCuisines.insert(tag) }
                            } label: {
                                TagChipView(label: "\(tag.emoji) \(tag.displayName)",
                                            isSelected: selectedCuisines.contains(tag))
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.vertical, 4)
                }

                Section("Source") {
                    HStack {
                        Text(draft.sourceLink.platform.displayName)
                        Spacer()
                        Link("Open", destination: draft.sourceLink.url)
                            .font(.caption)
                    }
                }

                Section("Notes") {
                    TextEditor(text: $notes)
                        .frame(minHeight: 80)
                }
            }
            .navigationTitle("Confirm Restaurant")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button("Cancel") { viewModel.cancelImport(); dismiss() }
                }
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button("Save") {
                        var updatedDraft = draft
                        // Pass selected cuisines back
                        viewModel.confirmImport(
                            draft: updatedDraft,
                            editedName: editedName,
                            editedAddress: editedAddress,
                            notes: notes
                        )
                        dismiss()
                    }
                    .fontWeight(.semibold)
                    .disabled(editedName.isEmpty)
                }
            }
        }
    }
}
