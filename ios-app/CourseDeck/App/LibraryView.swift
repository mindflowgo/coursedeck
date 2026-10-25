import Combine
import CourseDeckCore
import Foundation
import SwiftUI

@MainActor
final class LibraryModel: ObservableObject {
    @Published private(set) var courses: [CourseManifest] = []
    @Published private(set) var isLoading = false
    @Published private(set) var error: String?

    private let services: AppServices

    init(services: AppServices = .shared) {
        self.services = services
    }

    func load() async {
        isLoading = true
        defer { isLoading = false }
        courses = await services.reloadCourses()
        error = services.startupError
    }
}

struct LibraryView: View {
    @EnvironmentObject private var services: AppServices
    @StateObject private var model = LibraryModel()
    @State private var selectedCourseID: String?
    @State private var showingSample = false
    @State private var showingCheckpoints = false
    @State private var showingAIConsent = false
    @State private var dismissedAIConsentForSession = false
    @State private var showingSettings = false
    @State private var showingJobs = false
    @State private var showingIngest = false
    @State private var ingestMode: CourseIngestSheet.Mode = .newCourse
    @State private var keyPromptCandidate: PendingKeyReplacement?
    @State private var showingKeyPrompt = false
    @State private var deepLinkCover: DeepLinkCover?
    @State private var pendingDeepLinkRoute: CourseDeckDeepLinkRoute?
    @State private var deepLinkAutoCreate: DeepLinkAutoCreateRequest?
    @State private var deepLinkError: String?

    var body: some View {
        libraryContent
            .onOpenURL { url in
                openDeepLink(url)
            }
            .onReceive(NotificationCenter.default.publisher(for: .courseDeckOpenDeepLink)) { notification in
                if let route = notification.object as? CourseDeckDeepLinkRoute {
                    resolveDeepLink(route)
                }
            }
            .fullScreenCover(item: $deepLinkCover) { cover in
                deepLinkCoverView(cover)
            }
            .confirmationDialog(
                "Create a custom tab?",
                isPresented: Binding(
                    get: { deepLinkAutoCreate != nil },
                    set: { if !$0 { deepLinkAutoCreate = nil } }
                )
            ) {
                if let request = deepLinkAutoCreate {
                    Button("Create \(request.tab) and open") {
                        guard let route = pendingDeepLinkRoute else { return }
                        deepLinkAutoCreate = nil
                        resolveDeepLink(route, allowAutoCreate: true)
                    }
                    Button("Open \(request.fallback.tab) instead") {
                        deepLinkAutoCreate = nil
                        pendingDeepLinkRoute = nil
                        deepLinkCover = .reader(request.fallback)
                    }
                }
                Button("Cancel", role: .cancel) {
                    deepLinkAutoCreate = nil
                    pendingDeepLinkRoute = nil
                }
            } message: {
                Text("The link targets custom tab \(deepLinkAutoCreate?.tab ?? ""), which does not exist. Create it, or open the fallback page instead.")
            }
            .alert("Link error", isPresented: Binding(
                get: { deepLinkError != nil },
                set: { if !$0 { deepLinkError = nil } }
            )) {
                Button("OK", role: .cancel) { deepLinkError = nil }
            } message: {
                Text(deepLinkError ?? "")
            }
            .accessibilityIdentifier("library.root")
    }

