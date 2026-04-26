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

    init() {
        load()
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
    }

    // MARK: - Persistence

    func load() {
        guard let data = UserDefaults.standard.data(forKey: storageKey),
              let list = try? JSONDecoder().decode([Restaurant].self, from: data) else { return }
        restaurants = list
    }

    private func save() {
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

        if let existingIdx = restaurants.firstIndex(where: {
            normalize($0.name) == normalize(editedName) ||
            ($0.coordinates.latitude != 0 && distance($0.coordinates, coords) < 50)
        }) {
            var existing = restaurants[existingIdx]
            if !existing.sourceLinks.contains(where: { $0.url == draft.sourceLink.url }) {
                existing.sourceLinks.append(draft.sourceLink)
            }
            restaurants[existingIdx] = existing
        } else {
            restaurants.insert(restaurant, at: 0)
        }
        save()
        importDraft = nil
        showImportPreview = false
    }

    func confirmXhsImport() {
        for index in selectedDraftIndices.sorted() {
            guard index < importDrafts.count else { continue }
            let draft = importDrafts[index]
            addRestaurantFromDraft(draft)
        }
        save()
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
        restaurants = restaurants.enumerated()
            .filter { !offsets.contains($0.offset) }
            .map(\.element)
        save()
    }

    /// Remove a restaurant from the custom list by id. Used by the detail
    /// view's bookmark toggle. Silently no-ops if the id isn't in the list.
    func remove(restaurantId: UUID) {
        let before = restaurants.count
        restaurants.removeAll { $0.id == restaurantId }
        if restaurants.count != before { save() }
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
