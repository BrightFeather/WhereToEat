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
    @State private var cameraPosition: MapCameraPosition = .region(Self.nycRegion)
    @State private var presentedRestaurant: WeeklyRestaurant? = nil
    @State private var panelFraction: CGFloat = 0.45

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

/// Red circle pin, white border, drop shadow — visually consistent with the
/// reference designs (Resy / OpenTable). Selected state grows + adds an
/// orange glow ring.
private struct FindMapMarker: View {
    let isSelected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Circle()
                .fill(Color(red: 0.95, green: 0.20, blue: 0.20))
                .frame(width: isSelected ? 22 : 16, height: isSelected ? 22 : 16)
                .overlay(
                    Circle().stroke(Color.white, lineWidth: 2)
                )
                .shadow(color: .black.opacity(0.25), radius: 3, y: 1.5)
                .overlay(
                    Circle()
                        .stroke(Color.orange.opacity(isSelected ? 0.55 : 0), lineWidth: 4)
                        .frame(width: 36, height: 36)
                )
                .animation(.spring(response: 0.3, dampingFraction: 0.7), value: isSelected)
        }
        .buttonStyle(.plain)
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
            Text(headerLabel)
                .font(.fraunces(.title3, weight: .semibold))
                .padding(.horizontal, 16)
                .padding(.top, 4)
                .padding(.bottom, 6)

            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(viewModel.filtered) { r in
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

    private var headerLabel: String {
        let n = viewModel.resultCount
        if let cuisine = viewModel.selectedCuisine {
            return "\(n) \(viewModel.cuisineDisplayLabel(cuisine)) restaurant\(n == 1 ? "" : "s")"
        }
        return "\(n) restaurant\(n == 1 ? "" : "s")"
    }
}
