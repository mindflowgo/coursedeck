import XCTest
@testable import CourseDeckCore

final class LlmProviderStoreTests: XCTestCase {
    private func configJSON(cards: String, activeID: String = "card_deepseek") -> String {
        """
        {
          "version": 2,
          "activeId": "\(activeID)",
          "cards": [\(cards)]
        }
        """
    }

    // MARK: - Defaults

    func testDefaultDeepSeekCardIsBearerWithIOSSidecar() async throws {
        let workspace = try TestWorkspace()
        let secrets = InMemorySecretStore()
        let store = LlmProviderStore(root: workspace.dataRoot, secretStore: secrets)

        let configuration = try await store.load()
        let card = try XCTUnwrap(configuration.store.cards.first)
        XCTAssertEqual(card.id, "card_deepseek")
        XCTAssertEqual(card.label, "DeepSeek")
        XCTAssertEqual(card.baseUrl, "https://api.deepseek.com")
        XCTAssertEqual(card.model, "deepseek-flash")
        XCTAssertEqual(card.authHeaderType, .bearer)
        XCTAssertEqual(card.temperature, 0.3)

        let resolved = try XCTUnwrap(configuration.activeCard)
        XCTAssertEqual(resolved.extensions.maxTokens, 24_576)
        XCTAssertFalse(resolved.extensions.thinking)
        XCTAssertEqual(resolved.extensions.idleTimeoutSeconds, 60)
        XCTAssertEqual(resolved.timeoutPolicy.idle, 60)
        XCTAssertEqual(resolved.timeoutPolicy.absolute, 900)
        XCTAssertTrue(resolved.capabilities.supportsThinking)
        XCTAssertEqual(resolved.capabilities.authHeaderType, .bearer)

        XCTAssertTrue(workspace.exists("llm_config.json"))
        XCTAssertTrue(workspace.exists("llm_ios.json"))
        let ios = try workspace.readJSON("llm_ios.json")
        XCTAssertEqual(ios["cards"]?["card_deepseek"]?["maxTokens"]?.intValue, 24_576)
        XCTAssertEqual(ios["cards"]?["card_deepseek"]?["thinking"]?.boolValue, false)
        XCTAssertEqual(ios["cards"]?["card_deepseek"]?["capabilities"]?["thinking"]?.boolValue, true)
        let text = try workspace.readString("llm_config.json")
        XCTAssertFalse(text.contains("apiKey\": \"sk-"))
    }

    // MARK: - Key migration and endpoint binding

    func testImportedAPIKeyCardIsNormalizedToBearerAndMigrated() async throws {
        let workspace = try TestWorkspace()
        let secrets = InMemorySecretStore()
        try workspace.write(makeLlmConfigJSON(), to: "llm_config.json")
        let store = LlmProviderStore(root: workspace.dataRoot, secretStore: secrets)

        let configuration = try await store.load()
        let card = try XCTUnwrap(configuration.store.cards.first)
        XCTAssertEqual(card.authHeaderType, .bearer)
        XCTAssertEqual(card.apiKey, "")
        XCTAssertEqual(configuration.apiKeys[card.id], "sk-test123456789012345678901234")
        XCTAssertEqual(try secrets.secret(for: card.keyAccount), "sk-test123456789012345678901234")

        let persisted = try workspace.readString("llm_config.json")
        XCTAssertFalse(persisted.contains("sk-test123456789012345678901234"))
        XCTAssertTrue(persisted.contains("\"authHeaderType\" : \"bearer\"") || persisted.contains("\"authHeaderType\": \"bearer\""))

        // A later launch without a plaintext key still resolves it.
        let reloaded = try await LlmProviderStore(root: workspace.dataRoot, secretStore: secrets).load()
        XCTAssertEqual(reloaded.activeCard?.apiKey, "sk-test123456789012345678901234")
        XCTAssertTrue(reloaded.activeCard?.isConfigured ?? false)
    }

    func testEndpointChangeClearsBoundKey() async throws {
        let workspace = try TestWorkspace()
        let secrets = InMemorySecretStore()
        let store = LlmProviderStore(root: workspace.dataRoot, secretStore: secrets)
        var configuration = try await store.load()
        let card = try XCTUnwrap(configuration.store.cards.first)
        try await store.setAPIKey("sk-local-key", for: card.id)
        let storedKey = try await store.apiKey(for: card.id)
        XCTAssertEqual(storedKey, "sk-local-key")

        var changed = card
        changed.baseUrl = "https://example.com/v1"
        _ = try await store.upsert(card: changed)

        let loaded = try await store.load()
        XCTAssertNil(loaded.apiKeys[card.id])
        XCTAssertNil(try secrets.secret(for: card.keyAccount))
        let text = try workspace.readString("llm_config.json")
        XCTAssertFalse(text.contains("sk-local-key"))
    }

