# CourseDeck Multi-User Server Architecture

## Purpose

This document specifies how to extend CourseDeck into a **multi-user cloud server** running on Ubuntu/Docker with:

1. **Course Marketplace** — users can publish and browse/clone courses created by others.
2. **Family Subscriptions** — a guardian (parent/teacher) links to a learner (child/student) and can view their progress in shared courses.
3. **Authenticated Sessions** — every user (Tauri desktop, iPad app, web browser) authenticates with valid credentials via JWT tokens over HTTPS/WSS.
4. **WebSocket-first real-time** — live progress events, quiz scores, marketplace updates, and read receipts flow over a persistent WebSocket connection; REST remains for idempotent CRUD.

---

## Current Architecture (as-is)

Understanding the baseline before extending:

```
┌─────────────────────────────────────────────────────┐
│  Tauri Desktop (Mac/Windows/Linux)                   │
│  ┌────────────────────────────────────────────────┐  │
│  │  SvelteKit SPA (static build in app/build/)    │  │
│  │  Svelte 5 runes, Tailwind, CodeMirror, PDF.js  │  │
│  └───────────────────┬────────────────────────────┘  │
│                      │ http://127.0.0.1:3182          │
│  ┌───────────────────▼────────────────────────────┐  │
│  │  Bun HTTP Server (server/index.ts)             │  │
│  │  • handleApiRequest() — REST /api/*            │  │
│  │  • handleMcpHttpRequest() — /mcp (MCP-Lite)   │  │
│  │  • Static file serving (SPA build)             │  │
│  │  • NO auth (localhost-only origin check)       │  │
│  └───────────────────┬────────────────────────────┘  │
│                      │ fs read/write                  │
│  ┌───────────────────▼────────────────────────────┐  │
│  │  data/                                         │  │
│  │  ├── courses/<id>/*.md + .manifest.json        │  │
│  │  ├── library/                                  │  │
│  │  ├── prompts/                                  │  │
│  │  ├── groups.json                               │  │
│  │  ├── llm_config.json                           │  │
│  │  └── .mcp-token (bearer token, 48-hex chars)   │  │
│  └────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘

iPad / Mobile  ←→  Desktop Bun server (LAN, port 3182)
  sync via /api/sync/bundle (zip download) + /api/sync/push (JSON POST)
  NO auth — any LAN device can sync
```

**Key constraints to preserve:**

- `handleApiRequest()` in `app/src/lib/server/api.ts` is the single source of truth for all REST endpoints — it is used by both the Bun sidecar and the SvelteKit dev server. Its signature must not change.
- Data is stored as markdown files + JSON. No database today.
- MCP server uses a single file-backed bearer token (`.mcp-token`).
- The Bun HTTP server has no WebSocket handler today.
- CORS currently allows only `localhost`, `tauri.localhost`, and RFC-1918 LAN addresses.

### Endpoints that are local-desktop-only

These endpoints in `handleApiRequest()` must be **disabled or gated** in cloud mode — they are dangerous or meaningless on a shared server:

| Endpoint | Risk in cloud mode |
|----------|-------------------|
| `POST /api/open-folder` (calls `xdg-open` / `open`) | **Remote code execution** — shells out to OS file manager |
| `GET /api/network-ip` | Leaks server's internal IP addresses |
| `GET /api/pairing/info` | LAN pairing info irrelevant for cloud; leaks hostnames |
| `POST /api/settings/data-dir` | Lets a user relocate the global data dir |

The cloud server entry point must intercept these paths and return 404 before they reach `handleApiRequest()`.

---

## Target Architecture (to-be)

```
┌─────────────────────────────────────────────────────────────┐
│  Ubuntu Docker Host (your Linux server)                      │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐    │
│  │  Caddy (reverse proxy + TLS termination)             │    │
│  │  • HTTPS :443 → CourseDeck cloud server              │    │
│  │  • WSS :443/ws → WebSocket hub (transparent upgrade) │    │
│  │  • Static assets for web SPA                         │    │
│  └────────────────────┬─────────────────────────────────┘    │
│                       │                                      │
│  ┌────────────────────▼─────────────────────────────────┐    │
│  │  CourseDeck Cloud Server (new: server/cloud/)        │    │
│  │  Runtime: Bun (same as current)                      │    │
│  │                                                      │    │
│  │  HTTP Layer                                          │    │
│  │  ├── POST /auth/register, /auth/login                │    │
│  │  ├── POST /auth/refresh                              │    │
│  │  ├── GET  /api/marketplace/courses                   │    │
│  │  ├── POST /api/marketplace/publish                   │    │
│  │  ├── POST /api/marketplace/courses/:id/clone         │    │
│  │  ├── GET  /api/family/members                        │    │
│  │  ├── POST /api/family/invite                         │    │
│  │  ├── GET  /api/family/:learnerId/progress            │    │
│  │  └── All existing /api/* routes (scoped per user)    │    │
│  │                                                      │    │
│  │  WebSocket Layer (wss://... via /ws)                 │    │
│  │  ├── Auth: first message must be {type:"auth",token} │    │
│  │  ├── Channel: progress events from learner           │    │
│  │  ├── Channel: marketplace updates                    │    │
│  │  └── Channel: quiz results pushed to guardian        │    │
│  └────────────────────┬─────────────────────────────────┘    │
│                       │ SQL queries                          │
│  ┌────────────────────▼─────────────────────────────────┐    │
│  │  SQLite (phase 1) or PostgreSQL (phase 2+)           │    │
│  │  • users, sessions, families, marketplace_courses    │    │
│  │  • progress_events, quiz_results                     │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐    │
│  │  Docker volume: /data                                │    │
│  │  • Per-user data directory (same layout as local)    │    │
│  │  • Marketplace bundles                               │    │
│  └──────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘

Clients:
  Tauri Desktop → /api/* (JWT in Authorization header) — can sync local ↔ cloud
  iPad / Mobile → /api/sync/bundle + /api/sync/push (JWT)
  Web Browser   → served by Caddy, same SPA build
  Guardian      → WebSocket /ws → real-time progress events
```

---

## Detailed Component Design

### 1. Authentication Service

**Technology choice:** JWT (access + refresh token pair), stored in:
- Bun server: issued via `/auth/login`, `/auth/register`, `/auth/refresh`
- Client: `httpOnly` cookie (web browsers) or Tauri secure store (desktop) or iOS Keychain (mobile)
- Refresh token stored in a `sessions` table in the database

