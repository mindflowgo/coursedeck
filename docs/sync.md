# iPad ⇄ Desktop Sync Architecture

How CourseDeck moves course data from the desktop (source of truth) to the iPad
(Tauri iOS app) and back, and how progress is surfaced in the sync UI.

Related docs: [`architecture.md`](architecture.md) (system overview), [`ilc-import.md`](ilc-import.md)
(import pipeline — sync is downstream of it).

---

## 1. Data layout & roles

- **Desktop**: owns `<dataDir>/courses/<id>/**` (lessons, `.manifest.json`,
  `assets/**`, including the course textbook at
  `assets/locker_docs/course.pdf`), `<dataDir>/library/`, `<dataDir>/prompts/`,
  and `groups.json`. Served by the compiled Bun sidecar on loopback `:3182`.
- **iPad**: a file client. `tauri/src/mobile.rs` roots everything at
  `Documents/` (UIFileSharingEnabled) with the same shape:
  `Documents/{courses,library,prompts,groups.json}`. Course files are served to
  the webview offline via the `courseasset://` protocol; PDFs are resolved
  straight to disk paths by `pdf.rs::resolve_pdf_path`.
- **Paired browsers** follow the same `GET /api/sync/bundle` download path from
  the desktop over LAN.

Because the textbook PDF lives inside the course folder, it needs no separate
sync plumbing — it rides along with the course's files.

Known gap: the desktop **Library** (`<dataDir>/library/**`, pdf/epub/mobi) is
*not* part of the sync bundle. Library documents on the iPad are device-local
until that changes.

---

## 2. Sync flow (iPad → desktop pull)

```
CourseSyncPickerModal / ScanDesktopModal / InitialSyncModal
        │  syncFromDesktop({ courseIds?, since?, includeLlmKeys?, fullCourseIds? })
        ▼
syncState.svelte.ts ── 1. flush pending push queue (see §5)
        │              2. detect courses missing on this device → fullCourses
        │
        ├─ 3. invoke sync_prepare_bundle(…/api/sync/bundle/prepare?<params>)
        │        Rust reqwest POST; relays the desktop's NDJSON packing
        │        progress as `sync-progress` events; returns the complete line
        │
        └─ 4. invoke sync_fetch_prepared_zip(url=…/api/sync/bundle/download?token=…)
                 Rust streams the zip with download progress events,
                 extracts courses/<id>/** into Documents/courses
                 emits `sync-progress` events during extraction
```

Everything above the webview boundary stays binary in Rust: the zip bytes never
pass through JavaScript. The webview only ever sees progress strings and the
final `SyncZipSummary` (`generatedAt`, per-course `{course_id, files, assets}`,
`llmConfig`).

The prepare request itself also runs in Rust (`sync_prepare_bundle`), not a
webview XHR/streamUpload: the iOS webview's custom-scheme origin
(`tauri://localhost`) can't pass the sidecar's CORS allowlist, so an XHR-based
prepare fails silently on device while every smartFetch (native reqwest)
request works. streamUpload remains the tool for desktop-side backup import,
where the payload is a real file upload.

There is deliberately **no fallback transport**: the prepare→download flow is
the only sync path. Clients and desktops ship together (all clients are
expected to run the latest software — see `architecture.md` §2.1's zero-fallback
rule), so no legacy branch is carried. The older
`GET /api/sync/bundle` route remains for the **lite-PWA satellite** flow
(`docs/lite-pwa.md` §8), which downloads the archive directly over LAN — it
accepts the same params.

### 2.1 Selective sync & incremental cursor (the silent no-op bug)

`syncFromDesktop` defaults `since` to the device's `last_synced_at`. In
`createSyncBundleZipStream` (app/src/lib/server/backup.ts) files older than the
cursor are skipped, and **a course with zero newer files is skipped entirely —
manifest included**. Consequence: picking a course the device doesn't have yet
produces an empty bundle and the sync silently does nothing. This was the root
cause of "iPad import stopped working" (first-ever sync has no cursor, so it
worked).

Fix — **per-course full sync, owned by `syncFromDesktop`** so every entry point
is correct by construction: when `opts.fullCourseIds` is not supplied, the store
computes it itself as "selected (or, with a cursor and no `courseIds`, all
desktop) courses absent from `listCachedCourses()`" and sends them in the
`fullCourses` query param. The bundle builder bypasses the `since` filter for
those courses and archives the whole folder (manifest, lessons, assets,
textbook). Courses already on the device stay incremental.

- **All three live sync modals** go through this: `CourseSyncPickerModal`
  (Settings "Sync" picker), `ScanDesktopModal` (QR-connect course picker), and
  `InitialSyncModal` (first-run; no cursor → full sync anyway).
