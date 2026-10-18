# Technical Revision Guidance for Gemini: CourseDeck API, MCP, and Calendar Sync

**Project:** ilc-study-tool / CourseDeck  
**Prepared:** October 17, 2026  
**Audience:** Gemini, revising the architecture and implementation plan  
**Document to revise:** [api-mcp-plan.md](api-mcp-plan.md)  
**Original requirements:** [api-mcp.md](api-mcp.md)  
**Assessment:** Good architectural direction; substantive revisions required before implementation.

## 1. Assignment and expected output

Revise docs/api-mcp-plan.md into an implementation-ready plan using the findings and requirements below. This is a planning assignment. Do not begin a broad code refactor merely to resolve omissions in the document.

Preserve the useful decisions in Revision 2:

- Shared headless services used by both REST controllers and MCP tools.
- Hono as a reasonable Fetch-compatible router.
- Fiberplane mcp-lite as the preferred MCP framework, subject to a compatibility spike.
- Reuse of the existing deterministic schedule generator.
- Preservation of existing REST behavior, including asset decoding, streaming responses, and error shapes.
- A bounded concurrency pool for calendar requests.

Replace the current “Approved for Implementation” status with an accurate revision/review status. The plan itself cannot grant user approval. Remove unsupported guarantees such as sub-2ms transport latency, schedules always completing in under 10ms, fixed client timeout limits, and calendar sync always completing in 2–3 seconds. Treat performance numbers as measurements to obtain with a defined dataset.

The revised plan must include:

1. Concrete architecture decisions and their consequences.
2. Exact input, output, error, and asynchronous-result contracts.
3. Persistence and process-lifecycle rules.
4. An incremental implementation sequence with acceptance gates.
5. A test matrix tied to the identified failure cases.
6. Explicit deferred scope and external prerequisites.

Do not retain “TBD” for release-blocking decisions while calling the plan implementation-ready. If an external dependency cannot be resolved, isolate the dependent feature and state what can ship without it.

## 2. Evidence from the current code

These observations were checked during the audit. Recheck symbols when revising because line numbers and working-tree changes may move.

| Area | Existing code | Implication |
| --- | --- | --- |
| Shared REST handler | app/src/lib/server/api.ts exports handleApiRequest; the SvelteKit catch-all and server/index.ts both call it | Preserve behavior while extracting services; avoid separate business implementations |
| Backend startup | server/index.ts binds 127.0.0.1, defaults to port 3182, logs to stdout, and exits successfully on EADDRINUSE | The current entrypoint cannot simply become a reliable stdio launcher |
| Backend shutdown | tauri/src/lib.rs kills its recorded backend child on application exit | Headless MCP access after GUI exit requires an explicit lifecycle change |
| CORS | server/index.ts omits CORS headers for unrecognized origins but still dispatches requests | CORS decoration is not request authorization or origin rejection |
| Course identifiers | paths.ts normalizes course IDs to lowercase for service access | Creation, conflict detection, locking, and sync identities must normalize consistently |
| Storage writes | courses.ts writes markdown and JSON directly through fs.writeFileSync | Concurrent access and interrupted multi-file operations need deliberate protection |
| Lesson metadata | parser/courseIngest.ts defines CourseManifest, CourseManifestUnit, and CourseManifestLesson | Injection must produce the complete existing manifest shape |
| Assignment IDs | CourseIngest generates IDs such as 01.06_assign1 | Injection must distinguish assignments from ordinary 01.06 lessons |
| Lesson generation jobs | queue.ts keeps GenerationTask objects in a process-local Map | Jobs are not shared across processes or durable across restarts |
| Course generation jobs | api.ts has a separate activeCourseDocJobs Map | A single polling tool needs a unified job abstraction |
| Arbitrary answers | GenerationTask has status/error/timing fields, but no general prompt-result payload | prompt_course cannot return its eventual answer through the current queue unchanged |
| Blackout dates | schedule.ts uses startDate, endDate, and optional label | The proposed start/end/reason schema is incompatible |
| Blackout processing | scheduleGenerator.ts skips ranges missing startDate or endDate | Passing the proposed fields unchanged silently ignores blackouts |
| Tab vocabulary | tabs.ts COURSE_TABS includes lesson, summary, cheatsheet, test, schedule | notes is a separate aggregate, not a member of that constant |
| Schedule persistence | queue.ts saves preferences and provenance frontmatter with type course_schedule | A new schedule service must preserve the format consumed by the UI and sync |
| Session identity | PlannedSession.sessionKey includes date, lesson ID, type, and sometimes section | Rebuilding a schedule can change remote-event identities; stale-event cleanup is essential |
| Session time | PlannedSession and parsed ScheduleEvent do not contain an explicit start time | Calendar sync needs an explicit projection from ordered sessions plus saved preferences |
| Backups | backup.ts recursively exports data files; optional raw archives are the principal exclusion | Putting sync_credentials.json under data includes it in normal backups unless changed |