**Why JWT + refresh tokens:**
- Stateless access token — no DB hit per API call
- Revocable (refresh token in DB, deleted on logout or on guardian account suspension)
- Keeps existing `handleApiRequest()` working unchanged — just wrap it with a middleware that validates `Authorization: Bearer <access_token>` and sets up AsyncLocalStorage before calling through

**Token structure (access token, 15min TTL):**
```json
{
  "sub": "usr_abc123",
  "email": "user@example.com",
  "roles": ["learner", "guardian"],
  "iat": 1730000000,
  "exp": 1730000900
}
```

> **Security rule:** The access token must **never** contain filesystem paths.
> The server always computes the data directory from the `sub` claim:
> ```typescript
> const dataDir = path.join(CLOUD_DATA_ROOT, 'users', payload.sub);
> ```
> This ensures a forged or tampered token cannot redirect reads/writes to arbitrary paths.

**Token structure (refresh token, 30-day TTL):** opaque 48-hex token stored in `sessions` table.

**Implementation in Bun:**
```typescript
// server/cloud/auth.ts
import { SignJWT, jwtVerify } from 'jose'; // jose is a pure-JS JWT library, works in Bun

const ACCESS_TOKEN_SECRET = new TextEncoder().encode(process.env.ACCESS_TOKEN_SECRET!);

export async function verifyAccessToken(req: Request): Promise<JWTPayload | null> {
  const header = req.headers.get('authorization') ?? '';
  const token = header.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, ACCESS_TOKEN_SECRET);
    return payload;
  } catch {
    return null;
  }
}
```

**Registration flow:**
1. `POST /auth/register` — `{ email, password, displayName }`
2. Hash password with `Bun.password.hash()` (argon2id, built into Bun)
3. Insert `users` row with initial role `['learner']`
4. Create per-user data directory: `/data/users/usr_<id>/`
5. Return access + refresh token pair

**Login flow:**
1. `POST /auth/login` — `{ email, password }`
2. Fetch user row, verify with `Bun.password.verify()`
3. Issue new access + refresh token pair
4. Insert `sessions` row
5. Rate-limit: max 5 attempts per IP per minute; return 429 on breach (in-memory sliding window counter, keyed by IP)

**WebSocket auth:**
- Client upgrades to WS, sends first frame: `{ "type": "auth", "token": "<access_token>" }`
- Server verifies JWT, associates connection with `userId`
- Invalid/missing token: server sends `{ "type": "error", "code": "auth_failed" }` and closes connection
- Any non-auth message before authentication causes immediate close

---

### 2. Multi-User Data Isolation

Each user gets their own data directory under a shared volume:

```
/data/
├── users/
│   ├── usr_abc123/               ← per-user data (same layout as local)
│   │   ├── courses/
│   │   │   └── mcr3u/
│   │   │       ├── .manifest.json
│   │   │       └── 01.01.lesson.md
│   │   ├── library/
│   │   ├── prompts/
│   │   ├── groups.json
│   │   └── llm_config.json       ← user's own LLM keys, never shared
│   └── usr_def456/
│       └── ...
├── marketplace/
│   ├── pub_ghi789/               ← published course bundles (credentials stripped)
│   │   ├── manifest.json
│   │   └── bundle.zip
│   └── ...
└── coursedeck.db                 ← SQLite database (phase 1)
```

**The key insight:** `getDataDir()` already checks multiple sources for the data directory. In the cloud server, we use `AsyncLocalStorage` to scope it per-request from the authenticated user's `sub` claim. This is the **only** mechanism — `handleApiRequest()` signature stays unchanged.

```typescript
// server/cloud/middleware.ts
import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';

const CLOUD_DATA_ROOT = process.env.DATA_ROOT || '/data';
export const dataDirContext = new AsyncLocalStorage<string>();

export function getDataDirForUser(userId: string): string {
  // userId is validated via JWT signature — but belt-and-suspenders:
  if (!/^usr_[a-z0-9]{6,20}$/i.test(userId)) {
    throw new Error('Invalid userId format');
  }
  return path.join(CLOUD_DATA_ROOT, 'users', userId);
}

export function withUserDataDir<T>(userId: string, fn: () => T): T {
  return dataDirContext.run(getDataDirForUser(userId), fn);
}
```

Then modify `getDataDir()` in `paths.ts` to check `dataDirContext.getStore()` first — this is a 2-line addition:
```typescript
// In app/src/lib/server/paths.ts — add at the top of getDataDir():
export function getDataDir(): string {
  // Cloud mode: per-request user directory via AsyncLocalStorage
  const fromContext = dataDirContext?.getStore?.();
  if (fromContext) return fromContext;

  // ... entire existing fallback chain unchanged ...
}
```

Where `dataDirContext` is imported only when `CLOUD_MODE` is set (dynamic import or conditional require), so the single-user server path has zero overhead.

This means **zero changes to `handleApiRequest()`** — it calls `getDataDir()` (via `getCoursesDir()`, `getPromptsDir()`, etc.) and naturally operates on the correct user's data directory.

#### Storage Quotas

Each user's data directory must have a soft quota to prevent a single user from filling the shared volume:

```typescript
// server/cloud/quotas.ts
const DEFAULT_QUOTA_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB per user

export async function checkQuota(userId: string): Promise<{ used: number; limit: number; ok: boolean }> {
  const userDir = getDataDirForUser(userId);
  const used = await calculateDirSizeAsync(userDir);
  const limit = DEFAULT_QUOTA_BYTES; // could be per-user from DB
  return { used, limit, ok: used < limit };
}
```

The cloud middleware checks quota before write operations (file uploads, course clone, sync push). Read-only endpoints skip the check.

---

### 3. Database Schema

#### Phase 1: SQLite (simplest deployment)

For a small family/friends deployment, SQLite eliminates the PostgreSQL container entirely. Bun has `bun:sqlite` built in with excellent performance. The schema below is simple enough that SQLite handles it well — there are no heavy concurrent-write patterns (progress events are append-only from a single server process).

#### Phase 2+: PostgreSQL (when scaling)

Migrate to PostgreSQL when you need: multiple server instances, full-text search beyond SQLite's FTS5, or concurrent write throughput from many simultaneous users.

The schema is the same for both; only the driver changes.

