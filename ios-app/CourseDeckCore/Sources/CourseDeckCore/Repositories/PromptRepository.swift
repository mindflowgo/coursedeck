import Foundation

public enum PromptRepositoryError: Error, LocalizedError, Equatable {
    case protectedPrompt(String)
    case bundledPromptMissing(String)
    case notFound(String)
    case alreadyExists(String)
    case writeBlocked(String)

    public var errorDescription: String? {
        switch self {
        case let .protectedPrompt(id): return "Built-in prompt \"\(id)\" cannot be deleted."
        case let .bundledPromptMissing(id): return "Bundled prompt \"\(id)\" is missing from the app."
        case let .notFound(id): return "Prompt \"\(id)\" was not found."
        case let .alreadyExists(id): return "A prompt named \"\(id)\" already exists."
        case let .writeBlocked(reason): return "Writes are blocked: \(reason)"
        }
    }
}

/// Prompt catalog: active user prompts in `<root>/prompts` override bundled
/// defaults; defaults are seeded only when the active file is missing and never
/// overwrite user edits. Protected built-ins cannot be deleted (PLAN §4.8).
public actor PromptRepository {
    private let root: DataRoot
    private let bundledDirectory: URL?
    private let store: AtomicFileStore
    private let quarantine: FileQuarantine
    private let provenance: PromptProvenanceStore?
    private let leaseOwner: String

    public init(
        root: DataRoot,
        bundledDirectory: URL?,
        store: AtomicFileStore = AtomicFileStore(),
        provenance: PromptProvenanceStore? = nil
    ) {
        self.root = root
        self.bundledDirectory = bundledDirectory
        self.store = store
        self.quarantine = FileQuarantine(rootURL: root.quarantineURL)
        self.provenance = provenance
        self.leaseOwner = "PromptRepository.\(UUID().uuidString)"
    }

    public func list() throws -> [Prompt] {
        var byID: [String: Prompt] = [:]

        for prompt in bundledPrompts() {
            byID[prompt.id] = prompt
        }
        for prompt in activePrompts() {
            byID[prompt.id] = prompt
        }
        return byID.values.sorted { $0.id < $1.id }
    }

    /// Active prompt first, bundled fallback second. A missing active copy is
    /// seeded from the bundle when the root is writable.
    public func prompt(id: String) async throws -> Prompt? {
        let promptID = try PathValidator.promptId(id)
        if let active = activePrompt(id: promptID) {
            return active
        }
        guard let bundled = bundledPrompt(id: promptID) else { return nil }
        if root.writeGate.isWritable {
            try? await seed(bundled)
        }
        return bundled
    }

    /// Prompt plus its bundled hash and provenance record. Used by the prompt
    /// manager's diff/restore UI.
    public func inventory() async throws -> [PromptInventoryEntry] {
        let provenanceRecords: [String: PromptProvenanceRecord]
        if let provenance {
            provenanceRecords = await provenance.records()
        } else {
            provenanceRecords = [:]
        }
        return try list().map { prompt in
            let bundled = bundledPrompt(id: prompt.id)
            return PromptInventoryEntry(
                prompt: prompt,
                provenance: provenanceRecords[prompt.id],
                bundledSHA256: bundled.map { SHA256.hex($0.content) },
                bundledContent: bundled?.content
            )
        }
    }

    public func bundledPrompt(id: String) -> Prompt? {
        guard let promptID = try? PathValidator.promptId(id),
              let directory = bundledDirectory else { return nil }
        let url = directory.appendingPathComponent("\(promptID).md")
        guard let content = try? store.readString(url) else { return nil }
        return Prompt(
            id: promptID,
            title: Prompt.title(for: content, fallback: promptID),
            filename: "\(promptID).md",
            content: content,
            source: .bundled
        )
    }

    @discardableResult
    public func save(id: String, content: String) async throws -> Prompt {
        let promptID = try PathValidator.promptId(id)
        let saved = try writeActive(id: promptID, content: content)
        let bundledContent = bundledPrompt(id: promptID)?.content
        try? await provenance?.recordSaved(
            id: promptID,
            content: content,
            bundledContent: bundledContent
        )
        return saved
    }

    /// Creates a brand-new prompt. Built-in IDs (even optional ones) and
    /// existing active/custom IDs are rejected so the manager cannot silently
    /// shadow a protected prompt.
    @discardableResult
    public func create(id: String, content: String) async throws -> Prompt {
        let promptID = try PathValidator.promptId(id).lowercased()
        if PromptCatalog.isProtected(promptID) {
            throw PromptRepositoryError.protectedPrompt(promptID)
        }
        if activePrompt(id: promptID) != nil || bundledPrompt(id: promptID) != nil {
            throw PromptRepositoryError.alreadyExists(promptID)
        }
        return try await save(id: promptID, content: content)
    }

    private func writeActive(id promptID: String, content: String) throws -> Prompt {
        try root.acquireWriteLease(owner: leaseOwner)
        defer { root.releaseWriteLease(owner: leaseOwner) }
        try FileManager.default.createDirectory(at: root.promptsURL, withIntermediateDirectories: true)
        let url = try root.promptURL(promptID)
        try store.write(content, to: url)
        return Prompt(
            id: promptID,
            title: Prompt.title(for: content, fallback: promptID),
            filename: "\(promptID).md",
            content: content,
            source: .active
        )
    }

    /// Deletes an active prompt. Built-ins are protected even when the active
    /// file only shadows the bundled default.
    @discardableResult
    public func delete(id: String) async throws -> Bool {
        let promptID = try PathValidator.promptId(id)
        if PromptCatalog.isProtected(promptID) {
            throw PromptRepositoryError.protectedPrompt(promptID)
        }
        let removed = try removeActive(id: promptID)
        if removed {
            if let bundled = bundledPrompt(id: promptID) {
                try? await provenance?.recordRestored(id: promptID, content: bundled.content)
            } else {
                try? await provenance?.removeRecord(id: promptID)
            }
        }
        return removed
    }

    private func removeActive(id promptID: String) throws -> Bool {
        try root.acquireWriteLease(owner: leaseOwner)
        defer { root.releaseWriteLease(owner: leaseOwner) }
        let url = try root.promptURL(promptID)
        guard store.exists(url) else { return false }
        try FileManager.default.removeItem(at: url)
        return true
    }

    /// Overwrites an active prompt with its bundled default (explicit user
    /// action only; never part of seeding).
    @discardableResult
    public func restoreDefault(id: String) async throws -> Prompt {
        let promptID = try PathValidator.promptId(id)
        guard let bundled = bundledPrompt(id: promptID) else {
            throw PromptRepositoryError.bundledPromptMissing(promptID)
        }
        if let active = activePrompt(id: promptID) {
            try snapshotActive(id: promptID, content: active.content)
        }
        _ = try writeActive(id: promptID, content: bundled.content)
        try? await provenance?.recordRestored(id: promptID, content: bundled.content)
        return Prompt(
            id: promptID,
            title: bundled.title,
            filename: bundled.filename,
            content: bundled.content,
            source: .active
        )
    }

    /// Explicit restore is destructive, so the previous active prompt is
    /// recoverable at `prompts/<id>.md.bak`.
    private func snapshotActive(id: String, content: String) throws {
        try root.acquireWriteLease(owner: leaseOwner)
        defer { root.releaseWriteLease(owner: leaseOwner) }
        let url = try root.promptURL(id)
        let backup = url.deletingLastPathComponent()
            .appendingPathComponent(url.lastPathComponent + ".bak")
        try store.write(content, to: backup)
    }

    /// After an app update, replaces active prompts only when they are still
    /// byte-identical to the *previous* bundled default. User-edited and
    /// imported prompts are preserved; the prompt manager can offer an explicit
    /// "restore default" for those.
    @discardableResult
    public func refreshBundledDefaults() async throws -> [String] {
        guard let provenance else { return [] }
        let records = await provenance.records()
        var refreshed: [String] = []
        for bundled in bundledPrompts() {
            guard let active = activePrompt(id: bundled.id),
                  let record = records[bundled.id],
                  record.source == .seeded || record.source == .bundled,
                  let previousBundledHash = record.bundledSHA256 else {
                continue
            }
            let activeHash = SHA256.hex(active.content)
            guard activeHash == previousBundledHash else { continue }
            let newHash = SHA256.hex(bundled.content)
            guard newHash != activeHash else { continue }
            _ = try writeActive(id: bundled.id, content: bundled.content)
            try? await provenance.recordRestored(id: bundled.id, content: bundled.content)
            refreshed.append(bundled.id)
        }
        return refreshed
    }

    public func missingRequiredPrompts() -> [String] {
        PromptCatalog.requiredIDs.filter { id in
            let content = activePrompt(id: id)?.content ?? bundledPrompt(id: id)?.content ?? ""
            return content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
    }

    /// Validates the bundled `prompt-manifest.json` (hashes, required IDs,
    /// reviewed question counts). Returns nil when the bundle has no manifest,
    /// which only happens in tests/previews that supply a bare directory.
    public func stagingValidation() throws -> PromptManifestValidation? {
        guard let bundledDirectory,
              let manifest = try PromptManifestDocument.loadBundled(from: bundledDirectory) else {
            return nil
        }
        return manifest.validate(directory: bundledDirectory)
    }

    // MARK: - Private

    private func activePrompts() -> [Prompt] {
        guard let files = try? FileManager.default.contentsOfDirectory(
            at: root.promptsURL,
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles]
        ) else { return [] }
        var prompts: [Prompt] = []
        for file in files where file.pathExtension.lowercased() == "md" {
            let id = file.deletingPathExtension().lastPathComponent
            guard (try? PathValidator.promptId(id)) != nil else { continue }
            guard let content = try? store.readString(file) else {
                _ = try? quarantine.quarantineFile(file, reason: "unreadable prompt file", store: store)
                continue
            }
            prompts.append(Prompt(
                id: id,
                title: Prompt.title(for: content, fallback: id),
                filename: file.lastPathComponent,
                content: content,
                source: .active
            ))
        }
        return prompts
    }

    private func activePrompt(id: String) -> Prompt? {
        guard let url = try? root.promptURL(id), store.exists(url) else { return nil }
        guard let content = try? store.readString(url) else {
            _ = try? quarantine.quarantineFile(url, reason: "unreadable prompt file", store: store)
            return nil
        }
        return Prompt(
            id: id,
            title: Prompt.title(for: content, fallback: id),
            filename: "\(id).md",
            content: content,
            source: .active
        )
    }

    private func bundledPrompts() -> [Prompt] {
        guard let directory = bundledDirectory,
              let files = try? FileManager.default.contentsOfDirectory(
                at: directory,
                includingPropertiesForKeys: nil,
                options: [.skipsHiddenFiles]
              ) else { return [] }
        var prompts: [Prompt] = []
        for file in files where file.pathExtension.lowercased() == "md" {
            let id = file.deletingPathExtension().lastPathComponent
            guard (try? PathValidator.promptId(id)) != nil,
                  let content = try? store.readString(file) else { continue }
            prompts.append(Prompt(
                id: id,
                title: Prompt.title(for: content, fallback: id),
                filename: file.lastPathComponent,
                content: content,
                source: .bundled
            ))
        }
        return prompts
    }

    /// Writes a bundled default into the active root only if it is absent.
    private func seed(_ prompt: Prompt) async throws {
        try writeSeedIfMissing(prompt)
        try? await provenance?.recordSeeded(id: prompt.id, content: prompt.content)
    }

    private func writeSeedIfMissing(_ prompt: Prompt) throws {
        try root.acquireWriteLease(owner: leaseOwner)
        defer { root.releaseWriteLease(owner: leaseOwner) }
        try FileManager.default.createDirectory(at: root.promptsURL, withIntermediateDirectories: true)
        let url = try root.promptURL(prompt.id)
        guard !store.exists(url) else { return }
        try store.write(prompt.content, to: url)
    }
}
