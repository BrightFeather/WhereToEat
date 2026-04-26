import SwiftUI
import MapKit

/// Unified browse + booking surface.
///
/// Replaces the old split between `RestaurantDetailView` (browse) and
/// `AvailabilityView.preBrowserView` (pre-Safari confirmation). This view now
/// owns the `ReservationViewModel` state machine and drives the
/// Safari → ConfirmBookingForm → ReservationSuccessView sequence itself.
struct RestaurantDetailView: View {
    let restaurant: Restaurant
    var onLike: (() -> Void)?
    var onDislike: (() -> Void)?
    var onBlock: (() -> Void)?

    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var customListVM: CustomListViewModel
    @StateObject private var reservationVM: ReservationViewModel
    @State private var sourcesExpanded: Bool = false
    /// Re-read on each render so the Settings → "Show Google ratings" toggle
    /// takes effect immediately when the user navigates back.
    private var showRatings: Bool { UserProfile.load().showRatings }

    init(
        restaurant: Restaurant,
        onLike: (() -> Void)? = nil,
        onDislike: (() -> Void)? = nil,
        onBlock: (() -> Void)? = nil
    ) {
        self.restaurant = restaurant
        self.onLike = onLike
        self.onDislike = onDislike
        self.onBlock = onBlock
        self._reservationVM = StateObject(wrappedValue: ReservationViewModel(restaurant: restaurant))
    }

    private var isSaved: Bool { customListVM.contains(restaurant) }

    private var likeButtonLabel: String {
        // Single copy regardless of platform — "Book on Resy" / "Book on
        // OpenTable" wrapped to two lines and looked misaligned. The platform
        // is already shown as a badge next to the restaurant name.
        "Book this one"
    }