```sql
-- Users (roles is a JSON array: ["learner"], ["learner","guardian"], etc.)
CREATE TABLE users (
  id            TEXT PRIMARY KEY,          -- "usr_" + nanoid(10)
  email         TEXT UNIQUE NOT NULL,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  roles         TEXT NOT NULL DEFAULT '["learner"]',  -- JSON array; multiple roles allowed
  quota_bytes   INTEGER DEFAULT 2147483648,           -- 2 GB default
  created_at    TEXT DEFAULT (datetime('now')),
  updated_at    TEXT DEFAULT (datetime('now'))
);

-- Refresh token sessions
CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,          -- opaque 48-hex token (IS the refresh token)
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at   TEXT NOT NULL,
  created_at   TEXT DEFAULT (datetime('now')),
  user_agent   TEXT,
  ip           TEXT
);

-- Family/group relationships
-- Direction: guardian watches learner. Learner must accept.
CREATE TABLE family_members (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  guardian_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  learner_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status       TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'active' | 'revoked'
  invited_at   TEXT DEFAULT (datetime('now')),
  accepted_at  TEXT,
  UNIQUE(guardian_id, learner_id)
);

-- Marketplace course listings
CREATE TABLE marketplace_courses (
  id           TEXT PRIMARY KEY,          -- "pub_" + nanoid(10)
  publisher_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id    TEXT NOT NULL,             -- original course id in publisher's data dir
  title        TEXT NOT NULL,
  description  TEXT,
  tags         TEXT,                      -- JSON array: ["math","grade11"]
  grade        TEXT,
  level        TEXT,
  lesson_count INTEGER DEFAULT 0,
  bundle_path  TEXT NOT NULL,             -- path to .zip in marketplace volume
  bundle_size  INTEGER,
  version      INTEGER NOT NULL DEFAULT 1,
  downloads    INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'published' | 'unlisted'
  published_at TEXT,
  updated_at   TEXT DEFAULT (datetime('now'))
);

-- Progress events (for guardian dashboard)
-- Append-only log of learner activity.
CREATE TABLE progress_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  course_id    TEXT NOT NULL,
  lesson_id    TEXT,
  event_type   TEXT NOT NULL,  -- 'lesson_opened' | 'quiz_completed' | 'checkpoint_added' | 'tab_generated'
  payload      TEXT,           -- JSON blob: { score, percentage, tab_name, etc. }
  created_at   TEXT DEFAULT (datetime('now'))
);

-- Indexes
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);
CREATE INDEX idx_family_guardian ON family_members(guardian_id, status);
CREATE INDEX idx_family_learner ON family_members(learner_id, status);
CREATE INDEX idx_marketplace_status ON marketplace_courses(status, published_at);
CREATE INDEX idx_progress_events_user_course ON progress_events(user_id, course_id, created_at);
```

**Note on roles:** A user can hold multiple roles simultaneously. A parent who is self-learning AND monitoring their child has `["learner", "guardian"]`. A user who publishes courses has `["learner", "publisher"]`. Roles are stored as a JSON array in a TEXT column (works in both SQLite and PostgreSQL). Parse with `JSON.parse()` on read.

---

### 4. WebSocket Hub

Bun has native WebSocket support via `Bun.serve()`. Add a `/ws` upgrade handler alongside the existing HTTP handler:

```typescript
// server/cloud/wsHub.ts
import type { ServerWebSocket } from 'bun';

type WSData = {
  userId: string;
  roles: string[];
  authenticated: boolean;
};

// Map<userId, Set<ServerWebSocket>>
const connections = new Map<string, Set<ServerWebSocket<WSData>>>();

export function broadcast(toUserId: string, msg: object): void {
  const sockets = connections.get(toUserId);
  if (!sockets) return;
  const payload = JSON.stringify(msg);
  for (const ws of sockets) {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  }
}

export function isOnline(userId: string): boolean {
  const sockets = connections.get(userId);
  return sockets !== undefined && sockets.size > 0;
}

export const wsHandlers = {
  open(ws: ServerWebSocket<WSData>): void {
    ws.data.authenticated = false;
    // Client has 5 seconds to send auth message before we disconnect
    setTimeout(() => {
      if (!ws.data.authenticated) ws.close(4001, 'Auth timeout');
    }, 5000);
  },

  async message(ws: ServerWebSocket<WSData>, msg: string | Buffer): Promise<void> {
    const text = typeof msg === 'string' ? msg : msg.toString();
    let data: any;
    try { data = JSON.parse(text); } catch { return; }

    if (data.type === 'auth') {
      const payload = await verifyAccessToken(data.token);
      if (!payload?.sub) {
        ws.send(JSON.stringify({ type: 'error', code: 'auth_failed' }));
        ws.close(4003, 'Auth failed');
        return;
      }
      ws.data.userId = payload.sub as string;
      ws.data.roles = (payload.roles as string[]) ?? ['learner'];
      ws.data.authenticated = true;
      if (!connections.has(ws.data.userId)) connections.set(ws.data.userId, new Set());
      connections.get(ws.data.userId)!.add(ws);
      ws.send(JSON.stringify({ type: 'auth_ok', userId: ws.data.userId }));
      return;
    }

    // Reject all messages before auth
    if (!ws.data.authenticated) { ws.close(4001, 'Not authenticated'); return; }

    // Ping/pong keepalive
    if (data.type === 'ping') { ws.send(JSON.stringify({ type: 'pong' })); return; }
  },

  close(ws: ServerWebSocket<WSData>): void {
    if (ws.data.userId) {
      connections.get(ws.data.userId)?.delete(ws);
      if (connections.get(ws.data.userId)?.size === 0) {
        connections.delete(ws.data.userId);
      }
    }
  }
};
```

**How progress events flow to guardian:**

