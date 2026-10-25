import Foundation
import XCTest
import ZIPFoundation
@testable import CourseDeckCore

/// Temp data root + helpers shared by the Core tests.
final class TestWorkspace {
    let baseURL: URL
    let rootURL: URL
    let documentsURL: URL
    let dataRoot: DataRoot

    init(prefix: String = "CourseDeckCoreTests") throws {
        baseURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("\(prefix)-\(UUID().uuidString)", isDirectory: true)
        rootURL = baseURL.appendingPathComponent("Library/Application Support/CourseDeck", isDirectory: true)
        documentsURL = baseURL.appendingPathComponent("Documents", isDirectory: true)
        dataRoot = DataRoot(rootURL: rootURL, documentsURL: documentsURL)
        try dataRoot.prepare()
    }

    deinit {
        try? FileManager.default.removeItem(at: baseURL)
    }

    var exportDirectory: URL {
        documentsURL.appendingPathComponent("Export", isDirectory: true)
    }

    var importInbox: URL {
        documentsURL.appendingPathComponent("Import Inbox", isDirectory: true)
    }

    func url(_ relative: String) -> URL {
        rootURL.appendingPathComponent(relative)
    }

    @discardableResult
    func write(_ string: String, to relative: String) throws -> URL {
        try write(Data(string.utf8), to: relative)
    }

    @discardableResult
    func write(_ data: Data, to relative: String) throws -> URL {
        let url = self.url(relative)
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try data.write(to: url)
        return url
    }

    func readString(_ relative: String) throws -> String {
        String(decoding: try Data(contentsOf: url(relative)), as: UTF8.self)
    }

    func readJSON(_ relative: String) throws -> JSONValue {
        try JSONValue(parsing: Data(contentsOf: url(relative)))
    }

    func exists(_ relative: String) -> Bool {
        FileManager.default.fileExists(atPath: url(relative).path)
    }

    func makeCourse(
        id: String = "baf3m",
        title: String = "BAF3M",
        lessonID: String = "01.01",
        lessonBody: String = "# Lesson 01.01\n\nHello."
    ) throws {
        let manifest = CourseManifest(
            id: id,
            title: title,
            grade: "Grade 11",
            level: "University/College Preparation",
            description: "Test course",
            units: [
                CourseUnit(number: 1, title: "Unit 1", lessons: [
                    CourseLesson(
                        id: lessonID,
                        code: "\(id)_u1la1",
                        title: "Lesson One",
                        unitNumber: 1,
                        lessonNumber: 1,
                        type: .lesson,
                        hasFull: true,
                        hasSummary: true,
                        hasCheatsheet: true,
                        hasTest: true
                    ),
                ]),
            ],
            updatedAt: "2026-01-01T00:00:00.000Z"
        )
        try write(manifest.encoded(), to: "courses/\(id)/meta.json")
        try write(lessonBody, to: "courses/\(id)/\(lessonID).lesson.md")
    }

    // MARK: - ZIP helpers

    static func makeZip(entries: [(path: String, data: Data)], at url: URL) throws {
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        let archive = try Archive(url: url, accessMode: .create)
        for entry in entries {
            let data = entry.data
            try archive.addEntry(
                with: entry.path,
                type: .file,
                uncompressedSize: Int64(data.count),
                provider: { position, size in
                    let start = Int(position)
                    let end = min(start + size, data.count)
                    guard start <= end else { return Data() }
                    return data.subdata(in: start..<end)
                }
            )
        }
    }

    static func archivePaths(at url: URL) throws -> [String] {
        let archive = try Archive(url: url, accessMode: .read)
        return Array(archive).map(\.path)
    }

    static func archiveContents(at url: URL, path: String) throws -> Data {
        let archive = try Archive(url: url, accessMode: .read)
        guard let entry = archive[path] else {
            throw NSError(domain: "TestWorkspace", code: 1, userInfo: [NSLocalizedDescriptionKey: "missing \(path)"])
        }
        var data = Data()
        _ = try archive.extract(entry, skipCRC32: false) { data.append($0) }
        return data
    }

    static func archiveContainsSecret(at url: URL, scanner: SecretScanner = SecretScanner()) throws -> SecretMatch? {
        let archive = try Archive(url: url, accessMode: .read)
        for entry in archive where entry.type == .file {
            var data = Data()
            _ = try archive.extract(entry, skipCRC32: false) { data.append($0) }
            if let match = scanner.firstMatch(in: data) {
                return SecretMatch(pattern: "\(entry.path):\(match.pattern)", byteOffset: match.byteOffset)
            }
        }
        return nil
    }
}

func makeLlmConfigJSON(key: String = "sk-test123456789012345678901234") -> String {
    """
    {
      "version": 2,
      "activeId": "card_deepseek",
      "cards": [
        {
          "id": "card_deepseek",
          "label": "DeepSeek",
          "provider": "openai_compatible",
          "baseUrl": "https://api.deepseek.com",
          "apiKey": "\(key)",
          "authHeaderType": "api_key",
          "model": "deepseek-flash",
          "temperature": 0.3,
          "timeoutSeconds": 150,
          "sendSessionId": false
        }
      ]
    }
    """
}
