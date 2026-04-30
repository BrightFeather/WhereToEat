import Foundation
import Combine

final class CustomListViewModel: ObservableObject {
    @Published var restaurants: [Restaurant] = []
    // Single-restaurant import (Google Maps, Yelp, generic)
    @Published var importDraft: ImportedRestaurantDraft?
    // Multi-restaurant import (XHS)
    @Published var importDrafts: [ImportedRestaurantDraft] = []
    @Published var selectedDraftIndices: Set<Int> = []
    @Published var isImporting: Bool = false
    @Published var importError: String?
    @Published var showImportPreview: Bool = false
    @Published var showXhsImportPreview: Bool = false

    private let importService = CustomListImportService()
    private let storageKey = "custom_restaurant_list"
    private var weeklyCancellable: AnyCancellable?
    private var authCancellable: AnyCancellable?

    init() {
        load()
        // Pull the server-side favorites once on init and merge with the
        // local cache. Server is the cross-device source of truth; local
        // entries that the server didn't know about (e.g. saved while
        // offline or before this sync shipped) are pushed up by the merge.
        // Re-sync when the user signs in / signs out — the verified user id
        // changes, so the favorites set under it does too. AuthService is
        // `@MainActor`, so we have to hop onto the main actor before
        // touching its `$state` publisher (mirrors `weeklyCancellable` below).
        Task { @MainActor [weak self] in
            await self?.syncFromServer()
            self?.authCancellable = AuthService.shared.$state
                .dropFirst()
                .receive(on: DispatchQueue.main)
                .sink { [weak self] _ in
                    Task { await self?.syncFromServer() }
                }
        }

        NotificationCenter.default.addObserver(
            forName: .saveRestaurant,
            object: nil,
            queue: .main
        ) { [weak self] notification in
            guard let self, let restaurant = notification.object as? Restaurant else { return }
            self.addFromDiscovery(restaurant)
        }

        NotificationCenter.default.addObserver(
            forName: .snoozeRestaurant,
            object: nil,
            queue: .main
        ) { [weak self] notification in
            guard let self, let id = notification.object as? UUID else { return }
            guard let idx = self.restaurants.firstIndex(where: { $0.id == id }) else { return }
            self.restaurants[idx].snoozedUntil = Calendar.current.date(byAdding: .day, value: 30, to: Date())
            self.save()
        }

        // Whenever the weekly cache lands, fill in any sparse rows the user
        // saved from My Bookings (id + name + photo only). Matches by id.
        // `WeeklyRestaurantService` is @MainActor — hop the publisher subscription
        // onto the main actor before observing.
        Task { @MainActor [weak self] in
            self?.weeklyCancellable = WeeklyRestaurantService.shared.$status
                .receive(on: DispatchQueue.main)
                .sink { [weak self] status in
                    let weekly: [WeeklyRestaurant]
                    switch status {
                    case .ready(let l), .stale(let l): weekly = l
                    default: return
                    }
                    self?.hydrateSparseRows(from: weekly)
                }
        }
    }

    /// Replace rows that are missing core fields (no address, no XHS sources,
    /// no booking URL) with the richer record from the weekly cache when an id
    /// match is available. Preserves the user's `isCustom`, `notes`,
    /// `addedAt`, and `snoozedUntil`. No-op when nothing changes.
    private func hydrateSparseRows(from weekly: [WeeklyRestaurant]) {
        var changed = false
        for (idx, existing) in restaurants.enumerated() {
            let isSparse = existing.address.isEmpty
                && (existing.xhsSources?.isEmpty ?? true)
                && existing.bookingUrl == nil
                && existing.googlePlaceId == nil
            guard isSparse else { continue }
            guard let match = weekly.first(where: {
                $0.id.caseInsensitiveCompare(existing.id.uuidString) == .orderedSame
            }) else { continue }
            var hydrated = match.toRestaurant()
            hydrated.id = existing.id
            hydrated.isCustom = true
            hydrated.notes = existing.notes
            hydrated.snoozedUntil = existing.snoozedUntil
            hydrated.addedAt = existing.addedAt
            restaurants[idx] = hydrated
            changed = true
        }
        if changed { save() }
    }

    func addFromDiscovery(_ restaurant: Restaurant) {
        let alreadyExists = restaurants.contains { existing in
            existing.id == restaurant.id ||
            (restaurant.googlePlaceId != nil && existing.googlePlaceId == restaurant.googlePlaceId)
        }
        guard !alreadyExists else { return }
        var saved = restaurant
        saved.isCustom = true
        restaurants.insert(saved, at: 0)
        save()
        Task { await FavoritesService.shared.push(saved) }
    }

    // MARK: - Persistence

    func load() {
        guard let data = UserDefaults.standard.data(forKey: storageKey),
              let list = try? JSONDecoder().decode([Restaurant].self, from: data) else { return }
        restaurants = list
    }

    func save() {
        guard let data = try? JSONEncoder().encode(restaurants) else { return }
        UserDefaults.standard.set(data, forKey: storageKey)
    }

