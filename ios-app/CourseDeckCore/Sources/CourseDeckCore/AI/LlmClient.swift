import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Activity timestamp shared by the stream consumer and the timeout watchdog.
private final class LlmActivityClock: @unchecked Sendable {
    private let lock = NSLock()
    private var last = Date()

    func touch() {
        lock.lock()
        last = Date()
        lock.unlock()
    }

    var lastActivity: Date {
        lock.lock()
        defer { lock.unlock() }
        return last
    }
}

private final class LlmTimeoutFailure: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: Error?

    func set(_ error: Error) {
        lock.lock()
        if stored == nil { stored = error }
        lock.unlock()
    }

    var error: Error? {
        lock.lock()
        defer { lock.unlock() }
        return stored
    }
}

public struct LlmClientConfiguration: Sendable {
    public var retry: LlmRetryPolicy
    public var userAgent: String

    public init(retry: LlmRetryPolicy = LlmRetryPolicy(), userAgent: String = "CourseDeck/0.1") {
        self.retry = retry
        self.userAgent = userAgent
    }
}

/// OpenAI-compatible streaming client (PLAN §4.7).
///
/// * SSE with robust line buffering.
/// * Success only on `[DONE]` or `finish_reason == "stop"` with content.
/// * Separate connect/idle/absolute timeouts.
/// * Retries 429/502/503/504 and transport failures with `Retry-After`/jitter.
/// * Real cancellation of the streaming URLSession task.
public final class LlmClient: @unchecked Sendable {
    private let session: URLSession
    private let configuration: LlmClientConfiguration
    private let randomUnit: @Sendable () -> Double
    private let sleeper: @Sendable (TimeInterval) async throws -> Void

    public init(
        session: URLSession = .shared,
        configuration: LlmClientConfiguration = LlmClientConfiguration(),
        randomUnit: @escaping @Sendable () -> Double = { Double.random(in: 0...1) },
        sleeper: (@Sendable (TimeInterval) async throws -> Void)? = nil
    ) {
        self.session = session
        self.configuration = configuration
        self.randomUnit = randomUnit
        self.sleeper = sleeper ?? { seconds in
            guard seconds > 0 else { return }
            let nanoseconds = UInt64(min(seconds, 3_600) * 1_000_000_000)
            try await Task.sleep(nanoseconds: nanoseconds)
        }
    }

    // MARK: - Public API

    public func complete(
        _ request: LlmCompletionRequest,
        progress: (@Sendable (LlmStreamEvent) -> Void)? = nil
    ) async throws -> LlmCompletion {
        guard request.capabilities.isSupported else {
            throw LlmError.unsupportedProvider(request.card.provider)
        }

        let key = request.apiKey?.trimmingCharacters(in: .whitespacesAndNewlines)
        if request.capabilities.requiresAPIKey, key?.isEmpty != false {
            throw LlmError.missingAPIKey(cardLabel: request.card.label)
        }
        if model(request.card.model) == nil {
            throw LlmError.invalidEndpoint("The model name is empty for \(request.card.label).")
        }

        let endpoint = try LlmEndpointResolver.resolve(baseURL: request.card.baseUrl)
        var active = endpoint.primary
        var usedFallback = false
        var attempt = 0
        var lastError: Error?

        while attempt < configuration.retry.maxAttempts {
            try Task.checkCancellation()
            do {
                return try await stream(endpoint: active, request: request, progress: progress)
            } catch {
                let mapped = Self.mapError(error)
                lastError = mapped

                if let llm = mapped as? LlmError,
                   case .httpStatus(404, _) = llm,
                   !usedFallback,
                   let fallback = endpoint.fallback {
                    usedFallback = true
                    active = fallback
                    continue
                }

                if let llm = mapped as? LlmError, llm.isRetryable,
                   attempt < configuration.retry.maxAttempts - 1 {
                    let delay = configuration.retry.delay(
                        attempt: attempt,
                        retryAfter: llm.retryAfter,
                        randomUnit: randomUnit()
                    )
                    attempt += 1
                    try await sleeper(delay)
                    continue
                }
                throw mapped
            }
        }
        throw lastError ?? LlmError.transport("The request could not be completed.")
    }

    // MARK: - Request construction

    private func model(_ raw: String) -> String? {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return value.isEmpty ? nil : value
    }