    func testDeleteCardRemovesKeyAndOrphanItem() async throws {
        let workspace = try TestWorkspace()
        let secrets = InMemorySecretStore()
        let store = LlmProviderStore(root: workspace.dataRoot, secretStore: secrets)
        let configuration = try await store.load()
        let card = try XCTUnwrap(configuration.store.cards.first)
        try await store.setAPIKey("sk-delete-me", for: card.id)

        _ = try await store.deleteCard(id: card.id)
        XCTAssertNil(try secrets.secret(for: card.keyAccount))
        let after = try await store.load()
        XCTAssertTrue(after.store.cards.isEmpty)
        XCTAssertNil(after.store.activeId)
    }

    // MARK: - Timeout mapping

    func testImportedTimeoutMapsToIdleAndClamps() async throws {
        let workspace = try TestWorkspace()
        try workspace.write(
            configJSON(cards: """
            {"id":"card_deepseek","label":"DeepSeek","provider":"openai_compatible","baseUrl":"https://api.deepseek.com","authHeaderType":"api_key","model":"deepseek-flash","temperature":0.3,"timeoutSeconds":150}
            """),
            to: "llm_config.json"
        )
        let store = LlmProviderStore(root: workspace.dataRoot, secretStore: InMemorySecretStore())
        let configuration = try await store.load()
        let resolved = try XCTUnwrap(configuration.activeCard)
        XCTAssertEqual(resolved.extensions.idleTimeoutSeconds, 150)
        XCTAssertEqual(resolved.timeoutPolicy.idle, 150)
        XCTAssertEqual(resolved.timeoutPolicy.absolute, 900)
        XCTAssertEqual(resolved.timeoutPolicy.connect, 30)
    }

    func testHugeImportedTimeoutIsClampedNotAbsolute() async throws {
        let workspace = try TestWorkspace()
        try workspace.write(
            configJSON(cards: """
            {"id":"card_deepseek","label":"DeepSeek","provider":"openai_compatible","baseUrl":"https://api.deepseek.com","authHeaderType":"bearer","model":"deepseek-flash","timeoutSeconds":5000}
            """),
            to: "llm_config.json"
        )
        let store = LlmProviderStore(root: workspace.dataRoot, secretStore: InMemorySecretStore())
        let configuration = try await store.load()
        let resolved = try XCTUnwrap(configuration.activeCard)
        XCTAssertEqual(resolved.extensions.idleTimeoutSeconds, 600)
        XCTAssertEqual(resolved.timeoutPolicy.idle, 600)
        XCTAssertEqual(resolved.timeoutPolicy.absolute, 900)
    }

    // MARK: - Corrupt config

    func testCorruptConfigThrowsAndQuarantinesInsteadOfWiping() async throws {
        let workspace = try TestWorkspace()
        try workspace.write("{ this is not json", to: "llm_config.json")
        let store = LlmProviderStore(root: workspace.dataRoot, secretStore: InMemorySecretStore())

        do {
            _ = try await store.load()
            XCTFail("Expected a corrupt configuration error")
        } catch let error as LlmProviderStoreError {
            guard case let .corruptConfiguration(quarantinedAt) = error else {
                return XCTFail("Wrong error: \(error)")
            }
            XCTAssertNotNil(quarantinedAt)
        }
        XCTAssertFalse(workspace.exists("llm_config.json"))
        let quarantine = try FileManager.default.contentsOfDirectory(atPath: workspace.url(".quarantine").path)
        XCTAssertEqual(quarantine.count, 1)
    }

    // MARK: - Provider capability matrix

