import SwiftUI
import MapKit

/// Map-of-NYC + bottom-panel list of restaurants in this week's deck.
///
/// Composition (top → bottom, in a single ZStack so the parent TabView's
/// tab bar stays visible — we deliberately avoid `.sheet` for the panel
/// because a permanent sheet covers the tab bar AND blocks `.sheet(item:)`
/// from ever firing for the detail view):
///   1. Full-bleed `Map` with a pin per restaurant that has lat/lng coords.
///   2. Floating cuisine chip row + (optional) "no map locations" banner.
///   3. Bottom panel pinned to the bottom safe area inset, draggable
///      between peek (15%) / medium (45%) / large (75%) of screen height.
///
/// Data flows in from `WeeklyRestaurantService` (the same cache Home + Discovery
/// already use), so opening Find doesn't kick off a duplicate fetch.
struct FindView: View {
    @StateObject private var viewModel = FindViewModel()
    @EnvironmentObject private var customListVM: CustomListViewModel
    @EnvironmentObject private var locationService: LocationService
    @State private var cameraPosition: MapCameraPosition = .region(Self.nycRegion)
    @State private var presentedRestaurant: WeeklyRestaurant? = nil
    @State private var panelFraction: CGFloat = 0.45
    /// Set on first appear so we don't keep snapping back to the user's
    /// location every time the tab is re-entered. Subsequent visits respect
    /// whatever camera the user left behind.
    @State private var didApplyInitialCenter: Bool = false

    /// Initial span when centering on the user — covers ~1 mile in each
    /// direction, which gives ~10–30 visible pins in dense NYC and reads as
    /// "near you" rather than "all of Manhattan".
    private static let initialNearbySpan = MKCoordinateSpan(
        latitudeDelta: 0.018,
        longitudeDelta: 0.018
    )

    private static let nycRegion = MKCoordinateRegion(
        center: CLLocationCoordinate2D(latitude: 40.7308, longitude: -73.9973),
        span: MKCoordinateSpan(latitudeDelta: 0.10, longitudeDelta: 0.08)
    )

    var body: some View {
        GeometryReader { geo in
            ZStack {
                mapLayer

                VStack(spacing: 8) {
                    cuisineChipRow
                    if shouldShowNoCoordsBanner {
                        noCoordsBanner
                            .padding(.horizontal, 16)
                            .transition(.opacity.combined(with: .move(edge: .top)))
                    }
                    Spacer(minLength: 0)
                }

                VStack(spacing: 0) {
                    Spacer(minLength: 0)
                    // Recenter-on-user FAB — bottom-right, sits just above
                    // the bottom panel. Hidden when we don't have a fix yet
                    // (no point pretending to recenter to nowhere).
                    if locationService.currentLocation != nil {
                        HStack {
                            Spacer()
                            recenterButton
                                .padding(.trailing, 16)
                                .padding(.bottom, 12)
                        }
                    }
                    bottomPanel
                        .frame(height: max(140, geo.size.height * panelFraction))
                }
            }
            .animation(.spring(response: 0.35, dampingFraction: 0.85), value: panelFraction)
        }
        .sheet(item: $presentedRestaurant) { weekly in
            NavigationStack {
                RestaurantDetailView(restaurant: weekly.toRestaurant())
                    .environmentObject(customListVM)
            }
        }
        .onAppear { applyInitialCenterIfNeeded() }
        // `CLLocationCoordinate2D` isn't Equatable, so we observe a derived
        // Bool ("do we have a fix at all?") instead. The first fix flips it
        // false → true, which lets us snap-to-user once after a late GPS read.
        .onChange(of: locationService.currentLocation != nil) { _, hasFix in
            if hasFix { applyInitialCenterIfNeeded() }
        }
    }

