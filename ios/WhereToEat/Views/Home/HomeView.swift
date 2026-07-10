import SwiftUI

private extension String {
    /// Uppercase only the first character; leave the rest as-is.
    var firstLetterCapitalized: String {
        guard let first = first else { return self }
        return first.uppercased() + dropFirst()
    }
}

struct HomeView: View {
    @StateObject private var viewModel = HomeViewModel()
    @StateObject private var customListVM = CustomListViewModel()
    @StateObject private var pickVM: DiscoveryViewModel
    @EnvironmentObject private var locationService: LocationService
    @State private var selectedTab: Int = 0

    init() {
        // Pick tab reuses the existing Discovery view model. Lifted here as
        // an @StateObject so Pick keeps its deck position and filter state
        // across tab switches (mirrors how `customListVM` survives).
        let session = WeeklySession.load()
        _pickVM = StateObject(wrappedValue: DiscoveryViewModel(session: session))
    }

    var body: some View {
        // Tab bar configured once so the warm gradient shows through both tabs
        // instead of the default opaque systemBackground white edge.
        let _ = Self.configureTabBarAppearance()

        return TabView(selection: $selectedTab) {
            NavigationStack {
                mainTab
                    .toolbar {
                        ToolbarItem(placement: .navigationBarTrailing) {
                            HStack(spacing: 14) {
                                NavigationLink(destination: BookingsListView()) {
                                    Image(systemName: "calendar")
                                        .foregroundColor(.secondary)
                                }
                                NavigationLink(destination: SettingsView()) {
                                    Image(systemName: "gearshape")
                                        .foregroundColor(.secondary)
                                }
                            }
                        }
                    }
            }
            .tabItem { Label("Home", systemImage: "house.fill") }
            .tag(0)

            // Pick — the swipe deck (formerly reachable only from Home's CTA).
            NavigationStack {
                DiscoveryContainerView(viewModel: pickVM)
                    .environmentObject(customListVM)
            }
            .tabItem { Label("Pick", systemImage: "flame.fill") }
            .tag(1)

            // Find — full-bleed NYC map + list of restaurants.
            NavigationStack {
                FindView()
                    .environmentObject(customListVM)
                    .navigationBarHidden(true)
            }
            .tabItem { Label("Find", systemImage: "map.fill") }
            .tag(2)

            NavigationStack {
                CustomListView()
                    .navigationTitle("My List")
                    .environmentObject(customListVM)
            }
            .tabItem { Label("My List", systemImage: "heart.text.square") }
            .tag(3)
        }
        .tint(.accentColor)
        // Warm gradient on the TabView root so the area under the tab bar +
        // around safe-area insets reads as the same peach-cream surface as
        // the page content — no white edge sliver above the tab bar.
        .background(WarmGradientBackground().ignoresSafeArea())
        // Lifted so CardDeckView, DiscoveryWrapper, and any presented
        // `RestaurantDetailView` sheet can read / mutate the custom list via
        // `@EnvironmentObject` without each call site threading it through.
        .environmentObject(customListVM)
        .onReceive(NotificationCenter.default.publisher(for: .switchToMyList)) { _ in
            selectedTab = 3
        }
        .onReceive(NotificationCenter.default.publisher(for: .switchToPick)) { _ in
            selectedTab = 1
        }
        .onReceive(NotificationCenter.default.publisher(for: .switchToFind)) { _ in
            selectedTab = 2
        }
        .onReceive(NotificationCenter.default.publisher(for: .weeklySessionUpdated)) { _ in
            viewModel.refresh()
        }
        .onAppear { viewModel.refresh() }
    }

    private var mainTab: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                // Greeting + upcoming-reservations subhead
                VStack(alignment: .leading, spacing: 6) {
                    Text(viewModel.greeting)
                        .font(.fraunces(.largeTitle, weight: .semibold))
                    Text(viewModel.upcomingSubheadline)
                        .font(.fraunces(.title3))
                        .foregroundColor(.secondary)
                }
                .padding(.horizontal)

                if locationService.isUsingOverride {
                    HStack(spacing: 6) {
                        Image(systemName: "mappin.circle.fill").foregroundColor(.orange)
                        Text(locationService.effectiveCityName)
                            .font(.subheadline).foregroundColor(.secondary)
                    }
                    .padding(.horizontal)
                }

