import Foundation

// MARK: - Staged prompt manifest

public struct PromptManifestEntry: Equatable, Sendable {
    public var id: String
    public var file: String
    public var source: String?
    public var isProtected: Bool
    public var patched: Bool
    public var schemaPatch: String?
    public var sha256: String?
    public var bytes: Int?
    public var extras: [JSONMember]

    public init(
        id: String,
        file: String,
        source: String? = nil,
        isProtected: Bool = true,
        patched: Bool = false,
        schemaPatch: String? = nil,
        sha256: String? = nil,
        bytes: Int? = nil,
        extras: [JSONMember] = []
    ) {
        self.id = id
        self.file = file
        self.source = source
        self.isProtected = isProtected
        self.patched = patched
        self.schemaPatch = schemaPatch
        self.sha256 = sha256
        self.bytes = bytes
        self.extras = extras
    }

    public init?(json: JSONValue) {
        guard let id = json["id"]?.stringValue, !id.isEmpty else { return nil }
        self.init(
            id: id,
            file: json["file"]?.stringValue ?? "\(id).md",
            source: json["source"]?.stringValue,
            isProtected: json["protected"]?.boolValue ?? true,
            patched: json["patched"]?.boolValue ?? false,
            schemaPatch: json["schemaPatch"]?.stringValue,
            sha256: json["sha256"]?.stringValue?.lowercased(),
            bytes: json["bytes"]?.intValue,
            extras: json.objectValue?.filter {
                !["id", "file", "source", "protected", "patched", "schemaPatch", "sha256", "bytes"].contains($0.key)
            } ?? []
        )
    }

    public var json: JSONValue {
        var members: [JSONMember] = [
            JSONMember(key: "id", value: .string(id)),
            JSONMember(key: "file", value: .string(file)),
            JSONMember(key: "protected", value: .bool(isProtected)),
            JSONMember(key: "patched", value: .bool(patched)),
        ]
        if let source { members.append(JSONMember(key: "source", value: .string(source))) }
        if let schemaPatch { members.append(JSONMember(key: "schemaPatch", value: .string(schemaPatch))) }
        if let sha256 { members.append(JSONMember(key: "sha256", value: .string(sha256))) }
        if let bytes { members.append(JSONMember(key: "bytes", value: .number(String(bytes)))) }
        let known = Set(members.map(\.key))
        members.append(contentsOf: extras.filter { !known.contains($0.key) })
        return .object(members)
    }
}

public struct PromptManifestIssue: Equatable, Sendable {
    public var promptID: String?
    public var code: String
    public var message: String

    public init(promptID: String? = nil, code: String, message: String) {
        self.promptID = promptID
        self.code = code
        self.message = message
    }
}

public struct PromptManifestValidation: Equatable, Sendable {
    public var issues: [PromptManifestIssue]
    public var checkedPrompts: Int

    public init(issues: [PromptManifestIssue] = [], checkedPrompts: Int = 0) {
        self.issues = issues
        self.checkedPrompts = checkedPrompts
    }

    public var isValid: Bool { issues.isEmpty }
}

/// Decoded `prompt-manifest.json` (PLAN §4.8). The build stages the reviewed
/// prompt set; this type makes missing IDs, empty files, hash drift and count
/// regressions observable instead of silently shipping a broken catalog.
public struct PromptManifestDocument: Equatable, Sendable {
    public var manifestVersion: Int
    public var generatedAt: String?
    public var requiredPrompts: [String]
    public var optionalProtected: [String]
    public var excluded: [String]
    public var expectedQuestionCounts: [String: PromptQuestionCounts]
    public var prompts: [PromptManifestEntry]
    public var extras: [JSONMember]

    public init(
        manifestVersion: Int = 1,
        generatedAt: String? = nil,
        requiredPrompts: [String] = PromptCatalog.requiredIDs,
        optionalProtected: [String] = PromptCatalog.optionalProtectedIDs,
        excluded: [String] = [],
        expectedQuestionCounts: [String: PromptQuestionCounts] = PromptCatalog.expectedQuestionCounts,
        prompts: [PromptManifestEntry] = [],
        extras: [JSONMember] = []
    ) {
        self.manifestVersion = manifestVersion
        self.generatedAt = generatedAt
        self.requiredPrompts = requiredPrompts
        self.optionalProtected = optionalProtected
        self.excluded = excluded
        self.expectedQuestionCounts = expectedQuestionCounts
        self.prompts = prompts
        self.extras = extras
    }

