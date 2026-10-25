import Foundation

/// Writes package assets into `<course>/assets/{img,icons,locker_docs}` with
/// collision-safe names.
///
/// Desktop extraction reuses the first `diagram.png` it sees. That silently
/// shows the wrong diagram when two packages contain different files with the
/// same basename (PLAN §4.11). The policy here is:
///
/// 1. identical bytes at the target name → reuse the existing file;
/// 2. different bytes at the target name (including case-only names on APFS)
///    → `<content-hash-prefix>-<name>`;
/// 3. a hash-name collision → numeric suffix.
///
/// Every source reference (entry path, content-location, `cid:` id, basename)
/// is registered so the HTML cleaner can rewrite the right reference.
final class CourseAssetStore {
    let assetsURL: URL
    private let store: AtomicFileStore
    private var byReference: [String: IngestedAsset] = [:]
    private var byContent: [String: IngestedAsset] = [:]
    private(set) var assets: [IngestedAsset] = []
    private var caseInsensitiveNames: [AssetCategory: [String: String]] = [:]

    init(assetsURL: URL, store: AtomicFileStore = AtomicFileStore()) {
        self.assetsURL = assetsURL
        self.store = store
    }

    @discardableResult
    func add(
        data: Data,
        suggestedFilename: String,
        category: AssetCategory,
        originalReferences: [String] = []
    ) throws -> IngestedAsset {
        let references = normalizedReferences(originalReferences + [suggestedFilename])
        let hash = SHA256.hex(data)
        let contentKey = "\(category.rawValue)/\(hash)"

        // The same bytes seen earlier in this package: reuse the record and
        // register the new aliases.
        if var existing = byContent[contentKey] {
            register(existing, references: references)
            var aliases = existing.originalReferences
            for reference in references where !aliases.contains(reference) {
                aliases.append(reference)
            }
            existing.originalReferences = aliases
            byContent[contentKey] = existing
            if let index = assets.firstIndex(where: { $0.fileName == existing.fileName && $0.category == existing.category }) {
                assets[index] = existing
            }
            return existing
        }

        let categoryURL = assetsURL.appendingPathComponent(category.rawValue, isDirectory: true)
        try FileManager.default.createDirectory(at: categoryURL, withIntermediateDirectories: true)
        loadCaseInsensitiveNames(for: category, at: categoryURL)

        let sanitized = Self.sanitizeFilename(suggestedFilename, hash: hash)
        let resolved = try resolveTarget(
            sanitized: sanitized,
            hash: hash,
            category: category,
            categoryURL: categoryURL,
            data: data
        )

        var asset = IngestedAsset(
            fileName: resolved.fileName,
            category: category,
            byteCount: data.count,
            sha256: hash,
            isNew: resolved.isNew,
            originalReferences: references
        )
        if resolved.isNew {
            try store.write(data, to: categoryURL.appendingPathComponent(resolved.fileName))
            caseInsensitiveNames[category, default: [:]][resolved.fileName.lowercased()] = resolved.fileName
        } else {
            caseInsensitiveNames[category, default: [:]][resolved.fileName.lowercased()] = resolved.fileName
        }

        byContent[contentKey] = asset
        register(asset, references: references)
        assets.append(asset)
        return asset
    }

    func asset(forReference reference: String) -> IngestedAsset? {
        for key in referenceKeys(reference) {
            if let asset = byReference[key] {
                return asset
            }
        }
        return nil
    }

    /// Course-relative reference (`assets/img/name.ext`) for a raw HTML URL.
    func rewrittenReference(forReference reference: String) -> String? {
        asset(forReference: reference)?.rewrittenReference
    }

    // MARK: - Target resolution

    private struct TargetResolution {
        var fileName: String
        var isNew: Bool
    }

