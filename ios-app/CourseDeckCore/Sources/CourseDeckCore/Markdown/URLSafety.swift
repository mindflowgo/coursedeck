import Foundation

/// One shared allowlist for Markdown inline HTML, raw HTML links, and image
/// sources. The data root and lesson Markdown are untrusted (PLAN §3.1/§4.5),
/// so script-bearing schemes are rejected everywhere.
public enum MarkdownURLSafety {
    private static let dangerousPrefixes = ["javascript:", "data:", "vbscript:"]
    private static let allowedSchemes: Set<String> = [
        "http", "https", "mailto", "tel", "file", "coursedeck",
    ]

    public static func isSafeLink(_ value: String) -> Bool {
        let normalized = normalized(value)
        guard !normalized.isEmpty else { return false }
        return !isDangerous(value) && hasAllowedScheme(value)
    }

    public static func isSafeImageSource(_ value: String) -> Bool {
        let normalized = normalized(value)
        guard !normalized.isEmpty else { return false }
        return !isDangerous(value) && hasAllowedScheme(value)
    }

    private static func isDangerous(_ value: String) -> Bool {
        let normalized = normalized(value)
        return dangerousPrefixes.contains { normalized.hasPrefix($0) }
    }

    /// Removes whitespace/control characters before scheme detection so
    /// `java\nscript:` and `java script:` cannot slip through.
    private static func normalized(_ value: String) -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return String(trimmed.unicodeScalars.filter { scalar in
            !CharacterSet.whitespacesAndNewlines.contains(scalar)
                && !CharacterSet.controlCharacters.contains(scalar)
        }).lowercased()
    }

    /// Rejects explicit scheme values outside the allowlist while allowing
    /// relative paths, fragments, and course asset URLs.
    public static func hasAllowedScheme(_ value: String) -> Bool {
        let normalized = normalized(value)
        guard let colon = normalized.firstIndex(of: ":") else { return true }
        let scheme = String(normalized[..<colon])
        // A colon after a slash is part of a relative path.
        if let slash = normalized.firstIndex(of: "/"), slash < colon { return true }
        // Only a syntactically valid scheme is checked against the allowlist;
        // a colon in a relative path/query (`foo?x=1:2`) stays relative.
        guard scheme.range(
            of: #"^[a-z][a-z0-9+.-]*$"#,
            options: .regularExpression
        ) != nil else {
            return true
        }
        return allowedSchemes.contains(scheme)
    }
}
