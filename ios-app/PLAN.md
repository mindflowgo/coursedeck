# CourseDeck iOS — Native iPadOS Implementation Plan

Status: planning complete, implementation not started.
Target: iPadOS 18.0+ (runs on 18.7), sideloaded via iLoader.
Repo sub-folder: `ios-app/`.
Branch: `ios-app`.

> **Review corrections:** see [`PLAN-REVIEW.md`](./PLAN-REVIEW.md) for the adversarial review. The corrections in this document are authoritative; where earlier text conflicts with the review, the latest scope decisions below win.
>
> **Latest user scope decisions (2026-10-24):**
> - **Keep the current Xcode/toolchain.** Do not upgrade Xcode and do not modify the macOS builder container. The existing toolchain is **Xcode 16.0 with the iOS 18.0 SDK**, so the deployment target is **iPadOS 18.0**, not 18.7. The app adapts; no iOS 18.7/26-only APIs.
> - **PDF export is out of scope.**
> - **Scheduling is out of scope** for the initial iPad app (including schedule generation, mark-done, and Google Calendar/ARC). Existing `course.schedule.md` files are preserved on import/export but are not generated or edited.
> - **Implementation will be manifested via a workflow in this conversation** after plan polishing. The conversation log must remain current for handoff.

---

## 0. Decisions at a glance

| Decision | Choice |
|---|---|
| UI / runtime | **Native SwiftUI + UIKit**. No WKWebView, no JavaScript runtime, no local HTTP server, no sidecar. |
| Minimum OS | **iPadOS 18.0** (`IPHONEOS_DEPLOYMENT_TARGET = 18.0`). The app must run on 18.7 devices but is built with the current iOS 18.0 SDK. |
| Toolchain | **Current Xcode 16.0 / iOS 18.0 SDK** in the existing container. **Do not upgrade Xcode or modify the macOS builder container.** No iOS 18.7/26-only APIs; everything is `#available`-guarded. |
| Device family | iPad only (`TARGETED_DEVICE_FAMILY = 2`). |
| Project generation | XcodeGen `project.yml` (same pattern as `itube`). |
| Core logic | Local Swift package `CourseDeckCore` (models, parsers, storage, AI, aggregation) so it can be tested with `swift test` without a simulator. |
| Dependencies | `swift-markdown` **0.7.1** (0.7.2+ require Swift tools 6.2) with `swift-cmark` **0.7.0 exact** (do not let `from:` resolve to 0.9), `SwiftSoup` **2.14.3**, `SwiftMath` **1.7.3**, `ZIPFoundation` **0.9.20**, `Yams` **6.2.2**, `SwiftDraw` **0.24.0** — all `exactVersion` in `project.yml`/`Package.swift`; verify each builds on the Swift 6.0 toolchain in Phase 0. Commit **both** `ios-app/Package.resolved` and `ios-app/CourseDeckCore/Package.resolved`, and copy the app resolved file into the generated workspace before `xcodebuild`. No NIO, no WebView, no PDF library. |
| Reading view | Block-based renderer: selectable prose runs + a dedicated virtualized **table grid** + image/math/callout/detail/note blocks. |
| Editing | Plain monospaced `UITextView` + preview toggle. **No live-preview Markdown renderer in edit mode.** |
| AI | OpenAI-compatible client, DeepSeek defaults (`https://api.deepseek.com`, `deepseek-flash`), SSE streaming, durable foreground queue. |
| Keys | DeepSeek/GLM API keys in **Keychain**; never in the app bundle or plaintext JSON. |
| Out of scope | MCP (HTTP + stdio), SMTP/teacher email, Ask-AI selection toolbar and note creation/deletion. Existing USERNOTE data still renders read-only, and regeneration must not destroy it. |
| Deferred / out of scope | Chemical/mhchem rendering (SwiftMath fallback now; renderer protocol designed for future mhchem/KaTeX). **PDF export is out of scope.** **Scheduling is out of scope**, including schedule generation, mark-done, and Google Calendar/ARC; existing `course.schedule.md` files are preserved but not generated/edited. |
| Distribution | Unsigned IPA → iLoader signs with the user's Apple ID and installs over USB. No App Store path. |

---

## 1. Build and sideload chain (verified)

### 1.1 What exists

`C:\macos-builder\docker-compose.yml`:

- image `dockurr/macos`
- `VERSION: "15"` (macOS 15)
- 10 GB RAM, 4 CPU cores, 64 GB disk
- SSH published on `127.0.0.1:2222`, user `builder` / password `builder`
- project volumes: `ipad-monitorus-extendus` and `itube`
- Web UI on `:8006`

`build-itube.ps1` / `build-ipadmonitor.ps1` establish the working pattern:

1. rsync the Windows checkout into the container over SSH.
2. build frontend/assets (Tauri case).
3. `xcodegen generate` (itube case).
4. `xcodebuild clean archive -destination 'generic/platform=iOS' -configuration release ... CODE_SIGN_IDENTITY='' CODE_SIGNING_REQUIRED=NO CODE_SIGNING_ALLOWED=NO`.
5. copy `*.app` into `Payload/`, `zip` into an unsigned `.ipa`.
6. `scp` the IPA back to Windows.

### 1.2 Toolchain decision (latest user preference)

**Use the current Xcode/toolchain. Do not upgrade Xcode or modify the macOS builder container.**

Measured facts:

- `C:\macos-builder\itube.ipa` and `iPadMonitor.ipa` embed **`DTSDKName=iphoneos18.0`** and were built with the **iOS 18.0 SDK** (Xcode 16.0).
- `itube`'s `LastUpgradeCheck = 2630` is only a project attribute; it is not evidence of the installed toolchain.
- Xcode 26.3 would require an Xcode install and a larger VM disk. That is explicitly **not** happening.
- Consequence: the deployment target is **iPadOS 18.0**, not 18.7. The app must not use iOS 18.7/26-only APIs. These are the APIs available at 18.0; anything newer needs `#available` guards and a fallback.

Verify before the first build:

```bash
sw_vers
xcodebuild -version
xcrun --sdk iphoneos --show-sdk-version
df -h
```

Expected: current macOS 15.x, **Xcode 16.0**, **iOS SDK 18.0**. Assert the built IPA: `DTSDKName=iphoneos18.0`, `MinimumOSVersion=18.0`.

### 1.3 iLoader signing facts

`ipad-monitorus-extendus/iloader` is `nab138/iloader` (MIT), a Tauri desktop app using `isideload` + Apple development certificates:

- Accepts an **unsigned IPA**, signs it with the Apple ID development certificate, installs via USB.
- Requires Developer Mode on iPad and a trusted computer.
- Free Apple ID: **7-day provisioning expiry**, **3-app limit** (and limited App IDs); iLoader can revoke/renew certificates.
- Paid Apple Developer account: 1-year provisioning and more capabilities.
- Consequence for the app: avoid paid-only entitlements. No iCloud, push, App Groups, or background modes. Keychain (default access group), Files sharing, local notifications if needed later, custom URL scheme, ASWebAuthenticationSession, and ATS keys all work under free signing.
- The app bundle identifier should be stable: `com.ilc.coursedeck`.

### 1.4 Build script

Add `ios-app/scripts/build-ipa.ps1` modeled on `build-ipadmonitor.ps1`:

1. Verify Docker Desktop/container; print `sw_vers`, `xcodebuild -version`, `xcrun --sdk iphoneos --show-sdk-version`, and `df -h`. **Use the current Xcode/iOS 18.0 SDK; do not upgrade or modify the container.**
2. **Stage prompts before rsync:** copy the reviewed prompt set from `C:\Users\Meeoowz\Documents\ILC\_ILC-APP-DATA\prompts` plus `backup/test.md` and `backup/course_cheatsheet.md` into `ios-app/CourseDeck/Resources/Prompts/`. Exclude `mcp_prompt_instructions.md`, `promtps.zip`, `.DS_Store`, and `backup/` itself. Fail if any required prompt ID is missing or empty.
3. rsync `C:\Users\Meeoowz\Documents\Coding\ilc-study-tool\ios-app` → `builder@127.0.0.1:~/workspace/coursedeck-ios`.
4. In the container, run `swift test` in `CourseDeckCore` first; fail the build if core tests fail.
5. In the container:
   ```bash
   cd ~/workspace/coursedeck-ios
   xcodegen generate
   xcodebuild -list -project CourseDeck.xcodeproj   # must show the CourseDeck scheme
   xcodebuild clean archive \
     -project CourseDeck.xcodeproj \
     -scheme CourseDeck \
     -destination 'generic/platform=iOS' \
     -configuration Release \
     -archivePath build/CourseDeck.xcarchive \
     CODE_SIGN_IDENTITY='' \
     CODE_SIGNING_REQUIRED=NO \
     CODE_SIGNING_ALLOWED=NO
   cd build && rm -rf Payload CourseDeck.ipa && mkdir -p Payload \
     && cp -r CourseDeck.xcarchive/Products/Applications/CourseDeck.app Payload/ \
     && zip -qry CourseDeck.ipa Payload
   ```
6. Assert the produced IPA metadata (`DTSDKName=iphoneos18.0`, `MinimumOSVersion=18.0`) before copying it back. If the assertion fails, abort.
7. `scp` the IPA to `ios-app/CourseDeck.ipa` and `C:\macos-builder\CourseDeck.ipa`.
8. Do not embed provisioning profiles, API keys, credentials, or logs.

The `project.yml` must define an explicit shared scheme:

```yaml
schemes:
  CourseDeck:
    build:
      targets:
        CourseDeck: all
    run:
      config: Debug
    archive:
      config: Release
```

### 1.5 Build smoke test (gate before feature work)

A minimal `CourseDeck` app that:

- uses SwiftUI + one `UIViewRepresentable`
- links all six SwiftPM packages (`swift-markdown` 0.7.1 + pinned `swift-cmark`, `SwiftSoup`, `SwiftMath`, `ZIPFoundation`, `Yams`, `SwiftDraw` 0.24.0)
- includes an asset catalog, `Info.plist`, launch screen, and iPad orientations
- runs one `CourseDeckCore` unit test
- archives unsigned and produces an IPA
- **asserts `DTSDKName=iphoneos18.0`, `MinimumOSVersion=18.0`** in the IPA
- installs through iLoader and launches on the iPad

Only proceed when this round-trip works. This isolates toolchain/sideload problems from app bugs.

---

## 2. Architecture

### 2.1 Why native and not WebView

The desktop app's rendering stack is 23k LOC of Svelte/CodeMirror/KaTeX/pdfmake. Keeping it would require a WKWebView (~120–250 MB RAM) and either a JS backend or a native bridge. The light target is native:

- No WebView process, no JavaScript engine, no localhost server.
- System frameworks only for PDF viewing, networking, Keychain, Files, sharing.
- Six small Swift packages (~5–7 MB binary impact with a trimmed math font).
- The expensive, fragile parts (live-preview editor, HTML/CSS table layout) are replaced by a plain editor and a purpose-built table grid.

### 2.2 Layers

