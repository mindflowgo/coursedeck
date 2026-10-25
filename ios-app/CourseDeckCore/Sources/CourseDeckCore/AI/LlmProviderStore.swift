import Foundation

// MARK: - Provider capabilities

/// Per-provider transport capabilities (PLAN §4.7). DeepSeek-only fields must
/// never be sent to GLM/OpenAI/local servers.
public struct LlmProviderCapabilities: Equatable, Sendable {
    public enum MaxTokensField: String, Equatable, Sendable {
        case maxTokens = "max_tokens"
        case maxCompletionTokens = "max_completion_tokens"
    }

    public var supportsThinking: Bool
    public var maxTokensField: MaxTokensField
    public var supportsStreamUsage: Bool
    public var supportsSessionID: Bool
    public var supportsTemperature: Bool
    public var authHeaderType: LlmModelCard.AuthHeaderType
    public var requiresAPIKey: Bool
    public var isSupported: Bool

    public init(
        supportsThinking: Bool,
        maxTokensField: MaxTokensField,
        supportsStreamUsage: Bool,
        supportsSessionID: Bool,
        supportsTemperature: Bool,
        authHeaderType: LlmModelCard.AuthHeaderType,
        requiresAPIKey: Bool,
        isSupported: Bool = true
    ) {
        self.supportsThinking = supportsThinking
        self.maxTokensField = maxTokensField
        self.supportsStreamUsage = supportsStreamUsage
        self.supportsSessionID = supportsSessionID
        self.supportsTemperature = supportsTemperature
        self.authHeaderType = authHeaderType
        self.requiresAPIKey = requiresAPIKey
        self.isSupported = isSupported
    }

    public static func isDeepSeekHost(_ host: String) -> Bool {
        let clean = host.lowercased()
        return clean == "deepseek.com" || clean == "api.deepseek.com" || clean.hasSuffix(".deepseek.com")
    }

    public static func isLocalHost(_ host: String, provider: String) -> Bool {
        if ["lmstudio", "llamacpp", "ollama"].contains(provider) { return true }
        let clean = host.lowercased()
        return clean == "localhost" || clean == "127.0.0.1" || clean == "::1" || clean.hasSuffix(".local")
    }

    public static func resolved(for card: LlmModelCard) -> LlmProviderCapabilities {
        let host = URLComponents(string: card.baseUrl)?.host?.lowercased() ?? ""
        let model = card.model.lowercased()

        if card.provider == "llamacpp_native" {
            return LlmProviderCapabilities(
                supportsThinking: false,
                maxTokensField: .maxTokens,
                supportsStreamUsage: false,
                supportsSessionID: false,
                supportsTemperature: true,
                authHeaderType: .bearer,
                requiresAPIKey: false,
                isSupported: false
            )
        }

        if isDeepSeekHost(host) {
            // DeepSeek requires Bearer. The imported desktop `api_key` value is
            // normalized here and never sent.
            return LlmProviderCapabilities(
                supportsThinking: true,
                maxTokensField: .maxTokens,
                supportsStreamUsage: true,
                supportsSessionID: false,
                supportsTemperature: true,
                authHeaderType: .bearer,
                requiresAPIKey: true
            )
        }

        if isLocalHost(host, provider: card.provider) {
            return LlmProviderCapabilities(
                supportsThinking: false,
                maxTokensField: .maxTokens,
                supportsStreamUsage: false,
                supportsSessionID: false,
                supportsTemperature: true,
                authHeaderType: card.authHeaderType,
                requiresAPIKey: false
            )
        }

        if host == "api.openai.com" {
            let reasoningModel = ["o1", "o3", "o4", "gpt-5"].contains { model.hasPrefix($0) }
            return LlmProviderCapabilities(
                supportsThinking: false,
                maxTokensField: reasoningModel ? .maxCompletionTokens : .maxTokens,
                supportsStreamUsage: true,
                supportsSessionID: false,
                supportsTemperature: !reasoningModel,
                authHeaderType: .bearer,
                requiresAPIKey: true
            )
        }

        // GLM (opencode.ai) and generic OpenAI-compatible endpoints.
        return LlmProviderCapabilities(
            supportsThinking: false,
            maxTokensField: .maxTokens,
            supportsStreamUsage: true,
            supportsSessionID: false,
            supportsTemperature: true,
            authHeaderType: card.authHeaderType,
            requiresAPIKey: true
        )
    }

