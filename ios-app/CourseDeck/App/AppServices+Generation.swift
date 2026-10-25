import CourseDeckCore
import Foundation

// MARK: - Generation, provider, prompt, and import actions used by the UI.

@MainActor
extension AppServices {
    func refreshGenerationStatus() async {
        generationIsRunning = await generationLifecycle.queueIsRunning()
        generationError = await generationLifecycle.lastError
    }

    func retryGenerationRecovery() async {
        await generationLifecycle.consentDidChange()
        await refreshGenerationStatus()
    }

    // MARK: Enqueue

    @discardableResult
    func enqueueLessonGeneration(
        courseId: String,
        lessonId: String,
        tab: String,
        force: Bool,
        customPrompt: String? = nil,
        customContent: String? = nil
    ) async throws -> GenerationJob {
        let job = try await generationService.prepareLessonJob(
            LessonGenerationInput(
                courseId: courseId,
                lessonId: lessonId,
                tab: tab,
                customPrompt: customPrompt,
                customContent: customContent,
                force: force
            )
        )
        return try await enqueue(job)
    }

    @discardableResult
    func enqueueUnitGeneration(
        courseId: String,
        unitNumber: Int,
        tab: String,
        force: Bool,
        customPrompt: String? = nil,
        customContent: String? = nil
    ) async throws -> GenerationJob {
        let job = try await generationService.prepareUnitJob(
            UnitGenerationInput(
                courseId: courseId,
                unitNumber: unitNumber,
                tab: tab,
                customPrompt: customPrompt,
                customContent: customContent,
                force: force
            )
        )
        return try await enqueue(job)
    }

    @discardableResult
    func enqueueCourseDocGeneration(
        courseId: String,
        kind: CourseDocKind,
        force: Bool
    ) async throws -> GenerationJob {
        let job = try await generationService.prepareCourseDocJob(
            CourseDocGenerationInput(courseId: courseId, kind: kind, force: force)
        )
        return try await enqueue(job)
    }

    private func enqueue(_ job: GenerationJob) async throws -> GenerationJob {
        let queued = try await generationQueue.enqueue(job)
        await refreshGenerationStatus()
        return queued
    }

    // MARK: Job list

    func generationJobs() async -> [GenerationJob] {
        let jobs = await generationQueue.allJobs()
        return jobs.sorted { $0.createdAt > $1.createdAt }
    }

    func generationJob(id: String) async -> GenerationJob? {
        await generationQueue.job(id: id)
    }

    @discardableResult
    func retryGenerationJob(id: String) async throws -> GenerationJob? {
        let job = try await generationQueue.retry(id: id)
        await refreshGenerationStatus()
        return job
    }

    @discardableResult
    func discardGenerationJob(id: String) async throws -> Bool {
        let removed = try await generationQueue.discard(id: id)
        await refreshGenerationStatus()
        return removed
    }

    @discardableResult
    func cancelGenerationJob(id: String) async throws -> GenerationJob? {
        let job = try await generationQueue.cancel(id: id)
        await refreshGenerationStatus()
        return job
    }

    // MARK: Providers / keys

    func providerConfiguration() async throws -> LlmProviderConfiguration {
        try await llmProviders.load()
    }

    func saveModelCard(
        _ card: LlmModelCard,
        key: String?,
        extensions: LlmCardExtensions?
    ) async throws {
        var card = card
        if card.id.isEmpty
            || card.id.range(of: PathValidator.idPattern, options: [.regularExpression, .caseInsensitive]) == nil {
            card.id = "card_" + String(UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(12)).lowercased()
        }
        _ = try await llmProviders.upsert(card: card, extensions: extensions)
        if let key, !key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            try await llmProviders.setAPIKey(key, for: card.id)
        }
        await refreshGenerationStatus()
    }

    func deleteModelCard(id: String) async throws {
        _ = try await llmProviders.deleteCard(id: id)
        await refreshGenerationStatus()
    }

    func setActiveModelCard(id: String) async throws {
        _ = try await llmProviders.setActiveCard(id: id)
        await refreshGenerationStatus()
    }

    func clearModelKey(id: String) async throws {
        try await llmProviders.setAPIKey("", for: id)
    }

    // MARK: Prompts

    func promptInventory() async throws -> [PromptInventoryEntry] {
        try await prompts.inventory()
    }

    func prompt(id: String) async throws -> Prompt? {
        try await prompts.prompt(id: id)
    }

    @discardableResult
    func savePromptContent(id: String, content: String) async throws -> Prompt {
        try await prompts.save(id: id, content: content)
    }

    @discardableResult
    func createPrompt(id: String, content: String) async throws -> Prompt {
        try await prompts.create(id: id, content: content)
    }

    @discardableResult
    func restorePrompt(id: String) async throws -> Prompt {
        try await prompts.restoreDefault(id: id)
    }

    @discardableResult
    func deletePrompt(id: String) async throws -> Bool {
        try await prompts.delete(id: id)
    }

    func promptStagingValidation() async throws -> PromptManifestValidation? {
        try await prompts.stagingValidation()
    }

    // MARK: Missing work

    func scanMissingWork(courseId: String) async throws -> [MissingWorkItem] {
        try await missingWorkScanner.scan(courseId: courseId)
    }

    // MARK: Backup / pending keys

    func importBackup(from url: URL) async throws -> BackupImportResult {
        let accessing = url.startAccessingSecurityScopedResource()
        defer {
            if accessing { url.stopAccessingSecurityScopedResource() }
        }
        let result = try await backupService.importBackup(from: url)
        lastBackupReport = result.report
        pendingKeyReplacements = result.report.pendingKeyReplacements
        bumpDataRevision()
        await validatePendingKeyReplacements()
        await refreshGenerationStatus()
        return result
    }

    func validatePendingKeyReplacements() async {
        var valid: [PendingKeyReplacement] = []
        for candidate in pendingKeyReplacements {
            if (try? await llmProviders.isPendingKeyReplacementValid(candidate)) == true {
                valid.append(candidate)
            }
        }
        pendingKeyReplacements = valid
    }

    func replacePendingKey(_ candidate: PendingKeyReplacement) async throws {
        _ = try await llmProviders.adoptImportedKey(
            localCardId: candidate.cardId,
            importedCardId: candidate.importedCardId
        )
        pendingKeyReplacements.removeAll { $0.id == candidate.id }
        await refreshGenerationStatus()
    }

    func keepLocalKey(_ candidate: PendingKeyReplacement) async throws {
        _ = try await llmProviders.deleteCard(id: candidate.importedCardId)
        pendingKeyReplacements.removeAll { $0.id == candidate.id }
        await refreshGenerationStatus()
    }
}