### Validation baseline

The audit ran the existing unit suite: **249 passed, 0 failed**.

The server type check failed at app/src/lib/server/queue.test.ts:3 because its import of GenerationTask from $lib/types could not resolve. GenerationTask is currently exported from queue.ts. This is an observed existing working-tree issue, not a regression caused by this guidance document.

Do not conceal this failure by removing meaningful type-check coverage. Plan to correct the import or introduce an intentional shared type location.

The audit did not run the complete integration/PDF suite. Passing unit tests does not establish MCP compatibility.

## 3. Resolve backend ownership before adding transports

### Recommended decision: one authoritative backend

Use one backend process as the owner of a configured data directory, its mutation locks, its job registry, and external-sync operations. HTTP MCP and REST execute inside that owner. A stdio process acts as a protocol bridge/client of the owner; it must not import services and start a second generation queue.

This recommendation keeps the existing TypeScript domain code reusable and avoids introducing another storage implementation in Rust.

The revised topology should show:

~~~text
Desktop UI / development UI -- REST ---------+
                                            |
HTTP MCP clients ----------- MCP HTTP -------+--> Backend owner
                                            |    - domain services
Stdio client --> stdio bridge --> MCP HTTP --+    - job registry
                                                 - storage coordination
                                                 - sync providers
~~~

Document the following behavior precisely:

- How the backend is discovered and authenticated.
- How a launcher starts it when no compatible backend exists.
- How simultaneous launchers elect one owner without racing.
- How the owner prevents a second process from writing the same dataset.
- How the GUI attaches to an existing headless backend.
- What happens when the GUI closes with MCP clients or jobs still active.
- Whether an idle headless owner exits, and the conditions for doing so.
- How graceful shutdown stops admission, drains or aborts work, and records interrupted jobs.
- How an explicit shutdown differs from closing a GUI window.
- How custom DATA_DIR, ILC_SETTINGS_PATH, configured storage paths, and desktop launch working directories are resolved.

For the default single-profile release, make one installation endpoint own its active dataset. If another launch requests a conflicting dataset, fail clearly instead of silently attaching it to the wrong data. Multiple simultaneous profiles can be deferred unless the plan supplies separate discovery endpoints and locks.

### Discovery and ownership contract

A bound port is not proof that CourseDeck owns it. Add a small versioned health/identity contract with application identity, backend compatibility version, and opaque dataset identity. Do not expose secrets or absolute filesystem paths in an unauthenticated response.

Handle an unrelated process on port 3182 as a conflict. Do not treat EADDRINUSE as successful startup without verifying the expected server. Select a documented policy for fixed-port conflicts rather than scanning arbitrary ports.

Keep discovery credentials outside course data and backups. Use a persistent owner lock with an OS lock or another documented atomic ownership mechanism; a PID file by itself is insufficient because processes can die and PIDs can be reused.

### Development parity

The SvelteKit development server and Bun sidecar must not create independent job/storage owners against the same dataset. Define either:

1. Development UI API requests proxy to the same authoritative backend; or
2. A mutually exclusive development owner mode with the same service assembly.

Ensure /mcp has a real development route or is explicitly served only by the backend. The current /api catch-all does not automatically expose /mcp.

## 4. Make the stdio transport a defined deliverable

The current wording “feed JSON-RPC lines into mcpHandler(new Request(...)) and flush results” omits essential protocol work.

### Requirements

