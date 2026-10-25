import Foundation
import ZIPFoundation

public struct ArchiveSecretMatch: Equatable, Sendable {
    /// Entry path inside the archive (`nested.zip/inner/file.md` for a nested
    /// match).
    public var path: String
    public var match: SecretMatch

    public init(path: String, match: SecretMatch) {
        self.path = path
        self.match = match
    }
}

extension SecretScanner {
    /// Scans the *finished* archive (decompressed entry bytes), so an export
    /// verifies exactly what would leave the device even if source files were
    /// modified while the archive was being written.
    public func scanArchive(at url: URL) throws -> ArchiveSecretMatch? {
        try scanArchiveFile(url, depth: 0)
    }

    private func scanArchiveFile(_ url: URL, depth: Int) throws -> ArchiveSecretMatch? {
        guard depth < limits.maxDepth else {
            throw SecretScanError.boundsExceeded(
                path: url.lastPathComponent,
                reason: "nesting depth exceeds \(limits.maxDepth)"
            )
        }
        let archive: Archive
        do {
            archive = try Archive(url: url, accessMode: .read)
        } catch {
            throw SecretScanError.unreadable("\(url.lastPathComponent): not a readable ZIP")
        }

        let deadline = Date().addingTimeInterval(
            depth == 0 ? limits.archiveDeadlineSeconds : limits.deadlineSeconds
        )
        var count = 0
        var actualScanned: UInt64 = 0
        let entryLimit = depth == 0 ? limits.maxArchiveEntries : limits.maxNestedEntries
        for entry in archive {
            count += 1
            if count > entryLimit {
                throw SecretScanError.boundsExceeded(
                    path: url.lastPathComponent,
                    reason: "more than \(entryLimit) entries"
                )
            }
            if Date() > deadline {
                throw SecretScanError.boundsExceeded(
                    path: url.lastPathComponent,
                    reason: "scan deadline of \(limits.deadlineSeconds)s reached"
                )
            }
            guard entry.type == .file else { continue }

            let lowerPath = entry.path.lowercased()
            let isNestedArchive = lowerPath.hasSuffix(".zip")
            let isMHTML = lowerPath.hasSuffix(".mhtml") || lowerPath.hasSuffix(".mht")

            // Only entries extracted to a temp file need a hard size bound;
            // regular entries are streamed and may be large library assets.
            if isNestedArchive || isMHTML {
                guard entry.uncompressedSize <= limits.maxNestedUncompressedBytes else {
                    throw SecretScanError.boundsExceeded(
                        path: url.lastPathComponent,
                        reason: "entry \(entry.path) exceeds nested scan bounds"
                    )
                }
            } else {
                guard entry.uncompressedSize <= limits.maxFileBytes else {
                    throw SecretScanError.boundsExceeded(
                        path: url.lastPathComponent,
                        reason: "entry \(entry.path) exceeds scan bounds"
                    )
                }
            }

            if isNestedArchive {
                let tempURL = FileManager.default.temporaryDirectory
                    .appendingPathComponent("cdscan-\(UUID().uuidString).zip")
                defer { try? FileManager.default.removeItem(at: tempURL) }
                var nestedData = Data()
                var entryBytes: UInt64 = 0
                _ = try archive.extract(entry, skipCRC32: true) { chunk in
                    let byteCount = UInt64(chunk.count)
                    entryBytes += byteCount
                    actualScanned += byteCount
                    guard entryBytes <= limits.maxNestedUncompressedBytes,
                          actualScanned <= limits.maxNestedUncompressedBytes else {
                        throw SecretScanError.boundsExceeded(
                            path: entry.path,
                            reason: "nested ZIP exceeds actual scan bounds"
                        )
                    }
                    nestedData.append(chunk)
                }
                try nestedData.write(to: tempURL, options: .atomic)
                if let nested = try scanArchiveFile(tempURL, depth: depth + 1) {
                    return ArchiveSecretMatch(path: "\(entry.path)/\(nested.path)", match: nested.match)
                }
                continue
            }
            if isMHTML {
                var data = Data()
                var entryBytes: UInt64 = 0
                _ = try archive.extract(entry, skipCRC32: true) { chunk in
                    let byteCount = UInt64(chunk.count)
                    entryBytes += byteCount
                    actualScanned += byteCount
                    guard entryBytes <= limits.maxNestedUncompressedBytes,
                          actualScanned <= limits.maxNestedUncompressedBytes else {
                        throw SecretScanError.boundsExceeded(
                            path: entry.path,
                            reason: "MHTML exceeds actual scan bounds"
                        )
                    }
                    data.append(chunk)
                }
                if let match = try scanMHTML(data: data, path: entry.path) {
                    return ArchiveSecretMatch(path: entry.path, match: match)
                }
                continue
            }
            if let match = try scanEntry(
                entry,
                in: archive,
                actualBytes: &actualScanned,
                perEntryLimit: depth == 0 ? limits.maxFileBytes : limits.maxNestedUncompressedBytes,
                cumulativeLimit: depth == 0 ? nil : limits.maxNestedUncompressedBytes
            ) {
                return ArchiveSecretMatch(path: entry.path, match: match)
            }
        }
        return nil
    }