```typescript
// server/cloud/progressReporter.ts
// Called from inside handleApiRequest() after quiz submission, lesson open, etc.

import { broadcast } from './wsHub';
import { db } from './db';

export async function recordProgress(event: {
  userId: string;
  courseId: string;
  lessonId?: string;
  eventType: string;
  payload?: object;
}): Promise<void> {
  // 1. Persist to DB
  db.run(
    `INSERT INTO progress_events (user_id, course_id, lesson_id, event_type, payload)
     VALUES (?, ?, ?, ?, ?)`,
    [event.userId, event.courseId, event.lessonId ?? null, event.eventType,
     JSON.stringify(event.payload ?? {})]
  );

  // 2. Find all guardians watching this learner
  const guardians = db.query<{ guardian_id: string }>(
    `SELECT guardian_id FROM family_members
     WHERE learner_id = ? AND status = 'active'`
  ).all(event.userId);

  // 3. Push real-time WS event to each guardian
  const wsMsg = {
    type: 'progress_update',
    learnerId: event.userId,
    courseId: event.courseId,
    lessonId: event.lessonId,
    eventType: event.eventType,
    payload: event.payload,
    timestamp: new Date().toISOString()
  };
  for (const { guardian_id } of guardians) {
    broadcast(guardian_id, wsMsg);
  }

  // 4. Also push to the learner's own WS connections (for multi-device sync)
  broadcast(event.userId, {
    type: 'self_progress',
    courseId: event.courseId,
    lessonId: event.lessonId,
    eventType: event.eventType,
    timestamp: new Date().toISOString()
  });
}
```

The `recordProgress` function is a **no-op** in single-user / non-cloud mode. Guard with:
```typescript
// At the top of progressReporter.ts
const isCloudMode = process.env.CLOUD_MODE === 'true';
export async function recordProgress(event: { ... }): Promise<void> {
  if (!isCloudMode) return;
  // ... actual logic
}
```

---

### 5. Marketplace API

All marketplace endpoints require a valid JWT.

#### Publish a course

```
POST /api/marketplace/publish
Authorization: Bearer <access_token>
Content-Type: application/json

{
  "courseId": "mcr3u",
  "title": "MCR3U Grade 11 Functions",
  "description": "Complete Ontario curriculum...",
  "tags": ["math", "grade11", "ontario"],
  "grade": "11",
  "level": "University/College Preparation"
}
```

**Server logic:**
1. Verify JWT → get `userId`; verify user has `publisher` role (or `admin`)
2. Verify course exists in user's `courses/mcr3u/` directory
3. Call existing `createSyncBundleZipStream({ courseIds: ['mcr3u'] })` to produce the zip
4. **Strip credentials from the bundle** before writing to marketplace:
   - Remove `llm_config.json` (contains API keys)
   - Remove `.mcp-token`
   - Remove `.google_credentials.json`, `.arc_credentials.json`
   - Remove any file matching `.*credentials*` or `.*token*`
   - Alternatively, build a dedicated `createMarketplaceBundleStream()` that only includes `courses/<id>/` and `prompts/` — no root-level config files
5. Write sanitized zip to `/data/marketplace/pub_<nanoid>/bundle.zip`
6. Insert row in `marketplace_courses` with `status = 'pending'`
7. Return `{ id: "pub_ghi789", status: "pending" }`

> **Security: credential stripping is critical.** The existing `createSyncBundleZipStream()`
> includes `llmConfig` (with API keys) in its `syncMeta`. The marketplace publish flow must
> NEVER reuse this option. Create a separate `createMarketplaceBundleStream()` that exports
> only course content (markdown files, manifest, images) and nothing else.

#### Browse marketplace

```
GET /api/marketplace/courses?q=math&grade=11&tags=ontario&page=1&limit=20
Authorization: Bearer <access_token>
```

```json
{
  "courses": [
    {
      "id": "pub_ghi789",
      "title": "MCR3U Grade 11 Functions",
      "description": "...",
      "publisher": { "displayName": "fil", "id": "usr_abc123" },
      "tags": ["math", "grade11", "ontario"],
      "grade": "11",
      "level": "University/College Preparation",
      "lessonCount": 25,
      "downloads": 42,
      "version": 1,
      "publishedAt": "2026-10-01T00:00:00Z"
    }
  ],
  "total": 1,
  "page": 1
}
```

#### Download/clone a course

```
POST /api/marketplace/courses/pub_ghi789/clone
Authorization: Bearer <access_token>

{ "targetCourseId": "mcr3u_clone" }   // optional, defaults to original courseId
```

**Server logic:**
1. Check user's storage quota — reject if would exceed limit
2. Fetch `marketplace_courses` row → get `bundle_path`
3. Extract zip into the requesting user's `courses/<targetCourseId>/` data directory
4. Increment `downloads` counter
5. Return `{ courseId: "mcr3u_clone", status: "installed" }`

**Rate limit:** max 10 clones per user per hour to prevent abuse.

#### Course update versioning

When a publisher re-publishes a course that already exists in the marketplace:
1. `version` is incremented
2. Old bundle is kept as `bundle.v<N-1>.zip` (one previous version retained)
3. Users who previously cloned the course can check for updates:

```
GET /api/marketplace/courses/pub_ghi789/updates?myVersion=1
→ { "updateAvailable": true, "latestVersion": 2, "changelog": "Added Unit 5" }

POST /api/marketplace/courses/pub_ghi789/update
→ re-extracts the new bundle, merging with (not overwriting) user's local edits
```

The merge strategy for updates is last-writer-wins on a per-file basis, same as the existing iPad sync push protocol.

---

### 6. Family/Guardian System

#### Core concept

The family system gives a **guardian visibility into a learner's progress**. The guardian does not "grant" the learner access to courses — the learner already has their own courses (from marketplace, from sync, or from direct upload). The guardian simply watches.

**Data model:** When a `family_members` row has `status = 'active'`, the guardian can see all progress events from that learner across all courses. No per-course grant is needed — the relationship is between people, not between people and courses.

If fine-grained control is desired later, the **learner** (not the guardian) can toggle which courses are visible. This respects the learner's autonomy.

#### Invite a learner

```
POST /api/family/invite
Authorization: Bearer <access_token>   (guardian's token)

{ "learnerEmail": "child@example.com" }
```

**Server logic:**
1. Verify caller has `guardian` role (if not, add it — any user can become a guardian)
2. Look up `learnerEmail` in `users` table
3. If not found, return `{ status: "invite_sent", note: "User not registered yet" }` and optionally send an invite email (via existing `@lacspace/mailer`)
4. If found, insert `family_members` row with `status = 'pending'`
5. Push WS notification to the learner: `{ type: "family_invite", guardianName: "...", guardianId: "..." }`
6. Return `{ status: "invited", learnerId: "usr_def456" }`

#### Accept invite (learner's side)

```
POST /api/family/accept/:inviteId
Authorization: Bearer <access_token>   (learner's token)
```

**Authorization:** The `learner_id` on the `family_members` row must match the JWT's `sub`.

Updates `family_members.status = 'active'`, sets `accepted_at`. Sends WS notification to the guardian: `{ type: "family_accepted", learnerId: "..." }`.

