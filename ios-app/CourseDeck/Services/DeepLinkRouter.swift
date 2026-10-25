import CourseDeckCore
import Foundation

// MARK: - Route

enum CourseDeckDeepLinkRoute: Equatable, Sendable {
    case course(courseId: String)
    case courseTab(courseId: String, tab: String)
    case lesson(courseId: String, lessonId: String, tab: String)
    case unit(courseId: String, unitNumber: Int, tab: String)
}

enum DeepLinkParseError: Error, LocalizedError, Equatable {
    case unsupportedScheme(String)
    case malformed(String)

    var errorDescription: String? {
        switch self {
        case let .unsupportedScheme(scheme):
            return "Unsupported link scheme: \(scheme)."
        case let .malformed(reason):
            return "Invalid CourseDeck link: \(reason)"
        }
    }
}

enum CourseDeckDeepLink {
    static let scheme = "coursedeck"

    /// Supported forms:
    /// `coursedeck://course/<courseId>[/<tab>]`
    /// `coursedeck://lesson/<courseId>/<lessonId>[/<tab>]`
    /// `coursedeck://unit/<courseId>/<unitNumber>[/<tab>]`
    static func parse(_ url: URL) -> Result<CourseDeckDeepLinkRoute, DeepLinkParseError> {
        guard let scheme = url.scheme?.lowercased(), scheme == Self.scheme else {
            return .failure(.unsupportedScheme(url.scheme ?? "none"))
        }
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let host = components.host?.lowercased() else {
            return .failure(.malformed("missing host"))
        }
        let rawPath = components.percentEncodedPath
        let path = rawPath.split(separator: "/", omittingEmptySubsequences: true).map { segment -> String? in
            guard let decoded = String(segment).removingPercentEncoding else { return nil }
            guard !decoded.isEmpty,
                  decoded != ".",
                  decoded != "..",
                  !decoded.contains("/"),
                  !decoded.contains("\\"),
                  !decoded.contains("\0") else { return nil }
            return decoded
        }
        guard path.allSatisfy({ $0 != nil }) else {
            return .failure(.malformed("unsafe path component"))
        }
        let parts = path.compactMap { $0 }

        func courseID(_ value: String) -> String? {
            (try? PathValidator.courseId(value))
        }
        func lessonID(_ value: String) -> String? {
            (try? PathValidator.lessonId(value))
        }
        func tab(_ value: String) -> String? {
            guard let clean = try? PathValidator.tab(value) else { return nil }
            guard !PathValidator.isUnitScopeId(clean) else { return nil }
            return clean
        }

        switch host {
        case "course":
            guard parts.count == 1 || parts.count == 2,
                  let courseID = courseID(parts[0]) else {
                return .failure(.malformed("course links need a valid course id"))
            }
            if parts.count == 2 {
                guard let tab = tab(parts[1]) else {
                    return .failure(.malformed("invalid tab slug"))
                }
                return .success(.courseTab(courseId: courseID, tab: tab))
            }
            return .success(.course(courseId: courseID))
        case "lesson":
            guard parts.count == 2 || parts.count == 3,
                  let courseID = courseID(parts[0]),
                  let lessonID = lessonID(parts[1]) else {
                return .failure(.malformed("lesson links need a course and lesson id"))
            }
            let tab = parts.count == 3 ? tab(parts[2]) : "lesson"
            guard let tab else {
                return .failure(.malformed("invalid tab slug"))
            }
            return .success(.lesson(courseId: courseID, lessonId: lessonID, tab: tab))
        case "unit":
            guard parts.count == 2 || parts.count == 3,
                  let courseID = courseID(parts[0]),
                  let unitNumber = Int(parts[1]),
                  (1...99).contains(unitNumber) else {
                return .failure(.malformed("unit links need a course and unit number"))
            }
            let tab = parts.count == 3 ? tab(parts[2]) : "assignments"
            guard let tab else {
                return .failure(.malformed("invalid tab slug"))
            }
            return .success(.unit(courseId: courseID, unitNumber: unitNumber, tab: tab))
        default:
            return .failure(.malformed("unsupported host \(host)"))
        }
    }
}

// MARK: - Resolution

