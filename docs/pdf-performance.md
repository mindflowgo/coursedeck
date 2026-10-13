# PDF Generation Performance

Findings and measurements from an audit of the vector PDF export path
(`app/src/lib/pdf/`), plus the optimisations applied.

> The export path is already vector-based: `pdfmake` + bundled DejaVu fonts,
> selectable/searchable text, no `html2canvas`/`jspdf`. The canvas question
> therefore has a narrower answer than it first appears — see
> [Can the canvas be avoided?](#can-the-canvas-be-avoided).

## Where the time goes

### Offline harness — `bun run app/scripts/pdf-smoke.ts`

Server-side `pdfmake`, fonts pre-loaded from disk, images stubbed. Compile is
negligible; **render dominates**.

| case | pages | compile | render | size |
| --- | --- | --- | --- | --- |
| `baf3m/02.06.lesson` | 30 | 32–50 ms | 387–696 ms | 157 KB |
| `baf3m/03.05.summary` | 23 | 10–16 ms | 201–409 ms | 126 KB |
| `gwl3o/04.03.test` | 4 | 3–4 ms | 84–134 ms | 48 KB |

### Cold start in a real browser

Fresh incognito tab, dev build, **no** pre-warm — this is what the first export
click used to pay on top of the numbers above:

| stage | cost |
| --- | --- |
| pdfmake import + 6 font fetches + base64 encode + register | 701 ms |
| first render (fontkit parses all six faces; later renders don't) | +226 ms |
| **total cold start** | **~1082 ms** |

With pre-warm (engine already loaded and parsed) the same stages measure 0 ms /
24 ms, and the first render is 133 ms against 108 ms warm — i.e. the font
parsing has already happened.

### A real export, end to end

`exportDocumentToPdf` for `baf3m/02.06` notes in the dev build:

| stage | cold | repeat export |
| --- | --- | --- |
| compile (330 blocks) | 18–28 ms | 18–28 ms |
| images | 421 ms | **1 ms** |
| render | 738–847 ms | 738–847 ms |
| output | 254 KB | 254 KB |

(Wall-clock in automation was dominated by the native save dialog, which is not
representative of a real click.)

## What the canvas is actually used for

`imageStore.rasterizeElement` is the only canvas in the export path, reached
only for formats a PDF cannot carry (SVG, GIF, WebP). PNG and JPEG are embedded
byte-for-byte.

That "fallback" is in fact the **main** path, because the courses are
SVG-heavy:

| | files | total | avg | max |
| --- | --- | --- | --- | --- |
| SVG | 310 | 89 MB | 287 KB | 3.9 MB |
| JPEG | 556 | 18 MB | 32 KB | 244 KB |

Markdown image references: **942 SVG**, 478 JPG, 7 JPEG, 7 GIF, 6 PNG — so
~65% of image refs go through the canvas. Lessons average 6.1 icon refs, up to
89. Observed mode split over three lessons: 13 block, 7 inline.

### Two bugs in that path

**1. Quoted-printable-corrupt SVGs are silently dropped.** 11 of 310 SVGs are
stored quoted-printable encoded (`<svg id=3D"Layer_1" …`) but served as
`image/svg+xml`, so the browser rejects the XML and the figure vanishes from the
PDF (and is broken in the viewer too). All 11 live in `baf3m/assets/icons/` and
they include the two largest SVGs in the repo (3.9 MB and 430 KB). Decoding the
text makes them render, which confirms the cause.

**2. Rasterising at natural size.** A 24 pt inline icon was drawn at its full
natural resolution and then scaled down to 24 pt on the page.

## Changes applied

| file | change |
| --- | --- |
| `imageStore.ts` | rasterise at the on-page display size, capped at the source resolution; session-level source/embed caches; one decode instead of two; quoted-printable SVG repair |
| `fontLoader.ts` | native base64 encoder instead of a JS character-concatenation loop |
| `pdfClient.ts` | `prewarmPdfEngine()` / `schedulePdfPrewarm()` — loads the engine, fonts and font parsing while the browser is idle |
| `routes/courses/[course_id]/+page.svelte` | schedules the pre-warm on mount |
| `imageStore.test.ts` | unit tests for the sizing rule and SVG repair |

### Measured effect (real assets, real canvas)

Sizing rule — the bitmap is now at most 2× the display size and never larger
than the source, so an embed can only ever shrink:

| asset | mode | before | after | delta |
| --- | --- | --- | --- | --- |
| `notebook.svg` | inline (24 pt) | 9,250 B | 2,914 B | **−68%** |
| `try_it.svg` | inline (24 pt) | 19,322 B | 7,994 B | **−59%** |
| `definition.svg` | inline (24 pt) | 12,198 B | 5,046 B | **−59%** |
| `notebook.svg` | block | 9,250 B | 9,250 B | 0% |
| PNG / JPEG | any | unchanged | unchanged | 0% |

Repeat export: images stage **421 ms → 1 ms** (cache hit).

Previously-broken figures now embed: 10 of the 11 corrupt SVGs, including the
3.9 MB `baf3m_01.05.01.svg` (now a 34 KB embed) that previously produced
`[image unavailable]`.

## Can the canvas be avoided?

**Not at runtime, with this stack — but it can be moved to ingest.**

- PDF image XObjects accept rasters only; `pdfmake` exposes no SVG or vector
  API. Verified directly: passing a `Uint8Array` as an `image` node is rejected
  (`Invalid image: File '255,216,255,219,…'`), so images must be data URLs. The
  ~33% base64 inflation on every embed is inherent, not an oversight.
- The only way to remove the canvas from the runtime path is to convert SVG to
  PNG **ahead of time**, at course ingest (extend `imageOptimizer.ts` /
  `compress_course_images.ts`, which already rewrite images), and then the
  existing byte-for-byte embed path takes over.
- A true vector SVG→PDF path would need `svg-to-pdfkit`-style output, which
  means bypassing `pdfmake` entirely. Not viable today; it would shrink files
  and keep diagrams crisp, so it is the interesting long-term option.

Verdict: canvas is **unavoidable at runtime** for SVG under `pdfmake`, is
**avoidable at ingest**, and has been made **cheap** in the meantime.

## Remaining opportunities, ranked

1. **Render in a Web Worker.** 740–850 ms of synchronous main-thread work — the
   export spinner cannot even animate. Same wall clock, no UI freeze.
2. **Fix the SVG corruption at ingest/serve.** 11 files; fixes the on-screen
   viewer as well and removes a 3.9 MB download that always fails.
3. **Pre-rasterise SVG at ingest.** Removes canvas from the runtime path
   entirely (see above).
4. **Shrink the font payload.** 3.26 MB across six DejaVu faces is ~700 ms of
   the cold start; subsetting, or dropping the oblique faces, would cut it.
5. **Tauri save path.** `blob → base64 → invoke` copies the whole PDF a second
   time; writing `Uint8Array` bytes via the fs plugin would avoid it.
6. **Compile cache.** Only ~20–30 ms — low value, not worth the invalidation
   complexity.

## Reproducing

```bash
bun run app/scripts/pdf-smoke.ts   # compile/render baselines + output sanity
bun run check                      # svelte-check + server tsc
bun test app/src                   # includes imageStore sizing/repair tests
```

Browser-side numbers were taken by importing the modules directly from the Vite
dev server and timing `getPdfMake()`, a throwaway render, and
`createBrowserImageStore()` against live `/api/courses/.../assets/...` URLs.