                // Upcoming reservations — shown at the top if any.
                if viewModel.hasUpcomingReservations {
                    VStack(spacing: 14) {
                        ForEach(viewModel.upcomingReservations) { reservation in
                            NavigationLink(destination: BookingsListView()) {
                                BookingHeroCard(reservation: reservation)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.horizontal)
                }

                // Three curated picks (Top Pick / New This Week / Hidden Gem).
                // Replaces the old 2×2 photo-grid CTA — denser and more useful.
                if !viewModel.homePicks.isEmpty {
                    picksSection
                }

                // Single gradient CTA into the swipe deck — always rendered so
                // the user can reach Discovery even when the weekly pipeline
                // is rebuilding (weeklyCount = 0) or the source-filter set is
                // empty. Discovery itself shows the appropriate empty/
                // building state.
                findAnotherRestaurantButton
                    .padding(.horizontal)

                // Stats — only when we actually have a count to show.
                if viewModel.weeklyCount > 0 {
                    statsRow
                }
            }
            .padding(.vertical)
        }
        .background(WarmGradientBackground().ignoresSafeArea())
        .scrollContentBackground(.hidden)
        .refreshable {
            // Pull-to-refresh: force a fresh /api/restaurants/weekly fetch.
            // The conditional ETag path means a 304 (no changes) is cheap,
            // and a 200 with new data lands in the cache + publishes through
            // WeeklyRestaurantService.$status, which the home view model is
            // already subscribed to. After the network round-trip, also
            // re-pull the user's reserved + blocked sets so the home count
            // reflects any cross-device changes since last load.
            await viewModel.pullToRefresh()
        }
        .navigationBarTitleDisplayMode(.inline)
    }

    // MARK: - Gradient CTA into the swipe deck

    private var findAnotherRestaurantButton: some View {
        // Used to push Discovery via NavigationStack; now jumps to the Pick
        // tab via the `.switchToPick` notification bus so the Discovery deck
        // is reachable as a top-level tab.
        Button {
            NotificationCenter.default.post(name: .switchToPick, object: nil)
        } label: {
            HStack(spacing: 10) {
                Image(systemName: "sparkles")
                    .font(.subheadline).fontWeight(.semibold)
                Text(ctaLabel)
                    .font(.subheadline).fontWeight(.semibold)
                Spacer()
                Image(systemName: "arrow.right")
                    .font(.subheadline).fontWeight(.semibold)
            }
            .foregroundColor(.white)
            .padding(.horizontal, 18)
            .padding(.vertical, 14)
            .frame(maxWidth: .infinity)
            .background(
                LinearGradient(
                    colors: [
                        Color(red: 0.45, green: 0.20, blue: 0.95),
                        Color(red: 0.98, green: 0.48, blue: 0.10)
                    ],
                    startPoint: .leading, endPoint: .trailing
                )
            )
            .clipShape(RoundedRectangle(cornerRadius: 16))
            .shadow(color: Color(red: 0.45, green: 0.20, blue: 0.95).opacity(0.35),
                    radius: 10, y: 4)
        }
        .buttonStyle(.plain)
    }

    /// "Swipe through all N picks" when we have a count; bookings-only fallback
    /// keeps the shorter phrasing from before.
    private var ctaLabel: String {
        let total = viewModel.weeklyCount
        if viewModel.hasUpcomingReservations {
            return total > 0 ? "Swipe through \(total) more picks" : "Find another restaurant"
        }
        return total > 0 ? "Swipe through all \(total) picks" : "Find another restaurant"
    }

    // MARK: - This week's picks

    /// Always-expanded picks section. The header is a static label (no tap
    /// to collapse). With an upcoming reservation `homePicks` returns just
    /// TOP PICK; without, all three slots show.
    private var picksSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("This week's picks")
                    .font(.fraunces(.title3, weight: .semibold))
                    .foregroundColor(.primary)
                Spacer()
            }
            .padding(.horizontal)

            VStack(spacing: 12) {
                ForEach(viewModel.homePicks) { pick in
                    NavigationLink(destination: detailDestination(for: pick.restaurant)) {
                        HomePickCard(pick: pick)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal)
        }
    }

    private func detailDestination(for weekly: WeeklyRestaurant) -> some View {
        RestaurantDetailView(restaurant: weekly.toRestaurant())
            .environmentObject(customListVM)
    }

    // MARK: - Stats row

    private var statsRow: some View {
        HStack(spacing: 12) {
            Button {
                NotificationCenter.default.post(name: .switchToPick, object: nil)
            } label: {
                StatPill(emoji: "🍽", value: "\(viewModel.weeklyCount)", label: "picks")
            }
            .buttonStyle(.plain)

            Button {
                // Fires the existing `.switchToMyList` bus that the outer
                // TabView listens for (see HomeView body). No tab-coupling
                // plumbed through the viewmodel for this one-off.
                NotificationCenter.default.post(name: .switchToMyList, object: nil)
            } label: {
                StatPill(emoji: "📍", value: "\(customListVM.restaurants.count)", label: "saved")
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal)
    }

    /// Tint the UITabBar with the same cream wash as Home + My List. We used
    /// to make the bar fully transparent so the gradient bled through, but
    /// that left scrolled content visible *behind* the icons (the stats pills
    /// "🍽 N picks" and "📍 N saved" overlapped the Home / My List icons on
    /// the simulator). An opaque cream fill keeps the bar visually unified
    /// with the page while occluding the scroll content cleanly.
    private static func configureTabBarAppearance() {
        let appearance = UITabBarAppearance()
        appearance.configureWithOpaqueBackground()
        appearance.backgroundColor = UIColor { trait in
            trait.userInterfaceStyle == .dark
                ? UIColor(red: 0.12, green: 0.07, blue: 0.04, alpha: 1.0)
                : UIColor(red: 1.00, green: 0.94, blue: 0.85, alpha: 1.0)   // cream #FFF0D9
        }
        appearance.shadowColor = .clear   // drop the default 1pt top hairline
        UITabBar.appearance().standardAppearance = appearance
        UITabBar.appearance().scrollEdgeAppearance = appearance

        // Fraunces on navigation bar titles (inline + large) so screens like
        // "This week" and "My List" inherit the warm serif headline.
        let nav = UINavigationBarAppearance()
        nav.configureWithTransparentBackground()
        if let inlineFont = UIFont(name: "Fraunces", size: 24) {
            nav.titleTextAttributes = [
                .font: inlineFont,
                .foregroundColor: UIColor.label,
            ]
        }
        if let largeFont = UIFont(name: "Fraunces", size: 34) {
            nav.largeTitleTextAttributes = [
                .font: largeFont,
                .foregroundColor: UIColor.label,
            ]
        }
        UINavigationBar.appearance().standardAppearance = nav
        UINavigationBar.appearance().scrollEdgeAppearance = nav
        UINavigationBar.appearance().compactAppearance = nav
    }
}

