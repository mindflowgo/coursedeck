import CoreGraphics
import Foundation
import ImageIO
import XCTest
import ZIPFoundation
@testable import CourseDeckCore

final class IngestionTests: XCTestCase {
    // MARK: - Fixtures

    private func makeCourse(
        _ workspace: TestWorkspace,
        id: String = "baf3m",
        unitTitle: String = "Unit 1",
        lessons: [String] = ["01.01"]
    ) throws {
        let manifest = CourseManifest(
            id: id,
            title: id.uppercased(),
            units: [
                CourseUnit(
                    number: 1,
                    title: unitTitle,
                    lessons: lessons.map { lesson in
                        let parts = lesson.split(separator: ".")
                        let unit = parts.first.map(String.init) ?? "1"
                        let number = parts.count > 1 ? String(parts[1]) : "1"
                        return CourseLesson(
                            id: lesson,
                            code: "\(id)_u1la\(number)",
                            title: "Lesson \(lesson)",
                            unitNumber: Int(unit) ?? 1,
                            lessonNumber: Int(number) ?? 1,
                            type: .lesson,
                            hasFull: true
                        )
                    }
                )
            ],
            updatedAt: "2026-01-01T00:00:00.000Z"
        )
        try workspace.write(manifest.encoded(), to: "courses/\(id)/meta.json")
        for lesson in lessons {
            try workspace.write("# Lesson \(lesson)\n", to: "courses/\(id)/\(lesson).lesson.md")
        }
    }

    private func makeZip(
        _ workspace: TestWorkspace,
        name: String,
        entries: [(String, Data)]
    ) throws -> URL {
        let url = workspace.baseURL.appendingPathComponent(name)
        try TestWorkspace.makeZip(
            entries: entries.map { (path: $0.0, data: $0.1) },
            at: url
        )
        return url
    }