    /// Center on the user's current location with a tight "nearby" span the
    /// first time we have one. After that the user controls the camera.
    /// If we don't have GPS yet, still seed `visibleRegion` from the default
    /// NYC frame so the initial render is already region-clipped (otherwise
    /// `mappable` returns every coord-bearing row and the user sees the same
    /// dot-storm we're trying to avoid).
    private func applyInitialCenterIfNeeded() {
        if viewModel.visibleRegion == nil {
            viewModel.visibleRegion = Self.nycRegion
        }
        guard !didApplyInitialCenter else { return }
        guard let userCoord = locationService.currentLocation else { return }
        let region = MKCoordinateRegion(center: userCoord, span: Self.initialNearbySpan)
        cameraPosition = .region(region)
        viewModel.visibleRegion = region
        didApplyInitialCenter = true
    }

    // MARK: - Map layer

    private var mapLayer: some View {
        Map(position: $cameraPosition, selection: Binding(
            get: { viewModel.selectedRestaurantId },
            set: { viewModel.selectedRestaurantId = $0 }
        )) {
            ForEach(viewModel.mappable) { r in
                let coord = CLLocationCoordinate2D(
                    latitude: r.latitude ?? 0,
                    longitude: r.longitude ?? 0
                )
                Annotation(
                    r.googleDisplayName ?? r.restaurantName,
                    coordinate: coord,
                    anchor: .bottom
                ) {
                    FindMapMarker(
                        isSelected: viewModel.selectedRestaurantId == r.id
                    ) {
                        viewModel.select(r)
                        centerOn(r)
                    }
                }
                .tag(r.id)
            }
        }
        .mapStyle(.standard(elevation: .flat, pointsOfInterest: .excludingAll))
        .mapControls {
            MapCompass()
        }
        // Whenever the user finishes a pan/zoom the visible bbox advances.
        // FindViewModel uses this to clip both the pin set and the bottom
        // list — fewer dots when zoomed in, more as you zoom out. We use
        // `.onEnd` (not `.continuous`) to skip the per-frame churn during
        // a gesture; the dataset (~580 rows) recomputes instantly on release.
        .onMapCameraChange(frequency: .onEnd) { context in
            viewModel.visibleRegion = context.region
        }
    }

    // MARK: - Cuisine chip row (floating over the map, top)

