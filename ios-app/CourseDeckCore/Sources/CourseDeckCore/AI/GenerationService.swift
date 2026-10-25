import Foundation

// MARK: - Inputs

public struct LessonGenerationInput: Equatable, Sendable {
    public var courseId: String
    public var lessonId: String
    public var tab: String
    public var customPrompt: String?
    public var customContent: String?
    public var contextAttachment: PromptContextAttachment?
    public var force: Bool

    public init(
        courseId: String,
        lessonId: String,
        tab: String,
        customPrompt: String? = nil,
        customContent: String? = nil,
        contextAttachment: PromptContextAttachment? = nil,
        force: Bool = false
    ) {
        self.courseId = courseId
        self.lessonId = lessonId
        self.tab = tab
        self.customPrompt = customPrompt
        self.customContent = customContent
        self.contextAttachment = contextAttachment
        self.force = force
    }
}

public struct UnitGenerationInput: Equatable, Sendable {
    public var courseId: String
    public var unitNumber: Int
    public var tab: String
    public var customPrompt: String?
    public var customContent: String?
    public var contextAttachment: PromptContextAttachment?
    public var force: Bool

    public init(
        courseId: String,
        unitNumber: Int,
        tab: String,
        customPrompt: String? = nil,
        customContent: String? = nil,
        contextAttachment: PromptContextAttachment? = nil,
        force: Bool = false
    ) {
        self.courseId = courseId
        self.unitNumber = unitNumber
        self.tab = tab
        self.customPrompt = customPrompt
        self.customContent = customContent
        self.contextAttachment = contextAttachment
        self.force = force
    }
}

public struct CourseDocGenerationInput: Equatable, Sendable {
    public var courseId: String
    public var kind: CourseDocKind
    public var force: Bool

    public init(courseId: String, kind: CourseDocKind, force: Bool = false) {
        self.courseId = courseId
        self.kind = kind
        self.force = force
    }
}

public enum GenerationError: Error, LocalizedError, Equatable {
    case consentRequired
    case missingActiveModel
    case missingAPIKey(String)
    case missingPrompt(String)
    case unsupportedTab(String)
    case unsupportedCourseDoc(String)
    case confirmationRequired(target: String, existingCharacters: Int)
    case invalidOutput(OutputValidationResult)
    case corruptExistingFrontmatter(String)
    case courseNotFound(String)
    case lessonNotFound(String)
    case unitNotFound(Int)
    case userNoteProtectionFailed

    public var errorDescription: String? {
        switch self {
        case .consentRequired:
            return "Accept the AI data disclosure in Settings before generating content."
        case .missingActiveModel:
            return "No AI model card is configured. Add a DeepSeek card in Settings."
        case let .missingAPIKey(label):
            return "No API key is stored for \(label). Add the key in Settings."
        case let .missingPrompt(id):
            return "Prompt \"\(id)\" is missing. Restore the built-in prompt in Settings, or provide a custom prompt."
        case let .unsupportedTab(tab):
            return "The tab \"\(tab)\" cannot be generated on this device."
        case let .unsupportedCourseDoc(tab):
            return "Course documents support summary, cheatsheet and test, not \"\(tab)\"."
        case let .confirmationRequired(target, existingCharacters):
            return "\(target) already contains \(existingCharacters) characters. Confirm that it may be replaced."
        case let .invalidOutput(result):
            return "The generated document did not pass validation: \(result.summary)"
        case let .corruptExistingFrontmatter(file):
            return "\(file) has unreadable frontmatter. A .bak snapshot was kept; repair or re-import the file before regenerating it."
        case let .courseNotFound(id):
            return "Course \(id) was not found."
        case let .lessonNotFound(id):
            return "Lesson \(id) was not found."
        case let .unitNotFound(number):
            return "Unit \(number) was not found."
        case .userNoteProtectionFailed:
            return "Existing USERNOTE cards could not be preserved, so the file was not overwritten."
        }
    }
}

// MARK: - Generation service

