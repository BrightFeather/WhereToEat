import Foundation

enum ReviewPlatform: String, Codable, CaseIterable {
    case google = "google"
    case yelp = "yelp"
    case xiaohongshu = "xiaohongshu"

    var displayName: String {
        switch self {
        case .google: return "Google"
        case .yelp: return "Yelp"
        case .xiaohongshu: return "Xiaohongshu"
        }
    }
}

struct Review: Codable, Identifiable, Equatable {
    var id: UUID = UUID()
    var platform: ReviewPlatform
    var text: String
    var rating: Double?
    var date: Date?
    var authorName: String?
}