```
CourseDeck (app target)
├── App/            app lifecycle, navigation, environment
├── UI/             SwiftUI screens (library, workspace, settings, prompts, quizzes)
├── Render/         UIKit reader: block list, prose text views, table grid, images, math
├── Editor/         plain-text UITextView editor + autosave + preview toggle
├── Services/       Keychain, URLSession, share sheet, document viewer
└── Resources/      prompts, assets, privacy manifest

CourseDeckCore (local Swift package, testable with `swift test`)
├── Models/         Course, Lesson, Tab, Document, Checkpoint, Prompt, LLM card, Quiz
├── Storage/        paths, atomic files, repositories, backup/import
├── Markdown/       preprocessing, table repair/parse, math extraction, image specs, callouts
├── AI/             LLM client, SSE, queue, prompt catalog, aggregation, quiz grading
└── Ingestion/      zip/MHTML/HTML, HTML→Markdown, manifest building

CourseDeckCoreTests/
└── Fixtures/       Markdown corpora, JSON schemas, mock SSE responses
```

`CourseDeckCore` must be **Foundation-only**: no `UIKit`, PDF, Keychain presentation, or app-lifecycle code. Declare `platforms: [.iOS("18.0"), .macOS("14.0")]` (string initializers; `.v18` is absent from SwiftPM 6.0.0), inject root URLs/Keychain access, and keep UIKit/PDF in the app target. This is what makes `swift test` a real quality gate without a simulator. Use `#if canImport(UIKit)` only where unavoidable.

**Package manifest:** use `// swift-tools-version: 6.0`, `platforms: [.iOS("18.0"), .macOS("14.0")]`, and `swiftLanguageModes: [.v5]` (Xcode 16.0 ships Swift 6.0.0; the string platform initializers are required because `.v18` is absent from that PackageDescription). Set `SWIFT_VERSION = 5.0` explicitly in `project.yml`. Do not use tools 5.10 with these platform APIs.

**Concurrency:** annotate view models `@MainActor`, confine parsers/archives/network retries to actors, and use a `Sendable` block/document model. `SwiftSoup`, `ZIPFoundation`, `UIImage`, and `NSAttributedString` are not `Sendable`; never pass them across isolation boundaries. Use `@preconcurrency import` only as a documented bridge.

**App-scoped composition root:** one `AppServices` object owns the job-queue actor, backup coordinator, prompt seeding, migrations, and a **data-root generation token**. Use app-level active-scene/application state (not per-scene `scenePhase`) for job lifecycle. Before a replace-all import/swap, quiesce jobs, close/invalidate editors and file presenters, swap, then reopen; journal the swap and recover on launch. Test two scenes plus import/export while a job is running.
```

### 2.3 Reading architecture

The reader is a `UICollectionView` (or `UITableView`) backed by a block model:

- **Prose runs** — consecutive paragraphs/headings/lists/quotes rendered into one selectable `UITextView` (TextKit 2). This preserves selection across paragraphs without one view per paragraph.
- **Tables** — a dedicated `TableGridView` with virtualized rows, measured columns, per-table horizontal scrolling, header styling, alignment, multiline cells, and a long-press “Copy as TSV” action.
- **Images** — async, downsampled, aspect-ratio placeholder, tap for the full-screen viewer.
- **Math** — SwiftMath-rendered images/views cached by TeX + size + theme, with TeX copied via a custom attribute.
- **Callouts/details/USERNOTE** — styled container sections with child blocks; details and notes are collapsible.
- **Code blocks** — fenced (``` and `~~~`) and indented code; monospaced, horizontally scrollable, preserved verbatim.
- **Task lists** — GFM `- [ ]` / `- [x]` with a native checkbox and write-back to the source Markdown (if toggles are enabled); otherwise render read-only and say so.
- **Thematic breaks** — horizontal rules, including the section dividers inserted by chunking.
- **No raw HTML execution** — whitelisted inline tags (`br`, `sup`, `sub`, `mark`, `kbd`, `span` without style); raw HTML tables are parsed into a table block where possible, otherwise flattened with a visible warning.

**Table layout decision (authoritative):** use **option (b)** — a fixed-height table viewport with inner scrolling, explicit gesture arbitration, and an “Open table” full-screen route. This handles 500-row ledgers without a custom outer layout.

- Viewport height policy: tables up to N rows render full height; larger tables cap at ~480 pt and scroll internally.
- Gesture handoff: when the inner table is at its top/bottom, hand vertical scrolling to the outer reader; horizontal scrolling stays inside the table.
- Persist horizontal and vertical offsets per table across cell reuse and reader scrolling.
- Full-screen table route restores the same offsets and selection.
- Selection/copy model: per-cell text selection plus long-press Copy cell/row/TSV; do not promise cross-table drag selection.
- Phase 0 measures this exact design on the 500×5 ledger; do not reintroduce a custom flattened-row layout unless the gate fails.

**Prose run sizing:** do not put an entire 99 KB lesson in one self-sizing `UITextView`. Chunk prose runs at block boundaries or ~20–40 KB, compute heights off-main, avoid `automaticDimension` with `UITextView`, and invalidate on width/content-size change. Add a 99 KB fixture and measure on the oldest supported iPad.

Tradeoff: selection does not span from a paragraph into a table cell. Ask-AI is out of scope, so this is acceptable, but add find-in-document and “Copy section as Markdown” so study workflows do not regress. The design keeps the door open to a single TextKit 2 document later if cross-block selection becomes a requirement.

### 2.4 Editing architecture

- `UITextView` with a monospaced font, TextKit 2, undo, find/replace, keyboard shortcuts, Scribble/Pencil.
- **Disable smart punctuation and autocorrect:** `smartQuotesType = .no`, `smartDashesType = .no`, `smartInsertDeleteType = .no`, `autocorrectionType = .no`. Otherwise Markdown/LaTeX is silently corrupted.
- No live preview; a toolbar toggles Reader ↔ Editor.
- Debounced autosave (2–5 s) with atomic temp-file + rename. Save on `scenePhase` background and `viewWillDisappear`; never rely on the debounce alone.
- Before saving, compare the on-disk modification date/hash; if the file changed externally (Files app, another scene), offer reload/overwrite. Do the compare-and-swap **inside one `NSFileCoordinator.coordinate(writingItemAt:options:.forReplacing)` block**: re-read the current version, compare the hash, write a temp file, replace, keep a `.bak`. Register an `NSFilePresenter` for the open document. Test two scenes and a Files-app edit.
- Custom tab creation, deletion (two-step confirmation + trash/undo/snapshot), slug validation, deep-link auto-create (confirmation for external links), and lesson-navigation fallbacks are ported from `tabs.ts` / the desktop workspace.
- **Per-document serialization:** editor saves and AI/queue writes go through the same repository actor. Before a generation overwrite, check for a dirty editor; prompt/merge rather than silently overwriting unsaved changes. Test an open editor + background generation.

---

## 3. Data contracts

### 3.1 Layout (mirror the desktop exactly)

```
<container>/Library/Application Support/CourseDeck/   # live mutable root; not user-browsable
  courses/<courseId>/
    meta.json
    checkpoint.json
    <lessonId>.lesson.md
    <lessonId>.summary.md
    <lessonId>.cheatsheet.md
    <lessonId>.test.md
    <lessonId>.<customTab>.md
    <NN>.unit.<tab>.md
    course.<tab>.md
    <lessonId>.popquiz.<timestamp>.md
    assets/img|icons|locker_docs/
    _backup/            (imported raw packages; excluded from backup by default)
    attempts/           (new: local quiz attempts, one JSON per attempt)
  prompts/<promptId>.md
  llm_config.json       (cards without plaintext keys)
  .jobs.json            (durable generation journal)
```

- **Files exposure is limited:** the live root is in Application Support. Expose only `Documents/Import Inbox` (user drops backups/zips here) and `Documents/Export` (share-sheet/destination). `UIFileSharingEnabled` + `LSSupportsOpeningDocumentsInPlace` apply to those, not the live root.
- Import/export via document picker, security-scoped URLs, share sheet.
- **Audit the entire `Documents` tree on every foreground activation and before any course load/backup export/import** (`UIFileSharingEnabled` exposes all of Documents, not just the two subfolders): quarantine denylisted files, migrate `llm_config` keys, reject traversal. The data root is untrusted.
- Set `NSURLIsExcludedFromBackupKey` on internal state (`.jobs.json`, `attempts/`, caches) and on `_backup/` raw packages (~361 MB live); document that quiz attempts and raw packages are excluded from device/iCloud backup but `attempts/` is included in app export, while `_backup/` is included only with “include raw packages.” Cover this in first-run consent.
- No arbitrary data-directory setting; the app container is the data root.
- Flat files remain the source of truth; no database.
- Atomic writes for every mutable file. Serialize writes per course with an actor.

### 3.2 Compatibility

- **Semantic compatibility, not byte compatibility.** `meta.json`, tab filenames, frontmatter, checkpoints, prompts, and quiz Markdown must round-trip through the desktop, but YAML re-serialization will not be byte-identical.
- Preserve unknown JSON/YAML keys and field order. The full `meta.json` schema includes `id, title, grade, level, description, updatedAt, archived, units[]`; each lesson includes `id, code, title, unitNumber, lessonNumber, type, hasFull, hasSummary, hasCheatsheet, hasTest`. The desktop also injects `path`/`courseDocs` at read time; those are not persisted.
- Frontmatter is ordered untyped YAML. Update only known keys; preserve `activityCode, courseId, unit, unitNumber, lessonNumber, savedAt, contextAttachment, preferences, lastAttemptDate, score, totalQuestions, percentage, course, lesson, timestamp, createdAt`, and any user-defined key.
- Desktop backups import directly (zip paths are relative to the data dir). **Allowlist/passthrough:** `courses/`, `prompts/`, `lessonProgress/`, `attempts/`, and non-secret root metadata. **Denylist:** `.google_credentials.json`, `.arc_credentials.json`, `.mcp-token`, `.jobs.json`, `.cleanup_queue.json`, `backend.log`, `llm_config.json.bak*`, `.DS_Store`, and `_backup/` unless explicitly requested.
- **Do not refuse a whole desktop backup because it contains denylisted files.** A normal desktop backup includes `llm_config.json` with plaintext keys and the files above. Import the allowlisted entries, skip/quarantine the denylisted ones, and report what was skipped. Refuse only structural corruption, zip-slip, or zip-bomb conditions.
- Export produces the same layout **except `llm_config.json` is omitted entirely**; export only `llm_ios.json` (card metadata without keys). A sanitized `llm_config.json` in an iOS export would overwrite the desktop’s plaintext keys on desktop restore. Desktop import must merge/preserve existing keys or ignore the iOS config. `_backup/` excluded by default with an “include raw packages” option. No insecure plaintext key export. **No backup encryption in v1** (ZIPFoundation cannot do it); if encryption is needed later, wrap the archive with CryptoKit AES-GCM and a versioned header.
- **Key migration happens in Phase 1, before any plaintext key is written.** Imported desktop keys are parsed in memory, written to Keychain, and then the JSON is rewritten without keys. If Phase 1 cannot do that, discard imported keys and require re-entry.
- **Checkpoint schema is a top-level JSON array** with `{id, file, verticalPosition, type, date, color?, noteText?, anchorBlockID?, anchorFraction?}`. Preserve imported desktop values. For new iOS checkpoints, `verticalPosition` = **cumulative measured pixel height of all preceding blocks + `anchorFraction × current block height`**, updated after layout; not a block index. Add a desktop visual-resume test for a late block.
- **Stable block IDs:** `anchorBlockID` is deterministic — a stable AST path (heading slug + ordinal within section) or normalized-content hash + occurrence index — and survives reparse and small edits. Test anchor survival after reparse and an unrelated edit.
- **`dataVersion.json`** (root, explicit filename) stores `{version, appVersion, migratedAt}`; idempotent migrations handle `anchor*`, `attempts/`, settings extension fields, and the job journal. Snapshot before migration. **If the version is newer than the app supports, or the file is unreadable/corrupt, fail closed: open read-only, block writes/generation/import commit, and require upgrade/export.** Never treat an unreadable version as old.
- **Context-attachment tokens are canonical and exact:** `lesson - lessons`, `lesson - summaries`, `lesson - cheatsheets`, `unit - lessons`, `unit - summaries`, `unit - cheatsheets`, `course - lessons`, `course - summaries`, `course - cheatsheets`. Any other value is rejected or mapped; desktop `getPromptContext` uses exact string matching.
- **iOS-only LLM card extensions** (`maxTokens`, `thinking`, capability flags) live in a separate `llm_ios.json` keyed by card ID, not in `llm_config.json`; desktop normalization drops unknown fields. On desktop roundtrip, accept defaults or re-apply the iOS extension.

