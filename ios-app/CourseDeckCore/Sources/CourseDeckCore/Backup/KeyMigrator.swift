import Foundation

/// Minimal secret storage contract. The app target supplies the Keychain
/// implementation (`KeychainSecretStore`, Security framework); Core tests use
/// an in-memory store. Core stays Foundation-only so `swift test` works without
/// a simulator (PLAN §2.2).
public protocol SecretStore: AnyObject, Sendable {
    func setSecret(_ secret: String, for account: String) throws
    func secret(for account: String) throws -> String?
    func deleteSecret(for account: String) throws
    func allAccounts() throws -> [String]
}

public enum SecretStoreError: Error, LocalizedError, Equatable {
    case keychainFailure(String)

    public var errorDescription: String? {
        switch self {
        case let .keychainFailure(reason): return "Keychain operation failed: \(reason)"
        }
    }
}

public struct KeyMigrationReport: Equatable, Sendable {
    /// Cards whose key was written to the secret store.
    public var importedCardIDs: [String] = []
    /// Cards that already had a local key; local wins by default.
    public var keptLocalCardIDs: [String] = []
    /// Cards whose key was discarded because no secret store was available.
    public var discardedCardIDs: [String] = []
    /// Keychain items belonging to cards that no longer exist.
    public var orphanAccounts: [String] = []

    public init() {}
}

/// Migrates desktop plaintext keys into a secret store and rewrites the store
/// without keys. Import must call this before any bytes of `llm_config.json`
/// reach staging or the live root (PLAN §3.2 / §4.1).
public struct KeyMigrator: Sendable {
    public enum Policy: Equatable, Sendable {
        /// Existing local key wins; the imported key is ignored.
        case preserveLocal
        /// Imported key replaces the local key (explicit user choice).
        case replaceLocal
    }

    public let secretStore: SecretStore?
    public let policy: Policy

    public init(secretStore: SecretStore?, policy: Policy = .preserveLocal) {
        self.secretStore = secretStore
        self.policy = policy
    }

    /// Keychain account for a card. Binding the card ID to the normalized base
    /// URL means editing the endpoint cannot send a stored key to a new host.
    public static func account(cardId: String, baseURL: String) -> String {
        "llm_card:\(cardId):\(normalizedBaseURL(baseURL))"
    }

    public static func normalizedBaseURL(_ raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard var components = URLComponents(string: trimmed) else {
            return trimmed.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        }
        components.scheme = components.scheme?.lowercased()
        components.host = components.host?.lowercased()
        components.query = nil
        components.fragment = nil
        var path = components.percentEncodedPath
        while path.hasSuffix("/") { path.removeLast() }
        components.percentEncodedPath = path
        return components.string ?? trimmed
    }

    /// Writes each card's key to the secret store and clears it in the returned
    /// store. No plaintext key is ever persisted by the returned store.
    public func migrate(store: LlmStore) throws -> (store: LlmStore, report: KeyMigrationReport) {
        var sanitized = store
        var report = KeyMigrationReport()

        for index in sanitized.cards.indices {
            guard let key = sanitized.cards[index].apiKey,
                  !key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                sanitized.cards[index].apiKey = ""
                continue
            }
            let card = sanitized.cards[index]
            let account = card.keyAccount
            guard let secretStore else {
                report.discardedCardIDs.append(card.id)
                sanitized.cards[index].apiKey = ""
                continue
            }

            let existing = try? secretStore.secret(for: account)
            if existing != nil, policy == .preserveLocal {
                report.keptLocalCardIDs.append(card.id)
            } else {
                try secretStore.setSecret(key, for: account)
                report.importedCardIDs.append(card.id)
            }
            sanitized.cards[index].apiKey = ""
        }

        return (sanitized, report)
    }

    /// Reads the key for a card from the secret store (nil when absent).
    public func secret(for card: LlmModelCard) -> String? {
        try? secretStore?.secret(for: card.keyAccount)
    }

    /// Deletes the key when a card is deleted or its endpoint changes.
    public func deleteSecret(for card: LlmModelCard) throws {
        try secretStore?.deleteSecret(for: card.keyAccount)
    }

    /// Removes Keychain items for cards that no longer exist. Returns the
    /// deleted accounts.
    @discardableResult
    public func auditOrphans(knownCards: [LlmModelCard]) throws -> [String] {
        guard let secretStore else { return [] }
        let known = Set(knownCards.map(\.keyAccount))
        var deleted: [String] = []
        for account in try secretStore.allAccounts() where account.hasPrefix("llm_card:") {
            if !known.contains(account) {
                try secretStore.deleteSecret(for: account)
                deleted.append(account)
            }
        }
        return deleted.sorted()
    }

    /// Full-file migration used by backup import and the Documents audit.
    /// Reads the config in memory (bounded by the caller), persists keys, and
    /// returns sanitized JSON. Returns nil when the bytes are not a JSON store.
    public func migrateConfigData(_ data: Data) throws -> (json: JSONValue, report: KeyMigrationReport)? {
        guard (try? JSONValue(parsing: data)) != nil else { return nil }
        let store = try LlmStore.decode(data)
        let result = try migrate(store: store)
        return (result.store.sanitizedJSON, result.report)
    }
}

/// In-memory `SecretStore` for tests and previews. Never used by the app.
public final class InMemorySecretStore: SecretStore, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: String] = [:]

    public init() {}

    public func setSecret(_ secret: String, for account: String) throws {
        lock.lock()
        values[account] = secret
        lock.unlock()
    }

    public func secret(for account: String) throws -> String? {
        lock.lock()
        defer { lock.unlock() }
        return values[account]
    }

    public func deleteSecret(for account: String) throws {
        lock.lock()
        values.removeValue(forKey: account)
        lock.unlock()
    }

    public func allAccounts() throws -> [String] {
        lock.lock()
        defer { lock.unlock() }
        return Array(values.keys)
    }

    public func snapshot() -> [String: String] {
        lock.lock()
        defer { lock.unlock() }
        return values
    }
}
