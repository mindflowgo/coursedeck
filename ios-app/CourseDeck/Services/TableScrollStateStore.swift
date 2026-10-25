import CoreGraphics
import Foundation

/// Persists the inner scroll offsets of each table across cell reuse, reader
/// scrolling, and the full-screen table route. Offsets are kept in memory for
/// the lifetime of the reader; the store is app-scoped so a full-screen table
/// and the embedded viewport share the same values.
final class TableScrollStateStore {
    struct State: Equatable {
        var horizontal: CGFloat = 0
        var vertical: CGFloat = 0
    }

    private var states: [String: State] = [:]
    private let lock = NSLock()

    func state(documentID: String, tableID: String) -> State? {
        lock.lock()
        defer { lock.unlock() }
        return states[key(documentID: documentID, tableID: tableID)]
    }

    func setState(_ state: State, documentID: String, tableID: String) {
        lock.lock()
        states[key(documentID: documentID, tableID: tableID)] = state
        lock.unlock()
    }

    func clear(documentID: String) {
        lock.lock()
        let prefix = "\(documentID)::"
        states = states.filter { !$0.key.hasPrefix(prefix) }
        lock.unlock()
    }

    private func key(documentID: String, tableID: String) -> String {
        "\(documentID)::\(tableID)"
    }
}