- Use a dedicated entrypoint, or parse the mode before any HTTP listener, queue initialization, or startup logging occurs.
- Keep stdout exclusively for newline-delimited JSON-RPC messages.
- Send all diagnostics to stderr, including diagnostics originating in imported modules.
- Preserve request IDs and handle overlapping requests without globally serializing behind a long tool call.
- Correctly forward initialization, notifications, cancellation, and protocol negotiation.
- Do not emit blank messages for accepted notifications or HTTP responses without bodies.
- Correctly consume JSON responses and SSE responses from the HTTP transport.
- Preserve session and negotiated-version headers when the selected HTTP mode requires them.
- Bound input size, buffered output, and backpressure; handle EOF and broken pipes cleanly.
- Define what happens to an accepted backend job when a bridge exits.
- Ensure an exit or reconnect does not silently reissue a mutating tools/call request.

Choose a tested bridge implementation where practical. mcp-lite's documented transport is Streamable HTTP; do not assume it exports a ready-made stdio transport. Verify the exact installed version and API surface before promising an implementation.

Provide working packaged configurations using an absolute executable path and arguments. End users must not need a repository checkout, a globally installed Bun, or bun run server/index.ts.

Treat client compatibility as a tested matrix by client/version. Do not assume every client supports identical HTTP configuration keys or timeout behavior.

## 5. Specify the MCP trust boundary

### HTTP access

Keep the listener on loopback and explicitly configure:

- Allowed Host values for the selected endpoint.
- An exact allowed-Origin policy. Invalid present Origin values must be rejected before dispatch.
- A local bearer credential or another concrete authentication mechanism for MCP requests.
- Behavior for native clients without Origin headers.
- Request-size and tool-input limits substantially smaller than the existing backup-upload limit.
- CORS headers needed by supported browser clients, including MCP protocol/session headers where applicable.

Origin validation and authentication serve different purposes. Do not use absence of CORS response headers as the enforcement mechanism.

The stdio bridge must obtain local authentication through the same private configuration mechanism as the owner. Keep credentials out of copied URLs, logs, course markdown, and ordinary backup artifacts.

Document how the trusted desktop UI authenticates any protected REST routes. Identify which routes are intentionally readable without credentials; destructive REST endpoints must not remain an alternate route around MCP protections.

### Tool exposure

Define which tools are read-only, which write local data, which invoke a configured LLM, and which write to external services. Include appropriate MCP annotations supported by the pinned framework. Annotations help clients present actions; they do not replace server-side validation.

An archive/delete tool must describe remote-calendar effects explicitly. A retrieval tool with generateIfMissing enabled is capable of writes and LLM requests; it cannot honestly be advertised as unconditionally read-only.

### Error policy

Preserve existing REST response compatibility where required, including the { message } shape. For new MCP and sync boundaries, redact credentials, authorization headers, token responses, and provider URLs containing secrets. Local operation is not a justification for exposing secrets.

## 6. Unify asynchronous work and result retrieval

### Job model

Introduce a shared service that owns accepted jobs across REST and MCP. Refactor both GenerationQueue and activeCourseDocJobs behind it rather than inventing a polling wrapper over incompatible stores.

Use explicit job kinds and states. A suitable conceptual contract is:

~~~typescript
type JobKind = 'generate_lesson_doc' | 'generate_course_doc' | 'prompt_course';
type JobState =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancel_requested'
  | 'cancelled'
  | 'interrupted';

interface JobRecord {
  id: string;
  kind: JobKind;
  courseId: string;
  state: JobState;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  progress?: { completed: number; total?: number };
  result?: JobResult;
  error?: { code: string; message: string; retryable: boolean };
}
~~~

Define JobResult as a discriminated union for saved document references and prompt answers. A prompt answer must not overwrite a course document simply because both use an LLM.

The contract must establish:

- Unique execution IDs, separate from logical deduplication keys.
- Deduplication for an already active generation request.
- Request identities that distinguish arbitrary prompts, selected lessons, and preferences.
- An idempotency-key policy for explicit client retries.
- What inputs/model selection are captured at admission versus resolved at execution.
- Persisted status transitions and answer/result storage.
- Result retention, expiry, and cleanup.
- Unknown job, expired result, cancellation, and interrupted-work responses.
- Course/dataset revision checks before a generated result is committed.

Use a simple atomic journal/result-file design if sufficient; adding a database is not mandatory. The revised plan must pick a persistence mechanism rather than merely naming a QueueService.

