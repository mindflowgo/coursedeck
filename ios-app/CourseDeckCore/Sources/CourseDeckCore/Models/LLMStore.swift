import Foundation

public struct LlmModelCard: Equatable, Sendable {
    public enum AuthHeaderType: String, Equatable, Sendable {
        case bearer
        case apiKey = "api_key"
        case both
    }

    public var id: String
    public var label: String
    public var provider: String
    public var baseUrl: String
    /// In-memory only. Never serialized by `LlmStore.sanitizedJSON` and never
    /// written by the app's Keychain migration.
    public var apiKey: String?
    public var authHeaderType: AuthHeaderType
    public var model: String
    public var temperature: Double
    public var timeoutSeconds: Int
    public var sendSessionId: Bool
    public var extras: [JSONMember]

    public init(
        id: String,
        label: String,
        provider: String = "openai_compatible",
        baseUrl: String,
        apiKey: String? = nil,
        authHeaderType: AuthHeaderType = .bearer,
        model: String = "",
        temperature: Double = 0.3,
        timeoutSeconds: Int = 150,
        sendSessionId: Bool = false,
        extras: [JSONMember] = []
    ) {
        self.id = id
        self.label = label
        self.provider = provider
        self.baseUrl = baseUrl
        self.apiKey = apiKey
        self.authHeaderType = authHeaderType
        self.model = model
        self.temperature = temperature
        self.timeoutSeconds = timeoutSeconds
        self.sendSessionId = sendSessionId
        self.extras = extras
    }

