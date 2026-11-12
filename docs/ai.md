# AI generation policy and queue implementation plan

Status: proposed implementation plan, based on repository inspection on
2026-11-12. This document changes no runtime behavior. It is the handoff for the
LLM implementing the new generation policy, Markdown-only lesson context, and
queue controls.

## 1. Required behavior

Course Builder's study-material option and **Generate Missing (COURSE-ID)** must
use the same server-owned plan:

1. Generate one **Summary** for each instructional lesson, from that lesson's
   Markdown source (prefer its companion when available).
2. Generate one **Unit Test** covering the lessons of each unit. Place it after
   the unit's lessons in navigation and after their summaries in the submitted
   generation batch.
3. Do not generate lesson cheatsheets, study sheets, AI notes under those aliases,
   or per-lesson tests. Do not add course-wide documents or assignments to this
   automatic batch.

“At the end of a unit” means placement and generation order, not waiting until
the student completes the unit. Unit tests can be prepared with the course.
Use the manifest's curriculum order, not alphabetical sorting of lesson IDs.
Assignment entries are not instructional lessons: do not create separate summary
tasks for them. Report excluded or empty entries instead of silently inventing
source content.

Whenever an AI operation includes an existing lesson, its reference must come
from the lesson's Markdown representation. Never load its original HTML, iframe
DOM, PDF bytes, rendered page images, or full textbook as an automatic fallback.
The selected passage and user question remain separate inputs to Ask AI.

Keep user-written notes, checkpoint notes, existing documents, original lesson
assets, and assessment attempts intact. Changing generation policy does not
authorize deleting stored files. Existing explicit schedule/course-document and
custom-prompt workflows are outside the automatic batch; they must still obey
the Markdown rule whenever they attach lesson content. Do not build migration
machinery or translate obsolete generation requests into different artifacts.

## 2. Current code and gaps

Paths below are relative to the repository root. Function names are more stable
than line numbers; inspect current changes before editing these files.