struct DeepLinkAutoCreateRequest: Equatable, Sendable {
    var courseId: String
    var scope: ReaderScope
    var tab: String
    var fallback: ReaderTarget
}

enum DeepLinkResolution: Equatable, Sendable {
    case course(courseId: String)
    case reader(ReaderTarget)
    case quiz(QuizRequest)
    case needsAutoCreate(DeepLinkAutoCreateRequest)
    case invalid(String)
}

protocol DeepLinkDataSource: Sendable {
    func course(courseId: String) async throws -> CourseManifest?
    func discoverCourseDocs(courseId: String) async throws -> CourseDocsFlags
    func discoverUnitDocs(courseId: String, unitNumber: Int) async throws -> [String]
    func lessonBundle(courseId: String, lessonId: String) async throws -> LessonContentBundle?
    func createCustomDocument(
        courseId: String,
        scope: GeneratedDocumentScope,
        tab: String
    ) async throws -> DocumentSnapshot
}

extension CourseRepository: DeepLinkDataSource {
    func createCustomDocument(
        courseId: String,
        scope: GeneratedDocumentScope,
        tab: String
    ) async throws -> DocumentSnapshot {
        try await createCustomDocument(
            courseId: courseId,
            scope: scope,
            tab: tab,
            content: nil
        )
    }
}

struct DeepLinkResolver: Sendable {
    let dataSource: any DeepLinkDataSource

    init(dataSource: any DeepLinkDataSource) {
        self.dataSource = dataSource
    }

    func resolve(
        _ route: CourseDeckDeepLinkRoute,
        allowAutoCreate: Bool
    ) async -> DeepLinkResolution {
        switch route {
        case let .course(courseId):
            guard let manifest = try? await dataSource.course(courseId: courseId) else {
                return .invalid("Course \(courseId) was not found.")
            }
            return .course(courseId: manifest.id)

        case let .courseTab(courseId, tab):
            guard let manifest = try? await dataSource.course(courseId: courseId) else {
                return .invalid("Course \(courseId) was not found.")
            }
            let courseId = manifest.id
            let docs = (try? await dataSource.discoverCourseDocs(courseId: courseId)) ?? CourseDocsFlags()
            if let autoCreate = await autoCreateIfNeeded(
                courseId: courseId,
                scope: .course,
                tab: tab,
                existing: docs.custom[tab] == true,
                fallback: ReaderTarget(courseId: courseId, scope: .course, tab: "lesson"),
                allowAutoCreate: allowAutoCreate
            ) {
                return autoCreate
            }
            return destination(
                courseId: courseId,
                scope: .course,
                title: manifest.title,
                requested: tab,
                availableTabs: [],
                hasLesson: false,
                docs: docs
            )

        case let .lesson(courseId, lessonId, tab):
            guard let manifest = try? await dataSource.course(courseId: courseId) else {
                return .invalid("Course \(courseId) was not found.")
            }
            let courseId = manifest.id
            guard let lesson = manifest.lesson(id: lessonId) else {
                return .invalid("Lesson \(lessonId) was not found in \(courseId).")
            }
            let bundle = try? await dataSource.lessonBundle(courseId: courseId, lessonId: lessonId)
            let available = Set(bundle?.tabs.keys.map { $0 } ?? [])
            let hasLesson = !(bundle?.lesson.isEmpty ?? true)
            if let autoCreate = await autoCreateIfNeeded(
                courseId: courseId,
                scope: .lesson(lessonId),
                tab: tab,
                existing: available.contains(tab),
                fallback: ReaderTarget(
                    courseId: courseId,
                    scope: .lesson(lessonId),
                    tab: hasLesson ? "lesson" : "summary"
                ),
                allowAutoCreate: allowAutoCreate
            ) {
                return autoCreate
            }
            return destination(
                courseId: courseId,
                scope: .lesson(lessonId),
                title: lesson.title.isEmpty ? lessonId : lesson.title,
                requested: tab,
                availableTabs: available,
                hasLesson: hasLesson,
                docs: CourseDocsFlags()
            )

        case let .unit(courseId, unitNumber, tab):
            guard let manifest = try? await dataSource.course(courseId: courseId) else {
                return .invalid("Course \(courseId) was not found.")
            }
            let courseId = manifest.id
            guard let unit = manifest.unit(number: unitNumber) else {
                return .invalid("Unit \(unitNumber) was not found in \(courseId).")
            }
            let discovered = Set((try? await dataSource.discoverUnitDocs(
                courseId: courseId,
                unitNumber: unitNumber
            )) ?? [])
            if let autoCreate = await autoCreateIfNeeded(
                courseId: courseId,
                scope: .unit(unitNumber),
                tab: tab,
                existing: discovered.contains(tab),
                fallback: ReaderTarget(
                    courseId: courseId,
                    scope: .unit(unitNumber),
                    tab: "assignments"
                ),
                allowAutoCreate: allowAutoCreate
            ) {
                return autoCreate
            }
            return destination(
                courseId: courseId,
                scope: .unit(unitNumber),
                title: unit.title.isEmpty ? "Unit \(unitNumber)" : unit.title,
                requested: tab,
                availableTabs: discovered,
                hasLesson: false,
                docs: CourseDocsFlags()
            )
        }
    }

