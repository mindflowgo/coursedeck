import Foundation
import Network
import XCTest
@testable import CourseDeckCore

struct MockHTTPRequest: Sendable {
    let method: String
    let path: String
    let headers: [String: String]
    let body: Data

    var jsonBody: JSONValue? {
        try? JSONValue(parsing: body)
    }
}

/// Minimal in-process HTTP/1.1 server that streams Server-Sent Events. Tests
/// exercise the real URLSession path, including chunked framing, partial
/// reads, cancellation and clean EOF truncation.
final class MockSSEServer: @unchecked Sendable {
    enum Response: Sendable {
        /// Writes each string as its own HTTP chunk. `terminate` sends the
        /// chunked terminator (clean EOF); false drops the connection.
        case sse(chunks: [String], delayPerChunk: TimeInterval, terminate: Bool)
        /// Same as `sse` but delays the response headers, which lets tests
        /// exercise the connect-only watchdog.
        case sseAfterHeaders(
            chunks: [String],
            delayPerChunk: TimeInterval,
            headerDelay: TimeInterval,
            terminate: Bool
        )
        case json(status: Int, body: String, headers: [String: String])
    }

    private struct Route {
        var responses: [Response]
        var nextIndex: Int = 0
    }

    private let listener: NWListener
    private let queue = DispatchQueue(label: "CourseDeck.MockSSEServer")
    private let lock = NSLock()
    private var routes: [String: Route] = [:]
    private var recorded: [MockHTTPRequest] = []

    var port: UInt16 { listener.port?.rawValue ?? 0 }
    var baseURL: URL { URL(string: "http://127.0.0.1:\(port)")! }

    init() throws {
        let parameters = NWParameters.tcp
        parameters.allowLocalEndpointReuse = true
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        listener = try NWListener(using: parameters)

        let ready = DispatchSemaphore(value: 0)
        let failure = FailureBox()
        listener.stateUpdateHandler = { state in
            switch state {
            case .ready:
                ready.signal()
            case let .failed(error):
                failure.set(error)
                ready.signal()
            case .cancelled:
                ready.signal()
            default:
                break
            }
        }
        listener.newConnectionHandler = { [weak self] connection in
            self?.accept(connection)
        }
        listener.start(queue: queue)
        guard ready.wait(timeout: .now() + 5) == .success else {
            listener.cancel()
            throw MockServerError.startTimedOut
        }
        if let error = failure.error {
            listener.cancel()
            throw error
        }
        guard (listener.port?.rawValue ?? 0) != 0 else {
            listener.cancel()
            throw MockServerError.missingPort
        }
    }

    deinit {
        listener.cancel()
    }

    func stop() {
        listener.cancel()
    }

    func route(_ path: String, _ responses: [Response]) {
        lock.lock()
        routes[path] = Route(responses: responses.isEmpty ? [.json(status: 500, body: "{}", headers: [:])] : responses)
        lock.unlock()
    }

    var requests: [MockHTTPRequest] {
        lock.lock()
        defer { lock.unlock() }
        return recorded
    }

    // MARK: - Connection handling

    private func accept(_ connection: NWConnection) {
        connection.start(queue: queue)
        receive(connection, buffer: Data())
    }

