import Foundation

/// Port of the desktop `imageSpec.ts` parser (PLAN §4.5).
public enum ImageDimensionUnit: String, Equatable, Sendable {
    case px
    case rem
    case percent
}

public struct ImageDimension: Equatable, Sendable {
    public var value: Double
    public var unit: ImageDimensionUnit

    public init(value: Double, unit: ImageDimensionUnit) {
        self.value = value
        self.unit = unit
    }

    /// CSS string used by the HTML viewer and the SwiftUI/UIKit reader.
    public var cssValue: String {
        switch unit {
        case .px: return "\(Self.format(value))px"
        case .rem: return "\(Self.format(value))rem"
        case .percent: return "\(Self.format(value))%"
        }
    }

    /// Fraction of the available width for percentage dimensions.
    public var fraction: Double? {
        unit == .percent ? value / 100 : nil
    }

    static func format(_ value: Double) -> String {
        if value == value.rounded() { return String(Int(value)) }
        return String(value)
    }
}

public enum NamedImageSize: String, Equatable, Sendable {
    case xs
    case sm
    case md
    case lg
    case xl
    case full
}

public struct ImageSpec: Equatable, Sendable {
    /// Alt text with any `|spec` stripped and trimmed.
    public var alt: String
    /// Raw spec text after the last pipe, if any.
    public var rawSpec: String?
    public var width: ImageDimension?
    public var height: ImageDimension?
    public var namedSize: NamedImageSize?
    public var isCustom: Bool

    public init(
        alt: String,
        rawSpec: String? = nil,
        width: ImageDimension? = nil,
        height: ImageDimension? = nil,
        namedSize: NamedImageSize? = nil,
        isCustom: Bool = false
    ) {
        self.alt = alt
        self.rawSpec = rawSpec
        self.width = width
        self.height = height
        self.namedSize = namedSize
        self.isCustom = isCustom
    }
}

public enum ImageSpecParser {
    public static let defaultMaxHeight: Double = 480
    public static let iconMaxHeight: Double = 32

    private struct NamedPreset {
        let value: Double
        let unit: ImageDimensionUnit
        let name: NamedImageSize
    }

    /// Aliases intentionally match the desktop table (`thumb`, `small`, …).
    private static let namedPresets: [String: NamedPreset] = [
        "xs": NamedPreset(value: 160, unit: .px, name: .xs),
        "thumb": NamedPreset(value: 160, unit: .px, name: .xs),
        "sm": NamedPreset(value: 280, unit: .px, name: .sm),
        "small": NamedPreset(value: 280, unit: .px, name: .sm),
        "md": NamedPreset(value: 480, unit: .px, name: .md),
        "medium": NamedPreset(value: 480, unit: .px, name: .md),
        "lg": NamedPreset(value: 720, unit: .px, name: .lg),
        "large": NamedPreset(value: 720, unit: .px, name: .lg),
        "xl": NamedPreset(value: 100, unit: .percent, name: .xl),
        "full": NamedPreset(value: 100, unit: .percent, name: .full),
    ]

    private static let dimensionPattern = #"^(\d+(?:\.\d+)?)(px|rem|%)?$"#
    private static let pairPattern =
        #"^(\d+(?:\.\d+)?(?:px|%|rem)?)\s*x\s*(\d+(?:\.\d+)?(?:px|%|rem)?)$"#
    private static let widthPattern = #"\b(?:width|w)=([0-9]+(?:\.\d+)?(?:%|px|rem)?)"#
    private static let heightPattern = #"\b(?:height|h)=([0-9]+(?:\.\d+)?(?:%|px|rem)?)"#

    public static func parseDimension(_ raw: String) -> ImageDimension? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let match = firstMatch(dimensionPattern, in: trimmed),
              let value = Double(match[0]) else {
            return nil
        }
        let unit: ImageDimensionUnit
        switch (match[1] ?? "").lowercased() {
        case "px", "": unit = .px
        case "rem": unit = .rem
        case "%": unit = .percent
        default: return nil
        }
        return ImageDimension(value: value, unit: unit)
    }

    /// Parses Obsidian-style `![alt|spec](url)`. The **last** pipe wins, so
    /// alt text may itself contain a pipe.
    public static func parse(_ rawAlt: String) -> ImageSpec {
        guard let pipeIndex = rawAlt.lastIndex(of: "|") else {
            return ImageSpec(alt: rawAlt.trimmingCharacters(in: .whitespacesAndNewlines))
        }

        let alt = String(rawAlt[..<pipeIndex]).trimmingCharacters(in: .whitespacesAndNewlines)
        let spec = String(rawAlt[rawAlt.index(after: pipeIndex)...])
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()

        guard !spec.isEmpty else {
            return ImageSpec(alt: alt, rawSpec: "")
        }

        if let preset = namedPresets[spec] {
            return ImageSpec(
                alt: alt,
                rawSpec: spec,
                width: ImageDimension(value: preset.value, unit: preset.unit),
                namedSize: preset.name,
                isCustom: true
            )
        }

        if let pair = firstMatch(pairPattern, in: spec) {
            let width = parseDimension(pair[0])
            let height = parseDimension(pair[1])
            return ImageSpec(
                alt: alt,
                rawSpec: spec,
                width: width,
                height: height,
                isCustom: width != nil || height != nil
            )
        }

        var width: ImageDimension?
        var height: ImageDimension?
        if let match = firstMatch(widthPattern, in: spec) {
            width = parseDimension(match[0])
        }
        if let match = firstMatch(heightPattern, in: spec) {
            height = parseDimension(match[0])
        }
        if width == nil && height == nil {
            width = parseDimension(spec)
        }

        return ImageSpec(
            alt: alt,
            rawSpec: spec,
            width: width,
            height: height,
            isCustom: width != nil || height != nil
        )
    }

    /// Decorative icons render inline and are height-capped (PLAN §4.5).
    public static func isIcon(destination: String, alt: String, isCustom: Bool) -> Bool {
        let href = destination.lowercased()
        if href.contains("/assets/icons/") || href.contains("/icons/") {
            return true
        }
        if href.hasSuffix(".svg") && !isCustom && !href.contains("/img/") {
            return true
        }
        return alt.range(of: #"\b(icon|badge|button)\b"#, options: [.regularExpression, .caseInsensitive]) != nil
    }

    // MARK: - Regex helper

    /// Returns capture groups (index 0 is the first capture) for the first match.
    static func firstMatch(_ pattern: String, in text: String) -> [String]? {
        guard let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) else {
            return nil
        }
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        guard let match = regex.firstMatch(in: text, options: [], range: range) else {
            return nil
        }
        var groups: [String] = []
        for index in 1..<match.numberOfRanges {
            let groupRange = match.range(at: index)
            if groupRange.location == NSNotFound {
                groups.append("")
            } else if let swiftRange = Range(groupRange, in: text) {
                groups.append(String(text[swiftRange]))
            } else {
                groups.append("")
            }
        }
        return groups
    }
}
