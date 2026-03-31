import Foundation

enum SourcePlatform: String, Codable, CaseIterable, Identifiable {
    case google = "google"
    case yelp = "yelp"
    case xiaohongshu = "xiaohongshu"
    case eater = "eater"
    case website = "website"
    case other = "other"

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .google: return "Google Maps"
        case .yelp: return "Yelp"
        case .xiaohongshu: return "Xiaohongshu"
        case .eater: return "Eater"
        case .website: return "Website"
        case .other: return "Other"
        }
    }
}

struct SourceLink: Codable, Identifiable, Equatable {
    var id: UUID = UUID()
    var platform: SourcePlatform
    var url: URL
    var rawContent: String?
}
