import Foundation

/// Desktop checkpoint schema (`checkpoint.json` is a top-level JSON array).
///
/// New iOS checkpoints always carry both the legacy measured
/// `verticalPosition` (cumulative block height in pixels) and the stable
/// `anchorBlockID` / `anchorFraction` pair, so the desktop can still resume
/// and the iPad can restore a scroll position after a re-layout.
public struct Checkpoint: Equatable, Sendable {
    public enum Kind: Equatable, Sendable {
        case note
        case position
        case other(String)

        public init(raw: String) {
            switch raw.lowercased() {
            case "note": self = .note
            case "position": self = .position
            default: self = .other(raw)
            }
        }

        public var rawValue: String {
            switch self {
            case .note: return "note"
            case .position: return "position"
            case let .other(value): return value
            }
        }
    }

    public var id: String
    public var courseId: String?
    public var file: String
    public var verticalPosition: Double
    public var type: Kind
    public var color: String?
    public var noteText: String?
    public var date: String
    public var anchorBlockID: String?
    public var anchorFraction: Double?
    public var extras: [JSONMember]

    public init(
        id: String,
        courseId: String? = nil,
        file: String,
        verticalPosition: Double,
        type: Kind,
        color: String? = nil,
        noteText: String? = nil,
        date: String,
        anchorBlockID: String? = nil,
        anchorFraction: Double? = nil,
        extras: [JSONMember] = []
    ) {
        self.id = id
        self.courseId = courseId
        self.file = file
        self.verticalPosition = verticalPosition
        self.type = type
        self.color = color
        self.noteText = noteText
        self.date = date
        self.anchorBlockID = anchorBlockID
        self.anchorFraction = anchorFraction
        self.extras = extras
    }

    private static let knownKeys: Set<String> = [
        "id", "courseId", "file", "verticalPosition", "type", "color", "noteText",
        "date", "anchorBlockID", "anchorFraction",
    ]

    /// Returns nil when the object is missing a required desktop field. Such
    /// entries are kept as raw passthrough by `CheckpointDocument` instead of
    /// being silently dropped on the next save.
    public init?(json: JSONValue) {
        guard case let .object(members) = json else { return nil }
        var id: String?
        var courseId: String?
        var file: String?
        var verticalPosition: Double?
        var type: Kind?
        var color: String?
        var noteText: String?
        var date = ""
        var anchorBlockID: String?
        var anchorFraction: Double?
        var extras: [JSONMember] = []

        for member in members {
            switch member.key {
            case "id": id = member.value.stringValue
            case "courseId": courseId = member.value.stringValue
            case "file": file = member.value.stringValue
            case "verticalPosition": verticalPosition = member.value.doubleValue
            case "type": type = member.value.stringValue.map(Kind.init(raw:))
            case "color": color = member.value.stringValue
            case "noteText": noteText = member.value.stringValue
            case "date": date = member.value.stringValue ?? ""
            case "anchorBlockID": anchorBlockID = member.value.stringValue
            case "anchorFraction": anchorFraction = member.value.doubleValue
            default:
                if !Self.knownKeys.contains(member.key) { extras.append(member) }
            }
        }

        guard let id, !id.isEmpty,
              let file, !file.isEmpty,
              let verticalPosition,
              verticalPosition.isFinite,
              (anchorFraction == nil || anchorFraction?.isFinite == true),
              !file.contains("/"),
              !file.contains("\\"),
              PathValidator.parseDocFileName(file) != nil,
              let type else { return nil }

        self.init(
            id: id,
            courseId: courseId,
            file: file,
            verticalPosition: verticalPosition,
            type: type,
            color: color,
            noteText: noteText,
            date: date,
            anchorBlockID: anchorBlockID,
            anchorFraction: anchorFraction,
            extras: extras
        )
    }

    public var json: JSONValue {
        var members: [JSONMember] = [JSONMember(key: "id", value: .string(id))]
        if let courseId { members.append(JSONMember(key: "courseId", value: .string(courseId))) }
        members.append(JSONMember(key: "file", value: .string(file)))
        members.append(JSONMember(key: "verticalPosition", value: Self.number(verticalPosition)))
        members.append(JSONMember(key: "type", value: .string(type.rawValue)))
        if let color { members.append(JSONMember(key: "color", value: .string(color))) }
        if let noteText { members.append(JSONMember(key: "noteText", value: .string(noteText))) }
        members.append(JSONMember(key: "date", value: .string(date)))
        if let anchorBlockID { members.append(JSONMember(key: "anchorBlockID", value: .string(anchorBlockID))) }
        if let anchorFraction { members.append(JSONMember(key: "anchorFraction", value: Self.number(anchorFraction))) }
        let known = Set(members.map(\.key))
        members.append(contentsOf: extras.filter { !known.contains($0.key) })
        return .object(members)
    }

