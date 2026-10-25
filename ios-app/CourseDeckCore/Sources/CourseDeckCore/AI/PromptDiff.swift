import Foundation

public enum PromptDiffKind: Equatable, Sendable {
    case unchanged
    case added
    case removed
}

public struct PromptDiffLine: Equatable, Sendable {
    public var kind: PromptDiffKind
    public var text: String

    public init(kind: PromptDiffKind, text: String) {
        self.kind = kind
        self.text = text
    }
}

/// Line-level active-vs-bundled diff for the prompt manager. It is deliberately
/// small and deterministic: prompts are configuration text, not large
/// documents, so an O(n×m) LCS is adequate and has no dependency.
public enum PromptDiff {
    public static func compare(active: String, bundled: String) -> [PromptDiffLine] {
        let a = active.components(separatedBy: "\n")
        let b = bundled.components(separatedBy: "\n")
        var lcs = Array(
            repeating: Array(repeating: 0, count: b.count + 1),
            count: a.count + 1
        )
        if !a.isEmpty && !b.isEmpty {
            for i in stride(from: a.count - 1, through: 0, by: -1) {
                for j in stride(from: b.count - 1, through: 0, by: -1) {
                    if a[i] == b[j] {
                        lcs[i][j] = lcs[i + 1][j + 1] + 1
                    } else {
                        lcs[i][j] = max(lcs[i + 1][j], lcs[i][j + 1])
                    }
                }
            }
        }

        var output: [PromptDiffLine] = []
        var i = 0
        var j = 0
        while i < a.count && j < b.count {
            if a[i] == b[j] {
                output.append(PromptDiffLine(kind: .unchanged, text: a[i]))
                i += 1
                j += 1
            } else if lcs[i + 1][j] >= lcs[i][j + 1] {
                output.append(PromptDiffLine(kind: .removed, text: a[i]))
                i += 1
            } else {
                output.append(PromptDiffLine(kind: .added, text: b[j]))
                j += 1
            }
        }
        while i < a.count {
            output.append(PromptDiffLine(kind: .removed, text: a[i]))
            i += 1
        }
        while j < b.count {
            output.append(PromptDiffLine(kind: .added, text: b[j]))
            j += 1
        }
        return output
    }
}
