import Foundation

enum CuisineTag: String, Codable, CaseIterable, Identifiable {
    case french = "french"
    case italian = "italian"
    case japanese = "japanese"
    case chinese = "chinese"
    case korean = "korean"
    case mexican = "mexican"
    case american = "american"
    case mediterranean = "mediterranean"
    case thai = "thai"
    case indian = "indian"
    case vietnamese = "vietnamese"
    case spanish = "spanish"
    case middleEastern = "middle_eastern"
    case peruvian = "peruvian"
    case latinAmerican = "latin_american"
    case caribbean = "caribbean"
    case african = "african"
    case other = "other"

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .french: return "French"
        case .italian: return "Italian"
        case .japanese: return "Japanese"
        case .chinese: return "Chinese"
        case .korean: return "Korean"
        case .mexican: return "Mexican"
        case .american: return "American"
        case .mediterranean: return "Mediterranean"
        case .thai: return "Thai"
        case .indian: return "Indian"
        case .vietnamese: return "Vietnamese"
        case .spanish: return "Spanish"
        case .middleEastern: return "Middle Eastern"
        case .peruvian: return "Peruvian"
        case .latinAmerican: return "Latin American"
        case .caribbean: return "Caribbean"
        case .african: return "African"
        case .other: return "Other"
        }
    }

    static func from(string: String?) -> [CuisineTag] {
        guard let string, !string.isEmpty else { return [] }
        let lower = string.lowercased()
        if let exact = CuisineTag(rawValue: lower) { return [exact] }
        // Try matching by display name
        for tag in CuisineTag.allCases {
            if lower.contains(tag.displayName.lowercased()) { return [tag] }
        }
        return []
    }

    var emoji: String {
        switch self {
        case .french: return "🥐"
        case .italian: return "🍝"
        case .japanese: return "🍣"
        case .chinese: return "🥢"
        case .korean: return "🥩"
        case .mexican: return "🌮"
        case .american: return "🍔"
        case .mediterranean: return "🫒"
        case .thai: return "🍜"
        case .indian: return "🍛"
        case .vietnamese: return "🍲"
        case .spanish: return "🥘"
        case .middleEastern: return "🧆"
        case .peruvian: return "🫑"
        case .latinAmerican: return "💃"
        case .caribbean: return "🌴"
        case .african: return "🫘"
        case .other: return "🍴"
        }
    }
}