### 3.3 Path/ID rules (ported exactly)

- Course/lesson/prompt ID: `^[a-z0-9][a-z0-9._-]{0,63}$/i`, reject `.` and `..`.
- Tab slug: `^[a-z0-9][a-z0-9_]{0,31}$/`, lowercase only.
- Unit scope: `NN.unit`, files `NN.unit.<tab>.md`.
- Course scope: `course.<tab>.md`.
- Tab filename: `<lessonId>.<tab>.md`.
- Reserved tabs: `lesson`, `notes`, `summary`, `cheatsheet`, `test`, `schedule`, `course`, `assignments`, `popquiz`.
- Path containment: resolve and verify the result stays inside the data root (not string stripping).

---

## 4. Subsystem plans

### 4.1 Storage and repositories

- `CourseRepository`: list/read/patch manifests, lesson bundles, tab discovery, save/delete tabs, course docs, prompt contexts, aggregation, checkpoint CRUD. Scheduling/mark-done is not part of v1.
- `PromptRepository`: active + bundled fallback, first `#` title, auto-seed, protected IDs, custom prompt slugs.
- `SettingsStore`: theme, AI cards, backup preferences, storage info; JSON with atomic writes.
- `JobStore`: durable queue journal with states `queued/running/succeeded/failed/cancelled/interrupted`, full task inputs, retry metadata, timestamps, and explicit interrupted/retry-on-launch (never a false “resume”).
- `BackupService`: streamed ZIP export/import with `ZIPFoundation`; zip-slip guard; per-file staging; no whole-archive `Data`; progress/cancel. Allowlist/passthrough and denylist are defined in §3.2. **Skip/quarantine denylisted entries and import the rest; do not refuse a normal desktop backup.**
- **Never extract plaintext keys to staging.** Read `llm_config.json` from the archive stream in memory, write keys to Keychain, and write only sanitized JSON to staging. Assert no key pattern in staging/temp/journals; test an interrupted import.
- **Include-raw secret scan:** the live `_backup/` folders contain 79 ZIPs and 29 MHTML captures. A path-only denylist is insufficient. **Recursively content-scan nested archives/MHTML for key patterns with explicit bounds** (entry count, decompressed size, timeout). **Never mutate live data during export:** if a capture cannot be scanned within bounds, fail the include-raw export with a report or require an explicit user exclusion; do not silently skip it. Test a capture that trips a bound.
- **Export atomicity:** before building the archive, **await all dirty editor saves and quiesce generation writes**; then write the temp archive inside the destination directory (or a document-picker temp URL) and use `replaceItemAt`/`NSFileCoordinator`; verify size/CRC; delete partial files on failure. A cross-volume `moveItem` is copy-plus-delete, not atomic.
- **Free space:** require enough for the existing library + timestamped snapshot + staging + archive (roughly 3–4× the library), not just 2×. Prefer a rename-based snapshot and atomic directory swap over full copies. Fail early.
- Restore modes: **merge-by-default** (per-type policy below), replace-all with an automatic timestamped snapshot, and course-scoped import. Stage, validate, then commit atomically. Never leave a half-merged library. **Merge gets the same quiesce/compare-and-swap/journal/launch-recovery contract as replace-all**; test a kill during merge and an open editor/job.
- **Replace-all preservation:** a default export has no `_backup/`, and an iOS export has no `llm_config.json`; replace-all must preserve local-only `_backup/`, `llm_ios.json`, `attempts/`, `.jobs.json`, and unknown files unless the user explicitly opts to drop them. Warn before any local-only data would be removed; test a default-export replace-all.
- **Per-type merge policy:** local `meta.json` wins, but imported units/lessons are unioned and units never shrink — **union only lessons with at least one content file (lesson/summary/cheatsheet/test) or mark them as missing**; **course content files (`*.lesson.md`, `*.summary.md`, `*.cheatsheet.md`, `*.test.md`, `course.*.md`, `unit.*.md`, pop quizzes) local wins — only missing files are imported, and differing files go to `_conflicts/` with a hash/diff; replace-all only by explicit user choice**; **assets/ local wins, missing imported, differing binaries to `_conflicts/` with hashes**; **position checkpoints merge by `file` (one per file; local wins; import only if no local position)**; **note checkpoints union by ID (local wins; differing notes go to `_conflicts/`)**; LLM cards merge by ID/endpoint; prompts local wins unless the user chooses “replace bundled defaults”; `attempts/` skip-existing/local-wins; unknown/orphan files are preserved. **Active files use local-wins, but every conflict also gets a copy under `_conflicts/` with a summary UI** — never silent discard.
- Harden the archive: entry-count/size/compression-ratio limits (zip-bomb guard), stage in Application Support/temp, delete the archive after import. **No passphrase encryption in v1.**
- **Files-sharing bypass:** the live root is in Application Support; only `Documents/Import Inbox` and `Documents/Export` are intended drop zones, but `UIFileSharingEnabled` exposes the entire `Documents` tree. Audit the **whole Documents tree** on every foreground activation and before any course load/backup export/import; quarantine denylisted files anywhere and migrate `llm_config` keys. Test a backup unzipped at the `Documents` root while the app is running.
- Corruption handling: on `checkpoint.json`/`meta.json`/prompt parse failure, quarantine the file with a timestamp, keep a `.bak`, surface a recovery UI, and refuse to save empty state over corrupt data.
- Preserve unknown/orphan files on import/export (`summary-2`, `sum2`, `lessonProgress/`, legacy tabs) and document that they are not rendered as valid tabs. Do not silently delete them.

### 4.2 Markdown preprocessing (exact order)

1. Strip frontmatter (display only; editing keeps it).
2. Normalize Pandoc `{width=...}` image attributes to pipe syntax.
3. Rewrite `assets/` references to local file URLs (native, not API URLs).
4. **Protect code, TeX, and MathML before any table work:** replace triple-backtick/`~~~` fences, 4-space indented code, inline backticks, `<pre>`, `$...$`/`$$...$$`/`\(...\)`/`\[...\]` spans, and `<math>...</math>` subtrees with placeholders. This must happen before table repair so pipes inside math/MathML cannot split cells.
5. Extract GFM callouts (`NOTE/TIP/IMPORTANT/WARNING/CAUTION`). Each callout body runs the full preprocessing recursively (protect → repair → parse).
6. Extract `[!USERNOTE]` cards, target comments, and anchors. Each note body runs the full preprocessing recursively.
7. Repair tables on the placeholder-protected document.
8. Parse blocks.
9. Restore math tokens and render with SwiftMath.
10. **MathML pass:** real MCR3U lessons contain ~246 `<math>` tags, many inside raw HTML tables. Convert `mi/mn/mo/mrow/msup/msub/mstyle/mspace` **plus `mfrac/msqrt/mroot/mtable/mtr/mtd/mover/munder/munderover/mfenced`** to text or TeX; if a tag is unsupported, preserve its flattened text rather than dropping the subtree. Note the real element names are `msup`/`msub`, not `sup`/`sub`. This conversion must run **before** raw-HTML table parsing/sanitization, not after. Add MCR3U `01.03`/`01.06`/`04.09` fixtures (they contain `mfrac`/`msqrt`/`msup`) and a pipeline-level “no MathML text loss + fractions/roots render correctly” gate.
11. Inject USERNOTE cards and anchors.
12. Sanitize/drop unsupported HTML.

Order-sensitive fixtures must cover code/math inside tables, callouts, and USERNOTE bodies.

Port the exact regex/semantics, but fix the known defects listed in §6.

**swift-markdown parity:** disable smart quotes/dashes (`ParseOptions.disableSmartOpts`), convert soft breaks to hard breaks (desktop `breaks: true`), and add autolink handling. Use swift-markdown’s GFM table AST only for already-valid tables; keep the custom repair pass for malformed/stacked tables. Compare a fixture corpus against the desktop output.

### 4.3 Complex tables and ledgers (essential)

**Parsing / repair**

- Port `splitTableCells` (escaped `\|`, outer pipes optional, empty cells preserved).
- Port delimiter detection (`:?-{3,}:?`), alignment capture, header backward scan, body forward scan, stacked-table separation, blockquote/indent prefixes.
- Collapse multiline headers/cells into one row with `<br>`.
- Preserve surplus cells instead of truncating. If a row has more cells than the header, either extend the grid with extra columns or render an overflow row; never silently drop ledger data.
- Protect **all** code forms (triple-backtick fences, `~~~` fences, inline backticks, indented code, `<pre>`) from table repair and math extraction.
- Treat pipe characters inside `![alt|size](url)` and `$...$` as content, not delimiters.
- Merge a multiline header even when the last physical line already has the full pipe count.
- Separate stacked tables when a following delimiter has a different column schema.
- Preserve header-only tables, empty cells, escaped pipes, alignment, and inline formatting.
- Do not synthesize a header for headerless Markdown. Raw HTML tables with `colspan/rowspan` are parsed into a richer table model where feasible; otherwise flatten with a warning.
- **No-outer-pipe tables:** the desktop header/body scanners require `colCount + 1` pipes. For tables written as `A | B` / `--- | ---` / `1 | 2`, compute the expected pipe counts for 0, 1, and 2 outer pipes in both scans; test 2-, 3-, and 5-column variants, including ragged rows.
- **Math spans before cell splitting:** protect only spans that pass the math heuristic **or** a pipe-containing absolute-value form (`$|x|$`); never pair two currency cells (`| $1,500 | $2,000 |`) into one protected span. A protected token must not contain a cell delimiter. Add fixtures for `| $1,500 | $2,000 |`, `| $1,500 | $x$ |`, and no-space variants.
- **All code forms:** a shared placeholder extractor must protect triple-backtick fences, `~~~` fences, 4-space indented code, inline backticks, and `<pre>` before table repair and math extraction, then restore afterward. **The ported table repair must not treat protected code as a table terminator:** remove/relax the `%%%TABLE_CODE_` stop conditions or use a distinct token namespace, so a multiline row with inline code is still merged. Add the multiline inline-code fixture.
- **Cell inline AST:** define rich cell content (bold, italic, strikethrough, inline code, links, math, images, `<br>`), not plain text. Render it selectably in the table grid and preserve it for copy/TSV.

