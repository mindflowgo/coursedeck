import CourseDeckCore
import SwiftUI
import UIKit

struct MarkdownEditorContext: Identifiable {
    var id: String { "\(target.courseId):\(target.id)" }
    var target: ReaderTarget
    var title: String
    var snapshot: DocumentSnapshot
}

/// Narrow seam for editor tests. Production uses `AppServices`.
@MainActor
protocol MarkdownEditorDataProviding: AnyObject {
    func documentURL(for target: ReaderTarget) throws -> URL
    func markdownSnapshot(for target: ReaderTarget) async throws -> DocumentSnapshot
    func saveMarkdown(
        target: ReaderTarget,
        content: String,
        expectedSHA256: String,
        force: Bool
    ) async throws -> DocumentSnapshot
    func bumpDataRevision()
}

extension AppServices: MarkdownEditorDataProviding {}

// MARK: - File presenter

/// Registered while an editor is open so `NSFileCoordinator` can serialize
/// external Files-app/two-scene writes and the editor learns about changes
/// before its next save.
final class EditorFilePresenter: NSObject, NSFilePresenter {
    let presentedItemURL: URL?
    let presentedItemOperationQueue: OperationQueue
    var onExternalChange: (() -> Void)?

    init(url: URL) {
        self.presentedItemURL = url
        let queue = OperationQueue()
        queue.name = "CourseDeck.EditorFilePresenter"
        queue.maxConcurrentOperationCount = 1
        self.presentedItemOperationQueue = queue
        super.init()
    }

    func presentedItemDidChange() {
        onExternalChange?()
    }
}

// MARK: - Model

@MainActor
final class MarkdownEditorModel: ObservableObject {
    enum SaveState: Equatable {
        case saved
        case editing
        case saving
        case conflict
        case failed(String)

        var label: String {
            switch self {
            case .saved: return "Saved"
            case .editing: return "Unsaved changes"
            case .saving: return "Saving…"
            case .conflict: return "File changed on disk"
            case let .failed(message): return message
            }
        }
    }

    @Published var text: String
    @Published private(set) var state: SaveState = .saved
    @Published private(set) var lastSavedAt: Date?
    @Published var showingConflict = false
    @Published var showingDiscardConfirmation = false
    @Published var showingError: String?

    let target: ReaderTarget
    let title: String
    let fileName: String

    private var savedText: String
    private var sha256: String
    private var saveTask: Task<Void, Never>?
    private let dataSource: any MarkdownEditorDataProviding
    private let autosaveDelay: TimeInterval
    private var presenter: EditorFilePresenter?

    init(
        context: MarkdownEditorContext,
        dataSource: any MarkdownEditorDataProviding = AppServices.shared,
        autosaveDelay: TimeInterval = 3,
        registerFilePresenter: Bool = true
    ) {
        self.target = context.target
        self.title = context.title
        self.fileName = context.snapshot.fileName
        self.text = context.snapshot.content
        self.savedText = context.snapshot.content
        self.sha256 = context.snapshot.sha256
        self.dataSource = dataSource
        self.autosaveDelay = autosaveDelay

        if registerFilePresenter,
           let url = try? dataSource.documentURL(for: context.target) {
            let presenter = EditorFilePresenter(url: url)
            NSFileCoordinator.addFilePresenter(presenter)
            self.presenter = presenter
            presenter.onExternalChange = { [weak self] in
                Task { @MainActor in
                    await self?.externalChangeDetected()
                }
            }
        }
    }

    deinit {
        if let presenter {
            NSFileCoordinator.removeFilePresenter(presenter)
        }
    }

    var isDirty: Bool { text != savedText }
    var characterCount: Int { text.count }
    var isPresentingFile: Bool { presenter != nil }

    func textDidChange() {
        guard isDirty else {
            state = .saved
            return
        }
        state = .editing
        saveTask?.cancel()
        saveTask = Task { [weak self] in
            guard let self else { return }
            try? await Task.sleep(nanoseconds: UInt64(max(0, self.autosaveDelay) * 1_000_000_000))
            guard !Task.isCancelled else { return }
            await self.save(force: false)
        }
    }

