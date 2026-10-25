import CourseDeckCore
import SwiftUI

// MARK: - Create custom tab

struct CustomTabCreateSheet: View {
    let courseId: String
    let scope: ReaderScope
    let onCreated: (DocumentSnapshot) -> Void

    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var services: AppServices
    @State private var name = ""
    @State private var error: String?
    @State private var isSaving = false

    private var slug: String {
        PathValidator.slugifyTabName(name)
    }

    private var validationMessage: String? {
        if name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return nil
        }
        if slug.isEmpty {
            return "Use at least one letter or number."
        }
        if (try? PathValidator.tab(slug)) == nil {
            return "Tab names must be 1–32 lowercase letters, numbers, or underscores."
        }
        if PathValidator.isReservedTab(slug) {
            return "That name is reserved by a built-in tab."
        }
        return nil
    }

    private var canCreate: Bool {
        !isSaving
            && !slug.isEmpty
            && (try? PathValidator.tab(slug)) != nil
            && !PathValidator.isReservedTab(slug)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Tab name") {
                    TextField("e.g. Exam review", text: $name)
                        .textInputAutocapitalization(.words)
                        .accessibilityIdentifier("customTab.name")
                    if !slug.isEmpty {
                        Text("File: \(fileName)")
                            .font(.caption.monospaced())
                            .foregroundStyle(.secondary)
                    }
                }
                if let validationMessage {
                    Section {
                        Text(validationMessage)
                            .font(.footnote)
                            .foregroundStyle(.orange)
                    }
                }
                if let error {
                    Section {
                        Text(error).font(.footnote).foregroundStyle(.red)
                    }
                }
                Section {
                    Text("Custom tabs are plain Markdown files. Built-in tabs (lesson, summary, cheatsheet, test, schedule, popquiz, assignments) are reserved.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
            .navigationTitle("New custom tab")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create") { create() }
                        .disabled(!canCreate)
                        .accessibilityIdentifier("customTab.create")
                }
            }
            .accessibilityIdentifier("customTab.root")
        }
    }

    private var fileName: String {
        switch scope {
        case let .lesson(lessonId):
            return "\(lessonId.lowercased()).\(slug).md"
        case let .unit(number):
            return String(format: "%02d", number) + ".unit.\(slug).md"
        case .course:
            return "course.\(slug).md"
        }
    }

    private func create() {
        isSaving = true
        error = nil
        Task {
            do {
                let snapshot = try await services.createCustomTab(
                    courseId: courseId,
                    scope: scope,
                    tab: slug
                )
                onCreated(snapshot)
                dismiss()
            } catch {
                self.error = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            }
            isSaving = false
        }
    }
}

// MARK: - Reusable delete confirmation

struct CustomTabDeleteModifier: ViewModifier {
    let onDelete: (String) -> Void
    @Binding var pending: WorkspaceTabOption?

    func body(content: Content) -> some View {
        content
            .confirmationDialog(
                "Delete “\(pending?.title ?? "")”?",
                isPresented: Binding(
                    get: { pending != nil },
                    set: { if !$0 { pending = nil } }
                ),
                presenting: pending
            ) { tab in
                Button("Delete custom tab", role: .destructive) {
                    onDelete(tab.slug)
                    pending = nil
                }
                Button("Cancel", role: .cancel) { pending = nil }
            } message: { _ in
                Text("The Markdown file is moved to the recoverable CourseDeck trash (not destroyed).")
            }
    }
}

extension View {
    func customTabDeleteConfirmation(
        pending: Binding<WorkspaceTabOption?>,
        onDelete: @escaping (String) -> Void
    ) -> some View {
        modifier(CustomTabDeleteModifier(onDelete: onDelete, pending: pending))
    }
}

// MARK: - Trash / restore

struct CustomTabTrashView: View {
    let courseId: String
    let onRestored: (DocumentSnapshot) -> Void

    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var services: AppServices
    @State private var documents: [TrashedDocument] = []
    @State private var error: String?
    @State private var restoringID: String?

    var body: some View {
        NavigationStack {
            List {
                if let error {
                    Section { Text(error).foregroundStyle(.red) }
                }
                if documents.isEmpty {
                    Text("No deleted custom tabs for this course.")
                        .foregroundStyle(.secondary)
                }
                ForEach(documents) { document in
                    HStack {
                        VStack(alignment: .leading, spacing: 3) {
                            Text(document.displayName)
                            Text("\(document.fileName) · \(document.deletedAt)")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        Button {
                            restore(document)
                        } label: {
                            if restoringID == document.id {
                                ProgressView()
                            } else {
                                Text("Restore")
                            }
                        }
                        .buttonStyle(.bordered)
                        .disabled(restoringID != nil)
                        .accessibilityIdentifier("trash.restore.\(document.tab)")
                    }
                }
            }
            .navigationTitle("Recently deleted")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
            .task { await load() }
            .refreshable { await load() }
            .accessibilityIdentifier("trash.root")
        }
    }

    private func load() async {
        documents = await services.trashedDocuments(courseId: courseId)
    }

    private func restore(_ document: TrashedDocument) {
        restoringID = document.id
        error = nil
        Task {
            do {
                let snapshot = try await services.restoreTrashedDocument(id: document.id)
                onRestored(snapshot)
                services.bumpDataRevision()
                await load()
            } catch {
                self.error = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            }
            restoringID = nil
        }
    }
}