#### Revoke (either party)

```
POST /api/family/revoke/:membershipId
Authorization: Bearer <access_token>   (either guardian or learner)
```

Sets `status = 'revoked'`. Guardian immediately stops receiving progress events. The guardian's dashboard shows "Connection revoked" for that learner.

#### View learner progress (guardian)

```
GET /api/family/:learnerId/progress?courseId=mcr3u&since=2026-10-01T00:00:00Z&limit=50
Authorization: Bearer <access_token>   (guardian)
```

**Authorization:** Verify `family_members` has `(guardian_id = current_user, learner_id = :learnerId, status = 'active')`. Reject with 403 otherwise.

```json
{
  "learnerId": "usr_def456",
  "learnerName": "Alex",
  "events": [
    {
      "eventType": "quiz_completed",
      "lessonId": "01.03",
      "courseId": "mcr3u",
      "payload": { "score": 7, "total": 10, "percentage": 70 },
      "timestamp": "2026-10-28T14:30:00Z"
    },
    {
      "eventType": "lesson_opened",
      "lessonId": "02.01",
      "courseId": "mcr3u",
      "payload": {},
      "timestamp": "2026-10-28T15:00:00Z"
    }
  ],
  "summary": {
    "lessonsOpened": 12,
    "quizzesCompleted": 4,
    "avgQuizScore": 82.5,
    "lastActiveAt": "2026-10-28T15:00:00Z",
    "activeDaysThisWeek": 3
  }
}
```

---

### 7. Hooking Progress Events into the Existing API

**The minimal-invasive approach:** Add a thin `recordProgress()` call in `handleApiRequest()` at points where learner activity happens. No changes to the core data logic. The call is a no-op in single-user mode.

Key hook points in `handleApiRequest()`:
```typescript
// After quiz result is saved:
// POST /api/courses/:id/lessons/:lessonId/popquiz
await recordProgress({
  userId: currentUserId(),  // read from AsyncLocalStorage context
  courseId,
  lessonId,
  eventType: 'quiz_completed',
  payload: { score, total, percentage }
});

// After unit test result is saved:
// POST /api/courses/:id/lessons/:lessonId/unit-test
await recordProgress({ ... eventType: 'unit_test_completed', ... });

// When lesson content is fetched (indicates learner opened the lesson):
// GET /api/courses/:id/lessons/:lessonId (lesson content fetch)
await recordProgress({ ... eventType: 'lesson_opened', ... });

// When AI tab generation completes:
// POST /api/courses/:id/course-docs
await recordProgress({ ... eventType: 'tab_generated', payload: { tab } ... });

// When checkpoint is added/modified:
// POST /api/courses/:id/checkpoints
await recordProgress({ ... eventType: 'checkpoint_added', ... });
```

**Accessing the current userId inside `handleApiRequest()`:** Since we're using AsyncLocalStorage for the data directory, we add a parallel `userIdContext`:

```typescript
// server/cloud/middleware.ts
export const userIdContext = new AsyncLocalStorage<string>();

export function currentUserId(): string | null {
  return userIdContext.getStore() ?? null;
}
```

The cloud server wraps every request in both contexts:
```typescript
userIdContext.run(userId, () => {
  dataDirContext.run(getDataDirForUser(userId), async () => {
    return handleApiRequest(req, url);
  });
});
```

In single-user mode, `currentUserId()` returns `null` and `recordProgress()` no-ops.

---

### 8. Desktop ↔ Cloud Sync

This is a new flow not present in the current system. Today, the Desktop is the source of truth and the iPad pulls from it over LAN. With the cloud server, both Desktop and iPad can sync against the cloud.

#### Sync model: cloud is the shared truth, local is the working copy

```
Desktop (local)  ←→  Cloud Server  ←→  iPad/Mobile
     ↑                    ↑                ↑
  edit here          stores truth     reads/takes quizzes
```

The Desktop app gains a new Settings → Cloud panel where the user enters their cloud server URL and logs in. Once connected:

