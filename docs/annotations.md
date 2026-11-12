# CourseDeck Annotations Specification & Architecture

## 1. Core Principles & Scope

Annotations in CourseDeck provide an integrated, multimodal study layer over course materials. They allow students to highlight text, attach contextual post-it notes, run location-aware AI tutoring queries, and sketch free-hand drawings directly on top of lessons.

The design adheres to these core architectural rules:

1. **Source-File and Renderer Isolation**:
   Annotations belong strictly to the **actual source file and renderer where they were created**. Original HTML presentations (`*.lesson.html`) and companion Markdown (`*.lesson.md` / `*.companion.md`) are treated as independent documents with distinct layouts, styling, and DOM structures. Annotations created in one view do not sync, map, or cross-pollinate into the other view. Switching views only displays annotations authored in that specific view.
2. **Invisible Source Instrumentation**:
   Document content is augmented with unobtrusive, persistent block identifiers (`data-anchor-id` in HTML, `<!--coursedeck-anchor:cd-...-->` in Markdown). Instructional text and code blocks are never altered, and anchor metadata is stripped before passing content into AI prompts or readers.
3. **Non-Destructive Presentation**:
   Highlights and free-hand strokes are rendered via overlays that never mutate the source HTML or Markdown files on disk. Text selection and native links remain fully interactive.
4. **Local-First & Cross-Platform Sync**:
   Annotations and strokes persist locally first (in browser IndexedDB or native desktop/mobile SQLite/file stores) and synchronize via atomic pushes with compare-and-swap (CAS) conflict resolution.

---

## 2. Annotation Domain Model

The annotation system is built on top of the **Checkpoint** domain model (`Checkpoint` in `app/src/lib/checkpoint.ts`).

### Checkpoint Types (`CheckpointType`)

| Type | Purpose | Key Attributes |
| :--- | :--- | :--- |
| `note` | Post-it sticky note pinned to a passage or paragraph | `noteText`, `color`, `anchor`, `selection` |
| `highlight` | Text highlight overlay painted directly on the document text | `color`, `selection`, `anchor` |
| `ai` | AI tutoring Q&A checkpoint attached to a selected passage | `aiQuestion`, `aiAnswer`, `aiStatus`, `color`, `selection`, `anchor` |
| `markup` | Derived page-relative checkpoints for PDF drawings | `file` (e.g., `doc.pdf:p1`), `verticalPosition` |
| `position` | Automatic reading position tracker (debounced scroll bookmark) | `file`, `verticalPosition`, `date` |

### Checkpoint Schema Contract

```ts
export interface Checkpoint {
  id: string;                      // Stable UUID or generated identifier
  courseId?: string;               // Owning course identifier
  file: string;                    // Target source file (e.g. "01.01.lesson.md", "01.01.lesson.html")
  verticalPosition: number;        // Content-relative fallback Y position in pixels
  type: CheckpointType;            // 'note' | 'highlight' | 'ai' | 'position' | 'markup'
  color?: string;                  // Palette color ID (default: 'yellow')
  noteText?: string;               // User-authored markdown text
  date: string;                    // ISO 8601 modification timestamp
  deleted?: boolean;               // Soft-delete tombstone for sync propagation
  anchor?: Anchor;                 // Source block anchor resolution data
  selection?: SelectionRange;      // Exact highlighted / quoted text range
  aiQuestion?: string;             // User question prompt
  aiAnswer?: string;               // Streamed/persisted AI markdown response
  aiStatus?: 'pending' | 'done' | 'error'; // Lifecycle state of AI response
}
```

---

## 3. The 10-Color Palette System

Checkpoints utilize a canonical 10-color palette divided into two balanced 5-color sets (`CHECKPOINT_COLORS` in `app/src/lib/checkpoint.ts`). Each color defines distinct light/dark background, border, text, and dot tokens:

