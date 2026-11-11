# History

**DO NOT USE THIS FOR BUILDING** it is simply to track improvements over time.

All architectural improvements have been implemented and verified, and docs/architecture.md has been updated to reflect the design.

1. Direct iPad LLM Generation (Sidecar-Free)
Client-Side Dispatch: Updated generateDirect to utilize smartFetch (@tauri-apps/plugin-http) instead of browser fetch, bypassing iOS WKWebView CORS restrictions and loopback relay limits.
Offline Routing: offlineFetch now intercepts POST /api/llm calls on iPad (isTauriMobile()) for generate, test, save_config, save_store, and set_active, reading and persisting LLM provider configurations and synced API keys directly to local IndexedDB without requiring a running desktop sidecar.
2. Sync Speed & Wire Compression Optimizations
Automatic Incremental Sync: syncFromDesktop now automatically tracks the lastSyncedAt cursor and sends since=<ISO> by default.
Gzip JSON Push: pushToDesktop compresses outgoing batch checkpoint and annotation JSON payloads with browser-native CompressionStream('gzip'). server/api.ts decompresses incoming gzipped requests via DecompressionStream('gzip').
Adaptive Deflate Compression: createSyncBundleZipStream applies Deflate Level 6 (fflate.ZipDeflate) to text files during incremental syncs while keeping fflate.ZipPassThrough for pre-compressed binaries (PDF, JPEG, PNG, ZIP).
Parallel Locker-Doc Uploads: Binary asset uploads now run through a controlled 3-worker concurrency pool.
3. Queue Atomicity & Storage Hygiene
Atomic Queue Management: Added clearPendingPushText() and removePendingPushAsset(courseId, filename). The text pending queue clears immediately upon confirmed batch push, and binary assets are removed individually as their uploads complete.
Cleaned Endpoints & Types: Removed the redundant /api/settings/course-groups alias in favor of /api/settings/groups and typed group?: string on ClientLibraryDocument.
Dead Code Removed: Deleted obsolete scrollMemory.ts and scrollMemory.test.ts.
4. Architecture Documentation Updates (docs/architecture.md)
§1, §3.4, §4, §5, §8, §13, §17.1: Standardized on canonical .notes.md (01.01.notes.md, course.notes.md) in place of legacy cheatsheet references.
§2.2: Cleaned up the key directory tree to remove dead code references.
§3.5 & §17.2: Replaced legacy tab_scroll:* local storage documentation with the persistent filesystem-backed .checkpoints.json system.
§13.1 & §13.2: Clarified that study materials are single consolidated artifacts that overwrite on regeneration, removing ghost multi-version branching descriptions.
§16.3: Clarified the roles of save_config (active-card configuration helper for setup modals) vs save_store (multi-card store management).
§18.3: Removed references to legacy migration paths (data.old).
§20: Rewritten as iPad Offline Sync & Direct LLM Generation Architecture, documenting direct client-side generation, offlineFetch routing, incremental sync, wire compression, and parallel asset transfers.