### Wait briefly, without starting another job

For a missing document:

1. Validate the course, lesson, requested artifact, and generation policy.
2. Reuse an existing artifact only if it meets the defined availability policy.
3. Find or create one job.
4. Optionally wait a bounded interval for that same job.
5. Return either its result or a job reference.

The wait deadline only stops waiting for a response. It must not cancel and restart generation or enqueue duplicate work. A provider request timeout, client disconnection, tool wait budget, and explicit job cancellation are distinct events.

Do not add an MCP “fast path” that bypasses the existing concurrency policy. Define a shared concurrency limit for GUI and MCP generation.

### Polling and cancellation tools

Specify get_task_status output exactly, including terminal failures and the location of the result. Add get_task_result if full answers do not fit the status response. Generated documents may instead be retrieved through get_lesson_doc using the returned document reference.

Add cancellation if supported, or explicitly state the initial limitation. Existing cancelAll removes pending tasks; it does not establish cancellation of an active provider call.

If using custom job tools, label them application-level jobs. Do not advertise native MCP task capabilities unless the pinned framework and implementation actually support that protocol.

## 7. Correct schemas and define document semantics

### Course creation and discovery

- Normalize the ID before existence checks, path construction, manifest creation, deduplication, and sync lookup.
- Reuse assertCourseId and normalizeCourseId; do not introduce divergent validation patterns.
- Use exclusive creation so two concurrent requests cannot both succeed.
- Seed the existing CourseManifest shape and preserve existing field conventions.
- Return stable identifiers and document availability without leaking server-only absolute paths.
- Add get_course or list_lessons to discover unit/lesson IDs, titles, types, and available tabs.

The current list_courses description returns counts; counts are insufficient for an agent to select a lesson. If returning a full manifest instead, specify that response and bound its size.

### Artifact scope matrix

Write an explicit matrix for allowed scope, aliases, source, and generation behavior.

| Requested artifact | Lesson scope | Course scope |
| --- | --- | --- |
| lesson / full | Stored lesson source | Define whether this maps to the existing full-course aggregate |
| summary | Stored/generated lesson summary | Stored/generated course summary |
| cheatsheet | Stored/generated lesson cheatsheet | Stored/generated course cheatsheet |
| test / practice-sheet | Stored/generated lesson test | Stored/generated course test |
| notes | Reject unless a specific lesson-notes source is defined | Existing aggregated-notes behavior |
| schedule | Reject at lesson scope | Read saved schedule; build through the deterministic schedule service |

The exact course-scope lesson/notes alias policy is a decision to write down after checking existing UI behavior. Do not infer it from COURSE_TABS alone.

Do not generate original lesson source when none exists. Define empty files and placeholder documents separately from generated content. Existing hasLessonTabContent uses a content heuristic; decide whether to preserve it or replace it with an explicit artifact-status policy.

The app supports custom lesson tab slugs. Either expose them through a validated discovery/retrieval contract or declare built-in-only MCP scope for the first release. Do not accidentally remove custom-tab support during REST extraction.

### Schedule input

Use the actual blackout shape:

~~~typescript
interface BlackoutDateRange {
  startDate: string;
  endDate: string;
  label?: string;
}
~~~

Create shared runtime validation aligned with SchedulePreferences. Enforce:

- Valid calendar dates, not merely strings matching a date regex.
- Nonempty, unique weekdays in the range 0–6.
- A required targetEndDate in target mode, with a valid relation to startDate.
- Valid and ordered blackout ranges with bounded counts/date spans.
- Day-time keys 0–6 and valid HH:MM values.
- A defined relation between sessionsPerDay and the number of supplied times.
- Explicit handling of missing times, duplicate times, overlapping sessions, and overnight durations.
- Limits on lesson counts, content bytes, prompt bytes, and batch sizes.

Represent JSON object keys correctly at the boundary and convert them deliberately to the internal weekday representation.

### Schedule output and save

ScheduleService.buildAndSaveSchedule must:

1. Load and validate the course and preferences.
2. Compute optional effort metrics through the existing course helpers.
3. Invoke buildScheduleSkeleton.
4. Preserve schedule markdown syntax and frontmatter preferences/provenance.
5. Validate structural output and report overflow warnings.
6. Persist atomically and return a saved revision plus bounded output.