- **Set 1 (Pastel / Soft Tones)**:
  - `aqua` (Aqua Mint, `#a7f8ef`): Fresh teal accent, optimal for definitions.
  - `yellow` (Canary Yellow, `#f7fa6d`): Classic highlighter yellow (default).
  - `lavender` (Soft Lavender, `#d5b3ff`): Muted purple, ideal for vocabulary.
  - `gold` (Golden Yellow, `#ffd000`): High-contrast golden yellow for key formulas.
  - `pink` (Pastel Pink, `#f086be`): Soft rose for important questions.
- **Set 2 (Vibrant / Intense Tones)**:
  - `orange` (Tangerine Orange, `#ffa417`): Energetic amber for warnings/cautions.
  - `blue` (Electric Blue, `#0055ff`): Bold blue for core concepts.
  - `coral` (Coral Red, `#ff5a3c`): High-visibility red for urgent review items.
  - `cyan` (Electric Cyan, `#3ce1ff`): Bright cyan for references and cross-links.
  - `green` (Neon Green, `#48ff40`): High-saturation green for completed milestones.

Each entry conforms to the `CheckpointColor` interface, supplying automatic CSS custom properties (`--note-bg-light`, `--note-bg-dark`, `--note-border-light`, `--note-border-dark`, `--note-text-light`, `--note-text-dark`) used by the Post-It cards and modal dialogs.

---

## 4. Source Anchoring & Block Instrumentation

Anchoring avoids fragile line numbers, DOM CSS paths, or word counts that break when documents are edited or reflowed.

### Anchor Metadata Format

- **HTML Source**: Top-level semantic content blocks (`<p>`, `<h2>`, `<h3>`, `<li>`, `<pre>`, `<blockquote>`, `<table>`) receive a `data-anchor-id="cd-..."` attribute. Existing publisher IDs used by internal anchors or navigation scripts are strictly preserved.
- **Markdown Source**: Blocks are preceded by an invisible HTML comment:
  ```markdown
  <!--coursedeck-anchor:cd-a1b2c3d4-->
  The highest exponent or highest term degree in the expression...
  ```
  The markdown renderer transfers this ID to the rendered HTML block container before sanitization. Fenced code blocks containing literal anchor comments are never interpreted as metadata.

### Just-In-Time Instrumentation

1. Unanchored files are instrumented in-memory with deterministic block IDs upon initial load.
2. When the user creates the **first annotation** on a document, the application dispatches an atomic `POST /api/courses/:course/annotation-anchors` request before saving the checkpoint.
3. The server validates that existing content matches expected hashes, writes the instrumented source atomically, and returns success. Stale writes return HTTP 409, prompting the user to refresh without overwriting edits.

---

## 5. Selection Ranges & Robust Position Resolution

### Selection Range Contract (`SelectionRange`)

When an annotation binds to text, it records full context for exact reproduction and drift-resilient re-anchoring:

```ts
export interface SelectionRange {
  text: string;               // Exact quote text
  startAnchorId?: string;     // Anchor ID of start block
  endAnchorId?: string;       // Anchor ID of end block
  charStart?: number;         // UTF-16 character start offset in block (Markdown)
  charEnd?: number;           // UTF-16 character end offset in block (Markdown)
  prefix?: string;            // 20-30 character prefix immediately preceding selection
  suffix?: string;            // 20-30 character suffix immediately following selection
  start?: SelectionEndpoint;  // DOM path/offset endpoint for HTML iframe
  end?: SelectionEndpoint;    // DOM path/offset endpoint for HTML iframe
}
```

### Range Resolution Algorithm

1. **Exact Block & Offset Match**: The resolver first checks the block corresponding to `startAnchorId` and extracts text at `charStart..charEnd`. If it matches `text`, the range is immediately resolved.
2. **Context Disambiguation (Prefix / Suffix)**: If the text moved slightly due to minor edits, the resolver searches within the anchored block using `prefix + text + suffix` fuzzy matching.
3. **Block-Level Fallback**: If the text was substantially modified or deleted, the checkpoint falls back to anchoring at the top of `startAnchorId`.
4. **Pixel Fallback**: Untagged or blank document areas fall back to `verticalPosition` in author pixels.