    // MARK: - Import flow

    func importURL(_ urlString: String) async {
        isImporting = true
        importError = nil
        do {
            let drafts = try await importService.importURL(urlString)
            if drafts.count == 1, drafts.first?.sourceLink.platform != .xiaohongshu {
                // Single-restaurant import (existing flow)
                importDraft = drafts.first
                showImportPreview = true
            } else {
                // Multi-restaurant import (XHS)
                importDrafts = drafts
                selectedDraftIndices = Set(drafts.indices)
                showXhsImportPreview = true
            }
        } catch {
            importError = error.localizedDescription
        }
        isImporting = false
    }

    func confirmImport(draft: ImportedRestaurantDraft, editedName: String, editedAddress: String, notes: String) {
        let coords = (draft.latitude != nil && draft.longitude != nil)
            ? Coordinates(latitude: draft.latitude!, longitude: draft.longitude!)
            : Coordinates(latitude: 0, longitude: 0)

        let restaurant = Restaurant(
            name: editedName,
            address: editedAddress,
            coordinates: coords,
            sourceOrigin: .custom,
            cuisineTags: draft.cuisineTags,
            photos: draft.photos,
            rating: draft.rating,
            sourceLinks: [draft.sourceLink],
            phone: draft.phone,
            website: draft.website,
            isCustom: true,
            notes: notes.isEmpty ? nil : notes
        )

        let pushed: Restaurant
        if let existingIdx = restaurants.firstIndex(where: {
            normalize($0.name) == normalize(editedName) ||
            ($0.coordinates.latitude != 0 && distance($0.coordinates, coords) < 50)
        }) {
            var existing = restaurants[existingIdx]
            if !existing.sourceLinks.contains(where: { $0.url == draft.sourceLink.url }) {
                existing.sourceLinks.append(draft.sourceLink)
            }
            restaurants[existingIdx] = existing
            pushed = existing
        } else {
            restaurants.insert(restaurant, at: 0)
            pushed = restaurant
        }
        save()
        Task { await FavoritesService.shared.push(pushed) }
        importDraft = nil
        showImportPreview = false
    }

    func confirmXhsImport() {
        let beforeCount = restaurants.count
        for index in selectedDraftIndices.sorted() {
            guard index < importDrafts.count else { continue }
            let draft = importDrafts[index]
            addRestaurantFromDraft(draft)
        }
        save()
        // Push every newly-inserted row to the server. `addRestaurantFromDraft`
        // inserts at the front so the new ones are the prefix relative to
        // `beforeCount`. Skipped rows (dup `googlePlaceId`) don't appear here.
        let added = max(0, restaurants.count - beforeCount)
        let toPush = Array(restaurants.prefix(added))
        Task {
            for r in toPush {
                await FavoritesService.shared.push(r)
            }
        }
        importDrafts = []
        selectedDraftIndices = []
        showXhsImportPreview = false
    }

    private func addRestaurantFromDraft(_ draft: ImportedRestaurantDraft) {
        // Skip if already exists by Google Place ID
        if let placeId = draft.googlePlaceId,
           restaurants.contains(where: { $0.googlePlaceId == placeId }) {
            return
        }

        // Build booking URL: prefer Resy, then OpenTable, then website
        let bookingUrl = draft.resyBookingUrl ?? draft.opentableBookingUrl ?? draft.website

        // Build reservation source
        var reservationSource: ReservationSource?
        if let resyUrl = draft.resyBookingUrl {
            reservationSource = ReservationSource(platform: .resy, venueId: "", directBookingURL: resyUrl)
        } else if let otUrl = draft.opentableBookingUrl {
            reservationSource = ReservationSource(platform: .opentable, venueId: "", directBookingURL: otUrl)
        }

        // sourceLinks: one entry per XHS source so the detail-view multi-quote
        // carousel works on imported restaurants too. Fall back to the single
        // pasted link when the backend didn't populate `xhsSources`.
        let sourceLinks: [SourceLink]
        if let sources = draft.xhsSources, !sources.isEmpty {
            sourceLinks = sources.compactMap { src in
                URL(string: src.postUrl).map { SourceLink(platform: .xiaohongshu, url: $0) }
            }
        } else {
            sourceLinks = [draft.sourceLink]
        }

        let restaurant = Restaurant(
            name: draft.name,
            address: draft.address ?? "",
            coordinates: Coordinates(latitude: draft.latitude ?? 0, longitude: draft.longitude ?? 0),
            googleMapsLink: draft.googleMapsUrl,
            googlePlaceId: draft.googlePlaceId,
            bookingUrl: bookingUrl,
            sourceOrigin: .xhs,
            xhsRecommendation: draft.notes,
            cuisineTags: draft.cuisineTags,
            xhsSources: draft.xhsSources,
            photos: draft.photos,
            rating: draft.rating,
            reviewCount: draft.reviewCount,
            sourceLinks: sourceLinks,
            reservationSource: reservationSource,
            instagramUrl: draft.instagramUrl,
            website: draft.website,
            isCustom: true
        )

        restaurants.insert(restaurant, at: 0)
    }

