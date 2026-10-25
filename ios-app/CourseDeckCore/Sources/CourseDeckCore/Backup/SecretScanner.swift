import Foundation
import ZIPFoundation

public struct SecretMatch: Equatable, Sendable {
    public var pattern: String
    public var byteOffset: Int

    public init(pattern: String, byteOffset: Int) {
        self.pattern = pattern
        self.byteOffset = byteOffset
    }
}

public enum SecretScanError: Error, LocalizedError, Equatable {
    case boundsExceeded(path: String, reason: String)
    case unreadable(String)

    public var errorDescription: String? {
        switch self {
        case let .boundsExceeded(path, reason): return "Scan bounds exceeded for \(path): \(reason)"
        case let .unreadable(reason): return "Could not scan secret file: \(reason)"
        }
    }
}

/// Content scanner for API keys, tokens, and private keys.
///
/// A path-only denylist cannot cover the 79 raw ZIPs and 29 MHTML captures in
/// `_backup/`, so exports scan file content as well. Nested archives get
/// explicit bounds (entry count, decompressed bytes, depth, deadline) and fail
/// the include-raw export when a capture cannot be scanned — they are never
/// silently skipped (PLAN §4.1).
public struct SecretScanner: Sendable {
    public struct ScanLimits: Equatable, Sendable {
        public var maxArchiveEntries: Int
        public var maxNestedEntries: Int
        public var maxNestedUncompressedBytes: UInt64
        public var maxDepth: Int
        /// Deadline for a nested capture/package scan.
        public var deadlineSeconds: TimeInterval
        /// Deadline for scanning a full exported archive (may be hundreds of MB).
        public var archiveDeadlineSeconds: TimeInterval
        public var maxFileBytes: UInt64

        public init(
            maxArchiveEntries: Int = 200_000,
            maxNestedEntries: Int = 512,
            maxNestedUncompressedBytes: UInt64 = 64 * 1024 * 1024,
            maxDepth: Int = 2,
            deadlineSeconds: TimeInterval = 10,
            archiveDeadlineSeconds: TimeInterval = 900,
            maxFileBytes: UInt64 = 512 * 1024 * 1024
        ) {
            self.maxArchiveEntries = maxArchiveEntries
            self.maxNestedEntries = maxNestedEntries
            self.maxNestedUncompressedBytes = maxNestedUncompressedBytes
            self.maxDepth = maxDepth
            self.deadlineSeconds = deadlineSeconds
            self.archiveDeadlineSeconds = archiveDeadlineSeconds
            self.maxFileBytes = maxFileBytes
        }
    }

    public let limits: ScanLimits

    public init(limits: ScanLimits = ScanLimits()) {
        self.limits = limits
    }

    // MARK: - Public entry points