---

## 6. Persistent Highlight Rendering

Highlights persist across sessions and paint non-destructively over text in both supported renderers:

### Markdown Viewer (`MarkdownViewer.svelte`)
- Highlights are derived from `checkpoints.filter(c => c.type === 'highlight' && !c.deleted)`.
- Upon document render or resize (`ResizeObserver`), `resolveMarkdownRange` computes DOM `Range` objects across text nodes and projects their bounding boxes into container coordinates (`rangeRectsInScroller`).
- A dedicated background overlay (`pointer-events: none; z-index: 0`) paints `.checkpoint-paint` rectangles behind the text using CSS blend modes (`mix-blend-mode: multiply` in light mode, `mix-blend-mode: screen` in dark mode).

### HTML Presentation Viewer (`HtmlViewer.svelte` & `lessonBridge.ts`)
- The parent window filters active highlights and posts a message to the iframe bridge:
  ```js
  sendToBridge({ type: 'courseDeck:applyHighlights', highlights });
  ```
- The iframe bridge manages a dedicated, isolated `<div data-coursedeck-highlights>` overlay (`pointer-events: none; z-index: 2147483000`).
- The bridge re-resolves text ranges using `TreeWalker` text searches across DOM text nodes and updates the highlight bounding rectangles dynamically whenever accordions expand or the layout resizes.

---

## 7. Free-Hand Markup & Inking (Sketching)

CourseDeck provides free-hand sketching for highlighters and markers with stylus pressure and touch gestures (`app/src/lib/markup/`).

### Overlay Architecture

- **Direct Parent DOM Overlay**: Rather than injecting canvas/SVG rendering inside the iframe or serializing pen points across postMessage, markup overlays sit directly above the reading container in the parent DOM via `MarkupLayer.svelte`.
- **Mode States**:
  - **Inactive (`markupUi.mode === false`)**: `.markup-overlay` has `pointer-events: none`. All mouse clicks, text selection, and links pass through cleanly to the underlying HTML/Markdown text.
  - **Active (`markupUi.mode === true`)**: `.markup-overlay` has `pointer-events: auto; touch-action: none; cursor: crosshair;`. The overlay captures drawing inputs synchronously with zero IPC latency.
- **Uniform Scaling**: Coordinates are stored in author pixels (`stroke.authorWidth`). Both X and Y axes are scaled uniformly (`scale = currentWidth / authorWidth`) so shapes never distort when windows reflow.
- **Apple Pencil & PencilKit Integration**: On iPadOS (Tauri WKWebView), native Apple Pencil drawing is captured by PencilKit and handed off seamlessly to the SVG stroke pipeline with deferred acknowledgment (`ackPencilKitRendered`).

### File Scoping for Markup

Strokes are indexed by course and scoped canonical file key:
- **Markdown Lessons**: `courseId:01.01.lesson.md`
- **Original HTML Lessons**: `courseId:01.01.lesson.html`
- **PDF Documents**: `courseId:document.pdf:p{pageNumber}`

---

## 8. UI Interaction Components

### 1. Floating Checkpoint Trigger (`FloatingCheckpointTrigger.svelte`)
- **Compact State**: A floating 36px circular button with a pen icon (`PenLine`) that follows the reader's cursor along the right-hand gutter.
- **Expanded State**: Clicking or tapping freezes the trigger's vertical reading position and reveals a horizontal pill toolbar with three actions:
  1. **Highlight** (`Highlighter`): Available when active text selection exists. Instantly creates a highlight checkpoint.
  2. **Note** (`FlagTriangleRight`): Opens `CheckpointModal` to author a post-it note at this location.
  3. **Ask AI** (`Sparkles`): Captures selected passage or paragraph and opens the AI Composer.
- **Edge Clamping**: The trigger visually clamps within the viewport clearance while preserving the exact content-space vertical coordinate.

