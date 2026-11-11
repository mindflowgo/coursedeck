# Floating checkpoint investigation and fix plan

Original investigation: 2026-11-10. Implementation audit: 2026-11-11. The audit below supersedes the earlier implementation-completion claims. The original findings and proposed implementation remain below as the requirements and historical baseline.

## Source-anchor recommendation (historical design; current implementation in annotations.md)

**Scope correction:** `annotations.md` is the current annotation design. The
user explicitly ruled out mapping annotations between original HTML and its
companion Markdown. Each source file/view owns its anchors independently.

Use persistent block IDs in HTML and Markdown, combined with exact text ranges
and quote/context fallback. A source anchor identifies the containing content;
it does not by itself identify a particular line or selected phrase within a
large paragraph. Continue resolving the actual range geometry when rendering
a checkpoint, rather than substituting the block's top.

Suggested source representations:

```html
<p data-anchor-id="cd-b7f21c">A paragraph containing the selected passage.</p>
```

```markdown
<!--coursedeck-anchor:cd-b7f21c-->

A paragraph containing the selected passage.
```

These IDs must be persisted opaque identifiers, unique within the document,
not paragraph numbers regenerated on each render. Existing publisher IDs must
remain intact for links, scripts, and accordions. Multiple checkpoints may
refer to the same block with different text endpoints.

### Investigation findings

- The installed Marked parser preserves standalone and inline HTML comments
  in synthetic Markdown examples, while comment syntax in fenced code remains
  escaped text. A real anchor implementation must recognize metadata through
  Markdown tokens/source structure, not a global replacement that could alter
  code examples, tables, nested lists, or inline formatting.
- `MarkdownViewer` sanitizes rendered HTML with DOMPurify. The source comment
  should be consumed during parsing and become `data-anchor-id` on the actual
  rendered block. Do not depend on a raw comment surviving sanitization or
  having a visual bounding rectangle. The existing sanitizer configuration
  already explicitly allows `data-anchor-id`.
- HTML is stored as `.lesson.html`; its editable/AI companion is a separate
  `.lesson.companion.md`. `saveLessonTab` edits the companion when original HTML
  exists. Ingest can replace both files. A Markdown-only anchor write cannot
  fix an HTML annotation, and matching block numbers across these files would
  be unreliable.
- The HTML bridge already serializes text endpoints and has a range resolver;
  Markdown has range/quote helpers. Extend those mechanisms to use stable
  block IDs instead of creating a second independent annotation subsystem.

### Proposed implementation sequence

1. Define one versioned checkpoint target: document identity/revision, renderer,
   stable start/end block IDs, defined character offsets in rendered text,
   exact quote and adjacent context, plus the legacy pixel fallback. For a
   position-only note, capture the nearest text position at the reading point;
   non-text blocks may need a block-relative offset.
2. Add source IDs during import/save and a controlled migration for existing
   documents. Preserve existing IDs across edits; allocate new ones to new
   blocks. Source metadata edits must use revision checks and atomic writes
   through both server and native storage paths. Persist/sync source metadata
   with its checkpoint so another device can resolve it. Viewing should not
   silently rewrite every lesson.
3. For HTML, add a namespaced data attribute to existing block elements without
   changing publisher IDs or wrapping every selection. For Markdown, consume
   anchor comments at the token/source-mapping layer and attach their IDs to
   the corresponding rendered blocks. Handle nested structures explicitly.
4. Resolve the stable block plus exact text range; verify its quote. If content
   has changed, try quote/context recovery and repair an unambiguous match.
   If unresolved, retain the checkpoint and mark it unresolved; never attach
   it to an arbitrary repeated phrase or an ancestor section's top. Recompute
   geometry on reflow, resize, image/font loading, and accordion changes.
5. Treat original HTML and companion Markdown as separate source identities.
   Preserve and resolve an annotation only in the file/view where it was
   created. There is no cross-view conversion or mapping requirement.
