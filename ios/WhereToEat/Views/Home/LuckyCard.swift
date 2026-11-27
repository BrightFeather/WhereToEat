import SwiftUI

/// "I'm feeling lucky" — last card on Home. Peach card palette: the detail
/// page's peach → cream wash in light mode, warm cocoa in dark mode, with
/// Discovery's orange chip style. CRAVING / WHERE chip rows pick the inputs;
/// only the button rolls.
struct LuckyCard: View {
    @ObservedObject var viewModel: HomeViewModel
    let onRoll: () -> Void

    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let match = viewModel.luckyMatch
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("I'm feeling lucky")
                        .font(.caption).fontWeight(.semibold)
                        .foregroundColor(palette.caption)
                    Text("Can't decide?")
                        .font(.fraunces(.title2, weight: .semibold))
                        .foregroundColor(palette.title)
                }
                Spacer()
                fan
            }

            rowLabel("CRAVING")
            chipRow {
                chip("Surprise me", selected: viewModel.luckyCuisine == nil) {
                    viewModel.selectLuckyCuisine(nil)
                }
                ForEach(viewModel.luckyCuisineOptions, id: \.self) { key in
                    chip(viewModel.cuisineDisplayLabel(key),
                         icon: key == viewModel.luckyInferredCuisine ? "sparkles" : nil,
                         selected: viewModel.luckyCuisine == key) {
                        viewModel.selectLuckyCuisine(key)
                    }
                }
            }

            rowLabel("WHERE")
            chipRow {
                ForEach(viewModel.luckyPlaceOptions, id: \.self) { place in
                    chip(placeLabel(place),
                         icon: place == .nearMe ? "location.fill" : nil,
                         selected: viewModel.luckyPlace == place,
                         dimmed: isEmptyRegion(place)) {
                        viewModel.selectLuckyPlace(place)
                    }
                }
            }

            HStack(spacing: 10) {
                actionButton(matchCount: match.restaurants.count)
                // With no matches the button itself ("Widen to all of New
                // York") explains it; the meta line would squeeze it.
                if !(match.restaurants.isEmpty && viewModel.luckyRollsLeft > 0) {
                    Text(metaLine(match))
                        .font(.caption)
                        .foregroundColor(palette.rowLabel)
                        .lineLimit(2)
                }
            }
            .padding(.top, 16)
        }
        .padding(16)
        .background(
            LinearGradient(colors: palette.background, startPoint: .top, endPoint: .bottom)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 20).strokeBorder(palette.border, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 20))
        .shadow(color: .black.opacity(scheme == .dark ? 0 : 0.06), radius: 10, y: 3)
    }

    // MARK: - Pieces

    /// Two candidate photos tilted behind a face-down "?" card.
    private var fan: some View {
        let photos = viewModel.luckyFanPhotos
        return ZStack {
            fanPhoto(photos.first).rotationEffect(.degrees(-14)).offset(x: -18, y: 4)
            fanPhoto(photos.count > 1 ? photos[1] : nil).rotationEffect(.degrees(12)).offset(x: 18, y: 4)
            RoundedRectangle(cornerRadius: 8)
                .fill(Self.orange)
                .frame(width: 40, height: 52)
                .overlay(Text("?").font(.title3).fontWeight(.bold).foregroundColor(.white))
                .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(palette.fanEdge, lineWidth: 2))
        }
        .frame(width: 92, height: 64)
    }

    private func fanPhoto(_ url: URL?) -> some View {
        CachedAsyncImage(url: url) { phase in
            switch phase {
            case .success(let img): img.resizable().scaledToFill()
            default: Color.detailBgTop
            }
        }
        .frame(width: 40, height: 52)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(palette.fanEdge, lineWidth: 2))
    }

    private func rowLabel(_ text: String) -> some View {
        Text(text)
            .font(.caption2).fontWeight(.semibold)
            .kerning(0.8)
            .foregroundColor(palette.rowLabel)
            .padding(.top, 14)
            .padding(.bottom, 6)
    }

    private func chipRow<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) { content() }
        }
    }

    private func chip(_ label: String, icon: String? = nil, selected: Bool,
                      dimmed: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 4) {
                if let icon { Image(systemName: icon).font(.caption2) }
                Text(label).font(.caption).fontWeight(.bold)
            }
            .foregroundColor(selected ? .white : palette.chipText)
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            .background(Capsule().fill(selected ? Self.orange : palette.chipFill))
            .opacity(dimmed && !selected ? 0.45 : 1)
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private func actionButton(matchCount: Int) -> some View {
        if viewModel.luckyRollsLeft == 0 {
            pill("Swipe the deck", icon: "rectangle.stack") {
                NotificationCenter.default.post(name: .switchToPick, object: nil)
            }
        } else if matchCount == 0 {
            if viewModel.luckyPlace == .wholeCity {
                pill("Try Surprise me", icon: "sparkles") { viewModel.selectLuckyCuisine(nil) }
            } else {
                pill("Widen to all of \(viewModel.luckyCityLabel)", icon: "arrow.up.left.and.arrow.down.right") {
                    viewModel.selectLuckyPlace(.wholeCity)
                }
            }
        } else {
            pill("Roll the dice", icon: "dice.fill") {
                UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                onRoll()
            }
        }
    }

    private func pill(_ label: String, icon: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(label, systemImage: icon)
                .font(.subheadline).fontWeight(.semibold)
                .foregroundColor(.white)
                .lineLimit(1)
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .background(Capsule().fill(Self.orange))
        }
        .buttonStyle(.plain)
    }

    private func metaLine(_ match: HomeViewModel.LuckyMatch) -> String {
        let left = viewModel.luckyRollsLeft
        if left == 0 { return "That's your lucky three for today" }
        let count = match.restaurants.count
        if count == 0 { return "No matches here" }
        var parts = ["\(count) spot\(count == 1 ? "" : "s")"]
        if let radius = match.radiusMeters {
            parts[0] += " within \(Self.milesLabel(radius))"
        }
        parts.append("\(left) roll\(left == 1 ? "" : "s") left")
        return parts.joined(separator: " · ")
    }

    private func placeLabel(_ place: HomeViewModel.LuckyPlace) -> String {
        switch place {
        case .nearMe: return "Near me"
        case .region(let name): return name
        case .wholeCity: return "All of \(viewModel.luckyCityLabel)"
        }
    }

    private func isEmptyRegion(_ place: HomeViewModel.LuckyPlace) -> Bool {
        if case .region(let name) = place { return viewModel.luckyCount(inRegion: name) == 0 }
        return false
    }

    static func milesLabel(_ meters: Double) -> String {
        let miles = meters / 1_609.34
        return miles < 10 ? String(format: "%.1f mi", miles).replacingOccurrences(of: ".0 ", with: " ")
                          : "\(Int(miles.rounded())) mi"
    }

    // MARK: - Palette

    static let orange = Color(red: 0.98, green: 0.48, blue: 0.10)   // #FA7A1A

    private struct Palette {
        let background: [Color]
        let border: Color
        let caption: Color
        let title: Color
        let rowLabel: Color
        let chipFill: Color
        let chipText: Color
        let fanEdge: Color
    }

    private var palette: Palette {
        scheme == .dark
            ? Palette(
                background: [Color(rgb: 0x331A0D), Color(rgb: 0x26140A)],
                border: Color(red: 0.55, green: 0.42, blue: 0.25, opacity: 0.45),
                caption: Color(rgb: 0xFFA94D),
                title: Color(rgb: 0xFFF0D9),
                rowLabel: Color(rgb: 0xC9A27E),
                chipFill: Color(rgb: 0x4A2A18),
                chipText: Color(rgb: 0xFFB877),
                fanEdge: Color(rgb: 0xFFF0D9))
            : Palette(
                background: [Color(rgb: 0xFFDBB5), Color(rgb: 0xFFF1DD)],
                border: Color(red: 0.62, green: 0.42, blue: 0.18, opacity: 0.28),
                caption: Color(rgb: 0xBF610D),
                title: Color(rgb: 0x3A1F0F),
                rowLabel: Color(rgb: 0x9E6B2E),
                chipFill: .white,
                chipText: Color(rgb: 0xBF610D),
                fanEdge: .white)
    }
}

extension Color {
    /// `Color(rgb: 0xFA7A1A)`.
    init(rgb: UInt32, opacity: Double = 1) {
        self.init(red: Double((rgb >> 16) & 0xFF) / 255,
                  green: Double((rgb >> 8) & 0xFF) / 255,
                  blue: Double(rgb & 0xFF) / 255,
                  opacity: opacity)
    }
}
