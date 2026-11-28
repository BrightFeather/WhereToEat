import SwiftUI

/// "I'm feeling lucky" — last card on Home. Peach card palette: the detail
/// page's peach → cream wash in light mode, a raised Low light card in dark, with
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
            chipRow(selectedId: viewModel.luckyCuisine ?? "any",
                    contentKey: viewModel.luckyCuisineOptions) {
                chip("Surprise me", selected: viewModel.luckyCuisine == nil) {
                    viewModel.selectLuckyCuisine(nil)
                }
                .id("any")
                ForEach(viewModel.luckyCuisineOptions, id: \.self) { key in
                    chip(viewModel.cuisineDisplayLabel(key),
                         icon: key == viewModel.luckyInferredCuisine ? "sparkles" : nil,
                         selected: viewModel.luckyCuisine == key) {
                        viewModel.selectLuckyCuisine(key)
                    }
                    .id(key)
                }
            }

            rowLabel("WHERE")
            chipRow(selectedId: selectedPlaceChipId,
                    contentKey: viewModel.luckyPlaceOptions.map(\.storageValue)) {
                ForEach(viewModel.luckyPlaceOptions, id: \.self) { place in
                    chip(placeLabel(place),
                         icon: place == .nearMe ? "location.fill" : (isExpandable(place) ? "chevron.down" : nil),
                         selected: isPlaceChipSelected(place)) {
                        withAnimation(.spring(response: 0.35, dampingFraction: 0.8)) {
                            viewModel.selectLuckyPlace(place)
                        }
                    }
                    .id(place.storageValue)
                }
            }

            // Picking a borough / region opens its neighborhoods, like the
            // Pick page's filter rows.
            if let region = viewModel.luckyPlace.region, !viewModel.luckyNeighborhoodOptions.isEmpty {
                rowLabel("NEIGHBORHOOD")
                chipRow(selectedId: viewModel.luckyPlace.storageValue,
                        contentKey: viewModel.luckyNeighborhoodOptions) {
                    chip("All of \(region)", selected: viewModel.luckyPlace == .region(region)) {
                        viewModel.selectLuckyPlace(.region(region))
                    }
                    .id(HomeViewModel.LuckyPlace.region(region).storageValue)
                    ForEach(viewModel.luckyNeighborhoodOptions, id: \.self) { hood in
                        let place = HomeViewModel.LuckyPlace.neighborhood(region: region, name: hood)
                        chip(hood, selected: viewModel.luckyPlace == place) {
                            viewModel.selectLuckyPlace(place)
                        }
                        .id(place.storageValue)
                    }
                }
                .transition(.opacity.combined(with: .move(edge: .top)))
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

    /// Horizontal chip row that runs edge to edge inside the card (no chip
    /// sliver clipped at the padding line) and keeps the selected chip
    /// scrolled into view, e.g. a remembered "Staten Island".
    private func chipRow<Content: View>(selectedId: String,
                                        contentKey: [String] = [],
                                        @ViewBuilder _ content: () -> Content) -> some View {
        let chips = content()
        return ScrollViewReader { proxy in
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) { chips }
                    .padding(.horizontal, 16)
            }
            .padding(.horizontal, -16)
            .onAppear { proxy.scrollTo(selectedId, anchor: .center) }
            .onChange(of: selectedId) { _, id in
                withAnimation(.easeOut(duration: 0.25)) { proxy.scrollTo(id, anchor: .center) }
            }
            // Options can load or reorder after first render (the region
            // list arrives async): re-center on the selection when they do.
            .onChange(of: contentKey) { _, _ in proxy.scrollTo(selectedId, anchor: .center) }
        }
    }

    private func chip(_ label: String, icon: String? = nil, selected: Bool,
                      action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 4) {
                if let icon { Image(systemName: icon).font(.caption2) }
                Text(label).font(.caption).fontWeight(.bold)
            }
            .foregroundColor(selected ? .white : palette.chipText)
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            .background(Capsule().fill(selected ? Self.orange : palette.chipFill))
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
            } else if case .neighborhood(let region, _) = viewModel.luckyPlace {
                pill("Widen to all of \(region)", icon: "arrow.up.left.and.arrow.down.right") {
                    viewModel.selectLuckyPlace(.region(region))
                }
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
        // The button keeps its full label; the meta line beside it wraps.
        .fixedSize(horizontal: true, vertical: false)
        .layoutPriority(1)
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
        case .neighborhood(_, let name): return name
        case .wholeCity: return "All of \(viewModel.luckyCityLabel)"
        }
    }

    /// A borough chip stays highlighted while one of its neighborhoods is
    /// picked.
    private func isPlaceChipSelected(_ place: HomeViewModel.LuckyPlace) -> Bool {
        if case .region(let name) = place { return viewModel.luckyPlace.region == name }
        return viewModel.luckyPlace == place
    }

    private var selectedPlaceChipId: String {
        if let region = viewModel.luckyPlace.region {
            return HomeViewModel.LuckyPlace.region(region).storageValue
        }
        return viewModel.luckyPlace.storageValue
    }

    private func isExpandable(_ place: HomeViewModel.LuckyPlace) -> Bool {
        if case .region = place { return true }
        return false
    }

    static func milesLabel(_ meters: Double) -> String {
        let miles = meters / 1_609.34
        return miles < 10 ? String(format: "%.1f mi", miles).replacingOccurrences(of: ".0 ", with: " ")
                          : "\(Int(miles.rounded())) mi"
    }

    // MARK: - Palette

    static let orange = Color.accentColor   // #FA7A1A light / #F0843C dark (AccentColor asset)

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

    /// Light: Peach card. Dark: Low light — a raised #312822 card with an
    /// orange hairline and the same orange as the only accent.
    private var palette: Palette {
        scheme == .dark
            ? Palette(
                background: [Color(rgb: 0x312822), Color(rgb: 0x2C241F)],
                border: Color(rgb: 0xF0843C, opacity: 0.35),
                caption: Color(rgb: 0xF0843C),
                title: Color(rgb: 0xEDE4D8),
                rowLabel: Color(rgb: 0x9C8F82),
                chipFill: Color(rgb: 0x3A302A),
                chipText: Color(rgb: 0xD9C9B6),
                fanEdge: Color(rgb: 0xEDE4D8))
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