| Area | Current implementation | Required change |
| --- | --- | --- |
| Builder archive import | `app/src/routes/builder/+page.svelte` submits `/api/queue` with `['summary', 'notes', 'test']` after parsing. | Request the shared course study-material plan after source files are available. |
| Builder manual/proposed course | Same page sends `queueStudyMaterials` to `POST /api/courses`; `app/src/lib/server/api.ts` calls `enqueueCourseMissing` with the same three lesson tabs. | Use the identical planner; preserve the user's opt-in checkbox and report enqueue failures separately from successful course creation. |
| AI dropdown | `app/src/lib/components/AIQueuePopover.svelte::enqueueMissing` sends the three-tab array. | Send course identity and the named generation action, not a second policy definition. |
| Course menu | `queueAllMissing` in the course reader route repeats the three-tab request and outdated tooltip. | Same action and accurate Summary + Unit Test messaging. |
| Chapter replacement | `app/src/lib/components/UploadModal.svelte` queues summary/notes/test for the replaced lesson. | Regenerate its summary only; mark its unit test stale or offer explicit unit-test regeneration. Do not silently overwrite an existing unit test. |
| Queue defaults | `app/src/lib/server/queue.ts::enqueueCourseMissing` defaults to summary + notes, loops every lesson/tab, and never adds unit tests. | Replace this lesson-tab scanner with the shared curriculum planner. |
| Queue API | `api.ts` defines `DEFAULT_LESSON_TABS`, `BULK_SUPPORTED_TABS`, and normalizes cheatsheet/studysheet into notes; single-tab enqueue accepts custom tabs. | Scope-aware generation validation at the queue boundary, shared by every producer. |
| Ingest stubs | `app/src/lib/parser/courseIngest.ts` writes summary, notes, and lesson-test placeholders. | Stop creating generated notes/test stubs. Retain summary placeholder semantics or use an explicit missing state. |
| Unit support | `tabs.ts` has `formatUnitScopeId` and `unitDocFileName`; the worker already selects `unit_test`; maintenance can enqueue unit tests. | Reuse these contracts rather than inventing unit IDs or a second test format. |
| Unit navigation | `LessonSelector.svelte` already puts “Unit Test / Assignment” after the lessons. | Preserve placement; make the Test destination obvious and ensure generated tests appear without refresh/navigation mistakes. |
| Server lesson source | `CourseService.getLessonContent/getLessonBundle` in `server/courses.ts` returns companion Markdown for original HTML/PDF, ordinary Markdown otherwise. | Reuse and strengthen this behavior; do not claim it currently sends raw HTML/PDF. Expose source provenance and use a consistent companion-first rule. |
| Context aggregation | `CourseService.getPromptContext` joins lesson bundles. Unit selection defaults to the first unit if it cannot resolve the requested one; missing lesson bodies are skipped. | Resolve the exact unit, reject invalid scope, and report missing input rather than silently generating an incomplete test. |
| Context override | Queue worker `customContent` bypasses normal source selection; `PromptCard.svelte` exposes attachment/context choices. | Separate custom instructions from canonical lesson reference. Summary/unit-test context must not be replaced by arbitrary raw document content. |
| Ask AI | Reader `currentReferenceMarkdown`, `handleAskAiSubmit`, `runCheckpointAi`, and `handleRetryCheckpointAi` use tab/bundle content with fallbacks. | Use the canonical source resolver for initial requests and retries, independent of displayed tab or original/companion mode. |
| Local source | `storage/clientStore.ts::getLessonBundleLocally` uses native bundle support, then an IndexedDB regex scan. That scan does not correctly identify `<id>.lesson.companion.md` as the lesson. | Fix companion selection and add provenance consistently in server, native, and IndexedDB adapters. |
| Queue display | Server `getStatus()` returns `filtered.slice(-50).reverse()`; popover applies `.slice(0, 20)`. | Return/display every active and pending task in submission order. |
| Queue operations | Pause/resume, pending cancellation, retry already exist. No individual remove action; UI mutation handlers do not check HTTP success. | Add per-task removal, explicit clear semantics, consistent errors, and refreshed authoritative state. |
| Queue ordering | Worker traverses a Map in insertion order; completed IDs are reused, and retry changes status in place. | Give every accepted run a unique identity and monotonic submission sequence, separate from deduplication. |

## 3. One generation planner and policy

Add a small shared policy module, for example `app/src/lib/ai/generationPolicy.ts`,
and a server planning function beside the queue. Avoid duplicating tab arrays in
components. Keep source resolution separate from planning.

Suggested public operation:

```json
{ "action": "generate_missing", "courseId": "example" }
```

Suggested planner contract:

```ts
planCourseStudyMaterials(courseId): {
  tasks: GenerationTaskInput[];
  skipped: Array<{ target: string; reason: string }>;
  unavailable: Array<{ target: string; lessonIds: string[]; reason: string }>;
}
```

For each unit in manifest order:

```text
missing lesson A summary
missing lesson B summary
missing unit test
then the next unit...
```

Concrete targets:

| Artifact | Scope/tab | Output | Prompt | Reference |
| --- | --- | --- | --- | --- |
| Lesson summary | actual lesson ID / `summary` | `<lessonId>.summary.md` | `summary` | That lesson's canonical Markdown |
| Unit test | `formatUnitScopeId(unit.number)` / `test` | `<NN>.unit.test.md` | `unit_test` | All instructional lesson Markdown in that unit, with lesson headings |

Use the real lesson IDs, including the repository's dot/dash variants. Do not
derive filenames or unit membership by ad-hoc splitting. Validate units against
the manifest. Empty units have no test task.

“Missing” means absent, blank body, or an application placeholder—not simply
below a character-count threshold. Current `hasLessonTabContent` checks the
canonical file, length >250, and a placeholder string, despite a queue comment
claiming version-aware detection. Unify presence detection for supported output
versions and unit documents. A legitimate short hand-written summary must not
be overwritten. Make current-generation output metadata explicit going forward.

