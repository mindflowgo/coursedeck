import CourseDeckCore
import SwiftUI
import UniformTypeIdentifiers

/// New-course and lesson-package ingestion UI. The course code is always
/// user-supplied and validated by `CourseIngestor`; the app never invents a
/// course id, grade, or description.
struct CourseIngestSheet: View {
    enum Mode: Equatable {
        case newCourse
        case importPackages(String?)
    }

    let mode: Mode
    var onFinished: (String) -> Void = { _ in }

    @EnvironmentObject private var services: AppServices
    @Environment(\.dismiss) private var dismiss

    @State private var courses: [CourseManifest] = []
    @State private var selectedCourseId = ""
    @State private var code = ""
    @State private var title = ""
    @State private var confirmExisting = false
    @State private var packages: [URL] = []
    @State private var showingImporter = false
    @State private var overwriteExisting = false
    @State private var isWorking = false
    @State private var errorMessage: String?
    @State private var resultSummary: String?
    @State private var createdCourseId: String?

    private static var packageTypes: [UTType] {
        var types: [UTType] = [.zip, .html]
        if let mhtml = UTType(filenameExtension: "mhtml") { types.append(mhtml) }
        if let mht = UTType(filenameExtension: "mht") { types.append(mht) }
        return types
    }

    var body: some View {
        NavigationStack {
            Form {
                if mode == .newCourse || createdCourseId != nil || selectedCourseId.isEmpty {
                    newCourseSection
                }
                if mode != .newCourse || createdCourseId != nil {
                    importSection
                }
                if let errorMessage {
                    Section {
                        Text(errorMessage).foregroundStyle(.red)
                    }
                }
                if let resultSummary {
                    Section("Result") {
                        Text(resultSummary)
                            .font(.footnote)
                            .textSelection(.enabled)
                    }
                }
            }
            .navigationTitle(mode == .newCourse ? "New Course" : "Import Lessons")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Close") { dismiss() }
                }
            }
            .task { await loadCourses() }
            .fileImporter(
                isPresented: $showingImporter,
                allowedContentTypes: Self.packageTypes,
                allowsMultipleSelection: true
            ) { result in
                switch result {
                case let .success(urls):
                    packages = urls
                    errorMessage = nil
                case let .failure(error):
                    errorMessage = error.localizedDescription
                }
            }
            .accessibilityIdentifier("ingest.root")
        }
    }

    private var newCourseSection: some View {
        Section {
            TextField("Course code (for example baf3m)", text: $code)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .accessibilityIdentifier("ingest.courseCode")
            TextField("Course title (optional)", text: $title)
                .accessibilityIdentifier("ingest.courseTitle")
            Toggle("Use the existing course if this code already exists", isOn: $confirmExisting)
            Button {
                Task { await createCourse() }
            } label: {
                if isWorking {
                    ProgressView()
                } else {
                    Label("Create course", systemImage: "plus.rectangle.on.folder")
                }
            }
            .disabled(isWorking || code.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            .accessibilityIdentifier("ingest.createCourse")
        } header: {
            Text("Course")
        } footer: {
            Text("The code is lowercased and validated (letters, digits, dots, dashes, underscores).")
        }
    }

    private var importSection: some View {
        Section {
            if courses.count > 1 {
                Picker("Course", selection: $selectedCourseId) {
                    ForEach(courses, id: \.id) { course in
                        Text("\(course.title) (\(course.id))").tag(course.id)
                    }
                }
            } else if let course = courses.first(where: { $0.id == selectedCourseId }) {
                LabeledContent("Course", value: "\(course.title) (\(course.id))")
            }

            Button {
                showingImporter = true
            } label: {
                Label("Choose lesson packages", systemImage: "doc.badge.plus")
            }
            .accessibilityIdentifier("ingest.choosePackages")

            if packages.isEmpty {
                Text("Choose one or more .zip, .mhtml, .mht, .html, or .htm packages.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(packages, id: \.absoluteString) { url in
                    Text(url.lastPathComponent)
                        .font(.footnote)
                }
            }

            Toggle("Overwrite existing lesson files (keeps .bak copies)", isOn: $overwriteExisting)

            Button {
                Task { await importPackages() }
            } label: {
                if isWorking {
                    ProgressView()
                } else {
                    Label("Import packages", systemImage: "square.and.arrow.down")
                }
            }
            .disabled(isWorking || packages.isEmpty || selectedCourseId.isEmpty)
            .accessibilityIdentifier("ingest.importPackages")
        } header: {
            Text("Lesson packages")
        } footer: {
            Text("Packages are archived in the course _backup folder. Existing lessons are preserved unless overwrite is enabled.")
        }
    }

    private func loadCourses() async {
        courses = await services.reloadCourses()
        switch mode {
        case .newCourse:
            break
        case let .importPackages(courseId):
            if let courseId, courses.contains(where: { $0.id == courseId }) {
                selectedCourseId = courseId
            } else if selectedCourseId.isEmpty {
                selectedCourseId = courses.first?.id ?? ""
            }
        }
        if selectedCourseId.isEmpty, let first = courses.first {
            selectedCourseId = first.id
        }
    }

    private func createCourse() async {
        isWorking = true
        defer { isWorking = false }
        errorMessage = nil
        do {
            let manifest = try await services.createCourse(
                code: code,
                title: title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : title,
                confirmExisting: confirmExisting
            )
            createdCourseId = manifest.id
            selectedCourseId = manifest.id
            courses = await services.reloadCourses()
            resultSummary = "Course \(manifest.id.uppercased()) is ready. Choose lesson packages to import."
            if mode == .newCourse {
                onFinished(manifest.id)
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func importPackages() async {
        guard !selectedCourseId.isEmpty else { return }
        isWorking = true
        defer { isWorking = false }
        errorMessage = nil
        let accessed = packages.map { url -> (URL, Bool) in
            (url, url.startAccessingSecurityScopedResource())
        }
        defer {
            for (url, didAccess) in accessed where didAccess {
                url.stopAccessingSecurityScopedResource()
            }
        }
        do {
            let result = try await services.ingestPackages(
                courseId: selectedCourseId,
                packages: packages,
                overwriteExisting: overwriteExisting
            )
            var parts: [String] = []
            parts.append("Added \(result.newLessonsAdded.count) lesson(s)")
            if !result.overwrittenLessons.isEmpty {
                parts.append("overwrote \(result.overwrittenLessons.count)")
            }
            if !result.preservedLessons.isEmpty {
                parts.append("preserved \(result.preservedLessons.count)")
            }
            parts.append("\(result.totalLessons) total")
            if result.imageSummary.converted > 0 {
                parts.append("compressed \(result.imageSummary.converted) image(s)")
            }
            var summary = parts.joined(separator: ", ") + "."
            if !result.skippedPackages.isEmpty {
                summary += "\nSkipped: \(result.skippedPackages.joined(separator: ", "))."
            }
            if !result.warnings.isEmpty {
                summary += "\n" + result.warnings.prefix(8).joined(separator: "\n")
            }
            resultSummary = summary
            onFinished(selectedCourseId)
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