The generator can schedule past a target date and emit overflowWarning. Return that warning rather than implying target dates are always feasible.

Do not describe free-form notes as hard scheduler constraints: the deterministic engine does not automatically understand natural language. Separate saved notes from constraints the algorithm actually enforces.

## 8. Define storage and mutation guarantees

### Concurrency and atomicity

Use per-course mutation coordination inside the backend owner. Coordinate injection, metadata edits, generated-result commits, schedule rebuilds, archive/delete, import, and storage-directory changes.

Use temporary files in the destination directory followed by atomic replacement where supported. Define the platform-specific replacement behavior. Atomic replacement protects one file; it does not make a multi-file injection transaction atomic.

For injection, choose and document either:

- Staged writes with a recoverable commit/journal protocol; or
- Explicit per-item partial success with a manifest-reconciliation procedure.

Validate the full batch before starting writes. Specify duplicate-ID handling, tab-level conflicts, metadata merge rules, and what happens when the manifest commit fails.

### Injection contract

Preserve assignment naming conventions and complete manifest fields, including code, type, unit/lesson numbers, and tab availability flags. Define how code is supplied or derived for manually injected lessons.

Default overwriteExisting to false unless there is an explicit product requirement for automatic replacement. Return created, updated, skipped, and failed items with stable IDs.

Do not silently replace unit titles or overwrite source lessons while injecting a derived tab. Clarify whether a derived-tab-only lesson can exist without source material.

### Filesystem boundaries

safeJoin currently establishes lexical containment. It does not prove that a symlinked ancestor resolves inside the intended data root. Define a symlink policy for mutation paths and recursive deletion, and implement appropriate checks. Reuse central path helpers rather than constructing paths in tool handlers.

### Deletion and archive

- Archive should preserve source material and distinguish cleanup status from local archival status.
- Permanent deletion should coordinate with running jobs and prevent later commits to a deleted or recreated course.
- A course recreated with the same slug must have a different incarnation/revision identity for stale-job checks.
- Persist calendar-cleanup intent and required remote identifiers before removing local metadata.
- Retain retryable cleanup records outside the directory being deleted.
- Define offline, revoked-authorization, and partial-cleanup results.
- Scope cleanup to CourseDeck-managed events for the matching dataset/course.

Archiving through the existing REST metadata endpoint must follow the same documented cleanup policy as archiving through MCP. Do not add different side effects for the same state change depending on transport.

Do not hold a course mutation lock across slow Google requests. Commit local state and a durable cleanup intent, then perform remote work through the sync service.

Coordinate storage-directory migration and backup import with active jobs. A result accepted against one dataset must not be written into a newly selected dataset.

## 9. Complete MCP contracts and context limits

### Structured results and errors

Define outputSchema and structuredContent where supported, with readable text content for compatibility. Use consistent responses for documents, course manifests, mutation summaries, and jobs.

Map known execution failures to MCP tool errors using isError and stable application codes. Keep malformed protocol/schema requests distinct from valid tool calls that fail. HTTP 409 is meaningful for REST; an MCP client needs an explicit conflict result/error contract.

Define codes such as COURSE_NOT_FOUND, LESSON_NOT_FOUND, CONFLICT, GENERATION_UNAVAILABLE, CONTEXT_TOO_LARGE, JOB_NOT_FOUND, and WRITE_FAILED. Reuse a shared domain-error taxonomy.

Do not stringify a returned { success: false } object and accidentally present it as a successful tool result.

### Output budgets

Budget every potentially large tool response, not just prompt_course inputs:

- Paginate course/lesson listings.
- Add bounded document reads or chunk/reference retrieval.
- Limit snippets and result counts in search.
- Bound prompt answers and job results.
- Include continuation information and explicit truncation metadata.

Search should operate on canonical content roots and approved document files, excluding temporary files and raw archive internals. Specify multi-term matching, empty-after-normalization queries, deterministic tie-breaking, and archived-course behavior.

### Prompt assembly

Keep an absolute character/byte ceiling as a resource safeguard, but distinguish it from a model context budget. A 120k-character payload is not universally safe.

Define a conservative effective budget from configured context capacity or a documented fallback, reserving room for the system prompt, user prompt, and answer. Character-to-token estimates must be labeled estimates.

