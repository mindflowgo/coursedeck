import XCTest
@testable import CourseDeckCore

final class LlmClientTests: XCTestCase {
    private func makeCard(
        baseURL: URL,
        model: String = "deepseek-flash",
        provider: String = "openai_compatible",
        auth: LlmModelCard.AuthHeaderType = .bearer,
        sendSessionID: Bool = false
    ) -> LlmModelCard {
        LlmModelCard(
            id: "card_test",
            label: "Test",
            provider: provider,
            baseUrl: baseURL.absoluteString,
            authHeaderType: auth,
            model: model,
            temperature: 0.3,
            timeoutSeconds: 60,
            sendSessionId: sendSessionID
        )
    }

    private func makeRequest(
        card: LlmModelCard,
        key: String? = "sk-test",
        maxTokens: Int = 1_024,
        thinking: Bool = false,
        connect: TimeInterval = 5,
        idle: TimeInterval = 5,
        absolute: TimeInterval = 30,
        capabilities: LlmProviderCapabilities? = nil
    ) -> LlmCompletionRequest {
        let resolved = capabilities ?? LlmProviderCapabilities.resolved(for: card)
        let extensions = LlmCardExtensions(
            maxTokens: maxTokens,
            thinking: thinking,
            idleTimeoutSeconds: 60,
            capabilities: resolved
        )
        return LlmCompletionRequest(
            card: card,
            extensions: extensions,
            capabilities: resolved,
            apiKey: key,
            systemPrompt: "SYSTEM",
            userContent: "USER",
            timeoutPolicyOverride: LlmTimeoutPolicy(connect: connect, idle: idle, absolute: absolute)
        )
    }

    private func deepSeekCapabilities() -> LlmProviderCapabilities {
        LlmProviderCapabilities(
            supportsThinking: true,
            maxTokensField: .maxTokens,
            supportsStreamUsage: true,
            supportsSessionID: false,
            supportsTemperature: true,
            authHeaderType: .bearer,
            requiresAPIKey: true
        )
    }

    private func makeClient(maxAttempts: Int = 3) -> LlmClient {
        LlmClient(
            configuration: LlmClientConfiguration(
                retry: LlmRetryPolicy(
                    maxAttempts: maxAttempts,
                    baseDelay: 0.01,
                    maximumDelay: 0.05,
                    jitterFraction: 0
                )
            ),
            randomUnit: { 0 }
        )
    }

    // MARK: - Success/usage

    func testStreamingSuccessCapturesContentUsageAndRequestShape() async throws {
        let server = try MockSSEServer()
        defer { server.stop() }
        let card = makeCard(baseURL: server.baseURL)
        server.route("/v1/chat/completions", [.successfulCompletion("Hello world", usage: (10, 2, 12))])

        let completion = try await makeClient().complete(makeRequest(
            card: card,
            capabilities: deepSeekCapabilities()
        ))
        XCTAssertEqual(completion.content, "Hello world")
        XCTAssertEqual(completion.usage?.promptTokens, 10)
        XCTAssertEqual(completion.usage?.completionTokens, 2)
        XCTAssertEqual(completion.usage?.totalTokens, 12)
        XCTAssertEqual(completion.finishReason, .stop)
        XCTAssertTrue(completion.receivedDoneSentinel)

        let request = try XCTUnwrap(server.requests.first)
        XCTAssertEqual(request.method, "POST")
        XCTAssertEqual(request.path, "/v1/chat/completions")
        XCTAssertEqual(request.headers["authorization"], "Bearer sk-test")
        let body = try XCTUnwrap(request.jsonBody)
        XCTAssertEqual(body["model"]?.stringValue, "deepseek-flash")
        XCTAssertEqual(body["max_tokens"]?.intValue, 1_024)
        XCTAssertEqual(body["stream"]?.boolValue, true)
        XCTAssertEqual(body["thinking"]?["type"]?.stringValue, "disabled")
        XCTAssertEqual(body["stream_options"]?["include_usage"]?.boolValue, true)
        XCTAssertEqual(body["messages"]?.arrayValue?.first?["role"]?.stringValue, "system")
        XCTAssertEqual(body["messages"]?.arrayValue?.first?["content"]?.stringValue, "SYSTEM")
        XCTAssertEqual(body["messages"]?.arrayValue?.last?["content"]?.stringValue, "USER")
    }