Do not overwrite valid artifacts through Generate Missing. Explicit Regenerate
remains distinct. Deduplicate active/pending work by course + scope + normalized
output target; return counts/reasons for existing and already queued targets.
Concurrent clicks from two clients must not create duplicate work.

Unit tests use original lesson Markdown, not generated summaries, so a failed
summary does not invalidate their input. Missing required lesson Markdown does:
report the affected lesson IDs, skip that unit test in preflight, and recheck
at execution to catch later changes. Enqueue other eligible tasks. Do not emit a
test that silently omits half the unit.

Enforce the policy in `GenerationQueue.enqueue` as well as HTTP validation,
because maintenance and MCP call the queue directly. Reject lesson `test`,
cheatsheet/studysheet/AI-notes generation and their versioned target variants
with a clear error; do not redirect a requested lesson test into a unit test.
Scope-aware validation must preserve unit `test` and explicit course `test`.

### Other producers that must be updated

- `PromptsManager.svelte`, `ReparsePromptsModal.svelte`, and
  `/api/maintenance/reparse-prompts`: remove lesson-notes/cheatsheet generation
  categories and aliases. Reuse the same ordering/policy for summary + unit-test
  regeneration; keep its explicit overwrite intent separate from missing scans.
- Reader `triggerAIGeneration`, generated-tab menus, and `PromptCard`: hide or
  disable unsupported lesson generation and expose the correct unit-test prompt.
  Existing notes can remain editable; Notes must not serve as a renamed automatic
  cheatsheet generator. Do not broadly delete custom-tab functionality.
- `server/mcp/tools.ts`: update `get_lesson_doc(generateIfMissing)` and its schema,
  descriptions, and any direct generation branches. Reading existing notes/tests
  may remain supported, but a read must not trigger prohibited generation.
  Route supported summary/unit-test creation through the common queue policy.
- Audit the lesson Pop Quiz route and `/api/pop-quiz/generate`, including its local
  `generateDirect` fallback. They are a separate per-lesson assessment path.
  Under the requested “no tests for each lesson” policy, disable new lesson quiz
  generation and entry points; preserve existing attempts/results. Do not quietly
  keep this as a bypass under another label.
- Audit schedule links and defaults for references to removed generated lesson
  artifacts. Keep scheduling itself; do not generate lesson tests to satisfy an
  obsolete schedule link.

## 4. Canonical Markdown reference for every lesson AI call

Introduce a shared contract with environment-specific readers:

```ts
type LessonAiSource = {
  courseId: string;
  lessonId: string;
  sourceFile: string; // always a Markdown filename
  sourceKind: 'companion' | 'lesson-markdown';
  markdown: string;  // cleaned instructional body
};
```

Selection order is deterministic:

1. Use a nonempty `<lessonId>.lesson.companion.md` when available.
2. Otherwise use a nonempty `<lessonId>.lesson.md` that is actual instructional
   content, not a stub/link telling the reader to open an original document.
3. If neither is usable, return a typed `LESSON_MARKDOWN_UNAVAILABLE` error naming
   the lesson. Do not retrieve HTML/PDF, scrape the viewer, substitute a summary,
   or quietly use the active tab. Ask the user to prepare/repair the companion.

“Shorter Markdown” means the compact Markdown representation, not selecting an
arbitrary shortest file or truncating to a few characters. Strip frontmatter,
application anchor metadata, and inaccessible media using shared, tested helpers:
`parseFrontmatter`, `stripMarkdownAnchorMetadata`, and `stripLessonMedia`.
Preserve instructional text, math, tables, and code; blanket HTML-tag regex
removal can damage examples. No base64 media or raw document attachments should
reach the model through lesson reference fields.

For long lessons/units, estimate the configured context budget. If it cannot fit,
fail with an actionable context-size error; do not silently omit lessons or
replace the input with full HTML/PDF. A future chunking strategy requires its own
explicit coverage design. Do not reuse `budgetLessonContent` truncation as an
undocumented fallback for unit tests.

### Where to apply it

