import XCTest
@testable import CourseDeckCore

final class JSONValueTests: XCTestCase {
    func testCompactRoundtripPreservesFieldOrderAndNumberLexemes() throws {
        let source = #"{"id":"baf3m","title":"T","custom":{"x":1,"z":[true,null,"s"]},"units":[],"updatedAt":"2026","archived":true,"scale":1.0}"#
        let json = try JSONValue(parsing: source)
        XCTAssertEqual(json.serialized(pretty: false), source)
    }

    func testPrettyFormattingMatchesDesktopTwoSpaceLayout() throws {
        let json = try JSONValue(parsing: #"{"a":1,"b":{"c":true},"d":[1,2]}"#)
        let expected = """
        {
          "a": 1,
          "b": {
            "c": true
          },
          "d": [
            1,
            2
          ]
        }
        """
        XCTAssertEqual(json.serialized(), expected)
    }

    func testUnicodeEscapesAndSubscripts() throws {
        let json = try JSONValue(parsing: #"{"name":"caf\u00e9 \ud83d\ude00","x":1}"#)
        XCTAssertEqual(json["name"]?.stringValue, "café 😀")
        var mutable = json
        mutable["unknown"] = .string("kept")
        XCTAssertEqual(mutable["unknown"]?.stringValue, "kept")
        XCTAssertEqual(mutable.objectValue?.last?.key, "unknown")
    }

    func testRejectsTrailingContentAndInvalidBytes() throws {
        XCTAssertThrowsError(try JSONValue(parsing: #"{"a":1} trailing"#))
        XCTAssertThrowsError(try JSONValue(parsing: #"{"a":}"#))
        XCTAssertThrowsError(try JSONValue(parsing: #"{"a":01}"#))
    }

    func testMemberReplacementKeepsOrder() throws {
        var json = try JSONValue(parsing: #"{"a":1,"b":2,"c":3}"#)
        json["b"] = .number("20")
        XCTAssertEqual(json.serialized(pretty: false), #"{"a":1,"b":20,"c":3}"#)
        json["d"] = .string("new")
        XCTAssertEqual(json.serialized(pretty: false), #"{"a":1,"b":20,"c":3,"d":"new"}"#)
    }
}

final class ManifestModelTests: XCTestCase {
    func testManifestRoundtripPreservesUnknownKeysAndOrder() throws {
        let source = #"{"id":"baf3m","title":"BAF3M","grade":"Grade 11","level":"Uni","description":"Desc","units":[{"number":1,"title":"Unit 1","customUnit":"keep","lessons":[{"id":"01.01","code":"baf3m_u1la1","title":"Lesson","unitNumber":1,"lessonNumber":1,"type":"lesson","hasFull":true,"hasSummary":false,"hasCheatsheet":false,"hasTest":false,"customLesson":7}]}],"updatedAt":"2026-01-01T00:00:00.000Z","archived":true,"desktopExtra":{"a":1}}"#
        let manifest = try CourseManifest.decode(Data(source.utf8))
        XCTAssertEqual(manifest.id, "baf3m")
        XCTAssertEqual(manifest.archived, true)
        XCTAssertEqual(manifest.units[0].extras.first?.key, "customUnit")
        XCTAssertEqual(manifest.units[0].lessons[0].extras.first?.key, "customLesson")
        XCTAssertEqual(manifest.extras.first?.key, "desktopExtra")

        let reencoded = try JSONValue(parsing: manifest.encoded()).serialized(pretty: false)
        XCTAssertEqual(reencoded, source)
    }

    func testUnknownLessonTypeRoundtripsVerbatim() throws {
        let json = try JSONValue(parsing: #"{"id":"x","title":"X","units":[{"number":1,"title":"U","lessons":[{"id":"01.01","type":"project"}]}]}"#)
        let manifest = try CourseManifest(json: json)
        XCTAssertEqual(manifest.units[0].lessons[0].type, .other("project"))
        XCTAssertTrue(manifest.json.serialized(pretty: false).contains(#""type":"project""#))
    }
}

final class FrontmatterTests: XCTestCase {
    func testFrontmatterRoundtripPreservesOrderAndUnknownKeys() throws {
        let source = """
        ---
        activityCode: baf3m_u1la1
        courseId: baf3m
        prompt: You are a teacher.
        customKey:
          nested: true
        version: 1
        ---

        # Lesson

        Body text.
        """
        var document = try FrontmatterDocument(parsing: source)
        XCTAssertTrue(document.hadFrontmatter)
        XCTAssertEqual(document.entries.map(\.key), ["activityCode", "courseId", "prompt", "customKey", "version"])
        XCTAssertEqual(document.value(forKey: "customKey")?.mapping?["nested"]?.scalarValue, "true")
        XCTAssertEqual(document.body, "# Lesson\n\nBody text.")

        document.setValue(.scalar("summary"), forKey: "type")
        let serialized = try document.serialized()
        XCTAssertTrue(serialized.hasPrefix("---\n"))
        XCTAssertTrue(serialized.contains("customKey:"))
        XCTAssertTrue(serialized.contains("type: summary"))

        let reparsed = try FrontmatterDocument(parsing: serialized)
        XCTAssertEqual(reparsed.value(forKey: "customKey")?.mapping?["nested"]?.scalarValue, "true")
        XCTAssertEqual(reparsed.body, "# Lesson\n\nBody text.")
    }

    func testPlainMarkdownStaysPlain() throws {
        var document = try FrontmatterDocument(parsing: "# Hello\n\nNo frontmatter.")
        XCTAssertFalse(document.hadFrontmatter)
        XCTAssertEqual(try document.serialized(), "# Hello\n\nNo frontmatter.\n")
        document.setValue(.scalar("summary"), forKey: "prompt")
        XCTAssertTrue(try document.serialized().hasPrefix("---\n"))
    }
}

private extension YAMLValue {
    var mapping: [String: YAMLValue]? {
        if case let .mapping(pairs) = self {
            return Dictionary(uniqueKeysWithValues: pairs.map { ($0.key, $0.value) })
        }
        return nil
    }

    var scalarValue: String? {
        if case let .scalar(value) = self { return value }
        return nil
    }
}
