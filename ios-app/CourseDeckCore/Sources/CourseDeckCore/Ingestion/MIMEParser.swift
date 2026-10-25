import Foundation

public enum MIMEParseError: Error, LocalizedError, Equatable {
    case missingBoundary
    case noParts
    case malformed(String)
    case limitsExceeded(String)

    public var errorDescription: String? {
        switch self {
        case .missingBoundary: return "The MHTML file has no multipart boundary."
        case .noParts: return "The MHTML file contains no MIME parts."
        case let .malformed(reason): return "The MHTML file is malformed: \(reason)"
        case let .limitsExceeded(reason): return "The MHTML file exceeds safe decode bounds: \(reason)"
        }
    }
}

/// Bounds applied while MIME parts are decoded, before a caller can use them.
public struct MIMEDecodeLimits: Equatable, Sendable {
    public var maxPartBytes: UInt64
    public var maxTotalBytes: UInt64

    public init(
        maxPartBytes: UInt64 = 64 * 1024 * 1024,
        maxTotalBytes: UInt64 = 512 * 1024 * 1024
    ) {
        self.maxPartBytes = maxPartBytes
        self.maxTotalBytes = maxTotalBytes
    }
}

/// One decoded MHTML part.
public struct MIMEPart: Equatable, Sendable {
    public var headers: [String: String]
    public var contentType: String
    public var charset: String?
    public var transferEncoding: String
    public var contentLocation: String?
    public var contentID: String?
    public var fileName: String?
    public var decodedData: Data
    public var decodedText: String?

    public init(
        headers: [String: String],
        contentType: String,
        charset: String?,
        transferEncoding: String,
        contentLocation: String?,
        contentID: String?,
        fileName: String?,
        decodedData: Data,
        decodedText: String?
    ) {
        self.headers = headers
        self.contentType = contentType
        self.charset = charset
        self.transferEncoding = transferEncoding
        self.contentLocation = contentLocation
        self.contentID = contentID
        self.fileName = fileName
        self.decodedData = decodedData
        self.decodedText = decodedText
    }

    public var isHTML: Bool {
        contentType.hasPrefix("text/html") || contentType.hasPrefix("application/xhtml")
    }

    public var isImage: Bool {
        contentType.hasPrefix("image/") || (fileName.map { AssetCategory(fileName: $0) == .img || AssetCategory(fileName: $0) == .icons } ?? false)
    }

    public var isDocument: Bool {
        contentType.contains("pdf")
            || contentType.contains("msword")
            || contentType.contains("officedocument")
            || (fileName.map { AssetCategory(fileName: $0) == .lockerDocs } ?? false)
    }
}

public struct MIMEDocument: Equatable, Sendable {
    public var boundary: String
    public var parts: [MIMEPart]

    public init(boundary: String, parts: [MIMEPart]) {
        self.boundary = boundary
        self.parts = parts
    }
}

/// Minimal, dependency-free MHTML/MIME parser: boundary splitting, header
/// folding, quoted-printable and base64 transfer decoding, charset-aware text
/// decoding, and `content-id`/`content-location` mapping for `cid:` references.
public enum MIMEParser {
    public static func parse(
        _ data: Data,
        limits: MIMEDecodeLimits = MIMEDecodeLimits()
    ) throws -> MIMEDocument {
        guard let boundary = boundary(in: data) else {
            throw MIMEParseError.missingBoundary
        }
        let rawParts = splitParts(data, boundary: boundary)
        guard !rawParts.isEmpty else {
            throw MIMEParseError.noParts
        }
        var parts: [MIMEPart] = []
        var totalDecoded: UInt64 = 0
        for raw in rawParts {
            guard let part = try decodePart(raw, limits: limits) else { continue }
            totalDecoded += UInt64(part.decodedData.count)
            guard totalDecoded <= limits.maxTotalBytes else {
                throw MIMEParseError.limitsExceeded(
                    "decoded parts exceed \(limits.maxTotalBytes) bytes"
                )
            }
            parts.append(part)
        }
        guard !parts.isEmpty else {
            throw MIMEParseError.noParts
        }
        return MIMEDocument(boundary: boundary, parts: parts)
    }

    // MARK: - Boundary