    func testProviderCapabilitiesDifferPerHost() async throws {
        let workspace = try TestWorkspace()
        try workspace.write(
            configJSON(cards: """
            {"id":"card_deepseek","label":"DeepSeek","provider":"openai_compatible","baseUrl":"https://api.deepseek.com","authHeaderType":"api_key","model":"deepseek-flash","timeoutSeconds":150},
            {"id":"card_glm","label":"GLM","provider":"openai_compatible","baseUrl":"https://opencode.ai/inference/openai/v1/","authHeaderType":"bearer","model":"glm-5.3-flash","timeoutSeconds":150}
            """),
            to: "llm_config.json"
        )
        let store = LlmProviderStore(root: workspace.dataRoot, secretStore: InMemorySecretStore())
        let configuration = try await store.load()
        let deepSeek = try XCTUnwrap(configuration.resolvedCard(id: "card_deepseek"))
        let glm = try XCTUnwrap(configuration.resolvedCard(id: "card_glm"))

        XCTAssertEqual(deepSeek.card.authHeaderType, .bearer)
        XCTAssertTrue(deepSeek.capabilities.supportsThinking)
        XCTAssertTrue(deepSeek.capabilities.supportsStreamUsage)

        XCTAssertEqual(glm.card.authHeaderType, .bearer)
        XCTAssertFalse(glm.capabilities.supportsThinking)
        XCTAssertTrue(glm.capabilities.supportsStreamUsage)
        XCTAssertFalse(glm.capabilities.supportsSessionID)
        XCTAssertEqual(glm.capabilities.maxTokensField, .maxTokens)
    }

    func testOpenAIReasoningModelUsesMaxCompletionTokensAndNoTemperature() {
        let card = LlmModelCard(
            id: "card_openai",
            label: "OpenAI",
            baseUrl: "https://api.openai.com/v1",
            authHeaderType: .bearer,
            model: "gpt-5-mini"
        )
        let capabilities = LlmProviderCapabilities.resolved(for: card)
        XCTAssertEqual(capabilities.maxTokensField, .maxCompletionTokens)
        XCTAssertFalse(capabilities.supportsTemperature)
    }

    func testNativeLlamaCppIsUnsupported() async throws {
        let workspace = try TestWorkspace()
        try workspace.write(
            configJSON(cards: """
            {"id":"card_local","label":"llama.cpp","provider":"llamacpp_native","baseUrl":"http://127.0.0.1:8080","authHeaderType":"bearer","model":"local","timeoutSeconds":60}
            """),
            to: "llm_config.json"
        )
        let store = LlmProviderStore(root: workspace.dataRoot, secretStore: InMemorySecretStore())
        let configuration = try await store.load()
        let card = try XCTUnwrap(configuration.activeCard)
        XCTAssertFalse(card.capabilities.isSupported)

        do {
            _ = try await store.resolvedCard()
            XCTFail("Expected unsupported provider")
        } catch let error as LlmProviderStoreError {
            XCTAssertEqual(error, .unsupportedProvider("llamacpp_native"))
        }
    }

    // MARK: - Extension roundtrip

    func testIOSSidecarPreservesUnknownKeysAndValues() async throws {
        let workspace = try TestWorkspace()
        let secrets = InMemorySecretStore()
        let store = LlmProviderStore(root: workspace.dataRoot, secretStore: secrets)
        _ = try await store.load()

        try workspace.write(
            """
            {
              "version": 1,
              "cards": {
                "card_deepseek": {
                  "maxTokens": 12345,
                  "thinking": true,
                  "idleTimeoutSeconds": 90,
                  "futureField": {"nested": true}
                }
              },
              "futureRoot": "keep"
            }
            """,
            to: "llm_ios.json"
        )

        let configuration = try await store.load()
        let extensions = try XCTUnwrap(configuration.extensions["card_deepseek"])
        XCTAssertEqual(extensions.maxTokens, 12_345)
        XCTAssertTrue(extensions.thinking)
        XCTAssertEqual(extensions.idleTimeoutSeconds, 90)
        XCTAssertTrue(extensions.extras.contains { $0.key == "futureField" })

        var updated = configuration
        updated.store.cards[0].label = "DeepSeek Updated"
        _ = try await store.save(updated)
        let persisted = try workspace.readJSON("llm_ios.json")
        XCTAssertEqual(persisted["cards"]?["card_deepseek"]?["maxTokens"]?.intValue, 12_345)
        XCTAssertEqual(persisted["cards"]?["card_deepseek"]?["futureField"]?["nested"]?.boolValue, true)
    }

    func testSanitizedStoreNeverWritesPlaintextKeys() async throws {
        let workspace = try TestWorkspace()
        let secrets = InMemorySecretStore()
        let store = LlmProviderStore(root: workspace.dataRoot, secretStore: secrets)
        var configuration = try await store.load()
        configuration.store.cards[0].apiKey = "sk-should-not-persist"
        _ = try await store.save(configuration)

        let text = try workspace.readString("llm_config.json")
        XCTAssertFalse(text.contains("sk-should-not-persist"))
        XCTAssertEqual(
            try secrets.secret(for: configuration.store.cards[0].keyAccount),
            "sk-should-not-persist"
        )
    }