For specific_lessons, require and validate lessonIds. Define fallback behavior when summaries are missing. Do not silently send the full course for a selective request.

Truncation must preserve source labels and indicate which lessons or sections were omitted. Prefer selecting useful bounded excerpts over proportional truncation that removes the explanation from every lesson.

Read and assemble content incrementally where practical; a post-hoc slice of an already huge aggregate does not bound memory or disk work.

## 10. Keep calendar synchronization a separate deliverable

MCP can ship before Google sync. Domain extraction must not depend on a completed external provider. ARC's API is explicitly unspecified in the requirements: define its interface and defer implementation until that contract exists.

### Provider interface

Specify operations and data types for connection status, target calendars, desired-event projection, reconciliation, cleanup, cancellation, progress, and per-event failures. Keep provider credentials out of domain event objects and logs.

Call the initial feature one-way publish/reconcile if local schedules are authoritative. Two-way synchronization is a separate scope requiring a conflict-resolution policy.

### OAuth and secret storage

Define desktop OAuth setup concretely:

- OAuth client type, client-ID provisioning, and production/testing distribution assumptions.
- Required least-privilege scopes for the selected calendar features.
- System-browser launch, PKCE verifier handling, random state validation, and loopback callback lifetime.
- Refresh-token acquisition and preservation when a refresh response omits a new refresh token.
- Serialized refresh handling, reconnect, disconnect, and revocation behavior.
- Secure token storage through an OS credential store or a documented private-file fallback with platform-appropriate access controls.
- Backup/export and logging exclusions.

Do not assume “one click Connect” works without a provisioned OAuth client and a consent/distribution strategy.

Report invalid_grant as authorization requiring reconnection. Do not always attribute it to the seven-day testing limit; revocation and other causes are possible.

### Event projection and identity

Persist an opaque dataset identity that survives intended backup/restore. Combine dataset identity, normalized course identity, and a defined session identity when generating managed event IDs.

Use a Google-compatible deterministic encoding, for example a lowercase hexadecimal hash. Do not pass the raw date/lesson/type sessionKey as a Google event ID.

Define whether schedule identities include a revision. Existing keys contain dates, so rescheduling can produce different IDs. Either retain a stable logical session identity or reconcile and delete obsolete date-based events.

Tag managed events with an application identifier, dataset identifier, course identifier, schema version, session identifier, and content hash. The content hash should cover the owned remote fields.

Course ID alone is not a sufficient namespace for destructive cleanup when multiple datasets can contain the same course code.

### Reconciliation algorithm

Specify a recoverable flow:

1. Validate authorization, target-calendar access, and the saved schedule revision.
2. Project the desired managed-event set with deterministic IDs and hashes.
3. Discover existing managed events for the selected calendar and ownership tags, following all pages.
4. Skip unchanged events; create or update changed events.
5. Handle update-not-found and insert-conflict races according to provider error semantics.
6. Apply bounded retries for transient failures with exponential backoff and jitter.
7. Remove obsolete managed events only after the replacement write set has succeeded, or explicitly document an alternative partial-failure policy.
8. Persist per-event outcomes and a reconciliation summary so retry resumes safely.

Account for missing/inaccessible calendars, deleted events, rate limits, cancelled operations, remote edits, target-calendar changes, and lost local sync metadata.

An HTTP 404 is not always proof that only an event is missing. Validate target-calendar access and avoid endless recreate attempts when the calendar is unavailable.

Preserve or intentionally overwrite remote-owned fields according to a clear policy. A full events.update operation can replace fields; do not accidentally erase user customization without defining ownership.

### Timezone and session time

Persist the chosen IANA timezone with the schedule or sync configuration. A later system timezone change must not silently move every event.

Project ordered sessions onto saved weekday times and account for each session's duration. Define missing-time, excess-session, overlap, and overnight behavior. Use each event date's actual timezone offset, including daylight-saving transitions.

Include tests for nonexistent and ambiguous local times, and choose a documented resolution policy. Do not reuse today's UTC offset for an entire course.

### UI and progress

Use the actual /schedules route and course schedule view when naming integration targets; the original request's /schedule label should not create a duplicate route accidentally.

