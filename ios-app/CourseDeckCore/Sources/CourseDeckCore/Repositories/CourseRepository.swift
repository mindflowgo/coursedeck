import Foundation

public enum RepositoryError: Error, LocalizedError, Equatable {
    case notFound(String)
    case corrupt(String, quarantinedAt: URL?)
    case writeBlocked(String)
    case invalidIdentifier(String)
    case concurrentModification(String)
    case alreadyExists(String)
    case coordinationFailed(String)

    public var errorDescription: String? {
        switch self {
        case let .notFound(name): return "\(name) was not found."
        case let .corrupt(name, quarantinedAt):
            if let quarantinedAt {
                return "\(name) is corrupt and was quarantined at \(quarantinedAt.lastPathComponent)."
            }
            return "\(name) is corrupt."
        case let .writeBlocked(reason): return "Writes are blocked: \(reason)"
        case let .invalidIdentifier(value): return "Invalid identifier: \(value)"
        case let .concurrentModification(name):
            return "\(name) changed while the generation was running. Nothing was overwritten; reload the file and try again."
        case let .alreadyExists(name):
            return "\(name) already exists."
        case let .coordinationFailed(reason):
            return "The file could not be coordinated for writing: \(reason)"
        }
    }
}

/// A read snapshot used by the Markdown editor's compare-and-swap save.
public struct DocumentSnapshot: Equatable, Sendable {
    public var courseId: String
    public var scope: GeneratedDocumentScope
    public var tab: String
    public var fileName: String
    public var content: String
    public var sha256: String
    public var existed: Bool
    public var modifiedAt: Date?

    public init(
        courseId: String,
        scope: GeneratedDocumentScope,
        tab: String,
        fileName: String,
        content: String,
        sha256: String,
        existed: Bool,
        modifiedAt: Date?
    ) {
        self.courseId = courseId
        self.scope = scope
        self.tab = tab
        self.fileName = fileName
        self.content = content
        self.sha256 = sha256
        self.existed = existed
        self.modifiedAt = modifiedAt
    }
}

public struct PopQuizReference: Equatable, Sendable, Identifiable, Comparable {
    public var lessonId: String
    public var timestamp: String
    public var fileName: String
    public var modifiedAt: Date?

    public var id: String { fileName }

    public init(lessonId: String, timestamp: String, fileName: String, modifiedAt: Date?) {
        self.lessonId = lessonId
        self.timestamp = timestamp
        self.fileName = fileName
        self.modifiedAt = modifiedAt
    }

    public static func < (lhs: PopQuizReference, rhs: PopQuizReference) -> Bool {
        lhs.timestamp > rhs.timestamp
    }
}

/// A deleted custom tab kept under `.trash/`. Trash is device-local recovery
/// state: it is hidden from backup import/export and excluded from the OS
/// backup by `DataRoot.prepare`.
public struct TrashedDocument: Equatable, Sendable, Identifiable {
    public var id: String
    public var courseId: String
    public var fileName: String
    public var tab: String
    public var deletedAt: String

    public var displayName: String {
        PathValidator.customTabDisplayName(tab)
    }

    public init(id: String, courseId: String, fileName: String, tab: String, deletedAt: String) {
        self.id = id
        self.courseId = courseId
        self.fileName = fileName
        self.tab = tab
        self.deletedAt = deletedAt
    }
}

/// The document a generation writes. `compareAndSaveGeneratedDocument` derives
/// the validated filename and performs the read/compare/snapshot/write under
/// one data-root lease.
public enum GeneratedDocumentScope: Equatable, Sendable {
    case lesson(String)
    case unit(Int)
    case course
}

public enum ManifestLoadResult: Equatable, Sendable {
    case missing
    case ok(CourseManifest)
    case corrupt(quarantinedAt: URL?)
}

public struct LessonContentBundle: Equatable, Sendable {
    public var courseId: String
    public var lessonId: String
    public var lesson: String
    /// Every non-lesson tab file on disk, keyed by tab slug.
    public var tabs: [String: String]

    public init(courseId: String, lessonId: String, lesson: String, tabs: [String: String]) {
        self.courseId = courseId
        self.lessonId = lessonId
        self.lesson = lesson
        self.tabs = tabs
    }
}