    private var libraryContent: some View {
        NavigationSplitView {
            sidebar
                .navigationTitle("CourseDeck")
                .navigationSplitViewColumnWidth(min: 280, ideal: 320)
        } detail: {
            if let selectedCourseID {
                CourseBrowserView(courseId: selectedCourseID)
                    .id(selectedCourseID)
            } else {
                welcome
            }
        }
        .navigationSplitViewStyle(.balanced)
        .task { await model.load() }
        .refreshable { await model.load() }
        .onChange(of: services.dataRevision) { _, _ in
            Task { await model.load() }
        }
        .fullScreenCover(isPresented: $showingSample) {
            NavigationStack {
                ReaderScreen(request: .sample)
                    .toolbar {
                        ToolbarItem(placement: .topBarLeading) {
                            Button("Close") { showingSample = false }
                        }
                    }
            }
        }
        .sheet(isPresented: $showingCheckpoints) {
            NavigationStack {
                CheckpointHubView()
                    .toolbar {
                        ToolbarItem(placement: .topBarTrailing) {
                            Button("Done") { showingCheckpoints = false }
                        }
                    }
            }
        }
        .sheet(isPresented: $showingAIConsent) {
            AIConsentView(
                onAccept: {
                    Task {
                        await services.acceptAIConsent()
                        dismissedAIConsentForSession = false
                        showingAIConsent = false
                    }
                },
                onNotNow: {
                    Task { await services.declineAIConsent() }
                    dismissedAIConsentForSession = true
                    showingAIConsent = false
                }
            )
        }
        .onAppear { updateAIConsentPresentation() }
        .onChange(of: services.settings) { _, _ in updateAIConsentPresentation() }
        .onChange(of: services.settingsLoaded) { _, _ in updateAIConsentPresentation() }
        .sheet(isPresented: $showingSettings) {
            NavigationStack {
                SettingsView()
            }
            .environmentObject(services)
        }
        .sheet(isPresented: $showingJobs) {
            NavigationStack {
                GenerationJobsView()
            }
            .environmentObject(services)
        }
        .sheet(isPresented: $showingIngest) {
            CourseIngestSheet(mode: ingestMode) { courseId in
                selectedCourseID = courseId
                Task { await model.load() }
            }
            .environmentObject(services)
        }
        .onAppear {
            if let first = services.pendingKeyReplacements.first {
                keyPromptCandidate = first
                showingKeyPrompt = true
            }
        }
        .onChange(of: services.pendingKeyReplacements) { _, candidates in
            if !showingKeyPrompt, let first = candidates.first {
                keyPromptCandidate = first
                showingKeyPrompt = true
            }
        }
        .confirmationDialog(
            "Imported API key",
            isPresented: $showingKeyPrompt,
            presenting: keyPromptCandidate
        ) { candidate in
            Button("Replace local key") {
                Task { try? await services.replacePendingKey(candidate) }
            }
            Button("Keep local key", role: .destructive) {
                Task { try? await services.keepLocalKey(candidate) }
            }
            Button("Later", role: .cancel) {}
        } message: { candidate in
            Text("A key for \(candidate.endpoint) was imported. Replace the local key on \(candidate.cardLabel), or keep the local key and remove the imported card.")
        }
    }

