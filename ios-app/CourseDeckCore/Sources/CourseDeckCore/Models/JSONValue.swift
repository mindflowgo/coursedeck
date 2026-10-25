import Foundation

/// An ordered, lossless-enough JSON value used for every persisted desktop
/// file. `meta.json`, `checkpoint.json`, `llm_config.json` and the job journal
/// must survive a roundtrip through the iPad app without dropping unknown keys
/// or reordering the fields the desktop wrote, so we parse into this model
/// instead of `JSONSerialization` (which loses order) or `Codable` structs
/// (which lose unknown keys).
public enum JSONValue: Equatable, Sendable {
    case object([JSONMember])
    case array([JSONValue])
    case string(String)
    /// The raw number lexeme is kept so `1`, `1.0` and `1e3` roundtrip
    /// unchanged. Use `doubleValue` / `intValue` for arithmetic.
    case number(String)
    case bool(Bool)
    case null

    public init(_ value: String) { self = .string(value) }
    public init(_ value: Int) { self = .number(String(value)) }
    public init(_ value: Double) {
        if value.isFinite, value == value.rounded(), abs(value) < 9_007_199_254_740_992 {
            self = .number(String(Int64(value)))
        } else {
            self = .number(String(value))
        }
    }
    public init(_ value: Bool) { self = .bool(value) }

    public var objectValue: [JSONMember]? {
        if case let .object(members) = self { return members }
        return nil
    }

    public var arrayValue: [JSONValue]? {
        if case let .array(values) = self { return values }
        return nil
    }

    public var stringValue: String? {
        if case let .string(value) = self { return value }
        return nil
    }

    public var boolValue: Bool? {
        if case let .bool(value) = self { return value }
        return nil
    }

    public var intValue: Int? {
        switch self {
        case let .number(raw):
            return Int(raw) ?? Double(raw).flatMap { Int(exactly: $0.rounded()) }
        case let .string(raw):
            return Int(raw)
        default:
            return nil
        }
    }

    public var doubleValue: Double? {
        switch self {
        case let .number(raw): return Double(raw)
        case let .string(raw): return Double(raw)
        default: return nil
        }
    }

    public var isNull: Bool {
        if case .null = self { return true }
        return false
    }

    /// Member lookup. The first occurrence wins; duplicate keys are preserved
    /// verbatim by the parser for roundtrip fidelity.
    public subscript(key: String) -> JSONValue? {
        get {
            guard case let .object(members) = self else { return nil }
            return members.first(where: { $0.key == key })?.value
        }
        set {
            guard case var .object(members) = self else { return }
            guard let newValue else {
                members.removeAll { $0.key == key }
                self = .object(members)
                return
            }
            if let index = members.firstIndex(where: { $0.key == key }) {
                members[index].value = newValue
            } else {
                members.append(JSONMember(key: key, value: newValue))
            }
            self = .object(members)
        }
    }

    public subscript(index: Int) -> JSONValue? {
        guard case let .array(values) = self, values.indices.contains(index) else { return nil }
        return values[index]
    }

    /// Replaces or appends a member while keeping the original position of a
    /// known key and leaving the relative order of unknown keys untouched.
    public mutating func setMember(_ key: String, _ value: JSONValue) {
        self[key] = value
    }

    public func member(_ key: String) -> JSONMember? {
        guard case let .object(members) = self else { return nil }
        return members.first(where: { $0.key == key })
    }

    /// Serializes with the same 2-space layout the desktop's
    /// `JSON.stringify(value, null, 2)` produces.
    public func serialized(pretty: Bool = true) -> String {
        var output = ""
        write(to: &output, indent: 0, pretty: pretty)
        return output
    }

    public func serializedData(pretty: Bool = true) -> Data {
        Data(serialized(pretty: pretty).utf8)
    }

