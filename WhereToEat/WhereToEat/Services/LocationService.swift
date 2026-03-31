import Foundation
import Combine
import CoreLocation

// MARK: - Private delegate bridge (NSObject required by CLLocationManager)
private final class LocationManagerDelegate: NSObject, CLLocationManagerDelegate {
    var onLocationsUpdated: ((CLLocation) -> Void)?
    var onAuthorizationChanged: ((CLAuthorizationStatus) -> Void)?
    var onError: ((Error) -> Void)?

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let location = locations.last else { return }
        onLocationsUpdated?(location)
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        onError?(error)
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        onAuthorizationChanged?(manager.authorizationStatus)
    }
}

// MARK: - LocationService (pure ObservableObject, no NSObject)
final class LocationService: ObservableObject {
    static let shared = LocationService()

    @Published var currentLocation: CLLocationCoordinate2D?
    @Published var currentCity: String = ""
    @Published var authorizationStatus: CLAuthorizationStatus = .notDetermined

    private let manager = CLLocationManager()
    private let geocoder = CLGeocoder()
    private let delegate = LocationManagerDelegate()

    var cityOverride: City? {
        UserProfile.load().locationOverride
    }

    var effectiveCoordinates: CLLocationCoordinate2D? {
        if let override = cityOverride {
            return CLLocationCoordinate2D(latitude: override.latitude, longitude: override.longitude)
        }
        return currentLocation
    }

    var effectiveCityName: String {
        cityOverride?.name ?? currentCity
    }

    var isUsingOverride: Bool { cityOverride != nil }

    init() {
        manager.desiredAccuracy = kCLLocationAccuracyKilometer
        manager.delegate = delegate
        authorizationStatus = manager.authorizationStatus

        delegate.onLocationsUpdated = { [weak self] location in
            DispatchQueue.main.async {
                self?.currentLocation = location.coordinate
                self?.reverseGeocode(location)
            }
        }

        delegate.onAuthorizationChanged = { [weak self] status in
            DispatchQueue.main.async {
                self?.authorizationStatus = status
                if status == .authorizedAlways || status == .authorizedWhenInUse {
                    self?.startMonitoring()
                    self?.requestOneTimeLocation()
                }
            }
        }

        delegate.onError = { error in
            print("Location error: \(error)")
        }
    }

    func requestPermission() {
        manager.requestAlwaysAuthorization()
    }

    func startMonitoring() {
        guard authorizationStatus == .authorizedAlways ||
              authorizationStatus == .authorizedWhenInUse else { return }
        manager.startMonitoringSignificantLocationChanges()
    }

    func requestOneTimeLocation() {
        manager.requestLocation()
    }

    private func reverseGeocode(_ location: CLLocation) {
        geocoder.reverseGeocodeLocation(location) { [weak self] placemarks, _ in
            guard let self, let placemark = placemarks?.first else { return }
            let city = placemark.locality ?? placemark.administrativeArea ?? ""
            let state = placemark.administrativeArea ?? ""
            DispatchQueue.main.async {
                self.currentCity = city.isEmpty ? state : "\(city), \(state)"
            }
        }
    }
}

private struct DailyLocationEntry: Codable {
    var date: Date
    var latitude: Double
    var longitude: Double
    var resolvedCity: String
}