6. During re-import/regeneration, match old anchored content to new content
   and preserve IDs only when correspondence is reliable. A deleted or heavily
   rewritten passage cannot be made permanent by an ID alone. Keep original
   checkpoint data for recovery. Remove internal anchor metadata from AI
   reference text while retaining all instructional content.
7. Add end-to-end note save/reload tests for two selections in the same block,
   duplicate quotes, content inserted before/inside a block, block movement,
   re-import, cross-block selections, nested lists/tables/code, and source
   sync across devices. Test browser and native rendering; source anchors do
   not eliminate coordinate conversion or iframe message requirements.

PDF remains page plus page-relative offset. Its target is independent of the
HTML/Markdown source-anchor scheme.

This hybrid recommendation follows the W3C pattern of identifying a paragraph
and refining it to a passage, with text quote/context as another selector:
[selector refinement](https://www.w3.org/TR/annotation-model/#refinement-of-selection),
[text quote selector](https://www.w3.org/TR/annotation-model/#text-quote-selector).
Source comments are compatible with Markdown's raw HTML constructs, but the
application must deliberately interpret them:
[CommonMark HTML blocks](https://spec.commonmark.org/0.31.2/#html-blocks).

## Implementation status (2026-11-11)

**No: the full plan is not implemented.** Several core features exist, but the
earlier labels “Phase 1/3/5 done” and “Markdown + HTML done” were stronger than
the code and platform verification support. A feature being present does not
establish that its complete acceptance criteria pass on every supported reader
and platform.

| Phase | Audited status | Implemented | Remaining acceptance gaps |
| --- | --- | --- | --- |
| 1. Contract and persistence | Partial | Canonical AI status, legacy normalization, course local POST field preservation and PATCH, server persistence tests; original type errors resolved. | Local invalid-value behavior differs from server validation; no common typed request contract; library lacks the equivalent AI PATCH workflow; native disk-failure/sync behavior and every asynchronous navigation path need verification. |
| 2. Shared reader controller | Partial | Shared coordinate, range, and prompt helpers; course route clears selection and anchor state on document/view changes. | No shared controller/reader host or renderer adapter registration; orchestration remains in the course route. Other readers do not use this workflow. |
| 3. Trigger interaction | Partial, positioning correction in this review | Compact persistent control; click/keyboard expansion; expanded/focused freeze; pointer tracking; stationary-overlay positioning replaces the feedback loop; stale iframe positions are not replayed on collapse. | Device touch-end after native scrolling, keyboard/safe-area viewport bounds, measured expanded dimensions, complete focus behavior, and narrow-screen acceptance still need implementation or verification. |
| 4. Selection and highlighting | Partial | Markdown and server-delivered HTML range capture, quote/context resolution, persistent overlay painting, layout observers, explicit HTML scroller and session/source checks. | No PDF adapter; no native offline HTML delivery with the same bridge; protocol version/full payload validation and renderer identity are incomplete; touch focus/selection and reflow cases need browser/device tests. |
| 5. Ask AI | Partial | Separate question composer, editable `checkpoint_ask`, complete lesson text without 4,000-character slicing, quote/source-tab fields, generation retry, old duplicate flow removed. | Library reader integration, no-reference handling, retry/save failure lifecycle, and prompt-edit freshness need completion/verification. Initial AI context is now captured before asynchronous work; all retry/navigation paths must follow the same rule. |
| 6. Reader coverage and verification | Incomplete | Course Markdown lesson/generated tabs and original HTML are wired. | Book/PDF, library and document overlays, schedule/test selection, unified active-reader ownership, and native cross-platform acceptance remain open. |

### Corrections made during this review

- The offset/jump originated in `FloatingCheckpointTrigger.renderTop()`: it
  subtracted the moving control's own rectangle when calculating its next top.
  This incorporated its previous position and centering transform, producing
  feedback rather than a stable coordinate conversion. The reference is now a
  stationary overlay, with no platform-specific pixel adjustment.
- The external-position effect also subscribed to expanded state and internal
  position reads. It now consumes new iframe events without replaying a stale
  event when the user moves in the parent or closes the action bar.
- A second HTML layout feedback issue was found: the bridge reports a height
  that includes the iframe viewport, while the parent added 24 pixels to each
  report. Repeated reports can grow the frame without any content change.
  The parent now uses the reported height without adding that padding; a
  browser regression confirms repeated stable-content reports leave the
  frame height unchanged.
- Markdown selection capture preserves the pending selection while the action
  bar has focus. Hidden/background triggers are suspended for book/document
  views and note/AI composers.
- Keyboard opening now allows focus to transfer from the replaced compact
  button into the action bar before checking for focus loss. Escape restores
  focus after Svelte has rendered the compact button again.
- HTML document changes use a fresh iframe/window and session; its load handler
  no longer discards the session learned from an early bridge message.
- Initial Ask-AI context is captured with the composer identity, before model
  lookup and checkpoint save. Configuring a missing model from Ask AI no longer
  triggers generation of the currently open tab. Retry captures its course
  identity before fetching lesson context so navigation during that fetch
  cannot redirect the retry to another course.

### Reader coverage checklist

Checked items indicate implemented wiring, not certification on every native
platform. Unchecked items still require implementation or acceptance evidence.

- [x] Lesson Markdown and Markdown summary/cheatsheet/notes/custom tabs use the
  same trigger, selection callbacks, and checkpoint actions.
- [x] Original HTML lessons have a bridge for selection and persistent highlights
  when delivered by the server content endpoint.
- [ ] Schedule and rendered quiz/test content need selection adapters. Merely
  enabling the trigger on these views does not wire their rendered text into
  `activeSelection`.
- [ ] Original PDF lessons still use an uninstrumented iframe.
- [ ] Book/PDFViewer, library, and document overlays need the shared trigger and
  action workflow, including page-relative selection geometry.
- [ ] Image-only pages need explicit extraction capability handling: no false
  promise of selected-text highlighting before text is available.
- [ ] Third-party cross-origin webpages need an explicit capability boundary;
  the local lesson bridge cannot simply inspect arbitrary external documents.

### Remaining work in dependency order

1. Finish the shared persistence contract and failure semantics. In
   `clientStore.saveCheckpointLocally`, a native disk write failure is caught
   and the method can still resolve after an IndexedDB write. Subsequent reads
   prefer a nonempty native list, which can hide the newer cached record.
   Library checkpoint writes have the same swallowed-error pattern. Define
   an explicit durable-save/fallback outcome and test recovery, then add local
   validation and normalization equivalent to the server and library AI PATCH
   parity. Keep pending-sync records until successful acknowledgment.
2. Extract the shared reader host/controller. Move action orchestration out of
   the course route; register the active reader and its capabilities. Snapshot
   identity for note/highlight/AI create, edit, retry, and delete, and prevent
   asynchronous results from altering a newly opened document's UI.
3. Finish input and geometry acceptance. Verify touch-end following after
   native scrolling (pointer cancellation is not a final touch position),
   multitouch rejection in both parent and iframe, native selection-handle
   changes, pen input, measured expanded-menu bounds, software-keyboard visual
   viewport changes, rotation, and safe-area insets. Preserve the selected
   quote across menu/composer focus transfer.
4. Complete renderer coverage: PDF/text layer and page anchors, book/library
   and document overlays, rendered schedule/test content, and an explicit
   unsupported-selection state for non-text/image-only or foreign webpages.
   Add document/renderer identity to serialized selections and a versioned,
   validated iframe message contract. Avoid guessing when quote resolution
   becomes ambiguous after content changes.
5. Finish AI lifecycle acceptance. Fetch the latest editable prompt for a new
   request or explicitly refresh/invalidate its cache; show missing reference
   text before submission; supply library-document context; separate retrying
   an unsaved answer from generating a new answer; check pending-state writes
   and prevent duplicate submissions. Verify that full lesson text plus the
   original quote/question survive navigation and retry.
6. Implement the native HTML delivery path with the same bridge and local
   assets, then run the platform matrix below. Preserve existing link,
   document-opening, and lesson-navigation behavior on each path. Add the
   resulting renderer/input regressions to an executable test harness so the
   feature cannot be marked done based solely on message-string/unit tests.

### Cross-platform completion requirements

The user requires Windows, macOS, Linux, and mobile support. The UI changes
must use logical browser coordinates, pointer/selection APIs, and the shared
persistence contract; do not compensate for one OS with hard-coded offsets,
device-pixel scaling, absolute host paths, or mouse-only event handling.

| Target | Required verification | Current evidence/limitation |
| --- | --- | --- |
| Windows desktop | Packaged app/webview; mouse/pen/touch where available; Windows scaling; iframe bridge; local save/reload and model request. | Shared frontend/native file code exists; no Windows device run in this review. |
| macOS desktop | Packaged app/webview and browser; trackpad scrolling/zoom; selection and focus transfer; native persistence. | Current development host is macOS; that does not validate a packaged native run. |
| Linux desktop | Packaged app/webview; mouse/keyboard; display scaling; iframe and native storage behavior. | Shared frontend/native file code exists; no Linux device run in this review. |
| iOS/iPadOS | Native scrolling followed by touch-end, selection handles, Pencil/keyboard, rotation, safe areas/software keyboard, offline save/reload/sync, HTML delivery. | Local API tests emulate mobile routing. The `courseasset` protocol is registered under `target_os = "ios"`; HtmlViewer still requests server `/api/.../content`, so offline original HTML parity is not implemented. |
| Android/mobile browser | Touch and keyboard viewport behavior, selection handles, local persistence, HTML assets/bridge, and supported PDF renderer. | Do not infer Android native parity from iPad behavior: the reviewed native `courseasset` registration and mobile module are iOS-only. Audit/implement Android delivery and storage support before claiming native Android completion. |

For all targets, test the same synthetic lesson with nested formatting,
repeated text, cross-block selections, large scroll offsets, and an HTML
counterpart. Verify that the trigger's visible center follows the pointer
except for documented edge clamping, and that stored anchors use document
coordinates exactly once. Then test quote/highlight persistence and Ask AI
with a mocked model across reload and route changes. Native device tests are
required in addition to browser emulation, especially for touch selection,
custom protocols, and offline persistence.

### Evidence from the current audit

- Focused checkpoint/model/selection/prompt/server tests: **36 passed**,
  including two new positioning regressions.
- Local API routing tests: **24 passed**, including course checkpoint field
  preservation and local AI PATCH behavior. These use mocks; they are not a
  native-device storage/sync test.
- Final app type check: **0 errors, 10 existing library accessibility
  warnings**. Server type check also passes.
- Retained browser regression: `scripts/checkpoint-trigger-browser.mjs` with
  `scripts/fixtures/CheckpointTrigger.svelte`. The real Svelte components pass
  repeated pointer movement with different reader/overlay offsets, scrolling,
  iframe updates, stale-event rejection, expanded freeze, saved content
  coordinates, synthetic touch release/cancellation, edge clamps, keyboard
  opening/focus/Escape, HTML bridge height stability, and HTML document
  navigation. This uses synthetic content, not real course data.
- Run the browser regression with `bun scripts/checkpoint-trigger-browser.mjs`.
  It requires app dependencies and an optional Playwright installation. Set
  `PLAYWRIGHT_MODULE` to the installed module file if it is outside the repo;
  `PLAYWRIGHT_EXECUTABLE_PATH` optionally selects an installed Chromium.
  Project paths are resolved from the script, without host-specific paths.
  The reported browser run used Chromium on macOS; synthetic touch events do
  not certify native mobile scrolling or selection handles.
- The previous implementation report recorded 537 passing tests and a live
  browser smoke test. That historical report is not proof of the remaining
  native-platform acceptance criteria, nor of the subsequent positioning fix.
- No live model request or raw course-data access is needed for this review.

## Intended behavior

Every supported reading surface exposes the same compact control at its right edge. With a mouse, its vertical position follows the pointer within the reader. On touch devices, it moves to the last touch-end position and stays reachable. Clicking or tapping expands exactly three actions: Highlight, Note, Ask AI. Hover alone does not expand it.

A selection made before opening the control belongs to that action even if focus moves to the control or composer. Highlight visibly marks the selected passage; Note preserves it as a quotation; Ask AI opens a question composer and sends the user question, explicitly quoted selection, and complete lesson text through an editable prompt in Prompts.

Scope assumption: “all pages” means all study/document reading surfaces, including lesson HTML and Markdown, summary, cheatsheet, notes, custom tabs, course/unit documents, schedule/test reading content, book/PDF readers, and document overlays. Settings and other administrative screens do not have a study document to annotate. Editing, drawing, and text-input controls need deliberate interaction rules, not accidental exclusion of an entire page.

## Original investigation findings (2026-11-10)

| Finding | Evidence | Consequence |
| --- | --- | --- |
| Mouse-only positioning and hover expansion | `app/src/lib/components/FloatingCheckpointTrigger.svelte`: `handleMouseMove`, `handleTriggerMouseEnter`, `handleTriggerMouseMove`, listener effect | No explicit touch-end position support; approaching the control expands it before activation. |
| Uneven coverage | Course route around lines 3175–3215: trigger is inside workspace hidden for `book`, disabled for `schedule` and editing. Only that route imports the trigger. | Summary/Markdown share the trigger, but book, library/document overlays do not have the same interaction. |
| Two positioning paths | Trigger clamps parent mouse positions at both ends; external iframe positions only get a minimum. | HTML and Markdown can behave differently near viewport boundaries. |
| Incomplete selection capture | `MarkdownViewer.svelte:701` and `server/api.ts:3903` capture on mouseup, reject selections shorter than two characters, and omit exact range endpoints. | Touch handles, keyboard selection, single-character math, repeated text, and cross-block highlighting are not reliably represented. |
| Selection state outlives its document | Course route declares `activeSelection`, `externalCursorPosition`, and `htmlAnchorPositions`; assignments do not reset them on document/view changes. | An old selection or anchor can be applied to another tab/lesson or rendering mode. |
| Highlight is currently a marker | Course route `handleTriggerHighlight` saves text and a block/pixel anchor. Markdown has no checkpoint highlight rendering input; HTML only queries anchor positions. | A saved highlight does not paint the selected words. |
| Markdown position is not in a consistent coordinate space | `MarkdownViewer.svelte` uses `blockEl.offsetTop`, or `scrollTop + e.clientY`; `checkpoint.ts` resolves a block with `offsetTop`. | Reader padding, nested offset parents, and viewport offsets can displace markers. |
| Ask AI skips the user question | Course route `handleTriggerAskAI` uses selected text or `Explain this section` as `aiQuestion`. | There is no question entry step in the new flow. |
| AI ignores Prompts and loses lesson context | `triggerLlmForCheckpoint` hard-codes its system prompt and uses `cleanContext.slice(0, 4000)`. | User prompt customization is ignored; most of a long lesson is omitted. |
| Duplicate AI flows remain | Old `handleAnnotationSubmit` still exists after `SelectionToolbar` was removed from the route. | Two flows disagree about question handling, context, and storage. |
| Local persistence drops new fields | `app/src/lib/api.ts:847` reconstructs checkpoint POST bodies without `anchor`, `selection`, `aiQuestion`, `aiAnswer`, or `aiStatus`; no matching local checkpoint PATCH branch. | Production/local clients can lose fields that the server path preserves. AI updates can fall through to a different storage path. |
| Save failures and navigation are not handled uniformly | AI PATCH responses are not checked; async helpers read live `courseId` and lesson state after awaits. | UI can claim completion despite a failed save, or an answer can target changed context after navigation. |
| Type contract is inconsistent | `Checkpoint.aiStatus` permits `pending/done/error`; route writes `ready`; server patch accepts arbitrary strings; `CheckpointType` is referenced without an import. | App type checking fails in this area. |

The line references are investigation starting points; ongoing changes may move them.

## Original HTML iframe assessment (2026-11-10)

The bridge is partially implemented, not verified end to end. The server injects mouse-position forwarding, selected-text messages, and element-ID position queries into lesson HTML. `HtmlViewer.svelte` translates iframe coordinates into the parent reader and forwards selection/anchor results. These are useful foundations to retain.

Outstanding work:

- Add touch-end and keyboard/selection-change support, including native touch selection-handle adjustments.
- Preserve exact ranges and render/remove persisted highlights inside the iframe. An ancestor element ID alone cannot identify selected words.
- Validate that incoming messages originate from this iframe (`event.source`), validate payloads, and bind them to a document/session identity. Validate origins where the deployment supplies a stable origin; handle sandbox/native origins explicitly.
- Make the parent scroller explicit rather than finding it with `.closest('.overflow-y-auto')`.
- Apply identical top/bottom bounds and convert viewport, iframe, and content coordinates through shared helpers.
- Re-resolve anchors after iframe layout changes, image/font loading, resizing, and content replacement. Reset positions when the document changes.
- Keep the selected range when focus moves from iframe to parent control/composer, and ignore delayed messages from a previous lesson.
- Verify both browser and native/local HTML loading use the bridge. The reviewed injection is in the server content endpoint; local/native parity still needs a runtime check.

Original PDF lessons currently use a plain iframe in the course route. They do not inherit the HTML bridge. The book uses `PDFViewer`, which has a selectable text layer downstream but no integration with this shared trigger. These require a PDF adapter, not assumptions about HTML behavior.

## Proposed implementation

### 1. Establish one shared contract and make persistence consistent

Start with `checkpoint.ts`, `api.ts`, `server/api.ts`, `server/courses.ts`, and `storage/clientStore.ts`.

- Use one typed checkpoint create/update/patch contract across local and server implementations. Validate types and supported AI statuses at the boundary.
- Standardize on `pending | done | error`; normalize any already-stored `ready` value on read. Preserve legacy note, position, and markup records.
- Preserve all fields on local/server saves and partial updates. Add local PATCH support and verify native storage, cache, sync, and library writes retain the same fields.
- Give selections a serializable range representation: source document identity, exact quote, surrounding text for disambiguation, and renderer-specific endpoints. Retain pixels as a legacy fallback.
- Snapshot course/document/renderer identity, selection, anchor, and context before asynchronous work. Route completion to that snapshot; do not read mutable route state to choose the save destination.
- Distinguish failed generation from failed persistence, surface retryable failures, and avoid duplicate records on retry.

Acceptance: create, update, reload, sync, and delete preserve the complete record on every supported storage path; the three current checkpoint type errors are resolved.

### 2. Introduce a shared reader interaction controller

Extract interaction state and action orchestration from the large course route. Proposed modules: `checkpoint/controller.svelte.ts`, `checkpoint/selection.ts`, and `checkpoint/coordinates.ts`, with a shared reader host component.

The host owns the compact/expanded control, selection snapshot, note/AI composer, persistence actions, and document lifecycle. Renderer adapters supply pointer/selection events, range capture/resolution, highlight rendering, and scroll-to-anchor behavior. Adapters do not implement their own Highlight/Note/AI workflows.

Each reader registers an explicit identity, viewport/scroller, content root or iframe, and supported capabilities. Only the active reader owns the control; opening a document overlay suspends the background reader. Hidden book readers must not keep influencing pointer/selection state.

Use explicit states such as compact, expanded, composing note, and composing AI. Clear transient state on document changes/unmount; cancel timers and detach listeners. Async work may finish for its original document without changing the new document's UI.

Acceptance: switching tabs, lessons, HTML/Markdown mode, or overlays cannot transfer a selection or anchor to another document, and exactly one appropriate control is active.

### 3. Correct trigger positioning and activation

Keep `FloatingCheckpointTrigger.svelte` focused on control presentation and activation.

- Follow mouse pointer movement inside the registered reader. Use pointer events for mouse/pen/touch and a touch-end fallback only where device verification requires it.
- For touch, commit the final touch position after release and preserve it during reading; native scrolling must remain functional. Account for cancelled pointer sequences during scrolling and ignore pinch/multitouch gestures.
- Keep the control compact until click/tap/keyboard activation. Freeze its position while expanded or focused so the action targets do not move during use.
- Apply one coordinate conversion and clamp against the actual reader viewport, current control dimensions, toolbar clearance, safe areas, and visible viewport when the keyboard opens.
- Keep the compact control available while reading; do not auto-hide it after 2.5 seconds. Use a sensible initial position before the first pointer/touch interaction. If idle fading is desired later, retain an accessible visible target.
- Capture selection before control activation can collapse it. Treat composer focus as part of the same selection session.
- Provide Enter/Space activation, Escape dismissal, outside-click dismissal, focus restoration, `aria-expanded`, and adequate touch targets. Hidden/suspended controls must not remain keyboard-focusable.
- Collapse to compact after an action. Without a selection, Note and Ask AI remain available at the current reading position; Highlight stays visible but disabled with “Select text to highlight.”

Acceptance: the right-side trigger is reachable on narrow screens, remains steady while choosing actions, and behaves consistently with mouse, touch, pen, and keyboard.

### 4. Implement selection adapters and actual highlighting

Markdown/DOM adapter:

- Capture document `selectionchange` plus pointer completion, restricted to the active content root. Exclude toolbar, form, and editor selections.
- Record normalized range start/end, not just `Selection.anchorNode`; support backward, cross-node, cross-paragraph, repeated-text, and single-character selections.
- Compute marker positions from element/range rectangles relative to the reader and its scroll offset, not arbitrary `offsetTop` values.
- Render persistent highlights without rewriting source Markdown. Reconstruct ranges after render/reload and resolve them again after layout changes. Test overlap, deletion, links, math, and nested formatting.

HTML adapter:

- Move the injected bridge into a dedicated, testable module used by all relevant HTML delivery paths.
- Use typed/versioned messages for pointer updates, selection snapshots, anchor resolution, and highlight add/remove. Include document/session identity and reject stale or malformed messages.
- Perform DOM range operations and highlight painting inside the iframe; send only serializable data across the boundary.
- Preserve existing lesson links, document opening, sizing, and navigation behavior.

PDF adapter:

- Connect the existing text layer and page geometry to the same controller. Persist page/range information and page-relative geometry so zoom and virtualization do not break highlights or markers.
- Replace the uninstrumented original-PDF iframe with the supported PDF reader where feasible. Verify book, original PDF lessons, and document overlays use the same adapter.
- Image-only pages cannot supply selected text until extraction/OCR is available. Still expose position Note/Ask AI; make Highlight's unavailable state explicit.

For legacy text-only highlights, resolve using quote/context when unambiguous. If ambiguous or stale, retain the record and display an unresolved marker rather than painting an unrelated occurrence. HTML and Markdown can have different text order: preserve source-renderer identity and use a quote fallback when switching views, rather than applying one renderer's index to another.

Acceptance: Highlight paints precisely the selected text, survives reload/reflow, and disappears when deleted. Note preserves the full quotation separately from editable note text.

### 5. Replace both AI paths with one prompt-driven workflow

- Ask AI opens a composer showing the captured quotation plus a separate user-question field. Nothing is generated until submission. Offer an explicit “Explain this passage” shortcut if useful.
- Add a dedicated `checkpoint_ask` template to the existing Prompts system. Seed a default only if absent; never overwrite the user's customization. Keep it distinct from generated study-notes prompts.
- Use the editable template as the system instruction and build the request with separate labeled fields for course/lesson, active tab, selected passage, user question, and full lesson reference. Treat quoted lesson content as reference material.
- Resolve canonical full lesson content independently of the current tab. A selection from Summary still sends the full lesson and identifies Summary as the quotation's source; include relevant tab context when needed to understand it.
- For course/unit documents or standalone library files, use that document's full text and explicit scope rather than stale lesson state. If text is unavailable, show that limitation before sending.
- Remove `slice(0, 4000)`. Preserve all lesson instructional text; strip only non-content media/boilerplate using a reviewed normalization step. A context-limit failure must be visible rather than silently truncating the lesson.
- Use the existing active-model configuration path. Keep the composer/question intact if model configuration is needed or a request fails.
- Persist question, quote, response, anchor, and generation status through the shared repository. Show pending/error/retry states and check every save response.
- Retire the unused `handleAnnotationSubmit` route flow once the shared path replaces it, while preserving previously saved notes.

Acceptance: editing the Prompts template changes the next request; the exact selected quote and separately typed question are sent; a test sentinel near the end of a lesson longer than 4,000 characters is present in the request.

### 6. Apply the host across reading surfaces and verify

Mount the shared host at the appropriate reader boundary, rather than copying event handlers into individual tabs. Wire lesson/summary/cheatsheet/notes/custom-tab Markdown, HTML, course/unit documents, PDF/book, library, and document overlays through adapters. Schedule and rendered test text should be eligible; interactions in answer fields or editing/drawing controls should not become reading selections.

Third-party web pages displayed in arbitrary cross-origin iframes cannot be assumed to support the lesson bridge. Their overlay can expose document-level actions, but text selection/highlighting requires an authorized instrumented representation. Represent this capability explicitly and do not promise cross-origin selection parity without one.

Implement in small dependency-ordered changes: typed persistence first; controller and Markdown behavior second; HTML bridge third; AI composer/prompts fourth; remaining reader integrations fifth. Keep the existing HTML navigation/sizing work and coordinate against its current version before editing shared files.

## Verification matrix

| Area | Required checks |
| --- | --- |
| Trigger | Mouse movement; touch-end after tap and scrolling; pen; compact until activation; stationary expanded actions; upper/lower bounds; small viewport; zoom; keyboard; no duplicate/background controls. |
| Selection | Forward/backward; one character; multiple paragraphs; inline markup; lists/tables; repeated quotes; keyboard selection; touch handle changes; preserve through control/composer focus; clear on deliberate document selection change. |
| Rendering | Markdown tabs; original HTML; HTML-to-Markdown switch; book/PDF; document overlays; schedule/test rendered text; reader reload; image/font load; resize; PDF zoom/virtualization. |
| Persistence | Local/native and server create/update/PATCH/delete; reload; offline note/highlight; synchronization; library records; legacy records; overlapping highlights; unresolved anchors. |
| AI | Custom prompt edit; independent quote/question; full long lesson; Summary quote with lesson context; no selection; missing model; request/save error; retry; navigation during request; no silent context truncation. |
| Iframe | Scrolled parent; frame sizing; touch; selection retention on focus transfer; stale/foreign message rejection; missing/duplicate IDs; highlight restoration; existing links and navigation. |

Use unit tests for coordinate transforms, selection serialization/resolution, prompt assembly, and identity snapshots. Add contract tests for local/server persistence parity. Use synthetic content and mocked LLM responses for browser interaction tests; do not depend on live course data or paid model calls. Run real iPad/mobile checks for native selection handles and scrolling because mouse-only simulations are insufficient.

Required completion gates: focused regression tests pass; app/server type checks pass; browser and native/tablet acceptance matrix passes for supported surfaces; saved data survives reload/sync; old checkpoint behavior remains compatible.

## Historical verification from the original investigation (2026-11-10)

- `bun test app/src/lib/checkpoint.test.ts app/src/lib/server/courses.checkpoints.test.ts`: **12 passed, 0 failed**. Existing coverage is palette/routing/basic persistence, not this interaction flow.
- `bun run check` from `app/`: **3 errors, 10 warnings**. Errors are missing `CheckpointType` in `server/courses.ts`, unconstrained server `aiStatus`, and route `ready` versus model `done`. Warnings are in the library page.
- Static searches and working-tree diffs verified the component wiring, iframe bridge, prompt construction, and persistence differences described above.
- No browser/device interaction test or live model request was performed. No `coursedeck` MCP tool was available in this session, and raw course data was not read. Existing user prompt contents and real-course HTML behavior remain runtime verification items.