    @ViewBuilder
    private func deepLinkCoverView(_ cover: DeepLinkCover) -> some View {
        NavigationStack {
            Group {
                switch cover {
                case let .reader(target):
                    ReaderScreen(request: .target(target))
                case let .quiz(request):
                    QuizScreen(request: request)
                }
            }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Close") { deepLinkCover = nil }
                }
            }
        }
    }

    private func openDeepLink(_ url: URL) {
        switch CourseDeckDeepLink.parse(url) {
        case let .success(route):
            resolveDeepLink(route)
        case let .failure(error):
            deepLinkError = error.errorDescription
        }
    }

    private func resolveDeepLink(
        _ route: CourseDeckDeepLinkRoute,
        allowAutoCreate: Bool = false
    ) {
        Task {
            let resolution = await services.deepLinkResolver.resolve(
                route,
                allowAutoCreate: allowAutoCreate
            )
            switch resolution {
            case let .course(courseId):
                selectedCourseID = courseId
            case let .reader(target):
                selectedCourseID = target.courseId
                present(.reader(target))
            case let .quiz(request):
                selectedCourseID = request.courseId
                present(.quiz(request))
            case let .needsAutoCreate(request):
                pendingDeepLinkRoute = route
                deepLinkAutoCreate = request
            case let .invalid(message):
                deepLinkError = message
            }
        }
    }

    private func present(_ cover: DeepLinkCover) {
        // A warm link can arrive while the previous deep-link cover is open.
        deepLinkCover = nil
        DispatchQueue.main.async {
            deepLinkCover = cover
        }
    }

    private func updateAIConsentPresentation() {
        showingAIConsent = services.settingsLoaded
            && !services.settings.hasAIConsent
            && !dismissedAIConsentForSession
    }

    private var sidebar: some View {
        List(selection: $selectedCourseID) {
            Section("Courses") {
                if model.isLoading && model.courses.isEmpty {
                    ProgressView()
                } else if model.courses.isEmpty {
                    Text("No courses imported yet")
                        .foregroundStyle(.secondary)
                }
                ForEach(model.courses, id: \.id) { course in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(course.title)
                        Text("\(course.units.count) units · \(course.allLessons.count) lessons")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    .tag(course.id)
                    .accessibilityIdentifier("library.course.\(course.id)")
                }
            }
            Section("Study") {
                Button {
                    showingSample = true
                } label: {
                    Label("Open reader sample", systemImage: "book")
                }
                .accessibilityIdentifier("library.sample")
                Button {
                    showingCheckpoints = true
                } label: {
                    Label("Checkpoints", systemImage: "bookmark")
                }
                .accessibilityIdentifier("library.checkpoints")
            }
            Section("Tools") {
                Button {
                    ingestMode = .newCourse
                    showingIngest = true
                } label: {
                    Label("New course", systemImage: "plus.rectangle.on.folder")
                }
                .accessibilityIdentifier("library.newCourse")
                Button {
                    ingestMode = .importPackages(selectedCourseID)
                    showingIngest = true
                } label: {
                    Label("Import lesson package", systemImage: "square.and.arrow.down.on.square")
                }
                .accessibilityIdentifier("library.importLessons")
                Button {
                    showingSettings = true
                } label: {
                    Label("AI settings", systemImage: "gearshape")
                }
                .accessibilityIdentifier("library.settings")
                Button {
                    showingJobs = true
                } label: {
                    Label("Generation jobs", systemImage: "list.bullet.rectangle")
                }
                .accessibilityIdentifier("library.jobs")
            }
            if services.generationIsRunning || services.generationError != nil {
                Section("AI") {
                    if services.generationIsRunning {
                        Label("Generation queue running", systemImage: "bolt.fill")
                            .font(.footnote)
                            .foregroundStyle(.green)
                    }
                    if let error = services.generationError {
                        Text(error)
                            .font(.footnote)
                            .foregroundStyle(.red)
                        Button("Retry recovery") {
                            Task { await services.retryGenerationRecovery() }
                        }
                        .font(.footnote)
                    }
                }
            }
            if let error = model.error {
                Section("Storage") {
                    Text(error)
                        .font(.footnote)
                        .foregroundStyle(.red)
                }
            }
            if let message = services.dataVersionMessage {
                Section("Storage") {
                    Label(message, systemImage: services.isWritable ? "internaldrive" : "lock")
                        .font(.footnote)
                        .foregroundStyle(services.isWritable ? Color.secondary : Color.orange)
                }
            }
        }
    }

    private var welcome: some View {
        ContentUnavailableView {
            Label("CourseDeck", systemImage: "books.vertical")
        } description: {
            Text("Select a course, or open the reader sample to exercise prose runs, ledgers, math, callouts, details, USERNOTE cards, code, task lists, and the full-screen table.")
        } actions: {
            Button("Open reader sample") { showingSample = true }
                .buttonStyle(.borderedProminent)
                .accessibilityIdentifier("library.welcomeSample")
            Button("Checkpoints") { showingCheckpoints = true }
                .buttonStyle(.bordered)
        }
    }
}

// MARK: - Course browser

@MainActor
final class CourseBrowserModel: ObservableObject {
    let courseId: String
    @Published private(set) var manifest: CourseManifest?
    @Published private(set) var docs = CourseDocsFlags()
    @Published private(set) var error: String?

    private let services: AppServices

    init(courseId: String, services: AppServices = .shared) {
        self.courseId = courseId
        self.services = services
    }

    func load() async {
        do {
            manifest = try await services.repository.course(courseId: courseId)
            docs = (try? await services.repository.discoverCourseDocs(courseId: courseId)) ?? CourseDocsFlags()
        } catch {
            self.error = error.localizedDescription
        }
    }
}

