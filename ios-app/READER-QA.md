# CourseDeck Reader — Manual QA Notes

This file covers the native reader phase: prose runs, tables (fixed-height
viewport + inner scroll + full-screen route), images/SVG, math attachments,
callouts, details, USERNOTE cards, code blocks, task lists, the document viewer,
the checkpoints UI, and the Application Support data root.

Automated checks that were actually run for this round are recorded at the bottom.
Anything marked **Manual** below has not been executed in this round and must be
checked on a real iPad (or a simulator if one is available) before release.

---

## 1. Open the reader fixture

1. Launch CourseDeck on an iPad.
2. Tap **Open reader sample** in the sidebar (or the welcome screen).
3. Expected:
   - The reader opens full screen with the title **Reader sample**.
   - Prose is selectable across consecutive paragraphs; selecting from one
     paragraph into the next works because they share one `UITextView`.
   - Inline math (`$x^2 + y^2 = z^2$`, `$|x|$`) renders as MathJax-like images.
   - `$1,500` and `$45,000` remain literal currency text.
   - The inline SVG deck icon appears (not a “missing image” placeholder).
   - The display equation `\int_0^1 x^2\,dx = \frac{1}{3}` is centered.
   - Callout, details, USERNOTE, code, task list, blockquote, thematic break, and
     the unsupported-HTML fallback are all visible.

## 2. Prose, code, task lists

- **Prose** — tap and drag across paragraphs; selection handles continue across
  the run. Links are tinted/underlined; tapping an `https://` link opens
  `SFSafariViewController` (not a WebView inside the reader).
- **Inline math** — tap a rendered equation; expect a “TeX source” action sheet
  with **Copy TeX**. VoiceOver should read the equation as “Equation: …” when the
  run contains math.
- **Code block** — long lines scroll horizontally; the copy button copies the
  exact source including indentation. At the top/bottom of the code scroller,
  vertical drags hand off to the reader (see §3 for the same handoff in tables).
- **Task list** — checkboxes show the checked/unchecked state from the Markdown.
  They are deliberately read-only in this build; VoiceOver says “Read-only.
  Edit the Markdown to change the task state.” Confirm a checked item reads
  “Completed” and an unchecked item reads “Not completed”.

## 3. Tables — fixed-height viewport, inner scroll, full-screen route

Use the sample “A table that must not lose cells” ledger.

1. **No lost cells** — confirm the five columns and every row render, including
   the empty P.R./Credit-style cells (the sample’s third row).
2. **Currency/math protection** — `$|x|$` and `$1,500` occupy one cell each and
   are not split across columns.
3. **Wide table** — on a narrow Split View width the table scrolls horizontally
   inside its viewport; the page itself does not scroll sideways. Header cells
   remain aligned with body columns.
4. **Fixed-height viewport** — the 500-row test ledger caps the viewport near
   480 pt and scrolls internally. Confirm the reader can still scroll past the
   table.
5. **Gesture handoff** — scroll the table to its top, then drag downward again:
   the reader (not the table) should continue scrolling. Repeat at the bottom
   with an upward drag. Horizontal drags always stay inside the table.
6. **Offsets** — scroll the table right and down, scroll the reader away, then
   back. The table must restore the same horizontal and vertical offsets.
7. **Full-screen** — tap **Open table**. Confirm:
   - the same table and offsets are shown;
   - columns are re-measured for the wider window;
   - **Done** returns to the reader at the same reader scroll position;
   - the embedded table keeps the offsets changed in full screen.
8. **Copy** — long-press a cell and choose **Copy Cell**, **Copy Row**, or
   **Copy Table as TSV**. The full-screen ellipsis menu also offers TSV/header
   copy. Paste into Notes and confirm tabs/newlines are correct.
9. **Selection** — tap/drag inside a cell to select its text; copy selection
   works. Tap an inline math or image attachment in a cell: math shows a TeX
   action sheet, images open in the document viewer. Cross-cell drag selection
   is intentionally not supported.

