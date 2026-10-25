import XCTest
@testable import CourseDeckCore

private actor ImportWaitFlag {
    private(set) var value = false
    func set() { value = true }
}

final class Round2BackupTests: XCTestCase {
    private let endpoint = "https://api.deepseek.com"

    private func localCard() -> LlmModelCard {
        LlmModelCard(
            id: "card_local",
            label: "Local",
            baseUrl: endpoint,
            authHeaderType: .bearer,
            model: "deepseek-flash",
            timeoutSeconds: 150
        )
    }

    private func importedCard(id: String = "card_imported") -> LlmModelCard {
        LlmModelCard(
            id: id,
            label: "Imported",
            baseUrl: endpoint,
            authHeaderType: .bearer,
            model: "deepseek-flash",
            timeoutSeconds: 150
        )
    }

    private func importedConfigJSON(
        id: String = "card_imported",
        endpoint: String? = nil,
        key: String
    ) -> String {
        let baseURL = endpoint ?? self.endpoint
        return """
        {
          "version": 2,
          "activeId": "\(id)",
          "cards": [
            {
              "id": "\(id)",
              "label": "Imported",
              "provider": "openai_compatible",
              "baseUrl": "\(baseURL)",
              "apiKey": "\(key)",
              "authHeaderType": "bearer",
              "model": "deepseek-flash",
              "temperature": 0.3,
              "timeoutSeconds": 150
            }
          ]
        }
        """
    }

    private func makeWorkspace(
        localKey: String?
    ) throws -> (workspace: TestWorkspace, secrets: InMemorySecretStore) {
        let workspace = try TestWorkspace()
        let card = localCard()
        let store = LlmStore(version: 2, activeId: card.id, cards: [card])
        try workspace.write(store.sanitizedJSON.serializedData(), to: "llm_config.json")
        let secrets = InMemorySecretStore()
        if let localKey {
            try secrets.setSecret(localKey, for: card.keyAccount)
        }
        return (workspace, secrets)
    }

    private func makeArchive(
        _ workspace: TestWorkspace,
        importedKey: String
    ) throws -> URL {
        let archive = workspace.baseURL.appendingPathComponent("import.zip")
        try TestWorkspace.makeZip(
            entries: [
                ("llm_config.json", Data(importedConfigJSON(key: importedKey).utf8)),
                ("prompts/summary.md", Data("# Imported Summary\n\nImported prompt body.".utf8)),
            ],
            at: archive
        )
        return archive
    }