    // MARK: - Mutations, lease, and gate

    func testUpsertWithoutExtensionsRefreshesIdleTimeout() async throws {
        let workspace = try TestWorkspace()
        let store = LlmProviderStore(root: workspace.dataRoot, secretStore: InMemorySecretStore())
        var configuration = try await store.load()
        let id = configuration.store.cards[0].id
        var extensions = try XCTUnwrap(configuration.extensions[id])
        extensions.idleTimeoutSeconds = 300
        extensions.maxTokens = 12_345
        configuration.extensions[id] = extensions
        _ = try await store.save(configuration)

        var card = configuration.store.cards[0]
        card.timeoutSeconds = 90
        _ = try await store.upsert(card: card)

        let reloaded = try await store.load()
        XCTAssertEqual(reloaded.extensions[id]?.idleTimeoutSeconds, 90)
        XCTAssertEqual(reloaded.extensions[id]?.maxTokens, 12_345)
        XCTAssertEqual(reloaded.activeCard?.timeoutPolicy.idle, 90)
    }

    func testEndpointChangeWithCarriedKeyDoesNotStoreIt() async throws {
        let workspace = try TestWorkspace()
        let secrets = InMemorySecretStore()
        let store = LlmProviderStore(root: workspace.dataRoot, secretStore: secrets)
        var configuration = try await store.load()
        let card = configuration.store.cards[0]
        try await store.setAPIKey("sk-old-host", for: card.id)

        var changed = card
        changed.baseUrl = "https://example.com/v1"
        changed.apiKey = "sk-carried-over-from-old-host"
        _ = try await store.upsert(card: changed)

        XCTAssertNil(try secrets.secret(for: changed.keyAccount))
        let carriedKey = try await store.apiKey(for: changed.id)
        XCTAssertNil(carriedKey)
        XCTAssertNil(try secrets.secret(for: card.keyAccount))
        let text = try workspace.readString("llm_config.json")
        XCTAssertFalse(text.contains("sk-carried-over-from-old-host"))
        XCTAssertFalse(text.contains("sk-old-host"))
    }

    func testBulkSaveRemovingCardDeletesItsKeyAndOrphanItem() async throws {
        let workspace = try TestWorkspace()
        let secrets = InMemorySecretStore()
        let store = LlmProviderStore(root: workspace.dataRoot, secretStore: secrets)
        var configuration = try await store.load()
        let first = configuration.store.cards[0]
        var second = LlmModelCard(
            id: "card_glm",
            label: "GLM",
            baseUrl: "https://opencode.ai/inference/openai/v1/",
            authHeaderType: .bearer,
            model: "glm-5.3-flash"
        )
        let upserted = try await store.upsert(card: second)
        second = upserted.store.cards.first(where: { $0.id == "card_glm" }) ?? second
        try await store.setAPIKey("sk-first", for: first.id)
        try await store.setAPIKey("sk-second", for: second.id)
        XCTAssertEqual(try secrets.secret(for: second.keyAccount), "sk-second")

        var reduced = try await store.load()
        reduced.store.cards = reduced.store.cards.filter { $0.id == first.id }
        _ = try await store.save(reduced)

        XCTAssertNil(try secrets.secret(for: second.keyAccount))
        XCTAssertEqual(try secrets.secret(for: first.keyAccount), "sk-first")
        let reloaded = try await store.load()
        XCTAssertEqual(reloaded.store.cards.map(\.id), [first.id])
    }

    func testMutationRespectsFailClosedGateAndLeavesKeychainUntouched() async throws {
        let workspace = try TestWorkspace()
        let secrets = InMemorySecretStore()
        let store = LlmProviderStore(root: workspace.dataRoot, secretStore: secrets)
        let configuration = try await store.load()
        let card = configuration.store.cards[0]
        workspace.dataRoot.writeGate.block(reason: "newer data version")

        do {
            try await store.setAPIKey("sk-blocked", for: card.id)
            XCTFail("Expected write-blocked error")
        } catch let error as WriteBlockedError {
            XCTAssertTrue(error.reason.contains("newer"))
        }
        XCTAssertNil(try secrets.secret(for: card.keyAccount))
        XCTAssertFalse(try workspace.readString("llm_config.json").contains("sk-blocked"))
    }