    private func makeRequest(
        endpoint: URL,
        request: LlmCompletionRequest,
        key: String?
    ) throws -> URLRequest {
        var urlRequest = URLRequest(url: endpoint)
        urlRequest.httpMethod = "POST"
        // The request-level inactivity timeout is deliberately the absolute
        // safety cap. Connect and stream-idle stalls are enforced by their own
        // watchdogs so a slow-but-healthy response is never cut off at the
        // connect timeout (PLAN §4.7).
        urlRequest.timeoutInterval = request.timeoutPolicy.absolute
        urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        urlRequest.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        urlRequest.setValue(configuration.userAgent, forHTTPHeaderField: "User-Agent")

        if let key, !key.isEmpty {
            switch request.capabilities.authHeaderType {
            case .bearer:
                urlRequest.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
            case .apiKey:
                urlRequest.setValue(key, forHTTPHeaderField: "x-api-key")
            case .both:
                urlRequest.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
                urlRequest.setValue(key, forHTTPHeaderField: "x-api-key")
            }
        }

        var members: [JSONMember] = [
            JSONMember(key: "model", value: .string(request.card.model)),
            JSONMember(key: "messages", value: .array([
                .object([
                    JSONMember(key: "role", value: .string("system")),
                    JSONMember(key: "content", value: .string(request.systemPrompt)),
                ]),
                .object([
                    JSONMember(key: "role", value: .string("user")),
                    JSONMember(key: "content", value: .string(request.userContent)),
                ]),
            ])),
            JSONMember(key: "stream", value: .bool(true)),
        ]

        if request.capabilities.supportsTemperature {
            members.append(JSONMember(
                key: "temperature",
                value: .number(String(request.card.temperature))
            ))
        }

        let maxTokens = request.maxTokens
        switch request.capabilities.maxTokensField {
        case .maxTokens:
            members.append(JSONMember(key: "max_tokens", value: .number(String(maxTokens))))
        case .maxCompletionTokens:
            members.append(JSONMember(key: "max_completion_tokens", value: .number(String(maxTokens))))
        }

        if request.capabilities.supportsStreamUsage {
            members.append(JSONMember(
                key: "stream_options",
                value: .object([JSONMember(key: "include_usage", value: .bool(true))])
            ))
        }
        if request.capabilities.supportsThinking {
            members.append(JSONMember(
                key: "thinking",
                value: .object([
                    JSONMember(key: "type", value: .string(request.extensions.thinking ? "enabled" : "disabled")),
                ])
            ))
        }
        if request.capabilities.supportsSessionID, request.card.sendSessionId {
            members.append(JSONMember(key: "session_id", value: .string(UUID().uuidString)))
        }

        let body = JSONValue.object(members).serializedData(pretty: false)
        urlRequest.httpBody = body
        return urlRequest
    }

    // MARK: - Streaming

    private func stream(
        endpoint: URL,
        request: LlmCompletionRequest,
        progress: (@Sendable (LlmStreamEvent) -> Void)?
    ) async throws -> LlmCompletion {
        let start = Date()
        let key = request.apiKey?.trimmingCharacters(in: .whitespacesAndNewlines)
        let urlRequest = try makeRequest(endpoint: endpoint, request: request, key: key)

        let bytes: URLSession.AsyncBytes
        let http: HTTPURLResponse
        do {
            (bytes, http) = try await openStream(urlRequest: urlRequest, policy: request.timeoutPolicy)
        } catch {
            throw Self.mapError(error)
        }
        guard (200...299).contains(http.statusCode) else {
            let body = await Self.readBody(bytes, limit: 8_192)
            throw Self.httpError(status: http.statusCode, body: body, response: http)
        }

        let clock = LlmActivityClock()
        clock.touch()
        let failure = LlmTimeoutFailure()

        let consumer = Task<LlmCompletion, Error> { [self] in
            try await consume(
                bytes: bytes,
                request: request,
                progress: progress,
                clock: clock,
                startedAt: start
            )
        }
        let watchdog = Task {
            do {
                try await Self.watch(request.timeoutPolicy, clock: clock, requestStartedAt: start)
            } catch is CancellationError {
                // Normal shutdown after the consumer finished.
            } catch {
                failure.set(error)
                consumer.cancel()
            }
        }

        return try await withTaskCancellationHandler {
            do {
                let completion = try await consumer.value
                watchdog.cancel()
                return completion
            } catch {
                watchdog.cancel()
                if let timeout = failure.error { throw timeout }
                throw Self.mapError(error)
            }
        } onCancel: {
            consumer.cancel()
            watchdog.cancel()
        }
    }