## 4. Callouts, details, USERNOTE

- **Callout** — the NOTE card shows its label and nested table. Nested content is
  measured inside the card and does not overlap the card border.
- **Details** — the “Show the worked answer” section starts collapsed. Tap the
  header: it expands, shows the nested table, and the header’s VoiceOver value
  changes from “Collapsed” to “Expanded”. Tapping again collapses it. The reader
  must not jump to a different paragraph when the row changes height.
- **USERNOTE** — the amber card shows the query, target preview, body, and
  “Notes cannot be created or deleted in this build.” Tap **Jump to target**:
  the reader scrolls to “The derivative measures…” and briefly highlights it. If
  the target is deleted from the Markdown, the card still renders and says the
  target quote was not found.
- **Unsupported HTML** — the `<div>` fallback shows an orange “UNSUPPORTED HTML”
  label plus the flattened readable text; no script/style content runs.

## 5. Images, SVG, document viewer

- Tap the SVG icon: the image viewer opens full screen. Pinch to zoom, pan,
  double-tap to zoom, and use the share button. Close returns to the same reader
  position.
- Tap a link to a local PDF: PDFKit opens with page navigation and share. A link
  to an office/HTML attachment: Quick Look opens. A missing attachment:
  “File not available” alert (not a crash).
- Remote images: confirm they are not loaded automatically. A remote image cell
  shows a placeholder and a **Load remote image** button; tapping it asks for
  confirmation before any network request.
- SVG quoted-printable repair: use a real BAF3M lesson with an icon containing
  literal `=3D`. The icon should render, not show a decode failure.

## 6. Checkpoints and notes

1. Scroll into the middle of a lesson and open the toolbar bookmark menu.
2. **Save checkpoint** — close and reopen the document. With “Resume last
   position” enabled the reader returns to the saved block (not just the top).
3. **Add note at current position** — enter text and choose a colour. The note
   appears under **Document notes** and in the global **Checkpoints** hub,
   newest first.
4. Tap a note in the document sheet: the reader jumps to its anchor and the note
   card (if present) is highlighted.
5. Swipe-delete a note in the document sheet and in the hub. It is removed from
   `checkpoint.json`; the position checkpoint for the file remains.
6. Open **Checkpoints** from the library. Search by course, file, or note text;
   filter notes by colour; both notes and saved positions are listed. Tapping a
   checkpoint opens the reader at that position with 60 pt of preceding context.
7. Read-only documents (`course.schedule.md`, `course.lesson.md`) and the sample
   hide checkpoint controls and never write to `checkpoint.json`. When
   `dataVersion.json` is newer/corrupt, the library shows the read-only storage
   banner and the reader hides checkpoint controls.
8. Storage location: the live root is
   `Library/Application Support/CourseDeck`; `Documents` contains only
   `Import Inbox` and `Export`. Confirm no course data appears in the Files app
   except those two folders.

## 7. VoiceOver

Turn VoiceOver on and check:

- **Prose** — body text reads normally. Runs containing math/images use a spoken
  label so equations read as “Equation: …” and images as “image: alt text”.
- **Table** — the table exposes row and column counts, header names, and cell
  coordinates (“Row 3 of 500, column 2 of 5. Header: Debit.”). Header cells use
  the header trait. Three-finger swipe scrolls the inner table (implemented by
  `accessibilityScroll`). **Open table** is reachable and opens the full-screen
  route.
- **Math** — tapping an inline equation exposes TeX source; the display block
  reads “Equation: …”.
- **Images** — the image view reads its alt/caption; placeholders read the
  failure reason.
- **Task lists** — each row reads completed/not completed and the read-only
  hint.
- **Details** — header is a button with “Show/Hide details”, expanded/collapsed
  value.
- **USERNOTE** — card reads the query; “Jump to target” is a button.
- **Tables at accessibility sizes** — with Dynamic Type at a very large size,
  VoiceOver order follows header cells then visible body cells; scrolling the
  table refreshes the accessible cells.