// MARK: - App-wide warm background palette (shared by Home + My List)

extension Color {
    /// Reserved for future accent use — Home / My List / Welcome use a flat
    /// `homeBgMid` cream wash now via `WarmGradientBackground`.
    static let homeBgTop = Color(UIColor { trait in
        trait.userInterfaceStyle == .dark
            ? UIColor(red: 0.18, green: 0.09, blue: 0.05, alpha: 1.0)
            : UIColor(red: 1.00, green: 0.87, blue: 0.73, alpha: 1.0)
    })
    /// Background wash used by Home, My List, and Welcome — a calm cream that
    /// reads as "warm" without competing with the cards layered on top.
    static let homeBgMid = Color(UIColor { trait in
        trait.userInterfaceStyle == .dark
            ? UIColor(red: 0.12, green: 0.07, blue: 0.04, alpha: 1.0)
            : UIColor(red: 1.00, green: 0.94, blue: 0.85, alpha: 1.0)   // cream #FFF0D9
    })
    /// Reserved for future accent use.
    static let homeBgBottom = Color(UIColor { trait in
        trait.userInterfaceStyle == .dark
            ? UIColor(red: 0.05, green: 0.03, blue: 0.02, alpha: 1.0)
            : UIColor(red: 1.00, green: 0.98, blue: 0.93, alpha: 1.0)
    })

