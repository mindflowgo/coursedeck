import Foundation

public enum SettingsStoreError: Error, LocalizedError, Equatable {
    case writeBlocked(String)

    public var errorDescription: String? {
        switch self {
        case let .writeBlocked(reason): return "Writes are blocked: \(reason)"
        }
    }
}

/// Atomic JSON settings store with forward migration and unknown-field
/// preservation. A corrupt settings file is quarantined (with a `.bak`) and
/// defaults are returned, but known user data is never silently overwritten.
public actor SettingsStore {
    private let root: DataRoot
    private let store: AtomicFileStore
    private let quarantine: FileQuarantine
    private let leaseOwner: String

    public init(root: DataRoot, store: AtomicFileStore = AtomicFileStore()) {
        self.root = root
        self.store = store
        self.quarantine = FileQuarantine(rootURL: root.quarantineURL)
        self.leaseOwner = "SettingsStore.\(UUID().uuidString)"
    }

    public func load() -> Settings {
        let url = root.settingsURL
        guard store.exists(url) else { return Settings() }
        do {
            return Settings(json: try store.readJSON(url)).migratedToCurrent()
        } catch {
            _ = try? quarantine.quarantineFile(url, reason: "unreadable settings.json", store: store)
            return Settings()
        }
    }

    @discardableResult
    public func save(_ settings: Settings) throws -> Settings {
        try root.acquireWriteLease(owner: leaseOwner)
        defer { root.releaseWriteLease(owner: leaseOwner) }
        var copy = settings
        copy.version = Settings.currentVersion
        try store.writeJSON(copy.json, to: root.settingsURL)
        return copy
    }

    @discardableResult
    public func update(_ mutate: (inout Settings) -> Void) throws -> Settings {
        // Read and write under one lease; save re-enters with the same owner.
        try root.acquireWriteLease(owner: leaseOwner)
        defer { root.releaseWriteLease(owner: leaseOwner) }
        var settings = load()
        mutate(&settings)
        return try save(settings)
    }
}
