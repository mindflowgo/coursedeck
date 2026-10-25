import Combine
import CourseDeckCore
import SwiftUI
import UIKit

/// The source used to build a reader screen. `sample` is a bundled fixture and
/// never touches the course manifest or checkpoint store.
enum ReaderRequest: Equatable {
    case target(ReaderTarget)
    case sample
}

@MainActor
final class ReaderModel: ObservableObject {
    enum Phase {
        case loading
        case ready(ReaderDocument)
        case empty(String)
        case failed(String)
    }

    @Published private(set) var phase: Phase = .loading
    @Published private(set) var notes: [Checkpoint] = []
    @Published private(set) var position: ReaderPosition = .zero
    @Published var toast: String?

    let request: ReaderRequest
    private let startCheckpoint: Checkpoint?
    private let services: AppServices
    private(set) var document: ReaderDocument?
    private(set) var initialPosition: ReaderPosition?
    private var lastSavedPosition: ReaderPosition?

    init(
        request: ReaderRequest,
        startCheckpoint: Checkpoint? = nil,
        services: AppServices = .shared
    ) {
        self.request = request
        self.startCheckpoint = startCheckpoint
        self.services = services
    }

    var title: String {
        switch phase {
        case let .ready(document):
            if case let .lesson(_) = document.target.scope,
               document.target.tab != "lesson" {
                return "\(document.title) · \(PathValidator.customTabDisplayName(document.target.tab))"
            }
            return document.title
        default:
            return "Reader"
        }
    }

    var canSaveCheckpoints: Bool {
        ReaderSavePolicy.canSave(document: document, isWritable: services.isWritable)
    }

    /// Deep links from the checkpoint hub show 60 pt of preceding context.
    var initialOffsetAdjustment: CGFloat {
        startCheckpoint == nil ? 0 : -60
    }

    func load() async {
        if document != nil { return }
        phase = .loading
        do {
            let loaded: ReaderDocument
            switch request {
            case let .target(target):
                loaded = try await services.openDocument(target)
            case .sample:
                loaded = await services.loadSampleDocument()
            }
            document = loaded
            initialPosition = await resolveInitialPosition(for: loaded)
            phase = .ready(loaded)
            await reloadNotes(for: loaded)
        } catch let error as ReaderDocumentError {
            phase = .empty(error.localizedDescription)
        } catch {
            phase = .failed(error.localizedDescription)
        }
    }

    /// Reloads after a generation completes (or a missing file is created).
    func reload() async {
        document = nil
        initialPosition = nil
        phase = .loading
        await load()
    }

    private func resolveInitialPosition(for document: ReaderDocument) async -> ReaderPosition? {
        if let startCheckpoint {
            return ReaderPosition(
                verticalPosition: startCheckpoint.verticalPosition,
                anchorBlockID: startCheckpoint.anchorBlockID,
                anchorFraction: startCheckpoint.anchorFraction ?? 0
            )
        }
        guard document.supportsCheckpoints, services.settings.resumeLastPosition else { return nil }
        guard let checkpoint = await services.positionCheckpoint(
            courseId: document.courseId,
            file: document.file
        ) else { return nil }
        return ReaderPosition(
            verticalPosition: checkpoint.verticalPosition,
            anchorBlockID: checkpoint.anchorBlockID,
            anchorFraction: checkpoint.anchorFraction ?? 0
        )
    }

    func handlePosition(_ position: ReaderPosition) {
        self.position = position
        guard canSaveCheckpoints else { return }
        if let lastSavedPosition,
           abs(lastSavedPosition.verticalPosition - position.verticalPosition) < 4,
           lastSavedPosition.anchorBlockID == position.anchorBlockID {
            return
        }
        lastSavedPosition = position
        guard let document else { return }
        Task {
            _ = await services.savePosition(position, document: document)
        }
    }

    /// Persists immediately and reports whether the write actually happened.
    @discardableResult
    func savePositionNow(_ position: ReaderPosition) async -> Bool {
        self.position = position
        lastSavedPosition = position
        guard let document else { return false }
        return await services.savePosition(position, document: document)
    }