    private func write(to output: inout String, indent: Int, pretty: Bool) {
        switch self {
        case let .object(members):
            if members.isEmpty {
                output += "{}"
                return
            }
            output += "{"
            for (index, member) in members.enumerated() {
                if index > 0 { output += "," }
                if pretty {
                    output += "\n" + String(repeating: " ", count: (indent + 1) * 2)
                }
                Self.writeString(member.key, to: &output)
                output += pretty ? ": " : ":"
                member.value.write(to: &output, indent: indent + 1, pretty: pretty)
            }
            if pretty {
                output += "\n" + String(repeating: " ", count: indent * 2)
            }
            output += "}"
        case let .array(values):
            if values.isEmpty {
                output += "[]"
                return
            }
            output += "["
            for (index, value) in values.enumerated() {
                if index > 0 { output += "," }
                if pretty {
                    output += "\n" + String(repeating: " ", count: (indent + 1) * 2)
                }
                value.write(to: &output, indent: indent + 1, pretty: pretty)
            }
            if pretty {
                output += "\n" + String(repeating: " ", count: indent * 2)
            }
            output += "]"
        case let .string(value):
            Self.writeString(value, to: &output)
        case let .number(raw):
            output += raw
        case let .bool(value):
            output += value ? "true" : "false"
        case .null:
            output += "null"
        }
    }

    private static func writeString(_ value: String, to output: inout String) {
        output += "\""
        for scalar in value.unicodeScalars {
            switch scalar {
            case "\"": output += "\\\""
            case "\\": output += "\\\\"
            case "\n": output += "\\n"
            case "\r": output += "\\r"
            case "\t": output += "\\t"
            case "\u{08}": output += "\\b"
            case "\u{0C}": output += "\\f"
            default:
                if scalar.value < 0x20 {
                    output += String(format: "\\u%04x", scalar.value)
                } else {
                    output.unicodeScalars.append(scalar)
                }
            }
        }
        output += "\""
    }

    // MARK: - Parsing

    public init(parsing data: Data) throws {
        var parser = JSONParser(bytes: Array(data), isUTF8: true)
        self = try parser.parseDocument()
    }

    public init(parsing string: String) throws {
        self = try JSONValue(parsing: Data(string.utf8))
    }
}

public struct JSONMember: Equatable, Sendable {
    public var key: String
    public var value: JSONValue

    public init(key: String, value: JSONValue) {
        self.key = key
        self.value = value
    }
}

public enum JSONParseError: Error, LocalizedError, Equatable {
    case unexpectedEnd
    case unexpectedCharacter(offset: Int)
    case invalidNumber(offset: Int)
    case invalidEscape(offset: Int)
    case invalidUnicodeEscape(offset: Int)
    case trailingData(offset: Int)
    case depthExceeded(offset: Int)

    public var errorDescription: String? {
        switch self {
        case .unexpectedEnd: return "Unexpected end of JSON input."
        case let .unexpectedCharacter(offset): return "Unexpected character at byte \(offset)."
        case let .invalidNumber(offset): return "Invalid number at byte \(offset)."
        case let .invalidEscape(offset): return "Invalid escape sequence at byte \(offset)."
        case let .invalidUnicodeEscape(offset): return "Invalid unicode escape at byte \(offset)."
        case let .trailingData(offset): return "Unexpected trailing data at byte \(offset)."
        case let .depthExceeded(offset): return "JSON nesting depth exceeded at byte \(offset)."
        }
    }
}

private struct JSONParser {
    let bytes: [UInt8]
    let isUTF8: Bool
    var index = 0
    var depth = 0
    static let maxDepth = 512

    init(bytes: [UInt8], isUTF8: Bool) {
        self.bytes = bytes
        self.isUTF8 = isUTF8
    }

    mutating func parseDocument() throws -> JSONValue {
        skipWhitespace()
        let value = try parseValue()
        skipWhitespace()
        guard index == bytes.count else { throw JSONParseError.trailingData(offset: index) }
        return value
    }

    mutating func parseValue() throws -> JSONValue {
        skipWhitespace()
        guard index < bytes.count else { throw JSONParseError.unexpectedEnd }
        depth += 1
        defer { depth -= 1 }
        guard depth <= Self.maxDepth else { throw JSONParseError.depthExceeded(offset: index) }

        switch bytes[index] {
        case UInt8(ascii: "{"): return try parseObject()
        case UInt8(ascii: "["): return try parseArray()
        case UInt8(ascii: "\""): return .string(try parseString())
        case UInt8(ascii: "t"):
            try expect("true")
            return .bool(true)
        case UInt8(ascii: "f"):
            try expect("false")
            return .bool(false)
        case UInt8(ascii: "n"):
            try expect("null")
            return .null
        case UInt8(ascii: "-"), UInt8(ascii: "0")...UInt8(ascii: "9"):
            return .number(try parseNumber())
        default:
            throw JSONParseError.unexpectedCharacter(offset: index)
        }
    }