    func testMutationRespectsHeldLease() async throws {
        let workspace = try TestWorkspace()
        let secrets = InMemorySecretStore()
        let store = LlmProviderStore(
            root: workspace.dataRoot,
            secretStore: secrets,
            leaseTimeout: 0.1
        )
        let configuration = try await store.load()
        let card = configuration.store.cards[0]
        try workspace.dataRoot.writeLease.acquire(owner: "other-writer", timeout: 0)
        defer { workspace.dataRoot.writeLease.release(owner: "other-writer") }

        do {
            try await store.setAPIKey("sk-lease", for: card.id)
            XCTFail("Expected lease timeout")
        } catch let error as WriteLeaseError {
            guard case let .timedOut(_, heldBy) = error else {
                return XCTFail("Wrong lease error: \(error)")
            }
            XCTAssertEqual(heldBy, "other-writer")
        }
        XCTAssertNil(try secrets.secret(for: card.keyAccount))
    }

    func testReadOnlyRootWithPlaintextKeysFailsWithoutMigrating() async throws {
        let workspace = try TestWorkspace()
        let secrets = InMemorySecretStore()
        try workspace.write(makeLlmConfigJSON(), to: "llm_config.json")
        workspace.dataRoot.writeGate.block(reason: "newer data version")
        let store = LlmProviderStore(root: workspace.dataRoot, secretStore: secrets)

        do {
            _ = try await store.load()
            XCTFail("Expected a read-only plaintext-key error")
        } catch let error as LlmProviderStoreError {
            XCTAssertEqual(error, .readOnlyPlaintextKeys)
        }
        XCTAssertTrue(try secrets.snapshot().isEmpty)
        // The existing file is not rewritten by a fail-closed read.
        XCTAssertTrue(try workspace.readString("llm_config.json").contains("sk-test123456789012345678901234"))
    }

    // MARK: - Load transaction

    private enum ProviderTestError: Error {
        case forcedWriteFailure
    }

    func testLoadWithHeldLeaseAndPlaintextKeyDoesNotMigrate() async throws {
        let workspace = try TestWorkspace()
        let secrets = InMemorySecretStore()
        try workspace.write(makeLlmConfigJSON(), to: "llm_config.json")
        let store = LlmProviderStore(
            root: workspace.dataRoot,
            secretStore: secrets,
            leaseTimeout: 0.1
        )
        try workspace.dataRoot.writeLease.acquire(owner: "other-load", timeout: 0)
        defer { workspace.dataRoot.writeLease.release(owner: "other-load") }

        do {
            _ = try await store.load()
            XCTFail("Expected lease timeout")
        } catch let error as WriteLeaseError {
            guard case let .timedOut(_, heldBy) = error else {
                return XCTFail("Wrong error \(error)")
            }
            XCTAssertEqual(heldBy, "other-load")
        }
        XCTAssertTrue(try secrets.snapshot().isEmpty)
        XCTAssertTrue(try workspace.readString("llm_config.json").contains("sk-test123456789012345678901234"))
    }

    func testConcurrentLoadsRaceDefaultCreationSafely() async throws {
        let workspace = try TestWorkspace()
        let storeA = LlmProviderStore(root: workspace.dataRoot, secretStore: InMemorySecretStore())
        let storeB = LlmProviderStore(root: workspace.dataRoot, secretStore: InMemorySecretStore())

        async let first = storeA.load()
        async let second = storeB.load()
        let (a, b) = try await (first, second)

        XCTAssertEqual(a.store.cards.map(\.id), ["card_deepseek"])
        XCTAssertEqual(b.store.cards.map(\.id), ["card_deepseek"])
        XCTAssertTrue(try workspace.readString("llm_config.json").contains("\"card_deepseek\""))
        let canonical = try LlmStore.decode(workspace.readJSON("llm_config.json").serializedData())
        XCTAssertEqual(canonical.cards.count, 1)
    }

    func testPersistenceFailureAfterMigrationRollsBackKeys() async throws {
        let workspace = try TestWorkspace()
        let secrets = InMemorySecretStore()
        try workspace.write(makeLlmConfigJSON(), to: "llm_config.json")
        let store = LlmProviderStore(
            root: workspace.dataRoot,
            secretStore: secrets,
            willPersist: { _ in throw ProviderTestError.forcedWriteFailure }
        )

        do {
            _ = try await store.load()
            XCTFail("Expected forced persistence failure")
        } catch is ProviderTestError {
            // expected
        }
        XCTAssertTrue(try secrets.snapshot().isEmpty)
        // The plaintext file was not sanitized because the write failed.
        XCTAssertTrue(try workspace.readString("llm_config.json").contains("sk-test123456789012345678901234"))
    }

