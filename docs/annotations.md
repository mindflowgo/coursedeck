# CourseDeck annotations

## Scope and decisions

Annotations belong to the **actual source file and renderer where they were
created**. Original HTML and companion Markdown are independent documents.
There is no mapping, migration, or synchronization of annotations between
those views. Switching views must not show the other file's annotations.
Different devices viewing the same source file should resolve the same anchors.

HTML and Markdown use persistent source anchors plus precise text positions.
PDF remains page number plus page-relative offset. Notes/highlights/AI answers
remain checkpoint records; only invisible location metadata belongs in source.

## Source anchors

HTML: add `data-anchor-id="cd-…"` to existing content blocks, retaining publisher
IDs for links and scripts. Markdown: store `<!--coursedeck-anchor:cd-…-->` before
the corresponding source block and attach its ID to the rendered block before
HTML sanitization. Do not interpret examples inside fenced code as metadata.

IDs are opaque and persisted, not regenerated paragraph numbers. Several notes
may use the same block but have different range endpoints. Preserve existing
IDs on ordinary edits; newly inserted blocks get new IDs. Replacing a file does
not promise annotation recovery if its old content/anchors no longer exist.

Render unanchored files using deterministic IDs in memory, then persist the
same IDs through a validated source-write operation when the first annotation
is saved. Reading alone must not rewrite the course. Both server and native
storage must use the same instrumentation. Reject stale source writes rather
than overwriting an edited lesson. Save source anchors before saving a record
that depends on them, and report failures to the user.

## Position model

Each new record identifies its actual source filename and renderer. A text
selection stores stable start/end block IDs, defined character offsets, exact
quote, and short prefix/suffix context. Offsets use JavaScript UTF-16 text-node
units consistently in capture and resolution; source Markdown syntax is not
counted as rendered text. Cross-block ranges retain both endpoints.

Resolve the precise range first, validate its quote, then use unambiguous quote
recovery if edits moved the text. Resolve a position-only note against its block
and location within that block. Pixels record the current location when text
cannot be resolved (for example, a point in an untagged blank area). Never replace
an exact passage position with the top of a containing section. Return HTML
positions by checkpoint ID, because two notes may share the same element.

Rendering coordinates are distinct from stored content coordinates. Convert
iframe coordinates into parent reader content coordinates once. Measure marker
centers explicitly. Recompute after reflow, image/font loading, resizing, and
accordion changes. Clamping the visible trigger/menu must not alter the target
position captured in the reading content.

## Trigger and gutter

The compact trigger shows a single pen icon. Expansion still offers Highlight,
Note, and Ask AI. The trigger and saved marker dots sit in a reserved right-edge
gutter outside the page surface, inside the viewport. Expanded controls/notes
open inward. Avoid clipping, horizontal scrolling, and content-obscuring dots on
desktop and narrow mobile screens. Keep dates separate from marker geometry.

## New-method scope and verification

Only the new source-file/renderer/block-anchor method is supported. There is
no conversion or compatibility lookup for earlier paragraph indexes, publisher
element IDs, CSS paths, or unscoped annotation records. Records without explicit
source and renderer identity are not shown in the new reader workflow.
Anchor metadata is not instructional text and
must not become visible in readers or AI context.

Tests use synthetic files: multiple notes within one large section, repeated
quotes, cross-block/backward selections, nested lists/tables/code, parent/iframe
scroll, reload, resize, block insertion/movement, independent HTML/Markdown
views, source-write failures and stale revisions. Include actual note save and
reopen, not only mouse-follow checks. Browser tests supplement native Windows,
macOS, Linux, iOS/iPadOS, and Android acceptance; they do not certify every OS.

## Implemented behavior and current limits

- Shared deterministic instrumentation adds HTML block attributes and Markdown
  source comments, preserving existing IDs, publisher IDs, frontmatter, and
  source line endings. Markdown anchors identify top-level source blocks;
  nested content uses exact text offsets within its anchored owner.
- The explicit `POST /api/courses/:course/annotation-anchors` operation resolves
  the actual file, checks required anchor IDs, and saves metadata before the
  checkpoint. Stale targets return 409. Server writes are atomic; native writes
  compare the expected content before replacement. Local source tagging and its
  pending source-sync record share an IndexedDB transaction.
- Original HTML sync carries the pre-tagging source as a base and accepts
  only anchor metadata changes. It rejects newer/different server content,
  deletion, and replacement/removal of existing IDs with HTTP 409 before any
  merge. Failed pushes retain their queue; timestamps cannot override these
  checks. Ordinary Markdown content editing keeps the existing sync behavior.
- HTML positions are resolved by checkpoint ID using the precise range, or a
  saved block/caret position for a point note. Markdown resolves stable block
  IDs and the quote before falling back. Dates no longer shift dot centers.
- The compact trigger has one pen icon. The page reserves a right-side gutter;
  dots and the trigger stay outside the page surface while expanded UI opens
  inward. The captured reading position is separate from visual edge clamping.
  Saved markers sit above the compact trigger so overlapping positions cannot
  block reopening a note; expanded actions sit above the markers.
- Ask AI context strips application anchor comments using Markdown tokens; literal
  code examples remain instructional content. Failed note saves keep the editor
  and entered text open.

Browser verification uses real Svelte viewer/trigger/modal/marker components
with synthetic HTTP persistence. It covers two distinct selected passages in
one paragraph/large HTML section, equivalent Markdown notes, position-only
notes, save/reload/scroll/reflow alignment, source-file isolation, one compact
icon, and desktop/390px gutters without horizontal scrolling. Source helpers,
server persistence, local routing and stale-write handling have separate unit
tests. The native source-file/CAS/traversal regression ran on macOS.

Verification for this implementation: 48 focused tests, 26 local-routing tests,
and one native Rust source-file/CAS/traversal test passed. Server type checking
passed; the app check reported zero errors and ten existing library accessibility
warnings. The browser suite also verifies that an existing marker opens its note
when the compact trigger is deliberately positioned over that same gutter
location; the trigger does not intercept the click.

Native Windows/Linux/iOS/Android interaction has not been executed here.
An unavailable source must fail visibly rather than guessing a different file.
Original HTML still uses the existing server content delivery path; this change
does not implement a new offline HTML renderer. PDF remains page-relative.

Update this document when behavior or limits change. The earlier broad review
is in `floating-checkpoint-fix-plan.md`; this document supersedes its proposal
to map HTML anchors to companion Markdown.
