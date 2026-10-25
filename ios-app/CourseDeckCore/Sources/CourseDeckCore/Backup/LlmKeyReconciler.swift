import Foundation

public struct LlmKeyReconciliation: Equatable, Sendable {
    public var store: LlmStore
    public var pendingReplacements: [PendingKeyReplacement]
    public var adoptedCardIDs: [String]

    public init(
        store: LlmStore,
        pendingReplacements: [PendingKeyReplacement] = [],
        adoptedCardIDs: [String] = []
    ) {
        self.store = store
        self.pendingReplacements = pendingReplacements
        self.adoptedCardIDs = adoptedCardIDs
    }
}

/// Reconciles the Keychain accounts produced by backup staging with the merged
/// model-card list (PLAN §4.7 / §4.1).
///
/// Staging migrates imported plaintext keys into Keychain accounts keyed by the
/// *imported* card ID. If a local card already represents the same normalized
/// endpoint, the merged store keeps only the local card; this reconciler moves
/// the imported key to the local account when the local card has none, or
/// preserves the imported card so the user can choose between two keys.
public enum LlmKeyReconciler {
    public static func reconcile(
        imported: LlmStore,
        merged: LlmStore,
        secretStore: SecretStore?
    ) -> LlmKeyReconciliation {
        guard let secretStore else {
            return LlmKeyReconciliation(store: merged)
        }

        var result = merged
        var pending: [PendingKeyReplacement] = []
        var adopted: [String] = []

        for importedCard in imported.cards {
            let importedKey = (try? secretStore.secret(for: importedCard.keyAccount))?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let endpoint = KeyMigrator.normalizedBaseURL(importedCard.baseUrl)

            guard let matched = result.cards.first(where: {
                KeyMigrator.normalizedBaseURL($0.baseUrl) == endpoint
            }) else {
                // Same ID at a different endpoint (or a provider we cannot
                // merge) would lose the imported key. Keep it under a unique
                // card ID/account so auditOrphans does not destroy it.
                if result.cards.contains(where: { $0.id == importedCard.id }), !importedKey.isEmpty {
                    retainImportedCard(
                        importedCard,
                        key: importedKey,
                        secretStore: secretStore,
                        result: &result
                    )
                }
                continue
            }

            if matched.id == importedCard.id, matched.keyAccount == importedCard.keyAccount {
                // Same card and account: the shared Keychain item already
                // belongs to both sides.
                continue
            }

            if matched.provider != importedCard.provider {
                if !importedKey.isEmpty {
                    retainImportedCard(
                        importedCard,
                        key: importedKey,
                        secretStore: secretStore,
                        result: &result
                    )
                }
                continue
            }

            let localKey = (try? secretStore.secret(for: matched.keyAccount))?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""

            if importedKey.isEmpty {
                continue
            }
            if localKey.isEmpty {
                // Local card had no key: adopt the imported key and remove the
                // now-redundant imported account.
                try? secretStore.setSecret(importedKey, for: matched.keyAccount)
                try? secretStore.deleteSecret(for: importedCard.keyAccount)
                adopted.append(matched.id)
            } else if localKey == importedKey {
                try? secretStore.deleteSecret(for: importedCard.keyAccount)
            } else {
                // Both sides have different keys. Keep the imported card (and
                // its Keychain item) so auditOrphans does not destroy it before
                // the user chooses; surface a replace prompt in the report.
                if !result.cards.contains(where: { $0.id == importedCard.id }) {
                    var copy = importedCard
                    copy.apiKey = ""
                    result.cards.append(copy)
                }
                pending.append(PendingKeyReplacement(
                    cardId: matched.id,
                    cardLabel: matched.label,
                    endpoint: endpoint,
                    importedCardId: importedCard.id,
                    importedCardLabel: importedCard.label
                ))
            }
        }

        if let activeId = result.activeId,
           !result.cards.contains(where: { $0.id == activeId }) {
            result.activeId = result.cards.first?.id
        }
        // Remove accounts for cards that disappeared in the merge. Pending
        // imported cards are part of `result`, so their keys survive.
        _ = try? KeyMigrator(secretStore: secretStore).auditOrphans(knownCards: result.cards)

        return LlmKeyReconciliation(
            store: result,
            pendingReplacements: pending,
            adoptedCardIDs: adopted
        )
    }

    /// Preserves an imported card/key that cannot be merged into a local card
    /// (different endpoint or incompatible provider) by assigning a fresh card
    /// ID and moving the Keychain item to the matching account.
    private static func retainImportedCard(
        _ importedCard: LlmModelCard,
        key: String,
        secretStore: SecretStore,
        result: inout LlmStore
    ) {
        let existingIDs = Set(result.cards.map(\.id))
        var uniqueID: String
        repeat {
            uniqueID = "card_imported_\(UUID().uuidString.prefix(8).lowercased())"
        } while existingIDs.contains(uniqueID)

        var copy = importedCard
        copy.id = uniqueID
        copy.apiKey = ""
        if copy.keyAccount != importedCard.keyAccount {
            try? secretStore.setSecret(key, for: copy.keyAccount)
            try? secretStore.deleteSecret(for: importedCard.keyAccount)
        }
        result.cards.append(copy)
    }
}