    func addNote(text: String, color: String, position: ReaderPosition) async {
        guard let document else { return }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        guard position.anchorBlockID != nil else {
            toast = "Move the reader slightly before adding a note"
            return
        }
        self.position = position
        let checkpoint = await services.addNoteCheckpoint(
            document: document,
            position: position,
            noteText: trimmed,
            color: color
        )
        if checkpoint != nil {
            await reloadNotes(for: document)
            toast = "Note saved"
        }
    }

    func deleteNote(_ checkpoint: Checkpoint) async {
        guard let document else { return }
        if await services.deleteCheckpoint(courseId: document.courseId, checkpointId: checkpoint.id) {
            await reloadNotes(for: document)
        }
    }

    func reloadNotes(for document: ReaderDocument) async {
        let all = await services.documentCheckpoints(courseId: document.courseId, file: document.file)
        notes = all.filter { $0.type == .note }.sorted { $0.date > $1.date }
    }

    func optionalPosition() -> ReaderPosition? {
        guard position.anchorBlockID != nil else { return nil }
        return position
    }
}

@MainActor
final class ReaderProxy: ObservableObject {
    weak var controller: ReaderViewController?
    @Published private(set) var position: ReaderPosition = .zero

    func attach(_ controller: ReaderViewController) {
        self.controller = controller
    }

    func detach(_ controller: ReaderViewController) {
        if self.controller === controller {
            self.controller = nil
        }
    }

    func update(_ position: ReaderPosition) {
        self.position = position
    }

    func currentPosition() -> ReaderPosition {
        controller?.currentPosition() ?? position
    }

    func currentExactPosition() async -> ReaderPosition? {
        await controller?.currentExactPosition()
    }

    func saveNow() {
        controller?.savePositionNow()
    }

    @discardableResult
    func saveExactPositionNow() async -> ReaderPosition? {
        await controller?.saveExactPositionNow()
    }

    func scrollTo(blockID: String) {
        guard let controller else { return }
        Task { await controller.scrollToBlock(blockID) }
    }
}

struct ReaderContainerView: UIViewControllerRepresentable {
    let document: ReaderDocument
    let initialPosition: ReaderPosition?
    let deepLinkOffset: CGFloat
    let tableScrollState: TableScrollStateStore
    let proxy: ReaderProxy
    let onPositionChange: (ReaderPosition) -> Void

    func makeUIViewController(context: Context) -> ReaderViewController {
        let controller = ReaderViewController(
            document: document,
            initialPosition: initialPosition,
            tableScrollState: tableScrollState,
            deepLinkOffset: deepLinkOffset
        )
        controller.onReady = { controller in
            proxy.attach(controller)
        }
        controller.onPositionChange = { position in
            proxy.update(position)
            onPositionChange(position)
        }
        return controller
    }

    func updateUIViewController(_ uiViewController: ReaderViewController, context: Context) {}

    static func dismantleUIViewController(_ uiViewController: ReaderViewController, coordinator: Void) {
        uiViewController.onPositionChange = nil
        uiViewController.onReady = nil
    }
}

struct ReaderScreen: View {
    @StateObject private var model: ReaderModel
    @StateObject private var proxy = ReaderProxy()
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var services: AppServices
    @State private var showingNotes = false
    @State private var showingNoteEditor = false
    @State private var noteText = ""
    @State private var noteColor = "yellow"
    @State private var generationRequest: GenerationRequest?
    @State private var editorContext: MarkdownEditorContext?
    @Environment(\.scenePhase) private var scenePhase

    init(request: ReaderRequest, startCheckpoint: Checkpoint? = nil) {
        _model = StateObject(wrappedValue: ReaderModel(
            request: request,
            startCheckpoint: startCheckpoint
        ))
    }

