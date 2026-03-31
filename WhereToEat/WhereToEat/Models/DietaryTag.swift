import Foundation

enum DietaryTag: String, Codable, CaseIterable, Identifiable {
    case noRestrictions = "no_restrictions"
    case vegetarian = "vegetarian"
    case vegan = "vegan"
    case halal = "halal"
    case kosher = "kosher"
    case glutenFree = "gluten_free"
    case dairyFree = "dairy_free"
    case nutFree = "nut_free"
    case noShellfish = "no_shellfish"
    case noPork = "no_pork"

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .noRestrictions: return "No Restrictions"
        case .vegetarian: return "Vegetarian"
        case .vegan: return "Vegan"
        case .halal: return "Halal"
        case .kosher: return "Kosher"
        case .glutenFree: return "Gluten-Free"
        case .dairyFree: return "Dairy-Free"
        case .nutFree: return "Nut-Free"
        case .noShellfish: return "No Shellfish"
        case .noPork: return "No Pork"
        }
    }

    var emoji: String {
        switch self {
        case .noRestrictions: return "🍽"
        case .vegetarian: return "🥦"
        case .vegan: return "🌱"
        case .halal: return "☪️"
        case .kosher: return "✡️"
        case .glutenFree: return "🌾"
        case .dairyFree: return "🥛"
        case .nutFree: return "🥜"
        case .noShellfish: return "🦞"
        case .noPork: return "🐷"
        }
    }
}