    func testUsageOnlyChunkIsAccepted() async throws {
        let server = try MockSSEServer()
        defer { server.stop() }
        let card = makeCard(baseURL: server.baseURL)
        let chunks = [
            #"data: {"choices":[{"delta":{"content":"Done"},"finish_reason":null}]}"# + "\n\n",
            #"data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":1,"total_tokens":6}}"# + "\n\n",
            "data: [DONE]\n\n",
        ]
        server.route("/v1/chat/completions", [.sse(chunks: chunks, delayPerChunk: 0, terminate: true)])

        let completion = try await makeClient().complete(makeRequest(card: card))
        XCTAssertEqual(completion.content, "Done")
        XCTAssertEqual(completion.usage?.totalTokens, 6)
    }

    // MARK: - Truncation and empty output

    func testStreamWithoutDoneOrStopIsTruncatedAndNotRetried() async throws {
        let server = try MockSSEServer()
        defer { server.stop() }
        let card = makeCard(baseURL: server.baseURL)
        server.route("/v1/chat/completions", [.truncated("partial answer")])

        do {
            _ = try await makeClient().complete(makeRequest(card: card))
            XCTFail("Expected truncation")
        } catch let error as LlmError {
            XCTAssertEqual(error, .truncated(reason: "stream ended without [DONE] or finish_reason=stop"))
            XCTAssertFalse(error.isRetryable)
        }
        XCTAssertEqual(server.requests.count, 1)
    }

    func testFinishReasonLengthIsTruncation() async throws {
        let server = try MockSSEServer()
        defer { server.stop() }
        let card = makeCard(baseURL: server.baseURL)
        server.route("/v1/chat/completions", [.successfulCompletion("too short", finishReason: "length")])

        do {
            _ = try await makeClient().complete(makeRequest(card: card))
            XCTFail("Expected length truncation")
        } catch let error as LlmError {
            XCTAssertTrue(error.isLengthTruncation)
            XCTAssertEqual(error, .truncated(reason: "length"))
        }
        XCTAssertEqual(server.requests.count, 1)
    }

    func testEmptyCompletionFails() async throws {
        let server = try MockSSEServer()
        defer { server.stop() }
        let card = makeCard(baseURL: server.baseURL)
        server.route("/v1/chat/completions", [
            .sse(chunks: ["data: [DONE]\n\n"], delayPerChunk: 0, terminate: true),
        ])

        do {
            _ = try await makeClient().complete(makeRequest(card: card))
            XCTFail("Expected empty completion")
        } catch let error as LlmError {
            XCTAssertEqual(error, .emptyCompletion)
        }
    }

    // MARK: - HTTP failures and retries