## 8. Dynamic Type

Test at least: Large (default), XXXL, and Accessibility XXXL.

- Reader body, headings, table cells, code, captions, callout labels, and
  USERNOTE text all scale.
- Rows re-measure; text is never clipped at the bottom or right.
- Tables re-measure columns and row heights; existing scroll offsets are
  preserved as much as possible.
- Details and USERNOTE cards grow without overlapping their footers.
- The reader does not crash or freeze when changing the size while a long lesson
  is open.

## 9. Rotation, Split View, Stage Manager

- Rotate portrait ↔ landscape. The reader preserves the current block/fraction
  and re-measures prose and tables.
- In Split View / Slide Over / Stage Manager, resize the window through narrow
  widths. Tables that cannot fit switch to horizontal scrolling rather than
  truncating columns.
- Open the full-screen table, rotate, and confirm columns are re-measured and
  offsets restored.
- Scroll to a table, rotate twice, and confirm the table still shows the same
  cell region and the reader does not jump to the top.

## 10. Performance sanity

- Open a 99 KB lesson and a 500-row × 5-column ledger.
- First screen should appear promptly (parsing and row measurement happen off
  the main thread; rows show a “Preparing lesson content…” placeholder until
  measured).
- Scroll quickly; no repeated full-document reparse and no obvious main-thread
  hitches.
- Memory should remain stable while scrolling a 500-row ledger.

---

## Checks executed this round

Environment: `C:\macos-builder` container, macOS 15.8.1, Xcode 16.0, iOS SDK
18.0, iPad Pro 11-inch (M4) simulator (iOS 18.0).

Automated coverage now includes: inline bold/italic/code/link survival in
assembled prose; complete spoken text for mixed prose/math/image runs; 32 KB
prose chunking with safe paragraph/list splitting, a checked-in 97 KB fixture, a
50 KB single paragraph, and a 1000-item list; deep anchor restore, closed
`<details>` ancestor expansion (top-level and inside callouts), 60 pt hub
deep-link offset, rotation anchor preservation, USERNOTE jump, pixel-only
checkpoints, and background exact-save; deep-anchor restore after a 500-row
table; measured-height checkpoint writes and an iOS→desktop checkpoint JSON
round-trip; table summary/coordinates and offset restore after re-measure;
missing/remote image placeholder geometry; container backgrounds; read-only save
policy; `../assets` resolution and missing-PDF handling; virtual Course
Navigation; exact Dynamic Type point sizes at Large/XXXL/Accessibility XXXL; a
controller layout check that prose/table text is not clipped at Accessibility
XXXL; and the visible “Preparing lesson…” label while loading.

| Check | Command | Result |
|---|---|---|
| Core tests | `cd CourseDeckCore && swift test` | **194 tests, 0 failures** |
| App build (Debug) | `xcodebuild build ... -configuration Debug` | **BUILD SUCCEEDED** |
| App tests (unit) | `xcodebuild test ... -only-testing:CourseDeckTests` | **74 tests, 0 failures** |
| App tests (UI) | `xcodebuild test ... -only-testing:CourseDeckUITests` | **5 tests, 0 failures** (sample, table, task list, rotation, accessibility XXXL, loading label) |
| Full app suite | `xcodebuild test ...` (CourseDeck scheme) | **74 unit + 5 UI, 0 failures** |
| Release build | `xcodebuild build ... -configuration Release` | **BUILD SUCCEEDED** |

Not run in this round: physical iPad install via iLoader, a listening VoiceOver
session on hardware, the manual Dynamic Type/rotation matrix on the oldest
supported iPad, real-course BAF3M/MCR3U reader walkthrough with the full desktop
backup, and nested-scroll handoff on device. The simulated rotation and
accessibility-XXXL launches passed, but they do not replace listening to
VoiceOver or testing the actual gesture arbitration on glass. Those are
**Manual** items above, not passed checks.
