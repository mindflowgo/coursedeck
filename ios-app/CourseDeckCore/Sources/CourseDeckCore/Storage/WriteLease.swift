import Foundation

public enum WriteLeaseError: Error, LocalizedError, Equatable {
    case timedOut(owner: String, heldBy: String?)

    public var errorDescription: String? {
        switch self {
        case let .timedOut(owner, heldBy):
            return "Timed out acquiring the data write lease for \(owner); held by \(heldBy ?? "another operation")."
        }
    }
}

/// A process-wide exclusive write lease for the data root.
///
/// Backup export/import hold it for their whole operation (quiescing editor
/// saves and generation writes); repositories and stores acquire it around
/// each mutation. Same-owner acquisition is reentrant so a repository method
/// can call another mutating helper without deadlocking.
public final class WriteLease: @unchecked Sendable {
    private let condition = NSCondition()
    private var owner: String?
    private var depth = 0

    public init() {}

    public var isHeld: Bool {
        condition.lock()
        defer { condition.unlock() }
        return owner != nil
    }

    public var holder: String? {
        condition.lock()
        defer { condition.unlock() }
        return owner
    }

    public func acquire(owner newOwner: String, timeout: TimeInterval = 30) throws {
        condition.lock()
        defer { condition.unlock() }
        let deadline = Date().addingTimeInterval(timeout)
        while let current = owner, current != newOwner {
            if !condition.wait(until: deadline) {
                throw WriteLeaseError.timedOut(owner: newOwner, heldBy: current)
            }
        }
        owner = newOwner
        depth += 1
    }

    @discardableResult
    public func tryAcquire(owner newOwner: String) -> Bool {
        condition.lock()
        defer { condition.unlock() }
        if let current = owner, current != newOwner { return false }
        owner = newOwner
        depth += 1
        return true
    }

    public func release(owner newOwner: String) {
        condition.lock()
        defer { condition.unlock() }
        guard owner == newOwner else { return }
        depth -= 1
        if depth <= 0 {
            depth = 0
            owner = nil
            condition.broadcast()
        }
    }
}