    mutating func parseObject() throws -> JSONValue {
        index += 1
        skipWhitespace()
        var members: [JSONMember] = []
        if index < bytes.count, bytes[index] == UInt8(ascii: "}") {
            index += 1
            return .object(members)
        }
        while true {
            skipWhitespace()
            guard index < bytes.count, bytes[index] == UInt8(ascii: "\"") else {
                throw JSONParseError.unexpectedCharacter(offset: index)
            }
            let key = try parseString()
            skipWhitespace()
            guard index < bytes.count, bytes[index] == UInt8(ascii: ":") else {
                throw JSONParseError.unexpectedCharacter(offset: index)
            }
            index += 1
            let value = try parseValue()
            members.append(JSONMember(key: key, value: value))
            skipWhitespace()
            guard index < bytes.count else { throw JSONParseError.unexpectedEnd }
            if bytes[index] == UInt8(ascii: ",") {
                index += 1
                continue
            }
            if bytes[index] == UInt8(ascii: "}") {
                index += 1
                return .object(members)
            }
            throw JSONParseError.unexpectedCharacter(offset: index)
        }
    }

    mutating func parseArray() throws -> JSONValue {
        index += 1
        skipWhitespace()
        var values: [JSONValue] = []
        if index < bytes.count, bytes[index] == UInt8(ascii: "]") {
            index += 1
            return .array(values)
        }
        while true {
            values.append(try parseValue())
            skipWhitespace()
            guard index < bytes.count else { throw JSONParseError.unexpectedEnd }
            if bytes[index] == UInt8(ascii: ",") {
                index += 1
                continue
            }
            if bytes[index] == UInt8(ascii: "]") {
                index += 1
                return .array(values)
            }
            throw JSONParseError.unexpectedCharacter(offset: index)
        }
    }

    mutating func parseString() throws -> String {
        index += 1 // opening quote
        var scalars = String.UnicodeScalarView()
        while index < bytes.count {
            let byte = bytes[index]
            if byte == UInt8(ascii: "\"") {
                index += 1
                return String(scalars)
            }
            if byte == UInt8(ascii: "\\") {
                index += 1
                guard index < bytes.count else { throw JSONParseError.unexpectedEnd }
                switch bytes[index] {
                case UInt8(ascii: "\""): scalars.append("\"")
                case UInt8(ascii: "\\"): scalars.append("\\")
                case UInt8(ascii: "/"): scalars.append("/")
                case UInt8(ascii: "b"): scalars.append("\u{08}")
                case UInt8(ascii: "f"): scalars.append("\u{0C}")
                case UInt8(ascii: "n"): scalars.append("\n")
                case UInt8(ascii: "r"): scalars.append("\r")
                case UInt8(ascii: "t"): scalars.append("\t")
                case UInt8(ascii: "u"):
                    let scalar = try parseUnicodeEscape()
                    scalars.append(scalar)
                    continue
                default:
                    throw JSONParseError.invalidEscape(offset: index)
                }
                index += 1
                continue
            }
            if byte < 0x20 {
                throw JSONParseError.unexpectedCharacter(offset: index)
            }
            // Decode one UTF-8 code point, or pass bytes through as Latin-1
            // if the input was not valid UTF-8 (desktop files always are).
            let (scalar, length) = try decodeUTF8Scalar(at: index)
            scalars.append(scalar)
            index += length
        }
        throw JSONParseError.unexpectedEnd
    }

