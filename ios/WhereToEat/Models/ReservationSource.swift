import Foundation

enum ReservationPlatform: String, Codable, CaseIterable, Identifiable {
    case resy = "resy"
    case opentable = "opentable"
    case tock = "tock"
    case other = "other"

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .resy: return "Resy"
        case .opentable: return "OpenTable"
        case .tock: return "Tock"
        case .other: return "Other"
        }
    }

    var accentColor: String {
        switch self {
        case .resy: return "#E63946"
        case .opentable: return "#DA3743"
        case .tock: return "#1B1B1B"
        case .other: return "#6C757D"
        }
    }
}

struct ReservationSource: Codable, Equatable {
    var platform: ReservationPlatform
    var venueId: String
    var directBookingURL: URL?
}