    public var hasAPIKey: Bool {
        !(apiKey ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// Keychain account binding: card ID plus the normalized base URL, so a
    /// key is never forwarded to a different host after an endpoint edit.
    public var keyAccount: String {
        KeyMigrator.account(cardId: id, baseURL: baseUrl)
    }
}

public struct LlmStore: Equatable, Sendable {
    public var version: Int
    public var activeId: String?
    public var cards: [LlmModelCard]
    public var extras: [JSONMember]

    public init(version: Int = 2, activeId: String? = nil, cards: [LlmModelCard] = [], extras: [JSONMember] = []) {
        self.version = version
        self.activeId = activeId
        self.cards = cards
        self.extras = extras
    }

    public var activeCard: LlmModelCard? {
        cards.first(where: { $0.id == activeId }) ?? cards.first
    }

    // MARK: - Desktop-compatible normalization

    /// Accepts the version-2 multi-card store and the legacy flat single-config
    /// file, and drops cards without a usable base URL (desktop behavior).
    public static func normalized(from raw: JSONValue) -> LlmStore {
        var rawCards: [JSONValue] = []
        if let cards = raw["cards"]?.arrayValue {
            rawCards = cards
        } else if raw["baseUrl"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false {
            var legacy = raw
            legacy["id"] = .string("card_default")
            legacy["label"] = .string(providerLabel(raw["provider"]?.stringValue ?? "openai_compatible"))
            rawCards = [legacy]
        }

        var cards: [LlmModelCard] = []
        var seen = Set<String>()
        for rawCard in rawCards {
            guard let baseUrl = rawCard["baseUrl"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !baseUrl.isEmpty else { continue }

            let provider = normalizedProvider(rawCard["provider"]?.stringValue)
            var id = rawCard["id"]?.stringValue ?? ""
            if id.range(of: "^[a-z0-9][a-z0-9_-]{0,63}$", options: [.regularExpression, .caseInsensitive]) == nil {
                id = newCardId()
            }
            while seen.contains(id) { id = newCardId() }
            seen.insert(id)

            let label = rawCard["label"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let auth = LlmModelCard.AuthHeaderType(rawValue: rawCard["authHeaderType"]?.stringValue ?? "") ?? .bearer
            let temperature = cleanNumber(rawCard["temperature"]?.doubleValue, fallback: 0.3, minimum: 0)
            let timeout = Int(cleanNumber(rawCard["timeoutSeconds"]?.doubleValue, fallback: 150, minimum: 1))
            let known: Set<String> = [
                "id", "label", "provider", "baseUrl", "apiKey", "authHeaderType",
                "model", "temperature", "timeoutSeconds", "sendSessionId",
            ]
            let extras = rawCard.objectValue?.filter { !known.contains($0.key) } ?? []

            cards.append(LlmModelCard(
                id: id,
                label: label.isEmpty ? providerLabel(provider) : label,
                provider: provider,
                baseUrl: baseUrl,
                apiKey: rawCard["apiKey"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines),
                authHeaderType: auth,
                model: rawCard["model"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "",
                temperature: temperature,
                timeoutSeconds: min(timeout, 3600),
                sendSessionId: rawCard["sendSessionId"]?.boolValue ?? false,
                extras: extras
            ))
        }

        let requestedActive = raw["activeId"]?.stringValue
        let activeId = cards.contains(where: { $0.id == requestedActive }) ? requestedActive : cards.first?.id
        let knownRoot: Set<String> = ["version", "activeId", "cards"]
        let extras = raw.objectValue?.filter { !knownRoot.contains($0.key) } ?? []
        return LlmStore(version: 2, activeId: activeId, cards: cards, extras: extras)
    }

    public static func decode(_ data: Data) throws -> LlmStore {
        try normalized(from: JSONValue(parsing: data))
    }

    /// Sanitized serialization: card metadata and empty `apiKey` placeholders,
    /// never plaintext keys. This is the only shape written to disk or staged
    /// from an imported backup.
    public var sanitizedJSON: JSONValue {
        var members: [JSONMember] = [
            JSONMember(key: "version", value: .number("2")),
            JSONMember(key: "activeId", value: activeId.map { .string($0) } ?? .null),
            JSONMember(key: "cards", value: .array(cards.map(\.sanitizedJSON))),
        ]
        let known = Set(members.map(\.key))
        members.append(contentsOf: extras.filter { !known.contains($0.key) })
        return .object(members)
    }

    private static func normalizedProvider(_ raw: String?) -> String {
        switch raw {
        case "lmstudio", "llamacpp", "ollama", "gemini", "openai_compatible", "llamacpp_native":
            return raw!
        default:
            return "openai_compatible"
        }
    }

    private static func providerLabel(_ provider: String) -> String {
        switch provider {
        case "lmstudio": return "LM Studio (local)"
        case "llamacpp": return "llama.cpp server"
        case "ollama": return "Ollama (local)"
        case "gemini": return "Google Gemini"
        default: return "OpenAI-Compatible"
        }
    }

    private static func cleanNumber(_ value: Double?, fallback: Double, minimum: Double) -> Double {
        guard let value, value.isFinite, value >= minimum else { return fallback }
        return value
    }

    private static func newCardId() -> String {
        "card_" + UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(12).lowercased()
    }
}

extension LlmModelCard {
    /// Card metadata without a key. The empty `apiKey` placeholder keeps the
    /// desktop's key slot so a later desktop save does not look like a removal.
    public var sanitizedJSON: JSONValue {
        var members: [JSONMember] = [
            JSONMember(key: "id", value: .string(id)),
            JSONMember(key: "label", value: .string(label)),
            JSONMember(key: "provider", value: .string(provider)),
            JSONMember(key: "baseUrl", value: .string(baseUrl)),
            JSONMember(key: "apiKey", value: .string("")),
            JSONMember(key: "authHeaderType", value: .string(authHeaderType.rawValue)),
            JSONMember(key: "model", value: .string(model)),
            JSONMember(key: "temperature", value: Checkpoint.number(temperature)),
            JSONMember(key: "timeoutSeconds", value: .number(String(timeoutSeconds))),
            JSONMember(key: "sendSessionId", value: .bool(sendSessionId)),
        ]
        let known = Set(members.map(\.key))
        members.append(contentsOf: extras.filter { !known.contains($0.key) })
        return .object(members)
    }
}
