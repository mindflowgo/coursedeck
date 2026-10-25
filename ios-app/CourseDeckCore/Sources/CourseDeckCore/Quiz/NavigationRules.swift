import Foundation

// MARK: - Workspace navigation rules

public enum WorkspaceScope: Equatable, Sendable, Hashable {
    case lesson(String)
    case unit(Int)
    case course
}

public enum WorkspaceTabKind: Equatable, Sendable {
    /// The virtual `course.lesson` Course Navigation page.
    case courseNavigation
    case reader
    case readOnlyReader
    case quiz
    case custom
}

public struct WorkspaceTabOption: Equatable, Sendable, Identifiable {
    public var slug: String
    public var title: String
    public var kind: WorkspaceTabKind
    /// False means the well-known tab is valid navigation but its file has not
    /// been generated yet. It is still shown (with a generation CTA).
    public var isAvailable: Bool
    public var isVirtual: Bool

    public var id: String { "\(kind)-\(slug)" }

    public init(
        slug: String,
        title: String,
        kind: WorkspaceTabKind,
        isAvailable: Bool,
        isVirtual: Bool = false
    ) {
        self.slug = slug
        self.title = title
        self.kind = kind
        self.isAvailable = isAvailable
        self.isVirtual = isVirtual
    }
}

/// Pure navigation rules ported from the desktop workspace (PLAN §4.14):
///
/// * Course scope always exposes `lesson`, `summary`, `cheatsheet` and `test`,
///   even when the file is absent. `lesson` is the virtual Course Navigation
///   page. `schedule` appears only when `course.schedule.md` exists and is
///   read-only.
/// * Unit scope always exposes `assignments` and `test`, plus discovered
///   custom unit tabs. Unknown tabs fall back to `assignments`.
/// * Lesson scope exposes the lesson body plus always-valid
///   `summary`/`cheatsheet`/`test` generation slots and discovered custom tabs.
///   An unknown/missing custom tab falls back to `lesson`.
public enum NavigationRules {
    public static let courseBaseSlugs = ["lesson", "summary", "cheatsheet", "test"]
    public static let unitBaseSlugs = ["assignments", "test"]
    public static let lessonBaseSlugs = ["lesson", "summary", "cheatsheet", "test"]

    public static func courseTabs(docs: CourseDocsFlags) -> [WorkspaceTabOption] {
        var tabs: [WorkspaceTabOption] = [
            WorkspaceTabOption(
                slug: "lesson",
                title: "Course navigation",
                kind: .courseNavigation,
                isAvailable: true,
                isVirtual: true
            ),
            WorkspaceTabOption(
                slug: "summary",
                title: "Summary",
                kind: .reader,
                isAvailable: docs.summary
            ),
            WorkspaceTabOption(
                slug: "cheatsheet",
                title: "Cheatsheet",
                kind: .reader,
                isAvailable: docs.cheatsheet
            ),
            WorkspaceTabOption(
                slug: "test",
                title: "Practice test",
                kind: .quiz,
                isAvailable: docs.test
            ),
        ]
        if docs.schedule {
            tabs.append(WorkspaceTabOption(
                slug: "schedule",
                title: "Schedule (read-only)",
                kind: .readOnlyReader,
                isAvailable: true
            ))
        }
        for slug in docs.custom.keys.sorted() where !isBaseOrReserved(slug, scope: .course) {
            tabs.append(WorkspaceTabOption(
                slug: slug,
                title: PathValidator.customTabDisplayName(slug),
                kind: .custom,
                isAvailable: true
            ))
        }
        return tabs
    }

    public static func unitTabs(discovered: Set<String>) -> [WorkspaceTabOption] {
        var tabs: [WorkspaceTabOption] = [
            WorkspaceTabOption(
                slug: "assignments",
                title: "Assignments",
                kind: .reader,
                isAvailable: discovered.contains("assignments")
            ),
            WorkspaceTabOption(
                slug: "test",
                title: "Unit test",
                kind: .quiz,
                isAvailable: discovered.contains("test")
            ),
        ]
        for slug in discovered.sorted()
        where !["assignments", "test", "lesson", "notes", "summary", "cheatsheet", "schedule", "course", "popquiz"].contains(slug) {
            tabs.append(WorkspaceTabOption(
                slug: slug,
                title: PathValidator.customTabDisplayName(slug),
                kind: .custom,
                isAvailable: true
            ))
        }
        return tabs
    }