    private func autoCreateIfNeeded(
        courseId: String,
        scope: ReaderScope,
        tab: String,
        existing: Bool,
        fallback: ReaderTarget,
        allowAutoCreate: Bool
    ) async -> DeepLinkResolution? {
        let baseTabs: Set<String> = [
            "lesson", "summary", "cheatsheet", "test", "schedule",
            "assignments", "notes", "course", "popquiz",
        ]
        guard !baseTabs.contains(tab), !existing else { return nil }
        if allowAutoCreate {
            do {
                _ = try await dataSource.createCustomDocument(
                    courseId: courseId,
                    scope: generatedScope(scope),
                    tab: tab
                )
            } catch {
                return .invalid(
                    "The custom tab \"\(tab)\" could not be created: "
                        + ((error as? LocalizedError)?.errorDescription ?? error.localizedDescription)
                )
            }
            return .reader(ReaderTarget(courseId: courseId, scope: scope, tab: tab))
        }
        return .needsAutoCreate(DeepLinkAutoCreateRequest(
            courseId: courseId,
            scope: scope,
            tab: tab,
            fallback: fallback
        ))
    }

    private func destination(
        courseId: String,
        scope: ReaderScope,
        title: String,
        requested: String,
        availableTabs: Set<String>,
        hasLesson: Bool,
        docs: CourseDocsFlags
    ) -> DeepLinkResolution {
        guard let resolved = NavigationRules.resolvedTab(
            requested: requested,
            scope: workspaceScope(scope),
            availableTabs: availableTabs,
            hasLesson: hasLesson,
            docs: docs
        ) else {
            return .invalid("The tab \(requested) could not be resolved.")
        }
        if resolved.kind == .quiz {
            switch scope {
            case let .lesson(lessonId):
                return .quiz(.lessonTest(courseId: courseId, lessonId: lessonId, lessonTitle: title))
            case let .unit(number):
                return .quiz(.unitTest(courseId: courseId, unitNumber: number, unitTitle: title))
            case .course:
                return .quiz(.courseTest(courseId: courseId, courseTitle: title))
            }
        }
        return .reader(ReaderTarget(courseId: courseId, scope: scope, tab: resolved.slug))
    }

    private func generatedScope(_ scope: ReaderScope) -> GeneratedDocumentScope {
        switch scope {
        case let .lesson(lessonId): return .lesson(lessonId)
        case let .unit(number): return .unit(number)
        case .course: return .course
        }
    }

    private func workspaceScope(_ scope: ReaderScope) -> WorkspaceScope {
        switch scope {
        case let .lesson(lessonId): return .lesson(lessonId)
        case let .unit(number): return .unit(number)
        case .course: return .course
        }
    }
}

extension Notification.Name {
    static let courseDeckOpenDeepLink = Notification.Name("CourseDeckOpenDeepLink")
}

enum DeepLinkCover: Identifiable {
    case reader(ReaderTarget)
    case quiz(QuizRequest)

    var id: String {
        switch self {
        case let .reader(target): return "reader:\(target.id)"
        case let .quiz(request): return "quiz:\(request.id)"
        }
    }
}
