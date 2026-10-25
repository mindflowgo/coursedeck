import Foundation
import SwiftSoup
import ZIPFoundation

/// Unit/lesson/activity metadata derived from a package filename and its HTML,
/// ported from the desktop `ArchiveExtractor.parseLessonMetadata`.
public enum LessonMetadataParser {
    public struct Metadata: Equatable, Sendable {
        public var unitNumber: Int
        public var lessonNumber: Int
        public var activityCode: String
        public var isAssignment: Bool
        public var title: String
    }

    public static func parse(filename: String, html: String = "") -> Metadata {
        var unitNumber = 1
        var lessonNumber = 1
        var activityCode = ""
        var isAssignment = firstCapture("assign", in: filename, caseInsensitive: true) != nil

        let ulaMatch = captures(
            "u(\\d+)la(\\d+)(?:_assign(\\d+))?",
            in: filename,
            caseInsensitive: true
        )
        if let ulaMatch {
            unitNumber = Int(ulaMatch[0]) ?? 1
            lessonNumber = Int(ulaMatch[1]) ?? 1
            if ulaMatch.count > 2, !ulaMatch[2].isEmpty {
                isAssignment = true
            }
            activityCode = strippingPackageExtension(filename)
        } else if let match = captures(
            "(?:learning\\s*activity|activity|lesson|unit)\\s*(\\d+)[\\._\\s]+(\\d+)",
            in: filename,
            caseInsensitive: true
        ) {
            unitNumber = Int(match[0]) ?? 1
            lessonNumber = Int(match[1]) ?? 1
        } else if let match = captures("(\\d+)[\\._](\\d+)", in: filename, caseInsensitive: true) {
            unitNumber = Int(match[0]) ?? 1
            lessonNumber = Int(match[1]) ?? 1
        }

        if activityCode.isEmpty, !html.isEmpty,
           let match = captures(
               "(?:lessons|assignments)/([a-zA-Z0-9_]+_u(\\d+)la(\\d+))",
               in: html,
               caseInsensitive: true
           ) {
            activityCode = match[0]
            if ulaMatch == nil {
                unitNumber = Int(match[1]) ?? unitNumber
                lessonNumber = Int(match[2]) ?? lessonNumber
            }
        }

        if activityCode.isEmpty {
            activityCode = "u\(unitNumber)la\(lessonNumber)"
        }

        var title = ""
        if !html.isEmpty {
            if let rawTitle = firstCapture("<title[^>]*>([\\s\\S]*?)</title>", in: html, caseInsensitive: true) {
                title = plainText(rawTitle)
            }
            if title.isEmpty,
               let rawH1 = firstCapture("<h1[^>]*>([\\s\\S]*?)</h1>", in: html, caseInsensitive: true) {
                title = plainText(rawH1)
            }
        }
        if title.isEmpty {
            title = strippingPackageExtension(filename)
        }

        title = title.replacingOccurrences(
            of: "^learning\\s*activity\\s*",
            with: "",
            options: [.regularExpression, .caseInsensitive]
        )
        title = title.replacingOccurrences(
            of: "^(\\d+\\.\\d+)[:\\s_-]+",
            with: "$1 ",
            options: [.regularExpression, .caseInsensitive]
        )
        title = title.trimmingCharacters(in: .whitespacesAndNewlines)

        return Metadata(
            unitNumber: unitNumber,
            lessonNumber: lessonNumber,
            activityCode: activityCode,
            isAssignment: isAssignment,
            title: title
        )
    }

    static func strippingPackageExtension(_ filename: String) -> String {
        filename.replacingOccurrences(
            of: "\\.(html\\.zip|zip|mhtml|mht|html|htm)$",
            with: "",
            options: [.regularExpression, .caseInsensitive]
        )
    }