/// Course filesystem repository. All mutations are serialized by the actor and
/// every path is validated through `PathValidator.safeJoin` before it is used.
public actor CourseRepository {
    private let root: DataRoot
    private let store: AtomicFileStore
    private let quarantine: FileQuarantine
    private let leaseOwner: String
    private let leaseTimeout: TimeInterval

    public init(
        root: DataRoot,
        store: AtomicFileStore = AtomicFileStore(),
        leaseTimeout: TimeInterval = 30
    ) {
        self.root = root
        self.store = store
        self.quarantine = FileQuarantine(rootURL: root.quarantineURL)
        self.leaseOwner = "CourseRepository.\(UUID().uuidString)"
        self.leaseTimeout = leaseTimeout
    }

    // MARK: - Listings and manifests

    public func listCourses(includeArchived: Bool = true) throws -> [CourseManifest] {
        let fileManager = FileManager.default
        guard fileManager.fileExists(atPath: root.coursesURL.path) else { return [] }
        let entries = try fileManager.contentsOfDirectory(
            at: root.coursesURL,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles]
        )
        var manifests: [CourseManifest] = []
        for entry in entries {
            guard (try? entry.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true else { continue }
            let id = entry.lastPathComponent
            guard (try? PathValidator.courseId(id)) != nil else { continue }
            if case let .ok(manifest) = try manifestResult(courseId: id) {
                if includeArchived || manifest.archived != true {
                    manifests.append(manifest)
                }
            }
        }
        return manifests.sorted { $0.id.localizedStandardCompare($1.id) == .orderedAscending }
    }

    public func manifestResult(courseId: String) throws -> ManifestLoadResult {
        let course = try root.courseURL(courseId)
        let metaURL = try PathValidator.safeJoin(base: course, "meta.json")
        guard store.exists(metaURL) else { return .missing }
        do {
            let data = try store.read(metaURL)
            return .ok(try CourseManifest.decode(data))
        } catch {
            let quarantined = try? quarantine.quarantineFile(metaURL, reason: "unreadable meta.json: \(error)", store: store)
            return .corrupt(quarantinedAt: quarantined)
        }
    }

    public func course(courseId: String) throws -> CourseManifest? {
        switch try manifestResult(courseId: courseId) {
        case let .ok(manifest): return manifest
        case .missing: return nil
        case let .corrupt(quarantinedAt):
            throw RepositoryError.corrupt("meta.json", quarantinedAt: quarantinedAt)
        }
    }

    public func saveManifest(_ manifest: CourseManifest) throws {
        try root.acquireWriteLease(owner: leaseOwner, timeout: leaseTimeout)
        defer { root.releaseWriteLease(owner: leaseOwner) }
        let courseId = try PathValidator.normalizedCourseId(manifest.id)
        var copy = manifest
        copy.id = courseId
        let course = try root.courseURL(courseId)
        try FileManager.default.createDirectory(at: course, withIntermediateDirectories: true)
        let metaURL = try PathValidator.safeJoin(base: course, "meta.json")
        try store.write(copy.encoded(), to: metaURL)
    }

    public struct ManifestPatch: Equatable, Sendable {
        public var title: String?
        public var description: String?
        /// `true` sets `archived: true`; `false` removes the key entirely
        /// (desktop unarchive behavior); `nil` leaves it untouched.
        public var archived: Bool?

        public init(title: String? = nil, description: String? = nil, archived: Bool? = nil) {
            self.title = title
            self.description = description
            self.archived = archived
        }
    }

    @discardableResult
    public func patchManifest(courseId: String, patch: ManifestPatch) throws -> CourseManifest? {
        // The read-modify-write runs entirely under one lease so a concurrent
        // backup merge cannot slip units in between our read and write.
        try root.acquireWriteLease(owner: leaseOwner, timeout: leaseTimeout)
        defer { root.releaseWriteLease(owner: leaseOwner) }
        guard var manifest = try course(courseId: courseId) else { return nil }
        if let title = patch.title { manifest.title = title }
        if let description = patch.description { manifest.description = description }
        if let archived = patch.archived {
            manifest.archived = archived ? true : nil
        }
        try saveManifest(manifest)
        return manifest
    }

    // MARK: - Lesson bundles and tabs

    public func lessonBundle(courseId: String, lessonId: String) throws -> LessonContentBundle? {
        let course = try root.courseURL(courseId)
        let lesson = try PathValidator.lessonId(lessonId)
        guard FileManager.default.fileExists(atPath: course.path) else { return nil }

        let files = try FileManager.default.contentsOfDirectory(
            at: course,
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles]
        )
        var tabs: [String: String] = [:]
        var lessonContent = ""
        for file in files where file.pathExtension.lowercased() == "md" {
            guard let parsed = PathValidator.parseDocFileName(file.lastPathComponent),
                  !parsed.isCourseScope,
                  !parsed.isUnitScope,
                  parsed.lessonId.lowercased() == lesson.lowercased() else { continue }
            let content = try store.readString(file)
            if parsed.tab == "lesson" {
                lessonContent = content
            } else {
                tabs[parsed.tab] = content
            }
        }
        return LessonContentBundle(courseId: courseId, lessonId: lesson, lesson: lessonContent, tabs: tabs)
    }

    public func tabContent(courseId: String, lessonId: String, tab: String) throws -> String? {
        let course = try root.courseURL(courseId)
        let filename = try PathValidator.tabFileName(lessonId: lessonId, tab: tab)
        let url = try PathValidator.safeJoin(base: course, filename)
        guard store.exists(url) else { return nil }
        return try store.readString(url)
    }

    @discardableResult
    public func saveTab(courseId: String, lessonId: String, tab: String, content: String) throws -> String {
        try root.acquireWriteLease(owner: leaseOwner, timeout: leaseTimeout)
        defer { root.releaseWriteLease(owner: leaseOwner) }
        let course = try root.courseURL(courseId)
        guard FileManager.default.fileExists(atPath: course.path) else {
            throw RepositoryError.notFound("course \(courseId)")
        }
        let filename = try PathValidator.tabFileName(lessonId: lessonId, tab: tab)
        let url = try PathValidator.safeJoin(base: course, filename)
        try store.write(content, to: url)
        return filename
    }

    @discardableResult
    public func deleteTab(courseId: String, lessonId: String, tab: String) throws -> Bool {
        try root.acquireWriteLease(owner: leaseOwner, timeout: leaseTimeout)
        defer { root.releaseWriteLease(owner: leaseOwner) }
        let course = try root.courseURL(courseId)
        let filename = try PathValidator.tabFileName(lessonId: lessonId, tab: tab)
        let url = try PathValidator.safeJoin(base: course, filename)
        guard store.exists(url) else { return false }
        try FileManager.default.removeItem(at: url)
        return true
    }

    // MARK: - Course / unit documents

    public func courseDocument(courseId: String, tab: String) throws -> String? {
        let course = try root.courseURL(courseId)
        let filename = try PathValidator.courseDocFileName(tab: tab)
        let url = try PathValidator.safeJoin(base: course, filename)
        guard store.exists(url) else { return nil }
        return try store.readString(url)
    }

    @discardableResult
    public func saveCourseDocument(courseId: String, tab: String, content: String) throws -> String {
        try root.acquireWriteLease(owner: leaseOwner, timeout: leaseTimeout)
        defer { root.releaseWriteLease(owner: leaseOwner) }
        let course = try root.courseURL(courseId)
        try FileManager.default.createDirectory(at: course, withIntermediateDirectories: true)
        let filename = try PathValidator.courseDocFileName(tab: tab)
        let url = try PathValidator.safeJoin(base: course, filename)
        try store.write(content, to: url)
        return filename
    }

    public func unitDocument(courseId: String, unit: Int, tab: String) throws -> String? {
        let course = try root.courseURL(courseId)
        let filename = try PathValidator.unitDocFileName(unit: unit, tab: tab)
        let url = try PathValidator.safeJoin(base: course, filename)
        guard store.exists(url) else { return nil }
        return try store.readString(url)
    }

    @discardableResult
    public func saveUnitDocument(courseId: String, unit: Int, tab: String, content: String) throws -> String {
        try root.acquireWriteLease(owner: leaseOwner, timeout: leaseTimeout)
        defer { root.releaseWriteLease(owner: leaseOwner) }
        let course = try root.courseURL(courseId)
        try FileManager.default.createDirectory(at: course, withIntermediateDirectories: true)
        let filename = try PathValidator.unitDocFileName(unit: unit, tab: tab)
        let url = try PathValidator.safeJoin(base: course, filename)
        try store.write(content, to: url)
        return filename
    }

    public func discoverCourseDocs(courseId: String) throws -> CourseDocsFlags {
        let course = try root.courseURL(courseId)
        var flags = CourseDocsFlags()
        guard let files = try? FileManager.default.contentsOfDirectory(
            at: course,
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles]
        ) else { return flags }
        for file in files {
            guard let parsed = PathValidator.parseDocFileName(file.lastPathComponent),
                  parsed.isCourseScope else { continue }
            switch parsed.tab {
            case "summary": flags.summary = true
            case "cheatsheet": flags.cheatsheet = true
            case "test": flags.test = true
            case "schedule": flags.schedule = true
            case "lesson": break
            default: flags.custom[parsed.tab] = true
            }
        }
        return flags
    }

    /// Unit-scoped tab slugs present on disk (`NN.unit.<tab>.md`).
    public func discoverUnitDocs(courseId: String, unitNumber: Int) throws -> [String] {
        let course = try root.courseURL(courseId)
        guard let files = try? FileManager.default.contentsOfDirectory(
            at: course,
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles]
        ) else { return [] }
        var tabs = Set<String>()
        for file in files {
            guard let parsed = PathValidator.parseDocFileName(file.lastPathComponent),
                  parsed.isUnitScope,
                  parsed.unitNumber == unitNumber else { continue }
            tabs.insert(parsed.tab)
        }
        return tabs.sorted()
    }

    // MARK: - Editor compare-and-swap

    public func documentSnapshot(
        courseId: String,
        scope: GeneratedDocumentScope,
        tab: String
    ) throws -> DocumentSnapshot {
        try root.acquireWriteLease(owner: leaseOwner, timeout: leaseTimeout)
        defer { root.releaseWriteLease(owner: leaseOwner) }
        let target = try generatedDocumentTarget(courseId: courseId, scope: scope, tab: tab)
        guard store.exists(target.url) else {
            return DocumentSnapshot(
                courseId: courseId,
                scope: scope,
                tab: tab,
                fileName: target.fileName,
                content: "",
                sha256: SHA256.hex(Data()),
                existed: false,
                modifiedAt: nil
            )
        }
        let data = try store.read(target.url)
        guard let content = String(data: data, encoding: .utf8) else {
            throw AtomicFileStoreError.notUTF8(target.fileName)
        }
        return DocumentSnapshot(
            courseId: courseId,
            scope: scope,
            tab: tab,
            fileName: target.fileName,
            content: content,
            sha256: SHA256.hex(data),
            existed: true,
            modifiedAt: store.modificationDate(target.url)
        )
    }

    /// Saves an editor buffer only when the on-disk bytes still match the
    /// snapshot the editor loaded. `force` is the explicit "overwrite" choice
    /// after the user has seen the conflict. A `.bak` copy is always kept
    /// before a non-empty file is replaced (PLAN §2.4).
    @discardableResult
    public func compareAndSaveDocument(
        courseId: String,
        scope: GeneratedDocumentScope,
        tab: String,
        content: String,
        expectedSHA256: String,
        force: Bool = false
    ) throws -> DocumentSnapshot {
        try root.acquireWriteLease(owner: leaseOwner, timeout: leaseTimeout)
        defer { root.releaseWriteLease(owner: leaseOwner) }
        let target = try generatedDocumentTarget(courseId: courseId, scope: scope, tab: tab)
        let backup = target.url.deletingLastPathComponent()
            .appendingPathComponent(target.url.lastPathComponent + ".bak")
        try coordinatedCompareAndReplace(
            url: target.url,
            backupURL: backup,
            content: Data(content.utf8),
            expectedSHA256: expectedSHA256,
            force: force,
            fileName: target.fileName
        )
        let data = Data(content.utf8)
        return DocumentSnapshot(
            courseId: courseId,
            scope: scope,
            tab: tab,
            fileName: target.fileName,
            content: content,
            sha256: SHA256.hex(data),
            existed: true,
            modifiedAt: store.modificationDate(target.url)
        )
    }

    // MARK: - Custom tabs

    /// Creates a custom tab file and refuses reserved/built-in names. The
    /// starter content is a single heading so the reader/editor opens cleanly.
    @discardableResult
    public func createCustomDocument(
        courseId: String,
        scope: GeneratedDocumentScope,
        tab: String,
        content: String? = nil
    ) throws -> DocumentSnapshot {
        let slug = try PathValidator.tab(tab)
        guard !PathValidator.isReservedTab(slug) else {
            throw PathValidationError("The tab name \"\(slug)\" is reserved.")
        }
        try root.acquireWriteLease(owner: leaseOwner, timeout: leaseTimeout)
        defer { root.releaseWriteLease(owner: leaseOwner) }
        let target = try generatedDocumentTarget(courseId: courseId, scope: scope, tab: slug)
        guard !store.exists(target.url) else {
            throw RepositoryError.alreadyExists(target.fileName)
        }
        let starter = content ?? "# \(PathValidator.customTabDisplayName(slug))\n"
        try store.write(starter, to: target.url)
        return DocumentSnapshot(
            courseId: courseId,
            scope: scope,
            tab: slug,
            fileName: target.fileName,
            content: starter,
            sha256: SHA256.hex(Data(starter.utf8)),
            existed: true,
            modifiedAt: store.modificationDate(target.url)
        )
    }

    /// Deletes a custom tab but keeps a recoverable copy under `.trash/`.
    @discardableResult
    public func deleteCustomDocument(
        courseId: String,
        scope: GeneratedDocumentScope,
        tab: String
    ) throws -> URL? {
        let slug = try PathValidator.tab(tab)
        guard !PathValidator.isReservedTab(slug) else {
            throw PathValidationError("The tab name \"\(slug)\" is reserved.")
        }
        try root.acquireWriteLease(owner: leaseOwner, timeout: leaseTimeout)
        defer { root.releaseWriteLease(owner: leaseOwner) }
        let target = try generatedDocumentTarget(courseId: courseId, scope: scope, tab: slug)
        guard store.exists(target.url) else { return nil }
        try FileManager.default.createDirectory(at: root.trashURL, withIntermediateDirectories: true)
        let folderName = "\(FileQuarantine.timestamp())-\(UUID().uuidString.prefix(8))"
        let folder = root.trashURL.appendingPathComponent(folderName, isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let destination = folder.appendingPathComponent(target.fileName)
        do {
            try FileManager.default.moveItem(at: target.url, to: destination)
        } catch {
            try store.copy(from: target.url, to: destination)
            try FileManager.default.removeItem(at: target.url)
        }
        let metadata = TrashMetadata(
            courseId: try PathValidator.normalizedCourseId(courseId),
            fileName: target.fileName,
            tab: slug,
            deletedAt: ISO8601DateFormatter().string(from: Date())
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try store.write(try encoder.encode(metadata), to: folder.appendingPathComponent("metadata.json"))
        return destination
    }

    public func listTrashedDocuments(courseId: String? = nil) throws -> [TrashedDocument] {
        let normalized = try courseId.map { try PathValidator.normalizedCourseId($0) }
        guard let folders = try? FileManager.default.contentsOfDirectory(
            at: root.trashURL,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles]
        ) else { return [] }
        let decoder = JSONDecoder()
        var output: [TrashedDocument] = []
        for folder in folders {
            guard (try? folder.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true else { continue }
            let metadataURL = folder.appendingPathComponent("metadata.json")
            guard let data = try? Data(contentsOf: metadataURL),
                  let metadata = try? decoder.decode(TrashMetadata.self, from: data) else {
                continue
            }
            if let normalized, metadata.courseId != normalized { continue }
            guard FileManager.default.fileExists(
                atPath: folder.appendingPathComponent(metadata.fileName).path
            ) else { continue }
            output.append(
                TrashedDocument(
                    id: folder.lastPathComponent,
                    courseId: metadata.courseId,
                    fileName: metadata.fileName,
                    tab: metadata.tab,
                    deletedAt: metadata.deletedAt
                )
            )
        }
        return output.sorted { $0.deletedAt > $1.deletedAt }
    }

    @discardableResult
    public func restoreTrashedDocument(id: String) throws -> DocumentSnapshot {
        guard !id.isEmpty,
              id != ".",
              id != "..",
              !id.contains("/"),
              !id.contains("\\") else {
            throw PathValidationError("Invalid trash id: \(id)")
        }
        try root.acquireWriteLease(owner: leaseOwner, timeout: leaseTimeout)
        defer { root.releaseWriteLease(owner: leaseOwner) }
        let folder = try PathValidator.safeJoin(base: root.trashURL, id)
        let metadataURL = folder.appendingPathComponent("metadata.json")
        guard let metadataData = try? Data(contentsOf: metadataURL),
              let metadata = try? JSONDecoder().decode(TrashMetadata.self, from: metadataData),
              let parsed = PathValidator.parseDocFileName(metadata.fileName) else {
            throw RepositoryError.notFound("trash entry \(id)")
        }
        let scope: GeneratedDocumentScope
        if parsed.isCourseScope {
            scope = .course
        } else if parsed.isUnitScope {
            scope = .unit(parsed.unitNumber ?? 0)
        } else {
            scope = .lesson(parsed.lessonId)
        }
        let target = try generatedDocumentTarget(
            courseId: metadata.courseId,
            scope: scope,
            tab: parsed.tab
        )
        guard !store.exists(target.url) else {
            throw RepositoryError.alreadyExists(target.fileName)
        }
        let source = folder.appendingPathComponent(metadata.fileName)
        guard store.exists(source) else {
            throw RepositoryError.notFound("trash entry \(id)")
        }
        try FileManager.default.createDirectory(
            at: target.url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        do {
            try FileManager.default.moveItem(at: source, to: target.url)
        } catch {
            try store.copy(from: source, to: target.url)
            try FileManager.default.removeItem(at: source)
        }
        try? FileManager.default.removeItem(at: folder)
        let data = try store.read(target.url)
        guard let content = String(data: data, encoding: .utf8) else {
            throw AtomicFileStoreError.notUTF8(target.fileName)
        }
        return DocumentSnapshot(
            courseId: metadata.courseId,
            scope: scope,
            tab: parsed.tab,
            fileName: target.fileName,
            content: content,
            sha256: SHA256.hex(data),
            existed: true,
            modifiedAt: store.modificationDate(target.url)
        )
    }

    private struct TrashMetadata: Codable {
        var courseId: String
        var fileName: String
        var tab: String
        var deletedAt: String
    }

    // MARK: - Pop quizzes

    public func listPopQuizzes(courseId: String, lessonId: String) throws -> [PopQuizReference] {
        let course = try root.courseURL(courseId)
        let lesson = try PathValidator.lessonId(lessonId)
        guard let files = try? FileManager.default.contentsOfDirectory(
            at: course,
            includingPropertiesForKeys: [.contentModificationDateKey],
            options: [.skipsHiddenFiles]
        ) else { return [] }
        var output: [PopQuizReference] = []
        for file in files {
            guard let parsed = PathValidator.parsePopQuizFileName(file.lastPathComponent),
                  parsed.lessonId.lowercased() == lesson.lowercased() else { continue }
            output.append(
                PopQuizReference(
                    lessonId: parsed.lessonId,
                    timestamp: parsed.timestamp,
                    fileName: file.lastPathComponent,
                    modifiedAt: (try? file.resourceValues(forKeys: [.contentModificationDateKey]))?
                        .contentModificationDate
                )
            )
        }
        return output.sorted()
    }

    public func popQuizContent(
        courseId: String,
        lessonId: String,
        timestamp: String
    ) throws -> String? {
        let course = try root.courseURL(courseId)
        let fileName = try popQuizFileName(lessonId: lessonId, timestamp: timestamp)
        let url = try PathValidator.safeJoin(base: course, fileName)
        guard store.exists(url) else { return nil }
        return try store.readString(url)
    }

    /// Writes a newly generated pop quiz beside the lesson with the same
    /// `<lessonId>.popquiz.<timestamp>.md` filename pattern as desktop.
    @discardableResult
    public func savePopQuiz(
        courseId: String,
        lessonId: String,
        timestamp: String,
        content: String
    ) throws -> String {
        try root.acquireWriteLease(owner: leaseOwner, timeout: leaseTimeout)
        defer { root.releaseWriteLease(owner: leaseOwner) }
        return try writePopQuizLocked(
            courseId: courseId,
            lessonId: lessonId,
            timestamp: timestamp,
            content: content
        )
    }

    /// Chooses a unique timestamp while holding the repository write lease.
    /// Two generations in the same wall-clock second therefore produce two
    /// distinct loadable files. Retries are bounded.
    @discardableResult
    public func saveNewPopQuiz(
        courseId: String,
        lessonId: String,
        content: String,
        now: Date = Date(),
        maxAttempts: Int = 30
    ) throws -> PopQuizReference {
        try saveNewPopQuiz(
            courseId: courseId,
            lessonId: lessonId,
            contentBuilder: { _ in content },
            now: now,
            maxAttempts: maxAttempts
        )
    }

    /// Variant for generated content that needs the chosen timestamp in its
    /// frontmatter. The builder runs under the same write lease.
    @discardableResult
    public func saveNewPopQuiz(
        courseId: String,
        lessonId: String,
        contentBuilder: (String) -> String,
        now: Date = Date(),
        maxAttempts: Int = 30
    ) throws -> PopQuizReference {
        try root.acquireWriteLease(owner: leaseOwner, timeout: leaseTimeout)
        defer { root.releaseWriteLease(owner: leaseOwner) }
        let attempts = max(1, maxAttempts)
        for attempt in 0..<attempts {
            let candidate = now.addingTimeInterval(TimeInterval(attempt))
            let timestamp = PopQuizTimestamp.string(candidate)
            do {
                let fileName = try writePopQuizLocked(
                    courseId: courseId,
                    lessonId: lessonId,
                    timestamp: timestamp,
                    content: contentBuilder(timestamp)
                )
                return PopQuizReference(
                    lessonId: lessonId,
                    timestamp: timestamp,
                    fileName: fileName,
                    modifiedAt: Date()
                )
            } catch let error as RepositoryError {
                if case .alreadyExists = error { continue }
                throw error
            }
        }
        throw RepositoryError.alreadyExists("a unique pop-quiz timestamp after \(attempts) attempts")
    }

    private func writePopQuizLocked(
        courseId: String,
        lessonId: String,
        timestamp: String,
        content: String
    ) throws -> String {
        let course = try root.courseURL(courseId)
        try FileManager.default.createDirectory(at: course, withIntermediateDirectories: true)
        let fileName = try popQuizFileName(lessonId: lessonId, timestamp: timestamp)
        let url = try PathValidator.safeJoin(base: course, fileName)
        guard !store.exists(url) else {
            throw RepositoryError.alreadyExists(fileName)
        }
        try store.write(content, to: url)
        return fileName
    }

    private func popQuizFileName(lessonId: String, timestamp: String) throws -> String {
        let lesson = try PathValidator.lessonId(lessonId).lowercased()
        let candidate = "\(lesson).popquiz.\(timestamp).md"
        guard PathValidator.parsePopQuizFileName(candidate) != nil else {
            throw PathValidationError("Invalid pop-quiz timestamp: \(timestamp)")
        }
        return candidate
    }

    // MARK: - Generation compare-and-save

    /// Reads the current document and writes a `.bak` snapshot without
    /// changing the live file. Used before a corrupt-frontmatter refusal.
    @discardableResult
    public func snapshotGeneratedDocument(
        courseId: String,
        scope: GeneratedDocumentScope,
        tab: String
    ) throws -> URL? {
        try root.acquireWriteLease(owner: leaseOwner, timeout: leaseTimeout)
        defer { root.releaseWriteLease(owner: leaseOwner) }
        let target = try generatedDocumentTarget(courseId: courseId, scope: scope, tab: tab)
        guard store.exists(target.url) else { return nil }
        let data = try store.read(target.url)
        guard !data.isEmpty else { return nil }
        let backup = target.url.deletingLastPathComponent()
            .appendingPathComponent(target.url.lastPathComponent + ".bak")
        try store.write(data, to: backup)
        return backup
    }

    /// Atomic read/compare/snapshot/write for generated documents. The hash
    /// must be the SHA-256 of the bytes read when the generation was prepared;
    /// a concurrent editor write therefore fails instead of being overwritten.
    @discardableResult
    public func compareAndSaveGeneratedDocument(
        courseId: String,
        scope: GeneratedDocumentScope,
        tab: String,
        content: String,
        expectedExistingSHA256: String
    ) throws -> String {
        try root.acquireWriteLease(owner: leaseOwner, timeout: leaseTimeout)
        defer { root.releaseWriteLease(owner: leaseOwner) }
        let target = try generatedDocumentTarget(courseId: courseId, scope: scope, tab: tab)
        let backup = target.url.deletingLastPathComponent()
            .appendingPathComponent(target.url.lastPathComponent + ".bak")
        try coordinatedCompareAndReplace(
            url: target.url,
            backupURL: backup,
            content: Data(content.utf8),
            expectedSHA256: expectedExistingSHA256,
            force: false,
            fileName: target.fileName
        )
        return target.fileName
    }

    /// Coordinates the replace with other file presenters (the editor, Files
    /// app, another scene) so the compare-and-swap cannot race an external
    /// write. The coordination closure cannot throw, so the write error is
    /// captured and rethrown after coordination.
    /// Performs read → compare → `.bak` → replace inside one
    /// `NSFileCoordinator` block, so an external Files-app/two-scene writer
    /// cannot slip between the hash check and the write.
    private func coordinatedCompareAndReplace(
        url: URL,
        backupURL: URL,
        content: Data,
        expectedSHA256: String,
        force: Bool,
        fileName: String
    ) throws {
        let coordinator = NSFileCoordinator()
        var coordinationError: NSError?
        var writeError: Error?
        coordinator.coordinate(
            writingItemAt: url,
            options: .forReplacing,
            error: &coordinationError
        ) { coordinatedURL in
            do {
                let existing = store.exists(coordinatedURL) ? try store.read(coordinatedURL) : Data()
                if !force, SHA256.hex(existing) != expectedSHA256 {
                    throw RepositoryError.concurrentModification(fileName)
                }
                if !existing.isEmpty {
                    try store.write(existing, to: backupURL)
                }
                try store.write(content, to: coordinatedURL)
            } catch {
                writeError = error
            }
        }
        if let coordinationError {
            throw RepositoryError.coordinationFailed(coordinationError.localizedDescription)
        }
        if let writeError {
            throw writeError
        }
    }

    private func generatedDocumentTarget(
        courseId: String,
        scope: GeneratedDocumentScope,
        tab: String
    ) throws -> (url: URL, fileName: String) {
        let course = try root.courseURL(courseId)
        let fileName: String
        switch scope {
        case let .lesson(lessonId):
            fileName = try PathValidator.tabFileName(lessonId: lessonId, tab: tab)
        case let .unit(number):
            fileName = try PathValidator.unitDocFileName(unit: number, tab: tab)
        case .course:
            fileName = try PathValidator.courseDocFileName(tab: tab)
        }
        return (try PathValidator.safeJoin(base: course, fileName), fileName)
    }

    // MARK: - Assets

    public func assetURL(courseId: String, relativePath: String) throws -> URL? {
        let course = try root.courseURL(courseId)
        let components = relativePath
            .split(whereSeparator: { $0 == "/" || $0 == "\\" })
            .map(String.init)
        guard !components.isEmpty else { return nil }
        let url = try PathValidator.safeJoin(base: course, components: ["assets"] + components)
        guard store.exists(url) else { return nil }
        var isDirectory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory),
              !isDirectory.boolValue else { return nil }
        return url
    }

    /// All course files (for the backup exporter and missing-work scans).
    public func listCourseFiles(courseId: String) throws -> [URL] {
        let course = try root.courseURL(courseId)
        guard let enumerator = FileManager.default.enumerator(
            at: course,
            includingPropertiesForKeys: [.isRegularFileKey],
            options: [.skipsHiddenFiles]
        ) else { return [] }
        var files: [URL] = []
        for case let url as URL in enumerator {
            if (try? url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true {
                files.append(url)
            }
        }
        return files
    }
}

extension FileQuarantine {
    /// Keeps a `.bak` copy, then moves the corrupt file into quarantine.
    func quarantineFile(_ url: URL, reason: String, store: AtomicFileStore) throws -> URL? {
        _ = try? backupCopy(url)
        return try? quarantine(url, reason: reason)
    }
}