    /// Container exactly mirrors the Pick page's row in
    /// `HomeView.swift → DiscoveryContainerView` so the two tabs read
    /// identically: same `.padding(.horizontal)` (default 16), no extra
    /// vertical padding, no `.ultraThinMaterial` wash. The chips' own
    /// `Color(.systemBackground)` fill plus orange border keep them
    /// legible over the map without the frosted backdrop.
    private var cuisineChipRow: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                FindCuisineChip(label: "All", isSelected: viewModel.selectedCuisine == nil) {
                    viewModel.selectCuisine(nil)
                }
                ForEach(viewModel.availableCuisines, id: \.self) { c in
                    FindCuisineChip(
                        label: viewModel.cuisineDisplayLabel(c),
                        isSelected: viewModel.selectedCuisine == c
                    ) {
                        viewModel.selectCuisine(viewModel.selectedCuisine == c ? nil : c)
                    }
                }
            }
            .padding(.horizontal)
            .padding(.vertical, 6)
        }
    }

    // MARK: - "No map locations" banner

    /// Shown when the current cuisine filter has rows but none of them have
    /// `latitude`/`longitude` (typically restaurants that never matched a
    /// Google Place, so there's no `google_place_id` to backfill against).
    /// The list below is still useful — the banner just makes the empty
    /// map non-mysterious.
    private var shouldShowNoCoordsBanner: Bool {
        viewModel.filtered.isEmpty == false && viewModel.mappable.isEmpty
    }

    private var noCoordsBanner: some View {
        HStack(spacing: 8) {
            Image(systemName: "mappin.slash")
                .foregroundColor(.orange)
            Text("No map locations for these results — see list below.")
                .font(.footnote).fontWeight(.medium)
                .foregroundColor(.primary)
            Spacer()
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(Color(.systemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .stroke(Color.cardBorder, lineWidth: 1)
        )
        .shadow(color: .black.opacity(0.10), radius: 6, y: 3)
    }

    // MARK: - Bottom panel (replaces the previous `.sheet`)

    private var bottomPanel: some View {
        VStack(spacing: 0) {
            // Drag handle — taps cycle peek → medium → large → peek;
            // vertical drags step a single notch in the gesture direction.
            Capsule()
                .fill(Color.gray.opacity(0.4))
                .frame(width: 40, height: 5)
                .padding(.top, 8)
                .padding(.bottom, 6)
                .frame(maxWidth: .infinity)
                .contentShape(Rectangle())
                .onTapGesture { cyclePanel() }
                .gesture(
                    DragGesture()
                        .onEnded { value in
                            if value.translation.height < -30 { expandPanel() }
                            else if value.translation.height > 30 { collapsePanel() }
                        }
                )

            FindSheetContent(
                viewModel: viewModel,
                onOpen: { r in
                    viewModel.select(r)
                    centerOn(r)
                    presentedRestaurant = r
                }
            )
        }
        .background(Color.homeBgMid)
        .clipShape(
            UnevenRoundedRectangle(
                topLeadingRadius: 18,
                bottomLeadingRadius: 0,
                bottomTrailingRadius: 0,
                topTrailingRadius: 18,
                style: .continuous
            )
        )
        .shadow(color: .black.opacity(0.18), radius: 10, y: -3)
        // iOS 26 renders the TabView's tab bar as a floating capsule that
        // sits OVER the bottom safe-area inset. FindView's mapLayer also
        // extends into that inset, so without this trailing background the
        // map terrain shows around the tab bar capsule. We extend the
        // panel's cream colour past the safe-area edge — placed AFTER the
        // clipShape so the rounded top corners stay sharp while the bottom
        // edge bleeds down to the screen edge.
        .background(
            Color.homeBgMid
                .ignoresSafeArea(.container, edges: .bottom)
        )
    }

    // MARK: - Recenter FAB

    /// Floating action button — taps recenter the camera on the user's
    /// current location with the same tight "nearby" span used on first
    /// load. Visible only while we have a CoreLocation fix.
    private var recenterButton: some View {
        Button(action: recenterOnUser) {
            Image(systemName: "location.fill")
                .font(.system(size: 17, weight: .semibold))
                .foregroundColor(.accentColor)
                .frame(width: 44, height: 44)
                .background(Color(.systemBackground))
                .clipShape(Circle())
                .overlay(
                    Circle().stroke(Color.cardBorder, lineWidth: 1)
                )
                .shadow(color: .black.opacity(0.18), radius: 5, y: 2)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Recenter on my location")
    }

    private func recenterOnUser() {
        guard let userCoord = locationService.currentLocation else { return }
        let region = MKCoordinateRegion(center: userCoord, span: Self.initialNearbySpan)
        withAnimation(.easeInOut(duration: 0.35)) {
            cameraPosition = .region(region)
        }
        viewModel.visibleRegion = region
    }

    // MARK: - Map camera

    private func centerOn(_ r: WeeklyRestaurant) {
        guard let lat = r.latitude, let lon = r.longitude, lat != 0, lon != 0 else { return }
        withAnimation(.easeInOut(duration: 0.35)) {
            cameraPosition = .region(MKCoordinateRegion(
                center: CLLocationCoordinate2D(latitude: lat, longitude: lon),
                span: MKCoordinateSpan(latitudeDelta: 0.012, longitudeDelta: 0.012)
            ))
        }
    }

    // MARK: - Panel sizing

    private func cyclePanel() {
        switch panelFraction {
        case ..<0.30:  panelFraction = 0.45
        case ..<0.60:  panelFraction = 0.80
        default:       panelFraction = 0.15
        }
    }

    private func expandPanel() {
        if panelFraction < 0.30 { panelFraction = 0.45 }
        else if panelFraction < 0.60 { panelFraction = 0.80 }
    }

    private func collapsePanel() {
        if panelFraction > 0.60 { panelFraction = 0.45 }
        else if panelFraction > 0.30 { panelFraction = 0.15 }
    }
}

// MARK: - Map marker

/// Teardrop-style food marker: red circle with a white fork-and-knife icon,
/// a subtle highlight gradient, and a small pointer underneath so it reads
/// as a pin rather than a generic dot. Selected state grows, brightens, and
/// adds an orange glow ring.
private struct FindMapMarker: View {
    let isSelected: Bool
    let action: () -> Void

    private static let baseRed = Color(red: 0.95, green: 0.20, blue: 0.20)
    private static let highlightRed = Color(red: 1.00, green: 0.36, blue: 0.36)

    var body: some View {
        Button(action: action) {
            VStack(spacing: -2) {
                ZStack {
                    Circle()
                        .fill(
                            LinearGradient(
                                colors: [Self.highlightRed, Self.baseRed],
                                startPoint: .topLeading,
                                endPoint: .bottomTrailing
                            )
                        )
                        .frame(width: isSelected ? 30 : 22, height: isSelected ? 30 : 22)
                        .overlay(Circle().stroke(Color.white, lineWidth: 2))
                        .shadow(color: .black.opacity(0.30), radius: 3, y: 1.5)

                    Image(systemName: "fork.knife")
                        .font(.system(size: isSelected ? 13 : 10, weight: .bold))
                        .foregroundColor(.white)
                }
                // Pointer triangle under the circle.
                Triangle()
                    .fill(Self.baseRed)
                    .frame(width: isSelected ? 10 : 8, height: isSelected ? 7 : 5)
                    .shadow(color: .black.opacity(0.20), radius: 1.5, y: 1)
            }
            .overlay(
                // Selection glow ring (only visible when selected).
                Circle()
                    .stroke(Color.orange.opacity(isSelected ? 0.55 : 0), lineWidth: 4)
                    .frame(width: 44, height: 44)
                    .offset(y: -2)   // align with the circle, not the pointer
            )
            .animation(.spring(response: 0.3, dampingFraction: 0.7), value: isSelected)
        }
        .buttonStyle(.plain)
    }
}

/// Downward-pointing equilateral triangle for the pin's pointer.
private struct Triangle: Shape {
    func path(in rect: CGRect) -> Path {
        var p = Path()
        p.move(to: CGPoint(x: rect.midX, y: rect.maxY))
        p.addLine(to: CGPoint(x: rect.minX, y: rect.minY))
        p.addLine(to: CGPoint(x: rect.maxX, y: rect.minY))
        p.closeSubpath()
        return p
    }
}

// MARK: - Local cuisine chip (over map)

/// Visual twin of the Discovery / Pick page's `CuisineChip` — same orange
/// palette, same padding, same selected-state shadow. Kept as a separate
/// type only because `CuisineChip` is `private` to `HomeView.swift`; the
/// styling rules below are an exact copy so the two tabs read identically.
/// If the Pick chip changes, mirror the change here.
private struct FindCuisineChip: View {
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
                                lineWidth: isSelected ? 2 : 1.2)
                )
                .shadow(color: isSelected ? Self.boldOrange.opacity(0.35) : .black.opacity(0.05),
                        radius: isSelected ? 4 : 1.5,
                        y: isSelected ? 2 : 1)
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Bottom panel content

private struct FindSheetContent: View {
    @ObservedObject var viewModel: FindViewModel
    let onOpen: (WeeklyRestaurant) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            FindSearchBar(text: $viewModel.searchQuery)
                .padding(.horizontal, 16)
                .padding(.top, 6)
                .padding(.bottom, 8)

            Text(headerLabel)
                .font(.fraunces(.title3, weight: .semibold))
                .padding(.horizontal, 16)
                .padding(.top, 2)
                .padding(.bottom, 6)

            // Empty state when search yields nothing — replaces the list,
            // doesn't crowd it. Cleared by the X inside the search field.
            if viewModel.hasSearch && viewModel.visibleFiltered.isEmpty {
                searchEmptyState
            } else {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(spacing: 0) {
                            ForEach(viewModel.visibleFiltered) { r in
                                FindRestaurantRowView(
                                    restaurant: r,
                                    excerpt: viewModel.excerpt(for: r),
                                    isSelected: viewModel.selectedRestaurantId == r.id,
                                    onOpen: { onOpen(r) }
                                )
                                .id(r.id)
                                Divider().padding(.leading, 16)
                            }
                        }
                        .padding(.bottom, 20)
                    }
                    .onChange(of: viewModel.selectedRestaurantId) { _, newId in
                        guard let id = newId else { return }
                        withAnimation(.easeInOut(duration: 0.25)) {
                            proxy.scrollTo(id, anchor: .top)
                        }
                    }
                }
            }
        }
    }

    private var searchEmptyState: some View {
        VStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 32))
                .foregroundColor(.secondary)
            Text("No matches for \u{201C}\(viewModel.searchQuery.trimmingCharacters(in: .whitespacesAndNewlines))\u{201D}")
                .font(.subheadline).fontWeight(.semibold)
                .foregroundColor(.primary)
                .multilineTextAlignment(.center)
            Text("Try a different keyword, neighborhood, or cuisine.")
                .font(.caption)
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding(.horizontal, 32)
        .padding(.top, 28)
        .padding(.bottom, 16)
        .frame(maxWidth: .infinity)
    }

    private var headerLabel: String {
        let n = viewModel.resultCount
        let qualifier: String
        if viewModel.hasSearch {
            qualifier = "matching"
        } else if let cuisine = viewModel.selectedCuisine {
            qualifier = viewModel.cuisineDisplayLabel(cuisine)
        } else {
            qualifier = ""
        }
        let suffix = n == 1 ? "" : "s"
        return qualifier.isEmpty
            ? "\(n) restaurant\(suffix)"
            : "\(n) \(qualifier) restaurant\(suffix)"
    }
}