    // MARK: - MHTML / MIME decoding

    /// Decodes MHTML MIME parts (quoted-printable, base64, nested multipart)
    /// before scanning within explicit part/size/depth/deadline bounds.
    public func scanMHTML(data: Data, path: String = "mhtml") throws -> SecretMatch? {
        guard UInt64(data.count) <= limits.maxFileBytes else {
            throw SecretScanError.boundsExceeded(path: path, reason: "MHTML exceeds \(limits.maxFileBytes) bytes")
        }
        var budget = MIMEBudget()
        let deadline = Date().addingTimeInterval(limits.deadlineSeconds)
        return try scanMIMEPart(data, depth: 0, budget: &budget, deadline: deadline, path: path)
    }

    private struct MIMEBudget {
        var parts = 0
        var decodedBytes: UInt64 = 0
    }

    private func scanMIMEPart(
        _ data: Data,
        depth: Int,
        budget: inout MIMEBudget,
        deadline: Date,
        path: String
    ) throws -> SecretMatch? {
        if Date() > deadline {
            throw SecretScanError.boundsExceeded(path: path, reason: "MHTML scan deadline reached")
        }
        if depth > limits.maxDepth {
            throw SecretScanError.boundsExceeded(path: path, reason: "MIME nesting depth exceeded")
        }

        let (headers, body) = Self.splitMIMEHeaders(data)
        let contentType = headers["content-type"] ?? ""
        let encoding = headers["content-transfer-encoding"] ?? ""

        if contentType.lowercased().hasPrefix("multipart/"),
           let boundary = Self.boundary(from: contentType) {
            let parts = Self.splitMIMEParts(body, boundary: boundary)
            for part in parts {
                budget.parts += 1
                if budget.parts > limits.maxNestedEntries {
                    throw SecretScanError.boundsExceeded(path: path, reason: "too many MIME parts")
                }
                if let match = try scanMIMEPart(part, depth: depth + 1, budget: &budget, deadline: deadline, path: path) {
                    return match
                }
            }
        }

        let decoded = Self.decodeMIME(body, encoding: encoding)
        budget.decodedBytes += UInt64(decoded.count)
        guard budget.decodedBytes <= limits.maxNestedUncompressedBytes else {
            throw SecretScanError.boundsExceeded(path: path, reason: "decoded MHTML exceeds scan bounds")
        }
        if let match = Self.firstMatch(bytes: [UInt8](decoded)) {
            return match
        }
        // Also scan the undecoded part so plain-text captures are covered even
        // when the header lies about the encoding.
        if let match = Self.firstMatch(bytes: [UInt8](body)) {
            return match
        }
        // Headers can carry captured request credentials too.
        if let match = Self.firstMatch(bytes: [UInt8](data)) {
            return match
        }
        return nil
    }

