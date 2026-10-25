# CourseDeck iOS — Release Notes

## Unreleased — Phase 5 ingestion (iOS + desktop compatibility)

### Desktop compatibility (required alongside this iOS build)

The desktop parser must ship with these changes before a course is re-parsed
after an iOS ingest. Without them, a default backup (which excludes
`_backup/`) plus one new chapter would drop every existing lesson from the
desktop manifest.

- `app/src/lib/parser/courseIngest.ts`
  - Merges existing `meta.json` lessons when no package currently represents
    them, so re-parsing without `_backup/` keeps navigation intact.
  - Never shrinks units: an existing unit is retained even when no package
    produces a lesson for it.
  - Preserves loaded root, unit, and lesson fields by spreading
    `existingManifest`/`existingUnit`/lesson objects instead of rebuilding
    them, and uses nullish fallbacks (`existingManifest?.grade ?? 'Grade 11'`)
    so empty iOS-created grade/level/description values stay empty.
- `app/src/lib/parser/extractor.ts`
  - Accepts the `<stem>assets` companion folder produced by iOS ingestion when
    a standalone HTML package's sibling `assets` folder is archived into
    `_backup/`. This lets the desktop re-parse the archived package after the
    course `assets/` directory has been removed.

### iOS ingestion

- ZIP, MHTML/MHT, and standalone HTML packages are archived in the course
  `_backup/` folder with collision-safe names and secret scanning before
  commit.
- HTML is cleaned with SwiftSoup and converted by a custom Turndown-compatible
  HTML→Markdown converter (core/GFM/custom rules, table-cell `<br>`, details,
  callouts, MathML, learning goals).
- Assets are extracted into `assets/{img,icons,locker_docs}` with
  content-hash/case-safe collision handling and rewritten references.
- ImageIO resizes images wider than 512 px to 512 px at JPEG quality 0.82 and
  applies the 360 px `|50%` rule. A source-hash→JPEG map
  (`assets/img/image-optimizer.json`) is exported with backups so repeated
  ingest and restore/re-ingest reuse the existing derivative.
- SVG assets are repaired from quoted-printable (`=3D`) captures and rendered
  through the existing SwiftDraw reader path.
- Incremental ingest preserves existing lesson files unless overwrite is
  requested, snapshots the previous file as `.bak`, merges USERNOTE cards into
  any replaced lesson/summary/cheatsheet/test (or blocks the overwrite with a
  warning), and preserves unknown lesson fields and key order.
- Ingest limits enforce actual decompressed bytes (per entry, cumulative,
  compression ratio), MHTML decode bounds, companion-folder entry/byte bounds,
  and a separate MHTML package cap.
- The new-course flow requires a user-supplied, validated, lowercased course
  code and does not invent grade/level/description values.

### Verification

- `swift test` (CourseDeckCore, macOS builder, Xcode 16.0/iOS 18.0 SDK).
- `bun test src/lib/parser/courseIngest.test.ts` for the desktop compatibility
  merge and archived `<stem>assets` re-parse.