    func testConfigChangedUnderLeaseAbortsInsteadOfWritingStaleBytes() async throws {
        let workspace = try TestWorkspace()
        let secrets = InMemorySecretStore()
        try workspace.write(makeLlmConfigJSON(), to: "llm_config.json")
        let external = JSONValue.object([
            JSONMember(key: "version", value: .number("2")),
            JSONMember(key: "activeId", value: .string("card_external")),
            JSONMember(key: "cards", value: .array([
                .object([
                    JSONMember(key: "id", value: .string("card_external")),
                    JSONMember(key: "label", value: .string("External")),
                    JSONMember(key: "baseUrl", value: .string("https://example.com")),
                    JSONMember(key: "authHeaderType", value: .string("bearer")),
                    JSONMember(key: "model", value: .string("external")),
                ]),
            ])),
        ]).serializedData()

        let store = LlmProviderStore(
            root: workspace.dataRoot,
            secretStore: secrets,
            willPersist: { url in
                try external.write(to: url, options: .atomic)
            }
        )

        do {
            _ = try await store.load()
            XCTFail("Expected configuration-changed error")
        } catch let error as LlmProviderStoreError {
            XCTAssertEqual(error, .configurationChanged)
        }
        XCTAssertTrue(try secrets.snapshot().isEmpty)
        let data = try Data(contentsOf: workspace.url("llm_config.json"))
        XCTAssertEqual(data, external)
    }

    func testResolvedCardWithUnknownNonNilIDThrows() async throws {
        let workspace = try TestWorkspace()
        let secrets = InMemorySecretStore()
        let store = LlmProviderStore(root: workspace.dataRoot, secretStore: secrets)
        _ = try await store.load()
        try await store.setAPIKey("sk-active", for: "card_deepseek")

        do {
            _ = try await store.resolvedCard(id: "card_missing")
            XCTFail("Expected unknown card")
        } catch let error as LlmProviderStoreError {
            XCTAssertEqual(error, .unknownCard("card_missing"))
        }
        let active = try await store.resolvedCard(id: nil)
        XCTAssertEqual(active.card.id, "card_deepseek")
    }

    func testAdoptImportedKeyRejectsEndpointAndProviderMismatch() async throws {
        let workspace = try TestWorkspace()
        let secrets = InMemorySecretStore()
        let local = LlmModelCard(
            id: "card_local",
            label: "Local",
            provider: "openai_compatible",
            baseUrl: "https://api.deepseek.com",
            authHeaderType: .bearer,
            model: "deepseek-flash"
        )
        let differentEndpoint = LlmModelCard(
            id: "card_imported",
            label: "Imported",
            provider: "openai_compatible",
            baseUrl: "https://example.com",
            authHeaderType: .bearer,
            model: "deepseek-flash"
        )
        var store = LlmStore(version: 2, activeId: local.id, cards: [local, differentEndpoint])
        try workspace.write(store.sanitizedJSON.serializedData(), to: "llm_config.json")
        try secrets.setSecret("local-key", for: local.keyAccount)
        try secrets.setSecret("imported-key", for: differentEndpoint.keyAccount)
        let providerStore = LlmProviderStore(root: workspace.dataRoot, secretStore: secrets)
        _ = try await providerStore.load()

        do {
            _ = try await providerStore.adoptImportedKey(
                localCardId: local.id,
                importedCardId: differentEndpoint.id
            )
            XCTFail("Expected endpoint mismatch")
        } catch let error as LlmProviderStoreError {
            guard case .invalidEndpoint = error else { return XCTFail("Wrong error \(error)") }
        }
        XCTAssertEqual(try secrets.secret(for: local.keyAccount), "local-key")
        XCTAssertEqual(try secrets.secret(for: differentEndpoint.keyAccount), "imported-key")

        // Same endpoint, incompatible provider.
        var incompatible = differentEndpoint
        incompatible.baseUrl = local.baseUrl
        incompatible.provider = "lmstudio"
        store.cards = [local, incompatible]
        try workspace.write(store.sanitizedJSON.serializedData(), to: "llm_config.json")
        do {
            _ = try await providerStore.adoptImportedKey(
                localCardId: local.id,
                importedCardId: incompatible.id
            )
            XCTFail("Expected provider mismatch")
        } catch let error as LlmProviderStoreError {
            guard case .incompatibleProvider = error else { return XCTFail("Wrong error \(error)") }
        }
    }
}