/// Lesson, unit and course-document generation (PLAN §4.8/§4.9).
public actor GenerationService {
    public typealias ConsentProvider = @Sendable () async -> Bool

    private let root: DataRoot
    private let repository: CourseRepository
    private let prompts: PromptRepository
    private let contexts: PromptContextService
    private let providers: LlmProviderStore
    private let client: LlmClient
    private let consentProvider: ConsentProvider

    public init(
        root: DataRoot,
        repository: CourseRepository,
        prompts: PromptRepository,
        contexts: PromptContextService,
        providers: LlmProviderStore,
        client: LlmClient,
        consentProvider: @escaping ConsentProvider
    ) {
        self.root = root
        self.repository = repository
        self.prompts = prompts
        self.contexts = contexts
        self.providers = providers
        self.client = client
        self.consentProvider = consentProvider
    }

    private func assertConsent() async throws {
        try root.ensureWritable()
        guard await consentProvider() else {
            throw GenerationError.consentRequired
        }
    }

    // MARK: Preparation

    public func prepareLessonJob(_ input: LessonGenerationInput) async throws -> GenerationJob {
        try await assertConsent()
        let tab = try PathValidator.tab(input.tab)
        guard !["lesson", "notes", "schedule", "popquiz", "course"].contains(tab) else {
            throw GenerationError.unsupportedTab(tab)
        }
        let manifest = try await loadManifest(input.courseId)
        guard let lesson = manifest.lesson(id: input.lessonId) else {
            throw GenerationError.lessonNotFound(input.lessonId)
        }
        let attachment = input.contextAttachment ?? .lessonLessons
        guard attachment.scope == .lesson else {
            throw PromptContextError.attachmentScopeMismatch(attachment.rawValue)
        }
        if input.customPrompt?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty != false {
            guard let prompt = try await prompts.prompt(id: tab),
                  !prompt.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                throw GenerationError.missingPrompt(tab)
            }
        }

        let existing = try await repository.tabContent(
            courseId: input.courseId,
            lessonId: lesson.id,
            tab: tab
        ) ?? ""
        try assertOverwriteAllowed(
            existing: existing,
            target: "\(lesson.id).\(tab).md",
            force: input.force
        )
        try await assertModelReady()

        let id = GenerationJob.identifier(courseId: input.courseId, lessonId: lesson.id, tab: tab)
        return GenerationJob(
            id: id,
            courseId: input.courseId,
            lessonId: lesson.id,
            lessonTitle: lesson.title,
            tab: tab,
            customPrompt: trimmedOrNil(input.customPrompt),
            customContent: trimmedOrNil(input.customContent),
            contextAttachment: attachment.rawValue,
            preferences: Self.preferences(
                force: input.force,
                scope: "lesson",
                unitNumber: lesson.unitNumber,
                lessonNumber: lesson.lessonNumber
            ),
            lane: .standard,
            activeCardId: try await activeCardID(),
            activeCardPolicy: "pinned",
            maxAttempts: 3
        )
    }

    public func prepareUnitJob(_ input: UnitGenerationInput) async throws -> GenerationJob {
        try await assertConsent()
        let tab = try PathValidator.tab(input.tab)
        guard !["lesson", "notes", "schedule", "popquiz", "summary", "cheatsheet", "course"].contains(tab) else {
            throw GenerationError.unsupportedTab(tab)
        }
        let manifest = try await loadManifest(input.courseId)
        guard let unit = manifest.unit(number: input.unitNumber) else {
            throw GenerationError.unitNotFound(input.unitNumber)
        }
        let attachment = input.contextAttachment ?? .unitLessons
        guard attachment.scope == .unit else {
            throw PromptContextError.attachmentScopeMismatch(attachment.rawValue)
        }
        let scopeID = PathValidator.formatUnitScopeId(input.unitNumber)
        if input.customPrompt?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty != false {
            let promptID = await Self.unitPromptID(tab: tab, prompts: prompts)
            guard let prompt = try await prompts.prompt(id: promptID),
                  !prompt.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                throw GenerationError.missingPrompt(promptID)
            }
        }

        let existing = try await repository.unitDocument(
            courseId: input.courseId,
            unit: input.unitNumber,
            tab: tab
        ) ?? ""
        try assertOverwriteAllowed(
            existing: existing,
            target: "\(scopeID).\(tab).md",
            force: input.force
        )
        try await assertModelReady()

        let id = GenerationJob.identifier(courseId: input.courseId, lessonId: scopeID, tab: tab)
        return GenerationJob(
            id: id,
            courseId: input.courseId,
            lessonId: scopeID,
            lessonTitle: unit.title,
            tab: tab,
            customPrompt: trimmedOrNil(input.customPrompt),
            customContent: trimmedOrNil(input.customContent),
            contextAttachment: attachment.rawValue,
            preferences: Self.preferences(
                force: input.force,
                scope: "unit",
                unitNumber: input.unitNumber,
                lessonNumber: nil
            ),
            lane: .standard,
            activeCardId: try await activeCardID(),
            activeCardPolicy: "pinned",
            maxAttempts: 3
        )
    }

    public func prepareCourseDocJob(_ input: CourseDocGenerationInput) async throws -> GenerationJob {
        try await assertConsent()
        let manifest = try await loadManifest(input.courseId)
        let kind = input.kind
        guard let prompt = try await prompts.prompt(id: kind.promptID),
              !prompt.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw GenerationError.missingPrompt(kind.promptID)
        }
        // Surface first-time/no-curated-coverage problems before enqueueing.
        _ = try await contexts.buildAggregatedPayload(courseId: input.courseId, kind: kind)

        let existing = try await repository.courseDocument(courseId: input.courseId, tab: kind.tab) ?? ""
        try assertOverwriteAllowed(
            existing: existing,
            target: "course.\(kind.tab).md",
            force: input.force
        )
        try await assertModelReady()

        let id = GenerationJob.identifier(courseId: input.courseId, lessonId: "course", tab: kind.tab)
        return GenerationJob(
            id: id,
            courseId: input.courseId,
            lessonId: "course",
            lessonTitle: manifest.title,
            tab: kind.tab,
            contextAttachment: kind.attachment.rawValue,
            preferences: Self.preferences(force: input.force, scope: "course", unitNumber: nil, lessonNumber: nil),
            lane: .courseDocs,
            activeCardId: try await activeCardID(),
            activeCardPolicy: "pinned",
            maxAttempts: 3
        )
    }

    // MARK: Execution

    public func execute(job: GenerationJob) async throws -> GenerationOutcome {
        try await execute(
            job: job,
            context: GenerationExecutionContext(
                recordPartial: { _ in },
                isCancelled: { Task.isCancelled }
            )
        )
    }

    public func execute(
        job: GenerationJob,
        context: GenerationExecutionContext
    ) async throws -> GenerationOutcome {
        try await assertConsent()
        let manifest = try await loadManifest(job.courseId)
        let scope = try scope(for: job, manifest: manifest)
        let resolved = try await resolveCard(job: job)
        let isCourse = job.lessonId == "course"

        let promptID: String
        let systemPrompt: String
        if let custom = job.customPrompt?.trimmingCharacters(in: .whitespacesAndNewlines), !custom.isEmpty {
            promptID = "custom"
            systemPrompt = custom
        } else {
            promptID = await resolvedPromptID(for: job, scope: scope, isCourse: isCourse)
            guard let prompt = try await prompts.prompt(id: promptID),
                  !prompt.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                throw GenerationError.missingPrompt(promptID)
            }
            systemPrompt = prompt.content
        }

        let attachment = try attachment(for: job, isCourse: isCourse)
        let payload = try await buildPayload(
            job: job,
            scope: scope,
            attachment: attachment,
            isCourse: isCourse
        )

        let maxTokens = resolved.extensions.maxTokens
        var attempt = 0
        var usedTokens: Int?
        var completion: LlmCompletion?

        while attempt < 2 {
            attempt += 1
            if context.isCancelled() { throw LlmError.cancelled }
            let budget = attempt == 1 ? maxTokens : min(max(maxTokens * 2, maxTokens + 1_024), 65_536)
            let request = LlmCompletionRequest(
                card: resolved.card,
                extensions: resolved.extensions,
                capabilities: resolved.capabilities,
                apiKey: resolved.apiKey,
                systemPrompt: systemPrompt,
                userContent: payload.content,
                maxTokensOverride: budget
            )
            let reporter = StreamingProgressReporter(context: context)
            do {
                let result = try await client.complete(request) { event in
                    reporter.handle(event)
                }
                reporter.finish()
                usedTokens = result.usage?.totalTokens
                let kind = Self.contentKind(promptID: promptID, tab: job.tab, isCourse: isCourse)
                let validation = OutputValidator.validate(result.content, kind: kind)
                if validation.isValid {
                    completion = result
                    break
                }
                if attempt >= 2 {
                    throw GenerationError.invalidOutput(validation)
                }
            } catch let error as LlmError where error.isLengthTruncation && attempt < 2 {
                reporter.finish()
                continue
            }
        }

        guard let completion else {
            throw GenerationError.invalidOutput(OutputValidationResult(
                isValid: false,
                issues: [OutputValidationIssue(code: "invalidOutput", message: "The model did not return a usable document.")],
                normalizedContent: ""
            ))
        }

        let target = try await targetContent(job: job, scope: scope)
        if !target.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
           !Self.force(for: job) {
            throw GenerationError.confirmationRequired(
                target: target.fileName,
                existingCharacters: target.content.count
            )
        }

        let noteSplit = UserNoteProtector.split(target.content)
        let merged = UserNoteProtector.merge(noteSplit.notes, into: completion.content)
        if !noteSplit.notes.isEmpty,
           UserNoteProtector.split(merged.content).notes.count < noteSplit.notes.count {
            throw GenerationError.userNoteProtectionFailed
        }

        do {
            try GeneratedDocumentComposer.validateExistingFrontmatter(target.content)
        } catch {
            // Keep the previous file for recovery before refusing to merge.
            _ = try? await repository.snapshotGeneratedDocument(
                courseId: job.courseId,
                scope: documentScope(for: scope),
                tab: job.tab
            )
            throw GenerationError.corruptExistingFrontmatter(target.fileName)
        }

        let metadata = GeneratedDocumentMetadata(
            courseId: job.courseId,
            scopeId: job.lessonId,
            tab: job.tab,
            promptID: promptID,
            contextAttachment: payload.attachment.rawValue,
            unitNumber: Self.unitNumber(for: job, scope: scope),
            lessonNumber: Self.lessonNumber(for: job, scope: scope),
            isCourseScope: isCourse
        )
        let final = try GeneratedDocumentComposer.compose(
            generated: merged.content,
            metadata: metadata,
            existing: target.content.isEmpty ? nil : target.content
        )

        if context.isCancelled() { throw LlmError.cancelled }
        try await repository.compareAndSaveGeneratedDocument(
            courseId: job.courseId,
            scope: documentScope(for: scope),
            tab: job.tab,
            content: final,
            expectedExistingSHA256: target.sha256
        )

        return GenerationOutcome(content: final, tokensUsed: usedTokens)
    }

    // MARK: Scope and payload

    private enum Scope {
        case lesson(courseId: String, lesson: CourseLesson)
        case unit(courseId: String, unit: CourseUnit)
        case course(courseId: String)
    }

    private func scope(for job: GenerationJob, manifest: CourseManifest) throws -> Scope {
        if job.lessonId == "course" {
            return .course(courseId: job.courseId)
        }
        if PathValidator.isUnitScopeId(job.lessonId) {
            guard let number = PathValidator.parseUnitNumber(job.lessonId),
                  let unit = manifest.unit(number: number) else {
                throw GenerationError.unitNotFound(PathValidator.parseUnitNumber(job.lessonId) ?? 0)
            }
            return .unit(courseId: job.courseId, unit: unit)
        }
        guard let lesson = manifest.lesson(id: job.lessonId) else {
            throw GenerationError.lessonNotFound(job.lessonId)
        }
        return .lesson(courseId: job.courseId, lesson: lesson)
    }

    private func attachment(for job: GenerationJob, isCourse: Bool) throws -> PromptContextAttachment {
        let requested = job.contextAttachment.flatMap(PromptContextAttachment.canonical)
        if job.contextAttachment != nil, requested == nil {
            throw PromptContextError.unsupportedAttachment(job.contextAttachment ?? "")
        }
        if isCourse {
            guard let kind = CourseDocKind(rawValue: job.tab) else {
                throw GenerationError.unsupportedCourseDoc(job.tab)
            }
            let expected = kind.attachment
            if let requested, requested != expected {
                if requested == .courseLessons {
                    throw PromptContextError.unsupportedCourseDocAttachment(requested.rawValue)
                }
                throw PromptContextError.attachmentScopeMismatch(requested.rawValue)
            }
            return expected
        }
        if let requested { return requested }
        return PathValidator.isUnitScopeId(job.lessonId) ? .unitLessons : .lessonLessons
    }

    private func buildPayload(
        job: GenerationJob,
        scope: Scope,
        attachment: PromptContextAttachment,
        isCourse: Bool
    ) async throws -> PromptContextPayload {
        if let custom = job.customContent?.trimmingCharacters(in: .whitespacesAndNewlines),
           !custom.isEmpty {
            return try await contexts.payload(for: .lesson(
                courseId: job.courseId,
                lessonId: job.lessonId,
                attachment: attachment,
                customContent: custom
            ))
        }
        switch scope {
        case let .lesson(courseId, lesson):
            return try await contexts.payload(for: .lesson(
                courseId: courseId,
                lessonId: lesson.id,
                attachment: attachment,
                customContent: job.customContent
            ))
        case let .unit(courseId, unit):
            return try await contexts.payload(for: .unit(
                courseId: courseId,
                unitNumber: unit.number,
                attachment: attachment
            ))
        case let .course(courseId):
            guard let kind = CourseDocKind(rawValue: job.tab) else {
                throw GenerationError.unsupportedCourseDoc(job.tab)
            }
            return try await contexts.payload(for: .courseDoc(courseId: courseId, kind: kind))
        }
    }

    private func resolvedPromptID(for job: GenerationJob, scope: Scope, isCourse: Bool) async -> String {
        if isCourse { return "course_\(job.tab)" }
        switch scope {
        case .unit:
            return await Self.unitPromptID(tab: job.tab, prompts: prompts)
        case .lesson, .course:
            return job.tab
        }
    }

    private static func unitPromptID(tab: String, prompts: PromptRepository) async -> String {
        switch tab {
        case "test": return "unit_test"
        case "assignments": return "unit_assignments"
        default:
            let candidate = "unit_\(tab)"
            if let prompt = try? await prompts.prompt(id: candidate),
               !prompt.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                return candidate
            }
            return tab
        }
    }

    private static func contentKind(promptID: String, tab: String, isCourse: Bool) -> GeneratedContentKind {
        switch promptID {
        case "test": return .lessonTest
        case "unit_test": return .unitTest
        case "course_test": return .courseTest
        case "popquiz": return .popQuiz
        case "unit_assignments": return .unitAssignments
        case "summary", "course_summary": return .summary
        case "cheatsheet", "course_cheatsheet": return .cheatsheet
        default: return .custom(tab)
        }
    }

    // MARK: Target and metadata

    private struct Target {
        var fileName: String
        var content: String
        var sha256: String { SHA256.hex(Data(content.utf8)) }
    }

    private func targetContent(job: GenerationJob, scope: Scope) async throws -> Target {
        switch scope {
        case let .lesson(courseId, lesson):
            let fileName = try PathValidator.tabFileName(lessonId: lesson.id, tab: job.tab)
            let content = try await repository.tabContent(
                courseId: courseId,
                lessonId: lesson.id,
                tab: job.tab
            ) ?? ""
            return Target(fileName: fileName, content: content)
        case let .unit(courseId, unit):
            let fileName = try PathValidator.unitDocFileName(unit: unit.number, tab: job.tab)
            let content = try await repository.unitDocument(
                courseId: courseId,
                unit: unit.number,
                tab: job.tab
            ) ?? ""
            return Target(fileName: fileName, content: content)
        case let .course(courseId):
            let fileName = try PathValidator.courseDocFileName(tab: job.tab)
            let content = try await repository.courseDocument(courseId: courseId, tab: job.tab) ?? ""
            return Target(fileName: fileName, content: content)
        }
    }

    private func documentScope(for scope: Scope) -> GeneratedDocumentScope {
        switch scope {
        case let .lesson(_, lesson): return .lesson(lesson.id)
        case let .unit(_, unit): return .unit(unit.number)
        case .course: return .course
        }
    }

    private static func unitNumber(for job: GenerationJob, scope: Scope) -> Int? {
        switch scope {
        case let .lesson(_, lesson): return lesson.unitNumber
        case let .unit(_, unit): return unit.number
        case .course: return nil
        }
    }

    private static func lessonNumber(for job: GenerationJob, scope: Scope) -> Int? {
        switch scope {
        case let .lesson(_, lesson): return lesson.lessonNumber
        case .unit, .course: return nil
        }
    }

    // MARK: Readiness

    private func loadManifest(_ courseId: String) async throws -> CourseManifest {
        guard let manifest = try await repository.course(courseId: courseId) else {
            throw GenerationError.courseNotFound(courseId)
        }
        return manifest
    }

    private func resolveCard(job: GenerationJob) async throws -> ResolvedLlmCard {
        let configuration = try await providers.load()
        let resolved: ResolvedLlmCard?
        if let id = job.activeCardId, job.activeCardPolicy == "pinned" {
            // The queue records which card the user chose. If that card was
            // deleted while the job waited, fail clearly instead of silently
            // sending course content to a different provider.
            guard let pinned = configuration.resolvedCard(id: id) else {
                throw LlmProviderStoreError.unknownCard(id)
            }
            resolved = pinned
        } else {
            resolved = configuration.resolvedCard(id: job.activeCardId) ?? configuration.activeCard
        }
        guard let card = resolved else { throw GenerationError.missingActiveModel }
        guard card.capabilities.isSupported else {
            throw LlmError.unsupportedProvider(card.card.provider)
        }
        guard card.isConfigured else {
            throw GenerationError.missingAPIKey(card.card.label)
        }
        return card
    }

    private func assertModelReady() async throws {
        let configuration = try await providers.load()
        guard let card = configuration.activeCard else {
            throw GenerationError.missingActiveModel
        }
        guard card.capabilities.isSupported else {
            throw LlmError.unsupportedProvider(card.card.provider)
        }
        guard card.isConfigured else {
            throw GenerationError.missingAPIKey(card.card.label)
        }
    }

    private func activeCardID() async throws -> String? {
        let configuration = try await providers.load()
        return configuration.store.activeId ?? configuration.store.cards.first?.id
    }

    private func assertOverwriteAllowed(existing: String, target: String, force: Bool) throws {
        guard !existing.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, !force else { return }
        throw GenerationError.confirmationRequired(target: target, existingCharacters: existing.count)
    }

    private func trimmedOrNil(_ value: String?) -> String? {
        guard let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else {
            return nil
        }
        return value
    }

    private static func preferences(
        force: Bool,
        scope: String,
        unitNumber: Int?,
        lessonNumber: Int?
    ) -> JSONValue {
        var members: [JSONMember] = [
            JSONMember(key: "force", value: .bool(force)),
            JSONMember(key: "scope", value: .string(scope)),
        ]
        if let unitNumber {
            members.append(JSONMember(key: "unitNumber", value: .number(String(unitNumber))))
        }
        if let lessonNumber {
            members.append(JSONMember(key: "lessonNumber", value: .number(String(lessonNumber))))
        }
        return .object(members)
    }

    private static func force(for job: GenerationJob) -> Bool {
        job.preferences?["force"]?.boolValue ?? false
    }
}