    /// Scans a regular file in bounded chunks. A `.zip` file is scanned
    /// recursively; MHTML is MIME-decoded (quoted-printable/base64) before
    /// scanning; everything else is byte-scanned.
    public func scanFile(at url: URL, depth: Int = 0) throws -> SecretMatch? {
        let ext = url.pathExtension.lowercased()
        if ext == "zip" {
            return try scanNestedArchive(at: url, depth: depth)
        }
        if ext == "mhtml" || ext == "mht" {
            let size = UInt64((try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0)
            guard size <= limits.maxFileBytes else {
                throw SecretScanError.boundsExceeded(
                    path: url.lastPathComponent,
                    reason: "MHTML exceeds \(limits.maxFileBytes) bytes"
                )
            }
            return try scanMHTML(data: Data(contentsOf: url), path: url.lastPathComponent)
        }
        return try scanStream(at: url)
    }

    /// Byte-level scan of in-memory data (small files, staged metadata).
    public func firstMatch(in data: Data) -> SecretMatch? {
        Self.firstMatch(bytes: [UInt8](data))
    }

    public func firstMatch(in string: String) -> SecretMatch? {
        firstMatch(in: Data(string.utf8))
    }

    // MARK: - Stream scanning

    private func scanStream(at url: URL) throws -> SecretMatch? {
        let handle: FileHandle
        do {
            handle = try FileHandle(forReadingFrom: url)
        } catch {
            throw SecretScanError.unreadable("\(url.lastPathComponent): \(error)")
        }
        defer { try? handle.close() }

        let chunkSize = 256 * 1024
        let overlap = 16 * 1024
        var carry = Data()
        var total: UInt64 = 0
        while true {
            let chunk = try handle.read(upToCount: chunkSize) ?? Data()
            if chunk.isEmpty { break }
            total += UInt64(chunk.count)
            if total > limits.maxFileBytes {
                throw SecretScanError.boundsExceeded(
                    path: url.lastPathComponent,
                    reason: "file exceeds \(limits.maxFileBytes) bytes"
                )
            }
            var combined = carry
            combined.append(chunk)
            if let match = firstMatch(in: combined) {
                return match
            }
            carry = Data(combined.suffix(overlap))
        }
        return nil
    }

    // MARK: - Nested archives

    private func scanNestedArchive(at url: URL, depth: Int) throws -> SecretMatch? {
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

        let deadline = Date().addingTimeInterval(limits.deadlineSeconds)
        var entryCount = 0
        var actualScanned: UInt64 = 0

        for entry in archive {
            entryCount += 1
            if entryCount > limits.maxNestedEntries {
                throw SecretScanError.boundsExceeded(
                    path: url.lastPathComponent,
                    reason: "more than \(limits.maxNestedEntries) entries"
                )
            }
            if Date() > deadline {
                throw SecretScanError.boundsExceeded(
                    path: url.lastPathComponent,
                    reason: "scan deadline of \(limits.deadlineSeconds)s reached"
                )
            }
            guard entry.type == .file else { continue }

            // Declared sizes are only a cheap early reject. The authoritative
            // checks count bytes actually produced by the decompressor.
            guard entry.uncompressedSize <= limits.maxNestedUncompressedBytes else {
                throw SecretScanError.boundsExceeded(
                    path: url.lastPathComponent,
                    reason: "entry \(entry.path) declares more than \(limits.maxNestedUncompressedBytes) bytes"
                )
            }

            let entryPath = entry.path.lowercased()
            if entryPath.hasSuffix(".zip") {
                let nestedURL = FileManager.default.temporaryDirectory
                    .appendingPathComponent("cdscan-\(UUID().uuidString).zip")
                defer { try? FileManager.default.removeItem(at: nestedURL) }
                var nestedData = Data()
                var entryBytes: UInt64 = 0
                _ = try archive.extract(entry, skipCRC32: true) { chunk in
                    let count = UInt64(chunk.count)
                    entryBytes += count
                    actualScanned += count
                    guard entryBytes <= limits.maxNestedUncompressedBytes,
                          actualScanned <= limits.maxNestedUncompressedBytes else {
                        throw SecretScanError.boundsExceeded(
                            path: entry.path,
                            reason: "nested ZIP exceeds actual scan bounds"
                        )
                    }
                    nestedData.append(chunk)
                }
                try nestedData.write(to: nestedURL, options: .atomic)
                if let match = try scanNestedArchive(at: nestedURL, depth: depth + 1) {
                    return match
                }
                continue
            }
            if entryPath.hasSuffix(".mhtml") || entryPath.hasSuffix(".mht") {
                var data = Data()
                var entryBytes: UInt64 = 0
                _ = try archive.extract(entry, skipCRC32: true) { chunk in
                    let count = UInt64(chunk.count)
                    entryBytes += count
                    actualScanned += count
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
                    return match
                }
                continue
            }

            if let match = try scanEntry(
                entry,
                in: archive,
                actualBytes: &actualScanned,
                perEntryLimit: limits.maxNestedUncompressedBytes,
                cumulativeLimit: limits.maxNestedUncompressedBytes
            ) {
                return match
            }
        }
        return nil
    }

    /// Streams one archive entry through the byte scanner without materializing
    /// it. Throws a private stop error as soon as a match is found.
    func scanEntry(
        _ entry: Entry,
        in archive: Archive,
        actualBytes: inout UInt64,
        perEntryLimit: UInt64,
        cumulativeLimit: UInt64?
    ) throws -> SecretMatch? {
        var carry = Data()
        var match: SecretMatch?
        var entryBytes: UInt64 = 0
        do {
            _ = try archive.extract(entry, skipCRC32: true) { chunk in
                let count = UInt64(chunk.count)
                entryBytes += count
                actualBytes += count
                guard entryBytes <= perEntryLimit else {
                    throw SecretScanError.boundsExceeded(
                        path: entry.path,
                        reason: "entry exceeds \(perEntryLimit) actual bytes"
                    )
                }
                if let cumulativeLimit, actualBytes > cumulativeLimit {
                    throw SecretScanError.boundsExceeded(
                        path: entry.path,
                        reason: "cumulative scan bytes exceed \(cumulativeLimit)"
                    )
                }
                var combined = carry
                combined.append(chunk)
                if let found = Self.firstMatch(bytes: [UInt8](combined)) {
                    match = found
                    throw ScanStop()
                }
                carry = Data(combined.suffix(16 * 1024))
            }
        } catch is ScanStop {
            // `match` is set; return it below.
        }
        return match
    }

    private struct ScanStop: Error {}

    // MARK: - Pattern engine (byte-level so binary capture files scan too)

    private struct PrefixPattern {
        let label: String
        let prefix: [UInt8]
        let minimumTail: Int
    }

    private static let prefixPatterns: [PrefixPattern] = [
        PrefixPattern(label: "openai-api-key", prefix: Array("sk-".utf8), minimumTail: 20),
        PrefixPattern(label: "google-api-key", prefix: Array("AIza".utf8), minimumTail: 35),
        PrefixPattern(label: "github-token", prefix: Array("ghp_".utf8), minimumTail: 20),
        PrefixPattern(label: "github-pat", prefix: Array("github_pat_".utf8), minimumTail: 20),
        PrefixPattern(label: "slack-token", prefix: Array("xoxb-".utf8), minimumTail: 10),
        PrefixPattern(label: "slack-token", prefix: Array("xoxp-".utf8), minimumTail: 10),
        PrefixPattern(label: "slack-token", prefix: Array("xoxa-".utf8), minimumTail: 10),
        PrefixPattern(label: "slack-token", prefix: Array("xoxr-".utf8), minimumTail: 10),
        PrefixPattern(label: "slack-token", prefix: Array("xoxs-".utf8), minimumTail: 10),
        PrefixPattern(label: "private-key", prefix: Array("-----BEGIN PRIVATE KEY-----".utf8), minimumTail: 0),
        PrefixPattern(label: "private-key", prefix: Array("-----BEGIN RSA PRIVATE KEY-----".utf8), minimumTail: 0),
        PrefixPattern(label: "private-key", prefix: Array("-----BEGIN OPENSSH PRIVATE KEY-----".utf8), minimumTail: 0),
    ]

    private static let jsonSecretKeys: [String] = [
        "\"apiKey\"", "\"api_key\"", "\"refresh_token\"", "\"client_secret\"", "\"password\"",
    ]

    static func firstMatch(bytes: [UInt8]) -> SecretMatch? {
        for pattern in prefixPatterns {
            var searchStart = 0
            while let found = find(pattern.prefix, in: bytes, from: searchStart) {
                if pattern.minimumTail == 0 {
                    return SecretMatch(pattern: pattern.label, byteOffset: found)
                }
                var cursor = found + pattern.prefix.count
                var tail = 0
                while cursor < bytes.count && isTokenByte(bytes[cursor]) {
                    tail += 1
                    cursor += 1
                }
                if tail >= pattern.minimumTail {
                    return SecretMatch(pattern: pattern.label, byteOffset: found)
                }
                searchStart = found + 1
            }
        }

        if let bearer = bearerMatch(bytes: bytes) {
            return bearer
        }

        for key in jsonSecretKeys {
            let needle = Array(key.utf8)
            var searchStart = 0
            while let found = find(needle, in: bytes, from: searchStart) {
                if let match = jsonValueMatch(bytes: bytes, keyEnd: found + needle.count, key: key) {
                    return match
                }
                searchStart = found + 1
            }
        }
        return nil
    }

    private static func bearerMatch(bytes: [UInt8]) -> SecretMatch? {
        let needle = Array("Bearer ".utf8)
        var searchStart = 0
        while let found = find(needle, in: bytes, from: searchStart) {
            var cursor = found + needle.count
            var length = 0
            while cursor < bytes.count && isTokenByte(bytes[cursor]) {
                length += 1
                cursor += 1
            }
            if length >= 20 {
                return SecretMatch(pattern: "bearer-token", byteOffset: found)
            }
            searchStart = found + 1
        }
        return nil
    }

    /// Matches `"apiKey" : "non-empty-secret"` with at least eight characters.
    private static func jsonValueMatch(bytes: [UInt8], keyEnd: Int, key: String) -> SecretMatch? {
        var cursor = keyEnd
        skipWhitespace(bytes, &cursor)
        guard cursor < bytes.count, bytes[cursor] == UInt8(ascii: ":") else { return nil }
        cursor += 1
        skipWhitespace(bytes, &cursor)
        guard cursor < bytes.count, bytes[cursor] == UInt8(ascii: "\"") else { return nil }
        cursor += 1
        let valueStart = cursor
        while cursor < bytes.count {
            if bytes[cursor] == UInt8(ascii: "\\") {
                cursor += 2
                continue
            }
            if bytes[cursor] == UInt8(ascii: "\"") { break }
            cursor += 1
        }
        let length = cursor - valueStart
        guard length >= 8 else { return nil }
        return SecretMatch(pattern: "json-\(key.trimmingCharacters(in: CharacterSet(charactersIn: "\"")))", byteOffset: valueStart)
    }

    private static func skipWhitespace(_ bytes: [UInt8], _ cursor: inout Int) {
        while cursor < bytes.count, bytes[cursor] == 0x20 || bytes[cursor] == 0x09 || bytes[cursor] == 0x0A || bytes[cursor] == 0x0D {
            cursor += 1
        }
    }

    private static func isTokenByte(_ byte: UInt8) -> Bool {
        if byte >= 48 && byte <= 57 { return true }
        if byte >= 65 && byte <= 90 { return true }
        if byte >= 97 && byte <= 122 { return true }
        switch byte {
        case UInt8(ascii: "-"), UInt8(ascii: "_"), UInt8(ascii: "."), UInt8(ascii: "~"),
             UInt8(ascii: "+"), UInt8(ascii: "/"), UInt8(ascii: "="):
            return true
        default:
            return false
        }
    }

    private static func find(_ needle: [UInt8], in haystack: [UInt8], from start: Int) -> Int? {
        guard !needle.isEmpty, haystack.count >= needle.count else { return nil }
        var index = max(0, start)
        let limit = haystack.count - needle.count
        while index <= limit {
            if haystack[index] == needle[0] {
                var matched = true
                for offset in 1..<needle.count where haystack[index + offset] != needle[offset] {
                    matched = false
                    break
                }
                if matched { return index }
            }
            index += 1
        }
        return nil
    }
}