    public static func boundary(in data: Data) -> String? {
        let prefix = String(decoding: data.prefix(64 * 1024), as: UTF8.self)
        guard let regex = try? NSRegularExpression(
            pattern: "boundary\\s*=\\s*\"?([^\";\\r\\n]+)\"?",
            options: [.caseInsensitive]
        ) else { return nil }
        let range = NSRange(prefix.startIndex..<prefix.endIndex, in: prefix)
        guard let match = regex.firstMatch(in: prefix, options: [], range: range),
              match.numberOfRanges > 1,
              let valueRange = Range(match.range(at: 1), in: prefix) else {
            return nil
        }
        return String(prefix[valueRange]).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    // MARK: - Splitting

    /// Splits on `--boundary` lines. Works on ISO-8859-1 so arbitrary bytes in
    /// a part body round-trip unchanged.
    static func splitParts(_ data: Data, boundary: String) -> [Data] {
        let text = String(data: data, encoding: .isoLatin1)
            ?? String(decoding: data, as: UTF8.self)
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
                if collecting { parts.append(partData(current)) }
                collecting = false
                break
            }
            if trimmed == marker {
                if collecting { parts.append(partData(current)) }
                current = []
                collecting = true
                continue
            }
            if collecting {
                current.append(line)
            }
        }
        if collecting, !current.isEmpty {
            parts.append(partData(current))
        }
        return parts
    }

    private static func partData(_ lines: [String]) -> Data {
        let text = lines.joined(separator: "\n")
        return Data(text.data(using: .isoLatin1) ?? Data(text.utf8))
    }

    // MARK: - Part decoding

    static func decodePart(_ data: Data, limits: MIMEDecodeLimits) throws -> MIMEPart? {
        let (headers, body) = splitHeaders(data)
        let contentTypeHeader = headers["content-type"] ?? "text/plain"
        let contentType = contentTypeHeader
            .split(separator: ";", maxSplits: 1, omittingEmptySubsequences: false)
            .first
            .map { $0.trimmingCharacters(in: .whitespaces).lowercased() } ?? "text/plain"
        let charset = parameter("charset", in: contentTypeHeader)
        let transfer = (headers["content-transfer-encoding"] ?? "").lowercased()
        let contentLocation = headers["content-location"]
            ?? headers["snapshot-content-location"]
            ?? headers["x-content-location"]
        let contentID = headers["content-id"]?
            .trimmingCharacters(in: CharacterSet(charactersIn: "<> \t\r\n"))
        let fileName = fileName(
            contentLocation: contentLocation,
            contentTypeHeader: contentTypeHeader,
            contentID: contentID
        )

        let decoded: Data
        if transfer.contains("base64") {
            decoded = decodeBase64(body)
        } else if transfer.contains("quoted-printable") {
            decoded = decodeQuotedPrintable(body)
        } else {
            decoded = body
        }
        guard UInt64(decoded.count) <= limits.maxPartBytes else {
            throw MIMEParseError.limitsExceeded(
                "part \(fileName ?? "unknown") exceeded \(limits.maxPartBytes) decoded bytes"
            )
        }

        let text: String?
        if contentType.hasPrefix("text/") || contentType.contains("json") || contentType.contains("xml") || contentType.contains("javascript") {
            text = HTMLTextDecoder.decode(decoded, declaredCharset: charset)
        } else {
            text = nil
        }

        return MIMEPart(
            headers: headers,
            contentType: contentType,
            charset: charset,
            transferEncoding: transfer,
            contentLocation: contentLocation,
            contentID: contentID,
            fileName: fileName,
            decodedData: decoded,
            decodedText: text
        )
    }

    static func splitHeaders(_ data: Data) -> (headers: [String: String], body: Data) {
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

    static func parameter(_ name: String, in header: String) -> String? {
        guard let regex = try? NSRegularExpression(
            pattern: "\(name)\\s*=\\s*\"?([^\";\\r\\n]+)\"?",
            options: [.caseInsensitive]
        ) else { return nil }
        let range = NSRange(header.startIndex..<header.endIndex, in: header)
        guard let match = regex.firstMatch(in: header, options: [], range: range),
              match.numberOfRanges > 1,
              let valueRange = Range(match.range(at: 1), in: header) else {
            return nil
        }
        return String(header[valueRange]).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func fileName(
        contentLocation: String?,
        contentTypeHeader: String,
        contentID: String?
    ) -> String? {
        if let location = contentLocation {
            let withoutQuery = location.split(separator: "?", maxSplits: 1).first.map(String.init) ?? location
            let name = (withoutQuery as NSString).lastPathComponent
            if !name.isEmpty, name != "/", name != "." {
                return name.removingPercentEncoding ?? name
            }
        }
        if let name = parameter("name", in: contentTypeHeader), !name.isEmpty {
            return name
        }
        if let contentID, !contentID.isEmpty {
            return contentID
        }
        return nil
    }

    // MARK: - Transfer decoding

    public static func decodeBase64(_ data: Data) -> Data {
        let text = String(decoding: data, as: UTF8.self)
            .components(separatedBy: .whitespacesAndNewlines)
            .joined()
        return Data(base64Encoded: text, options: [.ignoreUnknownCharacters]) ?? data
    }

    public static func decodeQuotedPrintable(_ data: Data) -> Data {
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
                   let high = hexValue(bytes[index + 1]),
                   let low = hexValue(bytes[index + 2]) {
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