    public static func lessonTabs(
        availableTabs: Set<String>,
        hasLesson: Bool
    ) -> [WorkspaceTabOption] {
        var tabs: [WorkspaceTabOption] = []
        if hasLesson {
            tabs.append(WorkspaceTabOption(
                slug: "lesson",
                title: "Lesson",
                kind: .reader,
                isAvailable: true
            ))
        }
        tabs.append(WorkspaceTabOption(
            slug: "summary",
            title: "Summary",
            kind: .reader,
            isAvailable: availableTabs.contains("summary")
        ))
        tabs.append(WorkspaceTabOption(
            slug: "cheatsheet",
            title: "Cheatsheet",
            kind: .reader,
            isAvailable: availableTabs.contains("cheatsheet")
        ))
        tabs.append(WorkspaceTabOption(
            slug: "test",
            title: "Practice test",
            kind: .quiz,
            isAvailable: availableTabs.contains("test")
        ))
        for slug in availableTabs.sorted()
        where !["lesson", "notes", "summary", "cheatsheet", "test", "schedule", "course", "assignments", "popquiz"].contains(slug) {
            tabs.append(WorkspaceTabOption(
                slug: slug,
                title: PathValidator.customTabDisplayName(slug),
                kind: .custom,
                isAvailable: true
            ))
        }
        return tabs
    }

    /// Resolves a requested tab. Well-known tabs stay valid even when their
    /// file is missing. Unknown/custom tabs fall back to the scope's default
    /// page instead of showing a dead end.
    public static func resolvedTab(
        requested: String,
        scope: WorkspaceScope,
        availableTabs: Set<String> = [],
        hasLesson: Bool = false,
        docs: CourseDocsFlags = CourseDocsFlags()
    ) -> WorkspaceTabOption? {
        let tabs: [WorkspaceTabOption]
        switch scope {
        case .course:
            tabs = courseTabs(docs: docs)
        case .unit:
            tabs = unitTabs(discovered: availableTabs)
        case .lesson:
            tabs = lessonTabs(availableTabs: availableTabs, hasLesson: hasLesson)
        }
        if let exact = tabs.first(where: { $0.slug == requested }) {
            return exact
        }
        switch scope {
        case .course:
            return tabs.first { $0.slug == "lesson" }
        case .unit:
            return tabs.first { $0.slug == "assignments" } ?? tabs.first
        case .lesson:
            return tabs.first { $0.slug == "lesson" }
                ?? tabs.first { $0.slug == "summary" }
                ?? tabs.first
        }
    }

    public static func isReadOnly(scope: WorkspaceScope, tab: String) -> Bool {
        if case .course = scope, tab == "lesson" { return true }
        if case .course = scope, tab == "schedule" { return true }
        return false
    }

    public static func isCustom(scope: WorkspaceScope, tab: String, availableTabs: Set<String>) -> Bool {
        switch scope {
        case .course:
            return !["lesson", "summary", "cheatsheet", "test", "schedule"].contains(tab)
        case .unit:
            return !unitBaseSlugs.contains(tab)
        case .lesson:
            return !lessonBaseSlugs.contains(tab)
        }
    }

    private static func isBaseOrReserved(_ slug: String, scope: WorkspaceScope) -> Bool {
        switch scope {
        case .course:
            return ["lesson", "summary", "cheatsheet", "test", "schedule", "course", "notes", "popquiz", "assignments"].contains(slug)
        case .unit:
            return ["assignments", "test", "lesson", "notes", "summary", "cheatsheet", "schedule", "course", "popquiz"].contains(slug)
        case .lesson:
            return ["lesson", "notes", "summary", "cheatsheet", "test", "schedule", "course", "assignments", "popquiz"].contains(slug)
        }
    }
}