**Rendering**

- `TableGridView` with measured column widths:
  - intrinsic min/max width per column from a **bounded sample** (header + first N rows + longest unbreakable tokens/p95), not all 2,500 cells up front
  - refine provisional widths off-main without visible reflow; cache per width/font
  - fit-to-width when possible; otherwise per-table horizontal scroll
  - minimum column width; numeric/currency columns right-aligned when alignment says so
  - header background, row separators, outer border, 12 pt/8 pt cell padding
  - multiline cell text; `<br>` is a hard line break
  - empty cells occupy their column
  - header-only tables render only the header
  - images constrained to cell width/height; math inline; display math may widen the column
  - long cells wrap, never truncate
  - large-ledger rows use the fixed-height viewport + inner-scroll design (option b); keep copy/selection complete
  - long-press menu: Copy as TSV (header included), Copy row, Copy cell
- **Accessibility:** expose the table as an accessibility container with row/column counts, header associations, cell coordinates, and `accessibilityScroll` for the inner table; provide an accessible “Open table” full-screen route. Test with VoiceOver at large Dynamic Type.
- A single table renderer is shared by reading, quiz rationale, and prompts preview (read-only). PDF export is out of scope.

**Test corpus**

The repo's `tableRepair.test.ts` has 8 tests; the 25 cases from the exploration were never checked in. **Author a new checked-in corpus** under `CourseDeckCoreTests/Fixtures` with input and expected block model, including:
- 2-column journal header + 5-column ledger (stacked tables)
- multiline rubric headers and cells
- escaped pipes, including in headers
- blockquoted/nested/indented tables
- header-only, same-column stacked, three stacked
- 5-column ledger with empty P.R./Credit cells
- no-outer-pipe 2-, 3-, and 5-column tables, including ragged rows
- currency in cells (`$1,500`, `$45,000`)
- math in cells (`$|x|$`)
- image sizing pipe in a cell
- `~~~` fence, indented code, `<pre>`, inline code in a multiline row, complete multiline header
- surplus cells (must not drop)
- CRLF input
- raw HTML table
- long/wide ledger with 500 rows (performance)
- generated-content tables (AI output often omits outer pipes)

### 4.4 Math

- Port the exact five delimiters (`$$`, `\[`, `\(`, `$`, parenthesized) and the currency heuristic, including keywords and the `5k/2m/3b` rejection.
- Protect code before extraction.
- SwiftMath for rendering. Upstream bundles 12 fonts (~7.1 MB); “trim to one” requires vendoring/forking the package to keep only Latin Modern (~0.73 MB) and its GUST license. Otherwise accept the full bundle. **SwiftMath 1.7.3’s `MTMathImage.asImage()` returns `(NSError?, MTImage?, LayoutInfo?)` with public ascent/descent**, so use that off-main; `MTMathUILabel.displayList` is main-thread layout only. Fall back to a fixed inline line height if `LayoutInfo` is unavailable. Add a custom `NSTextAttachment` with an accessibility label and TeX copy override; scale/scroll display math wider than the column.
- Unsupported commands show raw TeX in a secondary color; never drop the expression.
- Inline math baseline-aligned; display math centered; TeX copy/accessibility label.
- `\ce`, `\pu`, `\require`, and custom macros are future work; design `MathRenderer` as a protocol so mhchem/KaTeX can be added later.
- Fix the desktop bugs: math pipes inside table cells, math in image alt text, math tokens in raw HTML attributes.

### 4.5 Images, callouts, details, USERNOTE

- Image specs: pipe syntax, Pandoc syntax, named presets, `width/height`, last-pipe precedence, icon detection, captions, default max height 480 pt, icon max height 32 pt.
- Asset paths resolve inside the course `assets/` folder; missing assets show a placeholder with alt text.
- Full-page viewer: native image zoom/pan and PDF viewing via PDFKit/Quick Look; return to the same scroll position.
- Callouts: exact types and body semantics; caution gets a proper critical style.
- `<details>/<summary>`: collapsible block, default closed.
- USERNOTE: render the amber card, query, target preview, body, and anchor highlight; no create/delete UI. If the target quote is not found, show the card without an anchor.
- **Protect USERNOTEs on every overwrite path:** AI generation, bulk generation, ingestion/replace, and manual replace. Extract existing `[!USERNOTE]` blocks before writing, merge them back by target/paragraph, or block with an explicit count/warning. Always snapshot the previous file. Live BAF3M lessons/summaries already contain USERNOTEs; losing them is irreversible because creation is not ported. Add an ingest-overwrite USERNOTE fixture.
- **SVG:** `UIImage` cannot decode disk SVG. Use SwiftDraw (or convert SVG→PNG at ingest/import) and cache rendered results; test real `assets/icons/` SVGs in the reader. **Repair quoted-printable-encoded SVGs** (11 live BAF3M icons contain literal `=3D`) before decoding, or show a placeholder. If intentionally dropped, list it as an exclusion with a visible placeholder.
- Inline HTML whitelist; drop scripts/styles/iframes/forms and event handlers. Remote images are blocked or require explicit confirmation; local course assets load by default.

### 4.6 Reading performance

- Parse/repair off the main actor; cancel work when the document changes.
- Group prose into runs; virtualize blocks; lazy-load images and tables.
- Cache table measurements per width/font; invalidate on rotation/Dynamic Type.
- Downsample images to display size; cap the image cache.
- Target: first viewport within ~150 ms after data is available; 60 fps scrolling on a 100k-character document; no full-document reparse on scroll.
- Test on the oldest supported iPad, not only the newest.

### 4.7 AI provider and client

- Provider store: cards `{id,label,provider,baseUrl,model,authHeaderType,temperature,timeoutSeconds,maxTokens,thinking,sendSessionId,hasKey}`; one active card.
- Default DeepSeek card:
  - base URL `https://api.deepseek.com`
  - model `deepseek-flash`
  - **Bearer auth.** Note: the live desktop card currently has `authHeaderType: "api_key"`, which DeepSeek will likely reject. Normalize known DeepSeek hosts to Bearer after a live capability test; preserve custom header types for other hosts.
  - `max_tokens` 16,384–32,768 for 12–24-question exams
  - `thinking: {"type":"disabled"}` for speed; user can enable it
  - `stream: true`, `stream_options.include_usage: true`
  - no `session_id`
  - temperature 0.3
- URL resolution: append `/v1/chat/completions` when needed; 404 fallback to `/chat/completions`.
- SSE: robust line buffering, final `data:` line, `[DONE]`, usage on the final content chunk, ignore `reasoning_content` but surface it in logs. **Accept only `[DONE]` or `finish_reason == "stop"` with non-empty content.** `length`, `content_filter`, and unknown reasons are failures/retries, never saved.
- Timeouts: separate connect timeout (e.g. 30 s) from total generation; idle/stream-stall timeout (60 s default); absolute safety cap (e.g. 900 s); no 150 s abort that defeats long streams. **Imported `timeoutSeconds` maps to the idle/stream-stall timeout (clamped), not the absolute cap**; persist the canonical value in `llm_ios.json` (iOS export omits `llm_config.json`). Test a >150 s streaming generation.
- Retries: 429/502/503/504 + network errors, `Retry-After`/jitter; 401/402/403 surfaced with actionable messages; no retry on invalid key.
- Cancellation: real `URLSession` task cancellation, not just queue removal.
- Output validation: non-empty, question count, option count, answer key coverage, required sections. Strip one outer Markdown code fence before frontmatter parsing; retry once with a larger budget or fail with a clear message.
- Keychain: `kSecClassGenericPassword`, `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`; never log keys.
- iOS-only card extensions (`maxTokens`, `thinking`, capability flags) live in `llm_ios.json` keyed by card ID; desktop normalization drops unknown fields. Do not claim desktop roundtrip preserves them.
- Multi-card: keep the card list, but only OpenAI-compatible transport. `llamacpp_native` cards are shown as unsupported on iOS (unless a later phase adds it).
- **Provider capability matrix:** `thinking`, `max_tokens` vs `max_completion_tokens`, `stream_options.include_usage`, `session_id`, and auth header type are per-provider capabilities. Do not send DeepSeek-only fields to GLM/OpenAI/local servers. Version the card extension so desktop roundtrip preserves unknown/extra fields.
- **ATS/LAN:** add `NSLocalNetworkUsageDescription` and `NSAllowsLocalNetworking` (or a scoped exception) if LAN providers are supported; otherwise list local providers as unsupported. Test the user's GLM card at `https://opencode.ai/inference/openai/v1/` and a LAN LM Studio card.
- **Key endpoint binding:** store each key against card ID + normalized base URL; changing the endpoint clears/requires re-entry. Never forward a blank key to a different host.
- **Keychain merge/deletion:** local key wins by default with an explicit “replace with imported key” prompt; delete the Keychain item on card deletion or endpoint change; audit orphan items; test a merge where both sides have a key.
- **Privacy/logging:** first-run consent naming DeepSeek/GLM, what course/notes/answers are sent, and data-residency/retention caveats. Redact keys, prompts, answers, and completions from all production logs; verbose logging is opt-in, capped, and excluded from backups. No analytics.

### 4.8 Prompt catalog and context aggregation

