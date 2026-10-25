import Foundation

// MARK: - Messages

public struct LlmMessage: Equatable, Sendable {
    public enum Role: String, Equatable, Sendable {
        case system
        case user
        case assistant
    }

    public var role: Role
    public var content: String

    public init(role: Role, content: String) {
        self.role = role
        self.content = content
    }
}

// MARK: - Usage

/// Token accounting from the provider. Usage may arrive in its own final chunk
/// (`stream_options.include_usage`) or on the last content chunk.
public struct LlmUsage: Equatable, Sendable {
    public var promptTokens: Int?
    public var completionTokens: Int?
    public var totalTokens: Int?
    public var cachedPromptTokens: Int?
    public var reasoningTokens: Int?

    public init(
        promptTokens: Int? = nil,
        completionTokens: Int? = nil,
        totalTokens: Int? = nil,
        cachedPromptTokens: Int? = nil,
        reasoningTokens: Int? = nil
    ) {
        self.promptTokens = promptTokens
        self.completionTokens = completionTokens
        self.totalTokens = totalTokens
        self.cachedPromptTokens = cachedPromptTokens
        self.reasoningTokens = reasoningTokens
    }

    public init?(json: JSONValue) {
        guard let object = json.objectValue else { return nil }
        var prompt: Int?
        var completion: Int?
        var total: Int?
        var cached: Int?
        var reasoning: Int?
        for member in object {
            switch member.key {
            case "prompt_tokens": prompt = member.value.intValue
            case "completion_tokens": completion = member.value.intValue
            case "total_tokens": total = member.value.intValue
            case "prompt_cache_hit_tokens": cached = member.value.intValue
            case "prompt_tokens_details":
                cached = member.value["cached_tokens"]?.intValue ?? cached
            case "completion_tokens_details":
                reasoning = member.value["reasoning_tokens"]?.intValue ?? reasoning
            default:
                break
            }
        }
        guard prompt != nil || completion != nil || total != nil else { return nil }
        self.init(
            promptTokens: prompt,
            completionTokens: completion,
            totalTokens: total,
            cachedPromptTokens: cached,
            reasoningTokens: reasoning
        )
    }

    public var json: JSONValue {
        var members: [JSONMember] = []
        if let promptTokens { members.append(JSONMember(key: "prompt_tokens", value: .number(String(promptTokens)))) }
        if let completionTokens { members.append(JSONMember(key: "completion_tokens", value: .number(String(completionTokens)))) }
        if let totalTokens { members.append(JSONMember(key: "total_tokens", value: .number(String(totalTokens)))) }
        if let cachedPromptTokens {
            members.append(JSONMember(key: "prompt_tokens_details", value: .object([
                JSONMember(key: "cached_tokens", value: .number(String(cachedPromptTokens))),
            ])))
        }
        if let reasoningTokens {
            members.append(JSONMember(key: "completion_tokens_details", value: .object([
                JSONMember(key: "reasoning_tokens", value: .number(String(reasoningTokens))),
            ])))
        }
        return .object(members)
    }
}

// MARK: - Finish reasons

public enum LlmFinishReason: Equatable, Sendable {
    case stop
    case length
    case contentFilter
    case toolCalls
    case other(String)

    public init(raw: String?) {
        switch raw?.lowercased() {
        case "stop": self = .stop
        case "length": self = .length
        case "content_filter": self = .contentFilter
        case "tool_calls", "function_call": self = .toolCalls
        case let raw?: self = .other(raw)
        case nil: self = .other("")
        }
    }

    public var rawValue: String {
        switch self {
        case .stop: return "stop"
        case .length: return "length"
        case .contentFilter: return "content_filter"
        case .toolCalls: return "tool_calls"
        case let .other(raw): return raw
        }
    }
}

// MARK: - Completion

public struct LlmCompletion: Equatable, Sendable {
    /// Visible answer text. `reasoning_content` is never part of this value.
    public var content: String
    /// DeepSeek reasoning text, surfaced for diagnostics only.
    public var reasoningContent: String
    public var finishReason: LlmFinishReason
    public var usage: LlmUsage?
    public var model: String?
    public var requestID: String?
    public var receivedDoneSentinel: Bool
    public var elapsed: TimeInterval

    public init(
        content: String,
        reasoningContent: String = "",
        finishReason: LlmFinishReason,
        usage: LlmUsage? = nil,
        model: String? = nil,
        requestID: String? = nil,
        receivedDoneSentinel: Bool = false,
        elapsed: TimeInterval = 0
    ) {
        self.content = content
        self.reasoningContent = reasoningContent
        self.finishReason = finishReason
        self.usage = usage
        self.model = model
        self.requestID = requestID
        self.receivedDoneSentinel = receivedDoneSentinel
        self.elapsed = elapsed
    }
}