    public var json: JSONValue {
        .object([
            JSONMember(key: "thinking", value: .bool(supportsThinking)),
            JSONMember(key: "maxTokensField", value: .string(maxTokensField.rawValue)),
            JSONMember(key: "streamUsage", value: .bool(supportsStreamUsage)),
            JSONMember(key: "sessionId", value: .bool(supportsSessionID)),
            JSONMember(key: "temperature", value: .bool(supportsTemperature)),
            JSONMember(key: "authHeader", value: .string(authHeaderType.rawValue)),
            JSONMember(key: "requiresKey", value: .bool(requiresAPIKey)),
            JSONMember(key: "supported", value: .bool(isSupported)),
        ])
    }

    public init?(json: JSONValue) {
        guard let object = json.objectValue else { return nil }
        func bool(_ key: String) -> Bool? {
            object.first(where: { $0.key == key })?.value.boolValue
        }
        guard let thinking = bool("thinking"),
              let streamUsage = bool("streamUsage"),
              let sessionID = bool("sessionId"),
              let temperature = bool("temperature"),
              let requiresKey = bool("requiresKey"),
              let supported = bool("supported"),
              let rawField = object.first(where: { $0.key == "maxTokensField" })?.value.stringValue,
              let field = MaxTokensField(rawValue: rawField),
              let rawAuth = object.first(where: { $0.key == "authHeader" })?.value.stringValue,
              let auth = LlmModelCard.AuthHeaderType(rawValue: rawAuth) else {
            return nil
        }
        self.init(
            supportsThinking: thinking,
            maxTokensField: field,
            supportsStreamUsage: streamUsage,
            supportsSessionID: sessionID,
            supportsTemperature: temperature,
            authHeaderType: auth,
            requiresAPIKey: requiresKey,
            isSupported: supported
        )
    }
}

// MARK: - iOS-only card extensions

/// Fields kept in `llm_ios.json` keyed by card ID. `llm_config.json` stays
/// desktop-shaped and never carries them.
public struct LlmCardExtensions: Equatable, Sendable {
    public static let defaultMaxTokens = 24_576
    public static let maxTokensRange: ClosedRange<Int> = 1_024...65_536
    public static let idleRange: ClosedRange<Int> = 15...600
    public static let defaultIdleSeconds = 60

    public var maxTokens: Int
    public var thinking: Bool
    public var idleTimeoutSeconds: Int
    public var capabilities: LlmProviderCapabilities?
    public var extras: [JSONMember]

    public init(
        maxTokens: Int = LlmCardExtensions.defaultMaxTokens,
        thinking: Bool = false,
        idleTimeoutSeconds: Int = LlmCardExtensions.defaultIdleSeconds,
        capabilities: LlmProviderCapabilities? = nil,
        extras: [JSONMember] = []
    ) {
        self.maxTokens = LlmCardExtensions.clampMaxTokens(maxTokens)
        self.thinking = thinking
        self.idleTimeoutSeconds = LlmCardExtensions.clampIdle(idleTimeoutSeconds)
        self.capabilities = capabilities
        self.extras = extras
    }

    public static func clampMaxTokens(_ value: Int) -> Int {
        min(max(value, maxTokensRange.lowerBound), maxTokensRange.upperBound)
    }

    public static func clampIdle(_ value: Int) -> Int {
        min(max(value, idleRange.lowerBound), idleRange.upperBound)
    }

    private static let knownKeys: Set<String> = [
        "maxTokens", "thinking", "idleTimeoutSeconds", "capabilities",
    ]

    public init?(json: JSONValue) {
        guard case let .object(members) = json else { return nil }
        var maxTokens = LlmCardExtensions.defaultMaxTokens
        var thinking = false
        var idle = LlmCardExtensions.defaultIdleSeconds
        var capabilities: LlmProviderCapabilities?
        var extras: [JSONMember] = []

        for member in members {
            switch member.key {
            case "maxTokens":
                if let value = member.value.intValue { maxTokens = value }
            case "thinking":
                if let value = member.value.boolValue { thinking = value }
            case "idleTimeoutSeconds":
                if let value = member.value.intValue { idle = value }
            case "capabilities":
                capabilities = LlmProviderCapabilities(json: member.value)
            default:
                if !Self.knownKeys.contains(member.key) { extras.append(member) }
            }
        }

        self.init(
            maxTokens: maxTokens,
            thinking: thinking,
            idleTimeoutSeconds: idle,
            capabilities: capabilities,
            extras: extras
        )
    }