struct CourseBrowserView: View {
    @EnvironmentObject private var services: AppServices
    @StateObject private var model: CourseBrowserModel
    @State private var showingCreateTab = false
    @State private var showingTrash = false
    @State private var pendingDelete: WorkspaceTabOption?

    init(courseId: String) {
        _model = StateObject(wrappedValue: CourseBrowserModel(courseId: courseId))
    }

    var body: some View {
        Group {
            if let manifest = model.manifest {
                List {
                    Section("Course documents") {
                        ForEach(NavigationRules.courseTabs(docs: model.docs)) { tab in
                            courseRow(tab)
                        }
                    }
                    ForEach(manifest.units, id: \.number) { unit in
                        Section(unit.title.isEmpty ? "Unit \(unit.number)" : unit.title) {
                            NavigationLink {
                                UnitDocumentsView(
                                    courseId: model.courseId,
                                    unitNumber: unit.number,
                                    unitTitle: unit.title
                                )
                            } label: {
                                Label("Unit documents & generation", systemImage: "square.stack.3d.up")
                            }
                            ForEach(unit.lessons, id: \.id) { lesson in
                                NavigationLink {
                                    LessonDocumentListView(
                                        courseId: model.courseId,
                                        lessonId: lesson.id,
                                        lessonTitle: lesson.title
                                    )
                                } label: {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(lesson.title.isEmpty ? lesson.id : lesson.title)
                                        HStack(spacing: 6) {
                                            if !lesson.code.isEmpty {
                                                Text(lesson.code)
                                            }
                                            Text(lesson.type.rawValue.capitalized)
                                        }
                                        .font(.caption2)
                                        .foregroundStyle(.secondary)
                                    }
                                }
                            }
                        }
                    }
                }
                .navigationTitle(manifest.title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button {
                            showingTrash = true
                        } label: {
                            Label("Recently deleted", systemImage: "trash")
                        }
                        .accessibilityIdentifier("course.trash")
                    }
                    ToolbarItem(placement: .topBarTrailing) {
                        Button {
                            showingCreateTab = true
                        } label: {
                            Label("New custom tab", systemImage: "plus")
                        }
                        .accessibilityIdentifier("course.addCustomTab")
                    }
                }
            } else if let error = model.error {
                ContentUnavailableView("Course unavailable", systemImage: "exclamationmark.triangle", description: Text(error))
            } else {
                ProgressView("Loading course…")
            }
        }
        .task { await model.load() }
        .sheet(isPresented: $showingCreateTab) {
            CustomTabCreateSheet(courseId: model.courseId, scope: .course) { _ in
                Task {
                    await model.load()
                    services.bumpDataRevision()
                }
            }
            .environmentObject(services)
        }
        .sheet(isPresented: $showingTrash) {
            CustomTabTrashView(courseId: model.courseId) { _ in
                Task {
                    await model.load()
                    services.bumpDataRevision()
                }
            }
            .environmentObject(services)
        }
        .customTabDeleteConfirmation(pending: $pendingDelete) { slug in
            Task {
                _ = try? await services.deleteCustomTab(courseId: model.courseId, scope: .course, tab: slug)
                await model.load()
                services.bumpDataRevision()
            }
        }
    }

    private func courseRow(_ tab: WorkspaceTabOption) -> some View {
        NavigationLink {
            courseDestination(tab)
        } label: {
            VStack(alignment: .leading, spacing: 2) {
                Label(tab.title, systemImage: icon(for: tab))
                if !tab.isAvailable, tab.kind != .courseNavigation {
                    Text("Not generated")
                        .font(.caption2)
                        .foregroundStyle(.orange)
                }
            }
        }
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            if tab.kind == .custom {
                Button(role: .destructive) {
                    pendingDelete = tab
                } label: {
                    Label("Delete", systemImage: "trash")
                }
            }
        }
        .contextMenu {
            if tab.kind == .custom {
                Button(role: .destructive) {
                    pendingDelete = tab
                } label: {
                    Label("Delete custom tab", systemImage: "trash")
                }
            }
        }
        .accessibilityIdentifier(tab.title)
    }

    @ViewBuilder
    private func courseDestination(_ tab: WorkspaceTabOption) -> some View {
        if tab.kind == .quiz {
            QuizScreen(request: .courseTest(
                courseId: model.courseId,
                courseTitle: model.manifest?.title ?? model.courseId
            ))
        } else {
            ReaderScreen(request: .target(ReaderTarget(
                courseId: model.courseId,
                scope: .course,
                tab: tab.slug
            )))
        }
    }

    private func icon(for tab: WorkspaceTabOption) -> String {
        switch tab.slug {
        case "lesson": return "map"
        case "summary": return "text.alignleft"
        case "cheatsheet": return "tablecells"
        case "test": return "checkmark.circle"
        case "schedule": return "calendar"
        default: return "doc.text"
        }
    }
}