    private var xhsURL: URL? {
        restaurant.sourceLinks.first(where: { $0.platform == .xiaohongshu })?.url
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                PhotoCarouselView(photoURLs: restaurant.photos, height: 300)

                VStack(alignment: .leading, spacing: 16) {
                    header
                    tags
                    Divider()
                    addressBlock
                    Divider()
                    reviewsBlock
                    sourcesBlock
                }
                .padding()
            }
        }
        .scrollContentBackground(.hidden)
        .background(DetailGradientBackground().ignoresSafeArea())
        .ignoresSafeArea(edges: .top)
        .overlay(alignment: .top) { topOverlay }
        .interactiveDismissDisabled(isConfirmingOrSuccess)
        .sheet(isPresented: isConfirmingBinding) {
            NavigationStack {
                ConfirmBookingForm(viewModel: reservationVM) {
                    // "I didn't end up booking" → reset state so the sheet
                    // dismisses cleanly without tripping the success path.
                    reservationVM.state = .preBrowser
                }
                .navigationTitle(restaurant.name)
                .navigationBarTitleDisplayMode(.inline)
            }
            .interactiveDismissDisabled(true)
        }
        .fullScreenCover(item: successReservationBinding) { reservation in
            ReservationSuccessView(reservation: reservation, restaurant: restaurant) {
                // Close success, then close the detail sheet so we return
                // to Home with the fresh reservation already visible.
                reservationVM.state = .preBrowser
                dismiss()
            }
        }
        .safeAreaInset(edge: .bottom) { bottomBar }
    }

    // MARK: - Header (name + bookmark)

    private var header: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(restaurant.name).font(.title2).fontWeight(.bold)
                    if showRatings, let rating = restaurant.rating {
                        ratingBadge(rating: rating, count: restaurant.reviewCount)
                    }
                    bookmarkButton
                }
                if let neighborhood = restaurant.neighborhood {
                    Text(neighborhood)
                        .font(.subheadline).foregroundColor(.secondary)
                }
            }
            Spacer()
            VStack(alignment: .trailing, spacing: 4) {
                // Order: website → IG → Resy/OpenTable badge.
                HStack(spacing: 8) {
                    if let site = restaurantWebsiteUrl {
                        websiteButton(url: site)
                    }
                    if let ig = restaurant.instagramUrl {
                        instagramButton(url: ig)
                    }
                    if let source = restaurant.reservationSource {
                        PlatformBadgeView(platform: source.platform)
                    }
                }
            }
        }
    }

    /// Resolves a non-reservation website URL — prefers the explicit `website`
    /// field; falls back to `bookingUrl` when it's *not* a Resy/OpenTable link
    /// (those have their own badge).
    private var restaurantWebsiteUrl: URL? {
        if let website = restaurant.website { return website }
        if let booking = restaurant.bookingUrl {
            let host = booking.host?.lowercased() ?? ""
            let isReservation =
                host.contains("resy") || host.contains("opentable") || host.contains("tock")
            if !isReservation { return booking }
        }
        return nil
    }

    /// Compact star + rating + review count pill that sits next to the name.
    private func ratingBadge(rating: Double, count: Int?) -> some View {
        HStack(spacing: 3) {
            Image(systemName: "star.fill")
                .font(.caption)
                .foregroundColor(.yellow)
            Text(String(format: "%.1f", rating))
                .font(.subheadline).fontWeight(.semibold)
            if let count, count > 0 {
                Text("(\(formatRatingCount(count)))")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
        }
        .accessibilityLabel("Google rating \(String(format: "%.1f", rating)) out of 5")
    }

    private func websiteButton(url: URL) -> some View {
        Button {
            SafariPresenter.present(url: url) { /* no-op */ }
        } label: {
            Image(systemName: "globe")
                .font(.title2)
                .foregroundColor(.accentColor)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Open restaurant website")
    }

    private func instagramButton(url: URL) -> some View {
        Button {
            SafariPresenter.present(url: url) { /* no-op */ }
        } label: {
            Image(systemName: "camera.circle.fill")
                .font(.title2)
                .foregroundStyle(
                    LinearGradient(
                        colors: [
                            Color(red: 0.96, green: 0.31, blue: 0.55),
                            Color(red: 0.95, green: 0.51, blue: 0.20)
                        ],
                        startPoint: .topLeading, endPoint: .bottomTrailing
                    )
                )
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Open Instagram profile")
    }

    private var bookmarkButton: some View {
        Button(action: handleBookmarkTap) {
            Image(systemName: isSaved ? "bookmark.fill" : "bookmark")
                .font(.title3)
                .foregroundColor(isSaved ? .yellow : .secondary)
                .contentTransition(.symbolEffect(.replace))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(isSaved ? "Remove from My List" : "Save to My List")
    }

    private func handleBookmarkTap() {
        // Always in-place toggle — never dismiss the sheet. User explicitly
        // asked to stay on the page after saving so they can keep reading /
        // book / open Xiaohongshu without losing context.
        if isSaved {
            customListVM.remove(restaurantId: restaurant.id)
        } else {
            customListVM.addFromDiscovery(restaurant)
            // Drop from today's seen-set so the swipe deck won't re-deal it
            // later today — consistent with the save-button semantics on the
            // card itself.
            SeenService.shared.markSeen(restaurant.id)
        }
    }

    // MARK: - Tags

    private var tags: some View {
        FlowLayout(spacing: 6) {
            ForEach(restaurant.cuisineTags) { tag in
                TagChipView(label: tag.displayName)
            }
            if let price = restaurant.priceRange {
                TagChipView(label: String(repeating: "$", count: price))
            }
        }
    }

    // MARK: - Address + XHS + map

    private var addressBlock: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(restaurant.address, systemImage: "mappin.circle.fill")
                .font(.subheadline)

            xhsSourcesBlock

            // Open in Google Maps — inline card below the XHS quote so the
            // bottom bar only carries the primary booking actions.
            if let mapsUrl = restaurant.googleMapsLink {
                Link(destination: mapsUrl) {
                    HStack(spacing: 10) {
                        Image(systemName: "map.fill")
                            .foregroundColor(.white)
                            .frame(width: 24, height: 24)
                            .background(Color.green)
                            .clipShape(RoundedRectangle(cornerRadius: 5))
                        Text("Open in Google Maps")
                            .font(.subheadline).fontWeight(.medium)
                            .foregroundColor(.primary)
                        Spacer()
                        Image(systemName: "arrow.up.right")
                            .font(.caption).foregroundColor(.secondary)
                    }
                    .padding(10)
                    .background(Color(.systemGray6))
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                }
            }

            if restaurant.coordinates.latitude != 0 {
                Map(position: .constant(
                    MapCameraPosition.region(MKCoordinateRegion(
                        center: restaurant.coordinates.clLocation,
                        span: MKCoordinateSpan(latitudeDelta: 0.005, longitudeDelta: 0.005)
                    ))
                )) {
                    Marker(restaurant.name, coordinate: restaurant.coordinates.clLocation)
                }
                .frame(height: 140)
                .clipShape(RoundedRectangle(cornerRadius: 12))
            }
        }
    }

    // MARK: - Source quotes (XHS + Eater + Resy)

    /// One quote per source row that mentioned this restaurant — XHS creator
    /// posts, Eater editor lists, Resy blog features. Each renders as its own
    /// tappable quote card with a platform-coloured badge and byline.
    ///
    /// We collapse to the top 3 by default (sorted by likes desc by the
    /// backend) and reveal the rest behind a "See all N reviews" button.
    /// Falls back to the legacy single `xhsRecommendation` when no `sources[]`
    /// array was returned (older cached rows, custom-list imports).
    @ViewBuilder
    private var xhsSourcesBlock: some View {
        let structured = sortedSources(restaurant.xhsSources ?? [])

        if !structured.isEmpty {
            let collapseLimit = 3
            let visible = sourcesExpanded ? structured : Array(structured.prefix(collapseLimit))
            let hidden = max(0, structured.count - visible.count)
            let header = sourcesHeaderLabel(structured)

            VStack(alignment: .leading, spacing: 8) {
                if let header {
                    Text(header)
                        .font(.caption).fontWeight(.semibold)
                        .foregroundColor(.secondary)
                }
                ForEach(visible) { source in
                    SourceQuoteCard(source: source)
                }
                if hidden > 0 {
                    Button {
                        withAnimation(.easeInOut(duration: 0.2)) { sourcesExpanded = true }
                    } label: {
                        HStack(spacing: 6) {
                            Image(systemName: "chevron.down")
                            Text("See all \(structured.count) reviews")
                        }
                        .font(.subheadline).fontWeight(.medium)
                        .foregroundColor(.accentColor)
                    }
                    .padding(.top, 2)
                } else if sourcesExpanded, structured.count > collapseLimit {
                    Button {
                        withAnimation(.easeInOut(duration: 0.2)) { sourcesExpanded = false }
                    } label: {
                        HStack(spacing: 6) {
                            Image(systemName: "chevron.up")
                            Text("Show less")
                        }
                        .font(.subheadline).fontWeight(.medium)
                        .foregroundColor(.accentColor)
                    }
                    .padding(.top, 2)
                }
            }
        } else if let rec = restaurant.xhsRecommendation {
            // Legacy single-quote path — synthesise a stub source row.
            SourceQuoteCard(
                source: XHSSource(
                    postUrl: xhsURL?.absoluteString ?? "",
                    recommendation: rec,
                    likes: 0,
                    postCreatedAt: nil,
                    sourceType: "xiaohongshu",
                    author: nil,
                    sourceTitle: nil
                )
            )
        }
    }

    /// Drop empty quotes, then re-rank XHS rows by word count desc so the most
    /// substantive 小红书 review surfaces on top. Non-XHS rows keep their
    /// likes-desc order from the backend (Eater / Resy don't have a like
    /// signal worth re-ranking on, and editor articles are usually one-quote
    /// each). Order across types: 小红书 first (longest-first), then others.
    private func sortedSources(_ sources: [XHSSource]) -> [XHSSource] {
        let nonEmpty = sources.filter { ($0.recommendation ?? "").isEmpty == false }
        let xhs = nonEmpty.filter { $0.resolvedType == "xiaohongshu" }
            .sorted { wordCount($0.recommendation) > wordCount($1.recommendation) }
        let others = nonEmpty.filter { $0.resolvedType != "xiaohongshu" }
        return xhs + others
    }

    /// Word-ish count that does the right thing for both English (whitespace-split)
    /// and Chinese (no spaces — fall back to character count). We use the larger
    /// of the two so a Chinese-only quote isn't treated as 1 word.
    private func wordCount(_ text: String?) -> Int {
        guard let text else { return 0 }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return 0 }
        let whitespaceTokens = trimmed.split { $0.isWhitespace || $0.isNewline }.count
        return max(whitespaceTokens, trimmed.count)
    }

    /// Group counter under the section header. Mirrors the "X mentions in 小红书"
    /// accent on the swipe card. Rules:
    ///   - `count(xhs) > 1` → show that count first ("3 mentions in 小红书")
    ///   - else if non-XHS sources exist → "Featured in Eater + Resy"
    ///   - else nil (single quote, no header noise)
    private func sourcesHeaderLabel(_ sources: [XHSSource]) -> String? {
        let xhsCount = sources.filter { $0.resolvedType == "xiaohongshu" }.count
        let others = Set(sources.map(\.resolvedType)).subtracting(["xiaohongshu"])

        if xhsCount > 1 {
            if !others.isEmpty {
                let names = others.compactMap { DiscoverySource(rawValue: $0)?.shortName }
                    .sorted()
                    .joined(separator: " + ")
                return "\(xhsCount) mentions on 小红书 + \(names)"
            }
            return "\(xhsCount) creators on 小红书"
        }
        if !others.isEmpty {
            let names = others.compactMap { DiscoverySource(rawValue: $0)?.shortName }
                .sorted()
                .joined(separator: " + ")
            return xhsCount == 1
                ? "Featured on 小红书 + \(names)"
                : "Featured in \(names)"
        }
        return nil
    }

    // MARK: - Reviews

    @ViewBuilder
    private var reviewsBlock: some View {
        if !restaurant.reviewSnippets.isEmpty {
            VStack(alignment: .leading, spacing: 10) {
                Text("Reviews").font(.headline)
                ForEach(restaurant.reviewSnippets.prefix(3)) { review in
                    ReviewSnippetView(review: review)
                }
            }
        }
    }

    // MARK: - Sources (non-XHS)

    @ViewBuilder
    private var sourcesBlock: some View {
        let nonXhsLinks = restaurant.sourceLinks.filter { $0.platform != .xiaohongshu }
        if !nonXhsLinks.isEmpty {
            Divider()
            VStack(alignment: .leading, spacing: 8) {
                Text("Sources").font(.headline)
                ForEach(nonXhsLinks) { link in
                    Link(destination: link.url) {
                        HStack {
                            Image(systemName: "link")
                            Text(link.platform.displayName)
                            Spacer()
                            Image(systemName: "arrow.up.right")
                        }
                        .font(.subheadline)
                        .foregroundColor(.accentColor)
                    }
                }
            }
        }
    }

    // MARK: - Top overlay (close / block menu)

    private var topOverlay: some View {
        HStack {
            Button { dismiss() } label: {
                Image(systemName: "xmark.circle.fill")
                    .font(.title2)
                    .foregroundStyle(.white, .black.opacity(0.4))
            }
            .padding()
            Spacer()
            if let onBlock {
                Menu {
                    Button(role: .destructive, action: onBlock) {
                        Label("Block for 4 weeks", systemImage: "nosign")
                    }
                } label: {
                    Image(systemName: "ellipsis.circle.fill")
                        .font(.title2)
                        .foregroundStyle(.white, .black.opacity(0.4))
                }
                .padding()
            }
        }
    }

    // MARK: - Bottom bar

    private var bottomBar: some View {
        // Bottom bar carries the primary booking actions only. Open in
        // Google Maps lives inline under the XHS quote; Xiaohongshu is
        // reached by tapping the quote itself.
        primaryActions
            .padding(.horizontal)
            .padding(.vertical, 12)
            .background(.ultraThinMaterial)
    }

    @ViewBuilder
    private var primaryActions: some View {
        if onLike != nil || onDislike != nil {
            // Deck context — Pass + Book row.
            HStack(spacing: 12) {
                if let onDislike {
                    Button(action: onDislike) {
                        Label("Pass", systemImage: "xmark")
                            .font(.headline)
                            .foregroundColor(.red)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 14)
                            .background(Color(.systemGray6))
                            .clipShape(RoundedRectangle(cornerRadius: 14))
                    }
                }
                if onLike != nil, restaurant.effectiveBookingUrl != nil {
                    // Intentionally NOT calling `onLike()` here.
                    // onLike previously routed through `DiscoveryViewModel.swipeRight()`,
                    // which dismissed this detail sheet AND set `likedRestaurant`,
                    // which re-presented the detail view in the standalone
                    // single-Book layout — the "Book swaps layouts" bug the
                    // user saw. The detail view now owns the full booking
                    // state machine (Safari → ConfirmBookingForm → Success)
                    // so it's a mistake to hand control back to the deck
                    // mid-flow. The completed reservation is a stronger
                    // "liked" signal than a synthetic swipe-right record.
                    Button(action: openBrowser) {
                        Label(likeButtonLabel, systemImage: "heart.fill")
                            .font(.headline)
                            .foregroundColor(.white)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 14)
                            .background(Color.green)
                            .clipShape(RoundedRectangle(cornerRadius: 14))
                    }
                }
            }
        } else if restaurant.effectiveBookingUrl != nil {
            // Standalone context — one Book CTA.
            Button(action: openBrowser) {
                HStack(spacing: 8) {
                    Image(systemName: "calendar.badge.plus")
                    Text(restaurant.reservationSource != nil ? "Book this one" : "Go to Website")
                }
                .font(.headline)
                .foregroundColor(.white)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 14)
                .background(Color.accentColor)
                .clipShape(RoundedRectangle(cornerRadius: 14))
            }
        }
    }

    // MARK: - Booking state machine glue

    private func openBrowser() {
        guard let url = restaurant.effectiveBookingUrl else { return }
        SafariPresenter.present(url: url) {
            reservationVM.handleBrowserDismissed()
        }
    }

    private var isConfirmingOrSuccess: Bool {
        switch reservationVM.state {
        case .confirming, .success: return true
        default: return false
        }
    }

    private var isConfirmingBinding: Binding<Bool> {
        Binding(
            get: { if case .confirming = reservationVM.state { return true } else { return false } },
            set: { newValue in
                if !newValue, case .confirming = reservationVM.state {
                    reservationVM.state = .preBrowser
                }
            }
        )
    }

    private var successReservationBinding: Binding<Reservation?> {
        Binding(
            get: { if case .success(let r) = reservationVM.state { return r } else { return nil } },
            set: { _ in
                if case .success = reservationVM.state {
                    reservationVM.state = .preBrowser
                }
            }
        )
    }
}