    public var json: JSONValue {
        var members: [JSONMember] = [
            JSONMember(key: "maxTokens", value: .number(String(maxTokens))),
            JSONMember(key: "thinking", value: .bool(thinking)),
            JSONMember(key: "idleTimeoutSeconds", value: .number(String(idleTimeoutSeconds))),
        ]
        if let capabilities {
            members.append(JSONMember(key: "capabilities", value: capabilities.json))
        }
        let known = Set(members.map(\.key))
        members.append(contentsOf: extras.filter { !known.contains($0.key) })
        return .object(members)
    }
}

// MARK: - Resolved configuration

public struct ResolvedLlmCard: Equatable, Sendable {
    public var card: LlmModelCard
    public var extensions: LlmCardExtensions
    public var capabilities: LlmProviderCapabilities
    public var timeoutPolicy: LlmTimeoutPolicy
    /// In-memory only; never persisted or logged.
    public var apiKey: String?

    public init(
        card: LlmModelCard,
        extensions: LlmCardExtensions,
        capabilities: LlmProviderCapabilities,
        timeoutPolicy: LlmTimeoutPolicy,
        apiKey: String?
    ) {
        self.card = card
        self.extensions = extensions
        self.capabilities = capabilities
        self.timeoutPolicy = timeoutPolicy
        self.apiKey = apiKey
    }