    /// Waits for the response headers under a connect-only watchdog. Once
    /// headers arrive the stream-idle watchdog takes over. The URLRequest's own
    /// timeout is the absolute cap, so the two phases cannot be confused.
    private func openStream(
        urlRequest: URLRequest,
        policy: LlmTimeoutPolicy
    ) async throws -> (URLSession.AsyncBytes, HTTPURLResponse) {
        let failure = LlmTimeoutFailure()
        let streamTask = Task<(URLSession.AsyncBytes, HTTPURLResponse), Error> {
            let (bytes, response) = try await session.bytes(for: urlRequest)
            guard let http = response as? HTTPURLResponse else {
                throw LlmError.invalidResponse("The provider did not return an HTTP response.")
            }
            return (bytes, http)
        }

        let connectWatchdog = Task {
            do {
                let nanoseconds = UInt64(max(policy.connect, 0.001) * 1_000_000_000)
                try await Task.sleep(nanoseconds: nanoseconds)
            } catch {
                return
            }
            failure.set(LlmError.timedOut(phase: .connect))
            streamTask.cancel()
        }

        do {
            let result = try await withTaskCancellationHandler {
                try await streamTask.value
            } onCancel: {
                streamTask.cancel()
                connectWatchdog.cancel()
            }
            connectWatchdog.cancel()
            return result
        } catch {
            connectWatchdog.cancel()
            if let timeout = failure.error { throw timeout }
            throw Self.mapError(error)
        }
    }

    private func consume(
        bytes: URLSession.AsyncBytes,
        request: LlmCompletionRequest,
        progress: (@Sendable (LlmStreamEvent) -> Void)?,
        clock: LlmActivityClock,
        startedAt: Date
    ) async throws -> LlmCompletion {
        var parser = SSEParser()
        var content = ""
        var reasoning = ""
        var usage: LlmUsage?
        var finishReason: LlmFinishReason?
        var sawDone = false
        var model: String?
        var requestID: String?

        func handle(_ event: SSEEvent) throws -> Bool {
            let data = event.data.trimmingCharacters(in: .whitespacesAndNewlines)
            if data == "[DONE]" { return true }
            guard !data.isEmpty else { return false }
            guard let json = try? JSONValue(parsing: Data(data.utf8)) else {
                throw LlmError.invalidResponse("The stream contained a malformed JSON chunk.")
            }
            if let error = json["error"] {
                let message = error["message"]?.stringValue
                    ?? error.stringValue
                    ?? "The provider reported an error."
                throw LlmError.invalidResponse(message)
            }
            if let value = json["model"]?.stringValue, !value.isEmpty { model = value }
            if let value = json["id"]?.stringValue, !value.isEmpty { requestID = value }
            if let rawUsage = json["usage"], let parsed = LlmUsage(json: rawUsage) {
                usage = parsed
                progress?(.usage(parsed))
            }
            if let choice = json["choices"]?.arrayValue?.first {
                if let delta = choice["delta"] {
                    if let text = delta["content"]?.stringValue, !text.isEmpty {
                        content += text
                        progress?(.textDelta(text))
                    }
                    if let thinking = (delta["reasoning_content"] ?? delta["reasoning"])?.stringValue,
                       !thinking.isEmpty {
                        reasoning += thinking
                        progress?(.reasoningDelta(thinking))
                    }
                }
                if let raw = choice["finish_reason"]?.stringValue, !raw.isEmpty {
                    finishReason = LlmFinishReason(raw: raw)
                }
            }
            return false
        }

        do {
            // `AsyncLineSequence` drops empty lines, which are the SSE event
            // delimiters. Read bytes and split on LF ourselves so a blank line
            // reaches the parser and `[DONE]` is never merged into the last
            // JSON event.
            var lineBuffer: [UInt8] = []
            lineBuffer.reserveCapacity(4_096)
            for try await byte in bytes {
                clock.touch()
                lineBuffer.append(byte)
                if byte == 0x0A {
                    let chunk = String(decoding: lineBuffer, as: UTF8.self)
                    lineBuffer.removeAll(keepingCapacity: true)
                    for event in parser.feed(chunk) {
                        if try handle(event) { sawDone = true; break }
                    }
                }
                if sawDone { break }
                if Task.isCancelled { throw CancellationError() }
            }
            if !sawDone {
                if !lineBuffer.isEmpty {
                    let chunk = String(decoding: lineBuffer, as: UTF8.self)
                    for event in parser.feed(chunk) {
                        if try handle(event) { sawDone = true; break }
                    }
                }
                if !sawDone {
                    for event in parser.finish() {
                        if try handle(event) { sawDone = true }
                    }
                }
            }
        } catch {
            throw Self.mapError(error)
        }

        if finishReason == .length {
            throw LlmError.truncated(reason: "length")
        }
        if finishReason == .contentFilter {
            throw LlmError.contentFiltered
        }
        if finishReason == .toolCalls {
            throw LlmError.truncated(reason: "tool_calls")
        }
        if case let .other(raw) = finishReason, !raw.isEmpty {
            throw LlmError.truncated(reason: raw)
        }

        let trimmed = content.trimmingCharacters(in: .whitespacesAndNewlines)
        guard sawDone || finishReason == .stop else {
            throw LlmError.truncated(reason: "stream ended without [DONE] or finish_reason=stop")
        }
        guard !trimmed.isEmpty else {
            throw LlmError.emptyCompletion
        }

        return LlmCompletion(
            content: content,
            reasoningContent: reasoning,
            finishReason: finishReason ?? .stop,
            usage: usage,
            model: model,
            requestID: requestID,
            receivedDoneSentinel: sawDone,
            elapsed: Date().timeIntervalSince(startedAt)
        )
    }

