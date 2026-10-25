import Combine
import CourseDeckCore
import SwiftUI

@MainActor
final class CheckpointHubModel: ObservableObject {
    struct Entry: Identifiable, Equatable {
        var checkpoint: Checkpoint
        var courseId: String
        var courseTitle: String
        var id: String { "\(courseId):\(checkpoint.id)" }
        var isNote: Bool { checkpoint.type == .note }
    }

    @Published private(set) var entries: [Entry] = []
    @Published private(set) var isLoading = false
    @Published private(set) var error: String?
    @Published var searchText = ""
    @Published var colorFilter: String?

    private let services: AppServices

    init(services: AppServices = .shared) {
        self.services = services
    }

    var filteredEntries: [Entry] {
        let query = searchText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return entries.filter { entry in
            if let colorFilter, entry.isNote,
               (entry.checkpoint.color ?? "yellow") != colorFilter {
                return false
            }
            guard !query.isEmpty else { return true }
            return entry.courseTitle.lowercased().contains(query)
                || entry.checkpoint.file.lowercased().contains(query)
                || (entry.checkpoint.noteText ?? "").lowercased().contains(query)
        }
    }

    func load() async {
        isLoading = true
        defer { isLoading = false }
        let notes = await services.allNoteCheckpoints()
        var combined: [Entry] = notes.map {
            Entry(checkpoint: $0.checkpoint, courseId: $0.courseId, courseTitle: $0.courseTitle)
        }

        // Position checkpoints are per-file and live in each course's
        // checkpoint.json. Include them in the hub as well as notes.
        let courses = await services.reloadCourses()
        for course in courses {
            guard let document = try? await services.checkpoints.read(courseId: course.id) else {
                continue
            }
            for checkpoint in document.checkpoints where checkpoint.type == .position {
                combined.append(Entry(
                    checkpoint: checkpoint,
                    courseId: course.id,
                    courseTitle: course.title
                ))
            }
        }
        entries = combined.sorted { lhs, rhs in
            (lhs.checkpoint.date, lhs.checkpoint.id)
                > (rhs.checkpoint.date, rhs.checkpoint.id)
        }
        error = nil
    }

    func delete(_ entry: Entry) async {
        if await services.deleteCheckpoint(courseId: entry.courseId, checkpointId: entry.checkpoint.id) {
            entries.removeAll { $0.id == entry.id }
        }
    }

    func target(for entry: Entry) -> ReaderTarget? {
        ReaderTarget.from(file: entry.checkpoint.file, courseId: entry.courseId)
    }
}

/// Newest-first note checkpoints across active courses, with search and
/// delete. Tapping a note opens the reader at that checkpoint.
struct CheckpointHubView: View {
    @StateObject private var model = CheckpointHubModel()
    @State private var openEntry: CheckpointHubModel.Entry?

    var body: some View {
        List {
            if model.entries.isEmpty && !model.isLoading {
                ContentUnavailableView(
                    "No checkpoints yet",
                    systemImage: "bookmark",
                    description: Text("Save checkpoints or notes from the reader toolbar. Notes and saved positions appear here newest-first.")
                )
                .listRowBackground(Color.clear)
            }
            ForEach(model.filteredEntries) { entry in
                Button {
                    openEntry = entry
                } label: {
                    HStack(alignment: .top, spacing: 12) {
                        if entry.isNote {
                            Circle()
                                .fill(color(entry.checkpoint.color))
                                .frame(width: 12, height: 12)
                                .padding(.top, 5)
                        } else {
                            Image(systemName: "bookmark.fill")
                                .foregroundStyle(.secondary)
                                .frame(width: 12, height: 12)
                                .padding(.top, 5)
                        }
                        VStack(alignment: .leading, spacing: 4) {
                            if entry.isNote {
                                Text(entry.checkpoint.noteText?.isEmpty == false ? entry.checkpoint.noteText! : "Note")
                                    .foregroundStyle(.primary)
                            } else {
                                Text("Saved position")
                                    .foregroundStyle(.primary)
                            }
                            Text("\(entry.courseTitle) · \(entry.checkpoint.file)")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            Text(entry.checkpoint.date)
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                        }
                    }
                }
                .accessibilityIdentifier("checkpoint.\(entry.id)")
            }
            .onDelete { offsets in
                let entries = offsets.map { model.filteredEntries[$0] }
                Task {
                    for entry in entries { await model.delete(entry) }
                }
            }
        }
        .searchable(text: $model.searchText, prompt: "Search checkpoints")
        .navigationTitle("Checkpoints")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button("All colours") { model.colorFilter = nil }
                    ForEach(["yellow", "green", "blue", "pink", "orange"], id: \.self) { value in
                        Button(value.capitalized) { model.colorFilter = value }
                    }
                } label: {
                    Image(systemName: model.colorFilter == nil ? "line.3.horizontal.decrease.circle" : "line.3.horizontal.decrease.circle.fill")
                }
                .accessibilityLabel("Filter note colours")
            }
        }
        .task { await model.load() }
        .refreshable { await model.load() }
        .fullScreenCover(item: $openEntry) { entry in
            NavigationStack {
                Group {
                    if let target = model.target(for: entry) {
                        ReaderScreen(request: .target(target), startCheckpoint: entry.checkpoint)
                    } else {
                        ContentUnavailableView("Checkpoint unavailable", systemImage: "exclamationmark.triangle")
                    }
                }
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        Button("Close") { openEntry = nil }
                    }
                }
            }
        }
    }

    private func color(_ value: String?) -> Color {
        switch value {
        case "green": return .green
        case "blue": return .blue
        case "pink": return .pink
        case "orange": return .orange
        default: return .yellow
        }
    }
}