    private func makePNG(width: Int, height: Int, red: CGFloat = 0.2) -> Data {
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        guard let context = CGContext(
            data: nil,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: colorSpace,
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else {
            XCTFail("Could not create a CGContext")
            return Data()
        }
        context.setFillColor(CGColor(red: red, green: 0.4, blue: 0.8, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        guard let image = context.makeImage() else {
            XCTFail("Could not create a CGImage")
            return Data()
        }
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(
            data,
            "public.png" as CFString,
            1,
            nil
        ) else {
            XCTFail("Could not create an image destination")
            return Data()
        }
        CGImageDestinationAddImage(destination, image, nil)
        XCTAssertTrue(CGImageDestinationFinalize(destination))
        return data as Data
    }

    private func lessonHTML(
        title: String,
        imageReference: String = "./assets/img/diagram.png",
        includeGoals: Bool = true
    ) -> String {
        """
        <!doctype html>
        <html>
        <head><title>\(title)</title></head>
        <body>
        <main id="mainContent">
        <h1>\(title)</h1>
        \(includeGoals ? """
        <div id="ilcLearningGoals">
          <h2>Learning Goals</h2>
          <ul><li>Add fractions</li></ul>
          <h2>Success Criteria</h2>
          <ul><li>Solve fraction problems</li></ul>
        </div>
        """ : "")
        <p>Read the <strong>diagram</strong> and answer.</p>
        <table>
          <thead><tr><th>Item</th><th align="right">Cost</th></tr></thead>
          <tbody>
            <tr><td>Notebook<br>Blue</td><td align="right">$1,500</td></tr>
          </tbody>
        </table>
        <div class="app-row-callout"><p>Think about the denominator.</p></div>
        <details class="suggested-answer"><summary>Suggested Answer</summary><p>Because the denominators differ.</p></details>
        <p><img src="\(imageReference)" alt="Diagram"></p>
        <p><a href="./assets/locker_docs/worksheet.pdf">Worksheet</a></p>
        </main>
        </body>
        </html>
        """
    }

    private func quotedPrintable(_ text: String) -> String {
        var output = ""
        for scalar in text.unicodeScalars {
            switch scalar {
            case "=": output += "=3D"
            case "<": output += "=3C"
            case ">": output += "=3E"
            default: output.unicodeScalars.append(scalar)
            }
        }
        return output
    }

    /// Creates a deflate-compressed ZIP, then rewrites the declared
    /// uncompressed size in both headers to `declaredSize`. The compressed
    /// stream still contains the full data, so extraction produces more bytes
    /// than the headers claim.
    private func makeDeflateZip(
        _ workspace: TestWorkspace,
        name: String,
        entryPath: String,
        data: Data,
        declaredSize: UInt32? = nil
    ) throws -> URL {
        let url = workspace.baseURL.appendingPathComponent(name)
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        let archive = try Archive(url: url, accessMode: .create)
        try archive.addEntry(
            with: entryPath,
            type: .file,
            uncompressedSize: Int64(data.count),
            compressionMethod: .deflate,
            provider: { position, size in
                let start = Int(position)
                let end = min(start + size, data.count)
                guard start < end else { return Data() }
                return data.subdata(in: start..<end)
            }
        )
        if let declaredSize {
            try patchDeclaredUncompressedSize(at: url, to: declaredSize)
        }
        return url
    }

    private func patchDeclaredUncompressedSize(at url: URL, to value: UInt32) throws {
        var data = try Data(contentsOf: url)
        var index = 0
        while index + 26 < data.count {
            if data[index] == 0x50, data[index + 1] == 0x4B {
                if data[index + 2] == 0x03, data[index + 3] == 0x04 {
                    writeUInt32(&data, at: index + 22, value: value)
                } else if data[index + 2] == 0x01, data[index + 3] == 0x02 {
                    writeUInt32(&data, at: index + 24, value: value)
                }
            }
            index += 1
        }
        try data.write(to: url)
    }

    private func writeUInt32(_ data: inout Data, at offset: Int, value: UInt32) {
        guard offset + 4 <= data.count else { return }
        data[offset] = UInt8(value & 0xFF)
        data[offset + 1] = UInt8((value >> 8) & 0xFF)
        data[offset + 2] = UInt8((value >> 16) & 0xFF)
        data[offset + 3] = UInt8((value >> 24) & 0xFF)
    }

    private func imageFiles(_ workspace: TestWorkspace) throws -> [String] {
        try FileManager.default.contentsOfDirectory(
            at: workspace.url("courses/baf3m/assets/img"),
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles]
        )
        .map(\.lastPathComponent)
        .filter { ["jpg", "jpeg", "png"].contains(($0 as NSString).pathExtension.lowercased()) }
        .sorted()
    }

    // MARK: - New course

    func testNewCourseValidationAndCreation() async throws {
        XCTAssertEqual(try CourseIngestor.validatedCourseCode(" BAF3M "), "baf3m")
        XCTAssertThrowsError(try CourseIngestor.validatedCourseCode(""))
        XCTAssertThrowsError(try CourseIngestor.validatedCourseCode("bad code"))
        XCTAssertThrowsError(try CourseIngestor.validatedCourseCode("../evil"))
        XCTAssertThrowsError(try CourseIngestor.validatedCourseCode("."))
        XCTAssertThrowsError(try CourseIngestor.validatedCourseCode(".."))

        let workspace = try TestWorkspace()
        let ingestor = CourseIngestor(root: workspace.dataRoot)
        let manifest = try await ingestor.createCourse(
            NewCourseRequest(code: "BAF3M", title: "  Financial Accounting  ")
        )
        XCTAssertEqual(manifest.id, "baf3m")
        XCTAssertEqual(manifest.title, "Financial Accounting")
        XCTAssertEqual(manifest.grade, "")
        XCTAssertEqual(manifest.level, "")
        XCTAssertEqual(manifest.description, "")
        XCTAssertTrue(manifest.units.isEmpty)
        XCTAssertTrue(workspace.exists("courses/baf3m/meta.json"))
        XCTAssertTrue(workspace.exists("courses/baf3m/_backup"))

        do {
            _ = try await ingestor.createCourse(NewCourseRequest(code: "baf3m"))
            XCTFail("An existing course must be rejected without confirmation")
        } catch let error as IngestError {
            XCTAssertEqual(error, .courseExists("baf3m"))
        }

        let reused = try await ingestor.createCourse(
            NewCourseRequest(code: "baf3m", title: "Ignored", confirmExisting: true)
        )
        XCTAssertEqual(reused.title, "Financial Accounting")

        let noTitle = try await CourseIngestor(root: workspace.dataRoot).createCourse(
            NewCourseRequest(code: "mcr3u")
        )
        XCTAssertEqual(noTitle.title, "MCR3U")
    }

    // MARK: - ZIP

    func testZipIngestConvertsHTMLAssetsAndManifest() async throws {
        let workspace = try TestWorkspace()
        try makeCourse(workspace)
        let png = makePNG(width: 64, height: 32)
        let svg = Data(#"<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16"/></svg>"#.utf8)
        let package = try makeZip(
            workspace,
            name: "baf3m_u1la2.zip",
            entries: [
                ("lessons/baf3m_u1la2.html", Data(lessonHTML(title: "Lesson 1.2: Fractions").utf8)),
                ("assets/img/diagram.png", png),
                ("assets/icons/icon.svg", svg),
                ("assets/locker_docs/worksheet.pdf", Data("%PDF-1.4 test".utf8)),
            ]
        )

        let ingestor = CourseIngestor(root: workspace.dataRoot)
        let result = try await ingestor.ingest(courseId: "baf3m", packages: [package])

        XCTAssertEqual(result.newLessonsAdded, ["01.02"])
        XCTAssertEqual(result.totalLessons, 2)
        XCTAssertTrue(result.skippedPackages.isEmpty)
        XCTAssertTrue(workspace.exists("courses/baf3m/_backup/baf3m_u1la2.zip"))
        XCTAssertTrue(workspace.exists("courses/baf3m/01.02.lesson.md"))
        XCTAssertTrue(workspace.exists("courses/baf3m/01.02.summary.md"))
        XCTAssertTrue(workspace.exists("courses/baf3m/01.02.cheatsheet.md"))
        XCTAssertTrue(workspace.exists("courses/baf3m/01.02.test.md"))
        XCTAssertTrue(workspace.exists("courses/baf3m/assets/img/diagram.png"))
        XCTAssertTrue(workspace.exists("courses/baf3m/assets/icons/icon.svg"))
        XCTAssertTrue(workspace.exists("courses/baf3m/assets/locker_docs/worksheet.pdf"))

        let markdown = try workspace.readString("courses/baf3m/01.02.lesson.md")
        let frontmatter = try FrontmatterDocument(parsing: markdown)
        XCTAssertEqual(frontmatter.value(forKey: "title")?.stringValue, "Lesson 1.2: Fractions")
        XCTAssertEqual(frontmatter.value(forKey: "activityCode")?.stringValue, "baf3m_u1la2")
        XCTAssertEqual(frontmatter.value(forKey: "courseId")?.stringValue, "baf3m")
        XCTAssertEqual(frontmatter.value(forKey: "unit")?.stringValue, "Unit 1")
        XCTAssertEqual(frontmatter.value(forKey: "unitNumber")?.stringValue, "1")
        XCTAssertEqual(frontmatter.value(forKey: "lessonNumber")?.stringValue, "2")
        XCTAssertEqual(frontmatter.value(forKey: "type")?.stringValue, "lesson")

        XCTAssertTrue(markdown.contains("# Lesson 1.2: Fractions"))
        XCTAssertTrue(markdown.contains("| Item | Cost |"))
        XCTAssertTrue(markdown.contains("| --- | ---: |"))
        XCTAssertTrue(markdown.contains("Notebook<br>Blue"))
        XCTAssertTrue(markdown.contains("$1,500"))
        XCTAssertTrue(markdown.contains("<details class=\"suggested-answer\">"))
        XCTAssertTrue(markdown.contains("<summary>Suggested Answer</summary>"))
        XCTAssertTrue(markdown.contains("> [!TIP]"))
        XCTAssertTrue(markdown.contains("> [!NOTE]"))
        XCTAssertTrue(markdown.contains("![Diagram](./assets/img/diagram.png)"))
        XCTAssertTrue(markdown.contains("[Worksheet](./assets/locker_docs/worksheet.pdf)"))

        let loadedManifest = try await ingestorCourse(workspace)
        let manifest = try XCTUnwrap(loadedManifest)
        let lesson = try XCTUnwrap(manifest.lesson(id: "01.02"))
        XCTAssertEqual(lesson.title, "Lesson 1.2: Fractions")
        XCTAssertEqual(lesson.unitNumber, 1)
        XCTAssertEqual(lesson.lessonNumber, 2)
        XCTAssertTrue(lesson.hasFull)
        XCTAssertTrue(lesson.hasSummary)
        XCTAssertTrue(lesson.hasCheatsheet)
        XCTAssertTrue(lesson.hasTest)
    }

    private func ingestorCourse(_ workspace: TestWorkspace) async throws -> CourseManifest? {
        try await CourseRepository(root: workspace.dataRoot).course(courseId: "baf3m")
    }

    // MARK: - MHTML

    func testMHTMLIngestDecodesQuotedPrintableAndCIDAssets() async throws {
        let workspace = try TestWorkspace()
        try makeCourse(workspace)
        let png = makePNG(width: 80, height: 40, red: 0.8)
        let boundary = "----CourseDeckBoundary"
        let html = lessonHTML(
            title: "MHTML Lesson",
            imageReference: "cid:diagram@coursedeck"
        )
        let mhtml = """
        From: <Saved by Blink>
        MIME-Version: 1.0
        Content-Type: multipart/related; type="text/html"; boundary="\(boundary)"

        --\(boundary)
        Content-Type: text/html; charset="utf-8"
        Content-Transfer-Encoding: quoted-printable
        Content-Location: https://example.com/lessons/baf3m_u1la3.html

        \(quotedPrintable(html))
        --\(boundary)
        Content-Type: image/png
        Content-Transfer-Encoding: base64
        Content-Location: https://example.com/lessons/baf3m_u1la3_files/diagram.png
        Content-ID: <diagram@coursedeck>

        \(png.base64EncodedString())
        --\(boundary)--
        """
        let package = workspace.baseURL.appendingPathComponent("baf3m_u1la3.mhtml")
        try Data(mhtml.utf8).write(to: package)

        let ingestor = CourseIngestor(root: workspace.dataRoot)
        let result = try await ingestor.ingest(courseId: "baf3m", packages: [package])
        XCTAssertEqual(result.newLessonsAdded, ["01.03"])
        XCTAssertTrue(workspace.exists("courses/baf3m/assets/img/diagram.png"))
        XCTAssertEqual(
            try Data(contentsOf: workspace.url("courses/baf3m/assets/img/diagram.png")),
            png
        )
        let markdown = try workspace.readString("courses/baf3m/01.03.lesson.md")
        XCTAssertTrue(markdown.contains("![Diagram](./assets/img/diagram.png)"))
        XCTAssertTrue(markdown.contains("# MHTML Lesson"))
        XCTAssertTrue(markdown.contains("| Item | Cost |"))
    }

    // MARK: - Standalone HTML

    func testStandaloneHTMLWithCompanionFolder() async throws {
        let workspace = try TestWorkspace()
        try makeCourse(workspace)
        let folder = workspace.baseURL.appendingPathComponent("Lesson 1.4_files", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let png = makePNG(width: 48, height: 24, red: 0.1)
        try png.write(to: folder.appendingPathComponent("photo.png"))

        let htmlURL = workspace.baseURL.appendingPathComponent("Lesson 1.4.html")
        try Data(lessonHTML(
            title: "Lesson 1.4: Ratios",
            imageReference: "Lesson 1.4_files/photo.png"
        ).utf8).write(to: htmlURL)

        let ingestor = CourseIngestor(root: workspace.dataRoot)
        let result = try await ingestor.ingest(courseId: "baf3m", packages: [htmlURL])
        XCTAssertEqual(result.newLessonsAdded, ["01.04"])
        let backupContents = (try? FileManager.default.contentsOfDirectory(
            atPath: workspace.url("courses/baf3m/_backup").path
        )) ?? []
        let companionContents = (try? FileManager.default.contentsOfDirectory(
            atPath: workspace.url("courses/baf3m/_backup/Lesson 1.4_files").path
        )) ?? []
        XCTAssertTrue(
            workspace.exists("courses/baf3m/assets/img/photo.png"),
            "backup: \(backupContents), companion: \(companionContents), warnings: \(result.warnings)"
        )
        let markdown = try workspace.readString("courses/baf3m/01.04.lesson.md")
        XCTAssertTrue(markdown.contains("![Diagram](./assets/img/photo.png)"))
    }

    func testStandaloneHTMLWithSiblingAssetsFolder() async throws {
        let workspace = try TestWorkspace()
        try makeCourse(workspace)
        let assets = workspace.baseURL.appendingPathComponent("assets", isDirectory: true)
        try FileManager.default.createDirectory(at: assets, withIntermediateDirectories: true)
        try makePNG(width: 40, height: 20).write(to: assets.appendingPathComponent("photo.png"))
        let htmlURL = workspace.baseURL.appendingPathComponent("Lesson 1.5.html")
        try Data(lessonHTML(
            title: "Lesson 1.5: Percents",
            imageReference: "assets/photo.png"
        ).utf8).write(to: htmlURL)

        let ingestor = CourseIngestor(root: workspace.dataRoot)
        let result = try await ingestor.ingest(courseId: "baf3m", packages: [htmlURL])
        XCTAssertEqual(result.newLessonsAdded, ["01.05"])
        XCTAssertTrue(workspace.exists("courses/baf3m/assets/img/photo.png"))
        XCTAssertTrue(
            try workspace.readString("courses/baf3m/01.05.lesson.md")
                .contains("![Diagram](./assets/img/photo.png)")
        )
    }

    // MARK: - Manifest merge

    func testManifestMergePreservesExistingLessonsWithoutBackup() async throws {
        let workspace = try TestWorkspace()
        try makeCourse(workspace, unitTitle: "Fractions Unit", lessons: ["01.01", "01.02"])
        let package = try makeZip(
            workspace,
            name: "baf3m_u1la3.zip",
            entries: [("lessons/baf3m_u1la3.html", Data(lessonHTML(title: "Lesson 1.3").utf8))]
        )

        let ingestor = CourseIngestor(root: workspace.dataRoot)
        _ = try await ingestor.ingest(courseId: "baf3m", packages: [package])
        let firstLoad = try await ingestorCourse(workspace)
        var manifest = try XCTUnwrap(firstLoad)
        XCTAssertEqual(manifest.units.count, 1)
        XCTAssertEqual(manifest.units[0].title, "Fractions Unit")
        XCTAssertEqual(manifest.allLessons.map(\.id), ["01.01", "01.02", "01.03"])

        // Default desktop backups exclude `_backup/`; re-ingesting with no
        // packages must not drop existing lessons or units.
        try FileManager.default.removeItem(at: workspace.url("courses/baf3m/_backup"))
        let empty = try await ingestor.ingest(courseId: "baf3m", packages: [])
        let secondLoad = try await ingestorCourse(workspace)
        manifest = try XCTUnwrap(secondLoad)
        XCTAssertEqual(manifest.allLessons.map(\.id), ["01.01", "01.02", "01.03"])
        XCTAssertEqual(manifest.units[0].title, "Fractions Unit")
        XCTAssertTrue(empty.warnings.contains { $0.contains("No lesson packages were found") })
    }

    // MARK: - Incremental preservation

    func testIncrementalPreservesExistingLessonAndSnapshotsOnOverwrite() async throws {
        let workspace = try TestWorkspace()
        try makeCourse(workspace, lessons: ["01.01", "01.02"])
        let custom = """
        ---
        title: My Custom Lesson
        activityCode: custom_code
        courseId: baf3m
        unit: Unit 1
        unitNumber: 1
        lessonNumber: 2
        type: lesson
        savedAt: 2026-01-01
        ---

        # My Custom Lesson

        Hand-edited content.
        """
        try workspace.write(custom, to: "courses/baf3m/01.02.lesson.md")
        let package = try makeZip(
            workspace,
            name: "baf3m_u1la2.zip",
            entries: [("lessons/baf3m_u1la2.html", Data(lessonHTML(title: "Imported 1.2").utf8))]
        )

        let ingestor = CourseIngestor(root: workspace.dataRoot)
        let preserved = try await ingestor.ingest(courseId: "baf3m", packages: [package])
        XCTAssertEqual(preserved.preservedLessons, ["01.02"])
        XCTAssertEqual(
            try workspace.readString("courses/baf3m/01.02.lesson.md"),
            custom
        )
        let loaded = try await ingestorCourse(workspace)
        var manifest = try XCTUnwrap(loaded)
        XCTAssertEqual(manifest.lesson(id: "01.02")?.title, "My Custom Lesson")

        let overwritten = try await ingestor.ingest(
            courseId: "baf3m",
            packages: [package],
            options: IngestOptions(overwriteExisting: true)
        )
        XCTAssertEqual(overwritten.overwrittenLessons, ["01.02"])
        XCTAssertTrue(workspace.exists("courses/baf3m/01.02.lesson.md.bak"))
        let replaced = try workspace.readString("courses/baf3m/01.02.lesson.md")
        XCTAssertTrue(replaced.contains("# Imported 1.2"))
        XCTAssertEqual(
            try FrontmatterDocument(parsing: replaced).value(forKey: "title")?.stringValue,
            "Imported 1.2"
        )
        let backup = try workspace.readString("courses/baf3m/01.02.lesson.md.bak")
        XCTAssertTrue(backup.contains("My Custom Lesson"))
    }

    // MARK: - USERNOTE preservation

    func testOverwritePreservesUserNotesInLessonAndSummary() async throws {
        let workspace = try TestWorkspace()
        try makeCourse(workspace, lessons: ["01.01", "01.02"])
        let lessonWithNote = """
        ---
        title: Old Title
        activityCode: old_code
        courseId: baf3m
        unit: Unit 1
        unitNumber: 1
        lessonNumber: 2
        type: lesson
        savedAt: 2026-01-01
        ---

        # Old Title

        The denominator must match.

        > [!USERNOTE] Why?
        > <!-- target: "The denominator must match." -->
        > Because fractions need a common denominator.
        """
        try workspace.write(lessonWithNote, to: "courses/baf3m/01.02.lesson.md")

        let summaryWithNote = """
        ---
        prompt: ""
        type: summary
        version: 1
        updatedAt: 2026-01-01
        ---

        # Summary: Old Title

        Summary body.

        > [!USERNOTE] Remember
        > <!-- target: "Summary body." -->
        > Keep this note.
        """
        try workspace.write(summaryWithNote, to: "courses/baf3m/01.02.summary.md")

        let package = try makeZip(
            workspace,
            name: "baf3m_u1la2.zip",
            entries: [("lessons/baf3m_u1la2.html", Data(lessonHTML(title: "Imported 1.2").utf8))]
        )
        let result = try await CourseIngestor(root: workspace.dataRoot).ingest(
            courseId: "baf3m",
            packages: [package],
            options: IngestOptions(overwriteExisting: true)
        )

        let lesson = try workspace.readString("courses/baf3m/01.02.lesson.md")
        XCTAssertTrue(lesson.contains("# Imported 1.2"))
        XCTAssertTrue(lesson.contains("> [!USERNOTE] Why?"))
        XCTAssertTrue(lesson.contains("Because fractions need a common denominator."))
        XCTAssertFalse(result.warnings.contains { $0.contains("could not be preserved") })

        let summary = try workspace.readString("courses/baf3m/01.02.summary.md")
        XCTAssertTrue(summary.contains("# Summary: Imported 1.2"))
        XCTAssertTrue(summary.contains("> [!USERNOTE] Remember"))
        XCTAssertTrue(summary.contains("Keep this note."))
    }

    // MARK: - Manifest field preservation

    func testLessonUnknownFieldsSurvivePreserveAndOverwrite() async throws {
        let workspace = try TestWorkspace()
        let meta = """
        {
          "id": "baf3m",
          "title": "BAF3M",
          "units": [
            {
              "number": 1,
              "title": "Unit 1",
              "lessons": [
                {
                  "id": "01.01",
                  "code": "baf3m_u1la1",
                  "title": "Lesson 01.01",
                  "unitNumber": 1,
                  "lessonNumber": 1,
                  "type": "lesson",
                  "hasFull": true,
                  "hasSummary": false,
                  "hasCheatsheet": false,
                  "hasTest": false
                },
                {
                  "id": "01.02",
                  "customField": "keep-me",
                  "code": "baf3m_u1la2",
                  "title": "Lesson 01.02",
                  "unitNumber": 1,
                  "lessonNumber": 2,
                  "type": "lesson",
                  "hasFull": true,
                  "hasSummary": false,
                  "hasCheatsheet": false,
                  "hasTest": false
                }
              ]
            }
          ],
          "updatedAt": "2026-01-01T00:00:00.000Z"
        }
        """
        try workspace.write(meta, to: "courses/baf3m/meta.json")
        try workspace.write("# Lesson 01.01\n", to: "courses/baf3m/01.01.lesson.md")
        try workspace.write("# Lesson 01.02\n", to: "courses/baf3m/01.02.lesson.md")
        let package = try makeZip(
            workspace,
            name: "baf3m_u1la2.zip",
            entries: [("lessons/baf3m_u1la2.html", Data(lessonHTML(title: "Imported 1.2").utf8))]
        )
        let ingestor = CourseIngestor(root: workspace.dataRoot)

        _ = try await ingestor.ingest(courseId: "baf3m", packages: [package])
        try assertCustomLessonField(in: workspace)

        _ = try await ingestor.ingest(
            courseId: "baf3m",
            packages: [package],
            options: IngestOptions(overwriteExisting: true)
        )
        try assertCustomLessonField(in: workspace)
    }

    private func assertCustomLessonField(in workspace: TestWorkspace) throws {
        let data = try Data(contentsOf: workspace.url("courses/baf3m/meta.json"))
        let json = try JSONValue(parsing: data)
        guard case let .object(members) = json,
              let unitsMember = members.first(where: { $0.key == "units" }),
              let units = unitsMember.value.arrayValue,
              let firstUnit = units.first,
              case let .object(unitMembers) = firstUnit,
              let lessonsMember = unitMembers.first(where: { $0.key == "lessons" }),
              let lessons = lessonsMember.value.arrayValue else {
            XCTFail("meta.json did not have the expected shape")
            return
        }
        let lesson = lessons.first { value in
            guard case let .object(lessonMembers) = value else { return false }
            return lessonMembers.first(where: { $0.key == "id" })?.value.stringValue == "01.02"
        }
        guard let lesson, case let .object(lessonMembers) = lesson else {
            XCTFail("lesson 01.02 is missing")
            return
        }
        let keys = lessonMembers.map(\.key)
        XCTAssertEqual(
            keys.firstIndex(of: "customField"),
            1,
            "The unknown field must keep its position after id: \(keys)"
        )
        XCTAssertEqual(
            lessonMembers.first(where: { $0.key == "customField" })?.value.stringValue,
            "keep-me"
        )
    }

    // MARK: - Image optimization

    func testImageRewriteCompressesAndAddsHalfWidthSpec() throws {
        let workspace = try TestWorkspace()
        let course = workspace.url("courses/baf3m")
        try FileManager.default.createDirectory(
            at: course.appendingPathComponent("assets/img"),
            withIntermediateDirectories: true
        )
        try makePNG(width: 800, height: 400).write(
            to: course.appendingPathComponent("assets/img/photo.png")
        )
        let markdown = """
        # Images

        ![Photo](assets/img/photo.png)

        | A | B |
        | --- | --- |
        | ![P](assets/img/photo.png) | x |
        """
        try workspace.write(markdown, to: "courses/baf3m/01.01.lesson.md")

        let summary = try CourseImageOptimizer().optimize(courseDirectory: course)
        XCTAssertEqual(summary.scanned, 1)
        XCTAssertEqual(summary.converted, 1)
        XCTAssertEqual(summary.markdownRefsUpdated, 2)
        XCTAssertTrue(FileManager.default.fileExists(
            atPath: course.appendingPathComponent("assets/img/photo.jpg").path
        ))
        XCTAssertFalse(FileManager.default.fileExists(
            atPath: course.appendingPathComponent("assets/img/photo.png").path
        ))
        let size = try XCTUnwrap(
            CourseImageOptimizer.imageSize(course.appendingPathComponent("assets/img/photo.jpg"))
        )
        XCTAssertEqual(size.width, 512)

        let rewritten = try workspace.readString("courses/baf3m/01.01.lesson.md")
        XCTAssertTrue(rewritten.contains("![Photo|50%](./assets/img/photo.jpg)"))
        XCTAssertTrue(rewritten.contains("![P|50%](./assets/img/photo.jpg)"))
        XCTAssertTrue(rewritten.contains("| A | B |"))
        XCTAssertTrue(rewritten.contains("| --- | --- |"))
    }

    func testSmallImageGetsHalfWidthSpecWithoutCompression() throws {
        let workspace = try TestWorkspace()
        let course = workspace.url("courses/baf3m")
        try FileManager.default.createDirectory(
            at: course.appendingPathComponent("assets/img"),
            withIntermediateDirectories: true
        )
        try makePNG(width: 400, height: 200).write(
            to: course.appendingPathComponent("assets/img/wide.png")
        )
        try workspace.write(
            "![Wide](assets/img/wide.png)\n",
            to: "courses/baf3m/01.01.lesson.md"
        )

        let summary = try CourseImageOptimizer().optimize(courseDirectory: course)
        XCTAssertEqual(summary.converted, 0)
        XCTAssertEqual(summary.skippedSmall, 1)
        XCTAssertTrue(FileManager.default.fileExists(
            atPath: course.appendingPathComponent("assets/img/wide.png").path
        ))
        XCTAssertEqual(
            try workspace.readString("courses/baf3m/01.01.lesson.md"),
            "![Wide|50%](assets/img/wide.png)\n"
        )
    }

    func testImageRewriteDoesNotTouchCodeOrTablePipes() throws {
        let workspace = try TestWorkspace()
        let course = workspace.url("courses/baf3m")
        try FileManager.default.createDirectory(
            at: course.appendingPathComponent("assets/img"),
            withIntermediateDirectories: true
        )
        try makePNG(width: 800, height: 400).write(
            to: course.appendingPathComponent("assets/img/photo.png")
        )
        let markdown = """
        ```markdown
        ![Sample](assets/img/photo.png)
        ```

        | A | B |
        | --- | --- |
        | 1 | 2 |
        """
        try workspace.write(markdown, to: "courses/baf3m/01.01.lesson.md")

        let summary = try CourseImageOptimizer().optimize(courseDirectory: course)
        XCTAssertEqual(summary.converted, 1)
        // The only live reference is inside a fenced block, so the original
        // must be kept and the code sample must be untouched.
        XCTAssertTrue(FileManager.default.fileExists(
            atPath: course.appendingPathComponent("assets/img/photo.png").path
        ))
        let rewritten = try workspace.readString("courses/baf3m/01.01.lesson.md")
        XCTAssertTrue(rewritten.contains("![Sample](assets/img/photo.png)"))
        XCTAssertTrue(rewritten.contains("| A | B |"))
        XCTAssertTrue(summary.warnings.contains { $0.contains("still references") })
    }

    func testRepeatedIngestReusesConvertedImage() async throws {
        let workspace = try TestWorkspace()
        try makeCourse(workspace)
        let package = try makeZip(
            workspace,
            name: "baf3m_u1la2.zip",
            entries: [
                (
                    "lessons/baf3m_u1la2.html",
                    Data(lessonHTML(
                        title: "Lesson 1.2",
                        imageReference: "./assets/img/diagram.png"
                    ).utf8)
                ),
                ("assets/img/diagram.png", makePNG(width: 800, height: 400)),
            ]
        )
        let ingestor = CourseIngestor(root: workspace.dataRoot)

        _ = try await ingestor.ingest(courseId: "baf3m", packages: [package])
        let firstFiles = try imageFiles(workspace)
        XCTAssertEqual(firstFiles, ["diagram.jpg"])
        XCTAssertTrue(
            try workspace.readString("courses/baf3m/01.02.lesson.md")
                .contains("./assets/img/diagram.jpg")
        )

        // Re-extracting the same package recreates diagram.png. The
        // source-hash map must reuse diagram.jpg instead of writing
        // diagram-2.jpg, and the re-extracted PNG must be removed.
        _ = try await ingestor.ingest(courseId: "baf3m", packages: [package])
        XCTAssertEqual(try imageFiles(workspace), firstFiles)

        // The overwrite path rewrites the new lesson body from diagram.png to
        // diagram.jpg and must still leave exactly one derivative.
        _ = try await ingestor.ingest(
            courseId: "baf3m",
            packages: [package],
            options: IngestOptions(overwriteExisting: true)
        )
        XCTAssertEqual(try imageFiles(workspace), firstFiles)
        XCTAssertTrue(
            try workspace.readString("courses/baf3m/01.02.lesson.md")
                .contains("./assets/img/diagram.jpg")
        )
    }

    func testImageMapSurvivesBackupRestoreAndReingest() async throws {
        let workspace = try TestWorkspace()
        try makeCourse(workspace)
        let package = try makeZip(
            workspace,
            name: "baf3m_u1la2.zip",
            entries: [
                (
                    "lessons/baf3m_u1la2.html",
                    Data(lessonHTML(
                        title: "Lesson 1.2",
                        imageReference: "./assets/img/diagram.png"
                    ).utf8)
                ),
                ("assets/img/diagram.png", makePNG(width: 800, height: 400)),
            ]
        )
        _ = try await CourseIngestor(root: workspace.dataRoot).ingest(
            courseId: "baf3m",
            packages: [package]
        )
        let before = try imageFiles(workspace)
        XCTAssertEqual(before, ["diagram.jpg"])
        XCTAssertTrue(workspace.exists("courses/baf3m/assets/img/image-optimizer.json"))

        let exportService = BackupService(root: workspace.dataRoot)
        let export = try await exportService.exportBackup(
            options: BackupExportOptions(
                destinationDirectory: workspace.exportDirectory,
                includeRawPackages: true
            )
        )
        XCTAssertTrue(FileManager.default.fileExists(atPath: export.archiveURL.path))

        let restored = try TestWorkspace(prefix: "CourseDeckRestore")
        let importService = BackupService(root: restored.dataRoot)
        _ = try await importService.importBackup(
            from: export.archiveURL,
            options: BackupImportOptions(mode: .replaceAll, includeRawPackages: true)
        )
        XCTAssertTrue(restored.exists("courses/baf3m/assets/img/image-optimizer.json"))
        XCTAssertTrue(restored.exists("courses/baf3m/_backup/baf3m_u1la2.zip"))

        // Re-ingest from the restored `_backup/` package. The restored map must
        // make the optimizer reuse diagram.jpg rather than create a duplicate.
        _ = try await CourseIngestor(root: restored.dataRoot).ingest(
            courseId: "baf3m",
            packages: []
        )
        XCTAssertEqual(try imageFiles(restored), before)
        XCTAssertTrue(
            try restored.readString("courses/baf3m/01.02.lesson.md")
                .contains("./assets/img/diagram.jpg")
        )
    }

    // MARK: - Collisions

    func testAssetCollisionSameBasenameDifferentContentAndCase() async throws {
        let workspace = try TestWorkspace()
        try makeCourse(workspace)
        let firstPNG = makePNG(width: 64, height: 32, red: 0.1)
        let secondPNG = makePNG(width: 64, height: 32, red: 0.9)
        let thirdPNG = makePNG(width: 64, height: 32, red: 0.5)

        let first = try makeZip(
            workspace,
            name: "baf3m_u1la2.zip",
            entries: [
                ("lessons/baf3m_u1la2.html", Data(lessonHTML(title: "First", imageReference: "diagram.png").utf8)),
                ("img/diagram.png", firstPNG),
            ]
        )
        let second = try makeZip(
            workspace,
            name: "baf3m_u1la3.zip",
            entries: [
                ("lessons/baf3m_u1la3.html", Data(lessonHTML(title: "Second", imageReference: "diagram.png").utf8)),
                ("img/diagram.png", secondPNG),
            ]
        )
        let third = try makeZip(
            workspace,
            name: "baf3m_u1la4.zip",
            entries: [
                ("lessons/baf3m_u1la4.html", Data(lessonHTML(title: "Third", imageReference: "diagram.png").utf8)),
                ("img/diagram.png", firstPNG),
            ]
        )
        let fourth = try makeZip(
            workspace,
            name: "baf3m_u1la5.zip",
            entries: [
                ("lessons/baf3m_u1la5.html", Data(lessonHTML(title: "Fourth", imageReference: "Diagram.png").utf8)),
                ("img/Diagram.png", thirdPNG),
            ]
        )

        let ingestor = CourseIngestor(root: workspace.dataRoot)
        _ = try await ingestor.ingest(
            courseId: "baf3m",
            packages: [first, second, third, fourth]
        )

        let assets = try FileManager.default.contentsOfDirectory(
            at: workspace.url("courses/baf3m/assets/img"),
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles]
        ).map(\.lastPathComponent).sorted()
        XCTAssertEqual(assets.count, 3, "Identical bytes must reuse the first file; different bytes need distinct names")
        XCTAssertTrue(assets.contains("diagram.png"))
        XCTAssertTrue(assets.contains { $0.hasPrefix(String(SHA256.hex(secondPNG).prefix(10))) })
        XCTAssertTrue(assets.contains { $0.hasPrefix(String(SHA256.hex(thirdPNG).prefix(10))) })

        let firstMarkdown = try workspace.readString("courses/baf3m/01.02.lesson.md")
        let secondMarkdown = try workspace.readString("courses/baf3m/01.03.lesson.md")
        let thirdMarkdown = try workspace.readString("courses/baf3m/01.04.lesson.md")
        let fourthMarkdown = try workspace.readString("courses/baf3m/01.05.lesson.md")
        XCTAssertTrue(firstMarkdown.contains("./assets/img/diagram.png"))
        XCTAssertTrue(thirdMarkdown.contains("./assets/img/diagram.png"))
        XCTAssertTrue(secondMarkdown.contains(String(SHA256.hex(secondPNG).prefix(10))))
        XCTAssertTrue(fourthMarkdown.contains(String(SHA256.hex(thirdPNG).prefix(10))))
        XCTAssertNotEqual(
            imageReference(in: secondMarkdown),
            imageReference(in: firstMarkdown)
        )
    }

    private func imageReference(in markdown: String) -> String {
        guard let range = markdown.range(of: "](./assets/img/") else { return "" }
        return String(markdown[range.lowerBound...].prefix(80))
    }

    func testBackupArchiveNamesAreCollisionSafe() async throws {
        let workspace = try TestWorkspace()
        try makeCourse(workspace)
        let directoryA = workspace.baseURL.appendingPathComponent("a", isDirectory: true)
        let directoryB = workspace.baseURL.appendingPathComponent("b", isDirectory: true)
        try FileManager.default.createDirectory(at: directoryA, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: directoryB, withIntermediateDirectories: true)
        let packageA = try makeZip(
            workspace,
            name: "a/baf3m_u1la2.zip",
            entries: [("lessons/baf3m_u1la2.html", Data(lessonHTML(title: "A").utf8))]
        )
        let packageB = try makeZip(
            workspace,
            name: "b/baf3m_u1la2.zip",
            entries: [("lessons/baf3m_u1la2.html", Data(lessonHTML(title: "B").utf8))]
        )
        let identical = try makeZip(
            workspace,
            name: "c/baf3m_u1la2.zip",
            entries: [("lessons/baf3m_u1la2.html", Data(lessonHTML(title: "A").utf8))]
        )

        let ingestor = CourseIngestor(root: workspace.dataRoot)
        _ = try await ingestor.ingest(
            courseId: "baf3m",
            packages: [packageA, packageB, identical]
        )

        let backups = try FileManager.default.contentsOfDirectory(
            at: workspace.url("courses/baf3m/_backup"),
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles]
        ).map(\.lastPathComponent).sorted()
        let packageBHash = String(SHA256.hex(try Data(contentsOf: packageB)).prefix(10))
        XCTAssertEqual(backups.count, 2, "Identical package bytes must be archived once")
        XCTAssertTrue(backups.contains("baf3m_u1la2.zip"))
        XCTAssertTrue(backups.contains { $0.hasPrefix(packageBHash) })
    }

    // MARK: - Secrets

    func testSecretPackageIsSkipped() async throws {
        let workspace = try TestWorkspace()
        try makeCourse(workspace)
        let package = try makeZip(
            workspace,
            name: "baf3m_u1la2.zip",
            entries: [
                ("lessons/baf3m_u1la2.html", Data(lessonHTML(title: "Secret").utf8)),
                ("notes.md", Data("key = sk-abcdefghijklmnopqrstuvwxyz012345".utf8)),
            ]
        )

        let ingestor = CourseIngestor(root: workspace.dataRoot)
        let result = try await ingestor.ingest(courseId: "baf3m", packages: [package])
        XCTAssertEqual(result.skippedPackages, ["baf3m_u1la2.zip"])
        XCTAssertTrue(result.newLessonsAdded.isEmpty)
        XCTAssertFalse(workspace.exists("courses/baf3m/_backup/baf3m_u1la2.zip"))
        XCTAssertTrue(result.warnings.contains { $0.contains("secret") })
    }

    // MARK: - Edge cases

    func testCorruptAndEmptyPackagesAreSkipped() async throws {
        let workspace = try TestWorkspace()
        try makeCourse(workspace)
        let bad = workspace.baseURL.appendingPathComponent("bad.zip")
        try Data("this is not a zip".utf8).write(to: bad)
        let empty = try makeZip(workspace, name: "empty.zip", entries: [])

        let ingestor = CourseIngestor(root: workspace.dataRoot)
        let result = try await ingestor.ingest(courseId: "baf3m", packages: [bad, empty])
        XCTAssertTrue(result.skippedPackages.contains("bad.zip"))
        XCTAssertTrue(result.skippedPackages.contains("empty.zip"))
        XCTAssertTrue(result.warnings.contains { $0.contains("bad.zip") })
        let loaded = try await ingestorCourse(workspace)
        let manifest = try XCTUnwrap(loaded)
        XCTAssertEqual(manifest.allLessons.map(\.id), ["01.01"])
    }

    func testArchiveWithUnderstatedDeclaredSizeIsRejected() async throws {
        let workspace = try TestWorkspace()
        try makeCourse(workspace)
        let html = lessonHTML(title: "Understated Size", includeGoals: false)
        let data = Data(html.utf8)
        XCTAssertGreaterThan(data.count, 512)
        let package = try makeDeflateZip(
            workspace,
            name: "baf3m_u1la2.zip",
            entryPath: "lessons/baf3m_u1la2.html",
            data: data,
            declaredSize: 16
        )
        let limits = IngestLimits(
            maxEntryBytes: 512,
            maxTotalUncompressedBytes: 8_192,
            maxCompressionRatio: 10_000,
            maxHTMLBytes: 512
        )
        let result = try await CourseIngestor(root: workspace.dataRoot).ingest(
            courseId: "baf3m",
            packages: [package],
            options: IngestOptions(limits: limits)
        )
        XCTAssertTrue(result.skippedPackages.contains("baf3m_u1la2.zip"))
        XCTAssertTrue(result.warnings.contains { $0.contains("actual uncompressed bytes") })
        let loaded = try await ingestorCourse(workspace)
        XCTAssertEqual(try XCTUnwrap(loaded).allLessons.map(\.id), ["01.01"])
    }

    func testCompressionRatioLimitIsEnforced() async throws {
        let workspace = try TestWorkspace()
        try makeCourse(workspace)
        let repetitive = Data(String(repeating: "A", count: 200_000).utf8)
        let package = try makeDeflateZip(
            workspace,
            name: "baf3m_u1la2.zip",
            entryPath: "lessons/baf3m_u1la2.html",
            data: repetitive
        )
        let limits = IngestLimits(
            maxEntryBytes: 1_000_000,
            maxTotalUncompressedBytes: 1_000_000,
            maxCompressionRatio: 5,
            maxHTMLBytes: 1_000_000
        )
        let result = try await CourseIngestor(root: workspace.dataRoot).ingest(
            courseId: "baf3m",
            packages: [package],
            options: IngestOptions(limits: limits)
        )
        XCTAssertTrue(result.skippedPackages.contains("baf3m_u1la2.zip"))
        XCTAssertTrue(result.warnings.contains { $0.contains("compression ratio") })
    }

    func testTotalUncompressedLimitIsEnforced() async throws {
        let workspace = try TestWorkspace()
        try makeCourse(workspace)
        let html = Data(lessonHTML(title: "Total Limit", includeGoals: false).utf8)
        let asset = Data(repeating: 0x41, count: 800)
        let package = try makeZip(
            workspace,
            name: "baf3m_u1la2.zip",
            entries: [
                ("lessons/baf3m_u1la2.html", html),
                ("assets/img/extra.png", asset),
            ]
        )
        let limits = IngestLimits(
            maxEntryBytes: 2_000,
            maxTotalUncompressedBytes: 1_000,
            maxCompressionRatio: 10_000,
            maxHTMLBytes: 2_000
        )
        let result = try await CourseIngestor(root: workspace.dataRoot).ingest(
            courseId: "baf3m",
            packages: [package],
            options: IngestOptions(limits: limits)
        )
        XCTAssertTrue(result.skippedPackages.contains("baf3m_u1la2.zip"))
        XCTAssertTrue(result.warnings.contains { $0.contains("total actual uncompressed bytes") })
    }

    func testMHTMLHTMLPartLimitIsEnforced() async throws {
        let workspace = try TestWorkspace()
        try makeCourse(workspace)
        let boundary = "----LimitBoundary"
        let html = "<html><body><main>" + String(repeating: "x", count: 4_000) + "</main></body></html>"
        let mhtml = """
        MIME-Version: 1.0
        Content-Type: multipart/related; boundary="\(boundary)"

        --\(boundary)
        Content-Type: text/html; charset="utf-8"
        Content-Location: https://example.com/lessons/baf3m_u1la2.html

        \(html)
        --\(boundary)--
        """
        let url = workspace.baseURL.appendingPathComponent("baf3m_u1la2.mhtml")
        try Data(mhtml.utf8).write(to: url)
        let limits = IngestLimits(
            maxEntryBytes: 10_000,
            maxTotalUncompressedBytes: 10_000,
            maxCompressionRatio: 10_000,
            maxHTMLBytes: 1_000
        )
        let result = try await CourseIngestor(root: workspace.dataRoot).ingest(
            courseId: "baf3m",
            packages: [url],
            options: IngestOptions(limits: limits)
        )
        XCTAssertTrue(result.skippedPackages.contains("baf3m_u1la2.mhtml"))
        XCTAssertTrue(result.warnings.contains { $0.contains("MHTML HTML part exceeded") })
    }

    func testOversizedCompanionFolderIsRejected() async throws {
        let workspace = try TestWorkspace()
        try makeCourse(workspace)
        let htmlURL = workspace.baseURL.appendingPathComponent("Lesson 1.6.html")
        try Data(lessonHTML(title: "Lesson 1.6", includeGoals: false).utf8).write(to: htmlURL)
        let companion = workspace.baseURL.appendingPathComponent("Lesson 1.6_files", isDirectory: true)
        try FileManager.default.createDirectory(at: companion, withIntermediateDirectories: true)
        try Data(repeating: 0x41, count: 2_000).write(to: companion.appendingPathComponent("big.png"))

        let limits = IngestLimits(
            maxEntryBytes: 1_000,
            maxTotalUncompressedBytes: 10_000,
            maxCompressionRatio: 10_000,
            maxEntries: 10,
            maxHTMLBytes: 10_000
        )
        let result = try await CourseIngestor(root: workspace.dataRoot).ingest(
            courseId: "baf3m",
            packages: [htmlURL],
            options: IngestOptions(limits: limits)
        )
        XCTAssertTrue(result.skippedPackages.contains("Lesson 1.6.html"))
        XCTAssertTrue(result.warnings.contains { $0.contains("companion") })
        XCTAssertFalse(workspace.exists("courses/baf3m/assets/img/big.png"))
    }

    func testCompanionEntryCountLimitIsEnforced() async throws {
        let workspace = try TestWorkspace()
        try makeCourse(workspace)
        let htmlURL = workspace.baseURL.appendingPathComponent("Lesson 1.7.html")
        try Data(lessonHTML(title: "Lesson 1.7", includeGoals: false).utf8).write(to: htmlURL)
        let companion = workspace.baseURL.appendingPathComponent("Lesson 1.7_files", isDirectory: true)
        try FileManager.default.createDirectory(at: companion, withIntermediateDirectories: true)
        for index in 0..<3 {
            try makePNG(width: 4, height: 4).write(
                to: companion.appendingPathComponent("icon\(index).png")
            )
        }

        let limits = IngestLimits(
            maxEntryBytes: 100_000,
            maxTotalUncompressedBytes: 100_000,
            maxCompressionRatio: 10_000,
            maxEntries: 2,
            maxHTMLBytes: 100_000
        )
        let result = try await CourseIngestor(root: workspace.dataRoot).ingest(
            courseId: "baf3m",
            packages: [htmlURL],
            options: IngestOptions(limits: limits)
        )
        XCTAssertTrue(result.skippedPackages.contains("Lesson 1.7.html"))
        XCTAssertTrue(result.warnings.contains { $0.contains("companion entries") })
    }

    func testOversizedMHTMLAssetPartIsRejected() async throws {
        let workspace = try TestWorkspace()
        try makeCourse(workspace)
        let boundary = "----AssetBoundary"
        let html = "<html><body><main><h1>Asset</h1></main></body></html>"
        let bigBase64 = Data(repeating: 0x41, count: 4_096).base64EncodedString()
        let mhtml = """
        MIME-Version: 1.0
        Content-Type: multipart/related; boundary="\(boundary)"

        --\(boundary)
        Content-Type: text/html; charset="utf-8"
        Content-Location: https://example.com/lessons/baf3m_u1la2.html

        \(html)
        --\(boundary)
        Content-Type: image/png
        Content-Transfer-Encoding: base64
        Content-Location: https://example.com/lessons/baf3m_u1la2_files/big.png

        \(bigBase64)
        --\(boundary)--
        """
        let url = workspace.baseURL.appendingPathComponent("baf3m_u1la2.mhtml")
        try Data(mhtml.utf8).write(to: url)
        let limits = IngestLimits(
            maxEntryBytes: 1_000,
            maxTotalUncompressedBytes: 100_000,
            maxCompressionRatio: 10_000,
            maxHTMLBytes: 100_000,
            maxMHTMLPackageBytes: 100_000
        )
        let result = try await CourseIngestor(root: workspace.dataRoot).ingest(
            courseId: "baf3m",
            packages: [url],
            options: IngestOptions(limits: limits)
        )
        XCTAssertTrue(result.skippedPackages.contains("baf3m_u1la2.mhtml"))
        XCTAssertTrue(
            result.warnings.contains {
                $0.contains("safe decode bounds") || $0.contains("asset part")
            }
        )
        XCTAssertFalse(workspace.exists("courses/baf3m/assets/img/big.png"))
    }

    func testOversizedMHTMLPackageIsRejectedBeforeDecoding() async throws {
        let workspace = try TestWorkspace()
        try makeCourse(workspace)
        let url = workspace.baseURL.appendingPathComponent("baf3m_u1la2.mhtml")
        try Data(repeating: 0x41, count: 2 * 1024 * 1024).write(to: url)
        let limits = IngestLimits(
            maxPackageBytes: 4 * 1024 * 1024,
            maxEntryBytes: 4 * 1024 * 1024,
            maxTotalUncompressedBytes: 4 * 1024 * 1024,
            maxCompressionRatio: 10_000,
            maxHTMLBytes: 4 * 1024 * 1024,
            maxMHTMLPackageBytes: 1 * 1024 * 1024
        )
        let result = try await CourseIngestor(root: workspace.dataRoot).ingest(
            courseId: "baf3m",
            packages: [url],
            options: IngestOptions(limits: limits)
        )
        XCTAssertTrue(result.skippedPackages.contains("baf3m_u1la2.mhtml"))
        XCTAssertTrue(result.warnings.contains { $0.contains("ingest limit") })
    }

    func testMHTMLDecodeLimitIsEnforcedBeforePartsAreUsed() async throws {
        let workspace = try TestWorkspace()
        try makeCourse(workspace)
        let boundary = "----DecodeBoundary"
        let html = "<html><body><main>" + String(repeating: "y", count: 4_000) + "</main></body></html>"
        let mhtml = """
        MIME-Version: 1.0
        Content-Type: multipart/related; boundary="\(boundary)"

        --\(boundary)
        Content-Type: text/html; charset="utf-8"
        Content-Location: https://example.com/lessons/baf3m_u1la2.html

        \(html)
        --\(boundary)--
        """
        let url = workspace.baseURL.appendingPathComponent("baf3m_u1la2.mhtml")
        try Data(mhtml.utf8).write(to: url)
        let limits = IngestLimits(
            maxEntryBytes: 10_000,
            maxTotalUncompressedBytes: 1_000,
            maxCompressionRatio: 10_000,
            maxHTMLBytes: 10_000
        )
        let result = try await CourseIngestor(root: workspace.dataRoot).ingest(
            courseId: "baf3m",
            packages: [url],
            options: IngestOptions(limits: limits)
        )
        XCTAssertTrue(result.skippedPackages.contains("baf3m_u1la2.mhtml"))
        XCTAssertTrue(result.warnings.contains { $0.contains("safe decode bounds") })
    }

    func testStandaloneHTMLLimitIsEnforced() async throws {
        let workspace = try TestWorkspace()
        try makeCourse(workspace)
        let url = workspace.baseURL.appendingPathComponent("baf3m_u1la2.html")
        let html = "<html><body>" + String(repeating: "x", count: 4_000) + "</body></html>"
        try Data(html.utf8).write(to: url)
        let limits = IngestLimits(
            maxEntryBytes: 10_000,
            maxTotalUncompressedBytes: 10_000,
            maxCompressionRatio: 10_000,
            maxHTMLBytes: 1_000
        )
        let result = try await CourseIngestor(root: workspace.dataRoot).ingest(
            courseId: "baf3m",
            packages: [url],
            options: IngestOptions(limits: limits)
        )
        XCTAssertTrue(result.skippedPackages.contains("baf3m_u1la2.html"))
        XCTAssertTrue(
            result.warnings.contains {
                $0.contains("standalone HTML") || $0.contains("ingest limit")
            }
        )
    }

    func testScheduleFileIsPreservedByteForByte() async throws {
        let workspace = try TestWorkspace()
        try makeCourse(workspace)
        let schedule = "# Course Schedule\n\n| Date | Task |\n| --- | --- |\n| 2026-01-01 | Read 1.1 |\n"
        try workspace.write(schedule, to: "courses/baf3m/course.schedule.md")
        let package = try makeZip(
            workspace,
            name: "baf3m_u1la2.zip",
            entries: [("lessons/baf3m_u1la2.html", Data(lessonHTML(title: "Lesson 1.2").utf8))]
        )

        let ingestor = CourseIngestor(root: workspace.dataRoot)
        _ = try await ingestor.ingest(courseId: "baf3m", packages: [package])
        XCTAssertEqual(
            try workspace.readString("courses/baf3m/course.schedule.md"),
            schedule
        )
    }

    func testLargeStandaloneHTMLIngests() async throws {
        let workspace = try TestWorkspace()
        try makeCourse(workspace)
        let paragraph = String(repeating: "The quick brown fox jumps over the lazy dog. ", count: 6)
        var body = "<title>Large Lesson</title><h1>Large Lesson</h1>"
        for index in 0..<4_000 {
            body += "<p>Paragraph \(index): \(paragraph)</p>"
        }
        let html = "<html><head><title>Large Lesson</title></head><body><main id=\"mainContent\">\(body)</main></body></html>"
        XCTAssertGreaterThan(html.utf8.count, 1_000_000)
        let url = workspace.baseURL.appendingPathComponent("Large 2.3.html")
        try Data(html.utf8).write(to: url)

        let ingestor = CourseIngestor(root: workspace.dataRoot)
        let result = try await ingestor.ingest(courseId: "baf3m", packages: [url])
        XCTAssertEqual(result.newLessonsAdded, ["02.03"])
        let markdown = try workspace.readString("courses/baf3m/02.03.lesson.md")
        XCTAssertTrue(markdown.contains("# Large Lesson"))
        XCTAssertTrue(markdown.contains("Paragraph 3999"))
    }

    // MARK: - Streaming hash

    func testIncrementalSHA256MatchesKnownAnswer() throws {
        let expected = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        XCTAssertEqual(SHA256.hex("abc"), expected)

        var hasher = SHA256Hasher()
        hasher.update(Data("a".utf8))
        hasher.update(Data("bc".utf8))
        XCTAssertEqual(hasher.finalizeHex(), expected)

        let workspace = try TestWorkspace()
        let file = workspace.baseURL.appendingPathComponent("abc.txt")
        try Data("abc".utf8).write(to: file)
        XCTAssertEqual(try SHA256Hasher.hex(fileAt: file), expected)
    }

    // MARK: - Converter rules

    func testHTMLToMarkdownRules() throws {
        let html = """
        <h2>Heading</h2>
        <p>Some <strong>bold</strong>, <em>italic</em>, <del>gone</del>, and <code>x = 1</code>.</p>
        <ul><li>One</li><li>Two<ul><li>Nested</li></ul></li></ul>
        <ol><li>First</li><li>Second</li></ol>
        <ul><li><input type="checkbox" checked> Done</li><li><input type="checkbox"> Todo</li></ul>
        <blockquote><p>Quoted</p></blockquote>
        <pre><code class="language-swift">let x = 1
        print(x)</code></pre>
        <hr>
        <table>
          <thead><tr><th>Name</th><th align="right">Value</th></tr></thead>
          <tbody>
            <tr><td>A<br>B</td><td>1</td></tr>
            <tr><td>C</td><td>2</td><td>surplus</td></tr>
          </tbody>
        </table>
        <details class="suggested-answer"><summary>Answer</summary><p>Because.</p></details>
        <div class="app-callout-goals"><h3>Learning Goals &amp; Success Criteria</h3><ul><li>Goal</li></ul></div>
        <div class="app-row-callout"><p>Think about this.</p></div>
        <math><mrow><mi>x</mi><mo>+</mo><mn>1</mn></mrow></math>
        """
        let markdown = try HTMLToMarkdownConverter().convert(html)

        XCTAssertTrue(markdown.contains("## Heading"))
        XCTAssertTrue(markdown.contains("**bold**"))
        XCTAssertTrue(markdown.contains("*italic*"))
        XCTAssertTrue(markdown.contains("~~gone~~"))
        XCTAssertTrue(markdown.contains("`x = 1`"))
        XCTAssertTrue(markdown.contains("- One"))
        XCTAssertTrue(markdown.contains("- Two"))
        XCTAssertTrue(markdown.contains("  - Nested") || markdown.contains("    - Nested"))
        XCTAssertTrue(markdown.contains("1. First"))
        XCTAssertTrue(markdown.contains("2. Second"))
        XCTAssertTrue(markdown.contains("- [x] Done"))
        XCTAssertTrue(markdown.contains("- [ ] Todo"))
        XCTAssertTrue(markdown.contains("> Quoted"))
        XCTAssertTrue(markdown.contains("```swift"))
        XCTAssertTrue(markdown.contains("let x = 1"))
        XCTAssertTrue(markdown.contains("---"))
        XCTAssertTrue(markdown.contains("| Name | Value |  |"))
        XCTAssertTrue(markdown.contains("| --- | ---: | --- |"))
        XCTAssertTrue(markdown.contains("A<br>B"))
        XCTAssertTrue(markdown.contains("surplus"))
        XCTAssertTrue(markdown.contains("<details class=\"suggested-answer\">"))
        XCTAssertTrue(markdown.contains("<summary>Answer</summary>"))
        XCTAssertTrue(markdown.contains("Because."))
        XCTAssertTrue(markdown.contains("> [!NOTE]"))
        XCTAssertEqual(
            occurrences(of: "### Learning Goals & Success Criteria", in: markdown),
            1,
            "The goals heading must be emitted exactly once"
        )
        XCTAssertTrue(markdown.contains("> [!TIP]"))
        XCTAssertFalse(
            markdown.components(separatedBy: "\n").contains {
                $0.trimmingCharacters(in: .whitespaces) == ">"
            },
            "Callouts must not emit bare `>` lines"
        )
        XCTAssertTrue(markdown.contains("$x+1$") || markdown.contains("$x + 1$"))
    }

    private func occurrences(of needle: String, in haystack: String) -> Int {
        haystack.components(separatedBy: needle).count - 1
    }

    // MARK: - SVG

    func testSVGRepair() {
        let encoded = Data(#"=3Csvg xmlns=3D"http://www.w3.org/2000/svg" width=3D"16"=3E=3Crect/=3E=3C/svg=3E"#.utf8)
        let repaired = SVGRepair.repair(encoded)
        XCTAssertEqual(
            String(decoding: repaired, as: UTF8.self),
            #"<svg xmlns="http://www.w3.org/2000/svg" width="16"><rect/></svg>"#
        )
        let valid = Data(#"<svg xmlns="http://www.w3.org/2000/svg"/>"#.utf8)
        XCTAssertEqual(SVGRepair.repair(valid), valid)
    }
}