    func save(force: Bool) async {
        guard isDirty || force else { return }
        saveTask?.cancel()
        let content = text
        state = .saving
        do {
            let saved = try await dataSource.saveMarkdown(
                target: target,
                content: content,
                expectedSHA256: sha256,
                force: force
            )
            sha256 = saved.sha256
            savedText = content
            state = text == content ? .saved : .editing
            lastSavedAt = Date()
            showingConflict = false
            dataSource.bumpDataRevision()
        } catch let error as RepositoryError {
            if case .concurrentModification = error {
                state = .conflict
                showingConflict = true
            } else {
                state = .failed(error.localizedDescription)
                showingError = error.localizedDescription
            }
        } catch {
            state = .failed(error.localizedDescription)
            showingError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    func reloadFromDisk() async {
        do {
            let snapshot = try await dataSource.markdownSnapshot(for: target)
            text = snapshot.content
            savedText = snapshot.content
            sha256 = snapshot.sha256
            state = .saved
            showingConflict = false
        } catch {
            showingError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }
    }

    func flush() async {
        saveTask?.cancel()
        await save(force: false)
    }

    @discardableResult
    func replaceAll(find: String, replacement: String, caseSensitive: Bool) -> Int {
        let result = MarkdownFindReplace.replaceAll(
            in: text,
            find: find,
            replacement: replacement,
            caseSensitive: caseSensitive
        )
        if result.count > 0 {
            text = result.text
            textDidChange()
        }
        return result.count
    }

    @discardableResult
    func replaceNext(find: String, replacement: String, caseSensitive: Bool) -> Bool {
        let result = MarkdownFindReplace.replaceNext(
            in: text,
            find: find,
            replacement: replacement,
            caseSensitive: caseSensitive
        )
        if result.replaced {
            text = result.text
            textDidChange()
        }
        return result.replaced
    }

    /// Returns true only when it is safe to dismiss. Failures and conflicts
    /// keep the editor open; a dirty buffer requires explicit discard.
    func prepareToClose() async -> Bool {
        await flush()
        if case .conflict = state { return false }
        if case .failed = state { return false }
        if isDirty {
            showingDiscardConfirmation = true
            return false
        }
        return true
    }

    func discardChanges() {
        text = savedText
        state = .saved
        showingError = nil
        showingConflict = false
        showingDiscardConfirmation = false
    }

    func stopPresenting() {
        if let presenter {
            NSFileCoordinator.removeFilePresenter(presenter)
            self.presenter = nil
        }
    }

    private func externalChangeDetected() async {
        guard state != .saving else { return }
        guard let snapshot = try? await dataSource.markdownSnapshot(for: target) else { return }
        guard snapshot.sha256 != sha256 else { return }
        state = .conflict
        showingConflict = true
    }
}

// MARK: - Screen

struct MarkdownEditorScreen: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var model: MarkdownEditorModel
    @State private var showingFindReplace = false
    let onDismiss: () -> Void

    init(context: MarkdownEditorContext, onDismiss: @escaping () -> Void = {}) {
        _model = StateObject(wrappedValue: MarkdownEditorModel(context: context))
        self.onDismiss = onDismiss
    }

    var body: some View {
        VStack(spacing: 0) {
            statusBar
            Divider()
            MarkdownTextView(
                text: $model.text,
                onTextChange: { model.textDidChange() }
            )
            .accessibilityIdentifier("markdownEditor.textView")
        }
        .navigationTitle(model.title.isEmpty ? "Edit Markdown" : model.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button {
                    Task {
                        if await model.prepareToClose() {
                            closeEditor()
                        }
                    }
                } label: {
                    Image(systemName: "chevron.left")
                }
                .accessibilityLabel("Back")
                .accessibilityIdentifier("markdownEditor.back")
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    showingFindReplace = true
                } label: {
                    Image(systemName: "magnifyingglass")
                }
                .keyboardShortcut("f", modifiers: .command)
                .accessibilityLabel("Find and replace")
                .accessibilityIdentifier("markdownEditor.find")
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button("Save") {
                    Task { await model.save(force: false) }
                }
                .disabled(!model.isDirty)
                .keyboardShortcut("s", modifiers: .command)
                .accessibilityIdentifier("markdownEditor.save")
            }
        }
        .sheet(isPresented: $showingFindReplace) {
            FindReplaceSheet(model: model)
        }
        .alert("File changed on disk", isPresented: $model.showingConflict) {
            Button("Reload from disk") {
                Task { await model.reloadFromDisk() }
            }
            Button("Overwrite", role: .destructive) {
                Task { await model.save(force: true) }
            }
            Button("Keep editing", role: .cancel) {}
        } message: {
            Text("Another scene, the Files app, or a generation changed \(model.fileName). Reload to keep that version, or overwrite it with your edits. An overwrite keeps a .bak copy.")
        }
        .alert("Discard unsaved changes?", isPresented: $model.showingDiscardConfirmation) {
            Button("Discard changes", role: .destructive) {
                model.discardChanges()
                closeEditor()
            }
            Button("Keep editing", role: .cancel) {}
        } message: {
            Text("Your edits have not been saved. Discard them and close the editor?")
        }
        .alert("Could not save", isPresented: errorBinding) {
            Button("Retry") {
                Task { await model.save(force: false) }
            }
            Button("Discard changes", role: .destructive) {
                model.discardChanges()
                closeEditor()
            }
            Button("Keep editing", role: .cancel) {}
        } message: {
            Text(model.showingError ?? "")
        }
        .onChange(of: scenePhase) { _, phase in
            if phase != .active {
                Task { await model.flush() }
            }
        }
        .onDisappear {
            Task { await model.flush() }
            model.stopPresenting()
        }
        .interactiveDismissDisabled(model.isDirty || model.showingConflict)
        .accessibilityIdentifier("markdownEditor.root")
    }

    private func closeEditor() {
        onDismiss()
        dismiss()
    }

    private var statusBar: some View {
        HStack(spacing: 10) {
            Circle()
                .fill(statusColor)
                .frame(width: 8, height: 8)
            Text(model.state.label)
                .font(.caption)
                .foregroundStyle(.secondary)
            Spacer()
            Text("\(model.characterCount) characters")
                .font(.caption.monospacedDigit())
                .foregroundStyle(.secondary)
            if let saved = model.lastSavedAt {
                Text(saved, style: .time)
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(Color(uiColor: .secondarySystemBackground))
    }

    private var statusColor: Color {
        switch model.state {
        case .saved: return .green
        case .editing, .saving: return .orange
        case .conflict, .failed: return .red
        }
    }

    private var errorBinding: Binding<Bool> {
        Binding(
            get: { model.showingError != nil },
            set: { if !$0 { model.showingError = nil } }
        )
    }
}

// MARK: - UIKit text view

struct MarkdownTextView: UIViewRepresentable {
    @Binding var text: String
    let onTextChange: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(parent: self)
    }

    func makeUIView(context: Context) -> UITextView {
        let textView = UITextView()
        textView.delegate = context.coordinator
        textView.font = UIFontMetrics(forTextStyle: .body).scaledFont(
            for: .monospacedSystemFont(ofSize: 15, weight: .regular)
        )
        textView.adjustsFontForContentSizeCategory = true
        textView.autocorrectionType = .no
        textView.spellCheckingType = .no
        textView.smartQuotesType = .no
        textView.smartDashesType = .no
        textView.smartInsertDeleteType = .no
        textView.autocapitalizationType = .none
        textView.keyboardDismissMode = .interactive
        textView.isFindInteractionEnabled = true
        textView.alwaysBounceVertical = true
        textView.textContainerInset = UIEdgeInsets(top: 16, left: 12, bottom: 28, right: 12)
        textView.textContainer.lineFragmentPadding = 8
        textView.backgroundColor = .systemBackground
        textView.text = text
        textView.accessibilityLabel = "Markdown editor"
        return textView
    }

    func updateUIView(_ textView: UITextView, context: Context) {
        guard textView.text != text else { return }
        let selection = textView.selectedRange
        textView.text = text
        let limit = (text as NSString).length
        let location = min(selection.location, limit)
        let length = min(selection.length, limit - location)
        textView.selectedRange = NSRange(location: location, length: length)
    }

    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: MarkdownTextView

        init(parent: MarkdownTextView) {
            self.parent = parent
        }

        func textViewDidChange(_ textView: UITextView) {
            guard parent.text != textView.text else { return }
            parent.text = textView.text
            parent.onTextChange()
        }
    }
}