public enum LlmStreamEvent: Equatable, Sendable {
    case textDelta(String)
    case reasoningDelta(String)
    case usage(LlmUsage)
}

// MARK: - Timeouts

public enum LlmTimeoutPhase: String, Equatable, Sendable {
    case connect
    case idle
    case absolute
}

/// Connect, stream-idle and absolute safety limits are deliberately separate
/// (PLAN §4.7). An imported desktop `timeoutSeconds` maps to the idle limit,
/// never the absolute cap.
public struct LlmTimeoutPolicy: Equatable, Sendable {
    public static let connectSeconds: TimeInterval = 30
    public static let defaultIdleSeconds: TimeInterval = 60
    public static let absoluteSeconds: TimeInterval = 900
    public static let idleRange: ClosedRange<TimeInterval> = 15...600

    public var connect: TimeInterval
    public var idle: TimeInterval
    public var absolute: TimeInterval

    public init(connect: TimeInterval = LlmTimeoutPolicy.connectSeconds, idle: TimeInterval = LlmTimeoutPolicy.defaultIdleSeconds, absolute: TimeInterval = LlmTimeoutPolicy.absoluteSeconds) {
        self.connect = connect
        self.idle = idle
        self.absolute = absolute
    }

    public static func canonical(idleSeconds: TimeInterval?) -> LlmTimeoutPolicy {
        let requested = idleSeconds ?? defaultIdleSeconds
        let clamped = min(max(requested, idleRange.lowerBound), idleRange.upperBound)
        return LlmTimeoutPolicy(connect: connectSeconds, idle: clamped, absolute: absoluteSeconds)
    }
}

// MARK: - Retry policy

public struct LlmRetryPolicy: Equatable, Sendable {
    public var maxAttempts: Int
    public var baseDelay: TimeInterval
    public var maximumDelay: TimeInterval
    public var jitterFraction: Double

    public init(
        maxAttempts: Int = 3,
        baseDelay: TimeInterval = 0.5,
        maximumDelay: TimeInterval = 8,
        jitterFraction: Double = 0.2
    ) {
        self.maxAttempts = max(maxAttempts, 1)
        self.baseDelay = max(baseDelay, 0)
        self.maximumDelay = max(maximumDelay, 0)
        self.jitterFraction = min(max(jitterFraction, 0), 1)
    }

    /// Retry delay for a failed attempt. `attempt` is zero-based. A server
    /// `Retry-After` wins over the exponential schedule, capped only by a
    /// generous ceiling so a provider's requested pause is honored.
    public func delay(attempt: Int, retryAfter: TimeInterval?, randomUnit: Double) -> TimeInterval {
        if let retryAfter, retryAfter.isFinite, retryAfter >= 0 {
            return min(retryAfter, 120)
        }
        let exponential = baseDelay * pow(2, Double(max(attempt, 0)))
        let bounded = min(exponential, maximumDelay)
        let jitter = bounded * jitterFraction * min(max(randomUnit, 0), 1)
        return bounded + jitter
    }
}

// MARK: - Request

public struct LlmCompletionRequest: Sendable {
    public var card: LlmModelCard
    public var extensions: LlmCardExtensions
    public var capabilities: LlmProviderCapabilities
    public var apiKey: String?
    public var systemPrompt: String
    public var userContent: String
    public var maxTokensOverride: Int?
    /// Tests use this to shorten the idle/absolute windows without weakening
    /// the production clamps in `LlmCardExtensions`.
    public var timeoutPolicyOverride: LlmTimeoutPolicy?

    public init(
        card: LlmModelCard,
        extensions: LlmCardExtensions,
        capabilities: LlmProviderCapabilities,
        apiKey: String?,
        systemPrompt: String,
        userContent: String,
        maxTokensOverride: Int? = nil,
        timeoutPolicyOverride: LlmTimeoutPolicy? = nil
    ) {
        self.card = card
        self.extensions = extensions
        self.capabilities = capabilities
        self.apiKey = apiKey
        self.systemPrompt = systemPrompt
        self.userContent = userContent
        self.maxTokensOverride = maxTokensOverride
        self.timeoutPolicyOverride = timeoutPolicyOverride
    }

    public var maxTokens: Int {
        LlmCardExtensions.clampMaxTokens(maxTokensOverride ?? extensions.maxTokens)
    }

    public var timeoutPolicy: LlmTimeoutPolicy {
        timeoutPolicyOverride
            ?? LlmTimeoutPolicy.canonical(idleSeconds: TimeInterval(extensions.idleTimeoutSeconds))
    }
}

// MARK: - Errors

public enum LlmError: Error, Equatable, Sendable {
    case missingAPIKey(cardLabel: String)
    case authenticationFailed(status: Int, message: String)
    case rateLimited(retryAfter: TimeInterval?)
    case serverUnavailable(status: Int, message: String)
    case httpStatus(status: Int, message: String)
    case invalidEndpoint(String)
    case invalidResponse(String)
    case transport(String)
    case truncated(reason: String)
    case contentFiltered
    case emptyCompletion
    case timedOut(phase: LlmTimeoutPhase)
    case cancelled
    case unsupportedProvider(String)

