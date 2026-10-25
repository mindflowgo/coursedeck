import Foundation

public struct PathValidationError: Error, LocalizedError, Equatable, Sendable {
    public let message: String

    public init(_ message: String) {
        self.message = message
    }

    public var errorDescription: String? { message }
}

/// Desktop-compatible identifier and filename rules (PLAN §3.3).
public enum PathValidator {
    /// Course/lesson/prompt IDs: start alphanumeric, then alphanumerics,
    /// dot, underscore or dash, max 64 characters. Case-insensitive.
    public static let idPattern = "^[a-z0-9][a-z0-9._-]{0,63}$"
    /// Tab slugs: lowercase alphanumerics and underscores, max 32 characters.
    public static let tabPattern = "^[a-z0-9][a-z0-9_]{0,31}$"

    public static let reservedTabs: Set<String> = [
        "lesson", "notes", "summary", "cheatsheet", "test", "schedule",
        "course", "assignments", "popquiz",
    ]

    // MARK: - IDs

    public static func courseId(_ value: String) throws -> String {
        try identifier(value, kind: "course id")
    }

    public static func lessonId(_ value: String) throws -> String {
        try identifier(value, kind: "lesson id")
    }

    public static func promptId(_ value: String) throws -> String {
        try identifier(value, kind: "prompt id")
    }

    public static func normalizedCourseId(_ value: String) throws -> String {
        try Self.courseId(value).lowercased()
    }

    private static func identifier(_ value: String, kind: String) throws -> String {
        guard matches(value, pattern: idPattern, caseInsensitive: true), value != ".", value != ".." else {
            throw PathValidationError("Invalid \(kind): \(quoted(value))")
        }
        return value
    }

    public static func tab(_ value: String) throws -> String {
        guard matches(value, pattern: tabPattern) else {
            throw PathValidationError("Invalid tab: \(quoted(value))")
        }
        return value
    }

    public static func isTabSlug(_ value: String) -> Bool {
        matches(value, pattern: tabPattern)
    }

    public static func isReservedTab(_ value: String) -> Bool {
        reservedTabs.contains(value.lowercased())
    }

    /// Slugifies a user-typed tab name the same way the desktop does.
    public static func slugifyTabName(_ name: String) -> String {
        var value = name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        value = value.replacingOccurrences(of: "\\s+", with: "_", options: .regularExpression)
        value = value.replacingOccurrences(of: "[^a-z0-9_]", with: "", options: .regularExpression)
        value = value.replacingOccurrences(of: "_+", with: "_", options: .regularExpression)
        value = value.replacingOccurrences(of: "^_+|_+$", with: "", options: .regularExpression)
        return value
    }

    public static func customTabDisplayName(_ slug: String) -> String {
        slug.split(separator: "_")
            .filter { !$0.isEmpty }
            .map { $0.prefix(1).uppercased() + $0.dropFirst() }
            .joined(separator: " ")
    }

    // MARK: - Units

    public static func isUnitScopeId(_ value: String) -> Bool {
        matches(value.trimmingCharacters(in: .whitespacesAndNewlines), pattern: "^\\d+\\.unit$", caseInsensitive: true)
    }

    public static func parseUnitNumber(_ id: String) -> Int? {
        let clean = id.trimmingCharacters(in: .whitespacesAndNewlines)
        if let match = firstCapture(clean, pattern: "^(\\d+)\\.unit$", caseInsensitive: true) {
            return Int(match)
        }
        if let match = firstCapture(clean, pattern: "^(\\d+)\\.\\d+") {
            return Int(match)
        }
        if let match = firstCapture(clean, pattern: "^(\\d+)$") {
            return Int(match)
        }
        return nil
    }

    public static func formatUnitScopeId(_ unitNumber: Int) -> String {
        String(format: "%02d.unit", unitNumber)
    }

    // MARK: - Filenames (desktop `tabs.ts` semantics)

