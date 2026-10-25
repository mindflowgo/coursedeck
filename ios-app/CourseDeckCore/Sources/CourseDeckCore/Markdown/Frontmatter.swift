import Foundation
import Yams

/// Ordered, untyped YAML frontmatter. The desktop stores arbitrary user keys
/// (activity codes, quiz scores, schedule preferences) and expects them back;
/// we therefore keep the mapping as an ordered pair list and only touch the
/// keys a caller explicitly updates (PLAN §3.2).
public enum YAMLValue: Equatable, Sendable {
    case scalar(String)
    case sequence([YAMLValue])
    case mapping([YAMLPair])

    public var stringValue: String? {
        if case let .scalar(value) = self { return value }
        return nil
    }

    public var intValue: Int? {
        if case let .scalar(value) = self { return Int(value) }
        return nil
    }

    public var doubleValue: Double? {
        if case let .scalar(value) = self { return Double(value) }
        return nil
    }

    public subscript(key: String) -> YAMLValue? {
        guard case let .mapping(pairs) = self else { return nil }
        return pairs.first(where: { $0.key == key })?.value
    }
}

public struct YAMLPair: Equatable, Sendable {
    public var key: String
    public var value: YAMLValue

    public init(key: String, value: YAMLValue) {
        self.key = key
        self.value = value
    }
}

public enum FrontmatterError: Error, LocalizedError, Equatable {
    case invalidYAML(String)

    public var errorDescription: String? {
        switch self {
        case let .invalidYAML(reason): return "Invalid YAML frontmatter: \(reason)"
        }
    }
}

public struct FrontmatterDocument: Equatable, Sendable {
    public var entries: [YAMLPair]
    public var body: String
    public var hadFrontmatter: Bool

    public static let knownKeys: Set<String> = [
        "prompt", "type", "version", "updatedAt", "title",
        "activityCode", "courseId", "unit", "unitNumber", "lessonNumber", "savedAt",
        "contextAttachment", "preferences", "lastAttemptDate", "score",
        "totalQuestions", "percentage", "course", "lesson", "timestamp", "createdAt",
    ]

    public init(entries: [YAMLPair] = [], body: String, hadFrontmatter: Bool = false) {
        self.entries = entries
        self.body = body
        self.hadFrontmatter = hadFrontmatter
    }

    /// Parses `---\n...\n---\n\nbody`. Malformed YAML is surfaced, not
    /// silently discarded, so callers can quarantine or fall back.
    public init(parsing content: String) throws {
        let pattern = "^---\\s*\\n([\\s\\S]*?)\\n---\\s*\\n*([\\s\\S]*)$"
        guard let regex = try? NSRegularExpression(pattern: pattern),
              let match = regex.firstMatch(
                in: content,
                options: [],
                range: NSRange(content.startIndex..<content.endIndex, in: content)
              ) else {
            self.init(entries: [], body: content.trimmingCharacters(in: .whitespacesAndNewlines), hadFrontmatter: false)
            return
        }

        let yamlRange = Range(match.range(at: 1), in: content)
        let bodyRange = Range(match.range(at: 2), in: content)
        let yaml = yamlRange.map { String(content[$0]) } ?? ""
        let body = bodyRange.map { String(content[$0]) } ?? ""

        var entries: [YAMLPair] = []
        if !yaml.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            guard let node = try Yams.compose(yaml: yaml) else {
                throw FrontmatterError.invalidYAML("empty document")
            }
            entries = Self.pairs(from: node)
        }

        self.init(
            entries: entries,
            body: body.trimmingCharacters(in: .whitespacesAndNewlines),
            hadFrontmatter: true
        )
    }

    public func value(forKey key: String) -> YAMLValue? {
        entries.first(where: { $0.key == key })?.value
    }

    public mutating func setValue(_ value: YAMLValue, forKey key: String) {
        if let index = entries.firstIndex(where: { $0.key == key }) {
            entries[index].value = value
        } else {
            entries.append(YAMLPair(key: key, value: value))
        }
        hadFrontmatter = true
    }

    public mutating func removeValue(forKey key: String) {
        entries.removeAll { $0.key == key }
    }

    /// Fresh document body without a frontmatter block.
    public var serializedBody: String {
        body + "\n"
    }

    /// Serializes ordered frontmatter plus body. Only called when frontmatter
    /// exists (or was explicitly added), so a plain lesson file stays plain.
    public func serialized() throws -> String {
        guard hadFrontmatter || !entries.isEmpty else {
            return body + "\n"
        }
        let node = Node(entries.map { (Node($0.key), Self.node(for: $0.value)) })
        let yaml = try Yams.serialize(node: node, width: -1, allowUnicode: true)
        let normalizedYAML = yaml.hasSuffix("\n") ? yaml : yaml + "\n"
        return "---\n\(normalizedYAML)---\n\n\(body.trimmingCharacters(in: .whitespacesAndNewlines))\n"
    }

    // MARK: - Conversion

    private static func pairs(from node: Node) -> [YAMLPair] {
        guard let mapping = node.mapping else {
            return []
        }
        return mapping.map { pair in
            YAMLPair(
                key: pair.key.string ?? String(describing: pair.key),
                value: value(from: pair.value)
            )
        }
    }

    private static func value(from node: Node) -> YAMLValue {
        switch node {
        case let .scalar(scalar):
            return .scalar(scalar.string)
        case let .sequence(sequence):
            return .sequence(sequence.map { value(from: $0) })
        case let .mapping(mapping):
            return .mapping(mapping.map { pair in
                YAMLPair(
                    key: pair.key.string ?? String(describing: pair.key),
                    value: value(from: pair.value)
                )
            })
        case let .alias(alias):
            return .scalar(alias.anchor.rawValue)
        }
    }

    private static func node(for value: YAMLValue) -> Node {
        switch value {
        case let .scalar(scalar):
            return Node(scalar)
        case let .sequence(values):
            return Node(values.map { node(for: $0) })
        case let .mapping(pairs):
            return Node(pairs.map { (Node($0.key), node(for: $0.value)) })
        }
    }
}
