import XCTest
@testable import CourseDeckCore

final class KeyMigratorTests: XCTestCase {
    func testMigratesKeysToStoreAndSanitizesConfig() throws {
        let store = InMemorySecretStore()
        let migrator = KeyMigrator(secretStore: store)
        let data = Data(makeLlmConfigJSON().utf8)
        let result = try XCTUnwrap(try migrator.migrateConfigData(data))

        XCTAssertEqual(result.report.importedCardIDs, ["card_deepseek"])
        XCTAssertEqual(result.json["cards"]?[0]?["apiKey"]?.stringValue, "")
        XCTAssertFalse(result.json.serialized().contains("sk-test123456789012345678901234"))

        let account = KeyMigrator.account(cardId: "card_deepseek", baseURL: "https://api.deepseek.com")
        XCTAssertEqual(try store.secret(for: account), "sk-test123456789012345678901234")
        XCTAssertTrue(account.hasPrefix("llm_card:card_deepseek:"))
    }

    func testLocalKeyWinsByDefaultAndReplacePolicyOverrides() throws {
        let card = LlmModelCard(
            id: "card_deepseek",
            label: "DeepSeek",
            baseUrl: "https://api.deepseek.com",
            apiKey: "sk-imported123456789012345678901",
            authHeaderType: .apiKey
        )
        let store = InMemorySecretStore()
        try store.setSecret("sk-local123456789012345678901234", for: card.keyAccount)

        let preserve = KeyMigrator(secretStore: store, policy: .preserveLocal)
        let preserved = try preserve.migrate(store: LlmStore(cards: [card]))
        XCTAssertEqual(preserved.report.keptLocalCardIDs, ["card_deepseek"])
        XCTAssertTrue(preserved.report.importedCardIDs.isEmpty)
        XCTAssertEqual(try store.secret(for: card.keyAccount), "sk-local123456789012345678901234")
        XCTAssertEqual(preserved.store.cards[0].apiKey, "")

        let replace = KeyMigrator(secretStore: store, policy: .replaceLocal)
        let replaced = try replace.migrate(store: LlmStore(cards: [card]))
        XCTAssertEqual(replaced.report.importedCardIDs, ["card_deepseek"])
        XCTAssertEqual(try store.secret(for: card.keyAccount), "sk-imported123456789012345678901")
    }

    func testNoSecretStoreDiscardsImportedKeys() throws {
        let migrator = KeyMigrator(secretStore: nil)
        let store = try LlmStore.decode(Data(makeLlmConfigJSON().utf8))
        let result = try migrator.migrate(store: store)
        XCTAssertEqual(result.report.discardedCardIDs, ["card_deepseek"])
        XCTAssertEqual(result.store.cards[0].apiKey, "")
    }

    func testEndpointBindingAndOrphanAudit() throws {
        XCTAssertEqual(
            KeyMigrator.normalizedBaseURL(" HTTPS://API.DeepSeek.com/ "),
            "https://api.deepseek.com"
        )
        let a = KeyMigrator.account(cardId: "card", baseURL: "https://api.deepseek.com")
        let b = KeyMigrator.account(cardId: "card", baseURL: "https://api.deepseek.com/v1")
        XCTAssertNotEqual(a, b)

        let store = InMemorySecretStore()
        let card = LlmModelCard(id: "card", label: "C", baseUrl: "https://api.deepseek.com")
        try store.setSecret("key", for: card.keyAccount)
        try store.setSecret("orphan", for: KeyMigrator.account(cardId: "deleted", baseURL: "https://old.example.com"))
        try store.setSecret("unrelated", for: "some_other_service")

        let deleted = try KeyMigrator(secretStore: store).auditOrphans(knownCards: [card])
        XCTAssertEqual(deleted, ["llm_card:deleted:https://old.example.com"])
        XCTAssertEqual(try store.secret(for: card.keyAccount), "key")
        XCTAssertEqual(try store.secret(for: "some_other_service"), "unrelated")
    }

