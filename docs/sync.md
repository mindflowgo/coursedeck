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
CourseSyncPickerModal / InitialSyncModal
        │  syncFromDesktop({ courseIds, fullCourseIds, since, includeLlmKeys })
        ▼
syncState.svelte.ts ── 1. flush pending push queue (see §5)
        │
        ├─ 2. POST /api/sync/bundle/prepare?<params>   (streamUpload, NDJSON)
        │        desktop packs zip → <dataDir>/_sync-tmp/<token>.zip
        │        streams progress lines while packing
        │        final line: {type:'complete', token, url, courseCount, fileCount}
        │
        ├─ 3. invoke sync_fetch_prepared_zip(url=…/api/sync/bundle/download?token=…)
        │        Rust streams the zip with download progress events,
        │        extracts courses/<id>/** into Documents/courses
        │        emits `sync-progress` events during extraction
        │
        └─ fallback: any prepare failure → invoke sync_fetch_bundle_zip
                 (single GET /api/sync/bundle with identical params)
```

Everything above the webview boundary stays binary in Rust: the zip bytes never
pass through JavaScript. The webview only ever sees progress strings and the
final `SyncZipSummary` (`generatedAt`, per-course `{course_id, files, assets}`,
`llmConfig`).

### 2.1 Selective sync & incremental cursor (the silent no-op bug)

`syncFromDesktop` defaults `since` to the device's `last_synced_at`. In
`createSyncBundleZipStream` (app/src/lib/server/backup.ts) files older than the
cursor are skipped, and **a course with zero newer files is skipped entirely —
manifest included**. Consequence: picking a course the device doesn't have yet
produces an empty bundle and the sync silently does nothing. This was the root
cause of "iPad import stopped working" (first-ever sync has no cursor, so it
worked).

Fix — **per-course full sync**: courses listed in the `fullCourses` query param
bypass the `since` filter (the whole course folder is archived). The picker
modal (`CourseSyncPickerModal.svelte`) computes
`fullCourseIds = selectedIds − listCachedCourses()` so:

- **newly-selected courses** arrive complete (manifest, lessons, assets,
  textbook);
- **already-on-device courses** stay incremental (only files newer than
  `last_synced_at` move).

`InitialSyncModal` and other callers pass no `courseIds`/`since`, which already
produces a full sync.

---

## 3. Server endpoints

| Endpoint | Purpose |
| :--- | :--- |
| `GET /api/sync/courses` | Course summaries (`id`, `title`, `lessonCount`, `coursePDF`) for the picker. |
| `GET /api/sync/bundle` | Streaming zip download. Params: `courseIds`, `since`, `fullCourses`, `includeLlmKeys`. Used by the fallback path and paired browsers. |
| `POST /api/sync/bundle/prepare` | Pack the zip **server-side** to `<dataDir>/_sync-tmp/<token>.zip` while streaming NDJSON progress; completes with `{type:'complete', token, url, …}`. Same query params as the GET. |
| `GET /api/sync/bundle/download?token=…` | Serves a prepared bundle. Token validated against `^sync-[\w-]+\.zip$`; tokens are generated server-side (timestamp-based) and files expire after 1 hour (stale-file sweep on each prepare). |
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
spinners-only. One reactive buffer, two event sources:

- `syncState.syncLog: string[]` (cap 10, dedup consecutive lines, newest last)
  in `syncState.svelte.ts`; cleared at sync start.
- **Packing** (desktop): `prepare` NDJSON `status` lines → `onMessage` → log.
- **Download/extract** (iPad Rust): `mobile.rs` emits a Tauri `sync-progress`
  event (`{message}`) — throttled to 1 MB during download (with total when
  `Content-Length` is present), on first file per course and every 25 files
  during extraction, plus a per-course summary line at the end. `syncFromDesktop`
  listens via `@tauri-apps/api/event` and appends to the log; unlistens in
  `finally`.
- Errors append a final `Failed: …` line and the modals surface
  `syncState.syncError` as before.
- UI: `CourseSyncPickerModal.svelte` renders the last 5 lines under the footer
  button; `InitialSyncModal.svelte` under the spinner —
  `text-[10px] font-mono text-stone-400 dark:text-stone-500`, `aria-live="polite"`.

The modal stays open while `isSyncing` (existing behavior) and reloads the page
on success, exactly as before.

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
`.annotations.json` — pulling first would drop unpushed local edits.

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

- The prepare→download flow is the primary path; the direct
  `GET /api/sync/bundle` remains for paired browsers and as the iPad's
  automatic fallback (older desktop sidecar). A prepare failure never fails the
  sync — it degrades to the fallback with a log line.
- Downloads with no `Content-Length` fall back to MB-only progress lines.
- `sync-progress` emission is fire-and-forget (`let _ = app.emit(...)`) — a
  missing listener (e.g. background auto-sync) never fails the sync.

## 8. Testing

`app/src/lib/server/api.sync.test.ts` covers:

- `fullCourses` bypasses `since` for that course only (aged files included when
  listed; course skipped when not).
- `prepare` streams NDJSON (progress + complete lines, token shape), writes a
  bundle that downloads intact via the token route (verified by unzipping),
  rejects traversal tokens, and cleans up its temp file.
- Push merge semantics (documents, tombstones, checkpoints, prompts, locker
  binaries, traversal containment).

Rust side: `cargo check --lib --target aarch64-apple-ios-sim` must pass
(extraction logic itself is unchanged by the progress work; `sync-progress`
emission is fire-and-forget and never fails the sync).
