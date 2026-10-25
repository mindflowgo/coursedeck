import CoreGraphics
import Foundation
import ImageIO

/// ImageIO compression settings, matching the desktop `imageOptimizer.ts`
/// (PLAN §4.11): resize wider-than-512 images to 512 px, JPEG quality 0.82,
/// and add a `|50%` spec when the natural display width exceeds
/// `READING_COLUMN_PX * 0.5` (360 px).
public struct ImageCompressionOptions: Equatable, Sendable {
    public var maxWidth: Int
    public var jpegQuality: Double
    public var readingColumnWidth: Double
    public var maxDisplayFraction: Double

    public init(
        maxWidth: Int = 512,
        jpegQuality: Double = 0.82,
        readingColumnWidth: Double = 720,
        maxDisplayFraction: Double = 0.5
    ) {
        self.maxWidth = maxWidth
        self.jpegQuality = jpegQuality
        self.readingColumnWidth = readingColumnWidth
        self.maxDisplayFraction = maxDisplayFraction
    }

    public var halfWidthThreshold: Double {
        readingColumnWidth * maxDisplayFraction
    }
}

public struct ImageOptimizeSummary: Equatable, Sendable {
    public var scanned: Int
    public var converted: Int
    /// Re-extracted source bytes whose existing JPEG derivative was reused.
    public var reused: Int
    public var skippedSmall: Int
    public var bytesBefore: Int
    public var bytesAfter: Int
    public var markdownFilesUpdated: Int
    public var markdownRefsUpdated: Int
    public var warnings: [String]

    public init(
        scanned: Int = 0,
        converted: Int = 0,
        reused: Int = 0,
        skippedSmall: Int = 0,
        bytesBefore: Int = 0,
        bytesAfter: Int = 0,
        markdownFilesUpdated: Int = 0,
        markdownRefsUpdated: Int = 0,
        warnings: [String] = []
    ) {
        self.scanned = scanned
        self.converted = converted
        self.reused = reused
        self.skippedSmall = skippedSmall
        self.bytesBefore = bytesBefore
        self.bytesAfter = bytesAfter
        self.markdownFilesUpdated = markdownFilesUpdated
        self.markdownRefsUpdated = markdownRefsUpdated
        self.warnings = warnings
    }
}

public enum ImageOptimizeError: Error, LocalizedError, Equatable {
    case unreadable(String)
    case encodeFailed(String)

    public var errorDescription: String? {
        switch self {
        case let .unreadable(name): return "\(name) could not be read as an image."
        case let .encodeFailed(name): return "\(name) could not be encoded as JPEG."
        }
    }
}

/// Compresses course raster images and rewrites Markdown references.
///
/// This runs at the end of every ingest, exactly like the desktop. It is a
/// value type so it can be called from the `CourseIngestor` actor without
/// sharing ImageIO state.
public struct CourseImageOptimizer: Sendable {
    private struct Conversion {
        var fromKey: String
        var toKey: String
        var samePath: Bool
    }

    struct ImageRecord {
        var width: Int
        var height: Int
    }

    public let options: ImageCompressionOptions
    private let store: AtomicFileStore

    public init(
        options: ImageCompressionOptions = ImageCompressionOptions(),
        store: AtomicFileStore = AtomicFileStore()
    ) {
        self.options = options
        self.store = store
    }