- **Repair path**: the picker has a "Re-download selected courses in full"
  toggle that passes `fullCourseIds: selectedIds`, forcing a complete re-fetch
  to repair partially-synced copies (e.g. devices synced before this fix).

### 2.2 Prepared bundles: lifetime & secrets

- Tokens are `randomUUID()`-based (`sync-<uuid>.zip`), validated against
  `^sync-[\w-]+\.zip$`; timestamp-derived tokens were rejected as
  predictable.
- The bundle can contain desktop LLM API keys (`includeLlmKeys`), so the
  prepared file is **deleted immediately after one successful download** and
  any stale files are swept on the next prepare (1 h). `_sync-tmp` is excluded
  from both backup walkers (`createDataBackupZipStream` and
  `createDataBackupZip`) so keys-at-rest never leak into user backups.

---

## 3. Server endpoints

| Endpoint | Purpose |
| :--- | :--- |
| `GET /api/sync/courses` | Course summaries (`id`, `title`, `lessonCount`, `coursePDF`) for the pickers. |
| `GET /api/sync/bundle` | Streaming zip download for **lite-PWA satellites** (direct LAN download). Params: `courseIds`, `since`, `fullCourses`, `includeLlmKeys`. |
| `POST /api/sync/bundle/prepare` | Pack the zip **server-side** to `<dataDir>/_sync-tmp/<token>.zip` while streaming NDJSON progress; completes with `{type:'complete', token, url, …}`. Same query params as the GET. The iPad's only sync entry point. |
| `GET /api/sync/bundle/download?token=…` | Serves a prepared bundle: streamed (`createReadStream` → `Readable.toWeb`, with `Content-Length` — never buffered whole into memory), and **deleted after this one download**. Token validated against `^sync-[\w-]+\.zip$`. |
| `POST /api/sync/push` | iPad → desktop merge of text entities (see §5). |
| `POST/DELETE /api/courses/:id/locker-docs` | iPad → desktop binary pushes (multipart) and tombstone deletes. |

NDJSON message contract (`prepare`, mirroring `/api/backup/import`):

```
{"type":"progress","status":"Packing 2 course(s), 214 file(s)..."}
{"type":"progress","status":"Packing math12 — 34/128 files"}
{"type":"progress","status":"Packed 12.4 MB"}
{"type":"complete","token":"sync-2026-11-12T…zip","url":"/api/sync/bundle/download?token=…","courseCount":2,"fileCount":214,"generatedAt":"…"}
{"type":"error","success":false,"message":"…"}   (on failure)
```

`streamUpload` (app/src/lib/streamUpload.ts) is the single client for this:
XHR upload-progress + partial-line-buffered NDJSON parsing. It is the same
machinery the backup import uses — one progress idiom across the app.

---

## 4. Progress surface (the subtle grey log)

Design goal: quiet, monospace, bottom-of-modal log lines — never dialogs or
spinners-only. One reactive buffer, three event sources:

- `syncState.syncLog: string[]` (cap 10, dedup consecutive lines, newest last)
  in `syncState.svelte.ts`; cleared at sync start. Stage lines
  ("Checking which courses are on this device…", "Requesting bundle from
  <url>…", "Bundle ready — N courses, M files", "Imported N course(s)",
  "Failed: …") bracket the wire events so an on-device stall shows exactly
  which step stopped.
- **Packing** (desktop): prepare NDJSON `status` lines, relayed by the Rust
  `sync_prepare_bundle` command as `sync-progress` events.
- **Download/extract** (iPad Rust): `mobile.rs` emits `sync-progress` events —
  throttled to 1 MB during download (with total when `Content-Length` is
  present), on first file per course and every 25 files during extraction,
  plus a per-course summary line at the end. `syncFromDesktop` listens via
  `@tauri-apps/api/event` and appends to the log; unlistens in `finally`.
- Errors append a final `Failed: …` line and the modals surface
  `syncState.syncError` as before.
- UI: all three sync modals render the last 5 log lines —
  `CourseSyncPickerModal` and `InitialSyncModal` as plain grey lines,
  `ScanDesktopModal` in a subtle inset box — always
  `text-[10px] font-mono text-stone-400 dark:text-stone-500`, `aria-live="polite"`.

The modal stays open while `isSyncing` (existing behavior) and reloads the page
on success, exactly as before.

