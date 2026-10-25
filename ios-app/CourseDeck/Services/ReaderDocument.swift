import CourseDeckCore
import Foundation

/// Which file a reader is displaying. The file-name mapping is deliberately
/// derived through `PathValidator` so checkpoints keep the desktop's exact
/// `file` strings.
enum ReaderScope: Hashable, Sendable {
    case lesson(String)
    case unit(Int)
    case course
}

struct ReaderTarget: Hashable, Sendable {
    var courseId: String
    var scope: ReaderScope
    var tab: String

    var id: String {
        switch scope {
        case let .lesson(lessonId): return "\(courseId):\(lessonId):\(tab)"
        case let .unit(number): return "\(courseId):unit-\(number):\(tab)"
        case .course: return "\(courseId):course:\(tab)"
        }
    }

    /// Resolves a checkpoint's `file` value back into a reader target.
    static func from(file: String, courseId: String) -> ReaderTarget? {
        guard let parsed = PathValidator.parseDocFileName(file) else { return nil }
        if parsed.isCourseScope {
            return ReaderTarget(courseId: courseId, scope: .course, tab: parsed.tab)
        }
        if parsed.isUnitScope {
            return ReaderTarget(
                courseId: courseId,
                scope: .unit(parsed.unitNumber ?? 0),
                tab: parsed.tab
            )
        }
        return ReaderTarget(courseId: courseId, scope: .lesson(parsed.lessonId), tab: parsed.tab)
    }

    func fileName() throws -> String {
        switch scope {
        case let .lesson(lessonId):
            return try PathValidator.tabFileName(lessonId: lessonId, tab: tab)
        case let .unit(number):
            return try PathValidator.unitDocFileName(unit: number, tab: tab)
        case .course:
            return try PathValidator.courseDocFileName(tab: tab)
        }
    }
}

struct ReaderDocument: Identifiable, Sendable {
    var courseId: String
    var courseTitle: String
    var target: ReaderTarget
    var title: String
    /// Desktop-compatible checkpoint file name.
    var file: String
    var markdown: String
    var courseDirectoryURL: URL
    /// Sample content and course-scope pages without a file never write
    /// checkpoints.
    var supportsCheckpoints: Bool
    /// True for a read-only surface such as `course.schedule.md`.
    var isReadOnly: Bool

    var id: String { "\(courseId):\(file)" }
}

enum ReaderDocumentError: Error, LocalizedError, Equatable {
    case courseNotFound(String)
    case lessonNotFound(String)
    case notGenerated(String)
    case missingFile(String)

    var errorDescription: String? {
        switch self {
        case let .courseNotFound(id): return "Course \(id) was not found."
        case let .lessonNotFound(id): return "Lesson \(id) was not found."
        case let .notGenerated(title): return "\(title) has not been generated yet."
        case let .missingFile(name): return "\(name) is missing."
        }
    }
}

/// A document may be structurally writable but still must not create
/// checkpoints when the data root is read-only (newer/corrupt dataVersion) or
/// the document is a read-only surface such as a schedule or the virtual
/// `course.lesson` page.
enum ReaderSavePolicy {
    static func canSave(document: ReaderDocument?, isWritable: Bool) -> Bool {
        guard let document else { return false }
        return document.supportsCheckpoints && !document.isReadOnly && isWritable
    }
}