- **Stage prompts before rsync.** The active prompt root at `C:\Users\Meeoowz\Documents\ILC\_ILC-APP-DATA\prompts` has `summary`, `cheatsheet`, `popquiz`, `unit_assignments`, `unit_test`, `course_summary`, `course_test`, `course_schedule`, but **not** `test.md` or `course_cheatsheet.md`; those exist only in `prompts/backup/`. `test_kica.md` is absent entirely.
- Copy the active set plus `backup/test.md` and `backup/course_cheatsheet.md` into `ios-app/CourseDeck/Resources/Prompts/` before rsync. Exclude `mcp_prompt_instructions.md`, `backup/` (after extracting the two files), `.DS_Store`, `promtps.zip`, and `.mcp-token`.
- **Do not blindly overwrite schema fixes every build.** Keep a reviewed prompt override set in the repo (or apply the count/schema patches deterministically in the staging script) and verify hashes/counts in the manifest. The build must fail if staging would reintroduce the 2+2 schemas.
- Add a **required-prompt manifest** to the build: fail if any required ID is missing or empty, and record **expected question counts/ranges** per prompt. **`lesson` and `test_kica` are protected-if-present but not required**; the staged set does not include them. **Edit the staged prompt files so their schema examples show the full requested counts**: `test.md` requests 6 MC + 4 FIB but its schema shows 2+2; `course_test.md` requests 12 MC + 4 multi-part but schemas show 2+2. The manifest must enforce the same counts the prompts request; do not rely on widened validation. **Generated course tests are 12 MC + 4 multi-part (16 total).** The 10/24-MC and 0/8-multi-part variants are read-only parser fixtures only, not generation targets. Add fixtures for lesson test (6 MC + 4 FIB and the existing 8-MC variant), course test (12+4 generated; 10/24 read-only parser), unit test (12), and pop quiz (6). Treat `test_kica.md` as optional; the app falls back to `test.md` for practice tests.
- Seed into the app's `prompts/` on first launch only if missing; never overwrite user edits. Track provenance (bundled default vs user-edited) and content hashes; on backup import offer “replace bundled defaults, preserve user edits” with a diff, and provide a per-prompt “Restore default.”
- Allow importing prompts from a desktop backup; allow editing/creating/deleting except the protected built-ins: `course_summary`, `course_cheatsheet`, `course_schedule`, `course_test`, `summary`, `cheatsheet`, `test`, `test_kica`, `lesson`, `popquiz`, **`unit_assignments`**, **`unit_test`**. Test deletion protection and unit regeneration after an attempted deletion.
- Preserve desktop behavior: **no `{{...}}` interpolation**; prompts are static system prompts and content is a separate user message.
- Store `prompt` + `contextAttachment` in generated frontmatter; PromptCard diff/reset uses that.
- **Explicit context matrix (fixes the desktop ambiguity):**
  - **Lesson tabs:** default to the raw lesson body (media-stripped); curated/attachment content only when selected.
  - **Unit tabs:** aggregate **all lessons in the unit** (frontmatter/media stripped) with **3,000 chars/lesson and an 80,000-char total budget**; fall back curated → raw when summaries/cheatsheets are missing. Desktop `unit - lessons` is unbudgeted; iOS must bound it. Test first-time, no-curated, and the largest live unit (MCR3U unit 4, ~375 KB raw).
  - **Course summary:** curated lesson summaries → cheatsheets, 3000 chars/lesson.
  - **Course cheatsheet:** curated cheatsheets → summaries, 2500 chars/lesson.
  - **Course test:** curated summaries → cheatsheets, 2200 chars/lesson, plus existing lesson question coverage (max 10 questions, 8 lines, or 1500-char fallback).
  - A 50-character payload gate with a clear error.
  - **First-time course docs:** if curated coverage is below a threshold (or only “Not yet generated” stubs exist), do not silently send stubs. Offer an explicit “generate lesson summaries first” flow. Raw-lessons generation is not exposed for course docs in v1. Test a fresh course with no curated content.
  - **Course-doc selector mapping:** `course.summary` → `course - summaries`, `course.cheatsheet` → `course - cheatsheets`, `course.test` → curated summaries + question coverage. Hide/disable `course - lessons` for course docs in v1. The preview/char count must call the same `buildAggregatedPayload` used for generation, not `getPromptContext`. Document the intentional divergence from the desktop’s unbudgeted default. (Raw-lessons generation is not exposed for course docs in v1.)
- Port `getPromptContext` and `buildAggregatedPayload`; do not conflate them. **Decision:** course docs always use the budgeted curated aggregation matrix above; this intentionally diverges from the desktop’s unbudgeted `getPromptContext` default. Document the divergence and test the exact course-test payload for first-time, no-curated, and large-course cases.
- Course docs: summary/cheatsheet/test; prompt `course_<type>` → `<type>`; cached unless force; sync or async with a durable job.

### 4.9 Generation queue and flows

- Durable queue (JSON journal) with one worker per priority lane. The desktop `.jobs.json` record stores no inputs; the iOS record **must** store `courseId`, `lessonId`, `tab`, `lessonTitle`, `customPrompt`, `customContent`, `contextAttachment`, `preferences`, active-card policy, attempts/backoff, and partial output. Without this, a relaunch cannot faithfully regenerate a task.
- Task identity: `<courseId>:<lessonId>:<tab>`; dedupe pending/running; replace completed/failed. Scheduling tasks are out of scope.
- States, progress, logs, retries, pause/resume/cancel, per-task timeout, active-model-at-execution.
- **No false “resume.”** A streaming `URLSession` request cannot resume after suspension. On background, cancel and mark interrupted; persist inputs + partial text for diagnostics; on foreground, offer explicit “retry” or “discard.” Never mark a truncated stream completed.
- Separate priority lanes (or a second worker) for unit-test grading and pop quizzes so a long course-wide generation cannot block them.
- Foreground-first: iPadOS 18.x has no `BGContinuedProcessingTask` (that API is newer). Disable the idle timer and show a “keep app open” banner during generation. Do not promise background completion.
- Completion sentinel: success only on `[DONE]` or `finish_reason == "stop"` with non-empty content. `length` triggers a larger-budget retry; `content_filter` and unknown reasons fail; a missing terminator or stream error is failed/interrupted and never overwrites a good file. Accept usage-only chunks separately.
- Lesson/unit tab generation: prompt selection (`unit_<tab>` → `<tab>`), custom prompt/content/attachment, source extraction with media stripping, save frontmatter, ignore `lesson` generation.
- **Overwrite safety:** before any AI, bulk, or re-ingest overwrite, snapshot the existing file (`.bak`/trash) and confirm when non-empty content exists. Merge existing frontmatter fields the AI output does not own — especially `lastAttemptDate`, `score`, `totalQuestions`, `percentage` on scored unit tests — instead of serializing only AI-returned frontmatter.
- Course-wide docs: async job + status polling; one-shot completed/failed delivery; stale-job handling.
- Missing-work scan: manifest lessons × requested tabs; “missing” = absent, ≤250 chars, or contains “Not yet generated”; do not scan units. **Default bulk policy: summary + cheatsheet only.** Align the UI and error message; do not claim test is supported. If test is added later, extend the bulk validation and tests together.
- Pop quiz: synchronous generate/cache/force; 300-second wall-clock deadline; local attempt persistence; no email.
- Unit test grading: deterministic MC; FIB + open-ended through the AI grader with parts/partial credit and containment heuristics as fallback; 60-second timeout; score persisted to frontmatter.
- Scheduling is out of scope; do not enqueue or enrich schedule tasks in v1.

### 4.10 Quizzes

- Port `QuestionParser`: headers, `NN)` numbering, `[Category]`, `<Multiple-Choice>`, options, answer-key forms, fill-in/short-answer inference, checked-option fallback, inline answer, duplicate renumbering.
- **Legacy FIB sections:** parse `## Fill-in-the-Blank Questions` and `## Fill-in-the-Blank Answers` (and variants), map answers by original question number **plus section index** (FIB numbering restarts at 01 after MC 01-06), and parse inline `Answer: **...**` for questions with no options. **Scan FIB sections anywhere, including after `## Answers`** — 81 of 85 live lesson tests place them there. Apply the section-index rule before duplicate renumbering. Update the ported desktop expectation that FIB-after-answers is ignored. Add live fixtures (MCR3U/GWL3O 6-MC+4-FIB).
- **Multiple answer sections:** a course test may restart numbering and put short-answer answers in a separate `## ... Answers` / `### ... Suggested Answers` section. Scope each answer section correctly (do not pair MC answers with SA questions), preserve original numbers plus section index, and never truncate at the next `##`/`###`. Require a non-empty answer for every question; add BAF3M 24-MC+4-SA, GWL3O/MCR3U 12-MC+4-SA, and CLU3M 6-MC+4-FIB fixtures.
- **Pop-quiz discovery/persistence:** existing `<lessonId>.popquiz.<timestamp>.md` files (13 in the live library) are listed/loadable per lesson, included in backup/restore, and timer-resumed. New quizzes are **written to the course directory** with the same filename pattern (timestamp collision handling), not kept in memory only. Add generate → relaunch → load → export test. **A cached quiz that parses to 0 questions** (one live file is a table) shows a clear corrupt-quiz error with “regenerate” rather than a vacuous pass. Reserve `popquiz` as a custom-tab name; add fixtures.
- Extend MC answer letters to A–Z while keeping compatibility. This requires changing **all four** A–D regexes (answer key, option letters, prefix stripping, inline answer), not just option generation. Add 5-/6-option tests, bold/dash E–Z answers, and checked fallback.
- Practice tests and course tests are **read-only**; unit tests are interactive; pop quizzes are timed.
- Unit-test submit: MC exact; **fill-in-the-blank goes through the AI grader like desktop**, with normalized-containment as the fallback (not the primary path); open-ended AI grading with parts; heuristic fallback; partial credit; persist `lastAttemptDate`, `score`, `totalQuestions`, `percentage`; never persist raw answers in the test document. **In-progress answers persist as a private draft (Application Support, excluded from device backup) and restore on relaunch; the draft is deleted after submit.** Document any deliberate deterministic-scoring divergence.
- Pop-quiz submit: deterministic grading; persist attempt locally (new `attempts/` store) with timestamp, answers, score, duration, timed-out flag.
- Timer: persist `{contentHash, deadline, answers, score, duration, timedOut}` per pop-quiz timestamp; recompute the remaining time from the absolute deadline on `scenePhase`; no bare `Timer` reliance. Reloading the same timestamp offers “resume” or “Try Again”; only “Try Again” clears the deadline. Cached content is keyed by timestamp.
- Content hash/reset: reset answers when the test Markdown changes; preserve unrelated UI state.

### 4.11 Ingestion

- Accept `.zip`, `.mhtml/.mht`, standalone `.html` with companion folders.
- **Archive every uploaded package into `<course>/_backup/` atomically** with collision-safe names (the desktop depends on `_backup/` to rebuild units). Include it in exports only with “include raw packages.” Add a cross-platform test: ingest on iPad → re-parse on desktop → all previous lessons remain.
- **Scan imported packages for secrets** (nested archive/MHTML) before committing; after a successful import, delete/quarantine the source zip from `Documents/Import Inbox`. Test a package containing a key file.
- **Desktop compatibility patch:** the unchanged desktop `CourseIngest` still rebuilds units only from `_backup`, so a default backup (no `_backup`) + one new chapter drops lessons on desktop re-parse. Patch `courseIngest.ts` to merge existing manifest lessons when no package exists, and include that patch in the release notes. If the desktop remains untouched, scope the cross-platform test to a course with fully populated `_backup`.
- `ZIPFoundation` streaming; MHTML multipart parser (boundary, quoted-printable, base64, `cid:` mapping); SwiftSoup DOM cleaning; custom HTML→Markdown converter (port the 16 Turndown core rules + 7 GFM rules + 4 custom rules).
- Table cell `<br>` conversion, stacked-table repair, callout conversion, details conversion, asset extraction, learning-goal callouts.
- **Asset collision policy:** do not silently reuse the first `diagram.png`. Extract to unique per-package names (content hash prefix) and rewrite references, or detect content conflicts and prompt. Normalize case-only names for APFS; test two packages with the same basename.
- Image optimization with ImageIO: resize >512 px to 512, JPEG q0.82, rewrite Markdown **and HTML/absolute** references, apply the exact 360 px (`READING_COLUMN_PX * 0.5`) `|50%` threshold, collision-safe names, never break table pipes; delete originals only after all references are verified.
- Incremental rules: preserve existing lesson files unless overwrite is requested; preserve meta titles/unit names; rebuild units from packages **but merge existing manifest lessons when no package exists**. Never replace a non-empty units array with an empty one. A default desktop backup excludes `_backup`; without this merge, adding one chapter would drop every existing lesson from navigation.
- New-course flow: require a user-supplied, validated, lowercased course code; reject/confirm an existing course; no mock titles/defaults.
- Edge cases: empty/corrupt archives, missing entries, duplicate basenames, case-only collisions, no packages (warn, do not silently wipe units), failed single package, disk-full, large MHTML/HTML (benchmark 1–5 MB; handle charsets, `data-src`/`srcset`, `cid:`).

### 4.12 Schedules — out of scope (deferred)

Scheduling is not part of the initial iPad app. This includes schedule generation, `course.schedule.md` editing, mark-done, AI enrichment, Google Calendar, and ARC.

