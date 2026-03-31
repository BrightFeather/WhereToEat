import Foundation
import Combine

final class CustomListViewModel: ObservableObject {
    @Published var restaurants: [Restaurant] = []
    @Published var importDraft: ImportedRestaurantDraft?
    @Published var isImporting: Bool = false
    @Published var importError: String?
    @Published var showImportPreview: Bool = false

    private let importService = CustomListImportService()
    private let storageKey = "custom_restaurant_list"

    init() { load() }

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
            let draft = try await importService.importURL(urlString)
            importDraft = draft
            showImportPreview = true
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
            cuisineTags: draft.cuisineTags,
            photos: draft.photos,
            rating: draft.rating,
            sourceLinks: [draft.sourceLink],
            phone: draft.phone,
            website: draft.website,
            isCustom: true,
            notes: notes.isEmpty ? nil : notes
        )

        // Check for duplicate
        if let existingIdx = restaurants.firstIndex(where: {
            normalize($0.name) == normalize(editedName) ||
            ($0.coordinates.latitude != 0 && distance($0.coordinates, coords) < 50)
        }) {
            // Offer merge: add source link to existing
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

    func cancelImport() {
        importDraft = nil
        showImportPreview = false
        importError = nil
    }

    // MARK: - CRUD

    func delete(at offsets: IndexSet) {
        restaurants = restaurants.enumerated()
            .filter { !offsets.contains($0.offset) }
            .map(\.element)
        save()
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
