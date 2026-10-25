import Foundation
import Security
import CourseDeckCore

/// Keychain-backed `SecretStore` used by the app target. Core stays
/// Foundation-only; this file is the only place Security.framework is used for
/// model-provider keys.
///
/// Items are `kSecClassGenericPassword` with
/// `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` and no custom access
/// group, so free-signing/team changes do not require an entitlement.
final class KeychainSecretStore: SecretStore, @unchecked Sendable {
    private let service: String
    private let lock = NSLock()

    init(service: String = "com.ilc.coursedeck.llm") {
        self.service = service
    }

    func setSecret(_ secret: String, for account: String) throws {
        lock.lock()
        defer { lock.unlock() }

        let data = Data(secret.utf8)
        let baseQuery: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(baseQuery as CFDictionary)

        var attributes = baseQuery
        attributes[kSecValueData as String] = data
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(attributes as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw SecretStoreError.keychainFailure("add failed with status \(status)")
        }
    }

    func secret(for account: String) throws -> String? {
        lock.lock()
        defer { lock.unlock() }

        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else {
            throw SecretStoreError.keychainFailure("read failed with status \(status)")
        }
        return String(data: data, encoding: .utf8)
    }

    func deleteSecret(for account: String) throws {
        lock.lock()
        defer { lock.unlock() }

        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw SecretStoreError.keychainFailure("delete failed with status \(status)")
        }
    }

    func allAccounts() throws -> [String] {
        lock.lock()
        defer { lock.unlock() }

        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecReturnAttributes as String: true,
            kSecMatchLimit as String: kSecMatchLimitAll,
        ]
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return [] }
        guard status == errSecSuccess, let items = result as? [[String: Any]] else {
            throw SecretStoreError.keychainFailure("list failed with status \(status)")
        }
        return items.compactMap { $0[kSecAttrAccount as String] as? String }
    }
}