// MARK: - Find / replace

struct MarkdownFindReplaceResult: Equatable {
    var text: String
    var count: Int
}

enum MarkdownFindReplace {
    static func replaceAll(
        in text: String,
        find: String,
        replacement: String,
        caseSensitive: Bool
    ) -> MarkdownFindReplaceResult {
        let ranges = ranges(in: text, find: find, caseSensitive: caseSensitive)
        guard !ranges.isEmpty else {
            return MarkdownFindReplaceResult(text: text, count: 0)
        }
        let mutable = NSMutableString(string: text)
        for range in ranges.reversed() {
            mutable.replaceCharacters(in: range, with: replacement)
        }
        return MarkdownFindReplaceResult(text: mutable as String, count: ranges.count)
    }

    static func replaceNext(
        in text: String,
        find: String,
        replacement: String,
        caseSensitive: Bool
    ) -> (text: String, replaced: Bool) {
        guard let range = ranges(in: text, find: find, caseSensitive: caseSensitive).first else {
            return (text, false)
        }
        let mutable = NSMutableString(string: text)
        mutable.replaceCharacters(in: range, with: replacement)
        return (mutable as String, true)
    }

    static func matchCount(in text: String, find: String, caseSensitive: Bool) -> Int {
        ranges(in: text, find: find, caseSensitive: caseSensitive).count
    }

