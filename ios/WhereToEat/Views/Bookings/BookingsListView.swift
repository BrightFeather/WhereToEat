import SwiftUI

/// List of all reservations the user has saved. Accessed via a top-right
/// toolbar button on the Home screen.
struct BookingsListView: View {
    @EnvironmentObject private var customListVM: CustomListViewModel
    @State private var reservations: [Reservation] = []
    /// Stashed on swipe-to-cancel so we can confirm before actually cancelling.
    /// Using the reservation itself (not its id) keeps the alert message
    /// correct even if `reservations` is mutated before the alert resolves.
    @State private var pendingRemoval: Reservation?
    /// Brief toast shown after swipe-left → add to list. nil = hidden.
    @State private var toast: String?

    private let dayFormatter: DateFormatter = {
        let f = DateFormatter(); f.dateFormat = "EEE, MMM d"; return f
    }()
    private let timeFormatter: DateFormatter = {
        let f = DateFormatter(); f.dateFormat = "h:mm a"; return f
    }()

    var body: some View {
        ZStack(alignment: .bottom) {
            Group {
                if reservations.isEmpty {
                    emptyState
                } else {
                    list
                }
            }

            if let toast {
                Text(toast)
                    .font(.subheadline).fontWeight(.semibold)
                    .foregroundColor(.white)
                    .padding(.horizontal, 18)
                    .padding(.vertical, 10)
                    .background(.black.opacity(0.85))
                    .clipShape(Capsule())
                    .padding(.bottom, 24)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .animation(.easeInOut(duration: 0.2), value: toast)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(WarmGradientBackground().ignoresSafeArea())
        .navigationTitle("My Bookings")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear(perform: reload)
        .onReceive(NotificationCenter.default.publisher(for: .weeklySessionUpdated)) { _ in
            reload()
        }
    }

    private var list: some View {
        List {
            ForEach(groupedSections, id: \.title) { section in
                Section(section.title) {
                    ForEach(section.items) { reservation in
                        BookingRow(
                            reservation: reservation,
                            day: dayFormatter.string(from: reservation.datetime),
                            time: timeFormatter.string(from: reservation.datetime)
                        )
                        .listRowBackground(Color.homeBgBottom)
                        .swipeActions(edge: .leading, allowsFullSwipe: false) {
                            Button(role: .destructive) {
                                pendingRemoval = reservation
                            } label: {
                                Label("Cancel", systemImage: "trash")
                            }
                            .tint(.red)
                        }
                        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                            Button {
                                addToList(reservation)
                            } label: {
                                Label("Save", systemImage: "bookmark.fill")
                            }
                            .tint(.accentColor)
                        }
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(WarmGradientBackground().ignoresSafeArea())
        .alert(
            "Remove this reservation?",
            isPresented: Binding(
                get: { pendingRemoval != nil },
                set: { if !$0 { pendingRemoval = nil } }
            ),
            presenting: pendingRemoval
        ) { reservation in
            Button("Remove", role: .destructive) { remove(reservation) }
            Button("Keep", role: .cancel) { pendingRemoval = nil }
        } message: { reservation in
            Text(cancelMessage(for: reservation))
        }
    }

    /// Swipe-left → save the reservation's restaurant to the user's list.
    ///
    /// Reservations only carry a slim subset of restaurant fields (id, name,
    /// photo, platform). Whenever possible we hydrate from the in-memory
    /// weekly cache so the saved row carries the full record (address,
    /// coordinates, XHS sources, website, IG, booking URL, etc.) — otherwise
    /// the user reopens the saved row and sees an almost-empty detail page.
    /// If the user already has the restaurant saved (by id), `addFromDiscovery`
    /// no-ops and we show "Already in your list" instead.
    private func addToList(_ reservation: Reservation) {
        let alreadySaved = customListVM.restaurants.contains { $0.id == reservation.restaurantId }
        if alreadySaved {
            showToast("Already in your list")
            return
        }

        // Try the weekly cache first — same id space (UUID).
        let restaurant: Restaurant
        if let weekly = lookupWeekly(restaurantId: reservation.restaurantId) {
            var hydrated = weekly.toRestaurant()
            hydrated.isCustom = true
            restaurant = hydrated
        } else {
            // Fallback: stub-from-reservation. Detail page will be sparse, but
            // at least the row + photo + booking platform render.
            var reservationSource: ReservationSource?
            switch reservation.platform {
            case .resy, .opentable, .tock:
                reservationSource = ReservationSource(platform: reservation.platform, venueId: "", directBookingURL: nil)
            case .other:
                reservationSource = nil
            }
            restaurant = Restaurant(
                id: reservation.restaurantId,
                name: reservation.restaurantName,
                address: "",
                coordinates: Coordinates(latitude: 0, longitude: 0),
                sourceOrigin: .custom,
                photos: reservation.restaurantPhotoUrl.map { [$0] } ?? [],
                reservationSource: reservationSource,
                isCustom: true
            )
        }

        customListVM.addFromDiscovery(restaurant)
        showToast("Saved to your list")
    }

    /// Look up a `WeeklyRestaurant` by id from whichever weekly status the
    /// service is currently exposing. Returns nil when the cache is empty
    /// or the id isn't in this week's deck.
    private func lookupWeekly(restaurantId: UUID) -> WeeklyRestaurant? {
        let target = restaurantId.uuidString
        let pool: [WeeklyRestaurant]
        switch WeeklyRestaurantService.shared.status {
        case .ready(let l), .stale(let l): pool = l
        default: return nil
        }
        // WeeklyRestaurant.id is a String (matches the backend UUID string).
        // Compare case-insensitive since UUID normalises to uppercase but the
        // backend may return lowercase.
        return pool.first { $0.id.caseInsensitiveCompare(target) == .orderedSame }
    }

    private func showToast(_ text: String) {
        toast = text
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.8) {
            if toast == text { toast = nil }
        }
    }

    /// Alert body: base sentence + platform nudge when the booking lives on a
    /// third-party (Resy/OpenTable) that enforces its own cancellation policy.
    /// Removing here only clears the local record and server-side mirror; it
    /// can't call Resy/OpenTable's cancel API, so the user has to do that.
    private func cancelMessage(for reservation: Reservation) -> String {
        let base = "\(reservation.restaurantName) on \(dayFormatter.string(from: reservation.datetime)) at \(timeFormatter.string(from: reservation.datetime)) will be cancelled."
        switch reservation.platform {
        case .resy, .opentable:
            return base + " You might still need to cancel the reservation on \(reservation.platform.displayName) to avoid cancellation fee."
        case .tock, .other:
            return base
        }
    }

    private func remove(_ reservation: Reservation) {
        // Optimistically drop from the local list so the row vanishes
        // immediately; ReservationService.cancelReservation handles the
        // session file, notification, calendar event, and backend delete.
        reservations.removeAll { $0.id == reservation.id }
        Task { await ReservationService.shared.cancelReservation(id: reservation.id) }
    }

    private var emptyState: some View {
        VStack(spacing: 16) {
            Spacer()
            Image(systemName: "calendar.badge.plus")
                .font(.system(size: 54))
                .foregroundColor(.secondary)
            Text("No bookings yet")
                .font(.title3).fontWeight(.semibold)
            Text("When you book a restaurant, it'll show up here.")
                .font(.subheadline)
                .foregroundColor(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 40)
            Spacer()
        }
    }

    private func reload() {
        // Aggregate across every saved weekly session — a booking for next
        // Saturday lives under next Monday's key, so loading just the current
        // week would hide it.
        reservations = WeeklySession.allReservations()
            .sorted { $0.datetime < $1.datetime }
    }

    private var groupedSections: [(title: String, items: [Reservation])] {
        let now = Date()
        let upcoming = reservations.filter { $0.datetime >= now && $0.status != .cancelled }
        let past = reservations.filter { $0.datetime < now || $0.status == .cancelled }
        var out: [(String, [Reservation])] = []
        if !upcoming.isEmpty { out.append(("Upcoming", upcoming)) }
        if !past.isEmpty { out.append(("Past", past.reversed())) }
        return out
    }
}

private struct BookingRow: View {
    let reservation: Reservation
    let day: String
    let time: String

    var body: some View {
        HStack(spacing: 12) {
            CachedAsyncImage(url: reservation.restaurantPhotoUrl) { phase in
                switch phase {
                case .success(let img):
                    img.resizable().scaledToFill()
                default:
                    Color(.systemGray5)
                        .overlay(Image(systemName: "fork.knife").foregroundColor(.secondary))
                }
            }
            .frame(width: 56, height: 56)
            .clipShape(RoundedRectangle(cornerRadius: 10))

            VStack(alignment: .leading, spacing: 4) {
                Text(reservation.restaurantName)
                    .font(.subheadline).fontWeight(.semibold)
                    .lineLimit(1)
                HStack(spacing: 6) {
                    Image(systemName: "calendar")
                        .font(.caption2).foregroundColor(.secondary)
                    Text("\(day) · \(time)")
                        .font(.caption).foregroundColor(.secondary)
                }
                HStack(spacing: 6) {
                    Image(systemName: "person.2")
                        .font(.caption2).foregroundColor(.secondary)
                    Text("\(reservation.partySize) people")
                        .font(.caption).foregroundColor(.secondary)
                    if reservation.status == .cancelled {
                        Text("· Cancelled")
                            .font(.caption).foregroundColor(.red)
                    }
                }
            }
            Spacer()
        }
        .padding(.vertical, 4)
    }
}

extension Notification.Name {
    static let weeklySessionUpdated = Notification.Name("weeklySessionUpdated")
}
