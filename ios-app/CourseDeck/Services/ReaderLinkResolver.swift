import CourseDeckCore
import Foundation

enum ReaderLinkOutcome: Equatable {
    case external(URL)
    case localFile(URL)
    case fragment(String)
    case deepLink(CourseDeckDeepLinkRoute)
    case missing(String)
    case unsupported(String)
}

/// Resolves Markdown link destinations without a web view. Absolute HTTP(S)
/// links stay external; course-relative paths (including `../assets/...`) are
/// validated against the course directory; fragments become block jumps.
enum ReaderLinkResolver {
    static func resolve(_ url: URL, courseDirectoryURL: URL) -> ReaderLinkOutcome {
        let scheme = url.scheme?.lowercased()
        if scheme == "http" || scheme == "https" || scheme == "mailto" || scheme == "tel" {
            return .external(url)
        }
        if scheme == "coursedeck" {
            switch CourseDeckDeepLink.parse(url) {
            case let .success(route):
                return .deepLink(route)
            case let .failure(error):
                return .unsupported(error.errorDescription ?? url.absoluteString)
            }
        }
        if url.isFileURL {
            return FileManager.default.fileExists(atPath: url.path)
                ? .localFile(url)
                : .missing(url.lastPathComponent)
        }
        if let fragment = url.fragment, !fragment.isEmpty,
           url.path.isEmpty || url.relativeString.hasPrefix("#") {
            return .fragment(fragment)
        }

        // Relative destination. Strip leading parent segments, then validate
        // containment under the course directory.
        var candidate = url.relativeString
        if let queryIndex = candidate.firstIndex(of: "?") {
            candidate = String(candidate[..<queryIndex])
        }
        while candidate.hasPrefix("../") {
            candidate.removeFirst(3)
        }
        while candidate.hasPrefix("./") {
            candidate.removeFirst(2)
        }
        guard !candidate.isEmpty,
              !candidate.hasPrefix("/"),
              !candidate.hasPrefix("#") else {
            return .missing(url.relativeString)
        }
        let components = candidate.split(separator: "/").map(String.init)
        guard let resolved = try? PathValidator.safeJoin(
            base: courseDirectoryURL,
            components: components
        ) else {
            return .missing(url.relativeString)
        }
        return FileManager.default.fileExists(atPath: resolved.path)
            ? .localFile(resolved)
            : .missing(url.relativeString)
    }
}
