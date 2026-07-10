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
    /// Mutable map camera so the user can pinch / pan inside the inline mini-
    /// map. Initialised lazily in the map block when coordinates are present;
    /// the `arrow.up.right.square.fill` overlay still hands off to Apple Maps.
    @State private var mapCameraPosition: MapCameraPosition = .automatic
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
        // Same cream wash as Home / Discovery / My List — coherent palette,
        // no per-page gradient. Content panels (XHS quotes, Maps card,
        // address pill) carry their own white surface + warm hairline so
        // they sit cleanly on the wash instead of blending into it.
        .background(WarmGradientBackground().ignoresSafeArea())
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
                .navigationTitle("")
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
        // Single horizontal line: name + rating + bookmark on the left,
        // website + Instagram pushed to the trailing edge. The Resy /
        // OpenTable badge that used to sit far-right is gone — the booking
        // platform is already conveyed by the "Book this one" CTA + the
        // Safari sheet that opens to the platform's site.
        VStack(alignment: .leading, spacing: 4) {
            // `.firstTextBaseline` left the IG icon visually higher than the
            // title (custom shapes have no text baseline, so they pinned to
            // the row's top). `.center` aligns every glyph around the visual
            // midline of the title — IG, bookmark, and rating all sit even.
            HStack(alignment: .center, spacing: 8) {
                Text(restaurant.name)
                    .font(.title2)
                    .fontWeight(.medium)
                if showRatings, let rating = restaurant.rating {
                    ratingBadge(rating: rating, count: restaurant.reviewCount)
                }
                bookmarkButton
                Spacer(minLength: 8)
                if let site = restaurantWebsiteUrl {
                    websiteButton(url: site)
                }
                if let ig = restaurant.instagramUrl {
                    instagramButton(url: ig)
                }
            }
            if let neighborhood = restaurant.neighborhood {
                Text(neighborhood)
                    .font(.subheadline).foregroundColor(.secondary)
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
    /// Trailing `· $$$` chip when Places returned a `priceLevel`.
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
            if let price = restaurant.priceRange {
                Text("·").font(.subheadline).foregroundColor(.secondary)
                Text(String(repeating: "$", count: price))
                    .font(.subheadline).fontWeight(.light)
                    .fontWidth(.condensed)
                    .tracking(-0.5)
            }
        }
        .accessibilityLabel(
            "Google rating \(String(format: "%.1f", rating)) out of 5"
            + (restaurant.priceRange.map { ", price \(String(repeating: "$", count: $0))" } ?? "")
        )
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
            // Try the native Instagram app first via `instagram://user?username=…`;
            // `InstagramURLOpener` falls back to Safari if the IG app isn't
            // installed or the URL doesn't point at a profile path.
            InstagramURLOpener.open(url)
        } label: {
            InstagramGlyph()
                .frame(width: 26, height: 26)
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

    /// Hand off to Apple Maps with the restaurant pre-pinned. We build an
    /// `MKMapItem` from the existing coordinates so the destination opens
    /// with the venue name as the pin label rather than just a raw lat/lng
    /// drop. `MKLaunchOptionsMapTypeKey` defaults to standard which matches
    /// the inline mini-map's style.
    private func openInAppleMaps() {
        let coord = restaurant.coordinates.clLocation
        guard CLLocationCoordinate2DIsValid(coord), coord.latitude != 0 else { return }
        let placemark = MKPlacemark(coordinate: coord)
        let item = MKMapItem(placemark: placemark)
        item.name = restaurant.name
        item.openInMaps(launchOptions: nil)
    }

    // MARK: - Tags

    private var tags: some View {
        FlowLayout(spacing: 6) {
            ForEach(restaurant.cuisineTags) { tag in
                TagChipView(label: tag.displayName)
            }
        }
    }

    // MARK: - Address + XHS + map

    private var addressBlock: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(restaurant.address, systemImage: "mappin.circle.fill")
                .font(.subheadline)

            xhsSourcesBlock

            // Open in Google Maps — temporarily hidden. The inline mini-map
            // below already conveys location; restore this card if users miss
            // the explicit handoff.
            // if let mapsUrl = restaurant.googleMapsLink {
            //     Link(destination: mapsUrl) {
            //         HStack(spacing: 10) {
            //             Image(systemName: "map.fill")
            //                 .foregroundColor(.white)
            //                 .frame(width: 24, height: 24)
            //                 .background(Color.green)
            //                 .clipShape(RoundedRectangle(cornerRadius: 5))
            //             Text("Open in Google Maps")
            //                 .font(.subheadline).fontWeight(.medium)
            //                 .foregroundColor(.primary)
            //             Spacer()
            //             Image(systemName: "arrow.up.right")
            //                 .font(.caption).foregroundColor(.secondary)
            //         }
            //         .padding(10)
            //         .background(Color(.systemBackground))
            //         .clipShape(RoundedRectangle(cornerRadius: 10))
            //         .overlay(
            //             RoundedRectangle(cornerRadius: 10)
            //                 .stroke(Color.cardBorder, lineWidth: 1)
            //         )
            //     }
            // }

            if restaurant.coordinates.latitude != 0 {
                // Inline mini-map. Pinch + pan + zoom are enabled (the Map
                // owns its gesture stack via `mapCameraPosition`); the
                // floating arrow button in the top-right hands off to Apple
                // Maps with the restaurant name pre-pinned via `MKMapItem`.
                ZStack(alignment: .topTrailing) {
                    Map(position: $mapCameraPosition) {
                        Marker(restaurant.name, coordinate: restaurant.coordinates.clLocation)
                    }
                    .frame(height: 140)

                    Button(action: openInAppleMaps) {
                        Image(systemName: "arrow.up.right.square.fill")
                            .font(.title3)
                            .foregroundColor(.white)
                            .shadow(color: .black.opacity(0.35), radius: 2, y: 1)
                            .padding(8)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Open in Apple Maps")
                }
                .clipShape(RoundedRectangle(cornerRadius: 12))
                .overlay(
                    RoundedRectangle(cornerRadius: 12)
                        .stroke(Color.cardBorder, lineWidth: 1)
                )
                .onAppear {
                    // Re-center the camera each time the view appears so a
                    // previous pan/zoom doesn't leak across restaurants.
                    mapCameraPosition = .region(MKCoordinateRegion(
                        center: restaurant.coordinates.clLocation,
                        span: MKCoordinateSpan(latitudeDelta: 0.005, longitudeDelta: 0.005)
                    ))
                }
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

    /// Group counter under the section header. Rules:
    ///   - ≥ 2 distinct source types → "Mentioned on A and B" (and on
    ///     three+ types: "A, B, and C" — extends naturally as we add new
    ///     sources beyond xiaohongshu / eater / resy_blog).
    ///   - only 小红书, count == 2 → "Mentioned 2 times on 小红书"
    ///   - only 小红书, count ≥ 3 → "Mentioned 3+ times on 小红书"
    ///   - only one non-XHS source type → "Featured in Eater"
    ///   - else nil (single quote, no header noise).
    private func sourcesHeaderLabel(_ sources: [XHSSource]) -> String? {
        let typeCounts = Dictionary(grouping: sources, by: \.resolvedType)
            .mapValues(\.count)
        let presentTypes = typeCounts.keys

        if presentTypes.count >= 2 {
            let names = sourceDisplayNames(for: Array(presentTypes))
            return "Mentioned on \(joinWithAnd(names))"
        }

        if let only = presentTypes.first {
            let count = typeCounts[only] ?? 0
            if only == "xiaohongshu" {
                if count >= 3 { return "Mentioned 3+ times on 小红书" }
                if count == 2 { return "Mentioned 2 times on 小红书" }
                return nil
            }
            if let pretty = DiscoverySource(rawValue: only)?.shortName {
                return "Featured in \(pretty)"
            }
        }
        return nil
    }

    /// Map raw source-type keys to user-facing labels. Mirrors `XHSSource.displayPlatform`.
    private func sourceDisplayNames(for types: [String]) -> [String] {
        types
            .map { type -> String in
                switch type {
                case "xiaohongshu": return "小红书"
                case "eater":       return "Eater"
                case "resy_blog":   return "Resy"
                default:            return DiscoverySource(rawValue: type)?.shortName ?? type.capitalized
                }
            }
            .sorted()
    }

    private func joinWithAnd(_ items: [String]) -> String {
        switch items.count {
        case 0: return ""
        case 1: return items[0]
        case 2: return "\(items[0]) and \(items[1])"
        default:
            let head = items.dropLast().joined(separator: ", ")
            return "\(head), and \(items.last!)"
        }
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
            // Close button hugs the actual top-left corner — just below the
            // Dynamic Island / status bar safe-area edge, flush against the
            // leading edge of the screen.
            Button { dismiss() } label: {
                Image(systemName: "xmark.circle.fill")
                    .font(.title2)
                    .foregroundStyle(.white, .black.opacity(0.4))
            }
            .padding(.leading, 10)
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
                .padding(.trailing, 10)
            }
        }
        // Sits just below the Dynamic Island / notch — `safeAreaInsets.top`
        // is ~59pt on the 15/16 Pro, so this lifts the X to the corner
        // without colliding with the status bar.
        .padding(.top, 12)
    }

    // MARK: - Bottom bar

    /// True iff `primaryActions` would render at least one button. Used to
    /// suppress the blurred bottom-bar strip on restaurants that have no
    /// reservation source AND no swipe context — otherwise the empty
    /// `primaryActions` body still inherited the padding + material
    /// background, leaving an empty frosted bar pinned to the bottom.
    private var hasBottomAction: Bool {
        if onDislike != nil { return true }
        if onLike != nil, restaurant.reservationSource != nil { return true }
        if onLike == nil, onDislike == nil, restaurant.reservationSource != nil { return true }
        return false
    }

    @ViewBuilder
    private var bottomBar: some View {
        // Bottom bar carries the primary booking actions only. Open in
        // Google Maps lives inline under the XHS quote; Xiaohongshu is
        // reached by tapping the quote itself.
        if hasBottomAction {
            primaryActions
                .padding(.horizontal)
                .padding(.vertical, 12)
                .background(.ultraThinMaterial)
        }
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
                if onLike != nil, restaurant.reservationSource != nil {
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
        } else if restaurant.reservationSource != nil {
            // Standalone context — one Book CTA. Only shown when the
            // restaurant actually has a reservation platform (Resy /
            // OpenTable / Tock); the website-fallback "Go to Website"
            // CTA is intentionally hidden because non-bookable venues
            // shouldn't get a button-shaped affordance that promises one.
            Button(action: openBrowser) {
                HStack(spacing: 8) {
                    Image(systemName: "calendar.badge.plus")
                    Text("Book this one")
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
        // Try the native Resy / OpenTable / Tock app via Universal Links
        // first; `BookingURLOpener` falls back to SFSafariViewController for
        // any URL whose host doesn't claim a Universal Link match. The
        // `onReturn` callback runs whether the user dismissed Safari or
        // returned from the native app, so the Confirm form fires either way.
        BookingURLOpener.open(url) {
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
        .background(Color.homeBgBottom)
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .stroke(Color.cardBorder, lineWidth: 1)
        )
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
///
/// Long XHS posts can run hundreds of characters; collapsed by default to
/// `Self.collapsedLineLimit` lines with a "Show more" toggle. The
/// outer-card tap (which opens the source post) is deliberately overridden
/// inside the toggle area so it doesn't fire when the user just wants to
/// expand the quote.
private struct SourceQuoteCard: View {
    let source: XHSSource

    @State private var expanded = false

    /// Show the expand toggle once the quote runs past this many characters.
    /// At ~36 characters per line on a card that wide, ~180 chars is roughly
    /// where the 5-line collapsed view starts cutting content off.
    private static let expandThreshold = 180
    private static let collapsedLineLimit = 5

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
                        .lineLimit(expanded ? nil : Self.collapsedLineLimit)
                    if shouldShowExpandToggle {
                        Button(action: { withAnimation(.easeInOut(duration: 0.2)) { expanded.toggle() } }) {
                            Text(expanded ? "Show less" : "Show more")
                                .font(.caption).fontWeight(.semibold)
                                .foregroundColor(.accentColor)
                        }
                        .buttonStyle(.plain)
                    }
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
            .background(Color.homeBgBottom)
            .clipShape(RoundedRectangle(cornerRadius: 10))
            .overlay(
                RoundedRectangle(cornerRadius: 10)
                    .stroke(Color.cardBorder, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
        .disabled(postURL == nil)
    }

    private var shouldShowExpandToggle: Bool {
        (source.recommendation?.count ?? 0) > Self.expandThreshold
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

/// Vector-drawn Instagram glyph — rounded square frame + center camera lens
/// circle + small filled "flash" dot in the top-right corner. Approximates
/// the trademarked logo silhouette using built-in shapes so we don\047t
/// need a bundled image asset. Filled with the Instagram brand gradient.
private struct InstagramGlyph: View {
    var body: some View {
        GeometryReader { geo in
            let size = min(geo.size.width, geo.size.height)
            let stroke = size * 0.10
            let lensRadius = size * 0.22
            let dotRadius = size * 0.055
            let inset = size * 0.07
            let cornerRadius = size * 0.26

            let gradient = LinearGradient(
                colors: [
                    Color(red: 0.40, green: 0.20, blue: 0.78),   // purple
                    Color(red: 0.96, green: 0.31, blue: 0.55),   // pink
                    Color(red: 0.99, green: 0.62, blue: 0.27)    // orange
                ],
                startPoint: .topLeading, endPoint: .bottomTrailing
            )

            ZStack {
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .strokeBorder(gradient, lineWidth: stroke)
                    .padding(inset)

                Circle()
                    .strokeBorder(gradient, lineWidth: stroke)
                    .frame(width: lensRadius * 2, height: lensRadius * 2)

                Circle()
                    .fill(gradient)
                    .frame(width: dotRadius * 2, height: dotRadius * 2)
                    .offset(x: size * 0.22, y: -size * 0.22)
            }
            .frame(width: size, height: size)
        }
    }
}
