import Combine
import CourseDeckCore
import Foundation
import UIKit

/// App-scoped composition root. It owns the single Application Support data
/// root, the repositories, the import-inbox audit, and the reader document
/// provider. View models never build paths themselves.
@MainActor
final class AppServices: ObservableObject {
    static let shared = AppServices()

    let dataRoot: DataRoot
    let repository: CourseRepository
    let checkpoints: CheckpointRepository
    let settingsStore: SettingsStore
    let prompts: PromptRepository
    let llmProviders: LlmProviderStore
    let generationService: GenerationService
    let generationQueue: GenerationQueue
    let generationLifecycle: GenerationLifecycleCoordinator
    let promptProvenance: PromptProvenanceStore
    let bundledPromptsURL: URL?
    let backupService: BackupService
    let ingestor: CourseIngestor
    let missingWorkScanner: MissingWorkScanner
    let documentProvider: ReaderDocumentProvider
    let attempts: QuizAttemptStore
    let drafts: QuizDraftStore
    let deepLinkResolver: DeepLinkResolver
    let tableScrollState = TableScrollStateStore()

    @Published private(set) var settings = Settings()
    @Published private(set) var settingsLoaded = false
    @Published private(set) var startupError: String?
    @Published private(set) var dataVersionMessage: String?
    @Published private(set) var lastAuditReport: InboxAuditReport?
    @Published var generationError: String?
    @Published var generationIsRunning = false
    @Published var pendingKeyReplacements: [PendingKeyReplacement] = []
    @Published var lastBackupReport: BackupReport?
    @Published private(set) var dataRevision = 0

    private let audit: ImportInboxAudit
    private var hasStarted = false

    private init() {
        let fileManager = FileManager.default
        let supportBase = (try? fileManager.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )) ?? fileManager.temporaryDirectory

        let rootURL = supportBase.appendingPathComponent("CourseDeck", isDirectory: true)
        let documentsURL = fileManager.urls(for: .documentDirectory, in: .userDomainMask).first
        let root = DataRoot(rootURL: rootURL, documentsURL: documentsURL)

        dataRoot = root
        let repository = CourseRepository(root: root)
        self.repository = repository
        let checkpoints = CheckpointRepository(root: root)
        self.checkpoints = checkpoints
        let settingsStore = SettingsStore(root: root)
        self.settingsStore = settingsStore
        let provenance = PromptProvenanceStore(root: root)
        let bundledPrompts = Bundle.main.url(forResource: "Prompts", withExtension: nil)
        let prompts = PromptRepository(
            root: root,
            bundledDirectory: bundledPrompts,
            provenance: provenance
        )
        self.prompts = prompts
        let providers = LlmProviderStore(root: root, secretStore: KeychainSecretStore())
        self.llmProviders = providers
        let contexts = PromptContextService(repository: repository)
        let consentProvider: @Sendable () async -> Bool = {
            await settingsStore.load().hasAIConsent
        }
        let generationService = GenerationService(
            root: root,
            repository: repository,
            prompts: prompts,
            contexts: contexts,
            providers: providers,
            client: LlmClient(),
            consentProvider: consentProvider
        )
        self.generationService = generationService
        let generationQueue = GenerationQueue(root: root) { [generationService] job, context in
            try await generationService.execute(job: job, context: context)
        }
        self.generationQueue = generationQueue
        generationLifecycle = GenerationLifecycleCoordinator(
            queue: generationQueue,
            consentProvider: consentProvider
        )
        promptProvenance = provenance
        bundledPromptsURL = bundledPrompts
        backupService = BackupService(
            root: root,
            keyMigrator: KeyMigrator(secretStore: KeychainSecretStore()),
            promptProvenance: provenance,
            bundledPromptsDirectory: bundledPrompts,
            generationQueue: generationQueue
        )
        ingestor = CourseIngestor(root: root)
        missingWorkScanner = MissingWorkScanner(repository: repository)
        documentProvider = ReaderDocumentProvider(root: root, repository: repository)
        attempts = QuizAttemptStore(root: root)
        drafts = QuizDraftStore(root: root)
        deepLinkResolver = DeepLinkResolver(dataSource: repository)
        audit = ImportInboxAudit(
            root: root,
            keyMigrator: KeyMigrator(secretStore: KeychainSecretStore())
        )

        do {
            try root.prepare()
        } catch {
            startupError = "The CourseDeck data folder could not be prepared: \(error.localizedDescription)"
        }

