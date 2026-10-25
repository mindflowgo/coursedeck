import Foundation

// MARK: - USERNOTE protection

/// Existing `[!USERNOTE]` cards are read-only in v1 and must survive every
/// generation/overwrite path (PLAN §4.5/§4.9). The card body is user data, not
/// model output.
public struct UserNoteBlock: Equatable, Sendable {
    public var query: String
    public var target: String?
    public var lines: [String]

    public init(query: String, target: String?, lines: [String]) {
        self.query = query
        self.target = target
        self.lines = lines
    }

    public var text: String { lines.joined(separator: "\n") }

    var identity: String {
        "\(query)\u{1F}\(target ?? "")"
    }
}

public enum UserNoteProtector {
    /// Splits USERNOTE cards out of a document. The returned content has the
    /// cards removed (blank lines collapse) and is safe to replace.
    public static func split(_ content: String) -> (content: String, notes: [UserNoteBlock]) {
        let lines = content.components(separatedBy: "\n")
        var output: [String] = []
        var notes: [UserNoteBlock] = []
        var index = 0

        while index < lines.count {
            if let query = markerQuery(lines[index]) {
                var block = [lines[index]]
                var cursor = index + 1
                while cursor < lines.count, isQuoted(lines[cursor]) {
                    block.append(lines[cursor])
                    cursor += 1
                }
                let raw = block.joined(separator: "\n")
                notes.append(UserNoteBlock(
                    query: query,
                    target: extractTarget(raw),
                    lines: block
                ))
                // Remove the card without leaving its blank-line footprint.
                if let last = output.last, last.trimmingCharacters(in: .whitespaces).isEmpty {
                    output.removeLast()
                }
                output.append("")
                index = cursor
                continue
            }
            output.append(lines[index])
            index += 1
        }

        return (collapseBlankLines(output.joined(separator: "\n")), notes)
    }

    /// Re-attaches notes after the paragraph containing their target quote. A
    /// note whose target cannot be found is appended at the end rather than
    /// dropped.
    public static func merge(
        _ notes: [UserNoteBlock],
        into content: String
    ) -> (content: String, inserted: Int, appended: Int) {
        guard !notes.isEmpty else { return (content, 0, 0) }
        let existingIdentities = Set(split(content).notes.map(\.identity))
        var working = content
        var inserted = 0
        var appended = 0

        for note in notes where !existingIdentities.contains(note.identity) {
            if let range = insertionRange(for: note, in: working) {
                let prefix = working[..<range.upperBound]
                let suffix = working[range.upperBound...]
                working = String(prefix) + "\n\n" + note.text + "\n\n" + String(suffix)
                inserted += 1
            } else {
                working = working.trimmingCharacters(in: .whitespacesAndNewlines)
                    + "\n\n" + note.text + "\n"
                appended += 1
            }
        }

        return (collapseBlankLines(working), inserted, appended)
    }

    // MARK: Private

