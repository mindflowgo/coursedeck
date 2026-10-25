import Foundation

// MARK: - Attempts

public enum QuizAttemptKind: String, Codable, Equatable, Sendable {
    case practice
    case unitTest = "unit-test"
    case popQuiz = "pop-quiz"
}

public struct QuizAttempt: Codable, Equatable, Sendable, Identifiable {
    public var id: String
    public var courseId: String
    public var lessonId: String?
    public var kind: QuizAttemptKind
    /// The document filename or pop-quiz timestamp that was attempted.
    public var quizKey: String
    public var title: String
    /// ISO-8601 timestamp (UTC).
    public var date: String
    public var score: Double
    public var total: Int
    public var percentage: Int
    public var durationSeconds: Int
    public var timedOut: Bool
    /// Pop-quiz answers are retained for attempt history. Unit-test attempt
    /// files never contain raw answers.
    public var answers: [String: String]?
    public var usedAI: Bool

    public init(
        id: String = UUID().uuidString,
        courseId: String,
        lessonId: String? = nil,
        kind: QuizAttemptKind,
        quizKey: String,
        title: String,
        date: String,
        score: Double,
        total: Int,
        percentage: Int,
        durationSeconds: Int = 0,
        timedOut: Bool = false,
        answers: [String: String]? = nil,
        usedAI: Bool = false
    ) {
        self.id = id
        self.courseId = courseId
        self.lessonId = lessonId
        self.kind = kind
        self.quizKey = quizKey
        self.title = title
        self.date = date
        self.score = score
        self.total = total
        self.percentage = percentage
        self.durationSeconds = durationSeconds
        self.timedOut = timedOut
        self.answers = answers
        self.usedAI = usedAI
    }
}

/// One JSON file per attempt under `<root>/attempts/` (allowlisted in app
/// export, excluded from device backup by `DataRoot.prepare`).
public struct QuizAttemptStore: Sendable {
    private let root: DataRoot
    private let store: AtomicFileStore

    public init(root: DataRoot, store: AtomicFileStore = AtomicFileStore()) {
        self.root = root
        self.store = store
    }

    @discardableResult
    public func record(_ attempt: QuizAttempt) throws -> URL {
        try root.acquireWriteLease(owner: "QuizAttemptStore")
        defer { root.releaseWriteLease(owner: "QuizAttemptStore") }
        try FileManager.default.createDirectory(at: root.attemptsURL, withIntermediateDirectories: true)
        let name = [
            safe(attempt.courseId),
            safe(attempt.lessonId ?? "course"),
            attempt.kind.rawValue,
            safe(attempt.quizKey, maxLength: 40),
            safe(attempt.date, maxLength: 24),
            safe(String(attempt.id.prefix(8)), maxLength: 8),
        ].joined(separator: "-") + ".json"
        let url = root.attemptsURL.appendingPathComponent(name)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let data = try encoder.encode(attempt)
        try store.write(data, to: url)
        return url
    }

    public func attempts(
        courseId: String? = nil,
        lessonId: String? = nil,
        kind: QuizAttemptKind? = nil
    ) throws -> [QuizAttempt] {
        guard let files = try? FileManager.default.contentsOfDirectory(
            at: root.attemptsURL,
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles]
        ) else { return [] }
        let decoder = JSONDecoder()
        var output: [QuizAttempt] = []
        for file in files where file.pathExtension.lowercased() == "json" {
            guard let data = try? Data(contentsOf: file),
                  let attempt = try? decoder.decode(QuizAttempt.self, from: data) else { continue }
            if let courseId, attempt.courseId != courseId { continue }
            if let lessonId, attempt.lessonId != lessonId { continue }
            if let kind, attempt.kind != kind { continue }
            output.append(attempt)
        }
        return output.sorted {
            if $0.date == $1.date { return $0.id > $1.id }
            return $0.date > $1.date
        }
    }

    public func attempt(id: String, courseId: String? = nil) throws -> QuizAttempt? {
        try attempts(courseId: courseId).first { $0.id == id }
    }

    private func safe(_ value: String, maxLength: Int = 64) -> String {
        let cleaned = value
            .lowercased()
            .replacingOccurrences(of: "[^a-z0-9._-]", with: "_", options: .regularExpression)
            .replacingOccurrences(of: "_+", with: "_", options: .regularExpression)
            .trimmingCharacters(in: CharacterSet(charactersIn: "._-"))
        let trimmed = cleaned.isEmpty ? "unnamed" : cleaned
        return String(trimmed.prefix(maxLength))
    }
}

// MARK: - Pop-quiz history commit

public protocol QuizAttemptRecording: Sendable {
    @discardableResult
    func record(_ attempt: QuizAttempt) throws -> URL
}

extension QuizAttemptStore: QuizAttemptRecording {}

/// Commits a pop-quiz result in the safe order: persist the final session,
/// write the attempt JSON, then remove the draft and session. A history write
/// failure leaves the completed session recoverable for a retry.
public struct PopQuizAttemptRecorder: Sendable {
    private let attempts: any QuizAttemptRecording
    private let drafts: QuizDraftStore

    public init(root: DataRoot) {
        self.attempts = QuizAttemptStore(root: root)
        self.drafts = QuizDraftStore(root: root)
    }

    public init(attempts: any QuizAttemptRecording, drafts: QuizDraftStore) {
        self.attempts = attempts
        self.drafts = drafts
    }