        let status = DataVersionStore(root: root).loadAndMigrate()
        switch status {
        case .missing:
            dataVersionMessage = nil
        case let .supported(record):
            dataVersionMessage = "Data version \(record.version)"
        case let .corrupt(reason):
            dataVersionMessage = "Read-only: dataVersion.json is unreadable (\(reason))."
        case let .newer(record, supported):
            dataVersionMessage = "Read-only: data version \(record.version) is newer than this build (\(supported))."
        case let .migrationFailed(reason):
            dataVersionMessage = "Read-only: \(reason)"
        }
    }

    func start() {
        guard !hasStarted else { return }
        hasStarted = true
        Task {
            // UI-test launch switches. Production launches never pass these.
            let arguments = ProcessInfo.processInfo.arguments
            if arguments.contains("-CourseDeckResetAIConsentForUITests") {
                _ = try? await settingsStore.update { $0.revokeAIConsent() }
            } else if arguments.contains("-CourseDeckAcceptAIConsentForUITests") {
                _ = try? await settingsStore.update { $0.acceptAIConsent() }
            }
            if arguments.contains("-CourseDeckSeedUITestCourseForUITests") {
                await seedUITestCourseIfNeeded()
            }
            let loaded = await settingsStore.load()
            settings = loaded
            settingsLoaded = true
            // Refresh untouched bundled prompts when the app ships new ones;
            // user-edited/imported prompts are preserved.
            _ = try? await prompts.refreshBundledDefaults()
        }
        Task {
            await runDocumentsAudit()
        }
    }

    // MARK: - Generation lifecycle (scene-aware, consent-gated)

    /// Seeds one tiny course for UI tests so navigation and generation CTAs can
    /// be exercised without a desktop backup. Production never passes the flag.
    private func seedUITestCourseIfNeeded() async {
        if (try? await repository.course(courseId: "uitest")) != nil { return }
        let manifest = CourseManifest(
            id: "uitest",
            title: "UITest Course",
            description: "Seeded for UI navigation tests.",
            units: [
                CourseUnit(
                    number: 1,
                    title: "Unit 1",
                    lessons: [
                        CourseLesson(
                            id: "01.01",
                            code: "UITEST_U1L1",
                            title: "Lesson One",
                            unitNumber: 1,
                            lessonNumber: 1,
                            type: .lesson,
                            hasFull: true
                        ),
                    ]
                ),
            ],
            updatedAt: GenerationJob.timestamp()
        )
        do {
            try await repository.saveManifest(manifest)
            _ = try await repository.saveTab(
                courseId: "uitest",
                lessonId: "01.01",
                tab: "lesson",
                content: "# Lesson One\n\nSeeded lesson body for UI tests."
            )
            dataRevision += 1
        } catch {
            startupError = "Could not seed the UI-test course: \(error.localizedDescription)"
        }
    }

    /// Registers a window scene. The first active scene recovers interrupted
    /// jobs and starts the queue only when the AI disclosure was accepted.
    func sceneBecameActive(_ sceneID: UUID) {
        scenePhaseChanged(sceneID, phase: .active)
    }

    /// The last resigning scene interrupts in-flight streams. A streaming
    /// URLSession request cannot be resumed after suspension.
    func sceneWillResignActive(_ sceneID: UUID) {
        scenePhaseChanged(sceneID, phase: .background)
    }

    func scenePhaseChanged(_ sceneID: UUID, phase: SceneActivityPhase) {
        Task {
            await generationLifecycle.scenePhaseChanged(id: sceneID, phase: phase)
            await refreshGenerationStatus()
        }
    }

    var hasAIConsent: Bool { settings.hasAIConsent }

    func bumpDataRevision() {
        dataRevision += 1
    }

    func acceptAIConsent() async {
        await updateSettings { $0.acceptAIConsent() }
        await generationLifecycle.consentDidChange()
        await refreshGenerationStatus()
    }

    func declineAIConsent() async {
        // Leave the consent version at zero; the queue stays stopped.
        await generationLifecycle.consentDidChange()
        await refreshGenerationStatus()
    }

    func revokeAIConsent() async {
        await updateSettings { $0.revokeAIConsent() }
        await generationLifecycle.consentDidChange()
        await refreshGenerationStatus()
    }

    func refreshSettings() async {
        settings = await settingsStore.load()
    }

    func updateSettings(_ mutate: (inout Settings) -> Void) async {
        do {
            let updated = try await settingsStore.update(mutate)
            settings = updated
        } catch {
            startupError = error.localizedDescription
        }
    }

    func runDocumentsAudit() async {
        let report = await audit.auditDocumentsTree()
        lastAuditReport = report
    }

    var isWritable: Bool { dataRoot.writeGate.isWritable }

    func reloadCourses() async -> [CourseManifest] {
        (try? await repository.listCourses(includeArchived: false)) ?? []
    }

    func loadSampleDocument() async -> ReaderDocument {
        await documentProvider.loadSample()
    }

    func openDocument(_ target: ReaderTarget) async throws -> ReaderDocument {
        try await documentProvider.load(target)
    }

    func positionCheckpoint(courseId: String, file: String) async -> Checkpoint? {
        try? await checkpoints.positionCheckpoint(courseId: courseId, file: file)
    }

    func documentCheckpoints(courseId: String, file: String) async -> [Checkpoint] {
        guard let document = try? await checkpoints.read(courseId: courseId) else { return [] }
        return document.checkpoints.filter { $0.file == file }
    }

    @discardableResult
    func savePosition(_ position: ReaderPosition, document: ReaderDocument) async -> Bool {
        guard ReaderSavePolicy.canSave(document: document, isWritable: isWritable) else { return false }
        guard let anchor = position.anchorBlockID, !anchor.isEmpty else { return false }
        do {
            _ = try await checkpoints.recordPosition(
                courseId: document.courseId,
                file: document.file,
                verticalPosition: position.verticalPosition,
                anchorBlockID: anchor,
                anchorFraction: position.anchorFraction
            )
            return true
        } catch {
            return false
        }
    }

    @discardableResult
    func addNoteCheckpoint(
        document: ReaderDocument,
        position: ReaderPosition,
        noteText: String,
        color: String
    ) async -> Checkpoint? {
        guard document.supportsCheckpoints, !document.isReadOnly, isWritable else { return nil }
        guard let anchor = position.anchorBlockID, !anchor.isEmpty else { return nil }
        return try? await checkpoints.addOrUpdateNote(
            courseId: document.courseId,
            file: document.file,
            verticalPosition: position.verticalPosition,
            anchorBlockID: anchor,
            anchorFraction: position.anchorFraction,
            color: color,
            noteText: noteText
        )
    }

    @discardableResult
    func deleteCheckpoint(courseId: String, checkpointId: String) async -> Bool {
        (try? await checkpoints.delete(courseId: courseId, checkpointId: checkpointId)) ?? false
    }

    func allNoteCheckpoints() async -> [CourseNoteCheckpoint] {
        (try? await checkpoints.allNoteCheckpoints(excludingArchived: true)) ?? []
    }

    // MARK: - Ingestion

    func createCourse(
        code: String,
        title: String? = nil,
        confirmExisting: Bool = false
    ) async throws -> CourseManifest {
        let manifest = try await ingestor.createCourse(
            NewCourseRequest(
                code: code,
                title: title,
                confirmExisting: confirmExisting
            )
        )
        dataRevision += 1
        return manifest
    }

    func ingestPackages(
        courseId: String,
        packages: [URL],
        overwriteExisting: Bool = false
    ) async throws -> IngestResult {
        // Documents is user-writable through Files; audit it before importing
        // untrusted packages (PLAN §3.1).
        await runDocumentsAudit()
        // Generated placeholders carry the same prompt text the desktop stores
        // in frontmatter, so a desktop roundtrip keeps the prompt association.
        let summaryPrompt = (try? await prompts.prompt(id: "summary"))?.content ?? ""
        let cheatsheetPrompt = (try? await prompts.prompt(id: "cheatsheet"))?.content ?? ""
        let testPrompt = (try? await prompts.prompt(id: "test"))?.content ?? ""
        let options = IngestOptions(
            overwriteExisting: overwriteExisting,
            summaryPrompt: summaryPrompt,
            cheatsheetPrompt: cheatsheetPrompt,
            testPrompt: testPrompt
        )
        let result = try await ingestor.ingest(
            courseId: courseId,
            packages: packages,
            options: options
        )
        dataRevision += 1
        return result
    }

    var contentSizeCategory: UIContentSizeCategory {
        UITraitCollection.current.preferredContentSizeCategory
    }
}