    public init(json: JSONValue) throws {
        guard json.objectValue != nil else {
            throw PromptManifestError.notAnObject
        }
        let counts = json["expectedQuestionCounts"]?.objectValue ?? []
        var expected: [String: PromptQuestionCounts] = [:]
        for member in counts {
            if let value = PromptQuestionCounts(json: member.value) {
                expected[member.key] = value
            }
        }
        self.init(
            manifestVersion: json["manifestVersion"]?.intValue ?? 1,
            generatedAt: json["generatedAt"]?.stringValue,
            requiredPrompts: json["requiredPrompts"]?.arrayValue?.compactMap(\.stringValue) ?? [],
            optionalProtected: json["optionalProtected"]?.arrayValue?.compactMap(\.stringValue) ?? [],
            excluded: json["excluded"]?.arrayValue?.compactMap(\.stringValue) ?? [],
            expectedQuestionCounts: expected,
            prompts: json["prompts"]?.arrayValue?.compactMap(PromptManifestEntry.init(json:)) ?? [],
            extras: json.objectValue?.filter {
                !["manifestVersion", "generatedAt", "sourceRoot", "destination",
                  "requiredPrompts", "optionalProtected", "excluded",
                  "expectedQuestionCounts", "prompts"].contains($0.key)
            } ?? []
        )
    }

    public static func decode(_ data: Data) throws -> PromptManifestDocument {
        try PromptManifestDocument(json: JSONValue(parsing: data))
    }

    public var json: JSONValue {
        var members: [JSONMember] = [
            JSONMember(key: "manifestVersion", value: .number(String(manifestVersion))),
            JSONMember(key: "requiredPrompts", value: .array(requiredPrompts.map { .string($0) })),
            JSONMember(key: "optionalProtected", value: .array(optionalProtected.map { .string($0) })),
            JSONMember(key: "excluded", value: .array(excluded.map { .string($0) })),
            JSONMember(
                key: "expectedQuestionCounts",
                value: .object(expectedQuestionCounts.keys.sorted().compactMap { key in
                    expectedQuestionCounts[key].map { JSONMember(key: key, value: $0.json) }
                })
            ),
            JSONMember(key: "prompts", value: .array(prompts.map(\.json))),
        ]
        if let generatedAt {
            members.insert(JSONMember(key: "generatedAt", value: .string(generatedAt)), at: 1)
        }
        let known = Set(members.map(\.key))
        members.append(contentsOf: extras.filter { !known.contains($0.key) })
        return .object(members)
    }

    /// Verifies the staged directory against the manifest. Every required
    /// prompt must exist, be non-empty, and match its recorded hash/size.
    public func validate(directory: URL, fileManager: FileManager = .default) -> PromptManifestValidation {
        var issues: [PromptManifestIssue] = []
        var entriesByID: [String: PromptManifestEntry] = [:]
        for entry in prompts {
            if entriesByID[entry.id] != nil {
                issues.append(PromptManifestIssue(
                    promptID: entry.id,
                    code: "duplicateID",
                    message: "Prompt \(entry.id) appears more than once in the manifest."
                ))
            }
            entriesByID[entry.id] = entry
        }

        for required in requiredPrompts {
            guard let entry = entriesByID[required] else {
                issues.append(PromptManifestIssue(
                    promptID: required,
                    code: "missingRequiredID",
                    message: "Required prompt \(required) is missing from the manifest."
                ))
                continue
            }
            let url = directory.appendingPathComponent(entry.file)
            guard fileManager.fileExists(atPath: url.path),
                  let data = try? Data(contentsOf: url) else {
                issues.append(PromptManifestIssue(
                    promptID: required,
                    code: "missingFile",
                    message: "Required prompt file \(entry.file) is missing."
                ))
                continue
            }
            if data.isEmpty || String(decoding: data, as: UTF8.self)
                .trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                issues.append(PromptManifestIssue(
                    promptID: required,
                    code: "emptyFile",
                    message: "Required prompt \(entry.file) is empty."
                ))
            }
        }

        for entry in prompts {
            let url = directory.appendingPathComponent(entry.file)
            guard let data = try? Data(contentsOf: url) else { continue }
            if let expectedHash = entry.sha256, !expectedHash.isEmpty,
               SHA256.hex(data) != expectedHash.lowercased() {
                issues.append(PromptManifestIssue(
                    promptID: entry.id,
                    code: "hashMismatch",
                    message: "Prompt \(entry.file) does not match the reviewed content hash."
                ))
            }
            if let expectedBytes = entry.bytes, data.count != expectedBytes {
                issues.append(PromptManifestIssue(
                    promptID: entry.id,
                    code: "sizeMismatch",
                    message: "Prompt \(entry.file) is \(data.count) bytes; the manifest recorded \(expectedBytes)."
                ))
            }
            if entry.isProtected, !PromptCatalog.isProtected(entry.id) {
                issues.append(PromptManifestIssue(
                    promptID: entry.id,
                    code: "unprotectedBuiltIn",
                    message: "Prompt \(entry.id) is required to be protected but is not in the protected set."
                ))
            }
        }