    /// Detail-page gradient stops. **Warm peach** at the top picks up the
    /// orange chip family from Discovery, fading down through cream into
    /// **soft mint** at the bottom — a sunset-on-the-table palette that ties
    /// the detail view to both the Home cream and the Discovery mint.
    static let detailBgTop = Color(UIColor { trait in
        trait.userInterfaceStyle == .dark
            ? UIColor(red: 0.20, green: 0.10, blue: 0.05, alpha: 1.0)   // warm cocoa
            : UIColor(red: 1.00, green: 0.86, blue: 0.71, alpha: 1.0)   // warm peach #FFDBB5
    })
    static let detailBgMid = Color(UIColor { trait in
        trait.userInterfaceStyle == .dark
            ? UIColor(red: 0.10, green: 0.07, blue: 0.05, alpha: 1.0)
            : UIColor(red: 1.00, green: 0.95, blue: 0.87, alpha: 1.0)   // cream #FFF1DD
    })
    static let detailBgBottom = Color(UIColor { trait in
        trait.userInterfaceStyle == .dark
            ? UIColor(red: 0.06, green: 0.10, blue: 0.09, alpha: 1.0)
            : UIColor(red: 0.88, green: 0.95, blue: 0.92, alpha: 1.0)   // soft mint #E1F2EA
    })

    /// Shared warm hairline used across every "card-on-cream" surface — chips,
    /// quote panels, the inline Maps link, the address pill. Sienna-tinted at
    /// low opacity so cards still read as warm-family but have a defined edge
    /// against the cream wash. One token = one tweak when palette evolves.
    static let cardBorder = Color(UIColor { trait in
        trait.userInterfaceStyle == .dark
            ? UIColor(red: 0.55, green: 0.42, blue: 0.25, alpha: 0.45)
            : UIColor(red: 0.62, green: 0.42, blue: 0.18, alpha: 0.22)
    })

    /// Discovery-only gradient stops. **Soft mint** at the top so the orange
    /// peach cuisine chips in the Discovery filter row pop visually against
    /// a cool, food-friendly hue. Fades down into a near-white cream so the
    /// card photo and the swipe pills stay neutral.
    static let discoveryBgTop = Color(UIColor { trait in
        trait.userInterfaceStyle == .dark
            ? UIColor(red: 0.07, green: 0.13, blue: 0.12, alpha: 1.0)   // dark forest
            : UIColor(red: 0.85, green: 0.94, blue: 0.91, alpha: 1.0)   // soft mint #D9F0E8
    })
    static let discoveryBgBottom = Color(UIColor { trait in
        trait.userInterfaceStyle == .dark
            ? UIColor(red: 0.05, green: 0.06, blue: 0.06, alpha: 1.0)
            : UIColor(red: 1.00, green: 0.98, blue: 0.93, alpha: 1.0)   // near-white cream
    })
}

/// Shared warm wash used as the background on Home and My List. Flat fill of
/// the cream stop (`homeBgMid`) — the previous 3-stop gradient introduced a
/// visible seam that read as "weird"; a single calm cream is friendlier to
/// the cards layered on top.
struct WarmGradientBackground: View {
    var body: some View {
        Color.homeBgMid
    }
}

/// Discovery-only background — soft mint → cream gradient. The cool mint
/// top stop keeps the orange-tinted cuisine chips in the filter row visually
/// distinct from the page (they were blending into the cream wash).
struct DiscoveryGradientBackground: View {
    var body: some View {
        LinearGradient(
            colors: [.discoveryBgTop, .discoveryBgBottom],
            startPoint: .top,
            endPoint: .bottom
        )
    }
}

/// Restaurant detail background — peach → cream → soft mint, vibrant enough
/// to feel like an entry into the booking flow without competing with the
/// photo carousel at the top (which the gradient slips behind via
/// `ignoresSafeArea(edges: .top)` on the parent ScrollView).
struct DetailGradientBackground: View {
    var body: some View {
        LinearGradient(
            colors: [.detailBgTop, .detailBgMid, .detailBgBottom],
            startPoint: .top,
            endPoint: .bottom
        )
    }
}

// MARK: - Home pick card (Top Pick / New This Week / Hidden Gem row)

private struct HomePickCard: View {
    let pick: HomeViewModel.HomePick

    private var restaurant: WeeklyRestaurant { pick.restaurant }

    private var photoURL: URL? {
        (restaurant.photoUrls?.first ?? restaurant.photoUrl).flatMap(URL.init(string:))
    }

    private var platform: ReservationPlatform? {
        if restaurant.resyBookingUrl?.isEmpty == false { return .resy }
        if restaurant.opentableBookingUrl?.isEmpty == false { return .opentable }
        return nil
    }

    private var subtitle: String {
        [restaurant.cuisineType?.capitalized, restaurant.neighborhood]
            .compactMap { $0?.isEmpty == false ? $0 : nil }
            .joined(separator: " · ")
    }