// MARK: - Search bar (top of bottom panel)

/// Capsule TextField with a leading magnifying-glass icon and a trailing
/// clear (X) button that appears once the user types. Visual language
/// matches the cuisine chip + map markers — cream `systemBackground`
/// fill, thin `cardBorder` stroke, no shadow.
private struct FindSearchBar: View {
    @Binding var text: String
    /// Drives keyboard focus so the "Done" key above the keyboard can
    /// dismiss it without forcing the user to hit Search. Tracking via
    /// `@FocusState` is the supported way to programmatically resign first
    /// responder in pure SwiftUI (no UIKit responder-chain hop needed).
    @FocusState private var isFocused: Bool

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .font(.subheadline)
                .foregroundColor(.secondary)

            TextField("Search restaurants, cuisines, neighborhoods", text: $text)
                .textFieldStyle(.plain)
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
                .submitLabel(.search)
                .focused($isFocused)
                .toolbar {
                    // Adds a "Done" button to the keyboard's input accessory
                    // bar. Trailing Spacer pushes it to the right edge —
                    // standard iOS pattern. Tap → resigns first responder
                    // and the keyboard slides away.
                    ToolbarItemGroup(placement: .keyboard) {
                        Spacer()
                        Button("Done") { isFocused = false }
                            .fontWeight(.semibold)
                    }
                }

            if !text.isEmpty {
                Button {
                    text = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.subheadline)
                        .foregroundColor(.secondary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Clear search")
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(Color(.systemBackground))
        .clipShape(Capsule())
        .overlay(
            Capsule().stroke(Color.cardBorder, lineWidth: 1)
        )
    }
}
