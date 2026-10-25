import Foundation

/// Course ingestion: archive packages into `_backup/`, extract lesson HTML and
/// assets, convert to Markdown, preserve incremental edits, merge the manifest,
/// and optimize images (PLAN §4.11).
///
/// The actor holds the data-root write lease for the whole operation so a
/// concurrent backup merge or generation cannot interleave. It deliberately
/// writes through `AtomicFileStore` instead of `CourseRepository` while the
/// lease is held; the repository would try to take the same non-reentrant
/// lease and deadlock.
public actor CourseIngestor {
    private let root: DataRoot
    private let store: AtomicFileStore
    private let scanner: SecretScanner
    private let leaseOwner: String
    private let leaseTimeout: TimeInterval

    public init(
        root: DataRoot,
        store: AtomicFileStore = AtomicFileStore(),
        scanner: SecretScanner = SecretScanner(),
        leaseTimeout: TimeInterval = 120
    ) {
        self.root = root
        self.store = store
        self.scanner = scanner
        self.leaseOwner = "CourseIngestor.\(UUID().uuidString)"
        self.leaseTimeout = leaseTimeout
    }

    // MARK: - New course

    /// Validates and lowercases a user-supplied course code. Empty values,
    /// traversal, spaces, and reserved `.`/`..` are rejected.
    public static func validatedCourseCode(_ raw: String) throws -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            throw IngestError.invalidCourseCode(raw)
        }
        let lower = trimmed.lowercased()
        guard lower != ".", lower != ".." else {
            throw IngestError.invalidCourseCode(raw)
        }
        do {
            _ = try PathValidator.courseId(lower)
        } catch {
            throw IngestError.invalidCourseCode(raw)
        }
        return lower
    }

    /// Creates a course from a user-supplied code. No mock grade, level, or
    /// description is invented; the title falls back to the uppercased code.
    /// An existing course is rejected unless `confirmExisting` is set, in
    /// which case the existing manifest is returned unchanged.
    @discardableResult
    public func createCourse(
        _ request: NewCourseRequest,
        now: Date = Date()
    ) throws -> CourseManifest {
        let id = try Self.validatedCourseCode(request.code)
        try root.acquireWriteLease(owner: leaseOwner, timeout: leaseTimeout)
        defer { root.releaseWriteLease(owner: leaseOwner) }

        let courseDir = try root.courseURL(id)
        let metaURL = try PathValidator.safeJoin(base: courseDir, "meta.json")
        if store.exists(metaURL) {
            guard request.confirmExisting else {
                throw IngestError.courseExists(id)
            }
            do {
                return try CourseManifest.decode(try store.read(metaURL))
            } catch {
                throw IngestError.corruptManifest(error.localizedDescription)
            }
        }

        try createCourseDirectories(courseDir)
        let title = request.title?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .nilIfEmpty ?? id.uppercased()
        let manifest = CourseManifest(
            id: id,
            title: title,
            grade: request.grade?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "",
            level: request.level?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "",
            description: request.description?.trimmingCharacters(in: .whitespacesAndNewlines) ?? "",
            units: [],
            updatedAt: IngestTimestamp.iso8601(now)
        )
        try store.write(manifest.encoded(), to: metaURL)
        try root.excludeRawPackagesFromBackup(courseId: id)
        return manifest
    }

    // MARK: - Ingest

    /// Ingests `packages` into an existing course. Every package is archived
    /// into `_backup/` first (unless `archivePackages` is false), then every
    /// package currently in `_backup/` is processed, matching the desktop's
    /// "rebuild from packages" behavior while merging existing manifest
    /// lessons so a default backup without `_backup/` cannot drop navigation.
    public func ingest(
        courseId: String,
        packages: [URL],
        options: IngestOptions = IngestOptions()
    ) throws -> IngestResult {
        let id = try PathValidator.normalizedCourseId(courseId)
        try root.acquireWriteLease(owner: leaseOwner, timeout: leaseTimeout)
        defer { root.releaseWriteLease(owner: leaseOwner) }

        let courseDir = try root.courseURL(id)
        let metaURL = try PathValidator.safeJoin(base: courseDir, "meta.json")
        guard store.exists(metaURL) else {
            throw IngestError.courseNotFound(id)
        }
        let existingManifest: CourseManifest
        do {
            existingManifest = try CourseManifest.decode(try store.read(metaURL))
        } catch {
            // Never write over an unreadable manifest: that would silently
            // destroy course metadata.
            throw IngestError.corruptManifest(error.localizedDescription)
        }

        try createCourseDirectories(courseDir)
        let backupDir = try PathValidator.safeJoin(base: courseDir, "_backup")
        let assetsURL = try PathValidator.safeJoin(base: courseDir, "assets")

        var warnings: [String] = []
        var skippedPackages: [String] = []
        var archivedPackages: [String] = []
        var sourceByArchivedName: [String: URL] = [:]
        var successfulSources: [URL] = []

        // 1. Secret-scan and archive uploaded packages.
        if options.archivePackages {
            for source in packages {
                let sourceURL = source.standardizedFileURL
                guard let kind = LessonPackageKind(fileExtension: sourceURL.pathExtension) else {
                    warnings.append("Skipped \(sourceURL.lastPathComponent): unsupported package type.")
                    skippedPackages.append(sourceURL.lastPathComponent)
                    continue
                }
                if isInside(sourceURL, backupDir) {
                    continue
                }

                // Reject oversized packages before reading or scanning them.
                let declaredSize = UInt64(
                    (try? sourceURL.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
                )
                let packageLimit: UInt64
                switch kind {
                case .zip: packageLimit = options.limits.maxPackageBytes
                case .mhtml: packageLimit = options.limits.maxMHTMLPackageBytes
                case .html: packageLimit = options.limits.maxHTMLBytes
                }
                if declaredSize > packageLimit {
                    warnings.append(
                        "Skipped \(sourceURL.lastPathComponent): the package exceeds the \(packageLimit)-byte ingest limit."
                    )
                    skippedPackages.append(sourceURL.lastPathComponent)
                    continue
                }

                do {
                    if let match = try scanner.scanFile(at: sourceURL) {
                        throw IngestError.secretFound(
                            package: sourceURL.lastPathComponent,
                            pattern: match.pattern
                        )
                    }
                    if kind == .html,
                       let match = try scanHTMLCompanions(
                           source: sourceURL,
                           limits: options.limits
                       ) {
                        throw IngestError.secretFound(
                            package: sourceURL.lastPathComponent,
                            pattern: match.pattern
                        )
                    }
                } catch let error as IngestError {
                    warnings.append(error.localizedDescription)
                    skippedPackages.append(sourceURL.lastPathComponent)
                    continue
                } catch {
                    warnings.append(
                        "Skipped \(sourceURL.lastPathComponent): the package could not be secret-scanned (\(error.localizedDescription))."
                    )
                    skippedPackages.append(sourceURL.lastPathComponent)
                    continue
                }

                do {
                    let name = try archivePackage(source: sourceURL, into: backupDir, limits: options.limits)
                    archivedPackages.append(name)
                    sourceByArchivedName[name] = sourceURL
                } catch {
                    warnings.append("Could not archive \(sourceURL.lastPathComponent): \(error.localizedDescription)")
                    skippedPackages.append(sourceURL.lastPathComponent)
                }
            }
        }

        // 2. Process every package currently in `_backup/`.
        let packageURLs = try listPackages(in: backupDir)
        if packageURLs.isEmpty {
            warnings.append(
                "No lesson packages were found; existing lessons were preserved."
            )
        }
        var outcomes: [LessonOutcome] = []
        var assetsExtracted = 0
        let extractor = LessonPackageExtractor(store: store, limits: options.limits)
        let cleaner = HTMLLessonCleaner()
        let converter = HTMLToMarkdownConverter()

        for packageURL in packageURLs {
            let packageName = packageURL.lastPathComponent
            do {
                let assetStore = CourseAssetStore(assetsURL: assetsURL, store: store)
                guard let extracted = try extractor.extract(
                    packageURL: packageURL,
                    assetStore: assetStore
                ) else {
                    warnings.append("No lesson HTML was found in \(packageName).")
                    skippedPackages.append(packageName)
                    continue
                }

                let cleaned = try cleaner.clean(html: extracted.html) { reference in
                    assetStore.rewrittenReference(forReference: reference)
                }
                let markdown = try converter.convert(cleaned.html)
                let outcome = try writeLesson(
                    extracted,
                    cleaned: cleaned,
                    markdown: markdown,
                    courseId: id,
                    courseDir: courseDir,
                    existingManifest: existingManifest,
                    options: options,
                    packageName: packageName,
                    warnings: &warnings
                )
                outcomes.append(outcome)
                warnings.append(contentsOf: extracted.warnings)
                warnings.append(contentsOf: cleaned.warnings)
                assetsExtracted += assetStore.assets.filter(\.isNew).count
                if let source = sourceByArchivedName[packageName] {
                    successfulSources.append(source)
                }
            } catch {
                warnings.append("Skipped \(packageName): \(error.localizedDescription)")
                skippedPackages.append(packageName)
            }
        }

        // 3. Merge the manifest. Existing lessons are never dropped, even when
        //    no package represents them (the default-backup case).
        let merged = mergeManifest(
            existing: existingManifest,
            outcomes: outcomes,
            courseDir: courseDir,
            now: options.now,
            warnings: &warnings
        )
        try store.write(merged.encoded(), to: metaURL)

        // 4. Compress oversized images and rewrite Markdown references.
        let imageSummary: ImageOptimizeSummary
        do {
            imageSummary = try CourseImageOptimizer(
                options: options.imageOptions,
                store: store
            ).optimize(courseDirectory: courseDir)
        } catch {
            warnings.append("Image optimization failed: \(error.localizedDescription)")
            imageSummary = ImageOptimizeSummary(warnings: [error.localizedDescription])
        }

        // 5. Remove successfully ingested sources from the Import Inbox.
        var sourcesRemoved: [URL] = []
        if options.removeSourceFromImportInbox, let inbox = root.importInboxURL {
            for source in successfulSources where isInside(source, inbox) {
                do {
                    try FileManager.default.removeItem(at: source)
                    sourcesRemoved.append(source)
                } catch {
                    warnings.append("Could not remove \(source.lastPathComponent) from the Import Inbox.")
                }
            }
        }

        try root.excludeRawPackagesFromBackup(courseId: id)

        let allLessons = merged.units.flatMap(\.lessons)
        return IngestResult(
            manifest: merged,
            newLessonsAdded: outcomes.filter(\.isNew).map(\.lessonId),
            overwrittenLessons: outcomes.filter(\.wasOverwritten).map(\.lessonId),
            preservedLessons: outcomes.filter(\.wasPreserved).map(\.lessonId),
            totalLessons: allLessons.count,
            archivedPackages: archivedPackages,
            skippedPackages: skippedPackages,
            warnings: warnings,
            imageSummary: imageSummary,
            assetsExtracted: assetsExtracted,
            sourcesRemoved: sourcesRemoved
        )
    }

    /// Convenience for the UI: create (or confirm) the course, then ingest.
    @discardableResult
    public func ingestIntoNewCourse(
        request: NewCourseRequest,
        packages: [URL],
        options: IngestOptions = IngestOptions()
    ) throws -> IngestResult {
        _ = try createCourse(request, now: options.now)
        let id = try Self.validatedCourseCode(request.code)
        return try ingest(courseId: id, packages: packages, options: options)
    }

    // MARK: - Lesson writing

    private struct LessonOutcome {
        var lessonId: String
        var unitNumber: Int
        var manifestLesson: CourseLesson
        var isNew: Bool
        var wasOverwritten: Bool
        var wasPreserved: Bool
    }

    private func writeLesson(
        _ extracted: ExtractedLessonPackage,
        cleaned: CleanedLessonHTML,
        markdown: String,
        courseId: String,
        courseDir: URL,
        existingManifest: CourseManifest,
        options: IngestOptions,
        packageName: String,
        warnings: inout [String]
    ) throws -> LessonOutcome {
        let lessonId = extracted.lessonId
        let lessonURL = try PathValidator.safeJoin(base: courseDir, "\(lessonId).lesson.md")
        let exists = store.exists(lessonURL)
        let shouldOverwrite = options.overwriteExisting
            || options.overwriteLessonIds.contains(lessonId)
            || options.overwritePackageFiles.contains(packageName)
        let existingLesson = existingManifest.lesson(id: lessonId)

        if exists && !shouldOverwrite {
            return preservedOutcome(
                extracted: extracted,
                lessonURL: lessonURL,
                courseDir: courseDir,
                existingLesson: existingLesson
            )
        }

        if exists {
            try backupExisting(lessonURL)
        }

        let unitTitle = existingManifest.unit(number: extracted.unitNumber)?.title
            ?? "Unit \(extracted.unitNumber)"
        let title = cleaned.title.nilIfEmpty ?? extracted.title
        let lessonDocument = lessonFrontmatterDocument(
            title: title,
            activityCode: extracted.activityCode,
            courseId: courseId,
            unitTitle: unitTitle,
            unitNumber: extracted.unitNumber,
            lessonNumber: extracted.lessonNumber,
            isAssignment: extracted.isAssignment,
            savedAt: IngestTimestamp.day(options.now),
            body: markdown
        )
        let newLessonContent = try lessonDocument.serialized()
        let existingLessonContent = exists ? (try? store.readString(lessonURL)) : nil
        let preservedLesson = preserveUserNotes(
            existing: existingLessonContent,
            newContent: newLessonContent,
            fileName: "\(lessonId).lesson.md",
            warnings: &warnings
        )
        guard !preservedLesson.blocked else {
            // The new body could not carry every existing USERNOTE card.
            // Keep the existing lesson and its placeholders untouched.
            return preservedOutcome(
                extracted: extracted,
                lessonURL: lessonURL,
                courseDir: courseDir,
                existingLesson: existingLesson
            )
        }
        try store.write(preservedLesson.content, to: lessonURL)

        try writePlaceholderDocument(
            type: "summary",
            prompt: options.summaryPrompt,
            body: initialSummaryBody(
                title: title,
                goals: cleaned.learningGoals,
                criteria: cleaned.successCriteria
            ),
            courseDir: courseDir,
            fileName: "\(lessonId).summary.md",
            overwrite: shouldOverwrite,
            now: options.now,
            warnings: &warnings
        )
        try writePlaceholderDocument(
            type: "cheatsheet",
            prompt: options.cheatsheetPrompt,
            body: initialCheatsheetBody(title: title),
            courseDir: courseDir,
            fileName: "\(lessonId).cheatsheet.md",
            overwrite: shouldOverwrite,
            now: options.now,
            warnings: &warnings
        )
        try writePlaceholderDocument(
            type: "test",
            prompt: options.testPrompt,
            body: initialTestBody(
                courseId: courseId,
                unitNumber: extracted.unitNumber,
                lessonNumber: extracted.lessonNumber,
                title: title
            ),
            courseDir: courseDir,
            fileName: "\(lessonId).test.md",
            overwrite: shouldOverwrite,
            now: options.now,
            warnings: &warnings
        )

        let presence = contentPresence(courseDir: courseDir, lessonId: lessonId)
        let lesson = CourseLesson(
            id: lessonId,
            code: extracted.activityCode,
            title: title,
            unitNumber: extracted.unitNumber,
            lessonNumber: extracted.lessonNumber,
            type: extracted.isAssignment ? .assignment : .lesson,
            hasFull: presence.full,
            hasSummary: presence.summary,
            hasCheatsheet: presence.cheatsheet,
            hasTest: presence.test,
            extras: existingLesson?.extras ?? [],
            originalOrder: existingLesson?.originalOrder ?? []
        )
        return LessonOutcome(
            lessonId: lessonId,
            unitNumber: extracted.unitNumber,
            manifestLesson: lesson,
            isNew: !exists,
            wasOverwritten: exists,
            wasPreserved: false
        )
    }

    /// Builds the manifest entry for a lesson whose files were not replaced.
    private func preservedOutcome(
        extracted: ExtractedLessonPackage,
        lessonURL: URL,
        courseDir: URL,
        existingLesson: CourseLesson?
    ) -> LessonOutcome {
        let identity = readLessonIdentity(at: lessonURL)
        let presence = contentPresence(courseDir: courseDir, lessonId: extracted.lessonId)
        let lesson = CourseLesson(
            id: extracted.lessonId,
            code: identity.activityCode ?? existingLesson?.code ?? extracted.activityCode,
            title: identity.title ?? existingLesson?.title ?? extracted.title,
            unitNumber: existingLesson?.unitNumber ?? extracted.unitNumber,
            lessonNumber: existingLesson?.lessonNumber ?? extracted.lessonNumber,
            type: identity.type ?? existingLesson?.type ?? (extracted.isAssignment ? .assignment : .lesson),
            hasFull: presence.full,
            hasSummary: presence.summary,
            hasCheatsheet: presence.cheatsheet,
            hasTest: presence.test,
            extras: existingLesson?.extras ?? [],
            originalOrder: existingLesson?.originalOrder ?? []
        )
        return LessonOutcome(
            lessonId: extracted.lessonId,
            unitNumber: existingLesson?.unitNumber ?? extracted.unitNumber,
            manifestLesson: lesson,
            isNew: false,
            wasOverwritten: false,
            wasPreserved: true
        )
    }

    private struct NotePreservation {
        var content: String
        var blocked: Bool
    }

    /// Merges USERNOTE cards from the file being replaced into the new body.
    /// If any card cannot be represented, the overwrite is blocked and the
    /// note count is reported in `IngestResult.warnings`.
    private func preserveUserNotes(
        existing: String?,
        newContent: String,
        fileName: String,
        warnings: inout [String]
    ) -> NotePreservation {
        guard let existing, !existing.isEmpty else {
            return NotePreservation(content: newContent, blocked: false)
        }
        let split = UserNoteProtector.split(existing)
        guard !split.notes.isEmpty else {
            return NotePreservation(content: newContent, blocked: false)
        }
        let merged = UserNoteProtector.merge(split.notes, into: newContent)
        let mergedIdentities = Set(UserNoteProtector.split(merged.content).notes.map(\.identity))
        let missing = split.notes.filter { !mergedIdentities.contains($0.identity) }
        guard missing.isEmpty else {
            warnings.append(
                "Blocked overwrite of \(fileName): \(missing.count) existing USERNOTE card(s) could not be preserved."
            )
            return NotePreservation(content: existing, blocked: true)
        }
        return NotePreservation(content: merged.content, blocked: false)
    }

    private struct LessonIdentity {
        var title: String? = nil
        var activityCode: String? = nil
        var type: CourseLessonType? = nil
    }

    private func readLessonIdentity(at url: URL) -> LessonIdentity {
        guard let content = try? store.readString(url) else { return LessonIdentity() }
        guard let document = try? FrontmatterDocument(parsing: content) else {
            return LessonIdentity()
        }
        let title = document.value(forKey: "title")?.stringValue?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let code = document.value(forKey: "activityCode")?.stringValue?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let typeRaw = document.value(forKey: "type")?.stringValue
        return LessonIdentity(
            title: title?.nilIfEmpty,
            activityCode: code?.nilIfEmpty,
            type: typeRaw.map { CourseLessonType(raw: $0) }
        )
    }

    private struct ContentPresence {
        var full: Bool
        var summary: Bool
        var cheatsheet: Bool
        var test: Bool
        var any: Bool { full || summary || cheatsheet || test }
    }

    private func contentPresence(courseDir: URL, lessonId: String) -> ContentPresence {
        func exists(_ suffix: String) -> Bool {
            guard let url = try? PathValidator.safeJoin(base: courseDir, "\(lessonId).\(suffix).md") else {
                return false
            }
            return store.exists(url)
        }
        return ContentPresence(
            full: exists("lesson"),
            summary: exists("summary"),
            cheatsheet: exists("cheatsheet"),
            test: exists("test")
        )
    }

    private func lessonFrontmatterDocument(
        title: String,
        activityCode: String,
        courseId: String,
        unitTitle: String,
        unitNumber: Int,
        lessonNumber: Int,
        isAssignment: Bool,
        savedAt: String,
        body: String
    ) -> FrontmatterDocument {
        FrontmatterDocument(
            entries: [
                YAMLPair(key: "title", value: .scalar(title)),
                YAMLPair(key: "activityCode", value: .scalar(activityCode)),
                YAMLPair(key: "courseId", value: .scalar(courseId)),
                YAMLPair(key: "unit", value: .scalar(unitTitle)),
                YAMLPair(key: "unitNumber", value: .scalar(String(unitNumber))),
                YAMLPair(key: "lessonNumber", value: .scalar(String(lessonNumber))),
                YAMLPair(key: "type", value: .scalar(isAssignment ? "assignment" : "lesson")),
                YAMLPair(key: "savedAt", value: .scalar(savedAt)),
            ],
            body: body,
            hadFrontmatter: true
        )
    }

    @discardableResult
    private func writePlaceholderDocument(
        type: String,
        prompt: String,
        body: String,
        courseDir: URL,
        fileName: String,
        overwrite: Bool,
        now: Date,
        warnings: inout [String]
    ) throws -> Bool {
        let url = try PathValidator.safeJoin(base: courseDir, fileName)
        let exists = store.exists(url)
        if exists {
            guard overwrite else { return false }
            try backupExisting(url)
        }
        let document = FrontmatterDocument(
            entries: [
                YAMLPair(key: "prompt", value: .scalar(prompt)),
                YAMLPair(key: "type", value: .scalar(type)),
                YAMLPair(key: "version", value: .scalar("1")),
                YAMLPair(key: "updatedAt", value: .scalar(IngestTimestamp.day(now))),
            ],
            body: body,
            hadFrontmatter: true
        )
        let newContent = try document.serialized()
        let existingContent = exists ? (try? store.readString(url)) : nil
        let preserved = preserveUserNotes(
            existing: existingContent,
            newContent: newContent,
            fileName: fileName,
            warnings: &warnings
        )
        guard !preserved.blocked else { return false }
        try store.write(preserved.content, to: url)
        return true
    }

    private func initialSummaryBody(
        title: String,
        goals: [String],
        criteria: [String]
    ) -> String {
        let goalsSection = goals.isEmpty
            ? ""
            : "\n\n### Learning Goals\n" + goals.map { "- \($0)" }.joined(separator: "\n")
        let criteriaSection = criteria.isEmpty
            ? ""
            : "\n\n### Success Criteria\n" + criteria.map { "- \($0)" }.joined(separator: "\n")
        return "# Summary: \(title)\n\n*Not yet generated. This summary can be generated using the AI button above or automatically in the background.*\(goalsSection)\(criteriaSection)\n"
    }

    private func initialCheatsheetBody(title: String) -> String {
        "# Cheatsheet: \(title)\n\n*Not yet generated. This cheatsheet can be generated using the AI button above or automatically in the background.*\n"
    }

    private func initialTestBody(
        courseId: String,
        unitNumber: Int,
        lessonNumber: Int,
        title: String
    ) -> String {
        let code = "\(courseId.uppercased()).\(String(format: "%02d", unitNumber)).\(String(format: "%02d", lessonNumber))"
        return "course: \(code)\n\n# Practice Test: \(title)\n\n*Not yet generated. This practice test can be generated using the AI button above or automatically in the background.*\n"
    }

    private func backupExisting(_ url: URL) throws {
        guard store.exists(url) else { return }
        let data = try store.read(url)
        guard !data.isEmpty else { return }
        let backup = url.deletingLastPathComponent()
            .appendingPathComponent(url.lastPathComponent + ".bak")
        try store.write(data, to: backup)
    }

    // MARK: - Manifest merge

    private func mergeManifest(
        existing: CourseManifest,
        outcomes: [LessonOutcome],
        courseDir: URL,
        now: Date,
        warnings: inout [String]
    ) -> CourseManifest {
        var unitsByNumber: [Int: CourseUnit] = [:]
        for unit in existing.units {
            unitsByNumber[unit.number] = unit
        }

        let outcomeIds = Set(outcomes.map { $0.lessonId.lowercased() })
        for outcome in outcomes {
            var unit = unitsByNumber[outcome.unitNumber] ?? CourseUnit(
                number: outcome.unitNumber,
                title: existing.unit(number: outcome.unitNumber)?.title ?? "Unit \(outcome.unitNumber)"
            )
            if let index = unit.lessons.firstIndex(where: {
                $0.id.lowercased() == outcome.lessonId.lowercased()
            }) {
                var mergedLesson = outcome.manifestLesson
                let existingLesson = unit.lessons[index]
                mergedLesson.extras = Self.mergeExtras(
                    existing: existingLesson.extras,
                    new: mergedLesson.extras
                )
                if !existingLesson.originalOrder.isEmpty {
                    mergedLesson.originalOrder = existingLesson.originalOrder
                }
                unit.lessons[index] = mergedLesson
            } else {
                unit.lessons.append(outcome.manifestLesson)
            }
            unitsByNumber[outcome.unitNumber] = unit
        }

        // Refresh flags for lessons that came only from the existing manifest.
        for (number, var unit) in unitsByNumber {
            for index in unit.lessons.indices {
                let lesson = unit.lessons[index]
                guard !outcomeIds.contains(lesson.id.lowercased()) else { continue }
                let presence = contentPresence(courseDir: courseDir, lessonId: lesson.id)
                var refreshed = lesson
                refreshed.hasFull = presence.full
                refreshed.hasSummary = presence.summary
                refreshed.hasCheatsheet = presence.cheatsheet
                refreshed.hasTest = presence.test
                if let lessonURL = try? PathValidator.safeJoin(base: courseDir, "\(lesson.id).lesson.md") {
                    let identity = readLessonIdentity(at: lessonURL)
                    if let title = identity.title { refreshed.title = title }
                    if let code = identity.activityCode { refreshed.code = code }
                    if let type = identity.type { refreshed.type = type }
                }
                if !presence.any {
                    warnings.append(
                        "Lesson \(lesson.id) is listed in meta.json but has no content files; it was kept so navigation is not lost."
                    )
                }
                unit.lessons[index] = refreshed
            }
            unitsByNumber[number] = unit
        }

        let units = unitsByNumber.values
            .sorted { $0.number < $1.number }
            .map { unit -> CourseUnit in
                var copy = unit
                copy.lessons.sort {
                    $0.id.localizedStandardCompare($1.id) == .orderedAscending
                }
                return copy
            }

        if units.isEmpty {
            warnings.append("No lesson packages were found; the course has no lessons yet.")
        }

        var manifest = existing
        manifest.units = units
        manifest.updatedAt = IngestTimestamp.iso8601(now)
        return manifest
    }

    /// Keeps unknown lesson fields from the existing manifest and appends any
    /// new unknown fields the caller supplied. `originalOrder` is applied
    /// separately so the field keeps its desktop position.
    private static func mergeExtras(existing: [JSONMember], new: [JSONMember]) -> [JSONMember] {
        var output = existing
        let keys = Set(existing.map(\.key))
        for member in new where !keys.contains(member.key) {
            output.append(member)
        }
        return output
    }

    // MARK: - Package archiving

    private func archivePackage(
        source: URL,
        into backupDir: URL,
        limits: IngestLimits
    ) throws -> String {
        let fileManager = FileManager.default
        let declaredSize = UInt64((try? source.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0)
        guard declaredSize <= limits.maxPackageBytes else {
            throw IngestError.packageTooLarge(source.lastPathComponent, limits.maxPackageBytes)
        }
        try fileManager.createDirectory(at: backupDir, withIntermediateDirectories: true)

        // Stream the package into a temp file while hashing it. A 256 MB
        // package must not be materialized as one Data value on an iPad.
        let tempURL = backupDir.appendingPathComponent(".package-\(UUID().uuidString).tmp")
        guard fileManager.createFile(atPath: tempURL.path, contents: nil) else {
            throw IngestError.archiveBoundsExceeded(
                source.lastPathComponent,
                "could not create a package staging file"
            )
        }
        var tempExists = true
        defer {
            if tempExists {
                try? fileManager.removeItem(at: tempURL)
            }
        }

        let input = try FileHandle(forReadingFrom: source)
        defer { try? input.close() }
        let output = try FileHandle(forWritingTo: tempURL)
        defer { try? output.close() }

        var hasher = SHA256Hasher()
        var total: UInt64 = 0
        while let chunk = try input.read(upToCount: 256 * 1024), !chunk.isEmpty {
            total += UInt64(chunk.count)
            guard total <= limits.maxPackageBytes else {
                throw IngestError.packageTooLarge(source.lastPathComponent, limits.maxPackageBytes)
            }
            hasher.update(chunk)
            try output.write(contentsOf: chunk)
        }
        try output.synchronize()
        try output.close()

        let name = try uniquePackageName(
            suggested: source.lastPathComponent,
            hash: hasher.finalizeHex(),
            size: total,
            in: backupDir
        )
        // A standalone HTML package depends on its sibling `<stem>_files`,
        // `<stem>.files`, or `assets` folder. Copy recognized assets beside
        // the archived HTML under the archived stem before committing the
        // package, so a companion failure cannot leave a package without its
        // assets in `_backup/`.
        if LessonPackageKind(fileExtension: source.pathExtension) == .html {
            try archiveHTMLCompanions(
                source: source,
                archivedName: name,
                into: backupDir,
                limits: limits
            )
        }

        let destination = backupDir.appendingPathComponent(name)
        if !store.exists(destination) {
            try fileManager.moveItem(at: tempURL, to: destination)
            tempExists = false
        }
        return name
    }

    /// A standalone HTML package's assets live in sibling folders; scan those
    /// files too so a package cannot smuggle a key past the HTML scan. The
    /// scan is bounded by entry count and actual file/total bytes.
    private func scanHTMLCompanions(
        source: URL,
        limits: IngestLimits
    ) throws -> SecretMatch? {
        let fileManager = FileManager.default
        let stem = (source.lastPathComponent as NSString).deletingPathExtension
        let sourceNames = Self.uniqueStrings([
            "\(stem)_files", "\(stem).files", "assets", "\(stem)assets",
        ])
        let entryLimit = min(limits.maxEntries, 500)
        var entryCount = 0
        var totalBytes: UInt64 = 0

        for sourceName in sourceNames {
            let directory = source.deletingLastPathComponent()
                .appendingPathComponent(sourceName, isDirectory: true)
            var isDirectory: ObjCBool = false
            guard fileManager.fileExists(atPath: directory.path, isDirectory: &isDirectory),
                  isDirectory.boolValue,
                  let enumerator = fileManager.enumerator(
                      at: directory,
                      includingPropertiesForKeys: [.isRegularFileKey, .fileSizeKey],
                      options: [.skipsHiddenFiles]
                  ) else {
                continue
            }
            for case let file as URL in enumerator {
                guard (try? file.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true else {
                    continue
                }
                entryCount += 1
                guard entryCount <= entryLimit else {
                    throw IngestError.archiveBoundsExceeded(
                        source.lastPathComponent,
                        "more than \(entryLimit) companion entries"
                    )
                }
                let size = UInt64(
                    (try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
                )
                guard size <= limits.maxEntryBytes else {
                    throw IngestError.archiveBoundsExceeded(
                        source.lastPathComponent,
                        "companion \(file.lastPathComponent) exceeds \(limits.maxEntryBytes) bytes"
                    )
                }
                totalBytes += size
                guard totalBytes <= limits.maxTotalUncompressedBytes else {
                    throw IngestError.archiveBoundsExceeded(
                        source.lastPathComponent,
                        "total companion bytes exceeded \(limits.maxTotalUncompressedBytes)"
                    )
                }
                if let match = try scanner.scanFile(at: file) {
                    return match
                }
            }
        }
        return nil
    }

    private func archiveHTMLCompanions(
        source: URL,
        archivedName: String,
        into backupDir: URL,
        limits: IngestLimits
    ) throws {
        let fileManager = FileManager.default
        let sourceStem = (source.lastPathComponent as NSString).deletingPathExtension
        let archivedStem = (archivedName as NSString).deletingPathExtension
        // `<stem>_files`, `<stem>.files`, a plain sibling `assets` folder, and
        // an already-archived `<stem>assets` folder are all supported.
        let candidates: [(sourceName: String, destinationSuffix: String)] = [
            ("\(sourceStem)_files", "_files"),
            ("\(sourceStem).files", ".files"),
            ("assets", "assets"),
            ("\(sourceStem)assets", "assets"),
        ]
        let entryLimit = min(limits.maxEntries, 500)
        var entryCount = 0
        var totalBytes: UInt64 = 0
        var seenSources = Set<String>()

        for candidate in candidates {
            let sourceDirectory = source.deletingLastPathComponent()
                .appendingPathComponent(candidate.sourceName, isDirectory: true)
            guard !seenSources.contains(sourceDirectory.path) else { continue }
            seenSources.insert(sourceDirectory.path)
            var isDirectory: ObjCBool = false
            guard fileManager.fileExists(atPath: sourceDirectory.path, isDirectory: &isDirectory),
                  isDirectory.boolValue else {
                continue
            }
            let destination = backupDir.appendingPathComponent(
                archivedStem + candidate.destinationSuffix,
                isDirectory: true
            )
            guard !fileManager.fileExists(atPath: destination.path) else { continue }

            // Copy recognized assets into a temp sibling first, then rename,
            // so a crash never leaves a half-copied companion folder.
            let temporary = backupDir.appendingPathComponent(
                ".companion-\(UUID().uuidString)",
                isDirectory: true
            )
            var copied = 0
            do {
                try fileManager.createDirectory(at: temporary, withIntermediateDirectories: true)
                try copyCompanionAssets(
                    from: sourceDirectory,
                    to: temporary,
                    depth: 0,
                    limits: limits,
                    entryLimit: entryLimit,
                    entryCount: &entryCount,
                    totalBytes: &totalBytes,
                    copied: &copied
                )
                if copied == 0 {
                    try? fileManager.removeItem(at: temporary)
                } else {
                    try fileManager.moveItem(at: temporary, to: destination)
                }
            } catch {
                try? fileManager.removeItem(at: temporary)
                throw error
            }
        }
    }

    private func copyCompanionAssets(
        from directory: URL,
        to destinationRoot: URL,
        depth: Int,
        limits: IngestLimits,
        entryLimit: Int,
        entryCount: inout Int,
        totalBytes: inout UInt64,
        copied: inout Int
    ) throws {
        guard depth <= limits.maxCompanionDepth else { return }
        let fileManager = FileManager.default
        let contents = try fileManager.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: [.isDirectoryKey, .fileSizeKey],
            options: [.skipsHiddenFiles]
        )
        for file in contents {
            let isDirectory = (try? file.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) ?? false
            if isDirectory {
                try copyCompanionAssets(
                    from: file,
                    to: destinationRoot,
                    depth: depth + 1,
                    limits: limits,
                    entryLimit: entryLimit,
                    entryCount: &entryCount,
                    totalBytes: &totalBytes,
                    copied: &copied
                )
                continue
            }
            guard AssetCategory(fileName: file.lastPathComponent) != nil else { continue }
            entryCount += 1
            guard entryCount <= entryLimit else {
                throw IngestError.archiveBoundsExceeded(
                    directory.lastPathComponent,
                    "more than \(entryLimit) companion entries"
                )
            }
            let size = UInt64(
                (try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
            )
            guard size <= limits.maxEntryBytes else {
                throw IngestError.archiveBoundsExceeded(
                    file.lastPathComponent,
                    "companion file exceeds \(limits.maxEntryBytes) bytes"
                )
            }
            totalBytes += size
            guard totalBytes <= limits.maxTotalUncompressedBytes else {
                throw IngestError.archiveBoundsExceeded(
                    directory.lastPathComponent,
                    "total companion bytes exceeded \(limits.maxTotalUncompressedBytes)"
                )
            }
            // Resolve `/var` vs `/private/var` symlinks before computing the
            // relative path; string-prefix stripping would leave `private/`
            // in the destination name on macOS.
            let baseComponents = directory.resolvingSymlinksInPath()
                .standardizedFileURL.pathComponents
            let fileComponents = file.resolvingSymlinksInPath()
                .standardizedFileURL.pathComponents
            guard fileComponents.count > baseComponents.count,
                  Array(fileComponents.prefix(baseComponents.count)) == baseComponents else {
                continue
            }
            var destination = destinationRoot
            for component in fileComponents.dropFirst(baseComponents.count) {
                destination.appendPathComponent(component)
            }
            try fileManager.createDirectory(
                at: destination.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            if !fileManager.fileExists(atPath: destination.path) {
                try fileManager.copyItem(at: file, to: destination)
                copied += 1
            }
        }
    }

    private func uniquePackageName(
        suggested: String,
        hash: String,
        size: UInt64,
        in directory: URL
    ) throws -> String {
        let sanitized = CourseAssetStore.sanitizeFilename(suggested, hash: hash)
        let ext = (sanitized as NSString).pathExtension
        let base = (sanitized as NSString).deletingPathExtension
        let hashPrefix = String(hash.prefix(10))
        var candidates = [sanitized, ext.isEmpty ? "\(hashPrefix)-\(base)" : "\(hashPrefix)-\(base).\(ext)"]
        for index in 2...50 {
            candidates.append(ext.isEmpty ? "\(hashPrefix)-\(base)-\(index)" : "\(hashPrefix)-\(base)-\(index).\(ext)")
        }
        for candidate in candidates {
            let url = directory.appendingPathComponent(candidate)
            if store.exists(url) {
                let existingSize = UInt64(
                    (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
                )
                if existingSize == size, (try? SHA256Hasher.hex(fileAt: url)) == hash {
                    return candidate
                }
                continue
            }
            return candidate
        }
        return ext.isEmpty
            ? "\(hashPrefix)-\(UUID().uuidString.prefix(8))"
            : "\(hashPrefix)-\(UUID().uuidString.prefix(8)).\(ext)"
    }

    private func listPackages(in directory: URL) throws -> [URL] {
        guard FileManager.default.fileExists(atPath: directory.path) else { return [] }
        let contents = try FileManager.default.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: [.isRegularFileKey],
            options: [.skipsHiddenFiles]
        )
        return contents
            .filter {
                !$0.lastPathComponent.hasPrefix(".")
                    && LessonPackageKind(fileExtension: $0.pathExtension) != nil
                    && (try? $0.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true
            }
            .sorted {
                $0.lastPathComponent.localizedStandardCompare($1.lastPathComponent) == .orderedAscending
            }
    }

    // MARK: - Helpers

    private func createCourseDirectories(_ courseDir: URL) throws {
        let fileManager = FileManager.default
        for subdirectory in ["", "assets", "assets/img", "assets/icons", "assets/locker_docs", "_backup"] {
            let url = subdirectory.isEmpty
                ? courseDir
                : courseDir.appendingPathComponent(subdirectory, isDirectory: true)
            try fileManager.createDirectory(at: url, withIntermediateDirectories: true)
        }
    }

    private func isInside(_ url: URL, _ directory: URL) -> Bool {
        let path = url.standardizedFileURL.path
        let base = directory.standardizedFileURL.path
        return path == base || path.hasPrefix(base + "/")
    }

    private static func uniqueStrings(_ values: [String]) -> [String] {
        var output: [String] = []
        for value in values where !output.contains(value) {
            output.append(value)
        }
        return output
    }
}

private extension String {
    var nilIfEmpty: String? {
        isEmpty ? nil : self
    }
}
