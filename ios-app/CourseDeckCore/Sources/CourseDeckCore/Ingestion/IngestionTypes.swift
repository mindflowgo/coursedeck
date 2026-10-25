import Foundation

/// The package formats the desktop `CourseIngest` accepts (PLAN §4.11).
public enum LessonPackageKind: String, Sendable, Equatable, CaseIterable {
    case zip
    case mhtml
    case html

    public init?(fileExtension: String) {
        switch fileExtension.lowercased() {
        case "zip": self = .zip
        case "mhtml", "mht": self = .mhtml
        case "html", "htm": self = .html
        default: return nil
        }
    }
}

/// Asset folders inside `<course>/assets/`, matching the desktop extractor.
public enum AssetCategory: String, Sendable, Equatable, CaseIterable {
    case img
    case icons
    case lockerDocs = "locker_docs"

    public init?(fileName: String) {
        let ext = (fileName as NSString).pathExtension.lowercased()
        switch ext {
        case "png", "jpg", "jpeg", "gif", "webp", "heic", "bmp", "tiff":
            self = .img
        case "svg":
            self = .icons
        case "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx":
            self = .lockerDocs
        default:
            return nil
        }
    }
}

/// One asset written into the course. `rewrittenReference` is the
/// course-relative Markdown/HTML reference (`assets/img/name.ext`).
public struct IngestedAsset: Equatable, Sendable {
    public var fileName: String
    public var category: AssetCategory
    public var byteCount: Int
    public var sha256: String
    /// True when this call wrote new bytes; false when identical existing
    /// content was reused.
    public var isNew: Bool
    /// Every source reference that resolves to this asset (entry path,
    /// content-location, `cid:` id, basename).
    public var originalReferences: [String]

    public init(
        fileName: String,
        category: AssetCategory,
        byteCount: Int,
        sha256: String,
        isNew: Bool,
        originalReferences: [String] = []
    ) {
        self.fileName = fileName
        self.category = category
        self.byteCount = byteCount
        self.sha256 = sha256
        self.isNew = isNew
        self.originalReferences = originalReferences
    }

    /// Course-relative reference without a leading `./`.
    public var rewrittenReference: String {
        "assets/\(category.rawValue)/\(fileName)"
    }
}

/// A lesson package after extraction, before HTML→Markdown conversion.
public struct ExtractedLessonPackage: Equatable, Sendable {
    public var packageFilename: String
    public var packageKind: LessonPackageKind
    public var html: String
    public var htmlPath: String
    public var title: String
    public var unitNumber: Int
    public var lessonNumber: Int
    public var activityCode: String
    public var isAssignment: Bool
    public var assets: [IngestedAsset]
    public var warnings: [String]

    public init(
        packageFilename: String,
        packageKind: LessonPackageKind,
        html: String,
        htmlPath: String,
        title: String,
        unitNumber: Int,
        lessonNumber: Int,
        activityCode: String,
        isAssignment: Bool,
        assets: [IngestedAsset] = [],
        warnings: [String] = []
    ) {
        self.packageFilename = packageFilename
        self.packageKind = packageKind
        self.html = html
        self.htmlPath = htmlPath
        self.title = title
        self.unitNumber = unitNumber
        self.lessonNumber = lessonNumber
        self.activityCode = activityCode
        self.isAssignment = isAssignment
        self.assets = assets
        self.warnings = warnings
    }

    /// Desktop lesson id: `NN.NN` or `NN.NN_assign1`.
    public var lessonId: String {
        let unit = String(format: "%02d", unitNumber)
        let lesson = String(format: "%02d", lessonNumber)
        return isAssignment ? "\(unit).\(lesson)_assign1" : "\(unit).\(lesson)"
    }
}

/// Bounds for untrusted packages. Mirrors the archive guards used by backup
/// import so a zip bomb cannot exhaust memory.
public struct IngestLimits: Equatable, Sendable {
    public var maxPackageBytes: UInt64
    public var maxEntryBytes: UInt64
    /// Cumulative actual (not declared) uncompressed bytes for one package.
    public var maxTotalUncompressedBytes: UInt64
    /// Reject an entry whose actual uncompressed bytes exceed this multiple of
    /// its compressed size (zip-bomb guard).
    public var maxCompressionRatio: Double
    public var maxEntries: Int
    public var maxHTMLBytes: UInt64
    /// MHTML is decoded in memory, so it has a tighter package cap than a
    /// streamed ZIP.
    public var maxMHTMLPackageBytes: UInt64
    public var maxCompanionDepth: Int

    public init(
        maxPackageBytes: UInt64 = 256 * 1024 * 1024,
        maxEntryBytes: UInt64 = 64 * 1024 * 1024,
        maxTotalUncompressedBytes: UInt64 = 512 * 1024 * 1024,
        maxCompressionRatio: Double = 200,
        maxEntries: Int = 20_000,
        maxHTMLBytes: UInt64 = 32 * 1024 * 1024,
        maxMHTMLPackageBytes: UInt64 = 32 * 1024 * 1024,
        maxCompanionDepth: Int = 3
    ) {
        self.maxPackageBytes = maxPackageBytes
        self.maxEntryBytes = maxEntryBytes
        self.maxTotalUncompressedBytes = maxTotalUncompressedBytes
        self.maxCompressionRatio = maxCompressionRatio
        self.maxEntries = maxEntries
        self.maxHTMLBytes = maxHTMLBytes
        self.maxMHTMLPackageBytes = maxMHTMLPackageBytes
        self.maxCompanionDepth = maxCompanionDepth
    }
}