    private var generationTarget: GenerationRequest? {
        guard case let .target(target) = model.request else { return nil }
        return GenerationRequest.reader(target: target, title: model.document?.title ?? "")
    }

    /// Only real, writable files can be edited. `course.lesson` is virtual,
    /// `course.schedule.md` is read-only, and a read-only data root blocks all
    /// writes.
    private var editableTarget: ReaderTarget? {
        guard case let .target(target) = model.request else { return nil }
        guard let document = model.document,
              !document.isReadOnly,
              services.isWritable else { return nil }
        return target
    }

    private func openEditor(_ target: ReaderTarget) {
        Task {
            do {
                let snapshot = try await services.markdownSnapshot(for: target)
                editorContext = MarkdownEditorContext(
                    target: target,
                    title: model.title,
                    snapshot: snapshot
                )
            } catch {
                model.toast = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            }
        }
    }

    var body: some View {
        Group {
            switch model.phase {
            case .loading:
                ProgressView("Loading lesson…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            case let .ready(document):
                ReaderContainerView(
                    document: document,
                    initialPosition: model.initialPosition,
                    deepLinkOffset: model.initialOffsetAdjustment,
                    tableScrollState: AppServices.shared.tableScrollState,
                    proxy: proxy,
                    onPositionChange: model.handlePosition
                )
            case let .empty(message):
                ContentUnavailableView {
                    Label("Not available yet", systemImage: "doc.text.magnifyingglass")
                } description: {
                    Text(message)
                } actions: {
                    if let target = generationTarget {
                        Button("Generate this tab") {
                            generationRequest = target
                        }
                        .buttonStyle(.borderedProminent)
                        .accessibilityIdentifier("reader.generateMissing")
                    }
                    Button("Reload") {
                        Task { await model.reload() }
                    }
                    .buttonStyle(.bordered)
                }
            case let .failed(message):
                ContentUnavailableView(
                    "Reader error",
                    systemImage: "exclamationmark.triangle",
                    description: Text(message)
                )
            }
        }
        .navigationTitle(model.title)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { toolbarContent }
        .sheet(isPresented: $showingNotes) {
            ReaderNotesSheet(model: model, proxy: proxy)
        }
        .fullScreenCover(item: $editorContext) { context in
            NavigationStack {
                MarkdownEditorScreen(context: context) {
                    Task { await model.reload() }
                }
            }
        }
        .sheet(item: $generationRequest) { request in
            GenerationSheet(request: request) { _ in
                model.toast = "Generation queued. Reload when it completes."
            }
            .environmentObject(AppServices.shared)
        }
        .sheet(isPresented: $showingNoteEditor) {
            NoteEditorSheet(
                text: $noteText,
                color: $noteColor,
                onSave: {
                    Task {
                        guard let position = await proxy.currentExactPosition() else {
                            model.toast = "Still measuring; try again in a moment"
                            return
                        }
                        await model.addNote(text: noteText, color: noteColor, position: position)
                    }
                    showingNoteEditor = false
                },
                onCancel: { showingNoteEditor = false }
            )
        }
        .task { await model.load() }
        .onChange(of: scenePhase) { _, phase in
            if phase != .active {
                Task {
                    await proxy.saveExactPositionNow()
                }
            }
        }
        .overlay(alignment: .bottom) {
            if let toast = model.toast {
                Text(toast)
                    .font(.footnote)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 8)
                    .background(.thinMaterial, in: Capsule())
                    .padding(.bottom, 18)
                    .task {
                        try? await Task.sleep(nanoseconds: 1_600_000_000)
                        model.toast = nil
                    }
            }
        }
    }

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        if case .target = model.request {
            ToolbarItem(placement: .topBarLeading) {
                Button {
                    dismiss()
                } label: {
                    Image(systemName: "chevron.left")
                }
                .accessibilityLabel("Back")
                .accessibilityIdentifier("reader.back")
            }
        }
        ToolbarItemGroup(placement: .topBarTrailing) {
            if let target = editableTarget {
                Button {
                    openEditor(target)
                } label: {
                    Image(systemName: "square.and.pencil")
                }
                .accessibilityLabel("Edit Markdown")
                .accessibilityIdentifier("reader.edit")
            }
            if let target = generationTarget {
                Button {
                    generationRequest = target
                } label: {
                    Image(systemName: "sparkles")
                }
                .accessibilityLabel("Generate content")
                .accessibilityIdentifier("reader.generate")
            }
            Button {
                Task { await model.reload() }
            } label: {
                Image(systemName: "arrow.clockwise")
            }
            .accessibilityLabel("Reload document")
            if model.canSaveCheckpoints {
                Menu {
                    Button {
                        Task {
                            proxy.saveNow()
                            guard let position = await proxy.currentExactPosition() else {
                                model.toast = "Still measuring; try again in a moment"
                                return
                            }
                            let saved = await model.savePositionNow(position)
                            model.toast = saved ? "Checkpoint saved" : "Couldn't save checkpoint"
                        }
                    } label: {
                        Label("Save checkpoint", systemImage: "bookmark")
                    }
                    Button {
                        noteText = ""
                        showingNoteEditor = true
                    } label: {
                        Label("Add note at current position", systemImage: "note.text.badge.plus")
                    }
                    Button {
                        showingNotes = true
                    } label: {
                        Label("Document notes (\(model.notes.count))", systemImage: "list.bullet")
                    }
                } label: {
                    Image(systemName: model.notes.isEmpty ? "bookmark" : "bookmark.fill")
                }
                .accessibilityLabel("Checkpoints and notes")
            }
        }
    }
}