1. **Server:** add a dedicated AI source resolver in/alongside
   `app/src/lib/server/courses.ts`. Use it for queue execution, lesson/unit/course
   lesson-context aggregation, prompt-context previews, and other lesson-aware
   server AI operations. Update the forwarding service wrapper if needed. Return
   the resolved filename/kind, so call sites can prove where input came from.
2. **Native:** align `tauri/src/course_files.rs` and
   `tauri/src/courses_fs.rs::get_lesson_bundle` (registered in `tauri/src/lib.rs`)
   with the same selection contract. Use portable path joins/validation. No
   POSIX-only paths or browser filesystem access.
3. **Local client:** fix `getLessonBundleLocally` in
   `app/src/lib/storage/clientStore.ts` to resolve exact companion/lesson keys in
   IndexedDB. Propagate provenance through `app/src/lib/api.ts` local responses.
   Prefer a dedicated AI-source operation if changing reader bundles would alter
   presentation semantics; all implementations must pass the same fixtures.
4. **Queue custom context:** summary/unit-test tasks carry source identity and
   instructions, not arbitrary `customContent` as their canonical reference.
   Resolve authoritative Markdown at processing time. Prompt overrides remain
   allowed; they must not change the source policy. Preview uses the same resolver.
5. **Ask AI:** replace `currentReferenceMarkdown` and retry fallback logic in the course
   reader route. Snapshot course/lesson identity when opening the composer; load
   the source for that snapshot, not whichever route is active after an await.
   `runCheckpointAi` receives resolved Markdown plus the captured quote and
   question. Preserve the configured `checkpoint_ask` prompt and
   `buildCheckpointAskUserPrompt` formatting. Update “full lesson” comments to mean
   the complete cleaned Markdown reference.
6. **Ask AI retry:** resolve the checkpoint's lesson identity again; never fall
   back to the current tab or a different lesson. On unavailable Markdown, retain
   the question and show a retryable error. Source failure must not make an empty
   or unrelated model request.
7. **Other entry points:** audit `server/mcp/tools.ts` lesson-context calls,
   `/api/courses/:id/prompt-context`, course-document aggregation, and direct
   `/api/llm` callers. Centralize application lesson-context assembly before
   `generateResult`/`generateDirect`; a generic LLM transport cannot infer the
   source provenance of an arbitrary string. Add payload tests at these boundaries.

An HTML selection can still supply its plain-text quote even when formatting
differs from companion Markdown. Keep that quote explicitly labelled as the
selected passage. Do not require matching anchor IDs across HTML and Markdown:
the checkpoint stays attached to its original file, while AI reference comes
from the companion. This preserves [annotations.md](annotations.md)'s file-local
annotation decision.

Builder curriculum proposal and starter-lesson authoring happen before persisted
lesson files exist. Preserve their purpose. Uploaded HTML/PDF can be converted
locally/on the server into a Markdown companion before model submission; the
raw file may reach the application's extractor, never the LLM. The current
`/api/builder/propose` already accepts companion Markdown and otherwise extracts
text; converge this preparation with [builder-improvements.md](builder-improvements.md)
without re-extracting an existing companion on every request. This is distinct
from falling back to original documents for an existing lesson AI call.

## 5. Queue ordering, identity, and operations

### State model

Keep the existing single sequential backend worker. Separate a **run ID** from
the **deduplication key**:

```ts
type QueueTaskIdentity = {
  id: string;        // unique accepted run
  dedupKey: string;  // course + scope + target
  sequence: number;  // monotonic within the queue instance
  createdAt: string;
};
```

The worker and UI both order by ascending `sequence`. Timestamps alone are not
enough for simultaneous submissions. Retries and explicit regenerations are new
submissions appended to the tail with a new run ID; they do not jump ahead using
an old Map position. Preserve their previous run as history. Duplicate active or
pending requests return the existing run instead of modifying its prompt/order.

Return all processing/pending tasks, without the server's 50-item truncation or
the UI's 20-item slice. Keep a bounded, separate recent history for completed,
failed, and cancelled runs. That history must not crowd waiting work out of the
response. At expected course sizes a scrollable full list is simplest; introduce
virtualization only if profiling requires it. Every task must remain accessible.