    private func makeBundledPrompts(_ workspace: TestWorkspace) throws -> URL {
        let directory = workspace.baseURL.appendingPathComponent("BundledPrompts", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try Data("# Summary Prompt\n\nBundled default.".utf8)
            .write(to: directory.appendingPathComponent("summary.md"))
        return directory
    }

    private func service(
        _ workspace: TestWorkspace,
        _ secrets: InMemorySecretStore,
        _ provenance: PromptProvenanceStore,
        bundled: URL
    ) -> BackupService {
        BackupService(
            root: workspace.dataRoot,
            keyMigrator: KeyMigrator(secretStore: secrets),
            promptProvenance: provenance,
            bundledPromptsDirectory: bundled
        )
    }

    // MARK: - Key reconciliation

    func testEndpointMatchedImportedKeyIsAdoptedWhenLocalHasNone() async throws {
        let (workspace, secrets) = try makeWorkspace(localKey: nil)
        let archive = try makeArchive(workspace, importedKey: "imported-key-123")
        let bundled = try makeBundledPrompts(workspace)
        let provenance = PromptProvenanceStore(root: workspace.dataRoot)
        let service = service(workspace, secrets, provenance, bundled: bundled)

        let result = try await service.importBackup(from: archive)

        let local = localCard()
        let imported = importedCard()
        XCTAssertEqual(try secrets.secret(for: local.keyAccount), "imported-key-123")
        XCTAssertNil(try secrets.secret(for: imported.keyAccount))
        XCTAssertEqual(result.report.adoptedImportedKeyCardIDs, ["card_local"])
        XCTAssertTrue(result.report.pendingKeyReplacements.isEmpty)

        let merged = try workspace.readJSON("llm_config.json")
        let ids = merged["cards"]?.arrayValue?.compactMap { $0["id"]?.stringValue } ?? []
        XCTAssertEqual(ids, ["card_local"])
        XCTAssertFalse(try workspace.readString("llm_config.json").contains("imported-key-123"))

        // The imported prompt is stamped so an app update preserves it.
        let record = await provenance.record(id: "summary")
        XCTAssertEqual(record?.source, .imported)
        XCTAssertEqual(record?.activeSHA256, SHA256.hex("# Imported Summary\n\nImported prompt body."))
    }

    func testBothSidesWithKeysSurfacesPendingReplacementAndKeepsImportedKey() async throws {
        let (workspace, secrets) = try makeWorkspace(localKey: "local-key-456")
        let archive = try makeArchive(workspace, importedKey: "imported-key-789")
        let bundled = try makeBundledPrompts(workspace)
        let provenance = PromptProvenanceStore(root: workspace.dataRoot)
        let service = service(workspace, secrets, provenance, bundled: bundled)

        let result = try await service.importBackup(from: archive)

        let local = localCard()
        let imported = importedCard()
        XCTAssertEqual(try secrets.secret(for: local.keyAccount), "local-key-456")
        XCTAssertEqual(try secrets.secret(for: imported.keyAccount), "imported-key-789")
        XCTAssertEqual(result.report.pendingKeyReplacements.count, 1)
        let pending = try XCTUnwrap(result.report.pendingKeyReplacements.first)
        XCTAssertEqual(pending.cardId, "card_local")
        XCTAssertEqual(pending.importedCardId, "card_imported")
        XCTAssertEqual(pending.endpoint, endpoint)

        let merged = try workspace.readJSON("llm_config.json")
        let ids = Set(merged["cards"]?.arrayValue?.compactMap { $0["id"]?.stringValue } ?? [])
        // Keeping the imported card keeps its Keychain account alive for the
        // replace prompt instead of silently discarding the key.
        XCTAssertEqual(ids, Set(["card_local", "card_imported"]))

        // The user chooses "replace": the local account receives the imported
        // key and the extra imported card/account disappears.
        let store = LlmProviderStore(root: workspace.dataRoot, secretStore: secrets)
        _ = try await store.adoptImportedKey(localCardId: "card_local", importedCardId: "card_imported")
        XCTAssertEqual(try secrets.secret(for: local.keyAccount), "imported-key-789")
        XCTAssertNil(try secrets.secret(for: imported.keyAccount))
        let after = try await store.load()
        XCTAssertEqual(after.store.cards.map(\.id), ["card_local"])
        XCTAssertEqual(after.apiKeys["card_local"], "imported-key-789")
    }

    func testDifferentEndpointImportedCardIsKeptWithItsOwnKey() async throws {
        let (workspace, secrets) = try makeWorkspace(localKey: "local-key")
        let otherEndpoint = "https://opencode.ai/inference/openai/v1/"
        let archive = workspace.baseURL.appendingPathComponent("other.zip")
        try TestWorkspace.makeZip(
            entries: [
                ("llm_config.json", Data("""
                {
                  "version": 2,
                  "activeId": "card_glm",
                  "cards": [{
                    "id": "card_glm",
                    "label": "GLM",
                    "provider": "openai_compatible",
                    "baseUrl": "\(otherEndpoint)",
                    "apiKey": "glm-key-abc",
                    "authHeaderType": "bearer",
                    "model": "glm-5.3-flash",
                    "timeoutSeconds": 150
                  }]
                }
                """.utf8)),
            ],
            at: archive
        )
        let bundled = try makeBundledPrompts(workspace)
        let provenance = PromptProvenanceStore(root: workspace.dataRoot)
        let service = service(workspace, secrets, provenance, bundled: bundled)

        let result = try await service.importBackup(from: archive)
        let glm = LlmModelCard(
            id: "card_glm",
            label: "GLM",
            baseUrl: otherEndpoint,
            authHeaderType: .bearer,
            model: "glm-5.3-flash"
        )
        XCTAssertEqual(try secrets.secret(for: glm.keyAccount), "glm-key-abc")
        XCTAssertTrue(result.report.pendingKeyReplacements.isEmpty)
        XCTAssertTrue(result.report.adoptedImportedKeyCardIDs.isEmpty)
    }

    func testStalePendingReplacementIsRejectedAfterLocalEndpointChanges() async throws {
        let (workspace, secrets) = try makeWorkspace(localKey: "local-key-456")
        let archive = try makeArchive(workspace, importedKey: "imported-key-789")
        let bundled = try makeBundledPrompts(workspace)
        let provenance = PromptProvenanceStore(root: workspace.dataRoot)
        let service = service(workspace, secrets, provenance, bundled: bundled)
        let result = try await service.importBackup(from: archive)
        let pending = try XCTUnwrap(result.report.pendingKeyReplacements.first)
        let imported = importedCard()

        let store = LlmProviderStore(root: workspace.dataRoot, secretStore: secrets)
        var relocated = localCard()
        relocated.baseUrl = "https://example.com/v1"
        _ = try await store.upsert(card: relocated)

        let stillValid = try await store.isPendingKeyReplacementValid(pending)
        XCTAssertFalse(stillValid)
        do {
            _ = try await store.adoptImportedKey(
                localCardId: pending.cardId,
                importedCardId: pending.importedCardId
            )
            XCTFail("Expected stale replacement rejection")
        } catch let error as LlmProviderStoreError {
            guard case .invalidEndpoint = error else { return XCTFail("Wrong error \(error)") }
        }
        XCTAssertEqual(try secrets.secret(for: imported.keyAccount), "imported-key-789")
    }

    func testImportedCardIDCollisionRetainsKeyUnderUniqueAccount() async throws {
        let workspace = try TestWorkspace()
        let secrets = InMemorySecretStore()
        let local = LlmModelCard(
            id: "card_shared",
            label: "Local shared",
            baseUrl: endpoint,
            authHeaderType: .bearer,
            model: "deepseek-flash"
        )
        try workspace.write(
            LlmStore(version: 2, activeId: local.id, cards: [local]).sanitizedJSON.serializedData(),
            to: "llm_config.json"
        )
        try secrets.setSecret("local-key", for: local.keyAccount)

        let otherEndpoint = "https://example.com/v1"
        let archive = workspace.baseURL.appendingPathComponent("collision.zip")
        try TestWorkspace.makeZip(
            entries: [
                (
                    "llm_config.json",
                    Data(importedConfigJSON(
                        id: "card_shared",
                        endpoint: otherEndpoint,
                        key: "imported-key"
                    ).utf8)
                ),
            ],
            at: archive
        )
        let service = BackupService(
            root: workspace.dataRoot,
            keyMigrator: KeyMigrator(secretStore: secrets)
        )
        let result = try await service.importBackup(from: archive)
        XCTAssertTrue(result.report.pendingKeyReplacements.isEmpty)

        let providerStore = LlmProviderStore(root: workspace.dataRoot, secretStore: secrets)
        let configuration = try await providerStore.load()
        let imported = try XCTUnwrap(configuration.store.cards.first {
            $0.id != "card_shared"
                && KeyMigrator.normalizedBaseURL($0.baseUrl) == otherEndpoint
        })
        XCTAssertTrue(imported.id.hasPrefix("card_imported_"))
        XCTAssertEqual(try secrets.secret(for: imported.keyAccount), "imported-key")
        XCTAssertNil(try secrets.secret(for: LlmModelCard(
            id: "card_shared",
            label: "old imported account",
            baseUrl: otherEndpoint
        ).keyAccount))

        // The retained card keeps its account through an orphan audit.
        _ = try KeyMigrator(secretStore: secrets).auditOrphans(knownCards: configuration.store.cards)
        XCTAssertEqual(try secrets.secret(for: imported.keyAccount), "imported-key")
        XCTAssertEqual(try secrets.secret(for: local.keyAccount), "local-key")
    }

    func testImportQuiescesGenerationQueueBeforeMerging() async throws {
        let (workspace, secrets) = try makeWorkspace(localKey: nil)
        let archive = try makeArchive(workspace, importedKey: "imported-key")
        let started = ImportWaitFlag()
        let queue = GenerationQueue(
            root: workspace.dataRoot,
            executor: { _, _ in
                await started.set()
                try await Task.sleep(nanoseconds: 60_000_000_000)
                return GenerationOutcome(content: "never")
            },
            retryable: { _ in false }
        )
        await queue.start()
        let job = GenerationJob(
            id: GenerationJob.identifier(courseId: "baf3m", lessonId: "01.01", tab: "summary"),
            courseId: "baf3m",
            lessonId: "01.01",
            lessonTitle: "Lesson",
            tab: "summary",
            activeCardId: "card_local"
        )
        _ = try await queue.enqueue(job)
        let deadline = Date().addingTimeInterval(5)
        while (await started.value) == false, Date() < deadline {
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        let didStart = await started.value
        XCTAssertTrue(didStart)

        let service = BackupService(
            root: workspace.dataRoot,
            keyMigrator: KeyMigrator(secretStore: secrets),
            generationQueue: queue
        )
        _ = try await service.importBackup(from: archive)

        let stored = await queue.job(id: job.id)
        XCTAssertEqual(stored?.status, .interrupted)
        await queue.shutdown(interruptRunning: true)
    }

    // MARK: - Prompt provenance

    func testImportRecordsProvenanceForImportedPrompts() async throws {
        let (workspace, secrets) = try makeWorkspace(localKey: nil)
        let archive = try makeArchive(workspace, importedKey: "imported-key")
        let bundled = try makeBundledPrompts(workspace)
        let provenance = PromptProvenanceStore(root: workspace.dataRoot)
        let service = service(workspace, secrets, provenance, bundled: bundled)

        _ = try await service.importBackup(from: archive)

        let record = await provenance.record(id: "summary")
        XCTAssertEqual(record?.source, .imported)
        XCTAssertEqual(record?.bundledSHA256, SHA256.hex("# Summary Prompt\n\nBundled default."))
        XCTAssertEqual(record?.activeSHA256, SHA256.hex("# Imported Summary\n\nImported prompt body."))
        XCTAssertEqual(
            try workspace.readString("prompts/summary.md"),
            "# Imported Summary\n\nImported prompt body."
        )
    }
}