private struct ReaderNotesSheet: View {
    @ObservedObject var model: ReaderModel
    @ObservedObject var proxy: ReaderProxy
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                if model.notes.isEmpty {
                    Text("No note checkpoints in this document.")
                        .foregroundStyle(.secondary)
                }
                ForEach(model.notes, id: \.id) { note in
                    Button {
                        if let anchor = note.anchorBlockID {
                            proxy.scrollTo(blockID: anchor)
                        }
                        dismiss()
                    } label: {
                        HStack(alignment: .top, spacing: 12) {
                            Circle()
                                .fill(noteColor(note.color))
                                .frame(width: 12, height: 12)
                                .padding(.top, 5)
                            VStack(alignment: .leading, spacing: 4) {
                                Text(note.noteText?.isEmpty == false ? note.noteText! : "Note")
                                    .font(.body)
                                    .foregroundStyle(.primary)
                                Text(note.date)
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                                if note.anchorBlockID == nil {
                                    Text("Target no longer found")
                                        .font(.caption2)
                                        .foregroundStyle(.orange)
                                }
                            }
                        }
                    }
                }
                .onDelete { offsets in
                    let notes = offsets.map { model.notes[$0] }
                    Task {
                        for note in notes { await model.deleteNote(note) }
                    }
                }
            }
            .navigationTitle("Notes")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    private func noteColor(_ value: String?) -> Color {
        switch value {
        case "green": return .green
        case "blue": return .blue
        case "pink": return .pink
        case "orange": return .orange
        default: return .yellow
        }
    }
}

private struct NoteEditorSheet: View {
    @Binding var text: String
    @Binding var color: String
    let onSave: () -> Void
    let onCancel: () -> Void

    var body: some View {
        NavigationStack {
            Form {
                Section("Note") {
                    TextField("What is important here?", text: $text, axis: .vertical)
                        .lineLimit(3...6)
                }
                Section("Colour") {
                    Picker("Colour", selection: $color) {
                        Text("Yellow").tag("yellow")
                        Text("Green").tag("green")
                        Text("Blue").tag("blue")
                        Text("Pink").tag("pink")
                        Text("Orange").tag("orange")
                    }
                    .pickerStyle(.segmented)
                }
            }
            .navigationTitle("Add note checkpoint")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: onCancel)
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save", action: onSave)
                        .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
        .presentationDetents([.medium])
    }
}