    private var labelAccent: Color {
        switch pick.label {
        case .topPick:     return Color(red: 0.98, green: 0.48, blue: 0.10)   // orange
        case .newThisWeek: return Color(red: 0.20, green: 0.65, blue: 0.35)   // green
        case .hiddenGem:   return Color(red: 0.45, green: 0.20, blue: 0.95)   // purple
        }
    }

    var body: some View {
        HStack(spacing: 12) {
            CachedAsyncImage(url: photoURL) { phase in
                switch phase {
                case .success(let img): img.resizable().scaledToFill()
                case .failure, .empty:
                    Color(.systemGray5)
                        .overlay(Image(systemName: "fork.knife").foregroundColor(.secondary))
                @unknown default: Color(.systemGray5)
                }
            }
            .frame(width: 92, height: 92)
            .clipped()
            .clipShape(RoundedRectangle(cornerRadius: 12))

            VStack(alignment: .leading, spacing: 4) {
                Text(pick.label.rawValue)
                    .font(.caption2).fontWeight(.bold)
                    .kerning(0.8)
                    .foregroundColor(labelAccent)

                Text(restaurant.googleDisplayName ?? restaurant.restaurantName)
                    .font(.body).fontWeight(.medium)
                    .foregroundColor(.primary)
                    .lineLimit(1)

                if !subtitle.isEmpty {
                    Text(subtitle)
                        .font(.subheadline)
                        .foregroundColor(.secondary)
                        .lineLimit(1)
                }

                if let platform {
                    PlatformBadgeView(platform: platform)
                }
            }

            Spacer(minLength: 0)

            Image(systemName: "chevron.right")
                .font(.footnote).fontWeight(.semibold)
                .foregroundColor(.secondary.opacity(0.6))
        }
        .padding(10)
        .background(Color.homeBgBottom)
        .clipShape(RoundedRectangle(cornerRadius: 16))
        .shadow(color: .black.opacity(0.06), radius: 8, y: 2)
    }
}

// MARK: - Stat pill

private struct StatPill: View {
    let emoji: String
    let value: String
    let label: String

    var body: some View {
        HStack(spacing: 6) {
            Text(emoji).font(.caption)
            Text(value)
                .font(.subheadline).fontWeight(.bold)
            Text(label)
                .font(.caption2).foregroundColor(.secondary)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity)
        .background(Color(.systemGray6))
        .clipShape(RoundedRectangle(cornerRadius: 14))
    }
}

// MARK: - Hero card for confirmed booking

struct BookingHeroCard: View {
    let reservation: Reservation

    private let dayFormatter: DateFormatter = {
        let f = DateFormatter(); f.dateFormat = "EEEE, MMM d"; return f
    }()
    private let timeFormatter: DateFormatter = {
        let f = DateFormatter(); f.dateFormat = "h:mm a"; return f
    }()

    var body: some View {
        ZStack(alignment: .bottomLeading) {
            CachedAsyncImage(url: reservation.restaurantPhotoUrl) { phase in
                switch phase {
                case .success(let img):
                    img.resizable().scaledToFill()
                case .failure, .empty:
                    LinearGradient(
                        colors: [Color(red: 0.10, green: 0.80, blue: 0.50), Color(red: 0.05, green: 0.40, blue: 0.35)],
                        startPoint: .topLeading, endPoint: .bottomTrailing
                    )
                @unknown default:
                    Color(.systemGray3)
                }
            }
            .frame(height: 220)
            .clipped()

            LinearGradient(
                colors: [.clear, .black.opacity(0.75)],
                startPoint: .top, endPoint: .bottom
            )

            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 6) {
                    Text("✅")
                        .font(.caption)
                    Text("You're all set")
                        .font(.caption).fontWeight(.bold)
                        .foregroundColor(.green)
                    Spacer()
                    Image(systemName: "chevron.right")
                        .foregroundColor(.white.opacity(0.5))
                        .font(.caption2)
                }

                Text(reservation.restaurantName)
                    .font(.title3).fontWeight(.bold)
                    .foregroundColor(.white)
                    .lineLimit(1)

                HStack(spacing: 14) {
                    Label(dayFormatter.string(from: reservation.datetime), systemImage: "calendar")
                    Label(timeFormatter.string(from: reservation.datetime), systemImage: "clock")
                    Label("\(reservation.partySize)", systemImage: "person.2")
                }
                .font(.caption).foregroundColor(.white.opacity(0.85))
            }
            .padding(18)
        }
        .clipShape(RoundedRectangle(cornerRadius: 24))
        .shadow(color: .black.opacity(0.15), radius: 12, y: 6)
    }
}

