import Foundation

/// Durable generation journal (`<root>/.jobs.json`).
///
/// The journal stores every task input, so a relaunch can rebuild the request
/// honestly. `processing` never survives a relaunch: `recoverInterrupted()`
/// flips non-terminal `running` jobs to `interrupted`, and the UI offers an
/// explicit retry or discard. There is no automatic resume (PLAN §4.9).
public actor JobStore {
    private let root: DataRoot
    private let store: AtomicFileStore
    private let quarantine: FileQuarantine
    private let leaseOwner: String

    public init(root: DataRoot, store: AtomicFileStore = AtomicFileStore()) {
        self.root = root
        self.store = store
        self.quarantine = FileQuarantine(rootURL: root.quarantineURL)
        self.leaseOwner = "JobStore.\(UUID().uuidString)"
    }

    public func allJobs() -> [GenerationJob] {
        loadJobs()
    }

    public func jobs(status: JobStatus) -> [GenerationJob] {
        loadJobs().filter { $0.status == status }
    }

    /// Inserts a job, deduping against `queued`/`running` tasks with the same
    /// identity. A terminal task with the same identity is replaced.
    @discardableResult
    public func enqueue(_ job: GenerationJob) throws -> GenerationJob {
        try root.acquireWriteLease(owner: leaseOwner)
        defer { root.releaseWriteLease(owner: leaseOwner) }
        var jobs = loadJobs()
        if let index = jobs.firstIndex(where: { $0.id == job.id }) {
            // `interrupted` is a non-terminal state because it needs an
            // explicit user decision, but it is replaceable: re-running the
            // same generation must not silently keep the interrupted record
            // and then never execute the new request.
            if !jobs[index].status.isTerminal, jobs[index].status != .interrupted {
                return jobs[index]
            }
            var replacement = job
            replacement.createdAt = GenerationJob.timestamp()
            replacement.updatedAt = replacement.createdAt
            jobs[index] = replacement
        } else {
            jobs.append(job)
        }
        try persist(jobs)
        return job
    }

    public func job(id: String) -> GenerationJob? {
        loadJobs().first(where: { $0.id == id })
    }

    @discardableResult
    public func update(id: String, mutate: (inout GenerationJob) -> Void) throws -> GenerationJob? {
        try root.acquireWriteLease(owner: leaseOwner)
        defer { root.releaseWriteLease(owner: leaseOwner) }
        var jobs = loadJobs()
        guard let index = jobs.firstIndex(where: { $0.id == id }) else { return nil }
        mutate(&jobs[index])
        jobs[index].updatedAt = GenerationJob.timestamp()
        try persist(jobs)
        return jobs[index]
    }

    /// Marks a job as running and increments the attempt counter.
    @discardableResult
    public func start(id: String, activeCardId: String? = nil) throws -> GenerationJob? {
        try update(id: id) { job in
            job.status = .running
            job.attempts += 1
            job.startedAt = GenerationJob.timestamp()
            job.lastError = nil
            if let activeCardId { job.activeCardId = activeCardId }
        }
    }

    @discardableResult
    public func finish(
        id: String,
        status: JobStatus,
        error: String? = nil,
        partialOutput: String? = nil,
        tokensUsed: Int? = nil
    ) throws -> GenerationJob? {
        try update(id: id) { job in
            job.status = status
            job.finishedAt = GenerationJob.timestamp()
            if let error { job.lastError = error }
            if let partialOutput { job.partialOutput = partialOutput }
            if let tokensUsed { job.tokensUsed = tokensUsed }
        }
    }

    @discardableResult
    public func cancel(id: String) throws -> GenerationJob? {
        try root.acquireWriteLease(owner: leaseOwner)
        defer { root.releaseWriteLease(owner: leaseOwner) }
        return try update(id: id) { job in
            if job.status == .queued || job.status == .running {
                job.status = .cancelled
                job.finishedAt = GenerationJob.timestamp()
            }
        }
    }

    /// Explicit user retry: interrupted/failed/cancelled tasks go back to the
    /// queue. Full inputs are already present in the journal.
    @discardableResult
    public func retry(id: String) throws -> GenerationJob? {
        try root.acquireWriteLease(owner: leaseOwner)
        defer { root.releaseWriteLease(owner: leaseOwner) }
        return try update(id: id) { job in
            guard job.status == .interrupted || job.status == .failed || job.status == .cancelled else { return }
            job.status = .queued
            job.finishedAt = nil
            job.startedAt = nil
            job.partialOutput = nil
        }
    }

    /// Returns a running job to the queue after a retryable transport failure.
    @discardableResult
    public func requeue(id: String, error: String?) throws -> GenerationJob? {
        try root.acquireWriteLease(owner: leaseOwner)
        defer { root.releaseWriteLease(owner: leaseOwner) }
        return try update(id: id) { job in
            guard job.status == .running else { return }
            job.status = .queued
            job.startedAt = nil
            job.finishedAt = nil
            job.partialOutput = nil
            if let error { job.lastError = error }
        }
    }

    /// Explicit discard: removes the journal record entirely.
    @discardableResult
    public func discard(id: String) throws -> Bool {
        try root.acquireWriteLease(owner: leaseOwner)
        defer { root.releaseWriteLease(owner: leaseOwner) }
        var jobs = loadJobs()
        let before = jobs.count
        jobs.removeAll { $0.id == id }
        guard jobs.count != before else { return false }
        try persist(jobs)
        return true
    }

    /// Called once on foreground launch. Returns the number of jobs moved to
    /// `interrupted`; no job is resumed automatically.
    @discardableResult
    public func recoverInterrupted() throws -> Int {
        try root.acquireWriteLease(owner: leaseOwner)
        defer { root.releaseWriteLease(owner: leaseOwner) }
        var jobs = loadJobs()
        var count = 0
        for index in jobs.indices where jobs[index].status == .running {
            jobs[index].status = .interrupted
            jobs[index].updatedAt = GenerationJob.timestamp()
            count += 1
        }
        if count > 0 {
            try persist(jobs)
        }
        return count
    }

    /// Next queued job for a worker. Interactive work drains before standard
    /// work, which drains before course-wide documents.
    public func nextQueued(preferredLane: JobLane? = nil) -> GenerationJob? {
        let queued = loadJobs().filter { $0.status == .queued }
        guard !queued.isEmpty else { return nil }
        return queued.sorted { lhs, rhs in
            let lhsRank = Self.rank(lhs.lane, preferred: preferredLane)
            let rhsRank = Self.rank(rhs.lane, preferred: preferredLane)
            if lhsRank != rhsRank { return lhsRank < rhsRank }
            return lhs.createdAt < rhs.createdAt
        }.first
    }

    /// Next queued job for one specific lane (each lane has its own worker).
    public func nextQueued(lane: JobLane) -> GenerationJob? {
        loadJobs()
            .filter { $0.status == .queued && $0.lane == lane }
            .sorted { $0.createdAt < $1.createdAt }
            .first
    }

    /// Removes terminal records older than `cutoff` (journal hygiene).
    @discardableResult
    public func pruneTerminal(olderThan cutoff: Date) throws -> Int {
        try root.acquireWriteLease(owner: leaseOwner)
        defer { root.releaseWriteLease(owner: leaseOwner) }
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        var jobs = loadJobs()
        let before = jobs.count
        jobs.removeAll { job in
            guard job.status.isTerminal,
                  let date = formatter.date(from: job.updatedAt) else { return false }
            return date < cutoff
        }
        if jobs.count != before {
            try persist(jobs)
        }
        return before - jobs.count
    }

    // MARK: - Private

    private static func rank(_ lane: JobLane, preferred: JobLane?) -> Int {
        if let preferred, lane == preferred { return -1 }
        switch lane {
        case .interactive: return 0
        case .standard: return 1
        case .courseDocs: return 2
        }
    }

    private func loadJobs() -> [GenerationJob] {
        let url = root.jobsURL
        guard store.exists(url) else { return [] }
        do {
            let json = try store.readJSON(url)
            guard let values = json.arrayValue else {
                throw JobStoreError.notAnArray
            }
            return values.compactMap(GenerationJob.init(json:))
        } catch {
            _ = try? quarantine.quarantineFile(url, reason: "unreadable .jobs.json", store: store)
            return []
        }
    }

    private func persist(_ jobs: [GenerationJob]) throws {
        try root.acquireWriteLease(owner: leaseOwner)
        defer { root.releaseWriteLease(owner: leaseOwner) }
        let json = JSONValue.array(jobs.map(\.json))
        try store.writeJSON(json, to: root.jobsURL)
        try? root.setExcludedFromBackup(root.jobsURL)
    }
}

public enum JobStoreError: Error, LocalizedError, Equatable {
    case notAnArray

    public var errorDescription: String? {
        switch self {
        case .notAnArray: return ".jobs.json must be a top-level JSON array."
        }
    }
}