    private static func markerQuery(_ line: String) -> String? {
        guard let regex = try? NSRegularExpression(
            pattern: #"^\s{0,3}>\s*\[!USERNOTE\]\s*(.*)$"#,
            options: [.caseInsensitive]
        ) else { return nil }
        let range = NSRange(line.startIndex..<line.endIndex, in: line)
        guard let match = regex.firstMatch(in: line, options: [], range: range) else { return nil }
        if let queryRange = Range(match.range(at: 1), in: line) {
            return String(line[queryRange]).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return ""
    }

    private static func isQuoted(_ line: String) -> Bool {
        line.range(of: #"^\s{0,3}>"#, options: .regularExpression) != nil
    }

    private static func extractTarget(_ raw: String) -> String? {
        guard let regex = try? NSRegularExpression(
            pattern: #"<!--\s*target:\s*"([\s\S]*?)"\s*-->"#,
            options: [.caseInsensitive]
        ) else { return nil }
        let range = NSRange(raw.startIndex..<raw.endIndex, in: raw)
        guard let match = regex.firstMatch(in: raw, options: [], range: range),
              let targetRange = Range(match.range(at: 1), in: raw) else { return nil }
        return String(raw[targetRange])
    }

    /// Finds the end of the paragraph containing the note's target quote,
    /// ignoring fenced code. Returns nil when no target is available or found.
    private static func insertionRange(for note: UserNoteBlock, in content: String) -> Range<String.Index>? {
        guard let target = note.target else { return nil }
        let needle = normalizedForSearch(String(target.prefix(80)))
        guard !needle.isEmpty else { return nil }

        let lines = content.components(separatedBy: "\n")
        var insideFence = false
        var blockStart: String.Index?
        var blockRanges: [Range<String.Index>] = []

        func lineEnd(after index: Int) -> String.Index {
            var cursor = content.startIndex
            for _ in 0..<index {
                guard let newline = content[cursor...].firstIndex(of: "\n") else { return content.endIndex }
                cursor = content.index(after: newline)
            }
            return content[cursor...].firstIndex(of: "\n") ?? content.endIndex
        }

        for (index, line) in lines.enumerated() {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
                insideFence.toggle()
            }
            let isBlank = trimmed.isEmpty
            if isBlank || insideFence {
                if let start = blockStart {
                    let end = lineEnd(after: index - 1)
                    if start <= end { blockRanges.append(start..<end) }
                    blockStart = nil
                }
            } else if blockStart == nil {
                blockStart = startIndex(ofLine: index, in: content)
            }
        }
        if let start = blockStart {
            let end = lineEnd(after: lines.count - 1)
            if start <= end { blockRanges.append(start..<end) }
        }

        for range in blockRanges.reversed() {
            let block = String(content[range])
            if normalizedForSearch(block).contains(needle) {
                return range
            }
        }
        return nil
    }

    private static func startIndex(ofLine index: Int, in content: String) -> String.Index {
        var cursor = content.startIndex
        for _ in 0..<index {
            guard let newline = content[cursor...].firstIndex(of: "\n") else { return content.endIndex }
            cursor = content.index(after: newline)
        }
        return cursor
    }

    private static func normalizedForSearch(_ text: String) -> String {
        text.lowercased()
            .components(separatedBy: .whitespacesAndNewlines)
            .filter { !$0.isEmpty }
            .joined(separator: " ")
    }

    private static func collapseBlankLines(_ text: String) -> String {
        var result = text.replacingOccurrences(of: "\n{3,}", with: "\n\n", options: .regularExpression)
        result = result.trimmingCharacters(in: .whitespacesAndNewlines)
        return result.isEmpty ? "" : result + "\n"
    }
}

// MARK: - Document metadata and frontmatter

public struct GeneratedDocumentMetadata: Equatable, Sendable {
    public var courseId: String
    /// Lesson ID, unit scope ID (`04.unit`), or `course`.
    public var scopeId: String
    public var tab: String
    public var promptID: String
    public var contextAttachment: String
    public var unitNumber: Int?
    public var lessonNumber: Int?
    public var isCourseScope: Bool
    public var savedAt: String

    public init(
        courseId: String,
        scopeId: String,
        tab: String,
        promptID: String,
        contextAttachment: String,
        unitNumber: Int? = nil,
        lessonNumber: Int? = nil,
        isCourseScope: Bool = false,
        savedAt: String = GenerationJob.timestamp()
    ) {
        self.courseId = courseId
        self.scopeId = scopeId
        self.tab = tab
        self.promptID = promptID
        self.contextAttachment = contextAttachment
        self.unitNumber = unitNumber
        self.lessonNumber = lessonNumber
        self.isCourseScope = isCourseScope
        self.savedAt = savedAt
    }