    static func ranges(in text: String, find: String, caseSensitive: Bool) -> [NSRange] {
        guard !find.isEmpty else { return [] }
        let ns = text as NSString
        let options: NSString.CompareOptions = caseSensitive ? [] : [.caseInsensitive]
        var ranges: [NSRange] = []
        var location = 0
        while location < ns.length {
            let searchRange = NSRange(location: location, length: ns.length - location)
            let range = ns.range(of: find, options: options, range: searchRange)
            if range.location == NSNotFound { break }
            ranges.append(range)
            location = range.location + max(range.length, 1)
        }
        return ranges
    }
}

private struct FindReplaceSheet: View {
    @ObservedObject var model: MarkdownEditorModel
    @Environment(\.dismiss) private var dismiss
    @State private var find = ""
    @State private var replacement = ""
    @State private var caseSensitive = false
    @State private var status: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("Find") {
                    TextField("Find text", text: $find)
                        .accessibilityIdentifier("findReplace.find")
                    Toggle("Match case", isOn: $caseSensitive)
                }
                Section("Replace") {
                    TextField("Replacement", text: $replacement)
                        .accessibilityIdentifier("findReplace.replacement")
                }
                Section {
                    HStack {
                        Button("Find") {
                            let count = MarkdownFindReplace.matchCount(
                                in: model.text,
                                find: find,
                                caseSensitive: caseSensitive
                            )
                            status = count == 1 ? "1 match." : "\(count) matches."
                        }
                        .disabled(find.isEmpty)
                        Button("Replace Next") {
                            let replaced = model.replaceNext(
                                find: find,
                                replacement: replacement,
                                caseSensitive: caseSensitive
                            )
                            status = replaced ? "Replaced one occurrence." : "No match."
                        }
                        .disabled(find.isEmpty)
                        Spacer()
                        Button("Replace All") {
                            let count = model.replaceAll(
                                find: find,
                                replacement: replacement,
                                caseSensitive: caseSensitive
                            )
                            status = count == 1 ? "Replaced 1 occurrence." : "Replaced \(count) occurrences."
                        }
                        .disabled(find.isEmpty)
                        .accessibilityIdentifier("findReplace.replaceAll")
                    }
                }
                if let status {
                    Section { Text(status).foregroundStyle(.secondary) }
                }
            }
            .navigationTitle("Find & Replace")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
            .accessibilityIdentifier("findReplace.root")
        }
        .presentationDetents([.medium])
    }
}