    private func resolveTarget(
        sanitized: String,
        hash: String,
        category: AssetCategory,
        categoryURL: URL,
        data: Data
    ) throws -> TargetResolution {
        let hashPrefix = String(hash.prefix(10))
        let base = (sanitized as NSString).deletingPathExtension
        let ext = (sanitized as NSString).pathExtension
        var candidates: [String] = [sanitized]
        let hashed = ext.isEmpty ? "\(hashPrefix)-\(base)" : "\(hashPrefix)-\(base).\(ext)"
        candidates.append(hashed)
        for index in 2...50 {
            candidates.append(ext.isEmpty ? "\(hashed)-\(index)" : "\(hashPrefix)-\(base)-\(index).\(ext)")
        }

        for candidate in candidates {
            let url = categoryURL.appendingPathComponent(candidate)
            if store.exists(url) {
                let existing = try store.read(url)
                if existing == data {
                    return TargetResolution(fileName: candidate, isNew: false)
                }
                continue
            }
            // APFS is case-insensitive: a different-case sibling would collide.
            if let existingName = caseInsensitiveNames[category]?[candidate.lowercased()] {
                let existingURL = categoryURL.appendingPathComponent(existingName)
                if store.exists(existingURL) {
                    let existing = try store.read(existingURL)
                    if existing == data {
                        return TargetResolution(fileName: existingName, isNew: false)
                    }
                }
                continue
            }
            return TargetResolution(fileName: candidate, isNew: true)
        }
        // Extremely unlikely; fall back to a UUID-suffixed name.
        let fallback = ext.isEmpty
            ? "\(hashPrefix)-\(UUID().uuidString.prefix(8))"
            : "\(hashPrefix)-\(UUID().uuidString.prefix(8)).\(ext)"
        return TargetResolution(fileName: fallback, isNew: true)
    }

    private func loadCaseInsensitiveNames(for category: AssetCategory, at directory: URL) {
        if caseInsensitiveNames[category] != nil { return }
        var names: [String: String] = [:]
        if let contents = try? FileManager.default.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles]
        ) {
            for url in contents {
                names[url.lastPathComponent.lowercased()] = url.lastPathComponent
            }
        }
        caseInsensitiveNames[category] = names
    }

    // MARK: - References

    private func register(_ asset: IngestedAsset, references: [String]) {
        for key in references.flatMap(referenceKeys) where byReference[key] == nil {
            byReference[key] = asset
        }
    }

    private func normalizedReferences(_ references: [String]) -> [String] {
        var output: [String] = []
        for reference in references {
            for key in referenceKeys(reference) where !output.contains(key) {
                output.append(key)
            }
        }
        return output
    }

    /// Exact, decoded, without-leading-`./`, and basename keys. `cid:` ids are
    /// kept exact (case-sensitive) and also lowercased.
    private func referenceKeys(_ reference: String) -> [String] {
        let trimmed = reference.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return [] }
        var keys: [String] = [trimmed]
        let decoded = trimmed.removingPercentEncoding ?? trimmed
        if decoded != trimmed { keys.append(decoded) }

        if decoded.lowercased().hasPrefix("cid:") {
            keys.append(decoded.lowercased())
            return keys
        }

        let noQuery = decoded.split(separator: "?", maxSplits: 1).first.map(String.init) ?? decoded
        let noFragment = noQuery.split(separator: "#", maxSplits: 1).first.map(String.init) ?? noQuery
        var normalized = noFragment.replacingOccurrences(of: "\\", with: "/")
        while normalized.hasPrefix("./") {
            normalized.removeFirst(2)
        }
        if normalized != trimmed { keys.append(normalized) }
        let basename = (normalized as NSString).lastPathComponent
        if !basename.isEmpty {
            keys.append(basename)
            keys.append(basename.lowercased())
        }
        return keys
    }

    // MARK: - Filename sanitizing

    static func sanitizeFilename(_ raw: String, hash: String) -> String {
        var name = raw.removingPercentEncoding ?? raw
        name = name.split(separator: "?", maxSplits: 1).first.map(String.init) ?? name
        name = name.split(separator: "#", maxSplits: 1).first.map(String.init) ?? name
        name = name.replacingOccurrences(of: "\\", with: "/")
        name = (name as NSString).lastPathComponent
        name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        name = name.replacingOccurrences(
            of: "[\\u0000-\\u001F:*?\"<>|]+",
            with: "-",
            options: .regularExpression
        )
        name = name.replacingOccurrences(of: "\\.+$", with: "", options: .regularExpression)
        name = name.trimmingCharacters(in: CharacterSet(charactersIn: ". "))
        if name.isEmpty {
            name = String(hash.prefix(10))
        }
        let ext = (name as NSString).pathExtension.lowercased()
        var base = (name as NSString).deletingPathExtension
        if base.isEmpty {
            base = String(hash.prefix(10))
        }
        if base.count > 96 {
            base = String(base.prefix(96))
        }
        return ext.isEmpty ? base : "\(base).\(ext)"
    }
}
