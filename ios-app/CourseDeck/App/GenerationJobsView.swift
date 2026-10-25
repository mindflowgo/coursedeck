import CourseDeckCore
import SwiftUI

@MainActor
final class GenerationJobsModel: ObservableObject {
    @Published private(set) var jobs: [GenerationJob] = []
    @Published var error: String?
    @Published var notice: String?

    private let services: AppServices

    init(services: AppServices = .shared) {
        self.services = services
    }

    func load() async {
        jobs = await services.generationJobs()
    }

    func retry(_ job: GenerationJob) async {
        do {
            _ = try await services.retryGenerationJob(id: job.id)
            await load()
        } catch {
            self.error = error.localizedDescription
        }
    }

    func discard(_ job: GenerationJob) async {
        do {
            _ = try await services.discardGenerationJob(id: job.id)
            await load()
        } catch {
            self.error = error.localizedDescription
        }
    }

    func cancel(_ job: GenerationJob) async {
        do {
            _ = try await services.cancelGenerationJob(id: job.id)
            await load()
        } catch {
            self.error = error.localizedDescription
        }
    }
}

struct GenerationJobsView: View {
    @Environment(\.dismiss) private var dismiss
    @StateObject private var model = GenerationJobsModel()

    var body: some View {
        List {
            if let error = model.error {
                Section { Text(error).foregroundStyle(.red) }
            }
            if let notice = model.notice {
                Section { Text(notice).foregroundStyle(.green) }
            }
            if model.jobs.isEmpty {
                ContentUnavailableView(
                    "No generation jobs",
                    systemImage: "tray",
                    description: Text("Queued, running and finished AI jobs appear here.")
                )
            }
            ForEach(model.jobs, id: \.id) { job in
                jobRow(job)
            }
        }
        .navigationTitle("Generation jobs")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    Task { await model.load() }
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .accessibilityLabel("Refresh jobs")
            }
            ToolbarItem(placement: .confirmationAction) {
                Button("Done") { dismiss() }
                    .accessibilityIdentifier("generationJobs.done")
            }
        }
        .task {
            await model.load()
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 2_000_000_000)
                await model.load()
            }
        }
        .accessibilityIdentifier("generationJobs.root")
    }

    @ViewBuilder
    private func jobRow(_ job: GenerationJob) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Label(job.status.rawValue.capitalized, systemImage: icon(for: job.status))
                    .font(.headline)
                    .foregroundStyle(color(for: job.status))
                Spacer()
                Text("\(job.attempts)/\(job.maxAttempts)")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            Text("\(job.lessonTitle.isEmpty ? job.lessonId : job.lessonTitle) · \(job.tab)")
                .font(.callout)
            Text(job.id)
                .font(.caption2)
                .foregroundStyle(.secondary)
            if let error = job.lastError, !error.isEmpty {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
            }
            if let tokens = job.tokensUsed {
                Text("\(tokens) tokens used").font(.caption2).foregroundStyle(.secondary)
            }
            if let partial = job.partialOutput, !partial.isEmpty {
                DisclosureGroup("Partial output (\(partial.count) chars)") {
                    ScrollView {
                        Text(String(partial.suffix(8_000)))
                            .font(.system(.caption2, design: .monospaced))
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .frame(maxHeight: 220)
                }
            }
            HStack(spacing: 12) {
                if job.status == .running || job.status == .queued {
                    Button("Cancel") {
                        Task { await model.cancel(job) }
                    }
                    .buttonStyle(.bordered)
                }
                if canRetry(job.status) {
                    Button("Retry") {
                        Task { await model.retry(job) }
                    }
                    .buttonStyle(.borderedProminent)
                }
                Button("Discard", role: .destructive) {
                    Task { await model.discard(job) }
                }
                .buttonStyle(.bordered)
            }
            .font(.caption)
        }
        .padding(.vertical, 4)
        .accessibilityIdentifier("generationJobs.job.\(job.id)")
    }

    private func canRetry(_ status: JobStatus) -> Bool {
        status == .interrupted || status == .failed || status == .cancelled
    }

    private func icon(for status: JobStatus) -> String {
        switch status {
        case .queued: return "clock"
        case .running: return "bolt.fill"
        case .succeeded: return "checkmark.circle.fill"
        case .failed: return "xmark.octagon.fill"
        case .cancelled: return "slash.circle"
        case .interrupted: return "pause.circle.fill"
        }
    }

    private func color(for status: JobStatus) -> Color {
        switch status {
        case .queued: return .secondary
        case .running: return .blue
        case .succeeded: return .green
        case .failed: return .red
        case .cancelled: return .orange
        case .interrupted: return .orange
        }
    }
}