**Pull (cloud → desktop):**
- Reuses the existing `/api/sync/bundle` endpoint (already produces a zip of the user's courses)
- Desktop calls `GET /api/sync/bundle?since=<lastSyncTimestamp>` with JWT auth
- Same extraction logic as the iPad sync, but into the Desktop's local data dir

**Push (desktop → cloud):**
- Reuses the existing `/api/sync/push` endpoint (already accepts JSON with checkpoints, annotations, documents)
- Desktop calls `POST /api/sync/push` with JWT auth when local edits are detected
- Same merge logic (last-writer-wins by mtime) already exists on the server

**Conflict resolution:** Same as today's iPad ↔ Desktop sync — last writer wins per file, based on modification timestamps. The `date` field in the push payload already implements this.

**Offline:** The Desktop always works offline against its local data directory. Sync happens when connected. The auto-push debounce (already in `syncState.svelte.ts`) handles reconnection gracefully.

This means the Desktop continues to work exactly as it does today for local-only users. Cloud sync is opt-in.

---

### 9. MCP Server in Cloud Mode

The existing MCP server (used by Claude Desktop, CLI tools) needs consideration:

- **Per-user MCP tokens:** In cloud mode, each user's `.mcp-token` lives in their own data dir and works as-is. But the MCP auth in `server/mcp/auth.ts` currently validates against `localhost` origins only.
- **Recommended approach:** Disable the MCP HTTP endpoint in cloud mode. MCP access via AI tools should go through the user's local Desktop server, which proxies to the cloud via the sync protocol. This avoids exposing MCP to the internet and keeps the existing localhost-only security model intact.
- If remote MCP is eventually needed, add a separate auth layer that maps MCP tokens to user identities, similar to how the REST auth works.

---

### 10. Routing Cloud vs. Single-User Server

Keep both modes operational — the Tauri desktop app continues to run in single-user mode (no auth, no DB); the cloud server is a separate entry point that wraps the same `handleApiRequest()`:

```typescript
// server/cloud/index.ts  (new file, parallel to server/index.ts)
import { handleApiRequest } from '../../app/src/lib/server/api';
import { verifyAccessToken } from './auth';
import { dataDirContext, getDataDirForUser, userIdContext } from './middleware';
import { wsHandlers } from './wsHub';

const BLOCKED_PATHS = new Set(['/api/open-folder', '/api/network-ip', '/api/pairing/info']);

Bun.serve({
  port: parseInt(process.env.PORT || '3182'),
  hostname: process.env.HOST || '0.0.0.0',

  async fetch(req, server) {
    const url = new URL(req.url);

    // WebSocket upgrade
    if (url.pathname === '/ws') {
      if (server.upgrade(req, { data: { userId: '', roles: [], authenticated: false } })) {
        return; // upgraded
      }
      return new Response('WebSocket upgrade failed', { status: 400 });
    }

    // Auth routes (no JWT required)
    if (url.pathname.startsWith('/auth/')) {
      return handleAuthRoutes(req, url);
    }

    // Block local-only endpoints
    if (BLOCKED_PATHS.has(url.pathname)) {
      return new Response(JSON.stringify({ message: 'Not available in cloud mode' }),
        { status: 404, headers: { 'Content-Type': 'application/json' } });
    }

    // All other routes require JWT
    const payload = await verifyAccessToken(req);
    if (!payload?.sub) {
      return new Response(JSON.stringify({ message: 'Authentication required' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } });
    }

    const userId = payload.sub as string;

    // Cloud-specific routes (marketplace, family)
    if (url.pathname.startsWith('/api/marketplace/')) {
      return userIdContext.run(userId, () =>
        dataDirContext.run(getDataDirForUser(userId), () =>
          handleMarketplaceRoutes(req, url, userId)));
    }
    if (url.pathname.startsWith('/api/family/')) {
      return userIdContext.run(userId, () =>
        handleFamilyRoutes(req, url, userId));
    }

    // All existing /api/* routes — scoped to user's data dir
    return userIdContext.run(userId, () =>
      dataDirContext.run(getDataDirForUser(userId), () =>
        handleApiRequest(req, url)));
  },

  websocket: wsHandlers
});

// server/index.ts remains completely unchanged — single-user mode.
```

---

### 11. Docker Setup

```yaml
# docker-compose.yml
services:
  coursedeck:
    build:
      context: .
      dockerfile: Dockerfile.cloud
    restart: unless-stopped
    environment:
      NODE_ENV: production
      PORT: 3182
      HOST: 0.0.0.0
      CLOUD_MODE: "true"
      DATA_ROOT: /data
      ACCESS_TOKEN_SECRET: ${ACCESS_TOKEN_SECRET}     # generate: openssl rand -hex 32
      REFRESH_TOKEN_SECRET: ${REFRESH_TOKEN_SECRET}   # generate: openssl rand -hex 32
      ACCESS_TOKEN_TTL: 900       # 15 minutes
      REFRESH_TOKEN_TTL: 2592000  # 30 days
    volumes:
      - coursedeck_data:/data
    ports:
      - "127.0.0.1:3182:3182"   # Caddy reverse-proxies to this; not exposed directly

  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    depends_on:
      - coursedeck
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config

volumes:
  coursedeck_data:
  caddy_data:
  caddy_config:
```

**Phase 1 uses SQLite** — no PostgreSQL container needed. The database file lives at `/data/coursedeck.db` inside the `coursedeck_data` volume. This makes initial deployment much simpler (2 containers: app + Caddy).

When scaling to PostgreSQL later, add a `postgres` service:
```yaml
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: coursedeck
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: coursedeck
    volumes:
      - pg_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U coursedeck"]
      interval: 10s
      timeout: 5s
      retries: 5
```

```dockerfile
# Dockerfile.cloud
FROM oven/bun:1.1-alpine AS builder
WORKDIR /app
COPY app/package.json app/bun.lockb ./app/
RUN cd app && bun install --frozen-lockfile
COPY app/ ./app/
RUN cd app && bun run build

FROM oven/bun:1.1-alpine
WORKDIR /app
COPY --from=builder /app/app/build ./app/build
COPY server/ ./server/
COPY app/src/ ./app/src/
COPY package.json bun.lockb ./
RUN bun install --frozen-lockfile --production
EXPOSE 3182
CMD ["bun", "run", "server/cloud/index.ts"]
```

```
# Caddyfile
yourdomain.com {
    reverse_proxy coursedeck:3182
    header Strict-Transport-Security "max-age=31536000; includeSubDomains"
}
```

> Caddy's `reverse_proxy` transparently handles WebSocket upgrades when the backend
> returns HTTP 101. No special `@ws` matcher is needed.

---

### 12. Client Changes

#### Tauri Desktop — no changes for single-user mode

When pointed at a cloud server URL (a new setting in Settings → "Cloud Server"), the desktop app:
1. Prompts for email + password via a new `CloudLoginModal.svelte`
2. Stores the access token in Tauri secure store (desktop) or `httpOnly` cookie (web)
3. Passes `Authorization: Bearer <token>` header in `smartFetch()` via a new `getAuthHeaders()` helper
4. On 401, triggers silent refresh via `/auth/refresh` using the stored refresh token
5. On 403, shows a "session expired — please log in again" modal

```typescript
// app/src/lib/cloudAuth.ts — new file

let accessToken: string | null = null;
let refreshToken: string | null = null;

export function getAuthHeaders(): Record<string, string> {
  return accessToken ? { Authorization: `Bearer ${accessToken}` } : {};
}

export function isCloudMode(): boolean {
  return accessToken !== null;
}

export async function attemptTokenRefresh(): Promise<boolean> {
  if (!refreshToken) return false;
  try {
    const cloudUrl = getCloudServerUrl();
    const res = await fetch(`${cloudUrl}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken })
    });
    if (!res.ok) return false;
    const data = await res.json();
    accessToken = data.accessToken;
    refreshToken = data.refreshToken;
    await persistTokens(); // Tauri secure store or localStorage
    return true;
  } catch {
    return false;
  }
}
```

```typescript
// Modification to existing smartFetch() in app/src/lib/api.ts:

export async function smartFetch(url: string, init?: RequestInit): Promise<Response> {
  const authHeaders = getAuthHeaders(); // empty object in single-user mode
  const mergedHeaders = { ...authHeaders, ...(init?.headers ?? {}) };

  const response = await _rawFetch(url, { ...init, headers: mergedHeaders });

  // Transparent token refresh on 401 (cloud mode only)
  if (response.status === 401 && isCloudMode() && !url.includes('/auth/')) {
    const refreshed = await attemptTokenRefresh();
    if (refreshed) {
      const retryHeaders = { ...getAuthHeaders(), ...(init?.headers ?? {}) };
      return _rawFetch(url, { ...init, headers: retryHeaders });
    }
    window.dispatchEvent(new CustomEvent('cloud-auth-expired'));
  }

  return response;
}
```

#### WebSocket client for guardian dashboard

```typescript
// app/src/lib/cloudWs.svelte.ts
import { getStoredAccessToken } from './cloudAuth';