    private static func plainText(_ html: String) -> String {
        let withoutTags = html.replacingOccurrences(
            of: "<[^>]+>",
            with: " ",
            options: .regularExpression
        )
        let decoded = (try? SwiftSoup.parseBodyFragment(withoutTags).text()) ?? withoutTags
        return decoded
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func captures(
        _ pattern: String,
        in text: String,
        caseInsensitive: Bool
    ) -> [String]? {
        let options: NSRegularExpression.Options = caseInsensitive ? [.caseInsensitive] : []
        guard let regex = try? NSRegularExpression(pattern: pattern, options: options) else {
            return nil
        }
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        guard let match = regex.firstMatch(in: text, options: [], range: range) else {
            return nil
        }
        var output: [String] = []
        for index in 1..<match.numberOfRanges {
            if let groupRange = Range(match.range(at: index), in: text) {
                output.append(String(text[groupRange]))
            } else {
                output.append("")
            }
        }
        return output
    }

    private static func firstCapture(
        _ pattern: String,
        in text: String,
        caseInsensitive: Bool
    ) -> String? {
        captures(pattern, in: text, caseInsensitive: caseInsensitive)?.first
    }
}

/// Extracts the lesson HTML and assets from `.zip`, `.mhtml`/`.mht`, and
/// standalone `.html` packages. The scoring and metadata rules mirror the
/// desktop `ArchiveExtractor`; asset writes go through `CourseAssetStore` so
/// basename collisions are safe.
struct LessonPackageExtractor {
    let store: AtomicFileStore
    let limits: IngestLimits

    init(store: AtomicFileStore = AtomicFileStore(), limits: IngestLimits = IngestLimits()) {
        self.store = store
        self.limits = limits
    }