    public static func tabFileName(lessonId: String, tab: String) throws -> String {
        let lesson = try Self.lessonId(lessonId).lowercased()
        let cleanTab = try Self.tab(tab)
        return "\(lesson).\(cleanTab).md"
    }

    public static func courseDocFileName(tab: String) throws -> String {
        let cleanTab = try Self.tab(tab)
        return "course.\(cleanTab).md"
    }

    public static func unitDocFileName(unit: Int, tab: String) throws -> String {
        let cleanTab = try Self.tab(tab)
        return String(format: "%02d.unit.%@.md", unit, cleanTab)
    }

    public static func unitDocFileName(scopeId: String, tab: String) throws -> String {
        guard let number = parseUnitNumber(scopeId), isUnitScopeId(scopeId) || scopeId.allSatisfy(\.isNumber) else {
            throw PathValidationError("Invalid unit scope: \(quoted(scopeId))")
        }
        return try unitDocFileName(unit: number, tab: tab)
    }

    public static func docFileName(scope: String, tab: String, isCourseScope: Bool = false) throws -> String {
        if isCourseScope || scope.lowercased() == "course" {
            return try courseDocFileName(tab: tab)
        }
        if isUnitScopeId(scope) {
            return try unitDocFileName(scopeId: scope, tab: tab)
        }
        return try tabFileName(lessonId: scope, tab: tab)
    }

    public struct ParsedDocFileName: Equatable, Sendable {
        public var isCourseScope: Bool
        public var isUnitScope: Bool
        public var unitNumber: Int?
        public var lessonId: String
        public var tab: String
    }

    public static func parseDocFileName(_ file: String) -> ParsedDocFileName? {
        let clean = file.trimmingCharacters(in: .whitespacesAndNewlines)

        if let match = captures(clean, pattern: "^course\\.([a-z0-9_-]+)\\.md$", caseInsensitive: true) {
            return ParsedDocFileName(
                isCourseScope: true,
                isUnitScope: false,
                unitNumber: nil,
                lessonId: "course",
                tab: match[0].lowercased()
            )
        }
        if let match = captures(clean, pattern: "^(\\d+)\\.unit\\.([a-z0-9_-]+)\\.md$", caseInsensitive: true) {
            let unitNumber = Int(match[0]) ?? 0
            return ParsedDocFileName(
                isCourseScope: false,
                isUnitScope: true,
                unitNumber: unitNumber,
                lessonId: String(format: "%02d.unit", unitNumber),
                tab: match[1].lowercased()
            )
        }
        if let match = captures(clean, pattern: "^([0-9]+(?:\\.[0-9]+)?(?:_[a-z0-9]+)?)\\.([a-z0-9_-]+)\\.md$", caseInsensitive: true) {
            return ParsedDocFileName(
                isCourseScope: false,
                isUnitScope: false,
                unitNumber: nil,
                lessonId: match[0],
                tab: match[1].lowercased()
            )
        }
        return nil
    }

    /// True for a pop-quiz file: `<lessonId>.popquiz.<timestamp>.md`.
    ///
    /// Live desktop files use `YYYY-MM-DD_HH-mm-ss`; compact timestamps are
    /// also accepted for tests and older exports.
    public static func parsePopQuizFileName(_ file: String) -> (lessonId: String, timestamp: String)? {
        guard let match = captures(
            file.trimmingCharacters(in: .whitespacesAndNewlines),
            pattern: "^([0-9]+(?:\\.[0-9]+)?(?:_[a-z0-9]+)?)\\.popquiz\\.([0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{2}-[0-9]{2}-[0-9]{2}|[0-9]{8,14})\\.md$",
            caseInsensitive: true
        ) else { return nil }
        return (match[0], match[1])
    }

    // MARK: - Path containment

    /// Resolves `components` against `base` and proves the result stays inside
    /// it. This resolves symlinks and normalizes, rather than string-stripping
    /// `../`, so traversal that reappears mid-path or through a symlink fails.
    public static func safeJoin(base: URL, _ components: String...) throws -> URL {
        try safeJoin(base: base, components: components)
    }