export const wsState = $state({
  connected: false,
  progressEvents: [] as ProgressEvent[]
});

let ws: WebSocket | null = null;
let reconnectAttempts = 0;

export function connectCloudWS(serverUrl: string): void {
  const wsUrl = serverUrl.replace(/^http/, 'ws') + '/ws';
  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    ws!.send(JSON.stringify({ type: 'auth', token: getStoredAccessToken() }));
    reconnectAttempts = 0;
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'auth_ok') { wsState.connected = true; return; }
    if (msg.type === 'progress_update') {
      wsState.progressEvents = [msg, ...wsState.progressEvents].slice(0, 200);
    }
    if (msg.type === 'family_invite' || msg.type === 'family_accepted') {
      window.dispatchEvent(new CustomEvent('family-update', { detail: msg }));
    }
  };

  ws.onclose = () => {
    wsState.connected = false;
    // Exponential backoff: 1s, 2s, 4s, 8s, ... capped at 30s
    const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30_000);
    reconnectAttempts++;
    setTimeout(() => connectCloudWS(serverUrl), delay);
  };

  ws.onerror = () => {
    ws?.close(); // triggers onclose → reconnect
  };
}

export function disconnectCloudWS(): void {
  reconnectAttempts = Infinity; // prevent reconnect
  ws?.close();
  ws = null;
  wsState.connected = false;
}
```

---

## Implementation Phases

### Phase 1 — Auth + Cloud Server Shell

**Goal:** A working cloud server that authenticates users and serves per-user data directories. The existing single-user Tauri app is unmodified.

1. Create `server/cloud/` directory with:
   - `index.ts` — cloud server entry point (wraps existing `handleApiRequest`)
   - `auth.ts` — JWT issue/verify/refresh via `jose`
   - `db.ts` — SQLite setup via `bun:sqlite` + migration runner
   - `middleware.ts` — AsyncLocalStorage for data-dir + userId scoping
2. Add 2-line `dataDirContext` check to `getDataDir()` in `paths.ts`
3. Create `docker/` with `docker-compose.yml`, `Dockerfile.cloud`, `Caddyfile`, `.env.example`
4. Add `POST /auth/register`, `POST /auth/login`, `POST /auth/refresh`, `POST /auth/logout`
5. Block local-only endpoints in cloud entry point
6. Run DB migration: `users`, `sessions` tables only

**Test:** Register a user, log in, receive tokens, make authenticated `GET /api/courses` call, see empty course list from user's fresh data dir. A second user sees their own isolated courses.

**New dependencies:** `jose` (JWT)

### Phase 2 — WebSocket Hub + Progress Events

1. Add `websocket:` handler to `Bun.serve()` in cloud entry point
2. Implement `wsHub.ts`, `progressReporter.ts`
3. DB migration: `progress_events` table
4. Add `recordProgress()` calls at hook points in `handleApiRequest()`
5. Add `currentUserId()` via AsyncLocalStorage
6. Add `GET /api/progress` for self-lookup (own progress history)
7. Add `cloudWs.svelte.ts` and `cloudAuth.ts` to frontend

**Test:** Quiz submission from client emits event; WS client (same user, second browser tab) receives `progress_update`.

### Phase 3 — Family System

1. DB migration: `family_members` table
2. Implement `/api/family/*` endpoints (invite, accept, revoke, progress)
3. Guardian progress events: WS broadcast to all active guardians
4. Frontend: `GuardianDashboard.svelte`, `FamilySettings.svelte`
5. Add learner invite email flow (using existing `@lacspace/mailer`)

**Test:** Guardian invites learner, learner accepts, learner completes quiz, guardian sees real-time WS event on dashboard.

### Phase 4 — Marketplace

1. DB migration: `marketplace_courses` table
2. Implement `createMarketplaceBundleStream()` (credential-stripped variant of sync bundle)
3. Implement `/api/marketplace/*` endpoints (publish, browse, clone, update check)
4. Storage quota enforcement on clone
5. Frontend: `Marketplace.svelte` — search, preview, install button
6. Admin approval endpoint (`POST /api/admin/marketplace/:id/approve`)

**Test:** User publishes a course, another user searches and clones it, it appears in their course list. No credentials leak in the bundle.

### Phase 5 — Desktop ↔ Cloud Sync

1. Add Settings → Cloud panel (`app/src/routes/settings/cloud/+page.svelte`)
2. Add `CloudLoginModal.svelte` with email/password form
3. Modify `smartFetch()` to inject auth headers when in cloud mode
4. Add cloud pull (reuse sync bundle download) and cloud push (reuse sync push) flows
5. Add auto-sync toggle (debounced push on local file changes, like the existing iPad auto-push)

**Test:** Desktop edits a course locally, push syncs to cloud, iPad pulls the update.

---

## Security Considerations

### Must-Have Before Go-Live

| Risk | Mitigation |
|------|-----------|
| Path traversal in per-user data dirs | `safeJoin()` already validates; cloud middleware computes dataDir from `sub` claim only — never from JWT body or user input |
| Token theft (access token) | 15-min TTL; `httpOnly` cookie for web clients; Tauri secure store for desktop |
| Remote code execution | Block `openWithFileManager`, `xdg-open` endpoints entirely in cloud mode |
| Guardian spying without consent | `family_members.status` must be `'active'` (learner accepted) before any progress is visible; learner can revoke at any time |
| Marketplace credential leak | Dedicated `createMarketplaceBundleStream()` strips all config files, secrets, and credentials from published bundles |
| Mass download / abuse | Rate-limit marketplace clone: 10/user/hour; rate-limit login: 5/IP/minute (429) |
| Brute-force login | In-memory sliding window counter by IP; exponential lockout after 10 failures |
| SQL injection | Parameterized queries everywhere; never string-interpolate user input into SQL |
| DoS via large uploads | Per-user storage quota (2 GB default); `maxRequestBodySize` reduced to 50 MB for marketplace publish |
| Secrets in environment | Never commit `.env` to git; use Docker secrets or a `.env` file outside the repo |
| Storage exhaustion | Per-user quota check before all write operations |

### Recommended Additions

- **Email verification** on registration before account is activated
- **PKCE flow** option for future OAuth2 providers (Google, Apple) — the existing Google Calendar OAuth flow in `sync.service.ts` can serve as the reference implementation
- **Audit log** table for sensitive actions (publish, guardian grant, admin approve, account delete)
- **CORS allowlist** via `CORS_ALLOWED_ORIGINS` env var — never wildcard in production
- **CSP headers** via Caddy for the served SPA

---

## How the Existing Sync Protocol Integrates

The iPad ↔ Desktop sync protocol maps cleanly onto the cloud server with no protocol changes — only the addition of auth headers:

| Today (LAN, no auth) | Cloud (HTTPS, JWT auth) |
|-------|-------|
| `GET /api/sync/bundle` | Same endpoint, requires JWT, serves requesting user's data dir |
| `POST /api/sync/push` | Same endpoint, requires JWT, writes to requesting user's data dir |
| `GET /api/sync/courses` | Same endpoint, requires JWT |

The cloud server becomes the new "desktop" for iPad/mobile clients. The iPad app's sync code changes are minimal — inject `Authorization: Bearer <token>` into the fetch calls and point at the cloud URL instead of a LAN IP.

The Tauri Desktop gains the **same** sync protocol in the opposite direction: it can push local edits up to the cloud and pull remote changes down. See [Section 8: Desktop ↔ Cloud Sync](#8-desktop--cloud-sync).

---

## Tech Stack Summary

| Layer | Technology | Rationale |
|-------|-----------|-----------|
| Runtime | Bun 1.x | Already used; native WebSocket, argon2, SQLite, fast startup |
| HTTP/WS server | `Bun.serve()` | Already used; WebSocket support built-in |
| Auth tokens | `jose` (npm) | Pure-JS JWT, works in Bun, widely audited |
| Database (phase 1) | SQLite via `bun:sqlite` | Zero-config, single-file, built into Bun runtime |
| Database (phase 2+) | PostgreSQL 16 | JSONB for event payloads, GIN indexes for tag search, concurrent writes |
| Reverse proxy | Caddy 2 | Automatic TLS, minimal config, transparent WebSocket proxying |
| File storage | Docker volume | Per-user data dirs + marketplace bundles; S3/MinIO later if needed |
| Frontend | SvelteKit (unchanged build) | No changes to existing SPA; new routes added for marketplace/guardian |
| Password hashing | `Bun.password.hash()` (argon2id) | Built into Bun runtime, no extra deps |
| Email | `@lacspace/mailer` (already in deps) | Already used for teacher check-in emails |
| Containerization | Docker + Docker Compose | Ubuntu host, 2 containers for phase 1 (app + Caddy) |

---

## File/Module Additions Summary

```
server/
├── index.ts                          (unchanged — single-user mode)
└── cloud/
    ├── index.ts                      (new: cloud server entry point, wraps handleApiRequest)
    ├── auth.ts                       (new: JWT issue/verify/refresh, login rate-limiting)
    ├── db.ts                         (new: bun:sqlite setup + migration runner)
    ├── middleware.ts                  (new: AsyncLocalStorage for dataDir + userId)
    ├── quotas.ts                     (new: per-user storage quota checks)
    ├── wsHub.ts                      (new: WebSocket connection registry + broadcast)
    ├── progressReporter.ts           (new: recordProgress() + guardian fan-out)
    ├── marketplaceBundle.ts          (new: credential-stripped bundle for publishing)
    ├── routes/
    │   ├── marketplace.ts            (new: /api/marketplace/*)
    │   ├── family.ts                 (new: /api/family/*)
    │   └── auth.routes.ts            (new: /auth/*)
    └── migrations/
        ├── 001_users_sessions.sql
        ├── 002_progress_events.sql
        ├── 003_family.sql
        └── 004_marketplace.sql

app/src/lib/
├── cloudAuth.ts                      (new: token storage, refresh, cloud-mode detection)
├── cloudWs.svelte.ts                 (new: WebSocket state + connect/reconnect with backoff)
├── api.ts                            (modified: inject auth headers in smartFetch, handle 401)
└── server/
    └── paths.ts                      (modified: 2-line AsyncLocalStorage check in getDataDir())

app/src/lib/components/
├── CloudLoginModal.svelte            (new)
├── GuardianDashboard.svelte          (new)
├── Marketplace.svelte                (new)
├── MarketplaceCourseCard.svelte      (new)
└── FamilySettings.svelte             (new)

app/src/routes/
├── marketplace/
│   └── +page.svelte                  (new)
├── guardian/
│   └── +page.svelte                  (new)
└── settings/
    └── cloud/
        └── +page.svelte              (new: cloud server URL, login/logout)

docker/
├── docker-compose.yml                (new)
├── Dockerfile.cloud                  (new)
├── Caddyfile                         (new)
└── .env.example                      (new)
```

---

## Prior Art / How Others Do This

**Moodle (LMS):** PHP monolith, MySQL, per-course enrolment model, guardian role built-in. Heavy but mature. Not applicable here — we want lightweight and real-time.

**Udemy/Coursera:** REST API + S3 for course assets + WebSocket notifications. Marketplace approval flow. Our marketplace follows this model at small scale.

**Duolingo:** Streak/progress events stored in append-only event tables, parent dashboard on top. Family linking via invite code. Our `progress_events` table is a direct analog.

**Linear / Liveblocks:** Real-time collaboration via WebSocket rooms with presence. Bun's native WebSocket + a connection registry per `userId` is the minimal version of this for guardian → learner progress streaming.

**Key decisions over alternatives:**
- **SSE (Server-Sent Events) vs WebSocket:** SSE is simpler for one-directional push (guardian watching learner). WebSocket is chosen here because the client also needs to send ping/auth frames and future features (e.g., collaborative annotation) will require bidirectional flow.
- **Redis Pub/Sub vs in-process Map:** In-process `Map<userId, Set<WebSocket>>` works for a single server instance (our case). Add Redis if you scale to multiple instances later.
- **SQLite vs PostgreSQL:** SQLite for phase 1 — eliminates a container, zero-config, built into Bun. Migrate to PostgreSQL when you need multiple server processes or heavier concurrent writes.
- **Drizzle ORM vs raw SQL:** Raw parameterized queries — the schema is simple, and an ORM would add deps and indirection for no benefit at this scale.