    /// Retryable transport conditions only. Authorization failures, truncation
    /// and empty completions are never retried by the transport.
    public var isRetryable: Bool {
        switch self {
        case .rateLimited, .serverUnavailable, .transport:
            return true
        case .timedOut(.connect), .timedOut(.idle):
            return true
        case .timedOut(.absolute), .authenticationFailed, .httpStatus, .invalidEndpoint,
             .invalidResponse, .truncated, .contentFiltered, .emptyCompletion, .cancelled,
             .missingAPIKey, .unsupportedProvider:
            return false
        }
    }

    public var isAuthenticationFailure: Bool {
        if case .authenticationFailed = self { return true }
        return false
    }

    public var isLengthTruncation: Bool {
        if case let .truncated(reason) = self { return reason == "length" }
        return false
    }

    public var userMessage: String {
        switch self {
        case let .missingAPIKey(label):
            return "No API key is stored for \(label). Add the key in Settings."
        case let .authenticationFailed(status, message):
            return "The provider rejected the API key (HTTP \(status)). \(message) Check the key and endpoint in Settings."
        case let .rateLimited(retryAfter):
            if let retryAfter {
                return "The provider is rate limiting requests. Retry in about \(Int(retryAfter.rounded())) seconds."
            }
            return "The provider is rate limiting requests. Try again shortly."
        case let .serverUnavailable(status, message):
            return "The provider is temporarily unavailable (HTTP \(status)). \(message)"
        case let .httpStatus(status, message):
            return "The provider returned HTTP \(status). \(message)"
        case let .invalidEndpoint(detail):
            return "The model endpoint is invalid: \(detail)"
        case let .invalidResponse(detail):
            return "The provider sent an unexpected response: \(detail)"
        case let .transport(detail):
            return "The network request failed: \(detail)"
        case let .truncated(reason):
            if reason == "length" {
                return "The response hit the token limit before it finished."
            }
            return "The response ended before completion (\(reason)). Nothing was saved."
        case .contentFiltered:
            return "The provider blocked the response with its content filter. Nothing was saved."
        case .emptyCompletion:
            return "The provider returned an empty response. Nothing was saved."
        case let .timedOut(phase):
            switch phase {
            case .connect: return "The connection timed out."
            case .idle: return "The response stream stalled."
            case .absolute: return "The generation exceeded the maximum allowed time."
            }
        case .cancelled:
            return "Generation was cancelled."
        case let .unsupportedProvider(provider):
            return "The model provider \"\(provider)\" is not supported on iPad."
        }
    }
}

extension LlmError: LocalizedError {
    public var errorDescription: String? { userMessage }
}

// MARK: - URL resolution

public struct LlmEndpoint: Equatable, Sendable {
    public var primary: URL
    /// DeepSeek accepts both `/v1/chat/completions` and `/chat/completions`.
    /// A 404 on the primary retries once against this URL.
    public var fallback: URL?

    public init(primary: URL, fallback: URL?) {
        self.primary = primary
        self.fallback = fallback
    }
}

public enum LlmEndpointResolver {
    public static func resolve(baseURL: String) throws -> LlmEndpoint {
        let trimmed = baseURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard var components = URLComponents(string: trimmed),
              let scheme = components.scheme?.lowercased(),
              scheme == "https" || scheme == "http",
              let host = components.host, !host.isEmpty else {
            throw LlmError.invalidEndpoint("\(trimmed) is not an http(s) URL.")
        }
        components.scheme = scheme
        components.query = nil
        components.fragment = nil

        var path = components.percentEncodedPath
        while path.hasSuffix("/"), path.count > 1 { path.removeLast() }
        if path == "/" { path = "" }
        components.percentEncodedPath = path

        let base = components
        func url(_ path: String) -> URL? {
            var copy = base
            copy.percentEncodedPath = path
            return copy.url
        }

        if path.hasSuffix("/chat/completions") {
            guard let primary = base.url else { throw LlmError.invalidEndpoint(trimmed) }
            return LlmEndpoint(primary: primary, fallback: nil)
        }

        let primaryPath = path.hasSuffix("/v1") ? path + "/chat/completions" : path + "/v1/chat/completions"
        guard let primary = url(primaryPath) else { throw LlmError.invalidEndpoint(trimmed) }

        var fallbackPath = path
        if fallbackPath.hasSuffix("/v1") { fallbackPath.removeLast(3) }
        fallbackPath += "/chat/completions"
        if fallbackPath == primaryPath {
            return LlmEndpoint(primary: primary, fallback: nil)
        }
        return LlmEndpoint(primary: primary, fallback: url(fallbackPath))
    }
}
