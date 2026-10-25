import Foundation

public struct LessonContentPresence: Equatable, Sendable {
    public var hasFull: Bool
    public var hasSummary: Bool
    public var hasCheatsheet: Bool
    public var hasTest: Bool

    public init(hasFull: Bool = false, hasSummary: Bool = false, hasCheatsheet: Bool = false, hasTest: Bool = false) {
        self.hasFull = hasFull
        self.hasSummary = hasSummary
        self.hasCheatsheet = hasCheatsheet
        self.hasTest = hasTest
    }

    public var hasAny: Bool {
        hasFull || hasSummary || hasCheatsheet || hasTest
    }
}

public struct ManifestMergeResult: Equatable, Sendable {
    public var manifest: CourseManifest
    public var addedLessonIDs: [String]
    /// Imported lessons that arrived without any content file; they are
    /// retained in the manifest with all presence flags false.
    public var missingLessonIDs: [String]
    /// Imported lessons whose IDs failed validation or duplicated another
    /// lesson. They are removed from navigation and written to `_conflicts/`.
    public var invalidLessons: [CourseLesson]
}

/// `meta.json` merge policy (PLAN §4.1):
/// local metadata wins; units and lessons are unioned; units never shrink;
/// a new lesson without content is kept but marked missing.
public enum ManifestMerger {
    public static func merge(
        local: CourseManifest?,
        imported: CourseManifest,
        stagedContent: [String: LessonContentPresence]
    ) -> ManifestMergeResult {
        var invalidLessons: [CourseLesson] = []
        let imported = sanitized(imported, invalidLessons: &invalidLessons)

        guard var result = local else {
            var manifest = imported
            var missing: [String] = []
            manifest.units = imported.units.map { unit in
                var unit = unit
                unit.lessons = unit.lessons.map { lesson in
                    var lesson = lesson
                    if let presence = stagedContent[lesson.id] {
                        lesson.hasFull = presence.hasFull
                        lesson.hasSummary = presence.hasSummary
                        lesson.hasCheatsheet = presence.hasCheatsheet
                        lesson.hasTest = presence.hasTest
                    } else {
                        lesson.hasFull = false
                        lesson.hasSummary = false
                        lesson.hasCheatsheet = false
                        lesson.hasTest = false
                        missing.append(lesson.id)
                    }
                    return lesson
                }
                return unit
            }
            // A manifest with no units is never written over existing data;
            // for a brand-new course it is still valid (empty course shell).
            return ManifestMergeResult(
                manifest: manifest,
                addedLessonIDs: manifest.allLessons.map(\.id),
                missingLessonIDs: missing,
                invalidLessons: invalidLessons
            )
        }

        guard !imported.units.isEmpty else {
            return ManifestMergeResult(
                manifest: result,
                addedLessonIDs: [],
                missingLessonIDs: [],
                invalidLessons: invalidLessons
            )
        }

        var added: [String] = []
        var missing: [String] = []
        var units = result.units

        for importedUnit in imported.units {
            if let index = units.firstIndex(where: { $0.number == importedUnit.number }) {
                var lessons = units[index].lessons
                for importedLesson in importedUnit.lessons {
                    if let lessonIndex = lessons.firstIndex(where: {
                        $0.id.lowercased() == importedLesson.id.lowercased()
                    }) {
                        // Local lesson wins; presence flags only grow when the
                        // archive actually contributed a new file.
                        if let presence = stagedContent[importedLesson.id] {
                            lessons[lessonIndex].hasFull = lessons[lessonIndex].hasFull || presence.hasFull
                            lessons[lessonIndex].hasSummary = lessons[lessonIndex].hasSummary || presence.hasSummary
                            lessons[lessonIndex].hasCheatsheet = lessons[lessonIndex].hasCheatsheet || presence.hasCheatsheet
                            lessons[lessonIndex].hasTest = lessons[lessonIndex].hasTest || presence.hasTest
                        }
                        continue
                    }
                    var lesson = importedLesson
                    if let presence = stagedContent[lesson.id], presence.hasAny {
                        lesson.hasFull = presence.hasFull
                        lesson.hasSummary = presence.hasSummary
                        lesson.hasCheatsheet = presence.hasCheatsheet
                        lesson.hasTest = presence.hasTest
                    } else {
                        lesson.hasFull = false
                        lesson.hasSummary = false
                        lesson.hasCheatsheet = false
                        lesson.hasTest = false
                        missing.append(lesson.id)
                    }
                    lessons.append(lesson)
                    added.append(lesson.id)
                }
                units[index].lessons = lessons
            } else {
                var unit = importedUnit
                unit.lessons = importedUnit.lessons.map { lesson in
                    var lesson = lesson
                    if let presence = stagedContent[lesson.id], presence.hasAny {
                        lesson.hasFull = presence.hasFull
                        lesson.hasSummary = presence.hasSummary
                        lesson.hasCheatsheet = presence.hasCheatsheet
                        lesson.hasTest = presence.hasTest
                    } else {
                        lesson.hasFull = false
                        lesson.hasSummary = false
                        lesson.hasCheatsheet = false
                        lesson.hasTest = false
                        missing.append(lesson.id)
                    }
                    return lesson
                }
                for lesson in unit.lessons { added.append(lesson.id) }
                units.append(unit)
            }
        }

        units.sort { $0.number < $1.number }
        result.units = units
        return ManifestMergeResult(
            manifest: result,
            addedLessonIDs: added,
            missingLessonIDs: missing,
            invalidLessons: invalidLessons
        )
    }

