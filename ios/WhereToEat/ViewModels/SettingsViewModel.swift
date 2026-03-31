import Foundation
import Combine
import CoreLocation

final class SettingsViewModel: ObservableObject {
    @Published var profile: UserProfile
    @Published var citySearchQuery: String = ""
    @Published var citySearchResults: [City] = []
    @Published var isSearchingCity: Bool = false

    private let geocoder = CLGeocoder()

    init() {
        self.profile = UserProfile.load()
    }

    func saveProfile() {
        profile.save()
    }

    func clearCityOverride() {
        profile.locationOverride = nil
        saveProfile()
    }

    func searchCity(_ query: String) async {
        guard !query.trimmingCharacters(in: .whitespaces).isEmpty else {
            citySearchResults = []
            return
        }
        isSearchingCity = true
        do {
            let placemarks = try await geocoder.geocodeAddressString(query)
            citySearchResults = placemarks.compactMap { placemark -> City? in
                guard let location = placemark.location else { return nil }
                let city = placemark.locality ?? placemark.administrativeArea ?? ""
                let state = placemark.administrativeArea ?? ""
                let country = placemark.country ?? ""
                let name = [city, state, country].filter { !$0.isEmpty }.joined(separator: ", ")
                return City(name: name, latitude: location.coordinate.latitude,
                            longitude: location.coordinate.longitude)
            }
        } catch {
            citySearchResults = []
        }
        isSearchingCity = false
    }

    func selectCity(_ city: City) {
        profile.locationOverride = city
        saveProfile()
        citySearchQuery = city.name
        citySearchResults = []
    }
}