        for id in ["test", "course_test", "unit_test", "popquiz"] {
            guard let counts = expectedQuestionCounts[id] else {
                issues.append(PromptManifestIssue(
                    promptID: id,
                    code: "missingExpectedCounts",
                    message: "The manifest must record the expected question counts for \(id)."
                ))
                continue
            }
            if let total = counts.total {
                let parts = [counts.multipleChoice, counts.fillInTheBlank, counts.shortAnswer, counts.multiPart]
                    .compactMap { $0 }
                    .reduce(0, +)
                if parts > 0, parts != total {
                    issues.append(PromptManifestIssue(
                        promptID: id,
                        code: "countMismatch",
                        message: "Prompt \(id) records a total of \(total) but its parts sum to \(parts)."
                    ))
                }
            }
            if let plan = PromptCatalog.expectedQuestionCounts[id], counts != plan {
                issues.append(PromptManifestIssue(
                    promptID: id,
                    code: "countMismatch",
                    message: "Prompt \(id) must request the reviewed counts (\(plan.json.serialized(pretty: false)))."
                ))
            }
        }

        if fileManager.fileExists(atPath: directory.appendingPathComponent("backup").path) {
            issues.append(PromptManifestIssue(
                code: "backupDirectoryPresent",
                message: "The staging directory must not contain the desktop backup/ folder."
            ))
        }
        for name in excluded {
            if fileManager.fileExists(atPath: directory.appendingPathComponent(name).path) {
                issues.append(PromptManifestIssue(
                    code: "excludedFilePresent",
                    message: "Excluded prompt file \(name) was staged."
                ))
            }
        }

        return PromptManifestValidation(issues: issues, checkedPrompts: prompts.count)
    }

    /// Loads `prompt-manifest.json` next to the bundled prompts.
    public static func loadBundled(from directory: URL) throws -> PromptManifestDocument? {
        let url = directory.appendingPathComponent("prompt-manifest.json")
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        return try decode(Data(contentsOf: url))
    }
}

public enum PromptManifestError: Error, LocalizedError, Equatable {
    case notAnObject

    public var errorDescription: String? {
        switch self {
        case .notAnObject: return "prompt-manifest.json must be a JSON object."
        }
    }
}

// MARK: - Provenance

public enum PromptProvenanceSource: String, Equatable, Sendable {
    /// Matches the bundled default byte-for-byte.
    case bundled
    /// Seeded from the bundle and never edited.
    case seeded
    /// The user or an imported backup changed the active copy.
    case userEdited = "user_edited"
    /// Copied from an imported desktop backup.
    case imported
}

public struct PromptProvenanceRecord: Equatable, Sendable {
    public var id: String
    public var source: PromptProvenanceSource
    public var bundledSHA256: String?
    public var activeSHA256: String?
    public var updatedAt: String
    public var extras: [JSONMember]

    public init(
        id: String,
        source: PromptProvenanceSource,
        bundledSHA256: String? = nil,
        activeSHA256: String? = nil,
        updatedAt: String,
        extras: [JSONMember] = []
    ) {
        self.id = id
        self.source = source
        self.bundledSHA256 = bundledSHA256
        self.activeSHA256 = activeSHA256
        self.updatedAt = updatedAt
        self.extras = extras
    }

    public var isUserEdited: Bool {
        source == .userEdited || source == .imported
    }

    public init?(json: JSONValue) {
        guard let id = json["id"]?.stringValue,
              let rawSource = json["source"]?.stringValue,
              let source = PromptProvenanceSource(rawValue: rawSource) else { return nil }
        self.init(
            id: id,
            source: source,
            bundledSHA256: json["bundledSHA256"]?.stringValue,
            activeSHA256: json["activeSHA256"]?.stringValue,
            updatedAt: json["updatedAt"]?.stringValue ?? "",
            extras: json.objectValue?.filter {
                !["id", "source", "bundledSHA256", "activeSHA256", "updatedAt"].contains($0.key)
            } ?? []
        )
    }

    public var json: JSONValue {
        var members: [JSONMember] = [
            JSONMember(key: "id", value: .string(id)),
            JSONMember(key: "source", value: .string(source.rawValue)),
            JSONMember(key: "updatedAt", value: .string(updatedAt)),
        ]
        if let bundledSHA256 { members.append(JSONMember(key: "bundledSHA256", value: .string(bundledSHA256))) }
        if let activeSHA256 { members.append(JSONMember(key: "activeSHA256", value: .string(activeSHA256))) }
        let known = Set(members.map(\.key))
        members.append(contentsOf: extras.filter { !known.contains($0.key) })
        return .object(members)
    }
}