// MARK: - Streaming progress

/// Accumulates visible deltas and periodically persists partial output so a
/// background/interrupted job leaves diagnostics behind. Reasoning deltas are
/// deliberately not written to the document.
private final class StreamingProgressReporter: @unchecked Sendable {
    private let context: GenerationExecutionContext
    private let lock = NSLock()
    private var text = ""
    private var lastReported = 0

    init(context: GenerationExecutionContext) {
        self.context = context
    }

    func handle(_ event: LlmStreamEvent) {
        guard case let .textDelta(delta) = event else { return }
        lock.lock()
        text += delta
        let shouldReport = text.count - lastReported >= 2_048
        if shouldReport { lastReported = text.count }
        let snapshot = text
        lock.unlock()
        if shouldReport {
            context.recordPartial(snapshot)
        }
    }

    func finish() {
        lock.lock()
        let snapshot = text
        let shouldReport = !snapshot.isEmpty && snapshot.count != lastReported
        lastReported = snapshot.count
        lock.unlock()
        if shouldReport {
            context.recordPartial(snapshot)
        }
    }
}

// MARK: - Missing work

public struct MissingWorkItem: Equatable, Sendable {
    public var lessonId: String
    public var lessonTitle: String
    public var tabs: [String]

    public init(lessonId: String, lessonTitle: String, tabs: [String]) {
        self.lessonId = lessonId
        self.lessonTitle = lessonTitle
        self.tabs = tabs
    }
}