- Preserve any existing `course.schedule.md` on import/export; do not delete or rewrite it.
- **Render an existing `course.schedule.md` as generic read-only Markdown** (no schedule parser/event semantics, no generation, no mark-done, no event toggles, task-list checkboxes disabled) so schedule checkpoints and deep links are not dead ends. If no schedule file exists, do not show a Schedule tab.
- Keep `course_schedule.md` in the bundled prompt resources only for forward compatibility; it is not wired to generation UI.
- Remove schedule-specific queue identity (`<courseId>:schedule`) and schedule generation tests from v1.

### 4.13 PDF export — out of scope (deferred)

PDF export is not part of the initial iPad app.

- No PDF renderer, share-sheet PDF flow, or course-booklet export in v1.
- `course.lesson` remains the Course Navigation page, not an all-lessons aggregate; the notes aggregate (`course-docs?type=notes`) was PDF-only and is not implemented.
- If PDF returns later, use the previously designed CoreText/pagination approach; do not leave dead code or dependencies in v1.

### 4.14 Search, checkpoints, settings

- In-memory full-text index over courses/tabs; fast for ~125 lessons; no SQLite dependency. Include find-in-document for the open reader.
- Checkpoints: one position per file + notes; write **both** legacy `verticalPosition` and `anchorBlockID`/`anchorFraction`; global hub with newest-first, color/search filters, archived-course exclusion, and 60 px deep-link offset; delete; resume setting.
- Course-scope navigation: `summary/cheatsheet/test` are always valid course tabs on iOS even when the file is absent (show the generation UI); `lesson` is the virtual Course Navigation page (below); only unknown/custom tabs fall back to `lesson`. This deliberately exposes `course.cheatsheet.md`, which the desktop API serves but its UI hides.
- `course.schedule.md`, if present, renders as **generic read-only Markdown** (no schedule parser, generation, mark-done, or toggles); schedule checkpoints/deep links resolve to it. If absent, no Schedule tab.
- Unit scope is a first-class mode: `assignments`, `test`, and custom unit tabs, with default-tab fallback, create/delete, generation prompts (`unit_assignments`, `unit_test`), and deep links.
- **`course.lesson` is a virtual Course Navigation scope**, not the all-lessons notes aggregate. It has no generation CTA, creates no file, and writes no new checkpoints. Existing `course.lesson.md` checkpoint entries **keep the `file` string unchanged** (desktop compatibility) and are mapped internally to the virtual page; never delete them. The notes aggregate (`course-docs?type=notes`) was only for PDF export and is out of scope in v1.
- Settings: AI cards, prompts, storage info, backup/import, theme, image compression, about, diagnostics/licenses; no MCP/email. Define a versioned settings schema with defaults and forward migrations; note that desktop theme/resume preferences live outside the data dir and are not preserved by a backup.
- Deep links: custom scheme `coursedeck://` for course/lesson/tab; validate IDs and path containment; require confirmation for external-link auto-creation on cold launch; no Universal Links (free signing).
- Task-list toggles go through the repository actor with hash check/snapshot; disabled on `course.schedule.md` and any read-only document.

### 4.15 iPad UX

- `NavigationSplitView`: courses/units/lessons sidebar, reader detail, optional inspector for checkpoints/prompts.
- External keyboard shortcuts: next/previous lesson, search, toggle editor/preview, quiz navigation.
- Dynamic Type, VoiceOver, Stage Manager/Split View, multiple scenes.
- Apple Pencil: text selection/Scribble; optional ink annotations later.
- Share sheet, Files app, document picker, drag-and-drop import.
- No hover-only interactions; long-press/context menus replace hover toolbars.

---

## 5. Feature parity matrix

| Desktop feature | iOS plan | Notes |
|---|---|---|
| Course dashboard, rename, archive | Port | Native split view; no arbitrary folder paths |
| Upload/ingest zip/MHTML/HTML, incremental add | Port (Phase 5) | SwiftSoup + ZIPFoundation + ImageIO |
| Lesson reading, tabs, custom tabs | Port | Block reader; custom tab rules preserved |
| GFM callouts, details, math, images | Port | SwiftMath; no mhchem yet |
| **Complex tables/ledgers** | **Port with fixes** | Dedicated table grid; no data loss; horizontal scroll |
| CodeMirror live preview editor | Replace | Plain text editor + preview toggle |
| Inline autosave | Port | Atomic, conflict detection |
| AI summaries/cheatsheets/tests/custom tabs | Port | DeepSeek `deepseek-flash` |
| Course-wide summary/cheatsheet/test | Port | Explicit context matrix; `course.cheatsheet` UI exposure decision |
| `course.lesson` Course Navigation page | Port | Course home/navigation; **not** the all-lessons notes aggregate |
| All-lessons notes aggregate / course booklet | **Out of scope** | Was PDF-only; no v1 consumer |
| Prompt manager + provenance | Port | Real prompts staged from active + `backup/`; required manifest |
| Practice/course tests | Port read-only | Quiz parser |
| Unit tests + AI grading | Port | Unit scope UI; FIB grading parity; no email; local score persistence |
| Unit assignments / custom unit tabs | Port | `unit_assignments` prompt; default `assignments` tab |
| Pop quizzes | Port | 300 s wall-clock; persisted deadline; local attempts; no email |
| Teacher check-in email | **Omit** | SMTP out of scope |
| MCP HTTP/stdio | **Omit** | Desktop-only |
| Ask-AI selection annotations | **Omit creation** | Existing USERNOTEs render read-only; regeneration must merge/snapshot |
| Checkpoints + hub + resume | Port | Write both `verticalPosition` and anchor; legacy desktop compatibility |
| Schedules + AI enrichment | **Out of scope (deferred)** | Preserve `course.schedule.md`; render read-only if present; no generation/editing |
| Google Calendar / ARC sync | **Out of scope (deferred)** | Follows scheduling |
| Backup export/import | Port | Streaming ZIP; allowlist/denylist; keys omitted; conflict modes |
| PDF export | **Out of scope (deferred)** | No renderer or booklet export in v1 |
| Search | Port | In-memory |
| Image compression | Port | ImageIO |
| Theme | Port | System + light/dark |
| Desktop zoom/open folder/window state | **Omit** | Use Dynamic Type/Files |
| Deep links | Port custom scheme | No Universal Links |

---

## 6. Edge-case matrix

### Tables

- Multiline headers/cells → one row with `<br>`.
- Stacked tables with different column counts → separate tables with a blank gap.
- Same-column stacked tables → separate sections, never merged.
- Header-only table → header only.
- Headerless Markdown → literal paragraph, no synthetic header.
- Empty cells → preserved.
- Short rows → padded for layout, original count preserved.
- Surplus cells → preserved (extra columns/overflow row), never dropped.
- Escaped pipes → literal pipe in the cell.
- Pipes in math (`$|x|$`) and image specs (`![a|50%](x)`) → content, not delimiters.
- `~~~`, indented code, `<pre>`, inline code in multiline rows → protected/preserved.
- Complete multiline header → merged.
- Blockquote/nested/indented tables → prefix preserved.
- Very wide tables → per-table horizontal scroll, sticky header optional.
- Very long tables → virtualized rows; copy/export complete.
- Images/math in cells → constrained, open viewer.
- Raw HTML table with spans → rich model or flatten with warning.
- Alignment → honored (right-align numeric ledgers).
- Currency vs math → currency stays literal.

### Math

- `$1,500`, `$45,000`, `$5k`, `$2m`, `$3b` → literal currency.
- `$30^\circ$`, `$2^3 = 8$`, `$5 \times 10^3$` → math.
- `$5x$`, `$2n$`, `$a, k, d, c$` → math.
- `$a - b$`, `$a/b$`, `$1/2$`, `$speed$` → not math.
- `US$5`, `$x$2` → not math.
- `$$`, `\[`, `\(`, `(...)` → correct display/inline handling.
- Code fences/indented code/inline code → untouched.
- Unsupported command → raw TeX fallback, no crash.
- Math in image alt/HTML attributes → rendered as text/TeX, not injected HTML.
- Future mhchem → renderer protocol slot, not implemented.

### AI

- 401/402/403 → actionable message, no retry.
- 429/502/503/504 → retries with Retry-After/jitter.
- Empty completion → failure, no file overwrite.
- `finish_reason: length` → retry with larger token budget or fail.
- Usage on final content chunk → captured.
- Missing `[DONE]`/final partial line → **failure/interrupted**, never saved as success.
- Cancel → URLSession task cancelled; pending queue tasks removed.
- App background/suspend → cancel and mark interrupted; persist inputs + partial text; explicit retry on foreground; no false “resumed” or “completed”.
- Duplicate enqueue → skipped/coalesced.
- Missing active model → fail at enqueue with setup prompt.
- Corrupt `llm_config.json` → explicit error; no silent wipe.
- Missing prompt → the required-prompt manifest should make this impossible in a shipped build; at runtime show a clear configuration error and a “restore default prompt” action, not a silent generic prompt.
- Empty lesson/too-short content → clear error.
- Malformed frontmatter → treat as body, preserve output, add required frontmatter.
- Disk write failure → task failed, not “completed”.
- Stalled worker → generation token prevents double completion.
- Course doc job older than 10 min → single-flight/generation ID.
- Malformed JSON from unit-test grader → heuristic fallback.
- >4 MC options → extend to A–Z.
- Missing answer key → scoring failure surfaced, not silently all-wrong.

### Storage/lifecycle

- App killed during autosave → atomic write leaves old or new file, never partial.
- External Files edit → conflict detection.
- Concurrent checkpoint writes → serialized actor.
- Import zip traversal → rejected.
- 2 GB backup → streamed, not in memory.
- Disk full → clear error; no partial manifest.
- Missing course/lesson/tab → empty state, not crash.
- Archived course → hidden from active lists; data preserved.
- Re-ingest with no packages → **merge existing manifest lessons; never write an empty units array**. Warn before any rebuild that would drop lessons.
- Case-only asset collisions → deterministic handling.
- Prompt seed only if missing; required-prompt manifest fails the build if an ID is absent.
- API key missing → setup UI; key never logged.
- Imported DeepSeek card with `authHeaderType: api_key` → normalize/test Bearer; do not silently send the wrong header.
- Existing USERNOTE blocks in a regenerated lesson/summary → merged back or overwrite blocked with a warning; never silently destroyed.
- Checkpoint written by iOS → contains `verticalPosition` + anchor, so the desktop still reads it.
- Desktop backup containing `llm_config.json` keys and denylisted files → import the allowlisted entries, skip/quarantine the rest, report skipped files; do not refuse the whole archive.
- Replace-all with a snapshot → free space covers library + snapshot + staging + archive (3–4×), or fail early.
- Merge conflicts in `meta.json`/`checkpoint.json`/cards → per-type union/merge policy; conflicts in `_conflicts/`, never silent last-writer-wins.
- Backup unzipped directly via Files → launch-time import-inbox audit quarantines denylisted files and migrates keys.
- `lessonProgress/` and orphan files → preserved byte-for-byte on import/export.
- `course.schedule.md` exists → rendered read-only; no generation/mark-done; schedule checkpoints resolve.
- `course.lesson` → Course Navigation page, not the notes aggregate.
- Course tab with no file (`summary`/`cheatsheet`/`test`) → still valid; show generation UI, do not fall back to `lesson`.
- Unit scope → assignments/test/custom tabs reachable; unit test runner and deep links work.
- External Files edit / two scenes → coordinated compare-and-swap with conflict UI; no silent overwrite.
- Re-sign/team change/uninstall → data-loss warning; mandatory export before re-sign; install-over test.
- Missing prompt IDs (`test`, `course_cheatsheet`) → build fails; runtime shows a clear configuration error, not a generic prompt.

