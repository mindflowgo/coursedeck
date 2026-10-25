import Foundation

/// Charset-aware decoding for MHTML parts and standalone HTML files.
///
/// ILC captures are UTF-8 in practice, but browser saves can declare
/// windows-1252 or a legacy charset. The decoder honours a declared charset
/// first, then falls back to BOM/UTF-8/Latin-1 so a wrong declaration never
/// produces mojibake or an empty lesson.
public enum HTMLTextDecoder {
    public static func decode(_ data: Data, declaredCharset: String? = nil) -> String {
        if let bomDecoded = decodeBOM(data) {
            return bomDecoded
        }
        if let charset = declaredCharset ?? charset(inHTML: data),
           let decoded = decode(data, charset: charset) {
            return decoded
        }
        if let utf8 = String(data: data, encoding: .utf8) {
            return utf8
        }
        if let latin1 = String(data: data, encoding: .isoLatin1) {
            return latin1
        }
        return String(decoding: data, as: UTF8.self)
    }

    /// Reads `<meta charset>` / `<meta http-equiv="Content-Type">` from the
    /// first 16 KB of the document.
    public static func charset(inHTML data: Data) -> String? {
        let prefix = data.prefix(16 * 1024)
        let text = String(decoding: prefix, as: UTF8.self)
        let patterns = [
            "(?i)<meta[^>]+charset\\s*=\\s*[\"']?([a-zA-Z0-9._:-]+)",
            "(?i)charset\\s*=\\s*[\"']?([a-zA-Z0-9._:-]+)",
        ]
        for pattern in patterns {
            if let value = firstCapture(pattern, in: text) {
                return value
            }
        }
        return nil
    }

    public static func decode(_ data: Data, charset: String) -> String? {
        let normalized = charset
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .trimmingCharacters(in: CharacterSet(charactersIn: "\"'"))
            .lowercased()
        let encoding: String.Encoding?
        switch normalized {
        case "utf-8", "utf8", "unicode-1-1-utf-8":
            encoding = .utf8
        case "utf-16", "utf-16le", "utf16", "unicode":
            encoding = .utf16LittleEndian
        case "utf-16be":
            encoding = .utf16BigEndian
        case "iso-8859-1", "iso8859-1", "latin1", "latin-1", "l1":
            encoding = .isoLatin1
        case "windows-1252", "cp1252", "x-cp1252":
            encoding = .windowsCP1252
        case "us-ascii", "ascii":
            encoding = .ascii
        case "iso-8859-2", "iso-8859-15":
            // No Foundation constant for these; Latin-1 preserves the common
            // ASCII range and is a safer fallback than dropping characters.
            encoding = .isoLatin1
        case "shift_jis", "shift-jis", "sjis", "x-sjis":
            encoding = .shiftJIS
        case "euc-jp", "x-euc-jp":
            encoding = .japaneseEUC
        case "iso-2022-jp":
            encoding = .iso2022JP
        default:
            encoding = nil
        }
        guard let encoding else { return nil }
        return String(data: data, encoding: encoding)
    }

    private static func decodeBOM(_ data: Data) -> String? {
        let bytes = [UInt8](data.prefix(4))
        if bytes.starts(with: [0xEF, 0xBB, 0xBF]) {
            return String(data: data.dropFirst(3), encoding: .utf8)
        }
        if bytes.starts(with: [0xFF, 0xFE]) {
            return String(data: data.dropFirst(2), encoding: .utf16LittleEndian)
        }
        if bytes.starts(with: [0xFE, 0xFF]) {
            return String(data: data.dropFirst(2), encoding: .utf16BigEndian)
        }
        return nil
    }

    private static func firstCapture(_ pattern: String, in text: String) -> String? {
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return nil }
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        guard let match = regex.firstMatch(in: text, options: [], range: range),
              match.numberOfRanges > 1,
              let valueRange = Range(match.range(at: 1), in: text) else {
            return nil
        }
        return String(text[valueRange])
    }
}