    private static func watch(
        _ policy: LlmTimeoutPolicy,
        clock: LlmActivityClock,
        requestStartedAt: Date
    ) async throws {
        while true {
            try await Task.sleep(nanoseconds: 50_000_000)
            if Task.isCancelled { throw CancellationError() }
            let now = Date()
            if now.timeIntervalSince(requestStartedAt) >= policy.absolute {
                throw LlmError.timedOut(phase: .absolute)
            }
            if now.timeIntervalSince(clock.lastActivity) >= policy.idle {
                throw LlmError.timedOut(phase: .idle)
            }
        }
    }

    // MARK: - Response helpers

    private static func readBody(_ bytes: URLSession.AsyncBytes, limit: Int) async -> Data {
        var data = Data()
        do {
            for try await byte in bytes {
                data.append(byte)
                if data.count >= limit { break }
            }
        } catch {
            // A failed error-body read must not mask the HTTP status.
        }
        return data
    }

    private static func httpError(status: Int, body: Data, response: HTTPURLResponse) -> LlmError {
        let message = errorMessage(from: body)
        switch status {
        case 401, 402, 403:
            return .authenticationFailed(status: status, message: message)
        case 429:
            return .rateLimited(retryAfter: retryAfterSeconds(response))
        case 502, 503, 504:
            return .serverUnavailable(status: status, message: message)
        default:
            return .httpStatus(status: status, message: message)
        }
    }

    private static func errorMessage(from body: Data) -> String {
        let text = String(decoding: body, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return "No error details were returned." }
        if let json = try? JSONValue(parsing: body) {
            let message = json["error"]?["message"]?.stringValue
                ?? json["message"]?.stringValue
                ?? json["error"]?.stringValue
            if let message, !message.isEmpty {
                return String(message.prefix(500))
            }
        }
        return String(text.prefix(500))
    }

    private static func retryAfterSeconds(_ response: HTTPURLResponse) -> TimeInterval? {
        guard let raw = response.value(forHTTPHeaderField: "Retry-After")?
            .trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else {
            return nil
        }
        if let seconds = TimeInterval(raw) {
            return max(0, seconds)
        }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
        if let date = formatter.date(from: raw) {
            return max(0, date.timeIntervalSinceNow)
        }
        return nil
    }

    static func mapError(_ error: Error) -> Error {
        if let llm = error as? LlmError { return llm }
        if error is CancellationError { return LlmError.cancelled }
        if let urlError = error as? URLError {
            switch urlError.code {
            case .cancelled:
                return LlmError.cancelled
            case .timedOut:
                // The URLRequest timeout is the absolute cap; connect/idle
                // phases are mapped by their own watchdogs.
                return LlmError.timedOut(phase: .absolute)
            case .networkConnectionLost, .notConnectedToInternet, .cannotConnectToHost,
                 .cannotFindHost, .dnsLookupFailed, .secureConnectionFailed, .appTransportSecurityRequiresSecureConnection:
                return LlmError.transport(urlError.localizedDescription)
            default:
                return LlmError.transport(urlError.localizedDescription)
            }
        }
        let nsError = error as NSError
        if nsError.domain == NSURLErrorDomain, nsError.code == NSURLErrorCancelled {
            return LlmError.cancelled
        }
        return LlmError.transport(error.localizedDescription)
    }
}

extension LlmError {
    public var retryAfter: TimeInterval? {
        if case let .rateLimited(value) = self { return value }
        return nil
    }
}