    func cancelImport() {
        importDraft = nil
        importDrafts = []
        selectedDraftIndices = []
        showImportPreview = false
        showXhsImportPreview = false
        importError = nil
    }

    // MARK: - CRUD

    func delete(at offsets: IndexSet) {
        let removedIds = offsets.compactMap { idx -> UUID? in
            guard idx < restaurants.count else { return nil }
            return restaurants[idx].id
        }
        restaurants = restaurants.enumerated()
            .filter { !offsets.contains($0.offset) }
            .map(\.element)
        save()
        Task {
            for id in removedIds {
                await FavoritesService.shared.remove(restaurantId: id)
            }
        }
    }

    /// Remove a restaurant from the custom list by id. Used by the detail
    /// view's bookmark toggle. Silently no-ops if the id isn't in the list.
    func remove(restaurantId: UUID) {
        let before = restaurants.count
        restaurants.removeAll { $0.id == restaurantId }
        if restaurants.count != before {
            save()
            Task { await FavoritesService.shared.remove(restaurantId: restaurantId) }
        }
    }

    /// True when the restaurant (by id OR by googlePlaceId) is already saved.
    func contains(_ restaurant: Restaurant) -> Bool {
        restaurants.contains { existing in
            existing.id == restaurant.id
                || (restaurant.googlePlaceId != nil && existing.googlePlaceId == restaurant.googlePlaceId)
        }
    }

    func update(_ restaurant: Restaurant) {
        guard let idx = restaurants.firstIndex(where: { $0.id == restaurant.id }) else { return }
        restaurants[idx] = restaurant
        save()
    }

    func addSourceLink(_ link: SourceLink, to restaurantId: UUID) {
        guard let idx = restaurants.firstIndex(where: { $0.id == restaurantId }) else { return }
        restaurants[idx].sourceLinks.append(link)
        save()
    }

    // MARK: - Server sync

    /// Pulls the user's favorites from the backend and reconciles with the
    /// local list:
    ///   1. Server entries with a snapshot are inserted / refreshed locally.
    ///   2. Server entries without a snapshot are dropped in as a sparse row
    ///      (id + name placeholder); `hydrateSparseRows` fills them when the
    ///      weekly cache lands.
    ///   3. Local-only entries (never made it to the server, or saved while
    ///      offline) are pushed up so the next device will see them.
    /// Server is authoritative for the *set* of saved ids; conflicts where
    /// both sides have a snapshot prefer the server's, which wins on a
    ///  second device the user just signed into.
    func syncFromServer() async {
        let serverEntries = await FavoritesService.shared.pullFromServer()
        let serverIds = Set(serverEntries.map(\.restaurantId))

        await MainActor.run {
            // 1+2. Apply the server's view of each entry. Local row is kept
            // when the server has no snapshot (preserves any locally-cached
            // detail data we already had).
            for entry in serverEntries {
                guard let uuid = UUID(uuidString: entry.restaurantId) else { continue }
                if let snapshot = entry.snapshot {
                    var copy = snapshot
                    copy.id = uuid
                    copy.isCustom = true
                    if let existingIdx = self.restaurants.firstIndex(where: { $0.id == uuid }) {
                        let existing = self.restaurants[existingIdx]
                        copy.notes = copy.notes ?? existing.notes
                        copy.snoozedUntil = copy.snoozedUntil ?? existing.snoozedUntil
                        copy.addedAt = existing.addedAt
                        self.restaurants[existingIdx] = copy
                    } else {
                        self.restaurants.insert(copy, at: 0)
                    }
                } else if !self.restaurants.contains(where: { $0.id == uuid }) {
                    // Sparse insert — `hydrateSparseRows` will backfill once
                    // the weekly cache lands. Address/name will look bare
                    // until then.
                    let sparse = Restaurant(
                        id: uuid,
                        name: "",
                        address: "",
                        coordinates: Coordinates(latitude: 0, longitude: 0),
                        sourceOrigin: .xhs,
                        isCustom: true
                    )
                    self.restaurants.append(sparse)
                }
            }

            // 3. Push local-only rows. `FavoritesService.push` is idempotent
            // (ON CONFLICT DO UPDATE), so re-pushing a row the server
            // already has is harmless if a race put us out of sync.
            let toPush = self.restaurants.filter { !serverIds.contains($0.id.uuidString) }
            self.save()
            Task {
                for r in toPush {
                    await FavoritesService.shared.push(r)
                }
            }
        }
    }

    // MARK: - Helpers

    private func normalize(_ name: String) -> String {
        name.lowercased().trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func distance(_ a: Coordinates, _ b: Coordinates) -> Double {
        let lat = (a.latitude - b.latitude) * 111_000
        let lng = (a.longitude - b.longitude) * 111_000 * cos(a.latitude * .pi / 180)
        return sqrt(lat * lat + lng * lng)
    }
}