/// Loads Markdown and metadata from the Application Support data root. Core
/// owns validation and repositories; this service only maps a reader target to
/// the repository call and the checkpoint filename.
actor ReaderDocumentProvider {
    private let root: DataRoot
    private let repository: CourseRepository
    private let store = AtomicFileStore()

    init(root: DataRoot, repository: CourseRepository) {
        self.root = root
        self.repository = repository
    }

    func load(_ target: ReaderTarget) async throws -> ReaderDocument {
        guard let manifest = try await repository.course(courseId: target.courseId) else {
            throw ReaderDocumentError.courseNotFound(target.courseId)
        }

        let file = try target.fileName()
        let directory = try root.courseURL(target.courseId)
        let markdown: String
        let title: String
        let readOnly: Bool

        if case .course = target.scope, target.tab == "lesson" {
            // `course.lesson` is the virtual Course Navigation page. It is
            // generated from the manifest, never read from a stale
            // course.lesson.md, but the checkpoint `file` string stays
            // `course.lesson.md` for desktop compatibility.
            return ReaderDocument(
                courseId: target.courseId,
                courseTitle: manifest.title,
                target: target,
                title: "Course Navigation",
                file: file,
                markdown: Self.courseNavigationMarkdown(manifest),
                courseDirectoryURL: directory,
                supportsCheckpoints: false,
                isReadOnly: true
            )
        }

        switch target.scope {
        case let .lesson(lessonId):
            guard let lesson = manifest.lesson(id: lessonId) ?? fallbackLesson(lessonId) else {
                throw ReaderDocumentError.lessonNotFound(lessonId)
            }
            if target.tab == "lesson" {
                if let bundle = try await repository.lessonBundle(courseId: target.courseId, lessonId: lessonId),
                   !bundle.lesson.isEmpty {
                    markdown = bundle.lesson
                } else {
                    throw ReaderDocumentError.missingFile(file)
                }
            } else if let content = try await repository.tabContent(
                courseId: target.courseId,
                lessonId: lessonId,
                tab: target.tab
            ) {
                markdown = content
            } else {
                throw ReaderDocumentError.notGenerated(lesson.title.isEmpty ? lessonId : lesson.title)
            }
            title = lesson.title.isEmpty ? lessonId : lesson.title
            readOnly = false

        case let .unit(number):
            guard let content = try await repository.unitDocument(
                courseId: target.courseId,
                unit: number,
                tab: target.tab
            ) else {
                throw ReaderDocumentError.notGenerated("Unit \(number) \(target.tab)")
            }
            markdown = content
            title = manifest.unit(number: number)?.title ?? "Unit \(number)"
            readOnly = false

        case .course:
            guard let content = try await repository.courseDocument(
                courseId: target.courseId,
                tab: target.tab
            ) else {
                throw ReaderDocumentError.notGenerated("Course \(target.tab)")
            }
            markdown = content
            title = target.tab == "lesson" ? "Course navigation" : manifest.title
            // `course.lesson` is the virtual Course Navigation page in the
            // desktop model. It is read-only here so existing
            // `course.lesson.md` checkpoint file strings remain compatible
            // without writing new checkpoints for a virtual page.
            readOnly = target.tab == "schedule" || target.tab == "lesson"
        }

        return ReaderDocument(
            courseId: target.courseId,
            courseTitle: manifest.title,
            target: target,
            title: title,
            file: file,
            markdown: markdown,
            courseDirectoryURL: directory,
            supportsCheckpoints: !readOnly,
            isReadOnly: readOnly
        )
    }

    /// Loads the bundled sample without creating a course, a manifest, or a
    /// checkpoint entry. Assets are written under a hidden sample directory so
    /// the Markdown pipeline can prove it only resolves files inside
    /// `<course>/assets/`.
    func loadSample() async -> ReaderDocument {
        let sampleDirectory = root.rootURL.appendingPathComponent(".reader-sample", isDirectory: true)
        let fileManager = FileManager.default
        try? fileManager.createDirectory(
            at: sampleDirectory.appendingPathComponent("assets/icons", isDirectory: true),
            withIntermediateDirectories: true
        )
        let markdownURL = sampleDirectory.appendingPathComponent("sample.reader.md")
        try? Data(ReaderSampleDocument.markdown.utf8).write(to: markdownURL, options: .atomic)
        let iconURL = sampleDirectory.appendingPathComponent("assets/icons/deck.svg")
        try? Data(ReaderSampleDocument.iconSVG.utf8).write(to: iconURL, options: .atomic)

        let target = ReaderTarget(courseId: "sample", scope: .lesson("sample"), tab: "reader")
        return ReaderDocument(
            courseId: "sample",
            courseTitle: "Reader sample",
            target: target,
            title: "Reader sample",
            file: "sample.reader.md",
            markdown: ReaderSampleDocument.markdown,
            courseDirectoryURL: sampleDirectory,
            supportsCheckpoints: false,
            isReadOnly: true
        )
    }

    private func fallbackLesson(_ lessonId: String) -> CourseLesson? {
        guard let parsed = PathValidator.parseDocFileName("\(lessonId).lesson.md") else { return nil }
        return CourseLesson(id: parsed.lessonId)
    }

    static func courseNavigationMarkdown(_ manifest: CourseManifest) -> String {
        var lines: [String] = []
        lines.append("# \(manifest.title) — Course Navigation")
        lines.append("")
        if !manifest.description.isEmpty {
            lines.append(manifest.description)
            lines.append("")
        }
        if manifest.units.isEmpty {
            lines.append("_No units or lessons are recorded in `meta.json` yet._")
        }
        for unit in manifest.units.sorted(by: { $0.number < $1.number }) {
            let unitTitle = unit.title.isEmpty ? "Unit \(unit.number)" : unit.title
            lines.append("## \(unitTitle)")
            lines.append("")
            if unit.lessons.isEmpty {
                lines.append("_No lessons in this unit._")
            } else {
                for lesson in unit.lessons {
                    let code = lesson.code.isEmpty ? lesson.id : lesson.code
                    let lessonTitle = lesson.title.isEmpty ? lesson.id : lesson.title
                    lines.append("- **\(code)** — \(lessonTitle)")
                }
            }
            lines.append("")
        }
        return lines.joined(separator: "\n")
    }
}