// MARK: - Booking detail sheet

struct BookingDetailView: View {
    let reservation: Reservation
    @Environment(\.dismiss) private var dismiss

    private let formatter: DateFormatter = {
        let f = DateFormatter(); f.dateStyle = .full; f.timeStyle = .short; return f
    }()

    var body: some View {
        NavigationStack {
            VStack(spacing: 24) {
                Text("🎉").font(.system(size: 64))
                VStack(spacing: 8) {
                    Text(reservation.restaurantName).font(.title2).fontWeight(.bold)
                    Text(formatter.string(from: reservation.datetime))
                        .font(.subheadline).foregroundColor(.secondary)
                    Text("\(reservation.partySize) people")
                        .font(.subheadline).foregroundColor(.secondary)
                    if reservation.confirmationCode != "—" {
                        Text("Confirmation: \(reservation.confirmationCode)")
                            .font(.caption).foregroundColor(.secondary)
                    }
                }
                Spacer()
            }
            .padding(.top, 40)
            .navigationTitle("your reservation")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}

// MARK: - Discovery wrapper

struct DiscoveryWrapper: View {
    let session: WeeklySession
    let customList: [Restaurant]
    var initialNeighborhood: String? = nil

    @StateObject private var viewModel: DiscoveryViewModel

    init(session: WeeklySession, customList: [Restaurant], initialNeighborhood: String? = nil) {
        self.session = session
        self.customList = customList
        self.initialNeighborhood = initialNeighborhood
        _viewModel = StateObject(wrappedValue: DiscoveryViewModel(
            session: session,
            customList: customList,
            initialNeighborhood: initialNeighborhood
        ))
    }

    var body: some View {
        DiscoveryContainerView(viewModel: viewModel)
    }
}

// MARK: - Discovery container with neighborhood filter

struct DiscoveryContainerView: View {
    @ObservedObject var viewModel: DiscoveryViewModel
    @EnvironmentObject private var customListVM: CustomListViewModel

    var body: some View {
        VStack(spacing: 0) {
            // Filter rows container — absorbs stray taps so they can't leak
            // through to the card deck below, which has an onTapGesture that
            // opens the restaurant detail sheet. Designer pass: tighter
            // inter-row spacing (6 → 3) so the two filter rows read as a
            // single zone instead of two competing bands.
            VStack(spacing: 3) {
                // Cuisine filter row (light orange)
                if !viewModel.availableCuisines.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            CuisineChip(label: "All", isSelected: viewModel.selectedCuisine == nil) {
                                viewModel.selectedCuisine = nil
                            }
                            ForEach(viewModel.availableCuisines, id: \.self) { cuisine in
                                CuisineChip(label: viewModel.cuisineDisplayLabel(cuisine),
                                            isSelected: viewModel.selectedCuisine == cuisine) {
                                    viewModel.selectedCuisine = cuisine
                                }
                            }
                        }
                        .padding(.horizontal)
                    }
                }

                // Borough filter row
                if !viewModel.availableBoroughs.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            FilterChip(label: "All", isSelected: viewModel.selectedBorough == nil) {
                                withAnimation(.spring(response: 0.35, dampingFraction: 0.8)) {
                                    viewModel.selectBorough(nil)
                                }
                            }
                            ForEach(viewModel.availableBoroughs, id: \.self) { borough in
                                FilterChip(label: borough.firstLetterCapitalized, isSelected: viewModel.selectedBorough == borough) {
                                    withAnimation(.spring(response: 0.35, dampingFraction: 0.8)) {
                                        viewModel.selectBorough(borough)
                                    }
                                }
                            }
                        }
                        .padding(.horizontal)
                    }
                }

                // Neighborhood sub-row (animated reveal). Multi-select — tap
                // multiple chips to include several neighborhoods; tap "All" to clear.
                if viewModel.selectedBorough != nil && !viewModel.availableNeighborhoods.isEmpty {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            NeighborhoodChip(label: "All", isSelected: viewModel.selectedNeighborhoods.isEmpty) {
                                viewModel.clearNeighborhoods()
                            }
                            ForEach(viewModel.availableNeighborhoods, id: \.self) { hood in
                                NeighborhoodChip(
                                    label: hood.firstLetterCapitalized,
                                    isSelected: viewModel.selectedNeighborhoods.contains(hood)
                                ) {
                                    viewModel.toggleNeighborhood(hood)
                                }
                            }
                        }
                        .padding(.horizontal)
                    }
                    .transition(.asymmetric(
                        insertion: .opacity.combined(with: .move(edge: .top)).combined(with: .scale(scale: 0.96, anchor: .top)),
                        removal: .opacity.combined(with: .move(edge: .top))
                    ))
                }
            }
            .padding(.top, 3)
            .padding(.bottom, 14)
            .frame(maxWidth: .infinity)
            // Filter row sits over the warm wash too — `Color.clear` lets the
            // page background show through; `contentShape(Rectangle())` keeps
            // the tap-absorb working without an opaque fill.
            .background(Color.clear)
            .contentShape(Rectangle())
            .onTapGesture { /* absorb stray taps so they don't leak to card */ }
            .zIndex(1)

            CardDeckView(viewModel: viewModel)
        }
        .background(WarmGradientBackground().ignoresSafeArea())
        .navigationTitle("This week")
        // Inline mode keeps the chips and card deck at their original Y
        // position. The bigger font size for "This week" comes from the
        // global UINavigationBar.appearance() inline-title config in
        // `HomeView.configureTabBarAppearance` — bumped from 17pt to 24pt
        // so the title reads as a proper page header without a `.large`
        // mode that would push the rest of the content down.
        .navigationBarTitleDisplayMode(.inline)
        .sheet(item: $viewModel.likedRestaurant) { restaurant in
            NavigationStack {
                RestaurantDetailView(restaurant: restaurant)
                    .environmentObject(customListVM)
            }
        }
    }
}

