import Foundation

public struct SSEEvent: Equatable, Sendable {
    public var event: String?
    public var data: String
    public var id: String?

    public init(event: String? = nil, data: String, id: String? = nil) {
        self.event = event
        self.data = data
        self.id = id
    }
}

/// Incremental Server-Sent Events parser. Feed arbitrary text chunks; complete
/// events are returned as soon as their terminating blank line arrives. A
/// truncated final line is flushed by `finish()` so the client can decide that
/// a partial JSON chunk is a failure rather than silently accepting it.
public struct SSEParser: Sendable {
    private var buffer = ""
    private var dataLines: [String] = []
    private var eventName: String?
    private var eventID: String?

    public init() {}

    public mutating func feed(_ chunk: String) -> [SSEEvent] {
        buffer += chunk
        var events: [SSEEvent] = []
        // Iterate Unicode scalars: Swift Characters treat CRLF as one grapheme
        // cluster, which would hide the blank line that terminates an event.
        while let lineBreak = buffer.unicodeScalars.firstIndex(where: { $0 == "\n" || $0 == "\r" }) {
            let line = String(buffer[buffer.startIndex..<lineBreak])
            let scalar = buffer.unicodeScalars[lineBreak]
            var next = buffer.unicodeScalars.index(after: lineBreak)
            if scalar == "\r",
               next < buffer.unicodeScalars.endIndex,
               buffer.unicodeScalars[next] == "\n" {
                next = buffer.unicodeScalars.index(after: next)
            }
            buffer = String(buffer[next...])
            if let event = consume(line: line) {
                events.append(event)
            }
        }
        return events
    }

    /// Flushes the last unterminated line and any pending event. Used at EOF to
    /// make truncation observable instead of silently dropping a partial chunk.
    public mutating func finish() -> [SSEEvent] {
        var events: [SSEEvent] = []
        if !buffer.isEmpty {
            let line = buffer
            buffer = ""
            if let event = consume(line: line) {
                events.append(event)
            }
        }
        if let event = flush() {
            events.append(event)
        }
        return events
    }

    private mutating func consume(line: String) -> SSEEvent? {
        if line.isEmpty {
            return flush()
        }
        if line.hasPrefix(":") {
            return nil
        }
        let field: String
        var value: String
        if let colon = line.firstIndex(of: ":") {
            field = String(line[line.startIndex..<colon])
            value = String(line[line.index(after: colon)...])
            if value.hasPrefix(" ") { value.removeFirst() }
        } else {
            field = line
            value = ""
        }

        switch field {
        case "data":
            dataLines.append(value)
        case "event":
            eventName = value
        case "id":
            eventID = value
        default:
            break
        }
        return nil
    }

    private mutating func flush() -> SSEEvent? {
        guard !dataLines.isEmpty else {
            eventName = nil
            eventID = nil
            return nil
        }
        let event = SSEEvent(
            event: eventName,
            data: dataLines.joined(separator: "\n"),
            id: eventID
        )
        dataLines.removeAll(keepingCapacity: true)
        eventName = nil
        eventID = nil
        return event
    }
}