    public var hasAPIKey: Bool {
        !(apiKey ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    public var isConfigured: Bool {
        capabilities.requiresAPIKey ? hasAPIKey : true
    }
}

public struct LlmProviderConfiguration: Equatable, Sendable {
    public var store: LlmStore
    public var extensions: [String: LlmCardExtensions]
    /// In-memory key cache. `save` never writes these to `llm_config.json`.
    public var apiKeys: [String: String]

    public init(
        store: LlmStore,
        extensions: [String: LlmCardExtensions] = [:],
        apiKeys: [String: String] = [:]
    ) {
        self.store = store
        self.extensions = extensions
        self.apiKeys = apiKeys
    }

    public var activeCard: ResolvedLlmCard? {
        resolvedCard(id: store.activeId) ?? store.cards.first.map { resolved(card: $0) }
    }

    public func resolvedCard(id: String?) -> ResolvedLlmCard? {
        guard let id, let card = store.cards.first(where: { $0.id == id }) else { return nil }
        return resolved(card: card)
    }

    public func resolved(card: LlmModelCard) -> ResolvedLlmCard {
        let extensions = extensions[card.id] ?? LlmCardExtensions(idleTimeoutSeconds: card.timeoutSeconds)
        let capabilities = LlmProviderCapabilities.resolved(for: card)
        return ResolvedLlmCard(
            card: card,
            extensions: extensions,
            capabilities: capabilities,
            timeoutPolicy: LlmTimeoutPolicy.canonical(idleSeconds: TimeInterval(extensions.idleTimeoutSeconds)),
            apiKey: apiKeys[card.id]
        )
    }
}

// MARK: - Store errors

public enum LlmProviderStoreError: Error, LocalizedError, Equatable {
    case corruptConfiguration(quarantinedAt: URL?)
    case readOnlyPlaintextKeys
    case configurationChanged
    case noActiveCard
    case unknownCard(String)
    case missingAPIKey(String)
    case unsupportedProvider(String)
    case incompatibleProvider(String)
    case invalidEndpoint(String)

    public var errorDescription: String? {
        switch self {
        case let .corruptConfiguration(quarantinedAt):
            if let quarantinedAt {
                return "llm_config.json is unreadable and was moved to \(quarantinedAt.lastPathComponent). Re-add the model cards in Settings."
            }
            return "llm_config.json is unreadable. Re-add the model cards in Settings."
        case .readOnlyPlaintextKeys:
            return "llm_config.json contains plaintext API keys but the data root is read-only. Export/repair the library and re-enter the keys; no key was migrated."
        case .configurationChanged:
            return "llm_config.json changed while it was being loaded. Nothing was overwritten; try again."
        case .noActiveCard:
            return "No AI model card is configured. Add a DeepSeek card in Settings."
        case let .unknownCard(id):
            return "The model card \(id) no longer exists."
        case let .missingAPIKey(label):
            return "No API key is stored for \(label). Add the key in Settings."
        case let .unsupportedProvider(provider):
            return "The model provider \"\(provider)\" is not supported on iPad."
        case let .incompatibleProvider(detail):
            return "The model cards cannot share a key: \(detail)"
        case let .invalidEndpoint(detail):
            return "The model endpoint does not match the stored key: \(detail)"
        }
    }
}

// MARK: - Provider store

/// Owns `llm_config.json`, `llm_ios.json`, and the Keychain binding for model
/// keys. Plaintext keys are never written to either JSON file.
public actor LlmProviderStore {
    public typealias PersistenceInterceptor = @Sendable (URL) throws -> Void

    private let root: DataRoot
    private let secretStore: SecretStore?
    private let store: AtomicFileStore
    private let quarantine: FileQuarantine
    private let leaseOwner: String
    private let leaseTimeout: TimeInterval
    /// Test seam: runs under the lease after migration and before the final
    /// fingerprint check. Production passes nil.
    private let willPersist: PersistenceInterceptor?

    public init(
        root: DataRoot,
        secretStore: SecretStore?,
        store: AtomicFileStore = AtomicFileStore(),
        leaseTimeout: TimeInterval = 30,
        willPersist: PersistenceInterceptor? = nil
    ) {
        self.root = root
        self.secretStore = secretStore
        self.store = store
        self.quarantine = FileQuarantine(rootURL: root.quarantineURL)
        self.leaseOwner = "LlmProviderStore.\(UUID().uuidString)"
        self.leaseTimeout = leaseTimeout
        self.willPersist = willPersist
    }

    private func acquireMutationLease() throws {
        try root.acquireWriteLease(owner: leaseOwner, timeout: leaseTimeout)
    }

    // MARK: Load

    public func load() throws -> LlmProviderConfiguration {
        // The whole read/migrate/persist transaction holds the data write
        // lease. The gate is checked only when a write is required, so a
        // read-only library can still display its cards.
        try root.writeLease.acquire(owner: leaseOwner, timeout: leaseTimeout)
        defer { root.writeLease.release(owner: leaseOwner) }

        let read = try readConfiguration()
        var configuration = read.configuration
        var shouldPersistConfig = read.didCreateDefault
        var migratedReport: KeyMigrationReport?
        var migratedCards: [LlmModelCard] = []

        // 1. Migrate any plaintext keys that reached the live root (desktop
        //    backup, Files bypass, or an older app build) before anything else.
        let hasPlaintextKeys = configuration.store.cards.contains { card in
            !(card.apiKey ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
        if hasPlaintextKeys {
            // Never migrate keys into the Keychain while the library is
            // read-only: the sanitized config could not be written back, so
            // plaintext would remain on disk.
            guard root.writeGate.isWritable else {
                throw LlmProviderStoreError.readOnlyPlaintextKeys
            }
            let migrator = KeyMigrator(secretStore: secretStore)
            let migrated = try migrator.migrate(store: configuration.store)
            configuration.store = migrated.store
            migratedReport = migrated.report
            migratedCards = migrated.store.cards
            for card in migrated.store.cards {
                if let key = migrator.secret(for: card) { configuration.apiKeys[card.id] = key }
            }
            shouldPersistConfig = true
        }

        // 2. Known DeepSeek hosts always use Bearer, even when a desktop card
        //    was imported with `authHeaderType: api_key`.
        var normalizedCards: [LlmModelCard] = []
        for var card in configuration.store.cards {
            if let host = URLComponents(string: card.baseUrl)?.host,
               LlmProviderCapabilities.isDeepSeekHost(host),
               card.authHeaderType != .bearer {
                card.authHeaderType = .bearer
                shouldPersistConfig = true
            }
            normalizedCards.append(card)
        }
        if normalizedCards != configuration.store.cards {
            configuration.store.cards = normalizedCards
        }
        if configuration.store.activeId == nil, let first = configuration.store.cards.first {
            configuration.store.activeId = first.id
            shouldPersistConfig = true
        }

        // 3. Extensions: fill defaults and canonicalize the idle timeout from
        //    the imported desktop value.
        var extensions = configuration.extensions
        var extensionsChanged = read.didCreateDefault
        for card in configuration.store.cards {
            if let existing = extensions[card.id] {
                if existing.capabilities != LlmProviderCapabilities.resolved(for: card) {
                    var updated = existing
                    updated.capabilities = LlmProviderCapabilities.resolved(for: card)
                    extensions[card.id] = updated
                    extensionsChanged = true
                }
            } else {
                extensions[card.id] = LlmCardExtensions(
                    idleTimeoutSeconds: card.timeoutSeconds,
                    capabilities: LlmProviderCapabilities.resolved(for: card)
                )
                extensionsChanged = true
            }
        }
        let cardIDs = Set(configuration.store.cards.map(\.id))
        for id in extensions.keys where !cardIDs.contains(id) {
            extensions.removeValue(forKey: id)
            extensionsChanged = true
        }
        configuration.extensions = extensions

        if (shouldPersistConfig || extensionsChanged), root.writeGate.isWritable {
            do {
                // Sidecar first: it is additive and can be rewritten safely if
                // the critical config write is aborted.
                if extensionsChanged {
                    try persistExtensions(configuration.extensions, for: configuration.store)
                }
                if shouldPersistConfig {
                    try willPersist?(root.llmConfigURL)
                    // Re-read under the lease. If a non-cooperating writer
                    // changed the file, abort instead of writing stale bytes.
                    let original = read.rawData ?? Data()
                    let current = store.exists(root.llmConfigURL)
                        ? try store.read(root.llmConfigURL)
                        : Data()
                    guard SHA256.hex(current) == SHA256.hex(original) else {
                        throw LlmProviderStoreError.configurationChanged
                    }
                    try persistConfig(configuration.store)
                }
            } catch {
                rollbackMigratedKeys(migratedReport, cards: migratedCards)
                throw error
            }
        }

        // 4. Resolve keys from the secret store (never from JSON). A Keychain
        //    read failure must not hide the card list; it simply looks like no
        //    key is stored until the user re-enters one.
        if let secretStore {
            for card in configuration.store.cards {
                configuration.apiKeys[card.id] = (try? secretStore.secret(for: card.keyAccount)) ?? nil
            }
        }
        return configuration
    }

    // MARK: Save

    @discardableResult
    public func save(_ configuration: LlmProviderConfiguration) throws -> LlmProviderConfiguration {
        try acquireMutationLease()
        defer { root.releaseWriteLease(owner: leaseOwner) }
        return try saveLocked(configuration)
    }

    /// Caller holds the data write lease. All provider-store mutations run
    /// through here so the fail-closed gate is checked once and Keychain and
    /// JSON stay in step.
    @discardableResult
    private func saveLocked(_ configuration: LlmProviderConfiguration) throws -> LlmProviderConfiguration {
        var sanitized = configuration
        let previousCards = ((try? readConfiguration())?.configuration.store.cards) ?? []
        var cards: [LlmModelCard] = []
        for card in configuration.store.cards {
            var copy = card
            let previous = previousCards.first(where: { $0.id == card.id })
            let endpointChanged = previous.map {
                KeyMigrator.normalizedBaseURL($0.baseUrl) != KeyMigrator.normalizedBaseURL(card.baseUrl)
            } ?? false

            if endpointChanged {
                // Endpoint change: never forward the old key to the new host,
                // and ignore a key carried on the edited card. The caller must
                // call setAPIKey for the new account.
                if let previous, let secretStore {
                    try secretStore.deleteSecret(for: previous.keyAccount)
                }
                sanitized.apiKeys.removeValue(forKey: card.id)
            } else if let key = card.apiKey?.trimmingCharacters(in: .whitespacesAndNewlines),
                      !key.isEmpty {
                guard let secretStore else {
                    throw SecretStoreError.keychainFailure("no secret store is available")
                }
                try secretStore.setSecret(key, for: card.keyAccount)
                sanitized.apiKeys[card.id] = key
            }
            copy.apiKey = ""
            cards.append(copy)
        }
        sanitized.store.cards = cards

        var extensions: [String: LlmCardExtensions] = [:]
        for card in cards {
            var value = sanitized.extensions[card.id] ?? LlmCardExtensions(idleTimeoutSeconds: card.timeoutSeconds)
            value.capabilities = LlmProviderCapabilities.resolved(for: card)
            extensions[card.id] = value
        }
        sanitized.extensions = extensions
        sanitized.store.version = max(sanitized.store.version, 2)
        if sanitized.store.activeId == nil || !cards.contains(where: { $0.id == sanitized.store.activeId }) {
            sanitized.store.activeId = cards.first?.id
        }

        try persistConfig(sanitized.store)
        try persistExtensions(extensions, for: sanitized.store)

        let keptIDs = Set(cards.map(\.id))
        for old in previousCards where !keptIDs.contains(old.id) {
            if let secretStore {
                try secretStore.deleteSecret(for: old.keyAccount)
            }
            sanitized.apiKeys.removeValue(forKey: old.id)
        }
        if let secretStore {
            // Removes items for cards deleted directly or through a bulk save.
            _ = try? KeyMigrator(secretStore: secretStore).auditOrphans(knownCards: cards)
        }
        sanitized.apiKeys = sanitized.apiKeys.filter { keptIDs.contains($0.key) }
        return sanitized
    }

    @discardableResult
    public func setActiveCard(id: String) throws -> LlmProviderConfiguration {
        try acquireMutationLease()
        defer { root.releaseWriteLease(owner: leaseOwner) }
        var configuration = try load()
        guard configuration.store.cards.contains(where: { $0.id == id }) else {
            throw LlmProviderStoreError.unknownCard(id)
        }
        configuration.store.activeId = id
        return try saveLocked(configuration)
    }

    public func setAPIKey(_ key: String, for cardId: String) throws {
        try acquireMutationLease()
        defer { root.releaseWriteLease(owner: leaseOwner) }
        var configuration = try load()
        guard let card = configuration.store.cards.first(where: { $0.id == cardId }) else {
            throw LlmProviderStoreError.unknownCard(cardId)
        }
        let trimmed = key.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let secretStore else {
            throw SecretStoreError.keychainFailure("no secret store is available")
        }
        if trimmed.isEmpty {
            try secretStore.deleteSecret(for: card.keyAccount)
            configuration.apiKeys.removeValue(forKey: cardId)
        } else {
            try secretStore.setSecret(trimmed, for: card.keyAccount)
            configuration.apiKeys[cardId] = trimmed
        }
        // The card list itself is unchanged; persist the normalized config.
        _ = try saveLocked(configuration)
    }

    public func apiKey(for cardId: String) throws -> String? {
        let configuration = try load()
        guard let card = configuration.store.cards.first(where: { $0.id == cardId }) else {
            throw LlmProviderStoreError.unknownCard(cardId)
        }
        return try secretStore?.secret(for: card.keyAccount)
    }

    @discardableResult
    public func upsert(card: LlmModelCard, extensions: LlmCardExtensions? = nil) throws -> LlmProviderConfiguration {
        try acquireMutationLease()
        defer { root.releaseWriteLease(owner: leaseOwner) }
        var configuration = try load()
        var normalized = card
        if let host = URLComponents(string: normalized.baseUrl)?.host,
           LlmProviderCapabilities.isDeepSeekHost(host) {
            normalized.authHeaderType = .bearer
        }

        if let index = configuration.store.cards.firstIndex(where: { $0.id == normalized.id }) {
            let previous = configuration.store.cards[index]
            if KeyMigrator.normalizedBaseURL(previous.baseUrl) != KeyMigrator.normalizedBaseURL(normalized.baseUrl) {
                if let secretStore {
                    // Endpoint change: the old key must never be forwarded to
                    // the new host. Require re-entry.
                    try secretStore.deleteSecret(for: previous.keyAccount)
                }
                configuration.apiKeys.removeValue(forKey: previous.id)
                normalized.apiKey = nil
            }
            configuration.store.cards[index] = normalized
        } else {
            configuration.store.cards.append(normalized)
            if configuration.store.activeId == nil {
                configuration.store.activeId = normalized.id
            }
        }

        if let extensions {
            configuration.extensions[normalized.id] = extensions
        } else {
            // No explicit sidecar: refresh the canonical idle timeout from the
            // card so an edited timeoutSeconds is not shadowed by a stale
            // llm_ios.json value. Other iOS-only preferences are preserved.
            var value = configuration.extensions[normalized.id]
                ?? LlmCardExtensions(idleTimeoutSeconds: normalized.timeoutSeconds)
            value.idleTimeoutSeconds = LlmCardExtensions.clampIdle(normalized.timeoutSeconds)
            value.capabilities = LlmProviderCapabilities.resolved(for: normalized)
            configuration.extensions[normalized.id] = value
        }
        return try saveLocked(configuration)
    }

    @discardableResult
    public func deleteCard(id: String) throws -> LlmProviderConfiguration {
        try acquireMutationLease()
        defer { root.releaseWriteLease(owner: leaseOwner) }
        var configuration = try load()
        guard let index = configuration.store.cards.firstIndex(where: { $0.id == id }) else {
            throw LlmProviderStoreError.unknownCard(id)
        }
        let card = configuration.store.cards.remove(at: index)
        if let secretStore {
            try? secretStore.deleteSecret(for: card.keyAccount)
        }
        configuration.apiKeys.removeValue(forKey: id)
        configuration.extensions.removeValue(forKey: id)
        if configuration.store.activeId == id {
            configuration.store.activeId = configuration.store.cards.first?.id
        }
        return try saveLocked(configuration)
    }

    /// True only while both cards still exist at the recorded normalized
    /// endpoint with compatible providers. A pending replacement whose local
    /// endpoint changed is stale and must be cleared from the UI.
    public func isPendingKeyReplacementValid(_ candidate: PendingKeyReplacement) throws -> Bool {
        let configuration = try load()
        guard let local = configuration.store.cards.first(where: { $0.id == candidate.cardId }),
              let imported = configuration.store.cards.first(where: { $0.id == candidate.importedCardId }) else {
            return false
        }
        return local.provider == imported.provider
            && KeyMigrator.normalizedBaseURL(local.baseUrl) == candidate.endpoint
            && KeyMigrator.normalizedBaseURL(imported.baseUrl) == candidate.endpoint
    }

    /// Applies a pending imported key to the local card and removes the extra
    /// imported card. Used by the "replace local key" prompt after an import.
    @discardableResult
    public func adoptImportedKey(
        localCardId: String,
        importedCardId: String
    ) throws -> LlmProviderConfiguration {
        try acquireMutationLease()
        defer { root.releaseWriteLease(owner: leaseOwner) }
        var configuration = try load()
        guard let local = configuration.store.cards.first(where: { $0.id == localCardId }) else {
            throw LlmProviderStoreError.unknownCard(localCardId)
        }
        guard let importedIndex = configuration.store.cards.firstIndex(where: { $0.id == importedCardId }) else {
            throw LlmProviderStoreError.unknownCard(importedCardId)
        }
        let imported = configuration.store.cards[importedIndex]
        guard KeyMigrator.normalizedBaseURL(local.baseUrl) == KeyMigrator.normalizedBaseURL(imported.baseUrl) else {
            throw LlmProviderStoreError.invalidEndpoint(
                "\(local.label) and \(imported.label) point at different endpoints; the imported key must not be forwarded."
            )
        }
        guard local.provider == imported.provider else {
            throw LlmProviderStoreError.incompatibleProvider(
                "\(local.provider) cannot be combined with \(imported.provider)."
            )
        }
        guard let secretStore else {
            throw SecretStoreError.keychainFailure("no secret store is available")
        }
        guard let importedKey = try secretStore.secret(for: imported.keyAccount),
              !importedKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw SecretStoreError.keychainFailure("the imported card has no key")
        }
        try secretStore.setSecret(importedKey, for: local.keyAccount)
        try secretStore.deleteSecret(for: imported.keyAccount)
        configuration.apiKeys[local.id] = importedKey
        configuration.apiKeys.removeValue(forKey: imported.id)
        configuration.extensions.removeValue(forKey: imported.id)
        configuration.store.cards.remove(at: importedIndex)
        if configuration.store.activeId == imported.id {
            configuration.store.activeId = local.id
        }
        return try saveLocked(configuration)
    }

    /// Resolves the requested card with its key. A non-nil unknown ID throws
    /// `unknownCard`; only nil falls back to the active/first card.
    public func resolvedCard(id: String? = nil) throws -> ResolvedLlmCard {
        let configuration = try load()
        let card: LlmModelCard?
        if let id {
            card = configuration.store.cards.first(where: { $0.id == id })
            guard card != nil else {
                throw LlmProviderStoreError.unknownCard(id)
            }
        } else {
            card = configuration.activeCard?.card ?? configuration.store.cards.first
            guard card != nil else {
                throw LlmProviderStoreError.noActiveCard
            }
        }
        guard let card else { throw LlmProviderStoreError.noActiveCard }
        let resolved = configuration.resolved(card: card)
        guard resolved.capabilities.isSupported else {
            throw LlmProviderStoreError.unsupportedProvider(card.provider)
        }
        guard resolved.isConfigured else {
            throw LlmProviderStoreError.missingAPIKey(card.label)
        }
        return resolved
    }

    // MARK: Private

    private static func defaultConfiguration() -> LlmProviderConfiguration {
        let card = LlmModelCard(
            id: "card_deepseek",
            label: "DeepSeek",
            provider: "openai_compatible",
            baseUrl: "https://api.deepseek.com",
            authHeaderType: .bearer,
            model: "deepseek-flash",
            temperature: 0.3,
            timeoutSeconds: LlmCardExtensions.defaultIdleSeconds,
            sendSessionId: false
        )
        let extensions = LlmCardExtensions(
            maxTokens: LlmCardExtensions.defaultMaxTokens,
            thinking: false,
            idleTimeoutSeconds: LlmCardExtensions.defaultIdleSeconds,
            capabilities: LlmProviderCapabilities.resolved(for: card)
        )
        return LlmProviderConfiguration(
            store: LlmStore(version: 2, activeId: card.id, cards: [card]),
            extensions: [card.id: extensions],
            apiKeys: [:]
        )
    }

    private func readConfiguration() throws -> ReadResult {
        guard store.exists(root.llmConfigURL) else {
            return ReadResult(
                configuration: Self.defaultConfiguration(),
                rawData: nil,
                didCreateDefault: true
            )
        }

        do {
            let data = try store.read(root.llmConfigURL)
            let normalized = try LlmStore.decode(data)
            let extensions = readExtensions()
            return ReadResult(
                configuration: LlmProviderConfiguration(store: normalized, extensions: extensions),
                rawData: data,
                didCreateDefault: false
            )
        } catch {
            let quarantined = try? quarantine.quarantineFile(
                root.llmConfigURL,
                reason: "unreadable llm_config.json: \(error)",
                store: store
            )
            throw LlmProviderStoreError.corruptConfiguration(quarantinedAt: quarantined)
        }
    }

    private struct ReadResult {
        var configuration: LlmProviderConfiguration
        var rawData: Data?
        var didCreateDefault: Bool
    }

    private func rollbackMigratedKeys(
        _ report: KeyMigrationReport?,
        cards: [LlmModelCard]
    ) {
        guard let report, let secretStore else { return }
        let imported = Set(report.importedCardIDs)
        for card in cards where imported.contains(card.id) {
            try? secretStore.deleteSecret(for: card.keyAccount)
        }
    }

    private func readExtensions() -> [String: LlmCardExtensions] {
        guard store.exists(root.llmIOSURL),
              let json = try? store.readJSON(root.llmIOSURL),
              let members = json.objectValue else { return [:] }
        guard let cards = members.first(where: { $0.key == "cards" })?.value.objectValue else { return [:] }
        var extensions: [String: LlmCardExtensions] = [:]
        for member in cards {
            if let value = LlmCardExtensions(json: member.value) {
                extensions[member.key] = value
            }
        }
        return extensions
    }

    private func persistConfig(_ storeValue: LlmStore) throws {
        try store.writeJSON(storeValue.sanitizedJSON, to: root.llmConfigURL)
    }

    private func persistExtensions(_ extensions: [String: LlmCardExtensions], for storeValue: LlmStore) throws {
        var cards: [JSONMember] = []
        for card in storeValue.cards {
            let value = extensions[card.id] ?? LlmCardExtensions(idleTimeoutSeconds: card.timeoutSeconds)
            cards.append(JSONMember(key: card.id, value: value.json))
        }
        // Preserve unknown root-level fields written by a newer build or a
        // desktop roundtrip.
        var rootExtras: [JSONMember] = []
        if let existing = try? store.readJSON(root.llmIOSURL),
           let members = existing.objectValue {
            rootExtras = members.filter { !["version", "cards"].contains($0.key) }
        }
        var documentMembers: [JSONMember] = [
            JSONMember(key: "version", value: .number("1")),
            JSONMember(key: "cards", value: .object(cards)),
        ]
        documentMembers.append(contentsOf: rootExtras)
        try store.writeJSON(.object(documentMembers), to: root.llmIOSURL)
    }
}