// MARK: - Filter chip (borough row — bold purple when selected, high contrast)

private struct FilterChip: View {
    let label: String
    let isSelected: Bool
    let action: () -> Void

    // Bold solid purple — distinct from cuisine (orange) and neighborhood (blue).
    private static let selectedFill = Color(red: 0.45, green: 0.20, blue: 0.95)

    var body: some View {
        Button(action: action) {
            Text(label)
                .font(.caption).fontWeight(.bold)
                .foregroundColor(isSelected ? .white : .primary)
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
                .background(isSelected ? Self.selectedFill : Color(.systemBackground))
                .clipShape(Capsule())
                .overlay(
                    Capsule()
                        .stroke(isSelected ? Self.selectedFill : Color.cardBorder,
                                lineWidth: 1)
                )
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Cuisine chip (light orange unselected, bold solid orange when selected)

private struct CuisineChip: View {
    let label: String
    let isSelected: Bool
    let action: () -> Void

    private static let boldOrange = Color(red: 0.98, green: 0.48, blue: 0.10)
    private static let orangeText = Color(red: 0.75, green: 0.38, blue: 0.05)
    private static let orangeBorder = Color(red: 0.98, green: 0.48, blue: 0.10).opacity(0.55)

    var body: some View {
        Button(action: action) {
            Text(label)
                .font(.caption).fontWeight(.bold)
                .foregroundColor(isSelected ? .white : Self.orangeText)
                .padding(.horizontal, 14)
                .padding(.vertical, 7)
                .frame(minWidth: 44)
                .background(isSelected ? Self.boldOrange : Color(.systemBackground))
                .clipShape(Capsule())
                .overlay(
                    Capsule()
                        .stroke(isSelected ? Self.boldOrange : Self.orangeBorder,
                                lineWidth: 1.2)
                )
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Neighborhood chip (sub-row under borough)

private struct NeighborhoodChip: View {
    let label: String
    let isSelected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(label)
                .font(.caption2).fontWeight(.medium)
                .foregroundColor(isSelected ? .white : .secondary)
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(
                    isSelected
                        ? AnyShapeStyle(Color.accentColor.opacity(0.85))
                        : AnyShapeStyle(Color(.systemBackground))
                )
                .overlay(
                    Capsule()
                        .stroke(isSelected ? Color.clear : Color.cardBorder, lineWidth: 1)
                )
                .clipShape(Capsule())
                .shadow(color: isSelected ? Color.accentColor.opacity(0.30) : .black.opacity(0.04),
                        radius: isSelected ? 3 : 1, y: isSelected ? 1.5 : 0.5)
        }
        .buttonStyle(.plain)
    }
}