Describe connection, calendar selection, timezone, projected counts, progress, partial failure, reconnect, retry, and cleanup behavior. Show a confirmation summary before an external publish operation according to the existing product's interaction conventions.

Do not present ARC as functional until its API/authentication contract and implementation exist. iCal export is optional additional scope, not a prerequisite for MCP.

## 11. Incremental implementation sequence

### Phase A: architecture decisions and compatibility spike

- Resolve owner lifecycle, authentication, durable jobs, mutation semantics, and schema contracts.
- Pin compatible Hono, mcp-lite, and schema-library versions.
- Explicitly include Zod v4 if using z.toJSONSchema; Zod is absent from current package manifests.
- Choose dependency locations that resolve from both server/index.ts and app server modules.
- Prove initialize, tools/list, a read-only tools/call, error results, and shutdown.
- Compile and execute a minimal packaged Bun binary using the selected dependencies.

**Gate:** Supported client(s) connect to the real transport, and the compiled binary behaves correctly.

### Phase B: read-only MCP and owner lifecycle

- Add authenticated /mcp and backend identity.
- Implement course/lesson discovery, bounded document reads, search, and saved-schedule retrieval.
- Establish development routing and single-owner behavior.

**Gate:** Read-only MCP works against fixture data without duplicating queues or bypassing access controls.

### Phase C: mutations and generation

- Implement shared course creation, injection, archive/delete, and deterministic schedule save.
- Introduce unified durable jobs and result retrieval.
- Add on-demand document generation and prompt_course.
- Share service behavior with corresponding REST routes.

**Gate:** Race, failure, cancellation, and restart scenarios meet the written contracts.

### Phase D: packaged stdio support

- Implement/test the stdio bridge and authenticated backend discovery/startup.
- Provide platform-correct configuration snippets.
- Verify GUI-open, GUI-closed, port-conflict, and multiple-client behavior.

**Gate:** A packaged installation works without a development runtime or source checkout.

### Phase E: incremental REST modularization

- Move controllers and existing services in manageable slices.
- Preserve existing HTTP contracts, streaming, custom tabs, imports, and settings.
- Keep the current adapter functional during migration.

This work may proceed alongside earlier phases where dependencies permit. Replacing every REST controller is not a prerequisite for proving useful MCP functionality.

### Phase F: Google Calendar publish/reconcile

- Implement OAuth provisioning, secure storage, projection, reconciliation, cleanup, and UI.
- Validate provider behavior with mocked failures and a dedicated test calendar.
- Leave ARC behind a defined interface until its API contract is available.

**Gate:** Repeated sync, reschedule, lost-manifest recovery, and offline cleanup are safe and retryable.

## 12. Required verification matrix

Extend existing tests with behavior-focused coverage. The current unit suite and manual Inspector checks alone do not cover the new architecture.

| Area | Required cases |
| --- | --- |
| REST compatibility | Existing API contract and sidecar E2E checks; percent/literal-percent assets; malformed encodings; backup streams; LLM streams; custom tabs |
| MCP protocol | Initialization/version negotiation; tools/list schemas; valid and invalid calls; notifications; unsupported methods; tool errors; concurrent request IDs |
| HTTP boundary | Invalid Origin rejected; invalid Host rejected; missing/wrong credential rejected; allowed native client; input limits; required CORS behavior |
| Stdio | No non-protocol stdout; empty HTTP notification response; JSON/SSE forwarding; EOF; malformed/oversized input; cancellation; subprocess exit |
| Ownership | Two launchers; existing valid owner; unrelated occupied port; GUI close; headless attach; custom dataset mismatch; graceful shutdown |
| Course mutation | Upper/lowercase conflicts; simultaneous create; assignment/source distinction; overwrite policy; duplicate batch entries; failed writes; manifest reconciliation |
| Deletion | Pending and active generation; stale result commit; recreated course slug; archive through REST and MCP; offline remote cleanup |
| Jobs | Fast completion; wait timeout with one execution; duplicate requests; distinct prompts; terminal answer retrieval; restart; expired/unknown job; cancellation |
| Documents | Source missing; placeholder versus generated content; valid/invalid scope combinations; custom tabs; bounded continuation reads |
| Schedules | Exact blackout fields; invalid dates/times; empty days; target overflow; multiple slots; persisted preferences; structural validation |
| Prompt context | Scope validation; small model budget; long user prompt; missing summaries; source attribution; bounded output |
| Calendar | Repeated no-op sync; insert conflict; update missing; deleted event; pagination; 403/429/transient errors; partial failures; stale-event cleanup |
| Calendar identity | Two datasets with the same course slug; restore/reconnect; changed calendar; rescheduled date-based keys; lost local manifest |
| Timezones | DST boundaries; ambiguous/nonexistent times; overnight sessions; changed system timezone; missing dayTimes |
| Secrets | Token redaction; credential file access controls; normal backup excludes OAuth and MCP credentials; disconnect behavior |
| Packaging | Compiled owner and stdio launcher on supported desktop platforms; absolute executable configuration; no global Bun requirement |

