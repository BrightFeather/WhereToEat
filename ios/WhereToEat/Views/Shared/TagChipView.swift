import SwiftUI

struct TagChipView: View {
    let label: String
    var isSelected: Bool = false
    var color: Color = .secondary

    var body: some View {
        Text(label)
            .font(.caption)
            .fontWeight(.medium)
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(isSelected ? color.opacity(0.15) : Color(.systemGray6))
            .foregroundColor(isSelected ? color : .secondary)
            .clipShape(Capsule())
            .overlay(Capsule().strokeBorder(isSelected ? color.opacity(0.4) : .clear, lineWidth: 1))
    }
}

struct SelectableTagChipView: View {
    let label: String
    @Binding var isSelected: Bool
    var color: Color = .accentColor

    var body: some View {
        Button { isSelected.toggle() } label: {
            TagChipView(label: label, isSelected: isSelected, color: color)
        }
        .buttonStyle(.plain)
    }
}