public struct PromptInventoryEntry: Equatable, Sendable {
    public var prompt: Prompt
    public var provenance: PromptProvenanceRecord?
    public var bundledSHA256: String?
    public var bundledContent: String?

    public init(
        prompt: Prompt,
        provenance: PromptProvenanceRecord?,
        bundledSHA256: String?,
        bundledContent: String? = nil
    ) {
        self.prompt = prompt
        self.provenance = provenance
        self.bundledSHA256 = bundledSHA256
        self.bundledContent = bundledContent
    }

    public var isUserEdited: Bool {
        guard let provenance else { return prompt.source == .active }
        return provenance.source == .userEdited || provenance.source == .imported
    }
}

/// Tracks whether each prompt is the shipped default, an untouched seed, or a
/// user/import edit (PLAN §4.8). A corrupt provenance file is quarantined and
/// reset: it is derived metadata, never prompt content.
public actor PromptProvenanceStore {
    private let root: DataRoot
    private let store: AtomicFileStore
    private let quarantine: FileQuarantine

    public init(root: DataRoot, store: AtomicFileStore = AtomicFileStore()) {
        self.root = root
        self.store = store
        self.quarantine = FileQuarantine(rootURL: root.quarantineURL)
    }

    public func records() -> [String: PromptProvenanceRecord] {
        loadDocument().records
    }

    public func record(id: String) -> PromptProvenanceRecord? {
        loadDocument().records[id]
    }

    public func isUserEdited(id: String) -> Bool {
        loadDocument().records[id]?.isUserEdited ?? false
    }

    @discardableResult
    public func record(
        id: String,
        source: PromptProvenanceSource,
        content: String,
        bundledContent: String?
    ) throws -> PromptProvenanceRecord {
        var document = loadDocument()
        let record = PromptProvenanceRecord(
            id: id,
            source: source,
            bundledSHA256: bundledContent.map(SHA256.hex),
            activeSHA256: SHA256.hex(content),
            updatedAt: GenerationJob.timestamp(),
            extras: document.records[id]?.extras ?? []
        )
        document.records[id] = record
        try persist(document)
        return record
    }

    public func recordSeeded(id: String, content: String) throws {
        _ = try record(id: id, source: .seeded, content: content, bundledContent: content)
    }

    public func recordSaved(id: String, content: String, bundledContent: String?) throws {
        let source: PromptProvenanceSource
        if let bundledContent, SHA256.hex(content) == SHA256.hex(bundledContent) {
            source = .bundled
        } else {
            source = .userEdited
        }
        _ = try record(id: id, source: source, content: content, bundledContent: bundledContent)
    }

    public func recordRestored(id: String, content: String) throws {
        _ = try record(id: id, source: .bundled, content: content, bundledContent: content)
    }

    public func recordImported(id: String, content: String, bundledContent: String?) throws {
        _ = try record(id: id, source: .imported, content: content, bundledContent: bundledContent)
    }

    public func removeRecord(id: String) throws {
        var document = loadDocument()
        guard document.records.removeValue(forKey: id) != nil else { return }
        try persist(document)
    }

    private struct Document {
        var records: [String: PromptProvenanceRecord]
    }

    private func loadDocument() -> Document {
        guard store.exists(root.promptProvenanceURL) else { return Document(records: [:]) }
        do {
            let json = try store.readJSON(root.promptProvenanceURL)
            let members = json["records"]?.objectValue ?? []
            var records: [String: PromptProvenanceRecord] = [:]
            for member in members {
                if let record = PromptProvenanceRecord(json: member.value) {
                    records[member.key] = record
                }
            }
            return Document(records: records)
        } catch {
            _ = try? quarantine.quarantineFile(
                root.promptProvenanceURL,
                reason: "unreadable prompt-provenance.json",
                store: store
            )
            return Document(records: [:])
        }
    }

    private func persist(_ document: Document) throws {
        try root.acquireWriteLease(owner: "PromptProvenanceStore")
        defer { root.releaseWriteLease(owner: "PromptProvenanceStore") }
        let records = document.records.keys.sorted().compactMap { key in
            document.records[key].map { JSONMember(key: key, value: $0.json) }
        }
        let json = JSONValue.object([
            JSONMember(key: "version", value: .number("1")),
            JSONMember(key: "records", value: .object(records)),
        ])
        try store.writeJSON(json, to: root.promptProvenanceURL)
    }
}