    public func optimize(courseDirectory: URL) throws -> ImageOptimizeSummary {
        var summary = ImageOptimizeSummary()
        let imgDirectory = courseDirectory
            .appendingPathComponent("assets", isDirectory: true)
            .appendingPathComponent("img", isDirectory: true)
        guard FileManager.default.fileExists(atPath: imgDirectory.path) else {
            return summary
        }

        let files = (try? FileManager.default.contentsOfDirectory(
            at: imgDirectory,
            includingPropertiesForKeys: [.isRegularFileKey],
            options: [.skipsHiddenFiles]
        )) ?? []
        let rasters = files.filter {
            let ext = $0.pathExtension.lowercased()
            return ["jpg", "jpeg", "png"].contains(ext)
                && (try? $0.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true
        }
        summary.scanned = rasters.count

        // Non-hidden so the backup allowlist exports it and a restore keeps
        // the source-hash→JPEG mapping (it contains only hashes and names).
        let mapURL = imgDirectory.appendingPathComponent("image-optimizer.json")
        var imageMap = loadImageMap(at: mapURL)
        var imageMapChanged = false
        var records: [String: ImageRecord] = [:]
        var renameMap: [String: String] = [:]
        var conversions: [Conversion] = []

        for file in rasters {
            let fileName = file.lastPathComponent
            do {
                guard let size = Self.imageSize(file), size.width > 0, size.height > 0 else {
                    summary.warnings.append("Skipped unreadable image \(fileName)")
                    continue
                }
                let fromKey = "img/\(fileName)".lowercased()
                if size.width <= options.maxWidth {
                    records[fromKey] = size
                    summary.skippedSmall += 1
                    continue
                }

                let sourceData = try store.read(file)
                let sourceHash = SHA256.hex(sourceData)

                // A re-extracted package recreates the original PNG. If the
                // same source bytes already produced a JPEG, reuse it instead
                // of creating `diagram-2.jpg` on every ingest.
                if let mappedTarget = imageMap[sourceHash] {
                    let targetURL = imgDirectory.appendingPathComponent(mappedTarget)
                    if store.exists(targetURL) {
                        let targetSize = Self.imageSize(targetURL)
                        let toKey = "img/\(mappedTarget)".lowercased()
                        records[toKey] = ImageRecord(
                            width: targetSize?.width ?? min(size.width, options.maxWidth),
                            height: targetSize?.height ?? size.height
                        )
                        summary.reused += 1
                        if mappedTarget != fileName {
                            renameMap[fromKey] = toKey
                            conversions.append(
                                Conversion(fromKey: fromKey, toKey: toKey, samePath: false)
                            )
                        } else {
                            conversions.append(
                                Conversion(fromKey: fromKey, toKey: toKey, samePath: true)
                            )
                        }
                        continue
                    }
                    imageMap.removeValue(forKey: sourceHash)
                    imageMapChanged = true
                }

                let bytesBefore = (try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
                let jpeg = try Self.compressJPEG(
                    file,
                    maxWidth: options.maxWidth,
                    quality: options.jpegQuality
                )
                let targetName = uniqueTargetName(for: fileName, in: imgDirectory)
                let targetURL = imgDirectory.appendingPathComponent(targetName)
                try store.write(jpeg, to: targetURL)
                imageMap[sourceHash] = targetName
                imageMapChanged = true

                let toKey = "img/\(targetName)".lowercased()
                records[toKey] = ImageRecord(width: min(size.width, options.maxWidth), height: size.height)
                summary.converted += 1
                summary.bytesBefore += bytesBefore
                summary.bytesAfter += jpeg.count

                if targetName != fileName {
                    renameMap[fromKey] = toKey
                    conversions.append(Conversion(fromKey: fromKey, toKey: toKey, samePath: false))
                } else {
                    conversions.append(Conversion(fromKey: fromKey, toKey: toKey, samePath: true))
                }
            } catch {
                summary.warnings.append("Could not optimize \(fileName): \(error.localizedDescription)")
            }
        }

        if imageMapChanged {
            imageMap = imageMap.filter { store.exists(imgDirectory.appendingPathComponent($0.value)) }
            do {
                try saveImageMap(imageMap, at: mapURL)
            } catch {
                summary.warnings.append(
                    "Could not save the image optimization map: \(error.localizedDescription)"
                )
            }
        }

        // Rewrite every Markdown file in the course root. The image regex only
        // touches `![alt|spec](assets/...)`, so table pipes and math stay put.
        let markdownFiles = ((try? FileManager.default.contentsOfDirectory(
            at: courseDirectory,
            includingPropertiesForKeys: [.isRegularFileKey],
            options: [.skipsHiddenFiles]
        )) ?? []).filter {
            $0.pathExtension.lowercased() == "md"
                && (try? $0.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true
        }

        for markdown in markdownFiles {
            guard let original = try? store.readString(markdown) else { continue }
            let (rewritten, count) = Self.rewriteMarkdown(
                original,
                renameMap: renameMap,
                widths: records.mapValues { $0.width },
                options: options
            )
            if rewritten != original {
                do {
                    try store.write(rewritten, to: markdown)
                    summary.markdownFilesUpdated += 1
                    summary.markdownRefsUpdated += count
                } catch {
                    summary.warnings.append("Could not rewrite \(markdown.lastPathComponent): \(error.localizedDescription)")
                }
            }
        }

        // Delete originals only after every Markdown rewrite succeeded and no
        // reference still points at them.
        let currentMarkdown = ((try? FileManager.default.contentsOfDirectory(
            at: courseDirectory,
            includingPropertiesForKeys: [.isRegularFileKey],
            options: [.skipsHiddenFiles]
        )) ?? []).compactMap { url -> String? in
            guard url.pathExtension.lowercased() == "md",
                  (try? url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true else {
                return nil
            }
            return try? store.readString(url)
        }

        for conversion in conversions where !conversion.samePath {
            let originalURL = courseDirectory.appendingPathComponent("assets/\(conversion.fromKey)")
            let targetURL = courseDirectory.appendingPathComponent("assets/\(conversion.toKey)")
            guard store.exists(targetURL), store.exists(originalURL) else { continue }
            let needle = conversion.fromKey.lowercased()
            let stillReferenced = currentMarkdown.contains { text in
                text.lowercased().contains(needle)
            }
            if stillReferenced {
                summary.warnings.append(
                    "Kept \(conversion.fromKey) because a Markdown file still references it."
                )
                continue
            }
            do {
                try FileManager.default.removeItem(at: originalURL)
            } catch {
                summary.warnings.append("Could not remove \(conversion.fromKey): \(error.localizedDescription)")
            }
        }

        return summary
    }

    // MARK: - Source-hash map

    /// Maps SHA-256 of the original source bytes to the JPEG derivative name.
    /// The hidden file is ignored by the raster enumeration and by Markdown
    /// scans; it is a rebuildable cache, not course content.
    private func loadImageMap(at url: URL) -> [String: String] {
        guard let json = try? store.readJSON(url),
              case let .object(members) = json else {
            return [:]
        }
        var output: [String: String] = [:]
        for member in members {
            if let value = member.value.stringValue {
                output[member.key] = value
            }
        }
        return output
    }

    private func saveImageMap(_ map: [String: String], at url: URL) throws {
        let members = map.keys.sorted().compactMap { key -> JSONMember? in
            guard let value = map[key] else { return nil }
            return JSONMember(key: key, value: .string(value))
        }
        try store.writeJSON(.object(members), to: url, pretty: false)
    }

    // MARK: - Naming

    private func uniqueTargetName(for fileName: String, in directory: URL) -> String {
        let base = (fileName as NSString).deletingPathExtension
        let fileManager = FileManager.default
        var target = "\(base).jpg"
        var index = 2
        while fileManager.fileExists(atPath: directory.appendingPathComponent(target).path),
              target != fileName,
              index < 10_000 {
            target = "\(base)-\(index).jpg"
            index += 1
        }
        return target
    }

    // MARK: - ImageIO

    static func imageSize(_ url: URL) -> ImageRecord? {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any] else {
            return nil
        }
        let width = (properties[kCGImagePropertyPixelWidth] as? NSNumber)?.intValue ?? 0
        let height = (properties[kCGImagePropertyPixelHeight] as? NSNumber)?.intValue ?? 0
        guard width > 0, height > 0 else { return nil }
        return ImageRecord(width: width, height: height)
    }

    static func compressJPEG(_ url: URL, maxWidth: Int, quality: Double) throws -> Data {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil) else {
            throw ImageOptimizeError.unreadable(url.lastPathComponent)
        }
        let thumbnailOptions: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxWidth,
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(
            source,
            0,
            thumbnailOptions as CFDictionary
        ) else {
            throw ImageOptimizeError.unreadable(url.lastPathComponent)
        }

        let tempURL = url.deletingLastPathComponent()
            .appendingPathComponent(".imgopt-\(UUID().uuidString).jpg")
        defer { try? FileManager.default.removeItem(at: tempURL) }
        guard let destination = CGImageDestinationCreateWithURL(
            tempURL as CFURL,
            "public.jpeg" as CFString,
            1,
            nil
        ) else {
            throw ImageOptimizeError.encodeFailed(url.lastPathComponent)
        }
        let properties: [CFString: Any] = [
            kCGImageDestinationLossyCompressionQuality: quality,
        ]
        CGImageDestinationAddImage(destination, image, properties as CFDictionary)
        guard CGImageDestinationFinalize(destination) else {
            throw ImageOptimizeError.encodeFailed(url.lastPathComponent)
        }
        return try Data(contentsOf: tempURL)
    }

    // MARK: - Markdown rewrite

    static func rewriteMarkdown(
        _ markdown: String,
        renameMap: [String: String],
        widths: [String: Int],
        options: ImageCompressionOptions
    ) -> (text: String, refsUpdated: Int) {
        let masked = MarkdownCodeMask.protect(markdown)
        guard let regex = try? NSRegularExpression(
            pattern: "!\\[([^\\]]*)\\]\\(([^)\\s]+)\\)(\\s*\\{([^}]*)\\})?"
        ) else {
            return (markdown, 0)
        }

        let text = masked.text
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        var output = ""
        var last = text.startIndex
        var updated = 0

        for match in regex.matches(in: text, options: [], range: range) {
            guard let fullRange = Range(match.range, in: text),
                  let altRange = Range(match.range(at: 1), in: text),
                  let urlRange = Range(match.range(at: 2), in: text) else {
                continue
            }
            let attrRange: Range<String.Index>? = match.range(at: 4).location != NSNotFound
                ? Range(match.range(at: 4), in: text)
                : nil

            output += String(text[last..<fullRange.lowerBound])
            let alt = String(text[altRange])
            let url = String(text[urlRange])
            let attr = attrRange.map { String(text[$0]) }
            let original = String(text[fullRange])
            let replacement = rewriteReference(
                alt: alt,
                url: url,
                attr: attr,
                renameMap: renameMap,
                widths: widths,
                options: options
            )
            if replacement != original { updated += 1 }
            output += replacement
            last = fullRange.upperBound
        }
        output += String(text[last...])
        return (MarkdownCodeMask.restore(output, tokens: masked.tokens), updated)
    }

    static func rewriteReference(
        alt rawAlt: String,
        url: String,
        attr: String?,
        renameMap: [String: String],
        widths: [String: Int],
        options: ImageCompressionOptions
    ) -> String {
        let original = "![\(rawAlt)](\(url))" + (attr.map { " {\($0)}" } ?? "")
        guard let key = assetKey(from: url) else { return original }

        var alt = rawAlt
        var spec: String?
        if let pipeIndex = alt.lastIndex(of: "|") {
            spec = alt[alt.index(after: pipeIndex)...].trimmingCharacters(in: .whitespaces)
            alt = String(alt[..<pipeIndex]).trimmingCharacters(in: .whitespaces)
        }

        if let attr, let width = widthFromAttribute(attr) {
            spec = width
        }

        let renamedKey = renameMap[key.lowercased()] ?? key
        let urlChanged = renamedKey != key
        let finalURL = urlChanged ? "./assets/\(renamedKey)" : url

        let naturalWidth = widths[renamedKey.lowercased()]
        let displayPixels = spec.flatMap { displayWidthPixels($0, options: options) }
            ?? naturalWidth.map(Double.init)
        var specChanged = false
        if let displayPixels, displayPixels > options.halfWidthThreshold {
            if spec != "50%" {
                spec = "50%"
                specChanged = true
            }
        }

        if !urlChanged && !specChanged && attr == nil { return original }
        let specPart = spec.map { "|\($0)" } ?? ""
        return "![\(alt)\(specPart)](\(finalURL))"
    }

    static func assetKey(from url: String) -> String? {
        let lower = url.lowercased()
        let rawKey: String
        if lower.hasPrefix("./assets/") {
            rawKey = String(url.dropFirst(9))
        } else if lower.hasPrefix("assets/") {
            rawKey = String(url.dropFirst(7))
        } else {
            return nil
        }
        guard !rawKey.isEmpty,
              !rawKey.contains("?"),
              !rawKey.contains("#") else { return nil }
        return rawKey.replacingOccurrences(of: "\\", with: "/")
    }

    static func widthFromAttribute(_ attr: String) -> String? {
        guard let regex = try? NSRegularExpression(
            pattern: "width\\s*=\\s*['\"]?([\\d.]+)(%|px)?",
            options: [.caseInsensitive]
        ) else { return nil }
        let range = NSRange(attr.startIndex..<attr.endIndex, in: attr)
        guard let match = regex.firstMatch(in: attr, options: [], range: range),
              match.numberOfRanges > 1,
              let valueRange = Range(match.range(at: 1), in: attr) else {
            return nil
        }
        let value = String(attr[valueRange])
        let unit = match.range(at: 2).location != NSNotFound
            ? Range(match.range(at: 2), in: attr).map { String(attr[$0]) } ?? ""
            : ""
        return unit == "%" ? "\(value)%" : "\(value)px"
    }

    /// Port of the desktop `specDisplayWidthPx`.
    static func displayWidthPixels(_ spec: String, options: ImageCompressionOptions) -> Double? {
        let value = spec.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !value.isEmpty else { return nil }
        switch value {
        case "xs", "thumb": return 160
        case "sm", "small": return 280
        case "md", "medium": return 480
        case "lg", "large": return 720
        case "full", "xl": return options.readingColumnWidth
        default: break
        }

        if let match = firstMatch("(?:width|w)=([0-9]+(?:\\.[0-9]+)?)(%|px|rem)?", in: value),
           match.count >= 1 {
            let amount = Double(match[0]) ?? 0
            let unit = match.count > 1 ? match[1] : ""
            if unit == "%" { return amount / 100 * options.readingColumnWidth }
            return amount * (unit == "rem" ? 16 : 1)
        }
        if let match = firstMatch("^(\\d+(?:px|%|rem)?)\\s*x\\s*\\d+", in: value), let first = match.first {
            if first.hasSuffix("%") { return options.readingColumnWidth }
            let amount = Double(first.replacingOccurrences(of: "px", with: "")
                .replacingOccurrences(of: "rem", with: "")) ?? 0
            return amount * (first.hasSuffix("rem") ? 16 : 1)
        }
        if value.range(of: "^\\d+(?:\\.\\d+)?%$", options: .regularExpression) != nil {
            let amount = Double(value.dropLast()) ?? 0
            return amount / 100 * options.readingColumnWidth
        }
        if value.range(of: "^\\d+(?:\\.\\d+)?$", options: .regularExpression) != nil {
            return Double(value)
        }
        return nil
    }

    private static func firstMatch(_ pattern: String, in text: String) -> [String]? {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else {
            return nil
        }
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        guard let match = regex.firstMatch(in: text, options: [], range: range) else {
            return nil
        }
        var groups: [String] = []
        for index in 1..<match.numberOfRanges {
            if let groupRange = Range(match.range(at: index), in: text) {
                groups.append(String(text[groupRange]))
            } else {
                groups.append("")
            }
        }
        return groups
    }
}

/// Masks fenced and inline code before the image regex runs, so a code sample
/// containing `![...](...)` is never rewritten.
enum MarkdownCodeMask {
    struct Masked {
        var text: String
        var tokens: [String]
    }

    static func protect(_ markdown: String) -> Masked {
        var tokens: [String] = []
        var lines: [String] = []
        var fence: String?
        var buffer: [String] = []

        func placeholder(_ value: String) -> String {
            let index = tokens.count
            tokens.append(value)
            return "\u{0001}CDCODE\(index)\u{0002}"
        }

        for line in markdown.components(separatedBy: "\n") {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if let currentFence = fence {
                buffer.append(line)
                if trimmed.hasPrefix(currentFence) {
                    lines.append(placeholder(buffer.joined(separator: "\n")))
                    buffer = []
                    fence = nil
                }
                continue
            }
            if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
                fence = String(trimmed.prefix(3))
                buffer = [line]
                continue
            }
            // Inline code spans.
            lines.append(protectInlineCode(in: line, placeholder: placeholder))
        }
        if let currentFence = fence, !buffer.isEmpty {
            // Unterminated fence: protect what we have rather than mangling it.
            lines.append(placeholder(buffer.joined(separator: "\n")))
            _ = currentFence
        }

        return Masked(text: lines.joined(separator: "\n"), tokens: tokens)
    }

    static func restore(_ text: String, tokens: [String]) -> String {
        var output = text
        for (index, token) in tokens.enumerated() {
            output = output.replacingOccurrences(
                of: "\u{0001}CDCODE\(index)\u{0002}",
                with: token
            )
        }
        return output
    }

    private static func protectInlineCode(
        in line: String,
        placeholder: (String) -> String
    ) -> String {
        guard let regex = try? NSRegularExpression(pattern: "`{1,3}[^`\\n]*`{1,3}") else {
            return line
        }
        let range = NSRange(line.startIndex..<line.endIndex, in: line)
        var output = ""
        var last = line.startIndex
        for match in regex.matches(in: line, options: [], range: range) {
            guard let full = Range(match.range, in: line) else { continue }
            output += String(line[last..<full.lowerBound])
            output += placeholder(String(line[full]))
            last = full.upperBound
        }
        output += String(line[last...])
        return output
    }
}
