import Foundation

/// Repairs SVG bytes captured as quoted-printable text.
///
/// Eleven live BAF3M icons contain literal `=3D`/`=3C`/`=3E` sequences instead
/// of `<`, `=`, `>` (PLAN §4.5). The reader and the ingestion extractor share
/// this repair so a repaired icon is identical on both paths.
public enum SVGRepair {
    public static func repair(_ data: Data) -> Data {
        guard var text = String(data: data, encoding: .utf8) else { return data }
        if text.hasPrefix("\u{FEFF}") {
            text.removeFirst()
        }
        guard isQuotedPrintableEncoded(text) else {
            return Data(text.utf8)
        }

        var bytes: [UInt8] = []
        let scalars = Array(text.unicodeScalars)
        var index = 0
        while index < scalars.count {
            let scalar = scalars[index]
            if scalar == "=" {
                // Soft line break: `=` at end of a line.
                if index + 1 < scalars.count, scalars[index + 1] == "\n" {
                    index += 2
                    continue
                }
                if index + 2 < scalars.count,
                   scalars[index + 1] == "\r",
                   scalars[index + 2] == "\n" {
                    index += 3
                    continue
                }
                if index + 2 < scalars.count,
                   let high = hexValue(scalars[index + 1]),
                   let low = hexValue(scalars[index + 2]) {
                    bytes.append(high << 4 | low)
                    index += 3
                    continue
                }
            }
            bytes.append(contentsOf: Array(String(scalar).utf8))
            index += 1
        }
        return Data(bytes)
    }

    public static func isQuotedPrintableEncoded(_ text: String) -> Bool {
        let upper = text.uppercased()
        return upper.contains("=3C") || upper.contains("=3D") || upper.contains("=3E")
    }

    private static func hexValue(_ scalar: Unicode.Scalar) -> UInt8? {
        guard scalar.isASCII else { return nil }
        switch scalar.value {
        case 48...57: return UInt8(scalar.value - 48)
        case 65...70: return UInt8(scalar.value - 65 + 10)
        case 97...102: return UInt8(scalar.value - 97 + 10)
        default: return nil
        }
    }
}
