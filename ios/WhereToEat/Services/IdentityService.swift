import Foundation
import Security

/// Device-scoped anonymous user id, stored in the Keychain so it survives
/// app reinstalls (within the same iCloud account / device user). Replaced
/// by a real Apple/Google subject id once auth (TASKS A1-A23) ships.
final class IdentityService {
    static let shared = IdentityService()

    private let service = "com.wheretoeat.identity"
    private let account = "anonymous-user-id"

    private(set) lazy var userId: String = {
        if let existing = readFromKeychain() { return existing }
        let fresh = UUID().uuidString
        writeToKeychain(fresh)
        return fresh
    }()

    private init() {}

    /// Replace the stored id with a verified provider-issued id after
    /// successful sign-in. Kept separate from `userId` so callers can't
    /// accidentally swap the anonymous id without routing through auth.
    func overrideUserId(_ newId: String) {
        writeToKeychain(newId)
        userId = newId
    }

    /// Mint a fresh anonymous UUID. Used on sign-out so the signed-out client
    /// doesn't keep pinging the backend with the now-privileged id.
    func resetAnonymous() {
        let fresh = UUID().uuidString
        writeToKeychain(fresh)
        userId = fresh
    }

    private func baseQuery() -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
    }

    private func readFromKeychain() -> String? {
        var query = baseQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data,
              let str = String(data: data, encoding: .utf8) else {
            return nil
        }
        return str
    }

    private func writeToKeychain(_ value: String) {
        let data = Data(value.utf8)
        var add = baseQuery()
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock

        SecItemDelete(baseQuery() as CFDictionary)
        SecItemAdd(add as CFDictionary, nil)
    }
}
