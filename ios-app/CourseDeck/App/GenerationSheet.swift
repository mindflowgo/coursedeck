import CourseDeckCore
import SwiftUI

/// Identifies a generatable tab on a lesson, unit, or course document.
enum GenerationRequest: Identifiable, Equatable {
    case lesson(courseId: String, lessonId: String, title: String, tab: String)
    case unit(courseId: String, unitNumber: Int, title: String, tab: String)
    case courseDoc(courseId: String, title: String, kind: CourseDocKind)

    var id: String {
        switch self {
        case let .lesson(courseId, lessonId, _, tab):
            return "lesson:\(courseId):\(lessonId):\(tab)"
        case let .unit(courseId, unitNumber, _, tab):
            return "unit:\(courseId):\(unitNumber):\(tab)"
        case let .courseDoc(courseId, _, kind):
            return "course:\(courseId):\(kind.rawValue)"
        }
    }

    var tab: String {
        switch self {
        case let .lesson(_, _, _, tab): return tab
        case let .unit(_, _, _, tab): return tab
        case let .courseDoc(_, _, kind): return kind.tab
        }
    }

    var displayTitle: String {
        switch self {
        case let .lesson(_, lessonId, title, tab):
            return "\(title.isEmpty ? lessonId : title) · \(PathValidator.customTabDisplayName(tab))"
        case let .unit(_, number, title, tab):
            return "\(title.isEmpty ? "Unit \(number)" : title) · \(PathValidator.customTabDisplayName(tab))"
        case let .courseDoc(_, title, kind):
            return "\(title.isEmpty ? "Course" : title) · \(PathValidator.customTabDisplayName(kind.rawValue))"
        }
    }

    var scopeDescription: String {
        switch self {
        case .lesson: return "Lesson tab"
        case let .unit(_, number, _, _): return "Unit \(number) tab"
        case .courseDoc: return "Course document"
        }
    }

    /// Maps a reader target to a generation request, or nil when the tab is
    /// virtual/read-only (the raw lesson, schedule, notes, pop quiz, course
    /// navigation, or an unsupported course tab).
    static func reader(target: ReaderTarget, title: String) -> GenerationRequest? {
        switch target.scope {
        case let .lesson(lessonId):
            guard !["lesson", "notes", "schedule", "popquiz", "course"].contains(target.tab) else {
                return nil
            }
            return .lesson(courseId: target.courseId, lessonId: lessonId, title: title, tab: target.tab)
        case let .unit(number):
            guard !["lesson", "notes", "schedule", "popquiz", "summary", "cheatsheet", "course"].contains(target.tab) else {
                return nil
            }
            return .unit(courseId: target.courseId, unitNumber: number, title: title, tab: target.tab)
        case .course:
            guard let kind = CourseDocKind(rawValue: target.tab) else { return nil }
            return .courseDoc(courseId: target.courseId, title: title, kind: kind)
        }
    }
}

struct GenerationSheet: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var services: AppServices

    let request: GenerationRequest
    let onQueued: (GenerationJob) -> Void

    @State private var useCustomPrompt = false
    @State private var customPrompt = ""
    @State private var force = false
    @State private var isQueuing = false
    @State private var errorMessage: String?
    @State private var showingReplaceConfirmation = false

    private var isCourseDoc: Bool {
        if case .courseDoc = request { return true }
        return false
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Request") {
                    Text(request.displayTitle).font(.headline)
                    Text(request.scopeDescription)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                if !isCourseDoc {
                    Section("Custom prompt") {
                        Toggle("Use a custom system prompt", isOn: $useCustomPrompt)
                        if useCustomPrompt {
                            TextEditor(text: $customPrompt)
                                .font(.system(.body, design: .monospaced))
                                .frame(minHeight: 140)
                                .accessibilityIdentifier("generation.customPrompt")
                            Text("Leave blank to use the built-in prompt for this tab.")
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                    }
                }

                Section("Overwrite") {
                    Toggle("Replace existing content without asking", isOn: $force)
                    Text("Without this, CourseDeck asks before replacing a non-empty file.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }

                if let errorMessage {
                    Section { Text(errorMessage).foregroundStyle(.red) }
                }

                Section {
                    Button {
                        Task { await queue(force: force) }
                    } label: {
                        HStack {
                            if isQueuing { ProgressView() }
                            Text(isQueuing ? "Queuing…" : "Queue generation")
                        }
                    }
                    .disabled(isQueuing)
                    .accessibilityIdentifier("generation.queue")
                }
            }
            .navigationTitle("Generate")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
            .alert("Replace existing content?", isPresented: $showingReplaceConfirmation) {
                Button("Replace", role: .destructive) {
                    Task { await queue(force: true) }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("This file already contains content. A .bak snapshot is kept before it is replaced.")
            }
            .accessibilityIdentifier("generation.root")
        }
    }

    private func queue(force: Bool) async {
        isQueuing = true
        errorMessage = nil
        defer { isQueuing = false }
        let prompt = useCustomPrompt && !customPrompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? customPrompt
            : nil

        do {
            let job: GenerationJob
            switch request {
            case let .lesson(courseId, lessonId, _, tab):
                job = try await services.enqueueLessonGeneration(
                    courseId: courseId,
                    lessonId: lessonId,
                    tab: tab,
                    force: force,
                    customPrompt: prompt
                )
            case let .unit(courseId, unitNumber, _, tab):
                job = try await services.enqueueUnitGeneration(
                    courseId: courseId,
                    unitNumber: unitNumber,
                    tab: tab,
                    force: force,
                    customPrompt: prompt
                )
            case let .courseDoc(courseId, _, kind):
                job = try await services.enqueueCourseDocGeneration(
                    courseId: courseId,
                    kind: kind,
                    force: force
                )
            }
            onQueued(job)
            dismiss()
        } catch let error as GenerationError {
            if case .confirmationRequired = error {
                showingReplaceConfirmation = true
            } else {
                errorMessage = error.localizedDescription
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