Run the existing project checks at the appropriate implementation gates:

~~~bash
bun run check
bun run test
bun run server:compile
~~~

Add actual execution tests for the compiled artifact. Existing tests that launch the source server do not prove compiled-runtime behavior.

Use scratch DATA_DIR and ILC_SETTINGS_PATH values and isolated ports in tests. Do not use a student's real courses or primary calendar.

## 13. Changes Gemini should make to the plan document

Use this as the final revision checklist:

- [ ] Correct the status and remove unmeasured performance/client guarantees.
- [ ] Replace the topology with an authoritative owner plus stdio bridge.
- [ ] Document the deviation from the original Rust-side requirement.
- [ ] Add a backend startup, identity, discovery, and shutdown contract.
- [ ] Add explicit HTTP host/origin/authentication enforcement.
- [ ] Move credentials out of ordinary data backups and define secure storage.
- [ ] Replace incompatible job maps with a concrete unified job/result design.
- [ ] Correct blackout fields, course-ID normalization, and artifact-scope semantics.
- [ ] Add lesson discovery and bounded output/result contracts.
- [ ] Define safe injection, assignment IDs, atomic writes, and mutation coordination.
- [ ] Define deletion/job coordination and durable offline cleanup.
- [ ] Define model-aware prompt budgeting and scope validation.
- [ ] Expand calendar upsert into a full reconciliation and identity policy.
- [ ] Define persisted timezone and per-session time projection.
- [ ] Defer ARC implementation until its API contract exists.
- [ ] Replace the all-at-once refactor sequence with gated increments.
- [ ] Add automated protocol, ownership, failure, packaging, and sync tests.
- [ ] Record the existing type-check failure and its intended resolution.
- [ ] Reconcile every example schema and handler with the written contracts.

Return a short explanation of the substantive changes and any remaining external prerequisites. Do not claim implementation or production readiness from revising prose alone.

## 14. References and interpretation

Primary technical references to verify against the versions selected for implementation:

- [mcp-lite README and API examples](https://github.com/fiberplane/mcp-lite)
- [mcp-lite exported API](https://github.com/fiberplane/mcp-lite/blob/main/packages/core/src/index.ts)
- [MCP transport specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
- [MCP tools and tool-result specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
- [Google desktop OAuth](https://developers.google.com/identity/protocols/oauth2/native-app)
- [Google Calendar event creation and ID constraints](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert)
- [Google Calendar event listing and pagination](https://developers.google.com/workspace/calendar/api/v3/reference/events/list)
- [Google Calendar error handling](https://developers.google.com/workspace/calendar/api/guides/errors)

The MCP specification requires invalid present Origin headers to be rejected for HTTP transport; stdout framing rules also come from the transport specification. The single-owner backend, durable job model, local credential policy, and phased rollout in this document are architectural recommendations for this repository.

The original requirements ask for a lightweight Rust-side transport modeled on ../timeflow. The inspected Timeflow implementation in tauri/src-tauri/src/native.rs forwards HTTP requests through Tauri events to JavaScript MCP logic; its MCP_FRAMEWORK.md describes a different Rust/rmcp design. Treat source and documentation separately.

Reusing CourseDeck's existing Bun backend is a reasonable proposed deviation because it already owns the TypeScript domain services. Explain this tradeoff explicitly; do not claim the Rust-side requirement was implemented or that copying Timeflow automatically supplies protocol/security correctness. Standard MCP HTTP and stdio do not require introducing a WebSocket server.