/// Compact review-count formatter: 1247 → "1.2k", 18420 → "18k", 96 → "96".
/// Used both in the detail header rating pill and the deck-card rating pill.
func formatRatingCount(_ count: Int) -> String {
    if count >= 10_000 { return "\(count / 1_000)k" }
    if count >= 1_000  { return String(format: "%.1fk", Double(count) / 1_000.0) }
    return "\(count)"
}

struct ReviewSnippetView: View {
    let review: Review
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(review.platform.displayName)
                    .font(.caption).fontWeight(.semibold)
                    .foregroundColor(.secondary)
                Spacer()
                if let rating = review.rating {
                    HStack(spacing: 2) {
                        Image(systemName: "star.fill").font(.caption2).foregroundColor(.yellow)
                        Text(String(format: "%.1f", rating)).font(.caption).foregroundColor(.secondary)
                    }
                }
            }
            Text(review.text)
                .font(.subheadline)
                .lineLimit(3)
        }
        .padding(10)
        .background(Color(.systemGray6))
        .clipShape(RoundedRectangle(cornerRadius: 10))
    }
}

// Simple flow layout for tags
struct FlowLayout: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxWidth = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, rowHeight: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x + size.width > maxWidth && x > 0 { x = 0; y += rowHeight + spacing; rowHeight = 0 }
            rowHeight = max(rowHeight, size.height)
            x += size.width + spacing
        }
        return CGSize(width: maxWidth, height: y + rowHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, rowHeight: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x + size.width > bounds.maxX && x > bounds.minX { x = bounds.minX; y += rowHeight + spacing; rowHeight = 0 }
            view.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            rowHeight = max(rowHeight, size.height)
            x += size.width + spacing
        }
    }
}