Remove large `customContent`/prompt bodies and schedule debug payloads from normal
queue list DTOs; use a detail view if needed. Move public queue types to a
browser-safe shared module rather than making UI types depend on server internals.

### Precise control semantics

| Control | Behavior |
| --- | --- |
| Row `[x]` / “Remove queued item” | Cancel one pending run. It will never execute. Show an accessible target-specific label and refresh from the server response. |
| Clear queue | Cancel all pending runs in the displayed queue scope. Keep generated files, history, and the active request. Label the scope and say the running item will finish. |
| Pause | Set queue paused immediately; finish the active request, but start no next item. Enqueues while paused append without resuming. |
| Resume | Continue from the earliest pending sequence, starting at most one worker. |
| Retry | Append failed work as fresh runs in a deterministic order, respecting policy and deduplication. |

The default display and controls operate on the **global** queue across courses,
matching the existing worker and poller. Generate Missing remains course-specific.
If adding a course filter, distinguish “Clear this course's waiting items” from
global pause/clear; never show global counts beside silently course-scoped actions.

Do not offer `[x]` as an implied abort for the running item. Actual active-request
cancellation would require external AbortSignal propagation through provider
retries, plus a guard before document save; it is a separate enhancement. Existing
LLM timeout AbortControllers are not a complete queue cancellation API.

Suggested `/api/queue` actions:

```text
generate_missing { courseId }
enqueue          { courseId, lessonId, tab, ... }  // explicit supported task
remove           { taskId }
clear            { courseId? }                   // pending only
pause
resume
retry            { taskId? or courseId? }
```

Validate every action. Unknown task: 404. Task already running or terminal when
Remove arrives: 409 with current state (or an explicit already-cancelled success
for an idempotent repeat). Never report success while a supposedly removed task
continues running. Perform removal and pending-to-processing claims without an
interleaving await. A clear request reports how many waiting tasks were cancelled.

Synchronize every transition with `JobService`: today `cancelAll` deletes Map
entries without cancelling their durable jobs. `JobService.cancelJob` changes job
metadata, but that alone does not remove work from `GenerationQueue`. Route
queue-backed cancellation through one owner so a cancelled job cannot still
generate a document. Use unique run IDs for job IDs and retain separate dedup
keys. Update `server/mcp/tools.ts::get_task_status` and all job-status consumers
when changing the identity contract; do not assume a separate cancellation API
already wires these two systems together.

### Client updates

- `AIQueuePopover.svelte`: render the complete ordered waiting list, include course,
  lesson/unit title, artifact, position, and state; add row remove controls and a
  clearly labelled Clear queue button. Keep Pause available when there is waiting
  work and Resume visible when paused. Allow Generate Missing while other work
  exists; deduplication handles repeated requests.
- Check `res.ok` for every action, disable only controls affected by an in-flight
  mutation, and show errors inline. Do not clear local rows or claim success on
  an HTTP error. Use adequate touch targets and keyboard-accessible buttons.
- `queueStatus.svelte.ts`: maintain one poller. Consume ordered active tasks plus
  recent terminal runs. Deduplicate completion notifications by unique run ID.
  Removing a run must not trigger the generated-document refresh path.
- Reader busy indicators and `onTaskFinished` consumers currently examine
  `status.tasks`; update all of them with the new shape. Completion must still
  refresh a summary/unit test even after more than 50 later submissions.
- Keep offline/unreachable status honest. No UI-only shadow queue that claims
  backend work was paused/removed while the backend was unreachable.

The current queue lives in backend memory; `JobService` persists metadata and
marks interrupted jobs after restart. Durable queue resumption is not part of
this request. State that limitation; do not add a second competing scheduler or
claim paused/pending work survives restart. Verify queue transport availability
on packaged desktop and mobile through `apiFetch`; its local direct-LLM support
does not imply a local `/api/queue` worker exists.

## 6. Implementation order

1. Add shared generation policy, task identity/status DTOs, and canonical source
   contract. Write focused tests for policy, source selection, and missing inputs.
