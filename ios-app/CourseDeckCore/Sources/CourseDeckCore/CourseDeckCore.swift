import Foundation

/// Namespace for CourseDeck's Foundation-only core.
///
/// Phase 0 only establishes the package and its test target. Models, storage,
/// markdown, AI, and ingestion live under this namespace in later phases.
public enum CourseDeckCore {
    /// Marketing version reported by the app shell and diagnostics.
    public static let version = "0.1.0"

    /// Stable bundle identifier used by Settings/ diagnostics. Signing may
    /// rewrite the installed identifier; this is the source value only.
    public static let bundleIdentifier = "com.ilc.coursedeck"
}