/// One source row's quote. Polymorphic over `source.resolvedType` —
///   - xiaohongshu → red 小红书 badge, tap opens XHS app via `XhsURLOpener`
///   - eater       → orange Eater badge, tap opens article in Safari
///   - resy_blog   → red Resy badge, tap opens article in Safari
///
/// Author + source title (when present) render as a byline under the quote.
private struct SourceQuoteCard: View {
    let source: XHSSource

    var body: some View {
        Button(action: openSource) {
            HStack(alignment: .top, spacing: 8) {
                Text(source.displayPlatform)
                    .font(.caption).fontWeight(.semibold)
                    .foregroundColor(.white)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 3)
                    .background(badgeColor.opacity(0.9))
                    .clipShape(Capsule())

                VStack(alignment: .leading, spacing: 4) {
                    Text(source.recommendation ?? "")
                        .font(.subheadline)
                        .foregroundColor(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .multilineTextAlignment(.leading)
                    if let byline {
                        Text(byline)
                            .font(.caption2)
                            .foregroundColor(.secondary.opacity(0.8))
                    }
                    if source.resolvedType == "xiaohongshu", source.likes > 0 {
                        Text("♥ \(formatLikes(source.likes))")
                            .font(.caption2)
                            .foregroundColor(.secondary.opacity(0.7))
                    }
                }

                if postURL != nil {
                    Spacer(minLength: 4)
                    Image(systemName: "arrow.up.right.square")
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
            }
            .padding(10)
            .background(Color(.systemGray6))
            .clipShape(RoundedRectangle(cornerRadius: 10))
        }
        .buttonStyle(.plain)
        .disabled(postURL == nil)
    }

    private var postURL: URL? { URL(string: source.postUrl) }

    /// Author + title byline. Skipped for raw XHS posts that lack both.
    private var byline: String? {
        let parts = [source.author, source.sourceTitle]
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private var badgeColor: Color {
        switch source.resolvedType {
        case "xiaohongshu": return Color(red: 1, green: 0.14, blue: 0.26)
        case "eater":       return Color(red: 0.91, green: 0.20, blue: 0.11)
        case "resy_blog":   return Color(red: 0.83, green: 0.14, blue: 0.14)
        default:            return .gray
        }
    }

    private func openSource() {
        guard let postURL else { return }
        if source.resolvedType == "xiaohongshu" {
            XhsURLOpener.open(postURL)
        } else {
            UIApplication.shared.open(postURL)
        }
    }

    private func formatLikes(_ n: Int) -> String {
        if n >= 10_000 { return String(format: "%.1fw", Double(n) / 10_000) } // XHS convention: 万
        if n >= 1_000  { return String(format: "%.1fk", Double(n) / 1_000) }
        return String(n)
    }
}
