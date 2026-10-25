import Foundation

public struct CourseNoteCheckpoint: Equatable, Sendable {
    public var checkpoint: Checkpoint
    public var courseId: String
    public var courseTitle: String

    public init(checkpoint: Checkpoint, courseId: String, courseTitle: String) {
        self.checkpoint = checkpoint
        self.courseId = courseId
        self.courseTitle = courseTitle
    }
}

/// Checkpoint persistence (`<course>/checkpoint.json`, a top-level array).
/// Position checkpoints keep the desktop's one-per-file rule; note checkpoints
/// are merged by ID. New writes carry both `verticalPosition` and
/// `anchorBlockID`/`anchorFraction` (PLAN §3.2).
public actor CheckpointRepository {
    private let root: DataRoot
    private let store: AtomicFileStore
    private let quarantine: FileQuarantine
    private let leaseOwner: String

    public init(root: DataRoot, store: AtomicFileStore = AtomicFileStore()) {
        self.root = root
        self.store = store
        self.quarantine = FileQuarantine(rootURL: root.quarantineURL)
        self.leaseOwner = "CheckpointRepository.\(UUID().uuidString)"
    }

    public func checkpointURL(courseId: String) throws -> URL {
        let course = try root.courseURL(courseId)
        return try PathValidator.safeJoin(base: course, "checkpoint.json")
    }

    public func read(courseId: String) throws -> CheckpointDocument {
        let url = try checkpointURL(courseId: courseId)
        guard store.exists(url) else { return CheckpointDocument() }
        do {
            return try CheckpointDocument(data: store.read(url))
        } catch {
            let quarantined = try? quarantine.quarantineFile(
                url,
                reason: "unreadable checkpoint.json: \(error)",
                store: store
            )
            throw RepositoryError.corrupt("checkpoint.json", quarantinedAt: quarantined)
        }
    }

    public func save(_ document: CheckpointDocument, courseId: String) throws {
        try root.acquireWriteLease(owner: leaseOwner)
        defer { root.releaseWriteLease(owner: leaseOwner) }
        let course = try root.courseURL(courseId)
        try FileManager.default.createDirectory(at: course, withIntermediateDirectories: true)
        try store.write(document.encoded(), to: try checkpointURL(courseId: courseId))
    }

    /// Creates or updates the single position checkpoint for `file`.
    @discardableResult
    public func recordPosition(
        courseId: String,
        file: String,
        verticalPosition: Double,
        anchorBlockID: String,
        anchorFraction: Double,
        date: String = GenerationJob.timestamp()
    ) throws -> Checkpoint {
        try root.acquireWriteLease(owner: leaseOwner)
        defer { root.releaseWriteLease(owner: leaseOwner) }
        try validateCheckpointFile(file)
        var document = try read(courseId: courseId)
        let fraction = Self.safeFraction(anchorFraction)
        let cleanFile = file.trimmingCharacters(in: .whitespacesAndNewlines)
        let cleanPosition = Self.safePosition(verticalPosition)

        if let index = document.checkpoints.firstIndex(where: {
            $0.type == .position && $0.file == cleanFile
        }) {
            document.checkpoints[index].verticalPosition = cleanPosition
            document.checkpoints[index].anchorBlockID = anchorBlockID
            document.checkpoints[index].anchorFraction = fraction
            document.checkpoints[index].date = date
            try save(document, courseId: courseId)
            return document.checkpoints[index]
        }

        let checkpoint = Checkpoint(
            id: "cp_pos_\(Self.randomSuffix())",
            file: cleanFile,
            verticalPosition: cleanPosition,
            type: .position,
            date: date,
            anchorBlockID: anchorBlockID,
            anchorFraction: fraction
        )
        document.checkpoints.append(checkpoint)
        try save(document, courseId: courseId)
        return checkpoint
    }

    /// Creates or updates a note checkpoint. Updating preserves the desktop's
    /// existing color/note text when the caller omits them.
    @discardableResult
    public func addOrUpdateNote(
        courseId: String,
        id: String? = nil,
        file: String,
        verticalPosition: Double,
        anchorBlockID: String,
        anchorFraction: Double,
        color: String? = nil,
        noteText: String? = nil,
        date: String = GenerationJob.timestamp()
    ) throws -> Checkpoint {
        try root.acquireWriteLease(owner: leaseOwner)
        defer { root.releaseWriteLease(owner: leaseOwner) }
        try validateCheckpointFile(file)
        var document = try read(courseId: courseId)
        let fraction = Self.safeFraction(anchorFraction)
        let cleanFile = file.trimmingCharacters(in: .whitespacesAndNewlines)
        let cleanPosition = Self.safePosition(verticalPosition)

        if let id, let index = document.checkpoints.firstIndex(where: { $0.id == id }) {
            document.checkpoints[index].file = cleanFile
            document.checkpoints[index].verticalPosition = cleanPosition
            document.checkpoints[index].anchorBlockID = anchorBlockID
            document.checkpoints[index].anchorFraction = fraction
            document.checkpoints[index].color = color ?? document.checkpoints[index].color ?? "yellow"
            document.checkpoints[index].noteText = noteText ?? document.checkpoints[index].noteText ?? ""
            document.checkpoints[index].date = date
            try save(document, courseId: courseId)
            return document.checkpoints[index]
        }

        let checkpoint = Checkpoint(
            id: id ?? "cp_note_\(Self.randomSuffix())",
            file: cleanFile,
            verticalPosition: cleanPosition,
            type: .note,
            color: color ?? "yellow",
            noteText: noteText ?? "",
            date: date,
            anchorBlockID: anchorBlockID,
            anchorFraction: fraction
        )
        document.checkpoints.append(checkpoint)
        try save(document, courseId: courseId)
        return checkpoint
    }

    @discardableResult
    public func delete(courseId: String, checkpointId: String) throws -> Bool {
        try root.acquireWriteLease(owner: leaseOwner)
        defer { root.releaseWriteLease(owner: leaseOwner) }
        var document = try read(courseId: courseId)
        let before = document.checkpoints.count
        document.checkpoints.removeAll { $0.id == checkpointId }
        guard document.checkpoints.count != before else { return false }
        try save(document, courseId: courseId)
        return true
    }

    public func positionCheckpoint(courseId: String, file: String) throws -> Checkpoint? {
        try read(courseId: courseId).checkpoints.first(where: {
            $0.type == .position && $0.file == file
        })
    }

    /// Newest-first note checkpoints across active courses (global hub).
    public func allNoteCheckpoints(excludingArchived: Bool = true) throws -> [CourseNoteCheckpoint] {
        let fileManager = FileManager.default
        guard fileManager.fileExists(atPath: root.coursesURL.path) else { return [] }
        let entries = try fileManager.contentsOfDirectory(
            at: root.coursesURL,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles]
        )
        var notes: [CourseNoteCheckpoint] = []
        for entry in entries where (try? entry.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) == true {
            let courseId = entry.lastPathComponent
            guard (try? PathValidator.courseId(courseId)) != nil else { continue }
            var courseTitle = courseId
            if let manifest = try? CourseManifest.decode(store.read(entry.appendingPathComponent("meta.json"))) {
                if excludingArchived, manifest.archived == true { continue }
                courseTitle = manifest.title
            }
            guard let document = try? read(courseId: courseId) else { continue }
            for checkpoint in document.checkpoints where checkpoint.type == .note {
                notes.append(CourseNoteCheckpoint(
                    checkpoint: checkpoint,
                    courseId: courseId,
                    courseTitle: courseTitle
                ))
            }
        }
        return notes.sorted { lhs, rhs in
            (lhs.checkpoint.date, lhs.checkpoint.id) > (rhs.checkpoint.date, rhs.checkpoint.id)
        }
    }

    private func validateCheckpointFile(_ file: String) throws {
        let clean = file.trimmingCharacters(in: .whitespacesAndNewlines)
        guard clean == file,
              !clean.contains("/"),
              !clean.contains("\\"),
              PathValidator.parseDocFileName(clean) != nil else {
            throw CheckpointError.invalidFile(file)
        }
    }

    private static func randomSuffix() -> String {
        String(UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(10)).lowercased()
    }

    private static func safePosition(_ value: Double) -> Double {
        value.isFinite ? max(0, value.rounded(.down)) : 0
    }

    private static func safeFraction(_ value: Double) -> Double {
        value.isFinite ? min(max(value, 0), 1) : 0
    }
}