    @discardableResult
    public func record(
        attempt: QuizAttempt,
        session: PopQuizSession,
        draftKey: String,
        submittedAt: Date = Date()
    ) throws -> QuizAttempt {
        var finalSession = session
        if let answers = attempt.answers { finalSession.answers = answers }
        finalSession.score = attempt.score
        finalSession.total = attempt.total
        finalSession.durationSeconds = attempt.durationSeconds
        finalSession.timedOut = attempt.timedOut
        finalSession.submittedAt = submittedAt
        try drafts.savePopQuizSession(finalSession)
        try attempts.record(attempt)
        try? drafts.delete(key: draftKey)
        try? drafts.deletePopQuizSession(key: finalSession.key)
        return attempt
    }
}

// MARK: - Drafts

public struct QuizDraft: Codable, Equatable, Sendable {
    public var key: String
    public var contentHash: String
    public var answers: [String: String]
    public var updatedAt: String

    public init(
        key: String,
        contentHash: String,
        answers: [String: String],
        updatedAt: String
    ) {
        self.key = key
        self.contentHash = contentHash
        self.answers = answers
        self.updatedAt = updatedAt
    }
}

/// Private draft and timer storage under `<root>/drafts/`, excluded from
/// device/iCloud backup and from app exports.
public struct QuizDraftStore: Sendable {
    private let root: DataRoot
    private let store: AtomicFileStore

    public init(root: DataRoot, store: AtomicFileStore = AtomicFileStore()) {
        self.root = root
        self.store = store
    }

    // MARK: In-progress answers

    public func save(_ draft: QuizDraft) throws {
        try root.acquireWriteLease(owner: "QuizDraftStore")
        defer { root.releaseWriteLease(owner: "QuizDraftStore") }
        let url = try draftURL(key: draft.key)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try store.write(try encoder.encode(draft), to: url)
    }

    /// Returns a draft only when it belongs to the current document content.
    /// A changed quiz resets answers instead of restoring them against a new
    /// question set (PLAN §4.10 content hash/reset).
    public func load(key: String, contentHash: String) -> QuizDraft? {
        guard let url = try? draftURL(key: key),
              let existing = try? store.read(url),
              let draft = try? JSONDecoder().decode(QuizDraft.self, from: existing) else {
            return nil
        }
        guard draft.contentHash == contentHash else {
            try? delete(key: key)
            return nil
        }
        return draft
    }

    public func delete(key: String) throws {
        try root.acquireWriteLease(owner: "QuizDraftStore")
        defer { root.releaseWriteLease(owner: "QuizDraftStore") }
        let url = try draftURL(key: key)
        try store.removeIfExists(url)
    }

    // MARK: Pop-quiz timer

    public func savePopQuizSession(_ session: PopQuizSession) throws {
        try root.acquireWriteLease(owner: "QuizDraftStore")
        defer { root.releaseWriteLease(owner: "QuizDraftStore") }
        let url = try popQuizSessionURL(key: session.key)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try store.write(try encoder.encode(session), to: url)
    }

    public func loadPopQuizSession(key: String, contentHash: String) -> PopQuizSession? {
        guard let url = try? popQuizSessionURL(key: key),
              let data = try? store.read(url),
              let session = try? JSONDecoder().decode(PopQuizSession.self, from: data) else {
            return nil
        }
        guard session.contentHash == contentHash else {
            try? deletePopQuizSession(key: key)
            return nil
        }
        return session
    }

    public func deletePopQuizSession(key: String) throws {
        try root.acquireWriteLease(owner: "QuizDraftStore")
        defer { root.releaseWriteLease(owner: "QuizDraftStore") }
        try store.removeIfExists(try popQuizSessionURL(key: key))
    }

    public static func contentHash(_ markdown: String) -> String {
        SHA256.hex(Data(markdown.trimmingCharacters(in: .whitespacesAndNewlines).utf8))
    }

    // MARK: Paths

    private func draftURL(key: String) throws -> URL {
        let name = SHA256.hex(Data(key.utf8)) + ".json"
        return try PathValidator.safeJoin(base: root.draftsURL, "quiz", name)
    }

    private func popQuizSessionURL(key: String) throws -> URL {
        let name = SHA256.hex(Data(key.utf8)) + ".session.json"
        return try PathValidator.safeJoin(base: root.draftsURL, "popquiz", name)
    }
}

// MARK: - Pop-quiz timer state

public struct PopQuizSession: Codable, Equatable, Sendable {
    public var key: String
    public var contentHash: String
    /// Absolute deadline; remaining time is always recomputed from this value,
    /// never from a bare `Timer` counter.
    public var deadline: Date
    public var startedAt: Date
    public var answers: [String: String]
    public var durationSeconds: Int
    public var timedOut: Bool
    public var score: Double?
    public var total: Int?
    public var submittedAt: Date?

    public init(
        key: String,
        contentHash: String,
        deadline: Date,
        startedAt: Date,
        answers: [String: String] = [:],
        durationSeconds: Int = PopQuizSession.defaultDuration,
        timedOut: Bool = false,
        score: Double? = nil,
        total: Int? = nil,
        submittedAt: Date? = nil
    ) {
        self.key = key
        self.contentHash = contentHash
        self.deadline = deadline
        self.startedAt = startedAt
        self.answers = answers
        self.durationSeconds = durationSeconds
        self.timedOut = timedOut
        self.score = score
        self.total = total
        self.submittedAt = submittedAt
    }

    public static let defaultDuration = 300

    public func remainingSeconds(now: Date = Date()) -> Int {
        max(0, Int(ceil(deadline.timeIntervalSince(now))))
    }

    public func hasExpired(now: Date = Date()) -> Bool {
        deadline.timeIntervalSince(now) <= 0
    }

    public func elapsedSeconds(now: Date = Date()) -> Int {
        max(0, durationSeconds - remainingSeconds(now: now))
    }
}