    mutating func parseUnicodeEscape() throws -> Unicode.Scalar {
        index += 1
        guard let high = try readHex4() else { throw JSONParseError.invalidUnicodeEscape(offset: index) }
        if high >= 0xD800, high <= 0xDBFF {
            guard index + 1 < bytes.count,
                  bytes[index] == UInt8(ascii: "\\"),
                  bytes[index + 1] == UInt8(ascii: "u") else {
                throw JSONParseError.invalidUnicodeEscape(offset: index)
            }
            index += 2
            guard let low = try readHex4(), low >= 0xDC00, low <= 0xDFFF else {
                throw JSONParseError.invalidUnicodeEscape(offset: index)
            }
            let value = 0x10000 + ((UInt32(high) - 0xD800) << 10) + (UInt32(low) - 0xDC00)
            guard let scalar = Unicode.Scalar(value) else {
                throw JSONParseError.invalidUnicodeEscape(offset: index)
            }
            return scalar
        }
        guard let scalar = Unicode.Scalar(UInt32(high)) else {
            throw JSONParseError.invalidUnicodeEscape(offset: index)
        }
        return scalar
    }

    mutating func readHex4() throws -> Int? {
        guard index + 4 <= bytes.count else { return nil }
        var value = 0
        for offset in 0..<4 {
            let byte = bytes[index + offset]
            let digit: Int
            switch byte {
            case UInt8(ascii: "0")...UInt8(ascii: "9"): digit = Int(byte - UInt8(ascii: "0"))
            case UInt8(ascii: "a")...UInt8(ascii: "f"): digit = Int(byte - UInt8(ascii: "a")) + 10
            case UInt8(ascii: "A")...UInt8(ascii: "F"): digit = Int(byte - UInt8(ascii: "A")) + 10
            default: return nil
            }
            value = value * 16 + digit
        }
        index += 4
        return value
    }

    mutating func decodeUTF8Scalar(at offset: Int) throws -> (Unicode.Scalar, Int) {
        guard let first = Unicode.Scalar(UInt32(bytes[offset])) else {
            throw JSONParseError.unexpectedCharacter(offset: offset)
        }
        if first.value < 0x80 {
            return (first, 1)
        }
        guard isUTF8 else { return (first, 1) }
        // Reuse Foundation's decoder for multi-byte scalars.
        let maxLength = min(4, bytes.count - offset)
        for length in stride(from: maxLength, through: 2, by: -1) {
            if let string = String(bytes: bytes[offset..<(offset + length)], encoding: .utf8),
               let scalar = string.unicodeScalars.first,
               string.unicodeScalars.count == 1 {
                return (scalar, length)
            }
        }
        return (first, 1)
    }

    mutating func parseNumber() throws -> String {
        let start = index
        if index < bytes.count, bytes[index] == UInt8(ascii: "-") { index += 1 }
        guard index < bytes.count, (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(bytes[index]) else {
            throw JSONParseError.invalidNumber(offset: start)
        }
        if bytes[index] == UInt8(ascii: "0") {
            index += 1
        } else {
            while index < bytes.count, (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(bytes[index]) {
                index += 1
            }
        }
        if index < bytes.count, bytes[index] == UInt8(ascii: ".") {
            index += 1
            let fractionStart = index
            while index < bytes.count, (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(bytes[index]) {
                index += 1
            }
            guard index > fractionStart else { throw JSONParseError.invalidNumber(offset: start) }
        }
        if index < bytes.count, bytes[index] == UInt8(ascii: "e") || bytes[index] == UInt8(ascii: "E") {
            index += 1
            if index < bytes.count, bytes[index] == UInt8(ascii: "+") || bytes[index] == UInt8(ascii: "-") {
                index += 1
            }
            let exponentStart = index
            while index < bytes.count, (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(bytes[index]) {
                index += 1
            }
            guard index > exponentStart else { throw JSONParseError.invalidNumber(offset: start) }
        }
        return String(decoding: bytes[start..<index], as: UTF8.self)
    }

    mutating func expect(_ literal: String) throws {
        let literalBytes = Array(literal.utf8)
        guard index + literalBytes.count <= bytes.count,
              Array(bytes[index..<(index + literalBytes.count)]) == literalBytes else {
            throw JSONParseError.unexpectedCharacter(offset: index)
        }
        index += literalBytes.count
    }

    mutating func skipWhitespace() {
        while index < bytes.count {
            switch bytes[index] {
            case 0x20, 0x09, 0x0A, 0x0D:
                index += 1
            default:
                return
            }
        }
    }
}