    public static func safeJoin(base: URL, components: [String]) throws -> URL {
        let baseURL = resolveExistingPrefix(base.standardizedFileURL)
        var target = baseURL
        for component in components {
            guard !component.isEmpty else { continue }
            if component.hasPrefix("/") || component.hasPrefix("\\") {
                throw PathValidationError("Path escapes its base directory: \(components.joined(separator: "/"))")
            }
            let segments = component.split(whereSeparator: { $0 == "/" || $0 == "\\" })
            if segments.contains("..") {
                throw PathValidationError("Path escapes its base directory: \(components.joined(separator: "/"))")
            }
            for segment in segments {
                target.appendPathComponent(String(segment))
            }
        }
        let resolved = resolveExistingPrefix(target.standardizedFileURL)
        let baseComponents = baseURL.pathComponents
        let targetComponents = resolved.pathComponents
        guard targetComponents.count >= baseComponents.count,
              Array(targetComponents.prefix(baseComponents.count)) == baseComponents else {
            throw PathValidationError("Path escapes its base directory: \(components.joined(separator: "/"))")
        }
        return resolved
    }

    /// Resolves symlinks in the longest existing prefix and replays the
    /// non-existent tail. `URL.resolvingSymlinksInPath()` alone leaves an
    /// intermediate symlink unresolved when the leaf does not exist yet,
    /// which would let `<base>/link-to-outside/new-file` pass containment.
    private static func resolveExistingPrefix(_ url: URL) -> URL {
        let fileManager = FileManager.default
        var existing = url
        var trailing: [String] = []
        while !fileManager.fileExists(atPath: existing.path), existing.path != "/" {
            trailing.insert(existing.lastPathComponent, at: 0)
            existing.deleteLastPathComponent()
        }
        var resolved = existing.resolvingSymlinksInPath()
        for component in trailing {
            resolved.appendPathComponent(component)
        }
        return resolved.standardizedFileURL
    }

    public static func trySafeJoin(base: URL, _ components: String...) -> URL? {
        try? safeJoin(base: base, components: components)
    }

    // MARK: - Regex helpers

    private static func matches(_ value: String, pattern: String, caseInsensitive: Bool = false) -> Bool {
        guard let range = matchRange(value, pattern: pattern, caseInsensitive: caseInsensitive) else {
            return false
        }
        // Anchors alone would accept a trailing newline in ICU; require the
        // match to consume the entire string.
        return range.lowerBound == value.startIndex && range.upperBound == value.endIndex
    }

    private static func matchRange(_ value: String, pattern: String, caseInsensitive: Bool) -> Range<String.Index>? {
        let options: String.CompareOptions = caseInsensitive
            ? [.regularExpression, .caseInsensitive]
            : [.regularExpression]
        return value.range(of: pattern, options: options)
    }

    private static func captures(_ value: String, pattern: String, caseInsensitive: Bool) -> [String]? {
        let options: NSRegularExpression.Options = caseInsensitive ? [.caseInsensitive] : []
        guard let regex = try? NSRegularExpression(pattern: pattern, options: options) else { return nil }
        let range = NSRange(value.startIndex..<value.endIndex, in: value)
        guard let match = regex.firstMatch(in: value, options: [], range: range),
              match.range == range else { return nil }
        var groups: [String] = []
        for index in 1..<match.numberOfRanges {
            guard let groupRange = Range(match.range(at: index), in: value) else { return nil }
            groups.append(String(value[groupRange]))
        }
        return groups
    }

    private static func firstCapture(_ value: String, pattern: String, caseInsensitive: Bool = false) -> String? {
        captures(value, pattern: pattern, caseInsensitive: caseInsensitive)?.first
    }

    private static func quoted(_ value: String) -> String {
        "\"" + value + "\""
    }
}

/// The timestamp shape used by `parsePopQuizFileName` and the desktop data.
public enum PopQuizTimestamp {
    public static func string(_ date: Date = Date()) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyy-MM-dd_HH-mm-ss"
        return formatter.string(from: date)
    }
}