    /// Validates imported lesson IDs against the desktop identifier rules and
    /// removes duplicates. Unit numbers come from the containing unit; a
    /// missing lesson number is derived from the `NN.NN` ID.
    private static func sanitized(
        _ imported: CourseManifest,
        invalidLessons: inout [CourseLesson]
    ) -> CourseManifest {
        var manifest = imported
        var seen = Set<String>()
        manifest.units = imported.units.map { unit in
            var unit = unit
            var lessons: [CourseLesson] = []
            for lesson in unit.lessons {
                guard (try? PathValidator.lessonId(lesson.id)) != nil else {
                    invalidLessons.append(lesson)
                    continue
                }
                let key = lesson.id.lowercased()
                guard seen.insert(key).inserted else {
                    invalidLessons.append(lesson)
                    continue
                }
                var copy = lesson
                copy.unitNumber = unit.number
                if copy.lessonNumber <= 0 {
                    copy.lessonNumber = derivedLessonNumber(copy.id)
                }
                lessons.append(copy)
            }
            unit.lessons = lessons
            return unit
        }
        return manifest
    }

    private static func derivedLessonNumber(_ lessonID: String) -> Int {
        let parts = lessonID.split(separator: ".")
        guard parts.count >= 2, let number = Int(parts[1]) else { return 0 }
        return number
    }
}

public struct CheckpointMergeResult: Equatable, Sendable {
    public var document: CheckpointDocument
    /// Imported note checkpoints whose text differs from the local note; the
    /// importer writes them to `_conflicts/` rather than discarding them.
    public var noteConflicts: [Checkpoint]
}

/// Checkpoint merge policy: one position per file (local wins), notes union by
/// ID (local wins), differing imported notes go to `_conflicts/`.
public enum CheckpointMerger {
    public static func merge(local: CheckpointDocument, imported: CheckpointDocument) -> CheckpointMergeResult {
        var result = local
        var conflicts: [Checkpoint] = []

        for checkpoint in imported.checkpoints {
            switch checkpoint.type {
            case .position:
                let hasLocalPosition = result.checkpoints.contains {
                    $0.type == .position && $0.file == checkpoint.file
                }
                if !hasLocalPosition {
                    result.checkpoints.append(checkpoint)
                }
            default:
                if let index = result.checkpoints.firstIndex(where: { $0.id == checkpoint.id }) {
                    if result.checkpoints[index].type == .note,
                       (result.checkpoints[index].noteText ?? "") != (checkpoint.noteText ?? "") {
                        conflicts.append(checkpoint)
                    }
                } else {
                    result.checkpoints.append(checkpoint)
                }
            }
        }

        for value in imported.passthrough where !result.passthrough.contains(value) {
            result.passthrough.append(value)
        }
        return CheckpointMergeResult(document: result, noteConflicts: conflicts)
    }
}

/// LLM cards merge by card ID, then by normalized endpoint. Local cards win;
/// imported cards only fill gaps. Imported cards never carry a plaintext key
/// (the importer already migrated it to the secret store).
public enum LlmStoreMerger {
    public static func merge(local: LlmStore?, imported: LlmStore) -> LlmStore {
        guard var result = local, !result.cards.isEmpty else {
            var copy = imported
            for index in copy.cards.indices { copy.cards[index].apiKey = "" }
            return copy
        }
        result.activeId = result.activeId ?? imported.activeId

        for card in imported.cards {
            if result.cards.contains(where: { $0.id == card.id }) { continue }
            let endpoint = KeyMigrator.normalizedBaseURL(card.baseUrl)
            if result.cards.contains(where: {
                KeyMigrator.normalizedBaseURL($0.baseUrl) == endpoint
            }) { continue }
            var copy = card
            copy.apiKey = ""
            result.cards.append(copy)
        }
        if !result.cards.contains(where: { $0.id == result.activeId }) {
            result.activeId = result.cards.first?.id
        }
        return result
    }
}