// MARK: - Lesson documents

@MainActor
final class LessonDocumentsModel: ObservableObject {
    let courseId: String
    let lessonId: String
    @Published private(set) var bundle: LessonContentBundle?
    @Published private(set) var popQuizzes: [PopQuizReference] = []
    @Published private(set) var error: String?

    private let services: AppServices

    init(courseId: String, lessonId: String, services: AppServices = .shared) {
        self.courseId = courseId
        self.lessonId = lessonId
        self.services = services
    }

    func load() async {
        do {
            bundle = try await services.repository.lessonBundle(courseId: courseId, lessonId: lessonId)
            popQuizzes = await services.popQuizzes(courseId: courseId, lessonId: lessonId)
        } catch {
            self.error = error.localizedDescription
        }
    }

    var options: [WorkspaceTabOption] {
        guard let bundle else { return [] }
        return NavigationRules.lessonTabs(
            availableTabs: Set(bundle.tabs.keys),
            hasLesson: !bundle.lesson.isEmpty
        )
    }
}

struct LessonDocumentListView: View {
    let courseId: String
    let lessonId: String
    let lessonTitle: String
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var services: AppServices
    @StateObject private var model: LessonDocumentsModel
    @State private var generationRequest: GenerationRequest?
    @State private var showingCreateTab = false
    @State private var showingTrash = false
    @State private var pendingDelete: WorkspaceTabOption?
    @State private var isGeneratingPopQuiz = false
    @State private var popQuizError: String?

    init(courseId: String, lessonId: String, lessonTitle: String) {
        self.courseId = courseId
        self.lessonId = lessonId
        self.lessonTitle = lessonTitle
        _model = StateObject(wrappedValue: LessonDocumentsModel(courseId: courseId, lessonId: lessonId))
    }