    public var values: [String: YAMLValue] {
        var values: [String: YAMLValue] = [
            "prompt": .scalar(promptID),
            "contextAttachment": .scalar(contextAttachment),
            "courseId": .scalar(courseId),
            "course": .scalar(courseId),
            "lesson": .scalar(scopeId),
            "savedAt": .scalar(savedAt),
        ]
        if let unitNumber { values["unitNumber"] = .scalar(String(unitNumber)) }
        if let lessonNumber { values["lessonNumber"] = .scalar(String(lessonNumber)) }
        return values
    }
}

/// Builds the final Markdown file: one outer code fence removed, generated
/// frontmatter merged with the existing file's unknown/scored fields, and the
/// metadata fields the app owns written explicitly.
public enum GeneratedDocumentComposer {
    /// A non-empty existing file that starts with `---` must have readable
    /// frontmatter. Silently discarding it would drop scored unit-test fields.
    public static func validateExistingFrontmatter(_ existing: String) throws {
        let trimmed = existing.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.hasPrefix("---") else { return }
        guard let document = try? FrontmatterDocument(parsing: trimmed),
              document.hadFrontmatter else {
            throw GeneratedDocumentComposerError.corruptExistingFrontmatter
        }
    }

    public static func compose(
        generated: String,
        metadata: GeneratedDocumentMetadata,
        existing: String?
    ) throws -> String {
        let stripped = OutputValidator.stripOuterFence(generated)
        let generatedDocument: FrontmatterDocument
        if let parsed = try? FrontmatterDocument(parsing: stripped) {
            generatedDocument = parsed
        } else {
            // Malformed generated frontmatter is treated as body so the output
            // is preserved, and the required frontmatter is added.
            generatedDocument = FrontmatterDocument(entries: [], body: stripped, hadFrontmatter: false)
        }

        var existingDocument: FrontmatterDocument?
        if let existing, !existing.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            try validateExistingFrontmatter(existing)
            existingDocument = try FrontmatterDocument(parsing: existing)
        }

        var document: FrontmatterDocument
        if let existingDocument, existingDocument.hadFrontmatter {
            document = FrontmatterDocument(
                entries: existingDocument.entries,
                body: generatedDocument.body,
                hadFrontmatter: true
            )
        } else {
            document = FrontmatterDocument(
                entries: generatedDocument.entries,
                body: generatedDocument.body,
                hadFrontmatter: generatedDocument.hadFrontmatter
            )
        }

        // The app owns these keys; existing unknown fields and scored fields
        // (lastAttemptDate/score/totalQuestions/percentage) are preserved
        // because they are already in the base entries and are not replaced.
        for key in ["savedAt", "prompt", "contextAttachment"] {
            document.removeValue(forKey: key)
        }
        for (key, value) in metadata.values {
            document.setValue(value, forKey: key)
        }

        // Keep any AI-returned frontmatter keys the existing file did not have
        // (for example `title`), without overwriting existing user data.
        for entry in generatedDocument.entries where document.value(forKey: entry.key) == nil {
            document.setValue(entry.value, forKey: entry.key)
        }

        document.hadFrontmatter = true
        return try document.serialized()
    }
}

// MARK: - Snapshot

public enum GeneratedDocumentComposerError: Error, LocalizedError, Equatable {
    case corruptExistingFrontmatter

    public var errorDescription: String? {
        switch self {
        case .corruptExistingFrontmatter:
            return "The existing document has unreadable frontmatter; it was not overwritten."
        }
    }
}

public enum GenerationSnapshot {
    /// Writes the previous file to `<name>.bak` before a generation overwrite.
    @discardableResult
    public static func snapshot(
        existing: String,
        to target: URL,
        store: AtomicFileStore = AtomicFileStore()
    ) throws -> URL? {
        guard !existing.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        let backup = target.deletingLastPathComponent()
            .appendingPathComponent(target.lastPathComponent + ".bak")
        try store.write(existing, to: backup)
        return backup
    }
}