    /// `JSON.stringify` writes integral doubles without a trailing `.0`, which
    /// keeps the desktop's numeric schema intact.
    static func number(_ value: Double) -> JSONValue {
        guard value.isFinite else { return .number("0") }
        if value == value.rounded(), abs(value) < 9_007_199_254_740_992 {
            return .number(String(Int64(value)))
        }
        return .number(String(value))
    }
}

/// The full `checkpoint.json` payload: decoded checkpoints plus any array
/// entries that did not match the desktop schema. Passthrough entries survive
/// a read-modify-write so a newer desktop feature cannot lose data here.
public struct CheckpointDocument: Equatable, Sendable {
    public var checkpoints: [Checkpoint]
    public var passthrough: [JSONValue]

    public init(checkpoints: [Checkpoint] = [], passthrough: [JSONValue] = []) {
        self.checkpoints = checkpoints
        self.passthrough = passthrough
    }

    public init(data: Data) throws {
        let parsed = try JSONValue(parsing: data)
        guard let values = parsed.arrayValue else { throw CheckpointError.notAnArray }
        var checkpoints: [Checkpoint] = []
        var passthrough: [JSONValue] = []
        for value in values {
            if let checkpoint = Checkpoint(json: value) {
                checkpoints.append(checkpoint)
            } else {
                passthrough.append(value)
            }
        }
        self.checkpoints = checkpoints
        self.passthrough = passthrough
    }

    public var json: JSONValue {
        .array(checkpoints.map(\.json) + passthrough)
    }

    public func encoded(pretty: Bool = true) -> Data {
        json.serializedData(pretty: pretty)
    }
}

public enum CheckpointError: Error, LocalizedError, Equatable {
    case notAnArray
    case invalidFile(String)
    case writeBlocked(String)

    public var errorDescription: String? {
        switch self {
        case .notAnArray: return "checkpoint.json must be a top-level JSON array."
        case let .invalidFile(file): return "Invalid checkpoint file reference: \(file)"
        case let .writeBlocked(reason): return "Writes are blocked: \(reason)"
        }
    }
}

/// Stable block identifiers for `anchorBlockID`. The anchor is deterministic
/// (heading slug + ordinal within the section, otherwise a content hash plus
/// occurrence index), so it survives a reparse and small edits.
public enum BlockAnchor {
    public static func headingAnchor(headingText: String, ordinal: Int) -> String {
        "h:\(slug(headingText)):\(ordinal)"
    }

    public static func contentAnchor(normalizedText: String, occurrence: Int) -> String {
        "c:\(fnv1a64(normalizedText)):\(occurrence)"
    }

    public static func slug(_ text: String) -> String {
        let lowered = text.lowercased()
        var output = ""
        var lastWasDash = true
        for scalar in lowered.unicodeScalars {
            let isASCIIAlnum = (scalar.value >= 97 && scalar.value <= 122) || (scalar.value >= 48 && scalar.value <= 57)
            if isASCIIAlnum {
                output.unicodeScalars.append(scalar)
                lastWasDash = false
            } else if !lastWasDash {
                output.append("-")
                lastWasDash = true
            }
        }
        if output.hasSuffix("-") { output.removeLast() }
        return output.isEmpty ? "section" : output
    }

    /// 64-bit FNV-1a. Stable across process runs and platforms (unlike
    /// `String.hashValue`), which is what a persisted anchor needs.
    public static func fnv1a64(_ text: String) -> String {
        var hash: UInt64 = 0xcbf29ce484222325
        for byte in text.utf8 {
            hash ^= UInt64(byte)
            hash = hash &* 0x100000001b3
        }
        return String(hash, radix: 16)
    }

    /// Computes the desktop-compatible `verticalPosition` for a checkpoint:
    /// the cumulative measured height of all preceding blocks plus
    /// `anchorFraction × currentBlockHeight`.
    public static func verticalPosition(precedingHeight: Double, currentBlockHeight: Double, anchorFraction: Double) -> Double {
        max(0, precedingHeight + min(max(anchorFraction, 0), 1) * max(0, currentBlockHeight))
    }
}
