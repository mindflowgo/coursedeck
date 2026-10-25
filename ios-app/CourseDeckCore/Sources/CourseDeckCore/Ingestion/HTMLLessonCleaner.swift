import Foundation
import SwiftSoup

/// Result of cleaning one lesson DOM before Markdown conversion.
public struct CleanedLessonHTML: Equatable, Sendable {
    public var title: String
    public var html: String
    public var learningGoals: [String]
    public var successCriteria: [String]
    public var warnings: [String]

    public init(
        title: String,
        html: String,
        learningGoals: [String] = [],
        successCriteria: [String] = [],
        warnings: [String] = []
    ) {
        self.title = title
        self.html = html
        self.learningGoals = learningGoals
        self.successCriteria = successCriteria
        self.warnings = warnings
    }
}

/// Port of the desktop `DomCleaner` (PLAN §4.11): title extraction, learning
/// goals/success criteria, section banners, answer-reveal buttons, asset link
/// rewriting, chrome removal, and main-content selection.
///
/// Asset rewriting uses the extraction mapping instead of blindly using the
/// basename, so two packages with the same `diagram.png` cannot cross-wire
/// their images.
public struct HTMLLessonCleaner: Sendable {
    public init() {}

    public func clean(
        html: String,
        assetResolver: ((String) -> String?)? = nil
    ) throws -> CleanedLessonHTML {
        let document = try SwiftSoup.parse(html)
        var warnings: [String] = []

        let pageTitle = ((try? document.title()) ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let h1Title = ((try? document.select("h1").first()?.text()) ?? "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let title = !pageTitle.isEmpty ? pageTitle : (!h1Title.isEmpty ? h1Title : "ILC Lesson")

        // 1. Learning goals / success criteria.
        var learningGoals: [String] = []
        var successCriteria: [String] = []
        for container in try document.select("#ilcLearningGoals").array() {
            var isSuccessCriteria = false
            for element in try container.select("h2, h3, p, ul, ol").array() {
                let text = (try? element.text())?
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                    .lowercased() ?? ""
                if text.contains("success criteria") {
                    isSuccessCriteria = true
                } else if text.contains("learning goal") {
                    isSuccessCriteria = false
                } else if ["ul", "ol"].contains(element.tagNameNormal()) {
                    for item in try element.select("li").array() {
                        let value = (try? item.text())?
                            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                        guard !value.isEmpty else { continue }
                        if isSuccessCriteria {
                            successCriteria.append(value)
                        } else {
                            learningGoals.append(value)
                        }
                    }
                }
            }

            if learningGoals.isEmpty && successCriteria.isEmpty {
                try container.remove()
            } else {
                var goalsHTML = "<div class=\"app-callout-goals\"><h3>Learning Goals &amp; Success Criteria</h3>"
                if !learningGoals.isEmpty {
                    goalsHTML += "<p><strong>You are learning to:</strong></p><ul>"
                    goalsHTML += learningGoals.map { "<li>\(escapeHTML($0))</li>" }.joined()
                    goalsHTML += "</ul>"
                }
                if !successCriteria.isEmpty {
                    goalsHTML += "<p><strong>Success criteria:</strong></p><ul>"
                    goalsHTML += successCriteria.map { "<li>\(escapeHTML($0))</li>" }.joined()
                    goalsHTML += "</ul>"
                }
                goalsHTML += "</div>"
                try container.before(goalsHTML)
                try container.remove()
            }
        }

        // 2. Section banners.
        for (selector, heading) in [
            ("#mindsOn .banner", "Minds On"),
            ("#action .banner", "Action"),
            ("#consolidation .banner", "Consolidation"),
        ] {
            for banner in try document.select(selector).array() {
                try banner.before("<h2>\(heading)</h2>")
                try banner.remove()
            }
        }

        // 3. Answer-reveal buttons → <details><summary>.
        for button in try document.select(".btn-answer-reveal").array() {
            let buttonID = (try? button.attr("id")) ?? ""
            let targetID = buttonID.replacingOccurrences(of: "Button", with: "")
            var answer: Element? = try? button.nextElementSibling()
            if answer == nil || !((try? answer?.className()) ?? "").contains("answer_reveal") {
                if !targetID.isEmpty {
                    answer = try document.select("#\(targetID)").first()
                }
            }
            let summaryText = (try? button.text())?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let summary = summaryText.isEmpty ? "Suggested Answer" : summaryText
            let answerHTML = (try? answer?.html()) ?? ""
            let details = "\n<details class=\"suggested-answer\"><summary>\(escapeHTML(summary))</summary>\n<div>\(answerHTML)</div>\n</details>\n"
            try button.before(details)
            try button.remove()
            try answer?.remove()
        }

        // 4. Table spans: colspan is expanded by the converter; rowspan is
        //    flattened, which loses the visual span. Surface a warning rather
        //    than silently pretending the table was faithful (PLAN §4.3).
        if try document.select("[rowspan]").first() != nil {
            warnings.append("A table uses rowspan; the span was flattened into a GFM table.")
        }

        // 5. Asset and document links.
        let resolve: (String) -> String? = { reference in
            assetResolver?(reference)
        }
        for image in try document.select("img").array() {
            let src = ((try? image.attr("src")) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let dataSrc = ((try? image.attr("data-src")) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let srcset = ((try? image.attr("srcset")) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            let raw = !dataSrc.isEmpty ? dataSrc : (!src.isEmpty ? src : Self.firstSrcsetCandidate(srcset))
            guard !raw.isEmpty else { continue }
            if let resolved = resolve(raw) {
                _ = try? image.attr("src", "./\(resolved)")
                _ = try? image.removeAttr("srcset")
                _ = try? image.removeAttr("data-src")
                _ = try? image.removeAttr("data-original")
            } else if raw.lowercased().hasPrefix("http://") || raw.lowercased().hasPrefix("https://") {
                warnings.append("Remote image left unchanged: \(raw)")
            }
        }

        for link in try document.select("a[href]").array() {
            let href = ((try? link.attr("href")) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !href.isEmpty else { continue }
            if href.lowercased().hasPrefix("javascript:") {
                _ = try? link.removeAttr("href")
                continue
            }
            if href.hasPrefix("#") { continue }
            if let resolved = resolve(href) {
                _ = try? link.attr("href", "./\(resolved)")
            }
        }

        for source in try document.select("source[srcset]").array() {
            let srcset = (try? source.attr("srcset")) ?? ""
            for candidate in Self.srcsetCandidates(srcset) {
                if let resolved = resolve(candidate.url) {
                    _ = try? source.attr("srcset", "./\(resolved)")
                    break
                }
            }
        }

        // 6. Remove scripts/styles/chrome and unsafe embeds.
        let removeSelectors = [
            "script", "style", "noscript", "link[rel=stylesheet]",
            "nav", ".navbar", "progress", "button.btn-app-drawer", "button.btn-app-close",
            ".sr-only", ".hidden", "iframe", "form", "object", "embed",
        ]
        for selector in removeSelectors {
            for element in try document.select(selector).array() {
                try element.remove()
            }
        }

        // 7. Strip inline event handlers and unsafe URLs.
        for element in try document.getAllElements().array() {
            for attribute in element.getAttributes()?.asList() ?? [] {
                let key = attribute.getKey().lowercased()
                if key.hasPrefix("on") {
                    _ = try? element.removeAttr(attribute.getKey())
                }
            }
        }

        // 8. Main content selection (desktop order).
        let main = try document.select("main#mainContent, #mainContent, .mainContent, main, body").first()
        let cleaned = (try? main?.html()) ?? (try? document.body()?.html()) ?? html

        return CleanedLessonHTML(
            title: title,
            html: cleaned,
            learningGoals: learningGoals,
            successCriteria: successCriteria,
            warnings: warnings
        )
    }

    // MARK: - srcset helpers

    static func firstSrcsetCandidate(_ srcset: String) -> String {
        srcsetCandidates(srcset).first?.url ?? ""
    }

    static func srcsetCandidates(_ srcset: String) -> [(url: String, descriptor: String)] {
        srcset
            .split(separator: ",")
            .compactMap { part -> (String, String)? in
                let pieces = part
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                    .split(separator: " ", maxSplits: 1, omittingEmptySubsequences: true)
                guard let first = pieces.first else { return nil }
                let descriptor = pieces.count > 1 ? String(pieces[1]) : ""
                return (String(first), descriptor)
            }
    }

    private func escapeHTML(_ text: String) -> String {
        text
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\"", with: "&quot;")
    }
}