### UI/iPad

- Rotation/Split View/Dynamic Type → table remeasure and scroll restore.
- Backgrounding during quiz → deadline recomputed; answers persisted.
- Reload pop quiz same timestamp → cached content; timer policy explicit.
- Very long lesson → progressive layout, no main-thread freeze.
- VoiceOver → table dimensions/headers, math TeX, image alt, quiz labels.
- External keyboard → focus, next/previous, submit.

---

## 7. Testing strategy

### Core package (`swift test`, no simulator)

- Table repair: the authored corpus (not a nonexistent 25-case suite) + 500-row ledger + wide table.
- Math extraction/currency: every case in §6.
- Image specs: pipe/Pandoc/named/key-value/precedence/icon detection.
- Question parser: port `questionParser.test.ts` cases (MC, bold/dash answers, option prefixes, fill-in, checked fallback, serialization, mixed unit test), plus **required live fixtures**: MCR3U/GWL3O 6-MC+4-FIB lesson tests, the 8-MC variant, BAF3M 24-MC+4-SA course test, the 8-MC+2-FIB+2-SA unit-test output, 13 existing pop-quiz files. Assert every question has a non-empty answer.
- MathML: MCR3U `01.03`/`01.06`/`04.09` fixtures; no MathML text loss; `mfrac`/`msqrt`/`msup` render correctly.
- **Fixture provisioning:** check live quiz fixtures into `CourseDeckCoreTests/Fixtures` or stage them in `build-ipa.ps1`; fail if any required fixture is missing. Do not reuse the desktop tests’ silent-skip behavior.
- Frontmatter round-trip; malformed YAML.
- Tabs/path validation; checkpoint JSON; prompt discovery.
- Course aggregation budgets and prompt contexts.
- LLM store normalization/migration/key isolation/timeout resolution.
- SSE parser: usage on last chunk, `[DONE]`, partial line, empty stream, 429/503, `length`.
- Queue: sequential, dedupe, pause/resume, retry, cancel, restart recovery.
- Unit-test grading: MC/FIB/AI parts/partial credit/fallback.
- Schedule files: preserve `course.schedule.md` on import/export; render read-only; schedule checkpoint resolves; no generation tests in v1.
- Backup: roundtrip, `_backup` exclusion, zip-slip, streaming, **secret scan**, merge/replace modes, pre-import snapshot, interrupted restore, `lessonProgress/` + `attempts/` passthrough, desktop backup with denylisted files imports the rest.
- Ingestion fixtures: zip, MHTML, HTML+folder, incremental preservation, image rewrite, **manifest merge when `_backup` is absent**, new-course code validation.
- **Prompt manifest:** every required ID exists and is non-empty; `test`/`course_cheatsheet` sourced from `backup/`; `test_kica` optional.
- **USERNOTE regeneration:** notes survive an AI overwrite (merge/snapshot).
- **Checkpoint roundtrip:** iOS writes → desktop reads; desktop writes → iOS reads; numeric `verticalPosition` preserved.
- **DeepSeek auth:** Bearer normalization and a real/recorded 401 test for the imported `api_key` card; GLM card smoke test.
- **Table corpus:** no-outer-pipe tables, `$|x|$`, `~~~`/indented/`<pre>`, complete multiline header, surplus cells, CRLF, 500-row ledger.
### App tests

- Reader snapshot/interaction tests for tables, callouts, details, USERNOTE.
- Editor autosave/conflict/cursor preservation.
- Quiz runner timer/scoring/persistence.
- Navigation rules: lesson switch with missing custom tab; course/unit scope fallbacks; resume position; course tab with no file stays valid (including cheatsheet); unit scope assignments/test/custom tabs; `course.lesson` is the navigation page; schedule read-only; deep links.
- **SVG assets:** reader rendering of real course SVGs.
- **File coordination:** external edit/two-scene conflict detection; install-over/re-sign data preservation (manual device test).
- **AppServices/data-root generation:** two scenes + import/export while a job runs; quiesce/swap/reopen; journal recovery after a killed swap.
- File import/export via document picker (UI test or manual).
- No PDF/booklet tests in v1 (out of scope).
- Add `CourseDeckTests` and `CourseDeckUITests` targets with `TEST_HOST`/`BUNDLE_LOADER`, a scheme `test:` action, and a committed `.xctestplan`.
- Simulator runtime is an explicit optional prerequisite: if `xcrun simctl list runtimes` has no iOS runtime, fall back to manual device QA via iLoader; do not modify the container just to install one.

### Integration

- Mock OpenAI-compatible server (local URLSession stub or tiny in-process HTTP server in tests) for:
  - 24-question exam streaming
  - usage final chunk
  - truncation
  - 401/429/503
  - cancellation
  - background interruption + explicit retry
- Real DeepSeek smoke test with a tiny prompt, gated behind an env var / manual run (never commit keys).
- Device QA via iLoader on the iPad (iPadOS 18.x/18.7): install, import backup, read a BAF3M ledger lesson, generate a summary, run a unit test, re-sign after 7 days.
- The current Xcode 16.0 may not include an iOS simulator runtime. **Do not download/install one (the container is frozen).** Approved test path: `swift test` for Core plus manual device QA via iLoader. If an existing simulator runtime is already present, `xcodebuild test` with an explicit iPad destination is a bonus, not a gate. Background/suspend and install-over behavior are manual, not `swift test`.

### Performance

- 100k-character lesson: first viewport, scroll fps, memory.
- 500-row × 5-column ledger: layout/copy/scroll.
- 50 MB zip import; default backup export (~196 MB, `_backup` excluded) and include-raw export (~543 MB) to Files.
- Low-memory device warnings; image cache eviction.

---

## 8. Phases and acceptance criteria

### Phase 0 — Toolchain and sideload smoke test (2–4 days)

- Verify the existing **Xcode 16.0 / iOS 18.0 SDK**; do not upgrade or modify the container.
- Add an explicit XcodeGen scheme; generate a minimal iPad app; link all six SPM packages (`swift-markdown`, `SwiftSoup`, `SwiftMath`, `ZIPFoundation`, `Yams`, `SwiftDraw`). Pin exact tags: **swift-markdown 0.7.1** is the last release with a Swift-6.0-compatible manifest (0.7.2/0.7.3 are tools 6.2); pin `swift-cmark` accordingly; use SwiftDraw 0.24.0. Resolve and build every package in Phase 0.
- Build unsigned IPA; assert `DTSDKName=iphoneos18.0`, `MinimumOSVersion=18.0`; install via iLoader; launch on the iPad.
- Run `CourseDeckCore` tests with `swift test` (no UIKit/PDF imports).
- Device-test Keychain add/read/delete, Files visibility, custom URL scheme, share sheet, ATS/local network, and install-over-existing-app data preservation.
- Prototype the reader with a 99 KB lesson, a 500×5 ledger, and ~100 math expressions; measure first viewport, scroll fps, memory, rotation, Dynamic Type, and selection. **Validate the fixed-height viewport + full-screen table design.**

**Acceptance:** app launches from an unsigned IPA; `xcodebuild` and `swift test` pass; the IPA metadata proves **MinimumOSVersion 18.0**; Keychain/Files work; the reader prototype meets the performance gate; the fixed-height table design is validated.

### Phase 1 — Data safety + reader (core value)

- Storage layout, atomic files, data version, corruption quarantine.
- **Backup import/export with allowlist/denylist, secret scan, merge/replace modes, and pre-import snapshot.**
- **Key migration to Keychain in Phase 1**, before any plaintext key is persisted.
- **Checkpoint migration writing both `verticalPosition` and anchor.**
- Course library + workspace navigation, course/unit scope rules, rename/archive.
- Markdown preprocessing, block model, prose reader, find-in-document.
- **Complex table grid** with the full authored corpus (including no-outer-pipes, math pipes, code forms, surplus cells).
- Math, images, **SVG**, callouts, details, USERNOTE read-only with regeneration merge/snapshot.
- Import the real desktop backup and read BAF3M/CLU3M/ENG4U/MCR3U/GWL3O lessons.

**Acceptance (measurable):** 125/125 real lesson files render; 547 Markdown files parse; **no new missing refs vs a mechanically generated baseline** (live data has 78 unique missing local files — 65 `.xlsx`, 11 `.pdf`, 2 images — plus 382 unique missing HTML attachment targets); office/HTML attachments get Quick Look/download/placeholder handling; ledgers preserve all cells; currency stays literal; no crash on a 100k-character lesson; exported zip contains no secret pattern and preserves `lessonProgress/` + `attempts/`; desktop reads iOS checkpoints.

### Phase 2 — Editing + prompts

- Plain-text editor, autosave, conflict detection.
- Custom tabs, tab navigation rules, deep-link auto-create.
- Prompt manager with bundled/imported prompts and provenance.

**Acceptance:** edit/save a lesson and a custom tab; desktop backup roundtrip preserves files.

### Phase 3 — AI generation

- Provider store + Keychain + DeepSeek client.
- Durable queue with full inputs, retries/cancel, interrupted-task recovery, output validation.
- Lesson/unit tab generation, course-wide docs, prompt contexts/aggregation.
- Missing-work scan, prompt card diff/reset.
- Generated Markdown renders correctly (tables/math/callouts).

**Acceptance:** generate summary/cheatsheet/test for a lesson; generate course summary/cheatsheet/test; the generated course test is 12 MC + 4 multi-part and completes without truncation; a separate mock/legacy 24-question stream stress test passes; killing/relaunching marks the task interrupted and offers a faithful retry (never a false “resume” or “completed”); DeepSeek Bearer auth and the GLM card both pass a smoke test.

### Phase 4 — Quizzes

- Question parser, practice/unit/pop quiz UI.
- Unit-test AI grading + partial credit + score persistence.
- Pop-quiz 300s wall-clock + attempt history.

**Acceptance:** ported scoring tests pass; backgrounding doesn't lose answers; no email dependency.

### Phase 5 — Ingestion

- Zip/MHTML/HTML ingestion, incremental add, image optimization, SVG conversion, mandatory course-code flow.
- Manifest merge so re-ingest without `_backup` preserves existing lessons.
- Preserve existing `course.schedule.md` files on import/export; no scheduling UI.

**Acceptance:** ingest a real ILC package; re-ingest preserves edits and all old lessons; schedule files are preserved byte-for-byte.

### Phase 6 — Hardening

- Full edge-case matrix, performance, accessibility, device QA.
- Diagnostics: redacted log export, last-crash marker, storage/integrity report, restore-from-snapshot.
- Data version/migration tests, upgrade/downgrade drill.
- Build/sideload docs, re-sign instructions, backup/restore drill, version/rollback policy.

**Acceptance:** **Core `swift test` green**; app/UI tests green only if an existing simulator runtime is available, otherwise manual device QA; real device QA on iPadOS 18.x/18.7; documented iLoader workflow; a default backup (~196 MB) and an include-raw backup (~543 MB) both import/export with no secrets; **same-signed-bundle-ID install-over preserves data**, and export/restore succeeds across any re-sign. If iLoader rewrites the bundle ID/team and forces an uninstall, the container may be lost; the documented path is export → reinstall → restore, not “re-sign preserves data.”