/// Options for one ingest run. Incremental preservation is the default: an
/// existing lesson file is never overwritten unless explicitly requested.
public struct IngestOptions: Sendable {
    public var overwriteExisting: Bool
    public var overwriteLessonIds: Set<String>
    public var overwritePackageFiles: Set<String>
    /// Copy every uploaded package into `<course>/_backup/` (PLAN §4.11).
    public var archivePackages: Bool
    /// Remove successfully ingested sources from `Documents/Import Inbox`.
    public var removeSourceFromImportInbox: Bool
    /// Prompt text stored in generated placeholder frontmatter, matching the
    /// desktop `prompt` key. Empty when the caller does not have prompts.
    public var summaryPrompt: String
    public var cheatsheetPrompt: String
    public var testPrompt: String
    public var imageOptions: ImageCompressionOptions
    public var limits: IngestLimits
    public var now: Date

    public init(
        overwriteExisting: Bool = false,
        overwriteLessonIds: Set<String> = [],
        overwritePackageFiles: Set<String> = [],
        archivePackages: Bool = true,
        removeSourceFromImportInbox: Bool = true,
        summaryPrompt: String = "",
        cheatsheetPrompt: String = "",
        testPrompt: String = "",
        imageOptions: ImageCompressionOptions = ImageCompressionOptions(),
        limits: IngestLimits = IngestLimits(),
        now: Date = Date()
    ) {
        self.overwriteExisting = overwriteExisting
        self.overwriteLessonIds = overwriteLessonIds
        self.overwritePackageFiles = overwritePackageFiles
        self.archivePackages = archivePackages
        self.removeSourceFromImportInbox = removeSourceFromImportInbox
        self.summaryPrompt = summaryPrompt
        self.cheatsheetPrompt = cheatsheetPrompt
        self.testPrompt = testPrompt
        self.imageOptions = imageOptions
        self.limits = limits
        self.now = now
    }
}

/// Summary of one ingest. `manifest` is the merged manifest that was written.
public struct IngestResult: Equatable, Sendable {
    public var manifest: CourseManifest
    public var newLessonsAdded: [String]
    public var overwrittenLessons: [String]
    public var preservedLessons: [String]
    public var totalLessons: Int
    public var archivedPackages: [String]
    public var skippedPackages: [String]
    public var warnings: [String]
    public var imageSummary: ImageOptimizeSummary
    public var assetsExtracted: Int
    public var sourcesRemoved: [URL]

    public init(
        manifest: CourseManifest,
        newLessonsAdded: [String] = [],
        overwrittenLessons: [String] = [],
        preservedLessons: [String] = [],
        totalLessons: Int = 0,
        archivedPackages: [String] = [],
        skippedPackages: [String] = [],
        warnings: [String] = [],
        imageSummary: ImageOptimizeSummary = ImageOptimizeSummary(),
        assetsExtracted: Int = 0,
        sourcesRemoved: [URL] = []
    ) {
        self.manifest = manifest
        self.newLessonsAdded = newLessonsAdded
        self.overwrittenLessons = overwrittenLessons
        self.preservedLessons = preservedLessons
        self.totalLessons = totalLessons
        self.archivedPackages = archivedPackages
        self.skippedPackages = skippedPackages
        self.warnings = warnings
        self.imageSummary = imageSummary
        self.assetsExtracted = assetsExtracted
        self.sourcesRemoved = sourcesRemoved
    }
}

/// User-supplied new-course request. The course code is mandatory and
/// validated; no mock grade/level/description is invented (PLAN §4.11).
public struct NewCourseRequest: Sendable, Equatable {
    public var code: String
    public var title: String?
    public var grade: String?
    public var level: String?
    public var description: String?
    /// When true, an existing course is reused instead of rejected.
    public var confirmExisting: Bool

    public init(
        code: String,
        title: String? = nil,
        grade: String? = nil,
        level: String? = nil,
        description: String? = nil,
        confirmExisting: Bool = false
    ) {
        self.code = code
        self.title = title
        self.grade = grade
        self.level = level
        self.description = description
        self.confirmExisting = confirmExisting
    }
}

public enum IngestError: Error, LocalizedError, Equatable {
    case invalidCourseCode(String)
    case courseExists(String)
    case courseNotFound(String)
    case corruptManifest(String)
    case unsupportedPackage(String)
    case packageTooLarge(String, UInt64)
    case archiveBoundsExceeded(String, String)
    case noLessonHTML(String)
    case writeBlocked(String)
    case secretFound(package: String, pattern: String)

    public var errorDescription: String? {
        switch self {
        case let .invalidCourseCode(value):
            return "Invalid course code \"\(value)\". Use lowercase letters, digits, dots, dashes or underscores, starting with a letter or digit."
        case let .courseExists(id):
            return "The course \"\(id)\" already exists."
        case let .courseNotFound(id):
            return "The course \"\(id)\" does not exist."
        case let .corruptManifest(reason):
            return "The course manifest is unreadable: \(reason)"
        case let .unsupportedPackage(name):
            return "\(name) is not a supported lesson package (.zip, .mhtml, .mht, .html or .htm)."
        case let .packageTooLarge(name, limit):
            return "\(name) exceeds the \(ByteCountFormatter.string(fromByteCount: Int64(limit), countStyle: .file)) ingest limit."
        case let .archiveBoundsExceeded(name, reason):
            return "\(name) exceeds safe archive bounds: \(reason)"
        case let .noLessonHTML(name):
            return "No lesson HTML was found in \(name)."
        case let .writeBlocked(reason):
            return "Writes are blocked: \(reason)"
        case let .secretFound(package, pattern):
            return "\(package) contains a secret (\(pattern)) and was not imported."
        }
    }
}

/// ISO-8601 timestamp with milliseconds, matching the desktop's
/// `new Date().toISOString()` manifest values.
enum IngestTimestamp {
    static func iso8601(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        return formatter.string(from: date)
    }

    static func day(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: date)
    }
}
