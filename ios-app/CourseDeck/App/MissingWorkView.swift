import CourseDeckCore
import SwiftUI

@MainActor
final class MissingWorkModel: ObservableObject {
    @Published private(set) var courses: [CourseManifest] = []
    @Published var selectedCourseID: String?
    @Published private(set) var items: [MissingWorkItem] = []
    @Published var error: String?
    @Published var notice: String?
    @Published var isScanning = false

    private let services: AppServices

    init(services: AppServices = .shared) {
        self.services = services
    }

    func loadCourses() async {
        courses = await services.reloadCourses()
        if selectedCourseID == nil {
            selectedCourseID = courses.first?.id
        }
    }

    func scan() async {
        guard let courseId = selectedCourseID else { return }
        isScanning = true
        defer { isScanning = false }
        do {
            items = try await services.scanMissingWork(courseId: courseId)
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    func queue(courseId: String, item: MissingWorkItem, tab: String) async {
        do {
            _ = try await services.enqueueLessonGeneration(
                courseId: courseId,
                lessonId: item.lessonId,
                tab: tab,
                force: true
            )
            notice = "Queued \(item.lessonId) \(tab)."
        } catch {
            self.error = error.localizedDescription
        }
    }
}

struct MissingWorkView: View {
    @StateObject private var model = MissingWorkModel()

    var body: some View {
        Form {
            Section("Course") {
                Picker("Course", selection: $model.selectedCourseID) {
                    ForEach(model.courses, id: \.id) { course in
                        Text(course.title.isEmpty ? course.id : course.title).tag(Optional(course.id))
                    }
                }
                Button {
                    Task { await model.scan() }
                } label: {
                    Label("Scan summary + cheatsheet", systemImage: "magnifyingglass")
                }
                .disabled(model.selectedCourseID == nil || model.isScanning)
                .accessibilityIdentifier("missingWork.scan")
                Text("The bulk scan only covers lesson summaries and cheatsheets. Unit tabs are not scanned.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            if let error = model.error {
                Section { Text(error).foregroundStyle(.red) }
            }
            if let notice = model.notice {
                Section { Text(notice).foregroundStyle(.green) }
            }
            if model.isScanning {
                Section { ProgressView("Scanning…") }
            }
            Section("Missing work") {
                if model.items.isEmpty {
                    Text("Scan a course to list lessons with missing or stub content.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                ForEach(model.items, id: \.lessonId) { item in
                    VStack(alignment: .leading, spacing: 6) {
                        Text(item.lessonTitle.isEmpty ? item.lessonId : item.lessonTitle)
                        Text(item.lessonId).font(.caption2).foregroundStyle(.secondary)
                        HStack(spacing: 8) {
                            ForEach(item.tabs, id: \.self) { tab in
                                Button("Queue \(tab)") {
                                    Task {
                                        guard let courseId = model.selectedCourseID else { return }
                                        await model.queue(courseId: courseId, item: item, tab: tab)
                                    }
                                }
                                .buttonStyle(.bordered)
                                .font(.caption)
                            }
                        }
                    }
                }
            }
        }
        .navigationTitle("Missing work")
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.loadCourses() }
        .accessibilityIdentifier("missingWork.root")
    }
}
