# Sketching (Free-hand Markup)

Draw highlighter and marker strokes directly on top of rendered lesson documents,
with touch-first input for iPad / iPhone. Strokes are stored per course and sync
between devices through the same pipeline as checkpoints.

Entry point: the **Markup** split button in the top toolbar (between **PDF** and
**Edit**), visible on any markdown-reader view (hidden for schedule, course
overview, and unit-test views, and while editing).

Standard icon: `Highlighter` from `lucide-svelte`.

## Component Map

| File | Role |
|---|---|
| `app/src/lib/markup/types.ts` | `MarkupStroke` model, color/tool unions, structural validation (`isMarkupStroke`) |
| `app/src/lib/markup/render.ts` | Pure stroke math: SVG path generation (perfect-freehand for markers, smoothed polylines for highlighters), eraser hit-testing, LWW merge. No DOM access — fully unit-testable |
| `app/src/lib/markup/annotationStore.svelte.ts` | Svelte 5 runes store: per-course stroke cache, optimistic mutations, undo/redo, debounced batched persistence, UI state (`mode`, `tool`, `color`, `eraser`, `pencilOnly`, `show`) |
| `app/src/lib/components/MarkupLayer.svelte` | The SVG overlay + pointer input handling. Rendered inside `.markdown-body` by `MarkdownViewer` |
| `app/src/lib/components/MarkupMenu.svelte` | The top-bar dropdown: swatches, eraser, undo/redo, show/hide, pencil-only, clear-all, done |

## Rendering Architecture

**One SVG overlay across the whole `.markdown-body` container** (the container
has `position: relative`). The overlay is `position: absolute; inset: 0` with
`overflow: visible`, so strokes are never clipped and there is no per-section
bookkeeping.

- When markup mode is **off**: `pointer-events: none` — strokes are visible but
  inert; links and text selection work normally underneath.
- When markup mode is **on**: `pointer-events: auto; touch-action: none` — all
  input goes to the overlay, and iOS does not try to scroll it.

Two stroke renderers, deliberately different:

- **Markers** — `perfect-freehand` (`getStroke`) filled outlines with per-point
  pressure taper (Pencil pressure when available, constant 0.5 for mouse/finger).
  ~2.75px, opaque.
- **Highlighters** — plain stroked SVG paths (quadratic-midpoint smoothing,
  round caps, `fill: none`, ~16px) with `mix-blend-mode: multiply`. Multiply
  keeps the text underneath jet-black and tints only the paper, like a physical
  highlighter. In dark mode multiply would vanish against dark paper, so CSS
  switches the layer to normal blending at 50% opacity.

The in-progress stroke is drawn into a dedicated live `<path>` updated by direct
DOM writes (no reactive re-render per pointermove).

## Coordinate Model (the one subtle part)

Strokes are stored in **author pixels**: coordinates relative to the
`.markdown-body` top-left at draw time, plus `authorWidth` (the container width
when drawn). Rendering scales both axes **uniformly**:

```
scale = currentBodyWidth / stroke.authorWidth
```

- Uniform (not independent x/y normalization) so a circle stays a circle when
  the document reflows at a different width (phone vs iPad, resize). Independent
  normalization would stretch shapes 4× when height triples from text rewrap.
- **Accepted limitation** (deliberate, per product decision): strokes are
  anchored to *page geometry*, not characters. A large reflow or content edit
  keeps strokes within the document but not over the exact original words, and
  no observer re-fits strokes after every resize. The show/hide toggle is the
  escape hatch for stale markings.
- `getBoundingClientRect()` math is used consistently for input and rendering,
  which keeps coordinates correct under the desktop build's CSS `zoom`.

## Input Model (touch-first)

Pointer events on the overlay, differentiated by `e.pointerType`:

- **Pen** (Apple Pencil) — always draws, records `e.pressure` per point, uses
  `getCoalescedEvents()` for high-frequency smoothing. The first time a pen is
  seen, **pencil-only mode auto-enables** (the pro note-app convention:
  pencil draws, finger scrolls).
- **Touch, pencil-only ON** — does not draw; the finger manually pans the
  content scroller (`scrollTop/scrollLeft` deltas), since `touch-action: none`
  disables native scrolling over the overlay.
- **Touch, pencil-only OFF** — draws (phone use case). A **second finger**
  joining mid-stroke cancels the stroke and takes over panning, so scrolling
  stays possible without leaving markup mode.
- **Mouse** — always draws, constant pressure.

The eraser is a drag: every `pointermove` hit-tests visible strokes
(point-to-segment distance + stroke half-width tolerance) and tombstones each
hit continuously.

`-webkit-user-select` / `-webkit-touch-callout` suppression on the overlay stops
text selection and the iOS long-press magnifier while drawing.

## Data Model

```ts
type MarkupTool = 'marker' | 'highlighter';
type MarkupColor = 'red' | 'blue' | 'green' | 'white' | 'black'
                 | 'hl-yellow' | 'hl-green' | 'hl-pink';  // preset keys, not hex

interface MarkupStroke {
  id: string;          // uuid — merge key across devices
  file: string;        // docFileName, e.g. "01.01.lesson.md"
  tool: MarkupTool;
  color: MarkupColor;  // resolved via MARKUP_PRESETS in render.ts
  points: number[];    // [x0,y0,p0, x1,y1,p1, ...] author px + pressure 0..1
  authorWidth: number; // .markdown-body width at draw time
  date: string;        // ISO — last-write-wins merge key
  deleted?: string;    // tombstone ISO date (erase / undo / clear)
}
```