**On-device debugging**: sync lines flow through `DebugLog()`
(`debugLog.svelte.ts`) — the app's single diagnostic logging channel. Every
line is appended to a persistent `debug.log` at the app data root
(`Documents/debug.log` on iPad, visible in the Files app; `<data>/debug.log`
on desktop via the Rust `debug_log_append` command or, for browser clients,
`POST /api/debug-log`). A **Debugger toggle in Settings → below Appearance**
controls console mirroring: when on, DebugLog lines also `console.log` (and the
"View console" button opens the in-app `ConsoleInspector` panel — the console
ring buffer captures `console.{log,info,warn,error,debug}` app-wide). Every
sync line is also emitted to the UI's grey log via `appendSyncLog`. If the iPad
build predates a Rust command, the failure surfaces as
`Failed: … unknown command sync_prepare_bundle` there.

---

## 5. Reverse sync (iPad → desktop push)

Local writes on any client land in pending-push queues (`clientStore.ts`);
`syncState.pushToDesktop` flushes them:

1. **Text entities** (checkpoints, annotations, documents, prompts) as one
   gzip-JSON `POST /api/sync/push`. The server applies per-entity
   **mtime-guarded last-writer-wins** — a stale push never clobbers a newer
   desktop edit, and delete tombstones apply only when newer than the file.
   Queue is cleared only after confirmed server merge (atomicity).
2. **Locker-doc binaries** as multipart uploads with a concurrency pool of 3,
   each removed from the queue as it succeeds; per-file DELETE tombstones.

Pushes are auto-flushed on a 3 s debounce (`PUSH_QUEUED_EVENT`) and on
reconnect. `syncFromDesktop` always flushes pending pushes **before** pulling,
because the incoming extract overwrites everything except
`.annotations.json` — pulling first would drop unpushed local edits. If the
pre-sync push fails, the sync **aborts with a visible error** instead of
clobbering the edits; the picker's "replace local data" answer to the
pending-changes warning maps to `discardPendingPush`, which skips the flush
and drops the pending queue (explicit user choice). The push itself always
runs inside `syncFromDesktop` (never duplicated in the modal) so its stages
land in the grey progress log.

---

## 6. Conflict & merge rules

| Data | Rule |
| :--- | :--- |
| Course files | Last sync wins (extract overwrites). Desktop is source of truth; local edits must be pushed first (§5 guarantees this). |
| `.annotations.json` | **LWW merge per stroke id** (`mobile.rs::merge_annotations_lww`) — local + incoming strokes merged by ISO-date comparison, so a fresh sync never drops unpushed iPad strokes; tombstones survive because the newer entry wins, deleted or not. |
| `.checkpoints.json` / pushes | Mtime-guarded LWW per entity id (server-side). |
| `.manifest.json` | Excluded from mtime filtering in incremental mode; rides along whenever the course has any change (or is in `fullCourses`), so the device's course list stays current. |
| Zip contents | Defense in depth on both sides: server excludes `_backup`/dotfiles (allowing the three dot-state files); Rust extractor additionally rejects `..`, empty segments, and non-allowlisted dotfiles. |

---

## 7. Compatibility & failure behavior

- **No fallback / no legacy paths.** The prepare→download flow is the only
  iPad sync transport; `sync_fetch_bundle_zip` (the old one-shot Rust command)
  was deleted once `sync_fetch_prepared_zip` replaced it, per
  `architecture.md` §2.1. All clients are expected to run the latest software.
- The `GET /api/sync/bundle` route is retained only because it is the
  documented lite-PWA satellite download surface — it shares all param parsing
  and the sync-meta builder with `prepare` (single code path in `api.ts`).
- A failed or interrupted prepare deletes its partial temp file (after the
  stream has closed) and reports `{type:'error'}` on the NDJSON stream; the
  sync surfaces it through `syncState.syncError`.
- Downloads with no `Content-Length` fall back to MB-only progress lines.
- `sync-progress` emission is fire-and-forget (`let _ = app.emit(...)`) — a
  missing listener never fails the sync.
- The log block is not gated on `isSyncing`: it renders whenever lines exist
  (with a "Starting sync…" placeholder while the first line is pending), so a
  failure leaves the trail visible for debugging.

## 8. Testing

`app/src/lib/server/api.sync.test.ts` covers:

- `fullCourses` bypasses `since` for that course only (aged files included when
  listed; course skipped when not) — on both `GET /api/sync/bundle` and
  `POST /api/sync/bundle/prepare`.
- `prepare` streams NDJSON (progress + complete lines, token shape), writes a
  bundle that downloads intact via the token route (verified by unzipping),
  rejects traversal tokens.
- Push merge semantics (documents, tombstones, checkpoints, prompts, locker
  binaries, traversal containment).

Rust side: `cargo check --lib --target aarch64-apple-ios-sim` must pass
(extraction logic itself is unchanged by the progress work; `sync-progress`
emission is fire-and-forget and never fails the sync).