    var body: some View {
        List {
            if let error = model.error {
                Text(error).foregroundStyle(.red)
            }
            if model.options.isEmpty {
                Text("No lesson documents found.")
                    .foregroundStyle(.secondary)
            }
            Section("Lesson") {
                ForEach(model.options) { tab in
                    HStack {
                        NavigationLink {
                            lessonDestination(tab)
                        } label: {
                            VStack(alignment: .leading, spacing: 2) {
                                Label(tab.title, systemImage: icon(for: tab))
                                if !tab.isAvailable {
                                    Text("Not generated")
                                        .font(.caption2)
                                        .foregroundStyle(.orange)
                                }
                            }
                        }
                        Spacer()
                        if tab.slug != "lesson" {
                            Button {
                                generationRequest = .lesson(
                                    courseId: courseId,
                                    lessonId: lessonId,
                                    title: lessonTitle,
                                    tab: tab.slug
                                )
                            } label: {
                                Image(systemName: "sparkles")
                            }
                            .buttonStyle(.bordered)
                            .accessibilityLabel("Generate \(tab.title)")
                        }
                    }
                    .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                        if tab.kind == .custom {
                            Button(role: .destructive) {
                                pendingDelete = tab
                            } label: {
                                Label("Delete", systemImage: "trash")
                            }
                        }
                    }
                    .contextMenu {
                        if tab.kind == .custom {
                            Button(role: .destructive) {
                                pendingDelete = tab
                            } label: {
                                Label("Delete custom tab", systemImage: "trash")
                            }
                        }
                    }
                }
            }
            Section {
                if model.popQuizzes.isEmpty {
                    Text("No pop quizzes for this lesson yet.")
                        .foregroundStyle(.secondary)
                }
                ForEach(model.popQuizzes) { quiz in
                    NavigationLink {
                        QuizScreen(request: .popQuiz(
                            courseId: courseId,
                            lessonId: lessonId,
                            timestamp: quiz.timestamp,
                            lessonTitle: lessonTitle.isEmpty ? lessonId : lessonTitle
                        ))
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            HStack {
                                Label(quiz.timestamp, systemImage: "clock.badge.questionmark")
                                if let modified = quiz.modifiedAt {
                                    Text(modified, style: .date)
                                        .font(.caption2)
                                        .foregroundStyle(.secondary)
                                }
                            }
                            Text("Timed · 5 minutes · attempt history")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            } header: {
                HStack {
                    Text("Pop quizzes")
                    Spacer()
                    Button {
                        generatePopQuiz()
                    } label: {
                        if isGeneratingPopQuiz {
                            ProgressView()
                        } else {
                            Text("Generate")
                        }
                    }
                    .font(.caption.weight(.semibold))
                    .buttonStyle(.borderless)
                    .disabled(isGeneratingPopQuiz)
                    .accessibilityIdentifier("lesson.generatePopQuiz")
                }
            }
            if let popQuizError {
                Section {
                    Text(popQuizError).font(.footnote).foregroundStyle(.red)
                }
            }
        }
        .navigationTitle(lessonTitle.isEmpty ? lessonId : lessonTitle)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button {
                    dismiss()
                } label: {
                    Image(systemName: "chevron.left")
                }
                .accessibilityLabel("Back")
                .accessibilityIdentifier("lessonDocuments.back")
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    showingTrash = true
                } label: {
                    Label("Recently deleted", systemImage: "trash")
                }
                .accessibilityIdentifier("lesson.trash")
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    showingCreateTab = true
                } label: {
                    Label("New custom tab", systemImage: "plus")
                }
                .accessibilityIdentifier("lesson.addCustomTab")
            }
        }
        .task { await model.load() }
        .sheet(item: $generationRequest) { request in
            GenerationSheet(request: request) { _ in }
                .environmentObject(services)
        }
        .sheet(isPresented: $showingCreateTab) {
            CustomTabCreateSheet(courseId: courseId, scope: .lesson(lessonId)) { _ in
                Task {
                    await model.load()
                    services.bumpDataRevision()
                }
            }
            .environmentObject(services)
        }
        .sheet(isPresented: $showingTrash) {
            CustomTabTrashView(courseId: courseId) { _ in
                Task {
                    await model.load()
                    services.bumpDataRevision()
                }
            }
            .environmentObject(services)
        }
        .customTabDeleteConfirmation(pending: $pendingDelete) { slug in
            Task {
                _ = try? await services.deleteCustomTab(
                    courseId: courseId,
                    scope: .lesson(lessonId),
                    tab: slug
                )
                await model.load()
                services.bumpDataRevision()
            }
        }
        .accessibilityIdentifier("lessonDocuments.root")
    }

    @ViewBuilder
    private func lessonDestination(_ tab: WorkspaceTabOption) -> some View {
        if tab.kind == .quiz {
            QuizScreen(request: .lessonTest(
                courseId: courseId,
                lessonId: lessonId,
                lessonTitle: lessonTitle.isEmpty ? lessonId : lessonTitle
            ))
        } else {
            ReaderScreen(request: .target(ReaderTarget(
                courseId: courseId,
                scope: .lesson(lessonId),
                tab: tab.slug
            )))
        }
    }

    private func icon(for tab: WorkspaceTabOption) -> String {
        switch tab.slug {
        case "lesson": return "doc.richtext"
        case "summary": return "text.alignleft"
        case "cheatsheet": return "tablecells"
        case "test": return "checkmark.circle"
        default: return "doc.text"
        }
    }

    private func generatePopQuiz() {
        isGeneratingPopQuiz = true
        popQuizError = nil
        Task {
            do {
                _ = try await services.generatePopQuiz(courseId: courseId, lessonId: lessonId, force: true)
                await model.load()
                services.bumpDataRevision()
            } catch {
                popQuizError = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            }
            isGeneratingPopQuiz = false
        }
    }
}
