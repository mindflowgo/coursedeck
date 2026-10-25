import CourseDeckCore
import SwiftUI

@MainActor
final class PromptManagerModel: ObservableObject {
    @Published private(set) var inventory: [PromptInventoryEntry] = []
    @Published var error: String?

    private let services: AppServices

    init(services: AppServices = .shared) {
        self.services = services
    }

    func load() async {
        do {
            inventory = try await services.promptInventory()
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}

struct PromptManagerView: View {
    @StateObject private var model = PromptManagerModel()
    @EnvironmentObject private var services: AppServices
    @State private var showingNewPrompt = false

    var body: some View {
        List {
            if let error = model.error {
                Text(error).foregroundStyle(.red)
            }
            ForEach(model.inventory, id: \.prompt.id) { entry in
                NavigationLink {
                    PromptEditorView(entry: entry) {
                        Task { await model.load() }
                    }
                } label: {
                    VStack(alignment: .leading, spacing: 3) {
                        HStack {
                            Text(entry.prompt.title)
                            if entry.isUserEdited {
                                Text("edited")
                                    .font(.caption2)
                                    .padding(.horizontal, 6)
                                    .padding(.vertical, 2)
                                    .background(Color.orange.opacity(0.18), in: Capsule())
                            }
                        }
                        Text("\(entry.prompt.id) · \(entry.provenance?.source.rawValue ?? entry.prompt.source.rawValue)")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
        .navigationTitle("Prompts")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    showingNewPrompt = true
                } label: {
                    Label("New prompt", systemImage: "plus")
                }
                .accessibilityIdentifier("promptManager.new")
            }
        }
        .sheet(isPresented: $showingNewPrompt) {
            NewPromptSheet(existingIDs: Set(model.inventory.map(\.prompt.id))) { _ in
                Task { await model.load() }
            }
            .environmentObject(services)
        }
        .task { await model.load() }
        .refreshable { await model.load() }
        .accessibilityIdentifier("promptManager.root")
    }
}

struct PromptEditorView: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var services: AppServices
    let entry: PromptInventoryEntry
    let onChanged: () -> Void

    @State private var content: String
    @State private var message: String?
    @State private var error: String?
    @State private var showingDeleteConfirmation = false
    @State private var showingRestoreConfirmation = false
    @State private var showingDiff = false
    @State private var isSaving = false

    init(entry: PromptInventoryEntry, onChanged: @escaping () -> Void) {
        self.entry = entry
        self.onChanged = onChanged
        _content = State(initialValue: entry.prompt.content)
    }

    var body: some View {
        Form {
            Section("Prompt") {
                TextEditor(text: $content)
                    .font(.system(.body, design: .monospaced))
                    .frame(minHeight: 260)
                    .accessibilityIdentifier("promptEditor.content")
            }
            Section("Provenance") {
                Text("Source: \(entry.provenance?.source.rawValue ?? entry.prompt.source.rawValue)")
                if let bundled = entry.bundledSHA256 {
                    Text("Bundled hash: \(bundled.prefix(16))…").font(.caption2)
                }
                if let active = entry.provenance?.activeSHA256 {
                    Text("Active hash: \(active.prefix(16))…").font(.caption2)
                }
                Text("Edits are saved to the active prompts folder. Bundled defaults are never overwritten.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                if entry.bundledContent != nil {
                    Button {
                        showingDiff = true
                    } label: {
                        Label("Compare with bundled default", systemImage: "doc.on.doc")
                    }
                    .accessibilityIdentifier("promptEditor.diff")
                }
            }
            if let message {
                Section { Text(message).foregroundStyle(.green) }
            }
            if let error {
                Section { Text(error).foregroundStyle(.red) }
            }
            Section {
                Button("Save") { save() }
                    .disabled(isSaving || content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .accessibilityIdentifier("promptEditor.save")
                if entry.bundledSHA256 != nil {
                    Button("Restore bundled default") {
                        showingRestoreConfirmation = true
                    }
                    .accessibilityIdentifier("promptEditor.restore")
                }
                if !PromptCatalog.isProtected(entry.prompt.id) {
                    Button("Delete prompt", role: .destructive) {
                        showingDeleteConfirmation = true
                    }
                }
            }
        }
        .navigationTitle(entry.prompt.id)
        .navigationBarTitleDisplayMode(.inline)
        .alert("Delete this prompt?", isPresented: $showingDeleteConfirmation) {
            Button("Delete", role: .destructive) { deletePrompt() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("The active prompt file is deleted. The bundled default (if any) remains available.")
        }
        .alert("Restore bundled default?", isPresented: $showingRestoreConfirmation) {
            Button("Restore", role: .destructive) { restore() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("The current active prompt is saved as prompts/\(entry.prompt.id).md.bak, then replaced with the bundled default.")
        }
        .sheet(isPresented: $showingDiff) {
            PromptDiffView(
                promptID: entry.prompt.id,
                active: content,
                bundled: entry.bundledContent ?? ""
            )
        }
        .accessibilityIdentifier("promptEditor.root")
    }

    private func save() {
        isSaving = true
        message = nil
        error = nil
        Task {
            do {
                let saved = try await services.savePromptContent(id: entry.prompt.id, content: content)
                content = saved.content
                message = "Prompt saved."
                onChanged()
            } catch {
                self.error = error.localizedDescription
            }
            isSaving = false
        }
    }

    private func restore() {
        message = nil
        error = nil
        Task {
            do {
                let restored = try await services.restorePrompt(id: entry.prompt.id)
                content = restored.content
                message = "Bundled default restored."
                onChanged()
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    private func deletePrompt() {
        Task {
            do {
                _ = try await services.deletePrompt(id: entry.prompt.id)
                onChanged()
                dismiss()
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}

// MARK: - New prompt

struct NewPromptSheet: View {
    let existingIDs: Set<String>
    let onCreated: (Prompt) -> Void

    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var services: AppServices
    @State private var rawID = ""
    @State private var content = "# New Prompt\n\n"
    @State private var error: String?
    @State private var isSaving = false

    private var promptID: String {
        var value = rawID.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        value = value.replacingOccurrences(of: "\\s+", with: "_", options: .regularExpression)
        value = value.replacingOccurrences(of: "[^a-z0-9._-]", with: "", options: .regularExpression)
        value = String(value.prefix(64))
        return value
    }

    private var validationMessage: String? {
        if rawID.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return nil }
        if promptID.isEmpty { return "Use at least one letter or number." }
        if (try? PathValidator.promptId(promptID)) == nil {
            return "Prompt IDs must start with a letter or number and use letters, numbers, dots, dashes or underscores."
        }
        if PromptCatalog.isProtected(promptID) {
            return "That ID is reserved by a built-in prompt. Choose another ID."
        }
        if existingIDs.contains(promptID) {
            return "A prompt with that ID already exists. Choose another ID or edit the existing prompt."
        }
        if content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return "Prompt content cannot be empty."
        }
        return nil
    }

    private var canSave: Bool {
        !isSaving
            && !promptID.isEmpty
            && (try? PathValidator.promptId(promptID)) != nil
            && !PromptCatalog.isProtected(promptID)
            && !existingIDs.contains(promptID)
            && !content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("ID") {
                    TextField("e.g. exam_review", text: $rawID)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .accessibilityIdentifier("prompt.new.id")
                    if !promptID.isEmpty {
                        Text("File: prompts/\(promptID).md")
                            .font(.caption.monospaced())
                            .foregroundStyle(.secondary)
                    }
                }
                Section("Prompt") {
                    TextEditor(text: $content)
                        .font(.system(.body, design: .monospaced))
                        .frame(minHeight: 220)
                        .accessibilityIdentifier("prompt.new.content")
                }
                if let validationMessage {
                    Section {
                        Text(validationMessage).font(.footnote).foregroundStyle(.orange)
                    }
                }
                if let error {
                    Section {
                        Text(error).font(.footnote).foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("New prompt")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create") { create() }
                        .disabled(!canSave)
                        .accessibilityIdentifier("prompt.new.create")
                }
            }
            .accessibilityIdentifier("prompt.new.root")
        }
    }

    private func create() {
        isSaving = true
        error = nil
        Task {
            do {
                let prompt = try await services.createPrompt(id: promptID, content: content)
                onCreated(prompt)
                dismiss()
            } catch {
                self.error = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            }
            isSaving = false
        }
    }
}

// MARK: - Diff

struct PromptDiffView: View {
    let promptID: String
    let active: String
    let bundled: String

    @Environment(\.dismiss) private var dismiss

    private var lines: [PromptDiffLine] {
        PromptDiff.compare(active: active, bundled: bundled)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                        HStack(alignment: .top, spacing: 8) {
                            Text(prefix(for: line.kind))
                                .font(.caption.monospaced().weight(.bold))
                                .foregroundStyle(color(for: line.kind))
                                .frame(width: 14, alignment: .leading)
                            Text(line.text.isEmpty ? " " : line.text)
                                .font(.caption.monospaced())
                                .foregroundStyle(color(for: line.kind))
                                .textSelection(.enabled)
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 1)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(background(for: line.kind))
                    }
                }
                .padding(.vertical, 8)
            }
            .navigationTitle("Active vs bundled")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
            .safeAreaInset(edge: .bottom) {
                HStack(spacing: 14) {
                    Label("Active", systemImage: "minus.circle").foregroundStyle(.red)
                    Label("Bundled", systemImage: "plus.circle").foregroundStyle(.green)
                    Spacer()
                }
                .font(.caption)
                .padding(10)
                .background(.bar)
            }
            .accessibilityIdentifier("prompt.diff")
        }
    }

    private func prefix(for kind: PromptDiffKind) -> String {
        switch kind {
        case .unchanged: return " "
        case .added: return "+"
        case .removed: return "−"
        }
    }

    private func color(for kind: PromptDiffKind) -> Color {
        switch kind {
        case .unchanged: return .secondary
        case .added: return .green
        case .removed: return .red
        }
    }

    private func background(for kind: PromptDiffKind) -> Color {
        switch kind {
        case .unchanged: return .clear
        case .added: return .green.opacity(0.08)
        case .removed: return .red.opacity(0.08)
        }
    }
}