---

## 9. Risks and mitigations

| Risk | Mitigation |
|---|---|
| **Current toolchain is Xcode 16.0 / iOS 18.0 SDK** | Target iPadOS **18.0**; do not upgrade Xcode or modify the container; assert the IPA metadata (`iphoneos18.0`, `MinimumOSVersion=18.0`) |
| Docker Desktop is stopped / SSH unavailable | Build script checks and reports; start Docker Desktop + container first |
| XcodeGen/SPM network access in container | Pre-fetch packages; cache DerivedData; pin versions + `Package.resolved`; explicit shared scheme |
| iLoader free-account 7-day expiry / 3-app limit | Design for free signing; re-sign weekly; mandatory export before re-sign; use paid account if available; iPadMonitor + itube already use two slots |
| iLoader/isideload rewrites bundle ID with team ID; Keychain/data container may change | Do not hardcode bundle ID; use default Keychain access group; device-test Keychain and install-over; document data-loss risk |
| Paid-only entitlements | Avoid iCloud/push/App Groups/background modes; Keychain default group only |
| **Prompt set incomplete** (`test.md`/`course_cheatsheet.md` only in `backup/`; no `test_kica.md`) | Stage active + `backup/` prompts before rsync; required-prompt manifest; fail build if missing |
| **USERNOTE destruction on regeneration** | Merge/snapshot before overwrite; block with warning; fixture test |
| **Manifest rebuild drops lessons when `_backup` is absent** | Merge existing manifest lessons; never write empty units; regression test |
| **Checkpoint schema mismatch** | Write both `verticalPosition` and anchor; define a monotonic pixel approximation; cross-reader visual-resume tests |
| **Backup import refuses normal desktop backups** | Skip/quarantine denylisted entries, import the rest, report skipped; refuse only structural corruption |
| **Backup merge/free-space/data loss** | Per-type merge policy; `_conflicts/`; 3–4× free-space check; rename-based snapshot; atomic directory swap |
| **Files-sharing bypass** | Separate import inbox / launch-time audit; quarantine denylisted files; migrate keys |
| **Frontmatter field order** | Yams 6.2.2 stores `Node.Mapping` as an ordered pair array; use ordered nodes plus raw frontmatter for untouched text; roundtrip test |
| **iOS-only card extensions lost on desktop roundtrip** | Separate `llm_ios.json` keyed by card ID; accept defaults after desktop save |
| **Zero-missing-assets gate impossible** | Mechanically generate the baseline (78 missing local files + 382 HTML targets); gate on no new missing refs; Quick Look/download/placeholders + diagnostics |
| **App test gate cannot run** | Add `CourseDeckTests`/`CourseDeckUITests`, scheme `test:` action, `.xctestplan`; simulator runtime optional/manual device QA |
| **Parser drops FIB/short-answer questions** | Parse legacy FIB sections and multiple answer sections; live fixtures; require non-empty answers |
| **iOS export wipes desktop keys** | Omit `llm_config.json` from iOS exports; export `llm_ios.json` only; desktop merge/preserve |
| **Dependency versions fail on Swift 6.0** | Pin swift-markdown 0.7.1 + swift-cmark, SwiftDraw 0.24.0, all exact; commit both Package.resolved files; Phase 0 resolution |
| **No app-scoped data-root coordinator** | `AppServices` owns queue/backup/migration/generation token; quiesce/swap/reopen; journal |
| **MathML text loss in raw HTML tables** | MathML→text/TeX pass before sanitization; never drop subtree; MCR3U fixtures |
| **Default backup size gate wrong** | Test ~196 MB default and ~543 MB include-raw separately |
| **DeepSeek card uses `api_key` auth** | Normalize/test Bearer; preserve custom headers for other hosts |
| Native table fidelity | Dedicated grid + authored corpus + 500-row ledger tests; no-outer-pipes/math-pipes/code-form fixes |
| **Table nested-scroll ambiguity** | Option (b) is authoritative: fixed-height viewport + full-screen table; Phase 0 validates gesture handoff and offsets |
| Cross-block selection lost | Document the tradeoff; add find-in-document and copy-section; Ask-AI out of scope |
| **SVG assets unsupported by UIImage** | SwiftDraw or convert at ingest; test real course SVGs |
| **Frontmatter unknown-key loss** | Ordered untyped YAML; preserve unknown keys/order; semantic roundtrip fixtures |
| **Context aggregation mismatch** | Explicit lesson/unit vs course-doc matrix; first-time/no-curated/large-course tests |
| **Backup secrets/logs** | Allowlist/denylist; secret scan; Keychain migration in Phase 1; no plaintext export |
| Background AI suspension on iPadOS 18.x | Foreground queue + durable inputs; cancel/interrupt on background; explicit retry; no false resume |
| **SSE truncation** | Require `[DONE]` or `finish_reason=stop`; `length`/`content_filter`/unknown = failure/retry; never overwrite good file |
| 2 GB backup memory / foreground suspension | ZIPFoundation streaming; temp file; keep-awake; free-space check; progress/cancel |
| Large lessons slow | Off-main parsing; chunked prose runs; virtualized tables; progressive layout |
| **External Files/multi-scene edits** | `NSFileCoordinator`/`NSFilePresenter`; compare-and-swap; conflict UI |
| **Privacy/log leakage** | First-run consent; redact keys/prompts/answers from logs; verbose logging opt-in and excluded from backups |
| Desktop data drift | Semantic compatibility + unknown-key preservation; roundtrip tests |

---

## 10. Decisions and defaults

These are applied unless the user overrides them:

1. **Toolchain:** keep the current Xcode 16.0 / iOS 18.0 SDK and target **iPadOS 18.0**. Do not upgrade Xcode or modify the builder container.
2. **PDF export:** out of scope for v1.
3. **Scheduling / Google Calendar / ARC:** out of scope for v1; preserve existing `course.schedule.md` files only.
4. **Multi-model cards:** keep DeepSeek + GLM with an active selector; only OpenAI-compatible transport. Normalize DeepSeek to Bearer; preserve custom headers for other hosts.
5. **Cross-block selection:** accept the block renderer for v1, but add find-in-document, “Copy section as Markdown,” and task toggles. **No table-cell editing in v1** (edit the raw Markdown in the editor). Revisit a single TextKit 2 document only if these are insufficient.
6. **Bulk missing-work scan:** summary + cheatsheet only; align the UI/error text; do not claim test support.
7. **Course cheatsheet:** expose `course.cheatsheet` as an always-valid course tab on iOS, read-only/generated via the prompt card, even though the desktop UI hides it.
8. **Prompt bundling:** bundle the active prompts plus `backup/test.md` and `backup/course_cheatsheet.md`; seed only if missing; provenance-aware import.
9. **Keys/backups:** no plaintext key export; allowlisted, secret-scrubbed backups; merge-by-default with snapshots; no encryption in v1; re-enter keys after reinstall/team change.
10. **Parity additions:** unit assignments, search, checkpoint hub, rename/archive, archived-course preservation, read-only existing schedules, and `dataVersion` migration move into Phase 1/2, not hardening.
11. **Privacy:** first-run consent naming DeepSeek/GLM and what is sent; redacted logs; no analytics.
12. **Course deletion:** archive-only in v1 (matching the desktop UI). If permanent delete is added, use two-step confirmation plus a snapshot/trash; never delete silently. Archived courses are preserved exactly on backup/import/export.
13. **Table layout:** fixed-height viewport + inner scroll + full-screen table (option b), with persisted offsets and gesture handoff.
14. **Data root:** live root in `Library/Application Support/CourseDeck`; only `Documents/Import Inbox` and `Documents/Export` are user-visible.
15. **iOS export config:** omit `llm_config.json` entirely; export `llm_ios.json` only so a desktop restore cannot wipe keys.

---

## 11. First implementation checklist

- [ ] Verify the current Xcode 16.0 / iOS 18.0 SDK in the existing container; **do not upgrade or resize**.
- [ ] Create `ios-app/project.yml` (XcodeGen, iPad-only, **18.0**, SPM packages, explicit `CourseDeck` scheme).
- [ ] Create `ios-app/CourseDeckCore/Package.swift` (Foundation-only, macOS 14 + iOS 18) + models/paths/atomic file store.
- [ ] Create `ios-app/CourseDeck/App/CourseDeckApp.swift` + minimal library screen.
- [ ] Create prompt staging + required-prompt manifest; copy active prompts and `backup/test.md`/`backup/course_cheatsheet.md`.
- [ ] Create `ios-app/scripts/build-ipa.ps1` and `run-core-tests.sh` with toolchain/IPA assertions.
- [ ] Add `ios-app/.gitignore` for `build/`, `DerivedData/`, `*.xcarchive`, `*.ipa`, generated `.xcodeproj`, `xcuserdata/`.
- [ ] Run Phase 0 smoke test; do not proceed until the IPA installs via iLoader and the metadata proves 18.0.
- [ ] Prototype the reader (99 KB lesson, 500×5 ledger, math) and validate the fixed-height viewport + full-screen table design.
- [ ] Implement the table repair parser + **authored** corpus before building the table grid.
- [ ] Implement backup import with secret scrubbing + checkpoint migration before AI.
- [ ] Implement the reader block model and prose view before the AI layer.
- [ ] Implement data versioning, corruption quarantine, and file coordination early.
- [ ] Add `PrivacyInfo.xcprivacy`, an About/Licenses screen (SwiftMath GUST/SIL fonts, SwiftDraw zlib, swift-markdown Apache 2.0, MIT packages), and version/build stamping.
- [ ] Define the IPA version/build scheme, keep the last known-good IPA, and require an export before upgrade/re-sign.
- [ ] Add `CourseDeckTests`/`CourseDeckUITests` targets, scheme `test:` action, and `.xctestplan`; treat simulator runtime as optional/manual device QA.
- [ ] Specify `dataVersion.json` and the checkpoint array schema; add `lessonProgress/` + `attempts/` passthrough.
- [ ] Implement the import-inbox/launch-time data audit so Files-unzipped backups cannot bypass secret scanning.
- [ ] Generate and check in the missing-reference baseline from all Markdown/HTML; gate on “no new missing refs,” not zero. Add Quick Look/download/placeholder handling for `.xlsx`/`.docx`/`.html`.
- [ ] Add live parser fixtures for 6-MC+4-FIB, 8-MC, BAF3M 24-MC+4-SA, GWL3O/MCR3U 12-MC+4-SA, CLU3M 6-MC+4-FIB, the 8-MC+2-FIB+2-SA unit test, and 13 pop quizzes; assert non-empty answers.
- [ ] Pin swift-markdown 0.7.1 + swift-cmark, SwiftDraw 0.24.0, and exact versions for SwiftSoup/SwiftMath/ZIPFoundation/Yams; commit both `Package.resolved` files; copy the app resolved file into the generated workspace; resolve all packages in Phase 0.
- [ ] Implement `AppServices` (queue/backup/migration/generation token) and the Application Support data root + Import Inbox audit.
- [ ] Add MathML→text/TeX conversion and MCR3U `01.03`/`01.06`/`04.09` fixtures.
