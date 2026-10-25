import XCTest
@testable import CourseDeckCore

final class PromptCatalogTests: XCTestCase {
    private func manifestJSON(
        required: [String] = ["summary"],
        entries: [PromptManifestEntry],
        counts: [String: PromptQuestionCounts] = [
            "test": PromptQuestionCounts(multipleChoice: 6, fillInTheBlank: 4, total: 10),
            "course_test": PromptQuestionCounts(multipleChoice: 12, multiPart: 4, total: 16),
            "unit_test": PromptQuestionCounts(multipleChoice: 8, fillInTheBlank: 2, shortAnswer: 2, total: 12),
            "popquiz": PromptQuestionCounts(multipleChoice: 4, fillInTheBlank: 2, total: 6),
        ]
    ) -> PromptManifestDocument {
        PromptManifestDocument(
            manifestVersion: 1,
            requiredPrompts: required,
            optionalProtected: ["lesson", "test_kica"],
            excluded: ["mcp_prompt_instructions.md"],
            expectedQuestionCounts: counts,
            prompts: entries
        )
    }

    private func writeManifest(_ manifest: PromptManifestDocument, to directory: URL) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try manifest.json.serializedData().write(to: directory.appendingPathComponent("prompt-manifest.json"))
    }

    func testCatalogAndManifestAgreeOnCounts() throws {
        XCTAssertEqual(PromptCatalog.requiredIDs.count, 10)
        XCTAssertTrue(PromptCatalog.requiredIDs.contains("test"))
        XCTAssertTrue(PromptCatalog.requiredIDs.contains("course_cheatsheet"))
        XCTAssertFalse(PromptCatalog.requiredIDs.contains("lesson"))
        XCTAssertFalse(PromptCatalog.requiredIDs.contains("test_kica"))
        XCTAssertEqual(PromptCatalog.expectedQuestionCounts["test"]?.multipleChoice, 6)
        XCTAssertEqual(PromptCatalog.expectedQuestionCounts["test"]?.fillInTheBlank, 4)
        XCTAssertEqual(PromptCatalog.expectedQuestionCounts["course_test"]?.total, 16)
        XCTAssertEqual(PromptCatalog.expectedQuestionCounts["unit_test"]?.total, 12)
        XCTAssertEqual(PromptCatalog.expectedQuestionCounts["popquiz"]?.total, 6)
        XCTAssertTrue(PromptCatalog.isProtected("unit_assignments"))
        XCTAssertTrue(PromptCatalog.isProtected("test_kica"))
    }

    func testManifestValidationAcceptsReviewedStaging() throws {
        let workspace = try TestWorkspace()
        let directory = workspace.baseURL.appendingPathComponent("Prompts", isDirectory: true)
        let content = "# Summary Prompt\n\nReviewed content."
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try Data(content.utf8).write(to: directory.appendingPathComponent("summary.md"))
        let entry = PromptManifestEntry(
            id: "summary",
            file: "summary.md",
            source: "active",
            sha256: SHA256.hex(content),
            bytes: content.utf8.count
        )
        let manifest = manifestJSON(entries: [entry])
        try writeManifest(manifest, to: directory)

        let loaded = try XCTUnwrap(try PromptManifestDocument.loadBundled(from: directory))
        let result = loaded.validate(directory: directory)
        XCTAssertTrue(result.isValid, "issues: \(result.issues)")
        XCTAssertEqual(result.checkedPrompts, 1)
    }

    func testManifestValidationDetectsMissingEmptyAndHashDrift() throws {
        let workspace = try TestWorkspace()
        let directory = workspace.baseURL.appendingPathComponent("Prompts", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

        let missingEntry = PromptManifestEntry(id: "summary", file: "summary.md", sha256: "abc")
        let missing = manifestJSON(entries: [missingEntry]).validate(directory: directory)
        XCTAssertTrue(missing.issues.contains { $0.code == "missingFile" })

        try Data("   \n".utf8).write(to: directory.appendingPathComponent("summary.md"))
        let empty = manifestJSON(entries: [missingEntry]).validate(directory: directory)
        XCTAssertTrue(empty.issues.contains { $0.code == "emptyFile" })

        let content = "# Summary\n\nChanged after review."
        try Data(content.utf8).write(to: directory.appendingPathComponent("summary.md"))
        let staleEntry = PromptManifestEntry(
            id: "summary",
            file: "summary.md",
            sha256: SHA256.hex("different"),
            bytes: content.utf8.count
        )
        let drifted = manifestJSON(entries: [staleEntry]).validate(directory: directory)
        XCTAssertTrue(drifted.issues.contains { $0.code == "hashMismatch" })
    }

    func testManifestValidationDetectsCountMismatchAndExcludedFiles() throws {
        let workspace = try TestWorkspace()
        let directory = workspace.baseURL.appendingPathComponent("Prompts", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let content = "# Summary\n\nBody."
        try Data(content.utf8).write(to: directory.appendingPathComponent("summary.md"))
        try Data("excluded".utf8).write(to: directory.appendingPathComponent("mcp_prompt_instructions.md"))
        try FileManager.default.createDirectory(at: directory.appendingPathComponent("backup"), withIntermediateDirectories: true)

        let entry = PromptManifestEntry(id: "summary", file: "summary.md", sha256: SHA256.hex(content))
        let broken = manifestJSON(
            entries: [entry],
            counts: [
                "test": PromptQuestionCounts(multipleChoice: 6, fillInTheBlank: 4, total: 10),
                "course_test": PromptQuestionCounts(multipleChoice: 12, multiPart: 3, total: 16),
                "unit_test": PromptQuestionCounts(multipleChoice: 8, fillInTheBlank: 2, shortAnswer: 2, total: 12),
                "popquiz": PromptQuestionCounts(multipleChoice: 4, fillInTheBlank: 2, total: 6),
            ]
        )
        let result = broken.validate(directory: directory)
        XCTAssertTrue(result.issues.contains { $0.code == "countMismatch" })
        XCTAssertTrue(result.issues.contains { $0.code == "excludedFilePresent" })
        XCTAssertTrue(result.issues.contains { $0.code == "backupDirectoryPresent" })
    }

    func testManifestRequiresExpectedCountsForGeneratedTests() throws {
        let workspace = try TestWorkspace()
        let directory = workspace.baseURL.appendingPathComponent("Prompts", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let manifest = PromptManifestDocument(
            requiredPrompts: ["summary"],
            expectedQuestionCounts: [:],
            prompts: []
        )
        let result = manifest.validate(directory: directory)
        XCTAssertTrue(result.issues.contains { $0.code == "missingExpectedCounts" })
    }

    func testManifestRejectsReviewedCountRegressionEvenWhenSumsMatch() throws {
        let workspace = try TestWorkspace()
        let directory = workspace.baseURL.appendingPathComponent("Prompts", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let content = "# Summary\n\nBody."
        try Data(content.utf8).write(to: directory.appendingPathComponent("summary.md"))
        let entry = PromptManifestEntry(id: "summary", file: "summary.md", sha256: SHA256.hex(content))
        var counts = PromptCatalog.expectedQuestionCounts
        // Internally consistent 5+4=9, but the reviewed schema is 6+4=10.
        counts["test"] = PromptQuestionCounts(multipleChoice: 5, fillInTheBlank: 4, total: 9)
        let manifest = manifestJSON(entries: [entry], counts: counts)
        let result = manifest.validate(directory: directory)
        XCTAssertTrue(
            result.issues.contains { $0.code == "countMismatch" && $0.promptID == "test" },
            "issues: \(result.issues)"
        )
    }

    func testRepositoryValidatesBundledStagingManifest() async throws {
        let workspace = try TestWorkspace()
        let bundled = workspace.baseURL.appendingPathComponent("BundledPrompts", isDirectory: true)
        try FileManager.default.createDirectory(at: bundled, withIntermediateDirectories: true)
        let content = "# Summary Prompt\n\nReviewed summary."
        try Data(content.utf8).write(to: bundled.appendingPathComponent("summary.md"))
        let entry = PromptManifestEntry(
            id: "summary",
            file: "summary.md",
            sha256: SHA256.hex(content),
            bytes: content.utf8.count
        )
        try manifestJSON(required: ["summary"], entries: [entry])
            .json.serializedData()
            .write(to: bundled.appendingPathComponent("prompt-manifest.json"))

        let repository = PromptRepository(root: workspace.dataRoot, bundledDirectory: bundled)
        let validation = try await repository.stagingValidation()
        XCTAssertEqual(validation?.isValid, true, "issues: \(String(describing: validation?.issues))")
    }

    // MARK: - Provenance

    func testProvenanceTracksSeedEditRestoreAndImport() async throws {
        let workspace = try TestWorkspace()
        let bundled = workspace.baseURL.appendingPathComponent("BundledPrompts", isDirectory: true)
        try FileManager.default.createDirectory(at: bundled, withIntermediateDirectories: true)
        let bundledContent = "# Summary Prompt\n\nBundled summary."
        try Data(bundledContent.utf8).write(to: bundled.appendingPathComponent("summary.md"))

        let provenance = PromptProvenanceStore(root: workspace.dataRoot)
        let repository = PromptRepository(
            root: workspace.dataRoot,
            bundledDirectory: bundled,
            provenance: provenance
        )

        let seeded = try await repository.prompt(id: "summary")
        XCTAssertEqual(seeded?.content, bundledContent)
        var record = await provenance.record(id: "summary")
        XCTAssertEqual(record?.source, .seeded)
        XCTAssertEqual(record?.bundledSHA256, SHA256.hex(bundledContent))
        XCTAssertEqual(record?.activeSHA256, SHA256.hex(bundledContent))

        try await repository.save(id: "summary", content: "# Mine\n\nEdited.")
        record = await provenance.record(id: "summary")
        XCTAssertEqual(record?.source, .userEdited)
        let edited = await provenance.isUserEdited(id: "summary")
        XCTAssertTrue(edited)

        let inventory = try await repository.inventory()
        let entry = try XCTUnwrap(inventory.first(where: { $0.prompt.id == "summary" }))
        XCTAssertTrue(entry.isUserEdited)
        XCTAssertEqual(entry.bundledSHA256, SHA256.hex(bundledContent))

        _ = try await repository.restoreDefault(id: "summary")
        record = await provenance.record(id: "summary")
        XCTAssertEqual(record?.source, .bundled)

        try await provenance.recordImported(
            id: "summary",
            content: "# Imported\n\nFrom desktop.",
            bundledContent: bundledContent
        )
        record = await provenance.record(id: "summary")
        XCTAssertEqual(record?.source, .imported)
        let importedIsEdited = await provenance.isUserEdited(id: "summary")
        XCTAssertTrue(importedIsEdited)

        let persisted = try workspace.readJSON("prompt-provenance.json")
        XCTAssertEqual(persisted["records"]?["summary"]?["source"]?.stringValue, "imported")
    }

    func testBundledRefreshOnlyUpdatesUntouchedSeededPrompts() async throws {
        let workspace = try TestWorkspace()
        let bundled = workspace.baseURL.appendingPathComponent("BundledPrompts", isDirectory: true)
        try FileManager.default.createDirectory(at: bundled, withIntermediateDirectories: true)
        let promptURL = bundled.appendingPathComponent("summary.md")
        let v1 = "# Summary Prompt\n\nVersion one."
        try Data(v1.utf8).write(to: promptURL)

        let provenance = PromptProvenanceStore(root: workspace.dataRoot)
        let repository = PromptRepository(
            root: workspace.dataRoot,
            bundledDirectory: bundled,
            provenance: provenance
        )
        _ = try await repository.prompt(id: "summary")

        // App update: untouched seeded prompt follows the new bundled default.
        let v2 = "# Summary Prompt\n\nVersion two with new guidance."
        try Data(v2.utf8).write(to: promptURL)
        let refreshed = try await repository.refreshBundledDefaults()
        XCTAssertEqual(refreshed, ["summary"])
        XCTAssertEqual(try workspace.readString("prompts/summary.md"), v2)
        var record = await provenance.record(id: "summary")
        XCTAssertEqual(record?.source, .bundled)
        XCTAssertEqual(record?.activeSHA256, SHA256.hex(v2))

        // User edits win over later bundled versions.
        try await repository.save(id: "summary", content: "# Mine\n\nCustom guidance.")
        let v3 = "# Summary Prompt\n\nVersion three."
        try Data(v3.utf8).write(to: promptURL)
        let afterEdit = try await repository.refreshBundledDefaults()
        XCTAssertTrue(afterEdit.isEmpty)
        XCTAssertEqual(
            try workspace.readString("prompts/summary.md"),
            "# Mine\n\nCustom guidance."
        )

        // Imported prompts are preserved as well.
        let imported = "# Imported\n\nFrom the desktop."
        try workspace.write(imported, to: "prompts/summary.md")
        try await provenance.recordImported(id: "summary", content: imported, bundledContent: v3)
        let v4 = "# Summary Prompt\n\nVersion four."
        try Data(v4.utf8).write(to: promptURL)
        let afterImport = try await repository.refreshBundledDefaults()
        XCTAssertTrue(afterImport.isEmpty)
        XCTAssertEqual(try workspace.readString("prompts/summary.md"), imported)
        record = await provenance.record(id: "summary")
        XCTAssertEqual(record?.source, .imported)
    }

    func testProvenanceSurvivesCorruptFileByQuarantining() async throws {
        let workspace = try TestWorkspace()
        try workspace.write("{not json", to: "prompt-provenance.json")
        let provenance = PromptProvenanceStore(root: workspace.dataRoot)
        let records = await provenance.records()
        XCTAssertTrue(records.isEmpty)
        XCTAssertFalse(workspace.exists("prompt-provenance.json"))
        let quarantine = try FileManager.default.contentsOfDirectory(atPath: workspace.url(".quarantine").path)
        XCTAssertEqual(quarantine.count, 1)
    }
}