    func extract(packageURL: URL, assetStore: CourseAssetStore) throws -> ExtractedLessonPackage? {
        guard let kind = LessonPackageKind(fileExtension: packageURL.pathExtension) else {
            throw IngestError.unsupportedPackage(packageURL.lastPathComponent)
        }
        let size = (try? packageURL.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        if UInt64(size) > limits.maxPackageBytes {
            throw IngestError.packageTooLarge(packageURL.lastPathComponent, limits.maxPackageBytes)
        }
        switch kind {
        case .zip:
            return try extractZip(packageURL, assetStore: assetStore)
        case .mhtml:
            return try extractMHTML(packageURL, assetStore: assetStore)
        case .html:
            return try extractHTML(packageURL, assetStore: assetStore)
        }
    }

    // MARK: - ZIP

    private func extractZip(_ zipURL: URL, assetStore: CourseAssetStore) throws -> ExtractedLessonPackage? {
        let archive: Archive
        do {
            archive = try Archive(url: zipURL, accessMode: .read)
        } catch {
            throw IngestError.archiveBoundsExceeded(zipURL.lastPathComponent, "not a readable ZIP")
        }
        let zipBasename = zipURL.lastPathComponent
        let cleanZipName = LessonMetadataParser.strippingPackageExtension(zipBasename).lowercased()
        let isZipAssignment = zipBasename.range(of: "assign", options: .caseInsensitive) != nil
        let targetCode: String?
        if let match = captures("u(\\d+)la(\\d+)", in: zipBasename) {
            targetCode = "u\(match[0])la\(match[1])".lowercased()
        } else {
            targetCode = nil
        }

        var best: (entryName: String, text: String, score: Int)?
        var entryCount = 0
        var totalExtractedBytes: UInt64 = 0

        for entry in archive {
            entryCount += 1
            if entryCount > limits.maxEntries {
                throw IngestError.archiveBoundsExceeded(zipBasename, "more than \(limits.maxEntries) entries")
            }
            guard entry.type == .file else { continue }
            let entryName = entry.path.replacingOccurrences(of: "\\", with: "/")
            guard !entryName.hasPrefix("__MACOSX/"),
                  !(entryName as NSString).lastPathComponent.hasPrefix("._"),
                  !isUnsafeEntryPath(entryName) else { continue }
            guard entry.uncompressedSize <= limits.maxEntryBytes else {
                throw IngestError.archiveBoundsExceeded(
                    zipBasename,
                    "entry \(entryName) declares more than \(limits.maxEntryBytes) bytes"
                )
            }

            let filename = (entryName as NSString).lastPathComponent
            let ext = (filename as NSString).pathExtension.lowercased()

            if let category = AssetCategory(fileName: filename) {
                var data = try extractEntryData(
                    entry,
                    from: archive,
                    packageName: zipBasename,
                    perEntryLimit: limits.maxEntryBytes,
                    totalBytes: &totalExtractedBytes
                )
                if category == .icons {
                    data = SVGRepair.repair(data)
                }
                try assetStore.add(
                    data: data,
                    suggestedFilename: filename,
                    category: category,
                    originalReferences: [entryName, filename]
                )
            }

            guard ext == "html" || ext == "htm" else { continue }
            guard entry.uncompressedSize <= limits.maxHTMLBytes else {
                throw IngestError.archiveBoundsExceeded(
                    zipBasename,
                    "HTML entry \(entryName) declares more than \(limits.maxHTMLBytes) bytes"
                )
            }
            let htmlData = try extractEntryData(
                entry,
                from: archive,
                packageName: zipBasename,
                perEntryLimit: min(limits.maxEntryBytes, limits.maxHTMLBytes),
                totalBytes: &totalExtractedBytes
            )
            let text = HTMLTextDecoder.decode(htmlData)
            let score = Self.scoreHTMLEntry(
                entryName: entryName,
                text: text,
                cleanZipName: cleanZipName,
                targetCode: targetCode,
                isAssignment: isZipAssignment
            )
            if best == nil || score > best!.score {
                best = (entryName, text, score)
            }
        }

        guard let best else { return nil }
        let metadata = LessonMetadataParser.parse(filename: zipBasename, html: best.text)
        return ExtractedLessonPackage(
            packageFilename: zipBasename,
            packageKind: .zip,
            html: best.text,
            htmlPath: best.entryName,
            title: metadata.title,
            unitNumber: metadata.unitNumber,
            lessonNumber: metadata.lessonNumber,
            activityCode: metadata.activityCode,
            isAssignment: metadata.isAssignment,
            assets: assetStore.assets
        )
    }

    /// Extracts one entry while counting the bytes actually produced, not the
    /// size declared in the ZIP headers. A crafted archive can understate
    /// `uncompressedSize`; the decompressor still emits the real bytes.
    private func extractEntryData(
        _ entry: Entry,
        from archive: Archive,
        packageName: String,
        perEntryLimit: UInt64,
        totalBytes: inout UInt64
    ) throws -> Data {
        var data = Data()
        var entryBytes: UInt64 = 0
        _ = try archive.extract(entry, skipCRC32: true) { chunk in
            let count = UInt64(chunk.count)
            entryBytes += count
            totalBytes += count
            guard entryBytes <= perEntryLimit else {
                throw IngestError.archiveBoundsExceeded(
                    packageName,
                    "entry \(entry.path) exceeded \(perEntryLimit) actual uncompressed bytes"
                )
            }
            guard totalBytes <= limits.maxTotalUncompressedBytes else {
                throw IngestError.archiveBoundsExceeded(
                    packageName,
                    "total actual uncompressed bytes exceeded \(limits.maxTotalUncompressedBytes)"
                )
            }
            data.append(chunk)
        }
        if entry.compressedSize > 0, limits.maxCompressionRatio > 0 {
            let ratio = Double(entryBytes) / Double(entry.compressedSize)
            if ratio > limits.maxCompressionRatio {
                throw IngestError.archiveBoundsExceeded(
                    packageName,
                    "entry \(entry.path) compression ratio \(String(format: "%.1f", ratio)) exceeded \(limits.maxCompressionRatio)"
                )
            }
        }
        return data
    }

    static func scoreHTMLEntry(
        entryName: String,
        text: String,
        cleanZipName: String,
        targetCode: String?,
        isAssignment: Bool
    ) -> Int {
        let lowerName = entryName.lowercased()
        let filename = (entryName as NSString).lastPathComponent
        let ext = (filename as NSString).pathExtension.lowercased()
        let entryStem = ((filename.lowercased() as NSString).deletingPathExtension)
        var score = 0

        if entryStem == cleanZipName { score += 1000 }
        if let targetCode {
            if entryStem.contains(targetCode) || lowerName.contains(targetCode) {
                score += 500
            } else if lowerName.range(of: "u\\d+la\\d+", options: .regularExpression) != nil {
                score -= 800
            }
        }
        if isAssignment {
            if lowerName.contains("/assignments/") || lowerName.hasPrefix("assignments/") { score += 400 }
            if entryStem.contains("assign") { score += 200 }
            if lowerName.contains("/lessons/") || lowerName.hasPrefix("lessons/") { score -= 200 }
        } else {
            if lowerName.contains("/lessons/") || lowerName.hasPrefix("lessons/") { score += 400 }
            if lowerName.contains("/assignments/") || lowerName.hasPrefix("assignments/") { score -= 600 }
            if entryStem.contains("assign") { score -= 400 }
        }
        if entryStem == "intermediate" || lowerName.contains("intermediate.html") { score += 1500 }
        if lowerName.contains("/locker_docs/")
            || lowerName.contains("/alt/")
            || lowerName.contains("/assets/")
            || lowerName.contains("/dependencies/")
            || lowerName.contains("/vendor/") {
            score -= 1000
        }
        if text.contains("ilcLearningGoals") || text.contains("mindsOn") { score += 150 }
        if text.contains("<section id=\"app_") { score += 100 }
        return score
    }

    // MARK: - MHTML

    private func extractMHTML(_ url: URL, assetStore: CourseAssetStore) throws -> ExtractedLessonPackage? {
        // MHTML is decoded in memory; enforce the tighter cap before reading.
        let declaredSize = UInt64((try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0)
        guard declaredSize <= limits.maxMHTMLPackageBytes else {
            throw IngestError.packageTooLarge(url.lastPathComponent, limits.maxMHTMLPackageBytes)
        }
        guard declaredSize <= limits.maxPackageBytes else {
            throw IngestError.packageTooLarge(url.lastPathComponent, limits.maxPackageBytes)
        }
        let data = try Data(contentsOf: url)
        guard UInt64(data.count) <= limits.maxMHTMLPackageBytes else {
            throw IngestError.packageTooLarge(url.lastPathComponent, limits.maxMHTMLPackageBytes)
        }
        let document = try MIMEParser.parse(
            data,
            limits: MIMEDecodeLimits(
                maxPartBytes: min(limits.maxEntryBytes, limits.maxTotalUncompressedBytes),
                maxTotalBytes: limits.maxTotalUncompressedBytes
            )
        )

        var lessonHTML = ""
        var fallbackHTML = ""
        var totalDecodedBytes: UInt64 = 0

        for part in document.parts {
            totalDecodedBytes += UInt64(part.decodedData.count)
            guard totalDecodedBytes <= limits.maxTotalUncompressedBytes else {
                throw IngestError.archiveBoundsExceeded(
                    url.lastPathComponent,
                    "total decoded MHTML bytes exceeded \(limits.maxTotalUncompressedBytes)"
                )
            }
            let filename = part.fileName ?? ""
            if part.isImage {
                guard UInt64(part.decodedData.count) <= limits.maxEntryBytes else {
                    throw IngestError.archiveBoundsExceeded(
                        url.lastPathComponent,
                        "MHTML asset part \(filename) exceeded \(limits.maxEntryBytes) bytes"
                    )
                }
                let category: AssetCategory = filename.lowercased().hasSuffix(".svg") || part.contentType.contains("svg")
                    ? .icons
                    : .img
                var assetData = part.decodedData
                if category == .icons {
                    assetData = SVGRepair.repair(assetData)
                }
                if !filename.isEmpty {
                    var references = [filename]
                    if let location = part.contentLocation { references.append(location) }
                    if let contentID = part.contentID {
                        references.append(contentID)
                        references.append("cid:\(contentID)")
                    }
                    try assetStore.add(
                        data: assetData,
                        suggestedFilename: filename,
                        category: category,
                        originalReferences: references
                    )
                }
            } else if part.isDocument, !filename.isEmpty {
                guard UInt64(part.decodedData.count) <= limits.maxEntryBytes else {
                    throw IngestError.archiveBoundsExceeded(
                        url.lastPathComponent,
                        "MHTML document part \(filename) exceeded \(limits.maxEntryBytes) bytes"
                    )
                }
                var references = [filename]
                if let location = part.contentLocation { references.append(location) }
                try assetStore.add(
                    data: part.decodedData,
                    suggestedFilename: filename,
                    category: .lockerDocs,
                    originalReferences: references
                )
            }

            guard part.isHTML else { continue }
            guard UInt64(part.decodedData.count) <= limits.maxHTMLBytes else {
                throw IngestError.archiveBoundsExceeded(
                    url.lastPathComponent,
                    "MHTML HTML part exceeded \(limits.maxHTMLBytes) bytes"
                )
            }
            guard let text = part.decodedText else { continue }
            let location = (part.contentLocation ?? "").lowercased()
            if location.contains("lessons/")
                || location.contains("assignments/")
                || location.contains("intermediate.html")
                || text.contains("ilcLearningGoals")
                || text.contains("mindsOn") {
                lessonHTML = text
            } else if fallbackHTML.isEmpty, text.contains("<body") || text.contains("<main") {
                fallbackHTML = text
            }
        }

        let html = lessonHTML.isEmpty ? fallbackHTML : lessonHTML
        guard !html.isEmpty else { return nil }
        guard UInt64(html.utf8.count) <= limits.maxHTMLBytes else {
            throw IngestError.archiveBoundsExceeded(
                url.lastPathComponent,
                "MHTML lesson HTML exceeded \(limits.maxHTMLBytes) bytes"
            )
        }
        let metadata = LessonMetadataParser.parse(filename: url.lastPathComponent, html: html)
        return ExtractedLessonPackage(
            packageFilename: url.lastPathComponent,
            packageKind: .mhtml,
            html: html,
            htmlPath: url.lastPathComponent,
            title: metadata.title,
            unitNumber: metadata.unitNumber,
            lessonNumber: metadata.lessonNumber,
            activityCode: metadata.activityCode,
            isAssignment: metadata.isAssignment,
            assets: assetStore.assets
        )
    }

    // MARK: - HTML + companion folder

    private func extractHTML(_ url: URL, assetStore: CourseAssetStore) throws -> ExtractedLessonPackage? {
        let declaredSize = UInt64((try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0)
        guard declaredSize <= limits.maxHTMLBytes else {
            throw IngestError.archiveBoundsExceeded(
                url.lastPathComponent,
                "standalone HTML exceeds \(limits.maxHTMLBytes) bytes"
            )
        }
        guard declaredSize <= limits.maxPackageBytes else {
            throw IngestError.packageTooLarge(url.lastPathComponent, limits.maxPackageBytes)
        }
        let data = try Data(contentsOf: url)
        guard UInt64(data.count) <= limits.maxPackageBytes else {
            throw IngestError.packageTooLarge(url.lastPathComponent, limits.maxPackageBytes)
        }
        guard UInt64(data.count) <= limits.maxHTMLBytes else {
            throw IngestError.archiveBoundsExceeded(
                url.lastPathComponent,
                "standalone HTML exceeded \(limits.maxHTMLBytes) bytes"
            )
        }
        let html = HTMLTextDecoder.decode(data)
        let directory = url.deletingLastPathComponent()
        let stem = ((url.lastPathComponent as NSString).deletingPathExtension)
        var totalExtractedBytes = UInt64(data.count)

        let companionCandidates = [
            directory.appendingPathComponent("\(stem)_files", isDirectory: true),
            directory.appendingPathComponent("\(stem).files", isDirectory: true),
            directory.appendingPathComponent("assets", isDirectory: true),
            // Archived HTML packages copy their sibling `assets` folder under
            // the archived stem so it cannot collide with another package.
            directory.appendingPathComponent("\(stem)assets", isDirectory: true),
        ]
        for companion in companionCandidates {
            guard FileManager.default.fileExists(atPath: companion.path) else { continue }
            try extractCompanionDirectory(
                companion,
                relativeBase: companion.lastPathComponent,
                depth: 0,
                assetStore: assetStore,
                totalBytes: &totalExtractedBytes
            )
        }

        let metadata = LessonMetadataParser.parse(filename: url.lastPathComponent, html: html)
        return ExtractedLessonPackage(
            packageFilename: url.lastPathComponent,
            packageKind: .html,
            html: html,
            htmlPath: url.lastPathComponent,
            title: metadata.title,
            unitNumber: metadata.unitNumber,
            lessonNumber: metadata.lessonNumber,
            activityCode: metadata.activityCode,
            isAssignment: metadata.isAssignment,
            assets: assetStore.assets
        )
    }

    private func extractCompanionDirectory(
        _ directory: URL,
        relativeBase: String,
        depth: Int,
        assetStore: CourseAssetStore,
        totalBytes: inout UInt64
    ) throws {
        guard depth <= limits.maxCompanionDepth else { return }
        let contents = try FileManager.default.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: [.isDirectoryKey, .fileSizeKey],
            options: [.skipsHiddenFiles]
        )
        for file in contents {
            let isDirectory = (try? file.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) ?? false
            if isDirectory {
                try extractCompanionDirectory(
                    file,
                    relativeBase: "\(relativeBase)/\(file.lastPathComponent)",
                    depth: depth + 1,
                    assetStore: assetStore,
                    totalBytes: &totalBytes
                )
                continue
            }
            guard let category = AssetCategory(fileName: file.lastPathComponent) else { continue }
            let declaredSize = UInt64((try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0)
            guard declaredSize <= limits.maxEntryBytes else {
                throw IngestError.archiveBoundsExceeded(
                    file.lastPathComponent,
                    "companion file exceeds \(limits.maxEntryBytes) bytes"
                )
            }
            var data = try Data(contentsOf: file)
            let actualSize = UInt64(data.count)
            guard actualSize <= limits.maxEntryBytes else {
                throw IngestError.archiveBoundsExceeded(
                    file.lastPathComponent,
                    "companion file exceeded \(limits.maxEntryBytes) actual bytes"
                )
            }
            totalBytes += actualSize
            guard totalBytes <= limits.maxTotalUncompressedBytes else {
                throw IngestError.archiveBoundsExceeded(
                    directory.lastPathComponent,
                    "total companion bytes exceeded \(limits.maxTotalUncompressedBytes)"
                )
            }
            if category == .icons {
                data = SVGRepair.repair(data)
            }
            try assetStore.add(
                data: data,
                suggestedFilename: file.lastPathComponent,
                category: category,
                originalReferences: [
                    "\(relativeBase)/\(file.lastPathComponent)",
                    file.lastPathComponent,
                ]
            )
        }
    }

    // MARK: - Helpers

    private func isUnsafeEntryPath(_ path: String) -> Bool {
        if path.hasPrefix("/") || path.hasPrefix("\\") { return true }
        let components = path.split(whereSeparator: { $0 == "/" || $0 == "\\" })
        return components.contains("..")
    }

    private func captures(_ pattern: String, in text: String) -> [String]? {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else {
            return nil
        }
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        guard let match = regex.firstMatch(in: text, options: [], range: range) else { return nil }
        var output: [String] = []
        for index in 1..<match.numberOfRanges {
            if let groupRange = Range(match.range(at: index), in: text) {
                output.append(String(text[groupRange]))
            } else {
                output.append("")
            }
        }
        return output
    }
}
