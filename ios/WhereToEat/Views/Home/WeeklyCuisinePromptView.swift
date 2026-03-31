import SwiftUI

struct WeeklyCuisinePromptView: View {
    var onConfirm: ([CuisineTag]) -> Void

    @State private var selected: Set<CuisineTag> = []
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 24) {
                Text("What are you feeling this weekend?")
                    .font(.title2).fontWeight(.bold)
                Text("Select one or more cuisines — we'll tailor your picks.")
                    .font(.subheadline).foregroundColor(.secondary)

                FlowLayout(spacing: 10) {
                    ForEach(CuisineTag.allCases) { tag in
                        Button {
                            if selected.contains(tag) { selected.remove(tag) }
                            else { selected.insert(tag) }
                        } label: {
                            HStack(spacing: 4) {
                                Text(tag.emoji)
                                Text(tag.displayName)
                            }
                            .padding(.horizontal, 14)
                            .padding(.vertical, 8)
                            .background(selected.contains(tag) ? Color.accentColor.opacity(0.15) : Color(.systemGray6))
                            .foregroundColor(selected.contains(tag) ? .accentColor : .primary)
                            .clipShape(Capsule())
                            .overlay(Capsule().strokeBorder(selected.contains(tag) ? Color.accentColor.opacity(0.4) : .clear))
                        }
                        .buttonStyle(.plain)
                    }
                }

                Spacer()

                Button {
                    onConfirm(Array(selected))
                    dismiss()
                } label: {
                    Text(selected.isEmpty ? "Show all restaurants" : "Show restaurants")
                        .font(.headline)
                        .foregroundColor(.white)
                        .frame(maxWidth: .infinity)
                        .padding()
                        .background(Color.accentColor)
                        .clipShape(RoundedRectangle(cornerRadius: 14))
                }
            }
            .padding()
            .navigationTitle("This Week's Mood")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
    }
}
