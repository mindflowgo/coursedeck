import Foundation

/// Atomic, durability-oriented file writes. Every mutable CourseDeck file goes
/// through here: write a temp file in the same directory, fsync it, then swap
/// it into place. A crash therefore leaves either the old or the new file,
/// never a partial one (PLAN §3.1 / §6 Storage/lifecycle).
public struct AtomicFileStore: Sendable {
    public init() {}

    public func write(_ data: Data, to url: URL) throws {
        let fileManager = FileManager.default
        let directory = url.deletingLastPathComponent()
        try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)

        let tempURL = directory.appendingPathComponent(
            ".\(url.lastPathComponent).\(UUID().uuidString).tmp"
        )
        do {
            try data.write(to: tempURL, options: .withoutOverwriting)
            let handle = try FileHandle(forWritingTo: tempURL)
            defer { try? handle.close() }
            try handle.synchronize()

            if fileManager.fileExists(atPath: url.path) {
                _ = try fileManager.replaceItemAt(url, withItemAt: tempURL)
            } else {
                try fileManager.moveItem(at: tempURL, to: url)
            }
        } catch {
            try? fileManager.removeItem(at: tempURL)
            throw error
        }
    }

    public func write(_ string: String, to url: URL) throws {
        try write(Data(string.utf8), to: url)
    }

    public func writeJSON(_ value: JSONValue, to url: URL, pretty: Bool = true) throws {
        try write(value.serializedData(pretty: pretty), to: url)
    }

    public func read(_ url: URL) throws -> Data {
        try Data(contentsOf: url)
    }

    public func readString(_ url: URL) throws -> String {
        let data = try Data(contentsOf: url)
        guard let string = String(data: data, encoding: .utf8) else {
            throw AtomicFileStoreError.notUTF8(url.lastPathComponent)
        }
        return string
    }

    public func readJSON(_ url: URL) throws -> JSONValue {
        try JSONValue(parsing: Data(contentsOf: url))
    }

    public func exists(_ url: URL) -> Bool {
        FileManager.default.fileExists(atPath: url.path)
    }

    public func removeIfExists(_ url: URL) throws {
        let fileManager = FileManager.default
        if fileManager.fileExists(atPath: url.path) {
            try fileManager.removeItem(at: url)
        }
    }

    /// Copies a file atomically into place, creating parent directories.
    public func copy(from source: URL, to destination: URL) throws {
        let data = try Data(contentsOf: source)
        try write(data, to: destination)
    }

    public func modificationDate(_ url: URL) -> Date? {
        try? FileManager.default.attributesOfItem(atPath: url.path)[.modificationDate] as? Date
    }
}

public enum AtomicFileStoreError: Error, LocalizedError, Equatable {
    case notUTF8(String)

    public var errorDescription: String? {
        switch self {
        case let .notUTF8(name): return "\(name) is not valid UTF-8."
        }
    }
}

/// Quarantine helpers for corrupt or denylisted files. Quarantined data is
/// moved (never deleted) and the original name is recorded for recovery.
public struct FileQuarantine: Sendable {
    public let rootURL: URL
    public init(rootURL: URL) {
        self.rootURL = rootURL
    }

    /// Moves `url` into the quarantine root under a timestamped, unique folder.
    /// Returns the quarantine URL.
    @discardableResult
    public func quarantine(_ url: URL, reason: String) throws -> URL {
        let fileManager = FileManager.default
        let timestamp = Self.timestamp()
        let folder = rootURL.appendingPathComponent("\(timestamp)-\(UUID().uuidString.prefix(8))", isDirectory: true)
        try fileManager.createDirectory(at: folder, withIntermediateDirectories: true)

        let destination = folder.appendingPathComponent(url.lastPathComponent)
        try fileManager.moveItem(at: url, to: destination)

        let note = "reason: \(reason)\noriginal: \(url.path)\nquarantinedAt: \(ISO8601DateFormatter().string(from: Date()))\n"
        try? Data(note.utf8).write(to: folder.appendingPathComponent("QUARANTINE.txt"))
        return destination
    }

    /// Copies the current bytes to `<name>.bak` before a corrupt file is
    /// quarantined, matching the desktop recovery contract.
    public func backupCopy(_ url: URL) throws -> URL {
        let backup = url.deletingLastPathComponent().appendingPathComponent(url.lastPathComponent + ".bak")
        if !FileManager.default.fileExists(atPath: backup.path) {
            try FileManager.default.copyItem(at: url, to: backup)
        }
        return backup
    }

    public static func timestamp(_ date: Date = Date()) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "yyyyMMdd-HHmmss"
        return formatter.string(from: date)
    }
}