    private static func splitMIMEHeaders(_ data: Data) -> (headers: [String: String], body: Data) {
        let crlf = Data("\r\n\r\n".utf8)
        let lf = Data("\n\n".utf8)
        let crlfRange = data.range(of: crlf)
        let lfRange = data.range(of: lf)
        let separator: Range<Data.Index>?
        if let crlfRange, let lfRange {
            separator = crlfRange.lowerBound <= lfRange.lowerBound ? crlfRange : lfRange
        } else {
            separator = crlfRange ?? lfRange
        }
        guard let separator else {
            return ([:], data)
        }
        let headerData = data.subdata(in: data.startIndex..<separator.lowerBound)
        let body = data.subdata(in: separator.upperBound..<data.endIndex)
        let headerText = String(decoding: headerData, as: UTF8.self)
        var headers: [String: String] = [:]
        var lastKey: String?
        for rawLine in headerText.components(separatedBy: "\n") {
            var line = rawLine
            if line.hasSuffix("\r") { line.removeLast() }
            if line.hasPrefix(" ") || line.hasPrefix("\t"), let key = lastKey {
                headers[key, default: ""] += " " + line.trimmingCharacters(in: .whitespaces)
                continue
            }
            guard let colon = line.firstIndex(of: ":") else { continue }
            let key = line[..<colon].trimmingCharacters(in: .whitespaces).lowercased()
            let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            headers[key] = value
            lastKey = key
        }
        return (headers, body)
    }

    private static func boundary(from contentType: String) -> String? {
        guard let regex = try? NSRegularExpression(
            pattern: "boundary\\s*=\\s*\"?([^\";\\r\\n]+)\"?",
            options: [.caseInsensitive]
        ) else { return nil }
        let range = NSRange(contentType.startIndex..<contentType.endIndex, in: contentType)
        guard let match = regex.firstMatch(in: contentType, options: [], range: range),
              match.numberOfRanges > 1,
              let valueRange = Range(match.range(at: 1), in: contentType) else { return nil }
        return String(contentType[valueRange]).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func splitMIMEParts(_ body: Data, boundary: String) -> [Data] {
        let text = String(decoding: body, as: UTF8.self)
        let marker = "--\(boundary)"
        let terminator = "--\(boundary)--"
        var parts: [Data] = []
        var current: [String] = []
        var collecting = false
        for rawLine in text.components(separatedBy: "\n") {
            var line = rawLine
            if line.hasSuffix("\r") { line.removeLast() }
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed == terminator {
                if collecting { parts.append(Data(current.joined(separator: "\n").utf8)) }
                collecting = false
                break
            }
            if trimmed == marker {
                if collecting { parts.append(Data(current.joined(separator: "\n").utf8)) }
                current = []
                collecting = true
                continue
            }
            if collecting { current.append(line) }
        }
        if collecting, !current.isEmpty {
            parts.append(Data(current.joined(separator: "\n").utf8))
        }
        return parts
    }

    private static func decodeMIME(_ body: Data, encoding: String) -> Data {
        let lower = encoding.lowercased()
        if lower.contains("base64") {
            let text = String(decoding: body, as: UTF8.self)
                .components(separatedBy: .whitespacesAndNewlines)
                .joined()
            if let decoded = Data(base64Encoded: text, options: [.ignoreUnknownCharacters]) {
                return decoded
            }
            return body
        }
        if lower.contains("quoted-printable") {
            return decodeQuotedPrintable(body)
        }
        return body
    }

    private static func decodeQuotedPrintable(_ data: Data) -> Data {
        let bytes = [UInt8](data)
        var output: [UInt8] = []
        var index = 0
        while index < bytes.count {
            if bytes[index] == UInt8(ascii: "=") {
                if index + 1 < bytes.count, bytes[index + 1] == 0x0A {
                    index += 2
                    continue
                }
                if index + 2 < bytes.count, bytes[index + 1] == 0x0D, bytes[index + 2] == 0x0A {
                    index += 3
                    continue
                }
                if index + 2 < bytes.count,
                   let high = Self.hexValue(bytes[index + 1]),
                   let low = Self.hexValue(bytes[index + 2]) {
                    output.append(high << 4 | low)
                    index += 3
                    continue
                }
            }
            output.append(bytes[index])
            index += 1
        }
        return Data(output)
    }

    private static func hexValue(_ byte: UInt8) -> UInt8? {
        switch byte {
        case UInt8(ascii: "0")...UInt8(ascii: "9"): return byte - UInt8(ascii: "0")
        case UInt8(ascii: "a")...UInt8(ascii: "f"): return byte - UInt8(ascii: "a") + 10
        case UInt8(ascii: "A")...UInt8(ascii: "F"): return byte - UInt8(ascii: "A") + 10
        default: return nil
        }
    }
}