/// Bulk missing-work scan. Only summary + cheatsheet are supported, matching
/// the plan's explicit bulk policy; unit tabs are never scanned.
public actor MissingWorkScanner {
    public static let supportedTabs = ["summary", "cheatsheet"]
    private let repository: CourseRepository

    public init(repository: CourseRepository) {
        self.repository = repository
    }

    public func scan(courseId: String, tabs: [String] = MissingWorkScanner.supportedTabs) async throws -> [MissingWorkItem] {
        let requested = tabs.isEmpty ? Self.supportedTabs : tabs
        for tab in requested where !Self.supportedTabs.contains(tab) {
            throw GenerationError.unsupportedTab(tab)
        }
        guard let manifest = try await repository.course(courseId: courseId) else {
            throw GenerationError.courseNotFound(courseId)
        }
        var items: [MissingWorkItem] = []
        for lesson in manifest.allLessons {
            var missing: [String] = []
            for tab in requested {
                let content = try? await repository.tabContent(
                    courseId: courseId,
                    lessonId: lesson.id,
                    tab: tab
                )
                if PromptContentSanitizer.isStub(content) {
                    missing.append(tab)
                }
            }
            if !missing.isEmpty {
                items.append(MissingWorkItem(
                    lessonId: lesson.id,
                    lessonTitle: lesson.title,
                    tabs: missing
                ))
            }
        }
        return items
    }
}