Colors are stored as preset keys so palette tweaks never migrate data. The
preset table (hex / width / opacity / blend) lives in `render.ts`.

## Persistence Pipeline (mirrors checkpoints)

Storage: `data/courses/<course_id>/annotations.json` — one flat stroke array
per course, filtered by `file` client-side. Tombstoned strokes are **kept
forever**: they are what makes erase/undo/clear survive sync merges.

Every mutation is applied optimistically in the store, then queued and flushed
as a debounced (300ms) batched `PUT` upsert. Failed flushes re-queue. Batches
also flush on `beforeunload` / tab-hidden.

| Layer | Path |
|---|---|
| Server API | `GET/PUT /api/courses/:id/annotations` in `app/src/lib/server/api.ts` (PUT merges upserts LWW) |
| Disk | `CourseService.getAnnotations/mergeAnnotations/saveAnnotations` in `courses.ts` |
| Sync bundle | annotations included per course in `/api/sync/bundle` |
| Sync push | `/api/sync/push` accepts an `annotations` payload, merges LWW per id |
| Offline client | `api.ts` `offlineFetch` handles GET/PUT (`/api/courses/:id/annotations` is a direct-file route; `annotations` is in `reservedSubpaths`) |
| Client store | `clientStore.ts`: `getAnnotationsLocally` / `saveAnnotationsLocally` (merge in JS, write-through to both stores) |
| IndexedDB | `coursedeck_v1` v2 adds `annotations` and `pending_push_annotations` stores; bundle import merges (never clobbers unpushed local strokes) |
| Rust (iPad) | `get_annotations` / `save_annotations` commands in `tauripad/src/lib.rs` |
| Rust (desktop) | same commands in `tauri/src/courses_fs.rs` |

Push queue integration is automatic: `syncState.svelte.ts` counts and pushes
`pending_push_annotations` alongside checkpoints, so the Sync/Push pill and
`SyncStatusPill` need no changes.

## Undo / Redo

Session-local, per course+file. Ops are `add(strokes)` and `erase(prev)`:

- Undo of an add → tombstone upsert (fresh date).
- Undo of an erase → restore upsert (fresh date, deleted cleared).
- Redo mirrors. Because every undo/redo is a normal dated upsert, history
  resolves correctly through the same LWW sync merge as live edits.

Keyboard: `⌘Z` / `Ctrl+Z`, `⇧⌘Z` / `⇧Ctrl+Z` while markup mode is active
(handled in the lesson page's existing keydown handler).

## UI State

All UI state lives in the `markupUi` rune in the store so the menu, overlay,
and page wiring stay in sync:

- `mode`, `tool`, `color`, `eraser` — the obvious.
- `show` — global markings visibility (device-local pref, `markup_show` in
  localStorage). Entering markup mode forces it on. This is the "easy way to
  toggle all the markings off".
- `pencilOnly` — device-local pref (`markup_pencil_only`), auto-enabled on
  first pen detection (`markup_pen_seen`).

Markup mode auto-exits when the Edit button is used (the reader is replaced by
the editor), and persists across tab/lesson switches (a drawing session spans
documents).

## Design Decisions & Rejected Alternatives

- **SVG paths, not `<canvas>`** — lossless at any zoom/DPR, no iOS WebKit
  canvas size caps on long documents, each stroke is an individually erasable
  element, and polylines serialize compactly as flat arrays.
- **Stroke math in TypeScript in the webview, not Rust** — `getStroke` must run
  synchronously inside `pointermove` (Pencil fires up to ~240Hz); the 2KB lib
  computes in well under 1ms. Routing through Tauri IPC per event would add
  async bridge latency/jitter — the documented Tauri IPC bottleneck for
  high-frequency messages. Rust stays where it's strong: persistence commands.
- **One whole-body overlay, not per-section overlays** — the renderer chunks
  long docs into `.markdown-section` elements with `content-visibility: auto`
  (off-screen sections have estimated geometry), so section-anchored overlays
  would misalign and clip cross-section strokes. A single overlay avoids all of
  it. (Cost: no partial-render culling — fine at these stroke counts.)
- **Author-px + uniform scale, not 0..1 normalization** — prevents aspect-ratio
  distortion across devices (see Coordinate Model).
- **Markers use perfect-freehand; highlighters don't** — filled translucent
  polygons look wrong for highlighters; stroked paths + multiply blend
  reproduce the physical tool. Text stays readable through the ink.
- **Tombstones instead of deletes** — deletes would resurrect on sync merge
  from a device that hasn't seen the erase.
- **PDF export does NOT include strokes (v1)** — `exportPdf.ts` re-renders
  markdown → pdfmake vectors without touching the DOM; including ink would
  mean mapping polylines into pdfmake canvas. Deliberate follow-up, not scope.
- **Text-anchored (Kindle-style) highlights rejected** — would require a
  selection→range→CSS Custom Highlight pipeline; a separate future feature.

## Testing

- `app/src/lib/markup/render.test.ts` — unit tests for point decoding, path
  generation (marker/highlighter/dot), eraser hit-testing (incl. width
  tolerance), and LWW merge (tombstones, stale-upsert rejection, invalid
  payloads).
- Browser E2E verified on a real lesson: draw → server `annotations.json`
  write → reload persistence → undo → redo → erase → hide/show.

## Future / Out of Scope

- Floating in-mode palette (bottom pill) — pure UI addition on the same store.
- Strokes in PDF export.
- Text-anchored highlights.
- Per-stroke selection/move; stroke import/export.