    func test401IsActionableAndNotRetried() async throws {
        let server = try MockSSEServer()
        defer { server.stop() }
        let card = makeCard(baseURL: server.baseURL)
        server.route("/v1/chat/completions", [
            .json(status: 401, body: #"{"error":{"message":"invalid key"}}"#, headers: [:]),
        ])

        do {
            _ = try await makeClient(maxAttempts: 3).complete(makeRequest(card: card))
            XCTFail("Expected auth failure")
        } catch let error as LlmError {
            XCTAssertEqual(error, .authenticationFailed(status: 401, message: "invalid key"))
            XCTAssertTrue(error.isAuthenticationFailure)
            XCTAssertFalse(error.isRetryable)
            XCTAssertTrue(error.userMessage.contains("Settings"))
        }
        XCTAssertEqual(server.requests.count, 1)
    }

    func test429RetriesWithRetryAfterThenSucceeds() async throws {
        let server = try MockSSEServer()
        defer { server.stop() }
        let card = makeCard(baseURL: server.baseURL)
        server.route("/v1/chat/completions", [
            .json(status: 429, body: #"{"error":{"message":"slow down"}}"#, headers: ["Retry-After": "0"]),
            .successfulCompletion("recovered"),
        ])

        let completion = try await makeClient(maxAttempts: 3).complete(makeRequest(card: card))
        XCTAssertEqual(completion.content, "recovered")
        XCTAssertEqual(server.requests.count, 2)
    }

    func test503RetriesAndEventuallyFails() async throws {
        let server = try MockSSEServer()
        defer { server.stop() }
        let card = makeCard(baseURL: server.baseURL)
        server.route("/v1/chat/completions", [
            .json(status: 503, body: #"{"error":{"message":"unavailable"}}"#, headers: [:]),
        ])

        do {
            _ = try await makeClient(maxAttempts: 3).complete(makeRequest(card: card))
            XCTFail("Expected server failure")
        } catch let error as LlmError {
            XCTAssertEqual(error, .serverUnavailable(status: 503, message: "unavailable"))
        }
        XCTAssertEqual(server.requests.count, 3)
    }

    func test404FallsBackToUnversionedChatCompletions() async throws {
        let server = try MockSSEServer()
        defer { server.stop() }
        let card = makeCard(baseURL: server.baseURL)
        server.route("/v1/chat/completions", [
            .json(status: 404, body: #"{"error":{"message":"not found"}}"#, headers: [:]),
        ])
        server.route("/chat/completions", [.successfulCompletion("fallback")])

        let completion = try await makeClient(maxAttempts: 1).complete(makeRequest(card: card))
        XCTAssertEqual(completion.content, "fallback")
        XCTAssertEqual(server.requests.map(\.path), ["/v1/chat/completions", "/chat/completions"])
    }

    // MARK: - Timeouts and cancellation

    func testCancellationCancelsTheStreamingTask() async throws {
        let server = try MockSSEServer()
        defer { server.stop() }
        let card = makeCard(baseURL: server.baseURL)
        let chunks = (0..<40).map { index in
            #"data: {"choices":[{"delta":{"content":"tick \#(index) "},"finish_reason":null}]}"# + "\n\n"
        }
        server.route("/v1/chat/completions", [
            .sse(chunks: chunks, delayPerChunk: 0.2, terminate: true),
        ])

        let client = makeClient()
        let request = makeRequest(card: card)
        let task = Task { try await client.complete(request) }
        try await Task.sleep(nanoseconds: 400_000_000)
        task.cancel()
        let started = Date()

        do {
            _ = try await task.value
            XCTFail("Expected cancellation")
        } catch let error as LlmError {
            XCTAssertEqual(error, .cancelled)
        }
        XCTAssertLessThan(Date().timeIntervalSince(started), 2.0)
    }

    func testIdleStallTimesOut() async throws {
        let server = try MockSSEServer()
        defer { server.stop() }
        let card = makeCard(baseURL: server.baseURL)
        server.route("/v1/chat/completions", [
            .sse(
                chunks: [#"data: {"choices":[{"delta":{"content":"one"},"finish_reason":null}]}"# + "\n\n"],
                delayPerChunk: 2.0,
                terminate: true
            ),
        ])

        do {
            _ = try await makeClient().complete(makeRequest(card: card, idle: 0.4, absolute: 10))
            XCTFail("Expected idle timeout")
        } catch let error as LlmError {
            XCTAssertEqual(error, .timedOut(phase: .idle))
        }
    }

    func testMidStreamStallUsesIdlePhaseWhenIdleExceedsConnect() async throws {
        let server = try MockSSEServer()
        defer { server.stop() }
        let card = makeCard(baseURL: server.baseURL)
        server.route("/v1/chat/completions", [
            .sse(
                chunks: [#"data: {"choices":[{"delta":{"content":"one"},"finish_reason":null}]}"# + "\n\n"],
                delayPerChunk: 3.0,
                terminate: true
            ),
        ])

        let started = Date()
        do {
            _ = try await makeClient(maxAttempts: 1).complete(makeRequest(
                card: card,
                connect: 0.3,
                idle: 1.0,
                absolute: 10
            ))
            XCTFail("Expected idle timeout")
        } catch let error as LlmError {
            XCTAssertEqual(error, .timedOut(phase: .idle))
        }
        XCTAssertGreaterThanOrEqual(Date().timeIntervalSince(started), 0.8)
        XCTAssertLessThan(Date().timeIntervalSince(started), 2.5)
    }

    func testHeaderStallUsesConnectPhase() async throws {
        let server = try MockSSEServer()
        defer { server.stop() }
        let card = makeCard(baseURL: server.baseURL)
        server.route("/v1/chat/completions", [
            .sseAfterHeaders(
                chunks: ["data: [DONE]\n\n"],
                delayPerChunk: 0,
                headerDelay: 3.0,
                terminate: true
            ),
        ])

        let started = Date()
        do {
            _ = try await makeClient(maxAttempts: 1).complete(makeRequest(
                card: card,
                connect: 0.4,
                idle: 5,
                absolute: 30
            ))
            XCTFail("Expected connect timeout")
        } catch let error as LlmError {
            XCTAssertEqual(error, .timedOut(phase: .connect))
        }
        XCTAssertLessThan(Date().timeIntervalSince(started), 2.0)
    }

    /// The old desktop behavior aborted at 150 seconds. This test is opt-in
    /// because it intentionally streams for ~160 seconds; run it with
    /// `COURSEDECK_RUN_LONG_STREAM=1 swift test --filter ...`.
    func testStreamingBeyond150SecondsWhenEnabled() async throws {
        try XCTSkipUnless(
            ProcessInfo.processInfo.environment["COURSEDECK_RUN_LONG_STREAM"] == "1",
            "Set COURSEDECK_RUN_LONG_STREAM=1 to run the >150s stream test."
        )
        let server = try MockSSEServer()
        defer { server.stop() }
        let card = makeCard(baseURL: server.baseURL)
        var chunks: [String] = []
        for index in 0..<16 {
            let finish = index == 15 ? "\"stop\"" : "null"
            chunks.append(
                #"data: {"choices":[{"delta":{"content":"tick \#(index) "},"finish_reason":\#(finish)}]}"#
                + "\n\n"
            )
        }
        chunks.append("data: [DONE]\n\n")
        server.route("/v1/chat/completions", [
            .sse(chunks: chunks, delayPerChunk: 10, terminate: true),
        ])

        let started = Date()
        let completion = try await makeClient(maxAttempts: 1).complete(makeRequest(
            card: card,
            connect: 30,
            idle: 60,
            absolute: 900
        ))
        XCTAssertTrue(completion.content.contains("tick 15"))
        XCTAssertGreaterThan(Date().timeIntervalSince(started), 150)
    }

    // MARK: - Provider-specific request fields

    func testDeepSeekThinkingEnabledIsSentExplicitly() async throws {
        let server = try MockSSEServer()
        defer { server.stop() }
        let card = makeCard(baseURL: server.baseURL)
        server.route("/v1/chat/completions", [.successfulCompletion("ok")])

        _ = try await makeClient().complete(makeRequest(
            card: card,
            thinking: true,
            capabilities: deepSeekCapabilities()
        ))
        let body = try XCTUnwrap(server.requests.first?.jsonBody)
        XCTAssertEqual(body["thinking"]?["type"]?.stringValue, "enabled")
    }

    func testGLMRequestDoesNotSendThinkingOrSessionID() async throws {
        let server = try MockSSEServer()
        defer { server.stop() }
        let card = makeCard(
            baseURL: server.baseURL,
            model: "glm-5.3-flash",
            sendSessionID: true
        )
        server.route("/v1/chat/completions", [.successfulCompletion("ok")])

        _ = try await makeClient().complete(makeRequest(card: card, thinking: true))
        let body = try XCTUnwrap(server.requests.first?.jsonBody)
        XCTAssertNil(body["thinking"])
        XCTAssertNil(body["session_id"])
        XCTAssertEqual(body["max_tokens"]?.intValue, 1_024)
        XCTAssertNotNil(body["temperature"])
    }

    func testMissingKeyFailsBeforeNetwork() async throws {
        let client = makeClient()
        let card = makeCard(baseURL: URL(string: "https://api.deepseek.com")!)
        let request = makeRequest(card: card, key: "")
        do {
            _ = try await client.complete(request)
            XCTFail("Expected missing key")
        } catch let error as LlmError {
            XCTAssertEqual(error, .missingAPIKey(cardLabel: "Test"))
        }
    }

    // MARK: - SSE parser and endpoint resolver

    func testSSEParserHandlesFragmentedCRLFAndMultilineData() {
        var parser = SSEParser()
        XCTAssertTrue(parser.feed("data: {\"a\":").isEmpty)
        var events = parser.feed("1}\r\n\r\n")
        XCTAssertEqual(events.map(\.data), ["{\"a\":1}"])

        events = parser.feed("event: chunk\ndata: one\ndata: two\n\n")
        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events.first?.event, "chunk")
        XCTAssertEqual(events.first?.data, "one\ntwo")

        _ = parser.feed("data: [DO")
        events = parser.feed("NE]\n\n")
        XCTAssertEqual(events.map(\.data), ["[DONE]"])
    }

    func testSSEParserFlushesTruncatedFinalLine() {
        var parser = SSEParser()
        _ = parser.feed("data: partial")
        let events = parser.finish()
        XCTAssertEqual(events.map(\.data), ["partial"])
    }

    func testEndpointResolverBuildsVersionedAndFallbackURLs() throws {
        let deepSeek = try LlmEndpointResolver.resolve(baseURL: "https://api.deepseek.com")
        XCTAssertEqual(deepSeek.primary.absoluteString, "https://api.deepseek.com/v1/chat/completions")
        XCTAssertEqual(deepSeek.fallback?.absoluteString, "https://api.deepseek.com/chat/completions")

        let glm = try LlmEndpointResolver.resolve(baseURL: "https://opencode.ai/inference/openai/v1/")
        XCTAssertEqual(glm.primary.absoluteString, "https://opencode.ai/inference/openai/v1/chat/completions")
        XCTAssertEqual(glm.fallback?.absoluteString, "https://opencode.ai/inference/openai/chat/completions")

        let explicit = try LlmEndpointResolver.resolve(baseURL: "https://example.com/chat/completions")
        XCTAssertEqual(explicit.primary.absoluteString, "https://example.com/chat/completions")
        XCTAssertNil(explicit.fallback)
    }

    func testSHA256KnownVectors() {
        XCTAssertEqual(SHA256.hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
        XCTAssertEqual(SHA256.hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    }
}