2. Implement server/native/IndexedDB source adapters and use them in Ask AI,
   retries, queue execution, and context previews. Preserve reader asset delivery.
3. Implement the ordered missing-material planner and integrate all builder/menu/
   replacement/maintenance/MCP producers. Remove obsolete generated stubs and
   forbidden-generation affordances. Update prompt selection and test placement.
4. Implement unique run sequencing, removal/clear/pause semantics, and consistent
   job state. Preserve the single-worker invariant and current timeout protections.
5. Update the shared poller, popover, and all task-status consumers. Verify mobile
   layout, error states, and busy/completion refreshes.
6. Run acceptance tests and update this document with actual implementation and
   verified platforms. Keep unrelated existing workspace changes intact.

## 7. Acceptance tests

Use synthetic course fixtures; access real course data only through the
`coursedeck` MCP tools required by `AGENTS.md`. Mock provider calls so tests do not
spend tokens or alter real courses.

| Test group | Required assertions |
| --- | --- |
| Planner | Two units with two lessons each produce exactly four summaries and two unit tests, ordered S1, S2, T1, S3, S4, T2. No generated notes/cheatsheets/lesson tests; no assignment-summary task. |
| Missing detection | Existing short valid documents and supported versions are retained; blank/stub documents are eligible. Repeat/concurrent submissions deduplicate. Missing source reports affected lessons and does not silently reduce unit coverage. |
| Entry-point parity | Builder archive and manual/proposal paths, AI dropdown, course menu, replacement, maintenance, and MCP follow the same policy. Direct lesson-test/alias requests are rejected. |
| Source priority | Put distinct sentinel text in HTML, PDF, companion, lesson Markdown, and summary fixtures. Captured provider requests contain the chosen Markdown sentinel and never original HTML/PDF/summary substitutes. Companion wins when both Markdown files exist. |
| Ask AI | Initial request and retry from original HTML, PDF-backed lesson, summary tab, and ordinary Markdown use the correct lesson Markdown plus quote/question/custom prompt. Navigation during awaits cannot change source identity. Missing Markdown makes no provider call. |
| Local parity | Native and IndexedDB companion-only fixtures resolve identically to the server, including source filename/kind. Missing source never fetches the original as fallback. |
| Unit test | Exact manifest unit membership, ordered lesson headings, proper `unit_test` prompt and `<NN>.unit.test.md` path. Invalid unit never falls back to unit one. Existing quiz parsing/grading/submission still works. |
| Queue visibility | Enqueue at least 75 tasks across courses; every waiting task is available in FIFO order with correct counts. Terminal history cannot hide pending items. |
| Queue controls | Remove first/middle/last pending item; clear while active; pause during active; enqueue while paused; rapid pause/resume; simultaneous remove/start; double-click actions; failed HTTP requests. No duplicate workers or falsely successful removals. |
| Retry/order | Retrying an old failed target and regenerating a completed target append after existing waiting work. Duplicate pending targets do not reorder. Job status, queue status, and document refresh agree. |
| Platforms | Browser and packaged transports, Windows/Linux Ctrl shortcuts and macOS Cmd conventions where relevant, mobile touch targets, offline status, and reconnect. Record real-device coverage separately from emulation. |

Extend existing suites: `app/src/lib/server/queue.test.ts`,
`api.builder.test.ts`, `api.reparse-prompts.test.ts`, `api.unit-test.test.ts`,
`courses.tabs.test.ts`, `app/src/lib/api.routing.test.ts`,
`app/src/lib/checkpoint/askPrompt.test.ts`, and `server/mcp/mcp.test.ts`.
Add resolver/planner tests and a focused queue UI browser fixture. Update
`scripts/api-contract.ts` when changing public queue/job contracts. Run app and
server type checks; do not present mocked browser tests as native-device proof.

Done means the automatic batch produces only lesson summaries and end-of-unit
tests, every existing-lesson AI reference is provably Markdown, and the full
ordered queue can be inspected, individually reduced, cleared, paused, and resumed
with truthful server state. This document is the plan; implementation and those
checks remain pending.
