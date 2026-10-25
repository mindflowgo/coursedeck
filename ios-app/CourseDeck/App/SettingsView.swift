import CourseDeckCore
import SwiftUI
import UniformTypeIdentifiers

@MainActor
final class SettingsModel: ObservableObject {
    @Published private(set) var configuration: LlmProviderConfiguration?
    @Published private(set) var prompts: [PromptInventoryEntry] = []
    @Published var error: String?

    private let services: AppServices

    init(services: AppServices = .shared) {
        self.services = services
    }

    func load() async {
        do {
            configuration = try await services.providerConfiguration()
            prompts = try await services.promptInventory()
            await services.validatePendingKeyReplacements()
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    var activeCardID: String? {
        configuration?.store.activeId
    }
}

struct SettingsView: View {
    @EnvironmentObject private var services: AppServices
    @Environment(\.dismiss) private var dismiss
    @StateObject private var model = SettingsModel()
    @State private var editorTarget: CardEditorTarget?
    @State private var showingConsent = false
    @State private var showingImportConfirmation = false
    @State private var showingImporter = false
    @State private var isImporting = false
    @State private var importSummary: String?

    var body: some View {
        Form {
            aiAccessSection
            modelCardsSection
            promptsSection
            generationSection
            keyReplacementSection
            backupSection
            if let error = model.error {
                Section("Error") {
                    Text(error).foregroundStyle(.red)
                }
            }
        }
        .navigationTitle("Settings")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .confirmationAction) {
                Button("Done") { dismiss() }
                    .accessibilityIdentifier("settings.done")
            }
        }
        .task { await model.load() }
        .refreshable { await model.load() }
        .sheet(item: $editorTarget) { target in
            ModelCardEditorView(
                card: target.card,
                extensions: target.extensions,
                hasStoredKey: target.hasStoredKey
            ) {
                Task { await model.load() }
            }
        }
        .sheet(isPresented: $showingConsent) {
            AIConsentView(
                onAccept: {
                    Task {
                        await services.acceptAIConsent()
                        showingConsent = false
                    }
                },
                onNotNow: { showingConsent = false }
            )
        }
        .confirmationDialog(
            "Import a CourseDeck backup?",
            isPresented: $showingImportConfirmation,
            titleVisibility: .visible
        ) {
            Button("Choose backup zip") { showingImporter = true }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("The import merges missing files. Existing files are kept and differing files go to _conflicts. Generation is interrupted while the import runs.")
        }
        .fileImporter(
            isPresented: $showingImporter,
            allowedContentTypes: [.zip],
            allowsMultipleSelection: false
        ) { result in
            switch result {
            case let .success(urls):
                guard let url = urls.first else { return }
                isImporting = true
                Task {
                    do {
                        let imported = try await services.importBackup(from: url)
                        importSummary = Self.summary(for: imported)
                        await model.load()
                    } catch {
                        model.error = error.localizedDescription
                    }
                    isImporting = false
                }
            case let .failure(error):
                model.error = error.localizedDescription
            }
        }
        .overlay {
            if isImporting {
                ProgressView("Importing backup…")
                    .padding(24)
                    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16))
            }
        }
        .accessibilityIdentifier("settings.root")
    }

    // MARK: - Sections

    private var aiAccessSection: some View {
        Section("AI access") {
            if services.settings.hasAIConsent {
                Label("Disclosure accepted (version \(services.settings.aiConsentVersion))", systemImage: "checkmark.shield")
                    .foregroundStyle(.green)
                if let date = services.settings.aiConsentAcceptedAt {
                    Text(date).font(.caption).foregroundStyle(.secondary)
                }
            } else {
                Label("AI generation is disabled until you accept the disclosure.", systemImage: "lock")
                    .foregroundStyle(.secondary)
            }
            Button("Review AI disclosure") { showingConsent = true }
                .accessibilityIdentifier("settings.aiDisclosure")
            if services.settings.hasAIConsent {
                Button("Revoke AI consent", role: .destructive) {
                    Task { await services.revokeAIConsent() }
                }
                .accessibilityIdentifier("settings.revokeConsent")
            }
            HStack {
                Label(
                    services.generationIsRunning ? "Generation queue running" : "Generation queue stopped",
                    systemImage: services.generationIsRunning ? "bolt.fill" : "pause.circle"
                )
                .font(.footnote)
                .foregroundStyle(services.generationIsRunning ? Color.green : Color.secondary)
                Spacer()
                Button("Retry recovery") {
                    Task { await services.retryGenerationRecovery() }
                }
                .font(.footnote)
            }
            if let error = services.generationError {
                Text(error).font(.footnote).foregroundStyle(.red)
            }
        }
    }

    private var modelCardsSection: some View {
        Section("Model cards") {
            if let configuration = model.configuration {
                ForEach(configuration.store.cards, id: \.id) { card in
                    HStack(alignment: .top, spacing: 10) {
                        Button {
                            Task {
                                try? await services.setActiveModelCard(id: card.id)
                                await model.load()
                            }
                        } label: {
                            Image(systemName: configuration.store.activeId == card.id ? "checkmark.circle.fill" : "circle")
                                .foregroundStyle(configuration.store.activeId == card.id ? Color.accentColor : Color.secondary)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Set \(card.label) active")

                        VStack(alignment: .leading, spacing: 2) {
                            Text(card.label)
                            Text("\(card.model) · \(endpointHost(card.baseUrl))")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                            Text(configuration.apiKeys[card.id].flatMap { $0.isEmpty ? nil : $0 } == nil ? "No key stored" : "Key stored in Keychain")
                                .font(.caption2)
                                .foregroundStyle(configuration.apiKeys[card.id].flatMap { $0.isEmpty ? nil : $0 } == nil ? .orange : .green)
                        }
                        Spacer()
                        Button("Edit") {
                            editorTarget = CardEditorTarget(
                                card: card,
                                extensions: configuration.extensions[card.id],
                                hasStoredKey: configuration.apiKeys[card.id]?.isEmpty == false
                            )
                        }
                        .buttonStyle(.bordered)
                    }
                    .swipeActions {
                        Button("Delete", role: .destructive) {
                            Task {
                                try? await services.deleteModelCard(id: card.id)
                                await model.load()
                            }
                        }
                    }
                }
                Button {
                    editorTarget = CardEditorTarget(
                        card: nil,
                        extensions: nil,
                        hasStoredKey: false
                    )
                } label: {
                    Label("Add model card", systemImage: "plus")
                }
                .accessibilityIdentifier("settings.addCard")
            } else {
                ProgressView()
            }
        }
    }

    private var promptsSection: some View {
        Section("Prompts") {
            NavigationLink {
                PromptManagerView()
            } label: {
                Label("Prompt manager", systemImage: "doc.text")
            }
            .accessibilityIdentifier("settings.prompts")
            Text("\(model.prompts.count) prompt files · bundled defaults are restored individually")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }

    private var generationSection: some View {
        Section("Generation") {
            NavigationLink {
                GenerationJobsView()
            } label: {
                Label("Generation jobs", systemImage: "list.bullet.rectangle")
            }
            .accessibilityIdentifier("settings.jobs")
            NavigationLink {
                MissingWorkView()
            } label: {
                Label("Scan missing work", systemImage: "magnifyingglass")
            }
            .accessibilityIdentifier("settings.missingWork")
        }
    }

    private var keyReplacementSection: some View {
        Section("Imported key replacements") {
            if services.pendingKeyReplacements.isEmpty {
                Text("No pending imported keys.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(services.pendingKeyReplacements) { candidate in
                    VStack(alignment: .leading, spacing: 4) {
                        Text("\(candidate.cardLabel) ← \(candidate.importedCardLabel)")
                            .font(.callout)
                        Text(candidate.endpoint)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                        HStack {
                            Button("Replace local key") {
                                Task {
                                    try? await services.replacePendingKey(candidate)
                                    await model.load()
                                }
                            }
                            .buttonStyle(.borderedProminent)
                            Button("Keep local key", role: .destructive) {
                                Task {
                                    try? await services.keepLocalKey(candidate)
                                    await model.load()
                                }
                            }
                            .buttonStyle(.bordered)
                        }
                    }
                }
            }
        }
    }

    private var backupSection: some View {
        Section("Backup") {
            Button {
                showingImportConfirmation = true
            } label: {
                Label("Import backup (merge)", systemImage: "square.and.arrow.down")
            }
            .disabled(isImporting)
            .accessibilityIdentifier("settings.importBackup")
            if let importSummary {
                Text(importSummary).font(.footnote).foregroundStyle(.secondary)
            }
            if let report = services.lastBackupReport {
                Text("Last import: \(report.filesWritten) files, \(report.importedPrompts.count) prompts, \(report.pendingKeyReplacements.count) key prompts")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
    }

    // MARK: - Helpers

    private func endpointHost(_ raw: String) -> String {
        URLComponents(string: raw)?.host ?? raw
    }

    private static func summary(for result: BackupImportResult) -> String {
        let report = result.report
        var parts = ["Imported \(result.filesImported) files"]
        if !report.importedPrompts.isEmpty { parts.append("\(report.importedPrompts.count) prompts") }
        if !report.conflicts.isEmpty { parts.append("\(report.conflicts.count) conflicts") }
        if !report.skipped.isEmpty { parts.append("\(report.skipped.count) skipped") }
        if !report.pendingKeyReplacements.isEmpty { parts.append("\(report.pendingKeyReplacements.count) key replacements need review") }
        return parts.joined(separator: " · ")
    }
}

private struct CardEditorTarget: Identifiable {
    let id = UUID()
    var card: LlmModelCard?
    var extensions: LlmCardExtensions?
    var hasStoredKey: Bool
}