    func testLlmStoreNormalizationPreservesUnknownCardFields() throws {
        let json = """
        {
          "version": 2,
          "activeId": "card_deepseek",
          "customRoot": true,
          "cards": [
            {
              "id": "card_deepseek",
              "label": "DeepSeek",
              "provider": "openai_compatible",
              "baseUrl": "https://api.deepseek.com",
              "authHeaderType": "api_key",
              "model": "deepseek-flash",
              "timeoutSeconds": 150,
              "maxTokens": 32000,
              "thinking": false
            }
          ]
        }
        """
        let store = try LlmStore.decode(Data(json.utf8))
        XCTAssertEqual(store.cards.count, 1)
        XCTAssertEqual(store.cards[0].authHeaderType, .apiKey)
        XCTAssertEqual(store.cards[0].extras.map(\.key), ["maxTokens", "thinking"])
        XCTAssertEqual(store.extras.map(\.key), ["customRoot"])
        let sanitized = store.sanitizedJSON.serialized(pretty: false)
        XCTAssertTrue(sanitized.contains(#""maxTokens":32000"#))
        XCTAssertTrue(sanitized.contains(#""customRoot":true"#))
    }
}

final class ImportInboxAuditTests: XCTestCase {
    func testAuditQuarantinesSecretsAndMigratesConfigAnywhereInDocuments() async throws {
        let workspace = try TestWorkspace()
        let fileManager = FileManager.default

        // A backup unzipped straight into Documents (not just the inbox).
        try TestWorkspace.makeZip(
            entries: [("courses/baf3m/meta.json", Data(#"{"id":"baf3m","title":"X","units":[]}"#.utf8))],
            at: workspace.importInbox.appendingPathComponent("desktop-backup.zip")
        )
        try fileManager.createDirectory(
            at: workspace.documentsURL.appendingPathComponent("courses/baf3m", isDirectory: true),
            withIntermediateDirectories: true
        )
        try Data("# course notes".utf8).write(
            to: workspace.documentsURL.appendingPathComponent("courses/baf3m/01.01.lesson.md")
        )
        try Data(makeLlmConfigJSON().utf8).write(to: workspace.documentsURL.appendingPathComponent("llm_config.json"))
        try Data("token".utf8).write(to: workspace.documentsURL.appendingPathComponent(".mcp-token"))
        try Data("junk".utf8).write(to: workspace.documentsURL.appendingPathComponent(".DS_Store"))
        try Data("oauth".utf8).write(to: workspace.documentsURL.appendingPathComponent(".google_credentials.json"))

        let keyStore = InMemorySecretStore()
        let audit = ImportInboxAudit(
            root: workspace.dataRoot,
            keyMigrator: KeyMigrator(secretStore: keyStore)
        )
        let report = await audit.auditDocumentsTree()

        XCTAssertEqual(report.quarantined.count, 3)
        XCTAssertTrue(report.quarantined.contains(".mcp-token"))
        XCTAssertTrue(report.quarantined.contains(".DS_Store"))
        XCTAssertTrue(report.quarantined.contains(".google_credentials.json"))
        XCTAssertEqual(report.migratedConfigs, ["llm_config.json"])
        XCTAssertEqual(report.inboxArchives.map(\.lastPathComponent), ["desktop-backup.zip"])

        // Non-secret course files stay where they are.
        XCTAssertEqual(
            String(
                data: try Data(contentsOf: workspace.documentsURL.appendingPathComponent("courses/baf3m/01.01.lesson.md")),
                encoding: .utf8
            ),
            "# course notes"
        )
        // The config is rewritten without the key.
        let config = try String(contentsOf: workspace.documentsURL.appendingPathComponent("llm_config.json"))
        XCTAssertFalse(config.contains("sk-test123456789012345678901234"))
        XCTAssertEqual(
            try keyStore.secret(for: KeyMigrator.account(
                cardId: "card_deepseek",
                baseURL: "https://api.deepseek.com"
            )),
            "sk-test123456789012345678901234"
        )
        // Denylisted files no longer exist inside Documents; they were moved
        // into a timestamped audit quarantine folder.
        XCTAssertFalse(fileManager.fileExists(atPath: workspace.documentsURL.appendingPathComponent(".mcp-token").path))
        let quarantineFolders = try fileManager.contentsOfDirectory(
            at: workspace.dataRoot.quarantineURL,
            includingPropertiesForKeys: nil
        )
        XCTAssertEqual(quarantineFolders.count, 1)
        let quarantined = try fileManager.contentsOfDirectory(
            at: quarantineFolders[0],
            includingPropertiesForKeys: nil
        ).map(\.lastPathComponent)
        XCTAssertTrue(quarantined.contains(".mcp-token"))
        XCTAssertTrue(quarantined.contains(".DS_Store"))
        XCTAssertTrue(quarantined.contains(".google_credentials.json"))
    }

    func testImportedInboxArchiveCanBeRemovedOnlyInsideInbox() async throws {
        let workspace = try TestWorkspace()
        let inboxFile = workspace.importInbox.appendingPathComponent("backup.zip")
        try Data("zip".utf8).write(to: inboxFile)
        let outside = workspace.documentsURL.appendingPathComponent("outside.zip")
        try Data("zip".utf8).write(to: outside)

        let audit = ImportInboxAudit(root: workspace.dataRoot, keyMigrator: KeyMigrator(secretStore: nil))
        try await audit.removeImportedArchive(inboxFile)
        XCTAssertFalse(FileManager.default.fileExists(atPath: inboxFile.path))

        do {
            try await audit.removeImportedArchive(outside)
            XCTFail("expected rejection")
        } catch let error as BackupError {
            guard case .importFailed = error else { return XCTFail("wrong error \(error)") }
        }
        XCTAssertTrue(FileManager.default.fileExists(atPath: outside.path))
    }
}