    private func receive(_ connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            var accumulated = buffer
            if let data { accumulated.append(data) }
            if let request = Self.parse(accumulated) {
                self.record(request)
                self.respond(to: request, on: connection)
                return
            }
            if error != nil || isComplete {
                connection.cancel()
                return
            }
            self.queue.async { self.receive(connection, buffer: accumulated) }
        }
    }

    private func record(_ request: MockHTTPRequest) {
        lock.lock()
        recorded.append(request)
        lock.unlock()
    }

    private func nextResponse(for path: String) -> Response {
        lock.lock()
        defer { lock.unlock() }
        guard var route = routes[path], !route.responses.isEmpty else {
            return .json(status: 404, body: #"{"error":{"message":"no route"\}}"#, headers: [:])
        }
        let index = min(route.nextIndex, route.responses.count - 1)
        route.nextIndex += 1
        routes[path] = route
        return route.responses[index]
    }

    private func respond(to request: MockHTTPRequest, on connection: NWConnection) {
        switch nextResponse(for: request.path) {
        case let .json(status, body, headers):
            let payload = Data(body.utf8)
            var head = "HTTP/1.1 \(status) \(Self.reason(status))\r\n"
            head += "Content-Type: application/json; charset=utf-8\r\n"
            head += "Content-Length: \(payload.count)\r\n"
            head += "Connection: close\r\n"
            for (key, value) in headers {
                head += "\(key): \(value)\r\n"
            }
            head += "\r\n"
            var data = Data(head.utf8)
            data.append(payload)
            connection.send(content: data, completion: .contentProcessed { _ in
                connection.cancel()
            })
        case let .sse(chunks, delay, terminate):
            writeSSE(
                chunks: chunks,
                delayPerChunk: delay,
                headerDelay: 0,
                terminate: terminate,
                on: connection
            )
        case let .sseAfterHeaders(chunks, delay, headerDelay, terminate):
            writeSSE(
                chunks: chunks,
                delayPerChunk: delay,
                headerDelay: headerDelay,
                terminate: terminate,
                on: connection
            )
        }
    }

    private func writeSSE(
        chunks: [String],
        delayPerChunk: TimeInterval,
        headerDelay: TimeInterval,
        terminate: Bool,
        on connection: NWConnection
    ) {
        var head = "HTTP/1.1 200 OK\r\n"
        head += "Content-Type: text/event-stream; charset=utf-8\r\n"
        head += "Cache-Control: no-cache\r\n"
        head += "Connection: close\r\n"
        head += "Transfer-Encoding: chunked\r\n\r\n"
        let headerData = Data(head.utf8)
        let start = { [weak self] in
            connection.send(content: headerData, completion: .contentProcessed { _ in
                guard let self else {
                    connection.cancel()
                    return
                }
                let writer = SSEWriter(
                    connection: connection,
                    queue: self.queue,
                    chunks: chunks,
                    delay: delayPerChunk,
                    terminate: terminate
                )
                writer.start()
            })
        }
        if headerDelay > 0 {
            queue.asyncAfter(deadline: .now() + headerDelay, execute: start)
        } else {
            start()
        }
    }

    private static func parse(_ data: Data) -> MockHTTPRequest? {
        guard let headerEnd = data.range(of: Data("\r\n\r\n".utf8)) else { return nil }
        guard let headerText = String(data: data[..<headerEnd.lowerBound], encoding: .utf8) else { return nil }
        var lines = headerText.components(separatedBy: "\r\n")
        guard !lines.isEmpty else { return nil }
        let requestLine = lines.removeFirst().split(separator: " ")
        guard requestLine.count >= 2 else { return nil }
        var headers: [String: String] = [:]
        for line in lines {
            guard let colon = line.firstIndex(of: ":") else { continue }
            let key = line[..<colon].trimmingCharacters(in: .whitespaces).lowercased()
            let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            headers[key] = value
        }
        let length = Int(headers["content-length"] ?? "0") ?? 0
        let bodyStart = headerEnd.upperBound
        guard data.count >= bodyStart + length else { return nil }
        let body = data.subdata(in: bodyStart..<(bodyStart + length))
        let target = String(requestLine[1])
        let path = target.split(separator: "?").first.map(String.init) ?? target
        return MockHTTPRequest(
            method: String(requestLine[0]),
            path: path,
            headers: headers,
            body: body
        )
    }

    private static func reason(_ status: Int) -> String {
        switch status {
        case 200: return "OK"
        case 401: return "Unauthorized"
        case 402: return "Payment Required"
        case 403: return "Forbidden"
        case 404: return "Not Found"
        case 429: return "Too Many Requests"
        case 500: return "Internal Server Error"
        case 503: return "Service Unavailable"
        default: return "Status"
        }
    }
}

