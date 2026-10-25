import CourseDeckCore
import SwiftUI

@MainActor
final class UnitDocumentsModel: ObservableObject {
    let courseId: String
    let unitNumber: Int
    let unitTitle: String
    @Published private(set) var discoveredTabs: Set<String> = []
    @Published var error: String?

    private let services: AppServices

    init(
        courseId: String,
        unitNumber: Int,
        unitTitle: String,
        services: AppServices = .shared
    ) {
        self.courseId = courseId
        self.unitNumber = unitNumber
        self.unitTitle = unitTitle
        self.services = services
    }

    func load() async {
        do {
            discoveredTabs = Set(try await services.repository.discoverUnitDocs(
                courseId: courseId,
                unitNumber: unitNumber
            ))
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    var options: [WorkspaceTabOption] {
        NavigationRules.unitTabs(discovered: discoveredTabs)
    }
}

struct UnitDocumentsView: View {
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var services: AppServices
    @StateObject private var model: UnitDocumentsModel
    @State private var generationRequest: GenerationRequest?
    @State private var showingCreateTab = false
    @State private var showingTrash = false
    @State private var pendingDelete: WorkspaceTabOption?

    init(courseId: String, unitNumber: Int, unitTitle: String) {
        _model = StateObject(wrappedValue: UnitDocumentsModel(
            courseId: courseId,
            unitNumber: unitNumber,
            unitTitle: unitTitle
        ))
    }

    var body: some View {
        List {
            if let error = model.error {
                Text(error).foregroundStyle(.red)
            }
            if model.options.allSatisfy({ !$0.isAvailable }) {
                Text("No unit documents yet. Generate the assignments or unit test tab.")
                    .foregroundStyle(.secondary)
            }
            ForEach(model.options) { tab in
                HStack {
                    NavigationLink {
                        destination(for: tab)
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
                    Button {
                        generationRequest = .unit(
                            courseId: model.courseId,
                            unitNumber: model.unitNumber,
                            title: model.unitTitle,
                            tab: tab.slug
                        )
                    } label: {
                        Image(systemName: "sparkles")
                    }
                    .buttonStyle(.bordered)
                    .accessibilityLabel("Generate \(tab.title)")
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
        .navigationTitle(model.unitTitle.isEmpty ? "Unit \(model.unitNumber)" : model.unitTitle)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button {
                    dismiss()
                } label: {
                    Image(systemName: "chevron.left")
                }
                .accessibilityLabel("Back")
                .accessibilityIdentifier("unitDocuments.back")
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    showingTrash = true
                } label: {
                    Label("Recently deleted", systemImage: "trash")
                }
                .accessibilityIdentifier("unit.trash")
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    showingCreateTab = true
                } label: {
                    Label("New unit tab", systemImage: "plus")
                }
                .accessibilityIdentifier("unit.addCustomTab")
            }
        }
        .task { await model.load() }
        .sheet(item: $generationRequest) { request in
            GenerationSheet(request: request) { _ in }
                .environmentObject(services)
        }
        .sheet(isPresented: $showingCreateTab) {
            CustomTabCreateSheet(courseId: model.courseId, scope: .unit(model.unitNumber)) { _ in
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
                _ = try? await services.deleteCustomTab(
                    courseId: model.courseId,
                    scope: .unit(model.unitNumber),
                    tab: slug
                )
                await model.load()
                services.bumpDataRevision()
            }
        }
        .accessibilityIdentifier("unitDocuments.root")
    }

    @ViewBuilder
    private func destination(for tab: WorkspaceTabOption) -> some View {
        if tab.kind == .quiz {
            QuizScreen(request: .unitTest(
                courseId: model.courseId,
                unitNumber: model.unitNumber,
                unitTitle: model.unitTitle
            ))
        } else {
            ReaderScreen(request: .target(ReaderTarget(
                courseId: model.courseId,
                scope: .unit(model.unitNumber),
                tab: tab.slug
            )))
        }
    }

    private func icon(for tab: WorkspaceTabOption) -> String {
        switch tab.slug {
        case "assignments": return "list.clipboard"
        case "test": return "checkmark.circle"
        default: return "doc.text"
        }
    }
}