### 2. Checkpoint Modal (`CheckpointModal.svelte`)
- **Compact Dialog Surface**: 420px max-width modal designed for speed and minimal distraction.
- **Inline Note Color Dropdown**: Right-aligned on the same header line as the "NOTE" label. Clicking the button opens an animated 2-column popover with all 10 palette colors grouped into **Pastel** and **Vibrant** categories with color swatches, labels, and checkmarks.
- **Keyboard Shortcuts**: `⌘+Enter` (or `Ctrl+Enter`) submits the note; `Escape` closes the dropdown or modal. Auto-focuses the note textarea upon open.

### 3. Checkpoint Markers & Post-It Cards (`CheckpointMarker.svelte`)
- **Gutter Marker Dot**: Pinned in the reserved right gutter with an above-marker timestamp (`formattedDate`). Uses `FlagTriangleRight` for notes, `Highlighter` for highlights, and `Sparkles` for AI answers.
- **Interactive Post-It Card**: Clicking a marker expands an inward-facing post-it card with styled border accents and paper colors matching the checkpoint's color ID.
- **Action Toolbar & DOM Click Isolation**:
  - The actions container is positioned absolutely in the top-right corner (`absolute top-2 right-2 z-30 pointer-events-auto`), and the card text body has `pr-10` padding. This guarantees that block-level text elements or multiline quotes never overlap or block clicks on the action buttons.
  - **Highlights**: Display only the trash icon. Clicking the trash button **immediately removes the highlight** and unpaints it from the document without requiring confirmation.
  - **Notes**: Display the `Edit3` pencil icon and a confirmation-guarded trash button (`Delete? Yes/No`) to prevent accidental note loss.
  - **AI Checkpoints**: Display streamed or persisted markdown with full KaTeX math support and a retry button if generation encountered an error.

---

## 9. Storage, Synchronization & CAS Integrity

### Persistence Endpoints

- `GET /api/courses/:course_id/checkpoints`: Retrieves all checkpoints for a course.
- `POST /api/courses/:course_id/checkpoints`: Creates or updates a checkpoint record.
- `DELETE /api/courses/:course_id/checkpoints/:id`: Deletes a checkpoint record.
- `POST /api/courses/:course_id/annotation-anchors`: Persists source anchor comments or attributes into the lesson file.

### Sync Conflict Resolution

1. Pushes to remote devices or desktop peers carry source anchor hashes and checkpoint modification timestamps.
2. If remote source text has changed independently, anchor sync rejects the push with HTTP 409 (Conflict), preserving both revisions in the sync log.
3. Checkpoint deletions write a tombstone (`deleted: true`) that syncs to peer devices before being garbage-collected.

---

## 10. Verification & Testing

The annotation and markup systems are covered by extensive automated unit and integration tests:

| Test Suite | File | Focus |
| :--- | :--- | :--- |
| **Domain Models & Palettes** | `app/src/lib/checkpoint.test.ts` | 10-color palette definitions, color alias mapping, record normalization, date formatting, KaTeX math parsing. |
| **Source Anchors & CAS** | `app/src/lib/checkpoint/sourceAnchors.test.ts` | Deterministic block instrumentation, HTML attribute injection, Markdown comment insertion, CAS staleness rejection. |
| **Selection Ranges** | `app/src/lib/checkpoint/selection.ts` | Range calculation, endpoint serialization, character offset resolution. |
| **Free-Hand Markup Math** | `app/src/lib/markup/render.test.ts` | Perfect-freehand path generation, quadratic highlighter smoothing, stroke hit-testing, author scale math. |
| **Offline Routing & Sync** | `app/src/lib/api.routing.test.ts` | Local-first routing, IndexedDB transactions, offline anchor caching. |
| **E2E Contract Verification** | `scripts/api-contract.ts` | Full HTTP contract tests for anchor creation, checkpoint CRUD, and deletion. |

---

*Last Updated: November 2026 — Antigravity Engineering Architecture Documentation*