private final class SSEWriter: @unchecked Sendable {
    private let connection: NWConnection
    private let queue: DispatchQueue
    private let chunks: [String]
    private let delay: TimeInterval
    private let terminate: Bool
    private var index = 0

    init(
        connection: NWConnection,
        queue: DispatchQueue,
        chunks: [String],
        delay: TimeInterval,
        terminate: Bool
    ) {
        self.connection = connection
        self.queue = queue
        self.chunks = chunks
        self.delay = delay
        self.terminate = terminate
    }

    func start() {
        sendNext()
    }

    private func sendNext() {
        guard index < chunks.count else {
            if terminate {
                connection.send(content: Data("0\r\n\r\n".utf8), completion: .contentProcessed { [connection] _ in
                    connection.cancel()
                })
            } else {
                connection.cancel()
            }
            return
        }
        let payload = Data(chunks[index].utf8)
        var frame = Data("\(String(payload.count, radix: 16))\r\n".utf8)
        frame.append(payload)
        frame.append(Data("\r\n".utf8))
        index += 1
        connection.send(content: frame, completion: .contentProcessed { _ in
            // The writer retains itself through this chain until the terminal
            // chunk is sent; a weak reference would deallocate it after the
            // first chunk and leave the client hanging.
            self.queue.asyncAfter(deadline: .now() + self.delay) {
                self.sendNext()
            }
        })
    }
}

private final class FailureBox: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: Error?

    func set(_ error: Error) {
        lock.lock()
        stored = error
        lock.unlock()
    }

    var error: Error? {
        lock.lock()
        defer { lock.unlock() }
        return stored
    }
}

enum MockServerError: Error {
    case startTimedOut
    case missingPort
}

// MARK: - SSE response helpers

extension MockSSEServer.Response {
    /// One content chunk with `finish_reason` + usage and a `[DONE]` sentinel.
    static func successfulCompletion(
        _ content: String,
        finishReason: String = "stop",
        usage: (prompt: Int, completion: Int, total: Int)? = nil
    ) -> MockSSEServer.Response {
        var root: [JSONMember] = [
            JSONMember(key: "id", value: .string("chatcmpl-test")),
            JSONMember(key: "model", value: .string("deepseek-flash")),
            JSONMember(key: "choices", value: .array([
                .object([
                    JSONMember(key: "delta", value: .object([
                        JSONMember(key: "content", value: .string(content)),
                    ])),
                    JSONMember(
                        key: "finish_reason",
                        value: finishReason.isEmpty ? .null : .string(finishReason)
                    ),
                ]),
            ])),
        ]
        if let usage {
            root.append(JSONMember(key: "usage", value: .object([
                JSONMember(key: "prompt_tokens", value: .number(String(usage.prompt))),
                JSONMember(key: "completion_tokens", value: .number(String(usage.completion))),
                JSONMember(key: "total_tokens", value: .number(String(usage.total))),
            ])))
        }
        let chunks = [
            "data: \(JSONValue.object(root).serialized(pretty: false))\n\n",
            "data: [DONE]\n\n",
        ]
        return .sse(chunks: chunks, delayPerChunk: 0, terminate: true)
    }

    /// Content that ends without `[DONE]` or `finish_reason: stop`.
    static func truncated(_ content: String) -> MockSSEServer.Response {
        let root = JSONValue.object([
            JSONMember(key: "id", value: .string("chatcmpl-truncated")),
            JSONMember(key: "model", value: .string("deepseek-flash")),
            JSONMember(key: "choices", value: .array([
                .object([
                    JSONMember(key: "delta", value: .object([
                        JSONMember(key: "content", value: .string(content)),
                    ])),
                    JSONMember(key: "finish_reason", value: .null),
                ]),
            ])),
        ])
        return .sse(chunks: ["data: \(root.serialized(pretty: false))\n\n"], delayPerChunk: 0, terminate: true)
    }
}
