import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { CourseService, type SchedulePayloadStats } from './courses';
import type { MarkupStroke } from '../markup/types';
import { PromptService } from './prompts';
import { LLMService, type LLMConfig, type LlmModelCard } from './llm';
import { stripLessonMedia } from '../markdown/stripMedia';
import { queueManager } from './queue';
import {
  getDataDir,
  getCoursesDir,
  getPromptsDir,
  safeJoin,
  assertCourseId,
  assertLessonId,
  assertPromptId,
  assertTab,
  PathValidationError,
  getDataStorageInfo,
  setCustomDataDir,
  loadAppSettings,
  saveAppSettings,
  getMcpServerInfo
} from './paths';
import { parseFrontmatter, serializeWithFrontmatter } from '../parser/frontmatter';
import { repairMarkdownTables } from '../markdown/tableRepair';
import { CourseIngest, type CourseDocType, type CourseManifest } from '../parser/courseIngest';
import { validateScheduleMarkdown } from '../parser/scheduleValidation';
import type { SchedulePreferences } from '../schedule';
import { ScheduleParser, toggleEventDone } from '../parser/scheduleParser';
import { optimizeCourseImages } from '../parser/imageOptimizer';
import { createDataBackupZip, createDataBackupZipStream, createSyncBundleZipStream, restoreDataBackupZip } from './backup';
import { SyncService } from './services/sync/sync.service';
import { GoogleCalendarProvider } from './services/sync/google.provider';
import { ArcSyncProvider } from './services/sync/arc.provider';
import { getOrCreateMcpToken, rotateMcpToken } from './services/mcp.service';
import { TeacherCheckinService, cleanImageReferences, type PopQuizQuestionResult, type PopQuizResultPayload, type UnitTestQuestionResult, type UnitTestResultPayload } from './services/teacherCheckin.service';
import { QuestionParser } from '../parser/questionParser';
import { formatUnitScopeId, courseDocFileName } from '../tabs';
import { NotFoundError, ConflictError, ValidationError } from './services/errors';
import { CourseService as CourseManagerService } from './services/course.service';
import { extractTextFromPdf } from './pdfText';

/**
 * Single source of truth for the entire HTTP API.
 *
 * This framework-agnostic handler is served by BOTH:
 *  - the SvelteKit catch-all route `src/routes/api/[...path]/+server.ts` (dev + web)
 *  - the compiled Bun sidecar `server/index.ts` (packaged desktop builds)
 *
 * Any endpoint change lands here once — the two serving paths can never drift.
 * CORS is applied by the sidecar wrapper, not here.
 */

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.ico': 'image/x-icon'
};

type Tab = 'summary' | 'notes' | 'test';

/** Course-level document types accepted by /api/courses/:id/course-docs. */
const COURSE_DOC_TYPES: readonly CourseDocType[] = ['summary', 'notes', 'test', 'schedule', 'logs'];

interface ActiveCourseDocJob {
  courseId: string;
  type: CourseDocType;
  status: 'generating' | 'completed' | 'failed';
  startedAt: number;
  result?: {
    markdown: string;
    usage?: any;
    warnings?: string[];
    debug?: any;
  };
  error?: string;
}

const activeCourseDocJobs = new Map<string, ActiveCourseDocJob>();

const DEFAULT_LESSON_TABS: readonly Tab[] = ['summary', 'notes', 'test'];
const BULK_SUPPORTED_TABS: readonly string[] = ['summary', 'notes', 'test', 'studysheet', 'cheatsheet'];

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

/** Matches SvelteKit's error() body shape: { message }. */
function error(status: number, message: string): Response {
  return json({ message }, status);
}

/** Store view shared by every /api/llm response (keys are never included). */
function llmStoreState(store: ReturnType<typeof LLMService.loadStore>) {
  const active = LLMService.activeCard(store);
  return {
    hasConfig: Boolean(active && active.baseUrl),
    activeId: store.activeId,
    cards: LLMService.summarizeCards(store)
  };
}

const FALLBACK_COURSE_BUILDER_PROMPT = `# Course Builder Prompt

You are an expert curriculum architect and educator.
Analyze the provided course material, syllabus, textbook chapter, or document and propose a structured course curriculum.

### Instructions:
1. Extract or determine:
   - "title": Clear and descriptive course title
   - "suggestedId": Short lowercase alphanumeric code (e.g. "cs101", "mcr3u")
   - "grade": Target grade level or course level (e.g. "11", "12", "Introductory")
   - "level": Academic level (e.g. "University", "College", "Open", "AP")
   - "description": 1-3 sentence course syllabus description
2. Structure the curriculum into a logical sequence of Units (typically 3 to 6 units).
3. Under each unit, break down the content into individual Lessons (and optional assignments):
   - "id": Two-digit dot numbering: "01.01", "01.02" for Unit 1; "02.01", "02.02" for Unit 2, etc.
   - "title": Student-friendly topic title
   - "type": "lesson" or "assignment"
   - "content": A markdown starter overview for the lesson with learning goals and key concepts

### Output Format:
Respond ONLY with a valid JSON object matching the requested schema without markdown backticks.`;

function extractJsonProposal(raw: string): any {
  let text = raw.trim();
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenceMatch) {
    text = fenceMatch[1].trim();
  }
  try {
    return JSON.parse(text);
  } catch {
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      return JSON.parse(text.substring(firstBrace, lastBrace + 1));
    }
    throw new Error('AI output did not contain valid JSON.');
  }
}

function normalizeProposal(rawProposal: any): {
  title: string;
  suggestedId: string;
  grade: string;
  level: string;
  description: string;
  units: Array<{
    number: number;
    title: string;
    lessons: Array<{
      id: string;
      title: string;
      type: 'lesson' | 'assignment';
      content?: string;
    }>;
  }>;
} {
  const title = typeof rawProposal?.title === 'string' && rawProposal.title.trim() ? rawProposal.title.trim() : 'New Course';
  let suggestedId = typeof rawProposal?.suggestedId === 'string' ? rawProposal.suggestedId.toLowerCase().replace(/[^a-z0-9._-]/g, '') : '';
  if (!suggestedId) {
    suggestedId = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 16).replace(/^-+|-+$/g, '') || 'course';
  }
  const grade = typeof rawProposal?.grade === 'string' ? rawProposal.grade.trim() : '11';
  const level = typeof rawProposal?.level === 'string' ? rawProposal.level.trim() : 'University';
  const description = typeof rawProposal?.description === 'string' ? rawProposal.description.trim() : '';

  const rawUnits = Array.isArray(rawProposal?.units) ? rawProposal.units : [];
  const units: Array<{
    number: number;
    title: string;
    lessons: Array<{
      id: string;
      title: string;
      type: 'lesson' | 'assignment';
      content?: string;
    }>;
  }> = [];

  for (let uIdx = 0; uIdx < rawUnits.length; uIdx++) {
    const u = rawUnits[uIdx];
    const uNum = typeof u.number === 'number' ? u.number : uIdx + 1;
    const uTitle = typeof u.title === 'string' && u.title.trim() ? u.title.trim() : `Unit ${uNum}`;
    const rawLessons = Array.isArray(u.lessons) ? u.lessons : [];
    const lessons: Array<{
      id: string;
      title: string;
      type: 'lesson' | 'assignment';
      content?: string;
    }> = [];

    for (let lIdx = 0; lIdx < rawLessons.length; lIdx++) {
      const l = rawLessons[lIdx];
      const lNum = lIdx + 1;
      const defaultId = `${String(uNum).padStart(2, '0')}.${String(lNum).padStart(2, '0')}`;
      const lId = typeof l.id === 'string' && l.id.trim() ? l.id.trim() : defaultId;
      const lTitle = typeof l.title === 'string' && l.title.trim() ? l.title.trim() : `Lesson ${lNum}`;
      const lType = l.type === 'assignment' ? 'assignment' : 'lesson';
      const lContent = typeof l.content === 'string' ? l.content : undefined;

      lessons.push({
        id: lId,
        title: lTitle,
        type: lType,
        content: lContent
      });
    }

    if (lessons.length === 0) {
      lessons.push({
        id: `${String(uNum).padStart(2, '0')}.01`,
        title: 'Introduction',
        type: 'lesson'
      });
    }

    units.push({
      number: uNum,
      title: uTitle,
      lessons
    });
  }

  if (units.length === 0) {
    units.push({
      number: 1,
      title: 'Unit 1: Overview',
      lessons: [
        {
          id: '01.01',
          title: 'Introduction',
          type: 'lesson'
        }
      ]
    });
  }

  return {
    title,
    suggestedId,
    grade,
    level,
    description,
    units
  };
}

function fileResponse(filePath: string, extraHeaders: Record<string, string> = {}): Response {
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  return new Response(new Uint8Array(fs.readFileSync(filePath)), {
    status: 200,
    headers: {
      'Content-Type': contentType,
      ...extraHeaders
    }
  });
}

function openWithFileManager(targetDir: string): Promise<Response> {
  if (!fs.existsSync(targetDir)) {
    return Promise.resolve(error(404, `Folder not found: ${targetDir}`));
  }
  const platform = os.platform();
  const binary = platform === 'darwin' ? 'open' : platform === 'win32' ? 'explorer.exe' : 'xdg-open';
  return new Promise((resolve) => {
    execFile(binary, [targetDir], (err) => {
      if (err) {
        console.error('Failed to open folder:', err);
        resolve(error(500, err.message));
      } else {
        resolve(json({ success: true, path: targetDir }));
      }
    });
  });
}

function renderOAuthResultHtml(success: boolean, errorMsg?: string, accountEmail?: string): string {
  const title = success ? 'Connected to Google Calendar!' : 'Authorization Failed';
  const subtitle = success
    ? 'Your Google account has been authorized. CourseDeck can now synchronize your study schedules.'
    : (errorMsg || 'Failed to complete Google Calendar authorization.');
  const icon = success
    ? `<svg style="width:52px;height:52px;color:#10b981;margin:0 auto 1.25rem;display:block;" fill="none" viewBox="0 0 24 24" stroke="currentColor">
         <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
       </svg>`
    : `<svg style="width:52px;height:52px;color:#ef4444;margin:0 auto 1.25rem;display:block;" fill="none" viewBox="0 0 24 24" stroke="currentColor">
         <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
       </svg>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} - CourseDeck</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      background: #0c0a09;
      color: #f5f5f4;
      text-align: center;
      padding: 1.5rem;
      box-sizing: border-box;
    }
    .card {
      background: #1c1917;
      border: 1px solid #292524;
      padding: 2.5rem 2rem;
      border-radius: 1rem;
      max-width: 440px;
      width: 100%;
      box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5), 0 8px 10px -6px rgba(0, 0, 0, 0.5);
    }
    h1 {
      font-size: 1.25rem;
      font-weight: 600;
      margin: 0 0 0.5rem;
      color: #fafaf9;
    }
    p {
      font-size: 0.875rem;
      color: #a8a29e;
      line-height: 1.5;
      margin: 0 0 1.5rem;
    }
    .badge {
      display: inline-block;
      padding: 0.35rem 0.85rem;
      background: #292524;
      border: 1px solid #44403c;
      border-radius: 9999px;
      font-size: 0.8125rem;
      color: #e7e5e4;
      margin-bottom: 1.5rem;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    .btn {
      display: inline-block;
      background: #f5f5f4;
      color: #0c0a09;
      font-weight: 500;
      font-size: 0.875rem;
      padding: 0.5rem 1.5rem;
      border-radius: 0.5rem;
      text-decoration: none;
      cursor: pointer;
      border: none;
      transition: background 0.15s;
    }
    .btn:hover {
      background: #e7e5e4;
    }
    .hint {
      margin-top: 1rem;
      font-size: 0.75rem;
      color: #78716c;
    }
  </style>
</head>
<body>
  <div class="card">
    ${icon}
    <h1>${title}</h1>
    <p>${subtitle}</p>
    ${accountEmail ? `<div class="badge">${accountEmail}</div><br>` : ''}
    <button class="btn" onclick="window.close()">Close Tab</button>
    <div class="hint">${success ? 'This window will close automatically in 3 seconds.' : 'Please return to CourseDeck to retry.'}</div>
  </div>
  <script>
    try {
      if (window.opener) {
        window.opener.postMessage({
          type: ${JSON.stringify(success ? 'GOOGLE_AUTH_SUCCESS' : 'GOOGLE_AUTH_ERROR')},
          email: ${JSON.stringify(accountEmail || '')},
          error: ${JSON.stringify(errorMsg || '')}
        }, '*');
      }
    } catch (e) {}
    ${success ? 'setTimeout(() => { try { window.close(); } catch(e) {} }, 3000);' : ''}
  </script>
</body>
</html>`;
}

export async function handleApiRequest(req: Request, url: URL): Promise<Response> {
  const method = req.method.toUpperCase();

  // Decode exactly once; subpaths below receive already-decoded values.
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return error(400, 'Malformed percent-encoding in request path');
  }

  try {
    // ---- /api/llm ----
    if (pathname === '/api/llm') {
      if (method === 'GET') {
        const read = LLMService.readStore();
        if (!read.ok) {
          // If the file exists on disk but is unparseable JSON, a silent fallback
          // would invite the user to overwrite it with a fresh save — failing
          // loudly lets them fix the syntax and keep their configured models.
          return error(500, `The stored AI models could not be read (${read.error}). Fix or remove llm_config.json, then reload.`);
        }
        const active = LLMService.activeCard(read.store);
        return json({
          ...llmStoreState(read.store),
          config: active
            ? {
                id: active.id,
                label: active.label,
                provider: active.provider,
                baseUrl: active.baseUrl,
                model: active.model,
                authHeaderType: active.authHeaderType,
                temperature: active.temperature,
                timeoutSeconds: active.timeoutSeconds,
                sendSessionId: active.sendSessionId ?? false,
                hasApiKey: Boolean(active.apiKey && active.apiKey.trim())
              }
            : null
        });
      }

      if (method === 'POST') {
        const body = ((await req.json().catch(() => ({}))) || {}) as Record<string, unknown>;
        const action = body.action as string | undefined;
        const config = body.config as LLMConfig | undefined;
        const { systemPrompt, userPrompt, sessionId } = body;

        if (action === 'save_store') {
          const submittedCards = Array.isArray(body.cards) ? (body.cards as LlmModelCard[]) : [];
          const activeId = typeof body.activeId === 'string' ? body.activeId : null;
          const read = LLMService.readStore();
          if (!read.ok) {
            return error(500, `Cannot update AI models because the existing file could not be read (${read.error}). Fix or remove llm_config.json first.`);
          }

          // A card with an empty Base URL cannot be saved (normalizeCards drops
          // them). If the client sent ONLY cards that normalize away, treating the
          // raw length as "models to store" would let one half-filled card clear
          // a working configuration.
          const usableCards = LLMService.normalizeCards(submittedCards);
          if (submittedCards.length > 0 && usableCards.length === 0) {
            return error(400, 'Every model needs a Base URL — nothing was saved, so your existing models are unchanged.');
          }
          // Removing every model is destructive and irreversible once AI features
          // depend on it, so it must be requested explicitly.
          if (usableCards.length === 0 && read.store.cards.length > 0 && body.confirmClear !== true) {
            return error(409, `Refusing to remove all ${read.store.cards.length} configured model(s). Resend with confirmClear: true if that is really intended.`);
          }

          LLMService.replaceCards(submittedCards, activeId);
          return json({ success: true, ...llmStoreState(LLMService.loadStore()) });
        }
        if (action === 'set_active') {
          const id = typeof body.id === 'string' ? body.id : '';
          if (!LLMService.setActiveCard(id)) return error(404, 'Model card not found');
          return json({ success: true, ...llmStoreState(LLMService.loadStore()) });
        }

        // Generation actions accept an explicit config (ad-hoc testing) or fall
        // back to the ACTIVE card, so every AI feature routes through it.
        if (action === 'test' || action === 'generate') {
          const explicit = config && typeof config.baseUrl === 'string' && config.baseUrl.trim() ? config : null;
          const effective = explicit ?? LLMService.loadStoredConfig();
          if (!effective || !effective.baseUrl) {
            return error(400, 'No AI model configured. Add a model in Settings → AI Models.');
          }
          if (sessionId && !effective.sessionId) {
            effective.sessionId = sessionId as string;
          }

          if (action === 'test') {
            return json(await LLMService.testConnection(effective));
          }
          if (!systemPrompt || !userPrompt) {
            return error(400, 'systemPrompt and userPrompt are required for generation');
          }
          try {
            const result = await LLMService.generateResult(
              effective,
              systemPrompt as string,
              stripLessonMedia(userPrompt as string)
            );
            const repaired = repairMarkdownTables(result.completion);
            const reqCourseId = (typeof body.courseId === 'string' && body.courseId.trim())
              ? body.courseId.trim()
              : (typeof sessionId === 'string' && sessionId.trim() ? sessionId.split('-')[0] : null);
            if (reqCourseId && CourseService.getCourse(reqCourseId)) {
              CourseService.recordLog({
                courseId: reqCourseId,
                lessonDoc: typeof body.lessonDoc === 'string' ? body.lessonDoc : (typeof body.tab === 'string' ? body.tab : 'prompt'),
                chars: result.completion.length,
                tokens: result.usage?.total_tokens ?? 0
              });
            }
            return json({ success: true, completion: repaired, usage: result.usage });
          } catch (err) {
            console.error('[LLM] Generation failed:', err);
            return error(500, err instanceof Error ? err.message : 'LLM generation failed');
          }
        }

        // Legacy single-config save (AI setup modal): updates the active card.
        if (action === 'save_config') {
          if (!config || typeof config.baseUrl !== 'string' || !config.baseUrl.trim()) {
            return error(400, 'A Base URL is required to save an AI model');
          }
          // Don't overwrite a config that exists but could not be parsed — the
          // user may be able to repair it, and this path would discard it.
          if (!LLMService.readStore().ok) {
            return error(500, 'The stored AI models could not be read, so they were left untouched. Fix or remove llm_config.json, then reload.');
          }
          LLMService.saveStoredConfig(config);
          const store = LLMService.loadStore();
          return json({ success: true, message: 'LLM configuration saved', activeId: store.activeId });
        }

        return error(400, `Unknown action: ${action}`);
      }
    }

    // ---- /api/pairing/info ----
    if (pathname === '/api/pairing/info' && method === 'GET') {
      const ifaces = os.networkInterfaces();
      const rawIps: string[] = [];
      for (const name of Object.keys(ifaces)) {
        for (const iface of ifaces[name] || []) {
          if (iface.family === 'IPv4' && !iface.internal) {
            rawIps.push(iface.address);
          }
        }
      }

      // Exclude 169.254.* (APIPA link-local) and 127.* (loopback)
      // Accept RFC 1918 private subnets: 192.168.*, 10.*, 172.16-31.*
      function isPrivateLan(ip: string): boolean {
        if (!ip || ip.startsWith('169.254.') || ip.startsWith('127.')) return false;
        if (ip.startsWith('192.168.') || ip.startsWith('10.')) return true;
        const match = ip.match(/^172\.(\d{1,3})\./);
        if (match) {
          const octet = parseInt(match[1], 10);
          return octet >= 16 && octet <= 31;
        }
        return false;
      }

      const privateIps = rawIps.filter(isPrivateLan);

      // Prioritize 192.168.* (most common home Wi-Fi), then 10.*, then 172.*
      privateIps.sort((a, b) => {
        const score = (ip: string) => (ip.startsWith('192.168.') ? 1 : ip.startsWith('10.') ? 2 : 3);
        return score(a) - score(b);
      });

      // Strict fallback: never show 169.254.*
      const lanIps = privateIps.length > 0
        ? privateIps
        : rawIps.filter((ip) => !ip.startsWith('169.254.') && !ip.startsWith('127.'));

      const hostname = os.hostname();
      const port = 3182;
      const primaryIp = lanIps[0] || '';
      return json({
        port,
        lanIps,
        hostname,
        primaryIp,
        primaryUrl: primaryIp ? `http://${primaryIp}:${port}` : `http://${hostname}:${port}`,
        bonjourUrl: `http://${hostname}:${port}`
      });
    }

    // ---- /api/sync/courses (desktop course list for selective sync) ----
    if (pathname === '/api/sync/courses' && method === 'GET') {
      const courses = CourseService.listCourses()
        .filter((c) => !c.archived)
        .map((c) => ({
          id: c.id.toLowerCase(),
          title: c.title || c.id,
          lessonCount: (c.units ?? []).reduce((sum, u) => sum + (u.lessons?.length || 0), 0),
          coursePDF: Boolean(c.coursePDF)
        }))
        .sort((a, b) => a.title.localeCompare(b.title));
      return json({ courses });
    }

    // ---- /api/sync/bundle (iPad offline sync: streaming zip archive) ----
    if (pathname === '/api/sync/bundle' && method === 'GET') {
      const courseIdsParam = url.searchParams.get('courseIds');
      const requestedIds = courseIdsParam
        ? courseIdsParam.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
        : null;

      const sinceParam = url.searchParams.get('since');
      if (sinceParam && Number.isNaN(Date.parse(sinceParam))) {
        return error(400, 'Invalid "since" timestamp — use ISO 8601 (e.g. 2026-10-27T12:00:00Z)');
      }

      const generatedAt = new Date().toISOString();
      const includeLlmKeys = url.searchParams.get('includeLlmKeys') === 'true';
      const llmStore = LLMService.loadStore();

      const { stream, courseCount, fileCount } = createSyncBundleZipStream({
        courseIds: requestedIds,
        since: sinceParam,
        syncMeta: {
          version: 1,
          generatedAt,
          llmConfig: {
            version: llmStore.version,
            activeId: llmStore.activeId,
            cards: llmStore.cards.map((card) => ({
              ...card,
              apiKey: includeLlmKeys ? card.apiKey : undefined
            }))
          },
          prompts: PromptService.listPrompts()
        }
      });

      return new Response(stream, {
        headers: {
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="coursedeck-sync-${generatedAt}.zip"`,
          'X-Sync-Generated-At': generatedAt,
          'X-Sync-Courses': String(courseCount),
          'X-Sync-Files': String(fileCount),
          'Cache-Control': 'no-store'
        }
      });
    }

    // ---- /api/sync/push (iPad -> Desktop sync) ----
    if (pathname === '/api/sync/push' && method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as {
        checkpoints?: Record<string, any[]>;
        annotations?: Record<string, any[]>;
        documents?: Record<string, Array<{ filename: string; content: string | null; date: string }>>;
        prompts?: Array<{ id: string; content: string | null; date: string }>;
        assets?: Record<string, Array<{ filename: string; base64: string | null; date: string }>>;
      };

      if (!body || typeof body !== 'object') {
        return error(400, 'Invalid push payload');
      }

      const results: Record<string, { merged: number; errors: string[] }> = {};

      if (body.annotations && typeof body.annotations === 'object') {
        for (const [rawCourseId, ipadStrokes] of Object.entries(body.annotations)) {
          let courseId: string;
          try {
            courseId = assertCourseId(rawCourseId).toLowerCase();
          } catch {
            continue;
          }
          if (!Array.isArray(ipadStrokes)) continue;

          const entry = results[courseId] ?? { merged: 0, errors: [] };
          try {
            const { merged } = CourseService.mergeAnnotations(courseId, ipadStrokes as MarkupStroke[]);
            entry.merged += merged;
          } catch (e) {
            entry.errors.push(e instanceof Error ? e.message : String(e));
          }
          results[courseId] = entry;
        }
      }

      if (body.checkpoints && typeof body.checkpoints === 'object') {
        for (const [rawCourseId, ipadCheckpoints] of Object.entries(body.checkpoints)) {
          let courseId: string;
          try {
            courseId = assertCourseId(rawCourseId).toLowerCase();
          } catch {
            continue;
          }

          if (!Array.isArray(ipadCheckpoints)) continue;

          const errors: string[] = [];
          let merged = 0;
          try {
            const existing = CourseService.getCheckpoints(courseId);
            const existingById = new Map(existing.map((c) => [c.id, c]));

            for (const cp of ipadCheckpoints) {
              if (!cp?.id) continue;
              const desktopCp = existingById.get(cp.id);
              const incomingDate = new Date(cp.date || 0);
              if (cp.deleted) {
                // Tombstone: propagate a local delete when it is newer than the
                // desktop copy; otherwise the desktop keeps its version.
                if (desktopCp && incomingDate > new Date(desktopCp.date)) {
                  existingById.delete(cp.id);
                  merged++;
                }
                continue;
              }
              if (!cp.file || typeof cp.verticalPosition !== 'number') continue;
              if (!desktopCp || incomingDate > new Date(desktopCp.date)) {
                const { deleted: _deleted, ...clean } = cp;
                existingById.set(cp.id, { ...clean, courseId: undefined });
                merged++;
              }
            }

            CourseService.saveCheckpoints(courseId, Array.from(existingById.values()));
          } catch (e) {
            errors.push(e instanceof Error ? e.message : String(e));
          }
          results[courseId] = { merged, errors };
        }
      }

      // Locally-edited course documents (lesson tabs, course docs, manifests).
      // Last-writer-wins, guarded by mtime: an edit made on the desktop after
      // the pushed write is newer and wins; tombstones delete older files only.
      if (body.documents && typeof body.documents === 'object') {
        const isValidPushFilename = (filename: unknown): filename is string =>
          typeof filename === 'string' &&
          !filename.includes('/') &&
          !filename.includes('\\') &&
          !filename.startsWith('.') &&
          (filename === 'meta.json' || filename === 'manifest.json' || filename.endsWith('.md'));

        for (const [rawCourseId, docs] of Object.entries(body.documents)) {
          let courseId: string;
          try {
            courseId = assertCourseId(rawCourseId).toLowerCase();
          } catch {
            continue;
          }
          if (!Array.isArray(docs)) continue;

          const entry = results[courseId] ?? { merged: 0, errors: [] };
          for (const doc of docs) {
            if (!isValidPushFilename(doc?.filename) || typeof doc?.date !== 'string') {
              entry.errors.push(`invalid document entry: ${JSON.stringify(doc?.filename)}`);
              continue;
            }
            try {
              const filePath = safeJoin(getCoursesDir(), courseId, doc.filename);
              const incomingDate = new Date(doc.date);
              if (Number.isNaN(incomingDate.getTime())) {
                entry.errors.push(`invalid date for ${doc.filename}`);
                continue;
              }
              const fileTime = fs.existsSync(filePath) ? fs.statSync(filePath).mtime : null;

              if (doc.content === null) {
                if (fileTime && fileTime <= incomingDate) {
                  fs.rmSync(filePath, { force: true });
                  entry.merged++;
                }
              } else if (typeof doc.content === 'string') {
                if (!fileTime || fileTime <= incomingDate) {
                  fs.mkdirSync(path.dirname(filePath), { recursive: true });
                  fs.writeFileSync(filePath, doc.content, 'utf8');
                  entry.merged++;
                }
              } else {
                entry.errors.push(`invalid content for ${doc.filename}`);
              }
            } catch (e) {
              entry.errors.push(e instanceof Error ? e.message : String(e));
            }
          }
          results[courseId] = entry;
        }
      }

      // Locally-edited prompt templates (same mtime-guarded last-writer-wins).
      if (Array.isArray(body.prompts)) {
        const entry = results['prompts'] ?? { merged: 0, errors: [] };
        for (const p of body.prompts) {
          try {
            const safeId = assertPromptId(p?.id);
            const incomingDate = new Date(p?.date);
            if (Number.isNaN(incomingDate.getTime())) {
              entry.errors.push(`invalid date for prompt ${p?.id}`);
              continue;
            }
            const promptPath = safeJoin(getPromptsDir(), `${safeId}.md`);
            const fileTime = fs.existsSync(promptPath) ? fs.statSync(promptPath).mtime : null;

            if (p.content === null) {
              if (fileTime && fileTime <= incomingDate) {
                PromptService.deletePrompt(safeId);
                entry.merged++;
              }
            } else if (typeof p.content === 'string') {
              if (!fileTime || fileTime <= incomingDate) {
                PromptService.savePrompt(safeId, p.content);
                entry.merged++;
              }
            } else {
              entry.errors.push(`invalid content for prompt ${safeId}`);
            }
          } catch (e) {
            entry.errors.push(e instanceof Error ? e.message : String(e));
          }
        }
        if (entry.merged > 0 || entry.errors.length > 0) {
          results['prompts'] = entry;
        }
      }

      // Locally-uploaded locker docs / pasted images (base64 binaries), same
      // mtime-guarded last-writer-wins as markdown documents.
      if (body.assets && typeof body.assets === 'object') {
        for (const [rawCourseId, assets] of Object.entries(body.assets)) {
          let courseId: string;
          try {
            courseId = assertCourseId(rawCourseId).toLowerCase();
          } catch {
            continue;
          }
          if (!Array.isArray(assets)) continue;

          const entry = results[courseId] ?? { merged: 0, errors: [] };
          for (const asset of assets) {
            const filename = typeof asset?.filename === 'string' ? asset.filename : '';
            if (
              !filename ||
              filename.startsWith('.') ||
              filename.includes('/') ||
              filename.includes('\\') ||
              filename === 'manifest.json' ||
              typeof asset?.date !== 'string'
            ) {
              entry.errors.push(`invalid asset entry: ${JSON.stringify(asset?.filename)}`);
              continue;
            }
            try {
              const lockerDir = safeJoin(getCoursesDir(), courseId, 'assets', 'locker_docs');
              const filePath = safeJoin(lockerDir, filename);
              const incomingDate = new Date(asset.date);
              if (Number.isNaN(incomingDate.getTime())) {
                entry.errors.push(`invalid date for ${filename}`);
                continue;
              }
              const fileTime = fs.existsSync(filePath) ? fs.statSync(filePath).mtime : null;

              if (asset.base64 === null) {
                if (fileTime && fileTime <= incomingDate) {
                  fs.rmSync(filePath, { force: true });
                  entry.merged++;
                }
              } else if (typeof asset.base64 === 'string') {
                const buffer = Buffer.from(asset.base64, 'base64');
                if (buffer.length === 0) {
                  entry.errors.push(`empty payload for ${filename}`);
                  continue;
                }
                if (!fileTime || fileTime <= incomingDate) {
                  fs.mkdirSync(lockerDir, { recursive: true });
                  fs.writeFileSync(filePath, buffer);
                  entry.merged++;
                }
              } else {
                entry.errors.push(`invalid payload for ${filename}`);
              }
            } catch (e) {
              entry.errors.push(e instanceof Error ? e.message : String(e));
            }
          }
          results[courseId] = entry;
        }
      }

      return json({ success: true, results, pushedAt: new Date().toISOString() });
    }

    // ---- /api/sync ----
    if (pathname === '/api/sync/status') {
      if (method === 'GET') {
        const courseId = url.searchParams.get('courseId') || undefined;
        const status = await SyncService.getStatus(courseId);
        return json(status);
      }
    }

    if (pathname === '/api/sync/calendars') {
      if (method === 'GET') {
        const providerId = url.searchParams.get('provider') || 'google';
        const provider = SyncService.getProvider(providerId);
        if (!provider) return error(400, `Unknown provider: ${providerId}`);
        try {
          const calendars = await provider.listCalendars();
          return json({ calendars });
        } catch (e: any) {
          return error(500, e.message || 'Failed to list calendars');
        }
      }
    }

    if (pathname === '/api/sync/reconcile') {
      if (method === 'POST') {
        const body = (await req.json().catch(() => ({}))) as Record<string, any>;
        const { provider = 'google', courseId, calendarId = 'primary', defaultTime } = body;
        if (!courseId) return error(400, 'courseId is required for schedule reconciliation');
        try {
          const result = await SyncService.reconcile(provider, courseId, calendarId, { defaultTime });
          return json(result);
        } catch (e: any) {
          return error(500, e.message || 'Schedule reconciliation failed');
        }
      }
    }

    if (pathname === '/api/sync/credentials') {
      if (method === 'POST') {
        const body = (await req.json().catch(() => ({}))) as Record<string, any>;
        if (body.provider === 'arc') {
          ArcSyncProvider.saveCredentials(body);
        } else {
          GoogleCalendarProvider.saveCredentials(body);
        }
        return json({ success: true, message: 'Sync credentials saved' });
      }
    }

    if (pathname === '/api/sync/disconnect') {
      if (method === 'POST') {
        const body = (await req.json().catch(() => ({}))) as Record<string, any>;
        if (body.provider === 'arc') {
          ArcSyncProvider.clearCredentials();
        } else {
          GoogleCalendarProvider.clearCredentials();
        }
        return json({ success: true, message: 'Sync credentials cleared' });
      }
    }

    // ---- /api/sync/oauth/google/start ----
    if (pathname === '/api/sync/oauth/google/start' && method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as Record<string, any>;
      const clientId = typeof body.clientId === 'string' ? body.clientId.trim() : '';
      const existing = GoogleCalendarProvider.loadCredentials();
      const clientSecret =
        typeof body.clientSecret === 'string' && body.clientSecret.trim()
          ? body.clientSecret.trim()
          : existing.clientSecret;
      const redirectUri = typeof body.redirectUri === 'string' ? body.redirectUri.trim() : undefined;

      if (!clientId) {
        return error(400, 'Google Client ID is required to start authorization.');
      }

      // Save client credentials as draft
      GoogleCalendarProvider.saveCredentials({ clientId, clientSecret });

      try {
        const result = GoogleCalendarProvider.createOAuthSession({
          clientId,
          clientSecret,
          redirectUri
        });
        return json({ success: true, ...result });
      } catch (err: any) {
        return error(400, err.message || 'Failed to start Google OAuth flow');
      }
    }

    // ---- /api/sync/oauth/google/callback ----
    if (pathname === '/api/sync/oauth/google/callback') {
      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const errorParam = url.searchParams.get('error');

      if (errorParam) {
        return new Response(renderOAuthResultHtml(false, `Google authorization error: ${errorParam}`), {
          status: 400,
          headers: { 'Content-Type': 'text/html; charset=utf-8' }
        });
      }

      if (!code || !state) {
        return new Response(renderOAuthResultHtml(false, 'Missing authorization code or state parameter.'), {
          status: 400,
          headers: { 'Content-Type': 'text/html; charset=utf-8' }
        });
      }

      try {
        const result = await GoogleCalendarProvider.handleOAuthCallback(code, state);
        return new Response(renderOAuthResultHtml(true, undefined, result.accountEmail), {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8' }
        });
      } catch (err: any) {
        return new Response(renderOAuthResultHtml(false, err.message || 'Failed to complete Google OAuth exchange'), {
          status: 500,
          headers: { 'Content-Type': 'text/html; charset=utf-8' }
        });
      }
    }

    // ---- /api/queue ----
    if (pathname === '/api/queue') {
      if (method === 'GET') {
        const courseId = url.searchParams.get('courseId') || undefined;
        return json(queueManager.getStatus(courseId));
      }
      if (method === 'POST') {
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        const {
          action,
          courseId,
          lessonId,
          lessonTitle,
          prompt,
          customPrompt
        } = body;

        if (action === 'enqueue') {
          if (!courseId) {
            return error(400, 'courseId is required to enqueue tasks');
          }

          const singleTab = typeof body.tab === 'string' ? body.tab : undefined;
          const bulkTabs = Array.isArray(body.tabs) ? (body.tabs as unknown[]) : undefined;

          if (singleTab !== undefined) {
            // One tab for one lesson — any valid tab slug, custom tabs included.
            // The schedule is a queue-only pseudo-tab for the whole course.
            const normalizedTab =
              singleTab.toLowerCase() === 'cheatsheet' || singleTab.toLowerCase() === 'studysheet'
                ? 'notes'
                : singleTab;
            try {
              assertTab(normalizedTab);
            } catch {
              return error(400, `Invalid tab: ${JSON.stringify(singleTab)}`);
            }
            // 'lesson' is the ingested source document; regenerating it would
            // overwrite the course text, so only study-material tabs generate.
            if (normalizedTab === 'lesson') {
              return error(400, "Invalid tab: 'lesson' is the source lesson and cannot be generated");
            }
            if (!lessonId && normalizedTab !== 'schedule') {
              return error(400, 'lessonId is required to generate a lesson tab');
            }

            const items = [
              {
                courseId: String(courseId),
                lessonId: normalizedTab === 'schedule' ? 'schedule' : String(lessonId),
                lessonTitle:
                  normalizedTab === 'schedule' ? 'Course Schedule' : String(lessonTitle || lessonId),
                tab: normalizedTab,
                customPrompt: (customPrompt || prompt) as string | undefined,
                customContent: typeof body.customContent === 'string' ? body.customContent : undefined,
                contextAttachment: typeof body.contextAttachment === 'string' ? body.contextAttachment : undefined,
                preferences: body.preferences as SchedulePreferences | undefined,
                cardId: typeof body.cardId === 'string' && body.cardId.trim() ? body.cardId.trim() : undefined
              }
            ];
            const enqueued = queueManager.enqueue(items);
            return json({
              success: true,
              enqueued,
              // Tasks not added because an identical one is already
              // pending/processing — surfaced so the UI can say so honestly.
              skipped: items.length - enqueued.length,
              status: queueManager.getStatus(String(courseId))
            });
          }

          // Bulk: fixed lesson tabs only — either all tabs for one lesson
          // (lessonId given, e.g. after a chapter replace) or a scan across
          // the whole course for missing ones.
          const requested: unknown[] =
            bulkTabs && bulkTabs.length > 0 ? bulkTabs : [...DEFAULT_LESSON_TABS];
          const valid = requested.every(
            (t): t is string =>
              typeof t === 'string' && (BULK_SUPPORTED_TABS as readonly string[]).includes(t.toLowerCase())
          );
          if (!valid) {
            return error(
              400,
              "Invalid tabs. Bulk generation supports 'summary', 'notes', and 'test'"
            );
          }
          // Normalize legacy 'cheatsheet' / 'studysheet' to 'notes' and deduplicate
          const lessonTabs = Array.from(
            new Set(
              (requested as string[]).map((t) =>
                t.toLowerCase() === 'cheatsheet' || t.toLowerCase() === 'studysheet'
                  ? 'notes'
                  : (t.toLowerCase() as Tab)
              )
            )
          ) as Tab[];

          if (lessonId) {
            const items = lessonTabs.map((t) => ({
              courseId: String(courseId),
              lessonId: String(lessonId),
              lessonTitle: String(lessonTitle || lessonId),
              tab: t
            }));
            const enqueued = queueManager.enqueue(items);
            return json({
              success: true,
              enqueued,
              skipped: items.length - enqueued.length,
              status: queueManager.getStatus(String(courseId))
            });
          }

          const enqueued = queueManager.enqueueCourseMissing(
            String(courseId),
            lessonTabs
          );
          return json({
            success: true,
            enqueued,
            status: queueManager.getStatus(String(courseId))
          });
        }

        if (action === 'pause') {
          queueManager.pause();
          return json({ success: true, status: queueManager.getStatus(courseId as string | undefined) });
        }
        if (action === 'resume') {
          queueManager.resume();
          return json({ success: true, status: queueManager.getStatus(courseId as string | undefined) });
        }
        if (action === 'cancel') {
          queueManager.cancelAll(courseId as string | undefined);
          return json({ success: true, status: queueManager.getStatus(courseId as string | undefined) });
        }
        if (action === 'retry') {
          queueManager.retryFailed(courseId as string | undefined);
          return json({ success: true, status: queueManager.getStatus(courseId as string | undefined) });
        }
        return error(400, `Unknown action: ${action}`);
      }
    }

    // ---- /api/prompts ----
    if (pathname === '/api/prompts') {
      if (method === 'GET') {
        return json({ prompts: PromptService.listPrompts() });
      }
      if (method === 'POST') {
        const body = (await req.json()) as Record<string, unknown>;
        const { id, content } = body;
        if (!id || typeof content !== 'string') {
          return error(400, 'Invalid request: id and content required');
        }
        try {
          assertPromptId(String(id));
          const success = PromptService.savePrompt(String(id), content);
          if (!success) return error(500, 'Failed to save prompt');
        } catch (err) {
          if (err instanceof PathValidationError) {
            return error(400, err.message);
          }
          throw err;
        }
        return json({ success: true });
      }
      if (method === 'DELETE') {
        const urlId = url.searchParams.get('id');
        let id = urlId;
        if (!id) {
          try {
            const body = (await req.json()) as Record<string, unknown>;
            id = body.id ? String(body.id) : null;
          } catch {}
        }
        if (!id) {
          return error(400, 'Invalid request: id required');
        }
        try {
          const safeId = assertPromptId(String(id));
          const STANDARD_BUILTINS = [
            'course_summary',
            'course_notes',
            'course_studysheet',
            'course_schedule',
            'course_test',
            'summary',
            'notes',
            'studysheet',
            'test',
            'test_kica',
            'lesson',
            'popquiz'
          ];
          if (STANDARD_BUILTINS.includes(safeId.toLowerCase())) {
            return error(403, 'Standard prompt templates cannot be deleted');
          }
          const success = PromptService.deletePrompt(safeId);
          if (!success) return error(404, 'Prompt not found or could not be deleted');
        } catch (err) {
          if (err instanceof PathValidationError) {
            return error(400, err.message);
          }
          throw err;
        }
        return json({ success: true });
      }
    }

    // ---- /api/parse (multipart upload + JSON re-parse) ----
    if (pathname === '/api/parse') {
      const contentType = req.headers.get('content-type') || '';

      if (contentType.includes('multipart/form-data')) {
        const formData = await req.formData();
        const rawCourseId = ((formData.get('courseId') as string) || '').trim().toLowerCase();
        if (!rawCourseId) {
          return error(400, 'Course code is required (e.g. "mcr3u", "clu3m").');
        }
        let courseId: string;
        try {
          courseId = assertCourseId(rawCourseId).toLowerCase();
        } catch {
          return error(400, `Invalid courseId: "${rawCourseId}". Must start with a letter or digit and contain only letters, numbers, dots, hyphens, or underscores.`);
        }

        const files = formData.getAll('files') as File[];
        const mode = (formData.get('mode') as string) || 'add';
        const targetLessonId = ((formData.get('targetLessonId') as string) || '').trim();
        if (targetLessonId) {
          try {
            assertLessonId(targetLessonId);
          } catch {
            return error(400, `Invalid targetLessonId: "${targetLessonId}"`);
          }
        }
        const overwriteExisting = formData.get('overwriteExisting') === 'true';

        if (!files.length) {
          return error(400, 'No files provided');
        }

        const courseDir = safeJoin(getCoursesDir(), courseId);
        const backupDir = safeJoin(courseDir, '_backup');
        fs.mkdirSync(backupDir, { recursive: true });

        const uploadedFilenames: string[] = [];
        for (const file of files) {
          const safeFilename = path.basename(file.name);
          if (/\.(zip|mhtml|mht|html|htm)$/i.test(safeFilename)) {
            const buffer = Buffer.from(await file.arrayBuffer());
            fs.writeFileSync(safeJoin(backupDir, safeFilename), buffer);
            uploadedFilenames.push(safeFilename);
          }
        }

        const ingester = new CourseIngest();
        const manifest = await ingester.ingestCourse(courseDir, {
          overwriteExisting: overwriteExisting || (mode === 'replace' && !targetLessonId),
          overwriteLessonIds: targetLessonId ? [targetLessonId] : undefined,
          overwriteFiles: mode === 'replace' ? uploadedFilenames : undefined
        });
        return json({ success: true, manifest });
      }

      // JSON re-parse of existing courses
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      const courseId = body.courseId as string | undefined;
      const overwriteExisting = Boolean(body.overwriteExisting);
      const lessonId = body.lessonId ? String(body.lessonId).trim() : undefined;

      const coursesDir = getCoursesDir();
      const ingester = new CourseIngest();

      if (courseId) {
        let safeCourseId: string;
        try {
          safeCourseId = assertCourseId(courseId).toLowerCase();
          if (lessonId) assertLessonId(lessonId);
        } catch {
          return error(400, `Invalid courseId or lessonId: "${courseId}"`);
        }

        const coursePath = safeJoin(coursesDir, safeCourseId);
        if (!fs.existsSync(coursePath)) {
          return error(404, `Course ${courseId} not found`);
        }
        const manifest = await ingester.ingestCourse(coursePath, {
          overwriteExisting,
          overwriteLessonIds: lessonId ? [lessonId] : undefined
        });
        return json({ success: true, manifest });
      } else {
        const dirs = fs
          .readdirSync(coursesDir, { withFileTypes: true })
          .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
          .map((d) => d.name);

        const manifests: unknown[] = [];
        for (const d of dirs) {
          try {
            const m = await ingester.ingestCourse(path.join(coursesDir, d));
            manifests.push(m);
          } catch (e) {
            console.error(`Failed to ingest ${d}:`, e);
          }
        }
        return json({ success: true, manifests });
      }
    }

    // ---- /api/maintenance/compress-images ----
    if (pathname === '/api/maintenance/compress-images' && method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      const coursesDir = getCoursesDir();

      let courseIds: string[];
      if (body?.courseId) {
        let courseId: string;
        try {
          courseId = assertCourseId(String(body.courseId)).toLowerCase();
        } catch {
          return error(400, `Invalid courseId: "${body.courseId}"`);
        }
        const coursePath = safeJoin(coursesDir, courseId);
        if (!fs.existsSync(coursePath)) {
          return error(404, `Course ${courseId} not found`);
        }
        courseIds = [courseId];
      } else {
        courseIds = fs
          .readdirSync(coursesDir, { withFileTypes: true })
          .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
          .map((d) => d.name);
      }

      const results: Array<Record<string, unknown>> = [];
      for (const courseId of courseIds) {
        try {
          const summary = await optimizeCourseImages(path.join(coursesDir, courseId));
          results.push({ courseId, ...summary });
        } catch (e) {
          console.error(`[compress-images] Failed for ${courseId}:`, e);
          results.push({ courseId, error: e instanceof Error ? e.message : String(e) });
        }
      }

      const totals = results.reduce<{ converted: number; bytesBefore: number; bytesAfter: number }>(
        (acc, r) => ({
          converted: acc.converted + (Number(r.converted) || 0),
          bytesBefore: acc.bytesBefore + (Number(r.bytesBefore) || 0),
          bytesAfter: acc.bytesAfter + (Number(r.bytesAfter) || 0)
        }),
        { converted: 0, bytesBefore: 0, bytesAfter: 0 }
      );
      return json({ success: true, results, totals });
    }

    // ---- /api/maintenance/reparse-prompts ----
    if (pathname === '/api/maintenance/reparse-prompts' && method === 'POST') {
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      const rawCategories = Array.isArray(body.categories) ? body.categories.map(String) : [];

      const VALID_CATEGORIES = [
        'lesson_summaries',
        'lesson_notes',
        'lesson_studysheets',
        'unit_assignments',
        'unit_tests',
        'course_summaries',
        'course_notes',
        'course_studysheets',
        'course_tests'
      ] as const;

      function normalizeCategory(cat: string): string {
        const c = String(cat).toLowerCase().trim();
        if (
          c === 'lesson_notes' ||
          c === 'lesson_note' ||
          c === 'notes' ||
          c === 'note' ||
          c === 'lesson_cheatsheets' ||
          c === 'lesson_cheatsheet' ||
          c === 'lesson_studysheet' ||
          c === 'lesson_studysheets' ||
          c === 'studysheets' ||
          c === 'studysheet' ||
          c === 'cheatsheet' ||
          c === 'cheatsheets'
        ) {
          return 'lesson_notes';
        }
        if (
          c === 'course_notes' ||
          c === 'course_note' ||
          c === 'course_cheatsheets' ||
          c === 'course_cheatsheet' ||
          c === 'course_studysheet' ||
          c === 'course_studysheets'
        ) {
          return 'course_notes';
        }
        if (c === 'lesson_summary' || c === 'summary' || c === 'summaries' || c === 'lesson_summaries') {
          return 'lesson_summaries';
        }
        if (c === 'course_summary' || c === 'course_summaries') {
          return 'course_summaries';
        }
        if (c === 'unit_assignment' || c === 'unit_assignments' || c === 'assignments') {
          return 'unit_assignments';
        }
        if (c === 'unit_test' || c === 'unit_tests') {
          return 'unit_tests';
        }
        if (c === 'course_test' || c === 'course_tests') {
          return 'course_tests';
        }
        return c;
      }

      const selectedCategories = Array.from(
        new Set(
          rawCategories
            .map(normalizeCategory)
            .filter((c): c is (typeof VALID_CATEGORIES)[number] =>
              (VALID_CATEGORIES as readonly string[]).includes(c)
            )
        )
      );

      if (selectedCategories.length === 0) {
        return error(400, 'At least one category must be selected for reparse.');
      }

      let courseIds: string[] = [];
      if (body.courseId && body.courseId !== 'all') {
        let courseId: string;
        try {
          courseId = assertCourseId(String(body.courseId)).toLowerCase();
        } catch {
          return error(400, `Invalid courseId: "${body.courseId}"`);
        }
        const course = CourseService.getCourse(courseId);
        if (!course) {
          return error(404, `Course ${courseId} not found`);
        }
        courseIds = [courseId];
      } else {
        const manifests = CourseService.listCourses();
        courseIds = manifests.map((m) => m.id.toLowerCase());
      }

      const tasksToEnqueue: Array<{
        courseId: string;
        lessonId: string;
        lessonTitle: string;
        tab: string;
        contextAttachment?: string;
      }> = [];

      for (const courseId of courseIds) {
        const course = CourseService.getCourse(courseId);
        if (!course) continue;

        // 1. Lesson Summaries
        if (selectedCategories.includes('lesson_summaries')) {
          for (const unit of course.units) {
            for (const lesson of unit.lessons) {
              tasksToEnqueue.push({
                courseId,
                lessonId: lesson.id,
                lessonTitle: lesson.title,
                tab: 'summary',
                contextAttachment: 'lesson - lessons'
              });
            }
          }
        }

        // 2. Lesson Notes
        if (selectedCategories.includes('lesson_notes') || selectedCategories.includes('lesson_studysheets')) {
          for (const unit of course.units) {
            for (const lesson of unit.lessons) {
              tasksToEnqueue.push({
                courseId,
                lessonId: lesson.id,
                lessonTitle: lesson.title,
                tab: 'notes',
                contextAttachment: 'lesson - lessons'
              });
            }
          }
        }

        // 3. Unit Assignments
        if (selectedCategories.includes('unit_assignments')) {
          for (const unit of course.units) {
            tasksToEnqueue.push({
              courseId,
              lessonId: formatUnitScopeId(unit.number),
              lessonTitle: `${unit.title} Assignments`,
              tab: 'assignments',
              contextAttachment: 'unit - lessons'
            });
          }
        }

        // 4. Unit Tests
        if (selectedCategories.includes('unit_tests')) {
          for (const unit of course.units) {
            tasksToEnqueue.push({
              courseId,
              lessonId: formatUnitScopeId(unit.number),
              lessonTitle: `${unit.title} Unit Test`,
              tab: 'test',
              contextAttachment: 'unit - lessons'
            });
          }
        }

        // 5. Course Summaries
        if (selectedCategories.includes('course_summaries')) {
          tasksToEnqueue.push({
            courseId,
            lessonId: 'course',
            lessonTitle: `${course.title} Summary`,
            tab: 'summary',
            contextAttachment: 'course - summaries'
          });
        }

        // 6. Course Notes
        if (selectedCategories.includes('course_notes') || selectedCategories.includes('course_studysheets')) {
          tasksToEnqueue.push({
            courseId,
            lessonId: 'course',
            lessonTitle: `${course.title} Notes`,
            tab: 'notes',
            contextAttachment: 'course - notes'
          });
        }

        // 7. Course Tests
        if (selectedCategories.includes('course_tests')) {
          tasksToEnqueue.push({
            courseId,
            lessonId: 'course',
            lessonTitle: `${course.title} Course Test`,
            tab: 'test',
            contextAttachment: 'course - lessons'
          });
        }
      }

      const enqueued = queueManager.enqueue(tasksToEnqueue);
      return json({
        success: true,
        enqueuedCount: enqueued.length,
        totalRequested: tasksToEnqueue.length,
        coursesCount: courseIds.length,
        categories: selectedCategories
      });
    }

    // ---- /api/settings/theme ----
    if (pathname === '/api/settings/theme') {
      if (method === 'GET') {
        const settings = loadAppSettings();
        return json({ success: true, theme: settings.theme || 'system' });
      }
      if (method === 'POST') {
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        const theme = body.theme as string | undefined;
        if (!theme || !['light', 'dark', 'system'].includes(theme)) {
          return error(400, 'Invalid theme. Expected "light", "dark", or "system".');
        }
        try {
          saveAppSettings({ theme });
          return json({ success: true, theme, message: `Theme saved as ${theme}` });
        } catch (err) {
          return error(500, err instanceof Error ? err.message : 'Failed to save theme setting');
        }
      }
    }

    // ---- /api/settings/storage ----
    if (pathname === '/api/settings/storage') {
      if (method === 'GET') {
        return json(getDataStorageInfo());
      }
      if (method === 'POST') {
        try {
          const body = (await req.json()) as Record<string, unknown>;
          const { dataDir, migrate } = body;
          const result = setCustomDataDir(String(dataDir || ''), Boolean(migrate));
          const storageInfo = getDataStorageInfo();
          return json({ success: true, ...storageInfo, migratedFiles: result.migratedFiles });
        } catch (err) {
          return error(400, err instanceof Error ? err.message : 'Failed to update data directory');
        }
      }
    }

    // ---- /api/settings/open-folder ----
    if (pathname === '/api/settings/open-folder' && method === 'POST') {
      const dataDir = getDataDir();
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }
      execFile(os.platform() === 'darwin' ? 'open' : os.platform() === 'win32' ? 'explorer' : 'xdg-open', [dataDir], (err) => {
        if (err) console.error(`Failed to open data directory '${dataDir}':`, err);
      });
      return json({ success: true, message: `Opened ${dataDir}`, path: dataDir });
    }

    // ---- /api/settings/mcp ----
    if (pathname === '/api/settings/mcp') {
      const mcpInfo = getMcpServerInfo();
      if (method === 'GET') {
        const settings = loadAppSettings();
        return json({
          enabled: settings.mcp_enabled ?? true,
          port: 3182,
          url: 'http://127.0.0.1:3182/mcp',
          token: getOrCreateMcpToken(),
          serverPath: mcpInfo.serverPath,
          command: mcpInfo.command,
          args: mcpInfo.args
        });
      }
      if (method === 'POST') {
        const body = (await req.json().catch(() => ({}))) as Record<string, any>;
        if (body.action === 'rotate_token') {
          const token = rotateMcpToken();
          return json({
            success: true,
            token,
            serverPath: mcpInfo.serverPath,
            command: mcpInfo.command,
            args: mcpInfo.args
          });
        }
        const enabled = Boolean(body.enabled);
        saveAppSettings({ mcp_enabled: enabled });
        return json({
          success: true,
          enabled,
          token: getOrCreateMcpToken(),
          serverPath: mcpInfo.serverPath,
          command: mcpInfo.command,
          args: mcpInfo.args
        });
      }
    }

    // ---- /api/settings/emailserver ----
    if (pathname === '/api/settings/emailserver') {
      if (method === 'GET') {
        return json(TeacherCheckinService.getSafeConfig());
      }
      if (method === 'POST') {
        const body = (await req.json().catch(() => ({}))) as Record<string, any>;
        const email = typeof body.email === 'string' ? body.email.trim() : '';
        const sender = body.sender === 'outlook' ? 'outlook' : 'gmail';
        const loginEmail = typeof body.loginEmail === 'string' ? body.loginEmail.trim() : '';
        const loginPassword = typeof body.loginPassword === 'string' ? body.loginPassword : '';

        // If loginPassword wasn't passed or is empty, retain existing password
        const existing = TeacherCheckinService.getConfig();
        const effectivePassword = loginPassword || existing?.loginPassword || '';

        TeacherCheckinService.saveConfig({
          email,
          sender,
          loginEmail,
          loginPassword: effectivePassword
        });

        return json({ success: true, message: 'Teacher Check-In settings saved', ...TeacherCheckinService.getSafeConfig() });
      }
    }

    // ---- /api/settings/emailserver/test ----
    if (pathname === '/api/settings/emailserver/test' && method === 'POST') {
      try {
        const body = (await req.json().catch(() => ({}))) as Record<string, any>;
        const existing = TeacherCheckinService.getConfig();
        const cfg = {
          email: typeof body.email === 'string' && body.email.trim() ? body.email.trim() : existing?.email || '',
          sender: body.sender === 'outlook' ? 'outlook' : (body.sender === 'gmail' ? 'gmail' : existing?.sender || 'gmail'),
          loginEmail: typeof body.loginEmail === 'string' && body.loginEmail.trim() ? body.loginEmail.trim() : existing?.loginEmail || '',
          loginPassword: typeof body.loginPassword === 'string' && body.loginPassword ? body.loginPassword : existing?.loginPassword || ''
        };
        const result = await TeacherCheckinService.sendTestEmail(cfg as any);
        return json(result);
      } catch (err: any) {
        console.error('[Teacher Check-In Test Email Error]', err);
        return error(500, err?.message || 'Failed to send test email');
      }
    }

    // ---- /api/pop-quiz/generate ----
    if (pathname === '/api/pop-quiz/generate' && method === 'POST') {
      try {
        const body = (await req.json().catch(() => ({}))) as Record<string, any>;
        const rawCourseId = String(body.courseId || '').trim();
        const rawLessonId = String(body.lessonId || '').trim();
        const rawTimestamp = String(body.timestamp || '').trim();
        const forceRegenerate = Boolean(body.forceRegenerate);

        if (!rawCourseId || !rawLessonId) {
          return error(400, 'courseId and lessonId are required to generate a pop quiz');
        }

        const courseId = assertCourseId(rawCourseId).toLowerCase();
        const lessonId = assertLessonId(rawLessonId);
        const coursesDir = getCoursesDir();
        const courseDir = safeJoin(coursesDir, courseId);
        if (!fs.existsSync(courseDir)) {
          return error(404, `Course ${courseId} not found`);
        }

        // Sanitized timestamp for disk storage (alphanumerics, dash, underscore)
        const safeTimestamp = (rawTimestamp || new Date().toISOString().replace(/[:.]/g, '-')).replace(/[^a-zA-Z0-9_-]/g, '_');
        const quizFileName = `${lessonId}.popquiz.${safeTimestamp}.md`;
        const quizFilePath = safeJoin(courseDir, quizFileName);

        // Check if already generated on disk
        if (!forceRegenerate && fs.existsSync(quizFilePath)) {
          const cached = fs.readFileSync(quizFilePath, 'utf8');
          if (cached && cached.trim().length > 50) {
            return json({ success: true, cached: true, markdown: cached, timestamp: safeTimestamp });
          }
        }

        // Read lesson text
        const bundle = CourseService.getLessonContent(courseId, lessonId);
        if (!bundle || !bundle.lesson || bundle.lesson.trim().length < 50) {
          return error(400, `Lesson ${lessonId} content is empty or unavailable.`);
        }

        // Load prompt
        let promptItem = PromptService.getPrompt('popquiz');
        let systemPrompt = promptItem?.content || '';
        if (!systemPrompt || systemPrompt.trim().length === 0) {
          return error(500, 'PopQuiz prompt template is missing. Please ensure popquiz.md is configured in Prompts.');
        }

        // Active LLM config
        const config = LLMService.loadStoredConfig();
        if (!config || !config.baseUrl) {
          return error(400, 'No active AI model configured. Please add and save a model in Settings → AI Models.');
        }

        const timeoutMs = LLMService.resolveRequestTimeoutMs(config);
        console.log(`[PopQuiz AI] Generating pop quiz for ${courseId.toUpperCase()} ${lessonId} using ${config.model || 'default'}`);

        const result = await LLMService.generateResult(
          config,
          systemPrompt,
          stripLessonMedia(bundle.lesson),
          { timeoutMs }
        );

        const repaired = repairMarkdownTables(result.completion.trim());
        const parsed = parseFrontmatter(repaired);
        const content = serializeWithFrontmatter(
          {
            ...parsed.frontmatter,
            type: 'popquiz',
            course: courseId.toUpperCase(),
            lesson: lessonId,
            timestamp: safeTimestamp,
            createdAt: new Date().toISOString()
          },
          parsed.body.trim()
        );

        fs.writeFileSync(quizFilePath, content, 'utf8');

        CourseService.recordLog({
          courseId,
          lessonDoc: `${lessonId}.popquiz.md`,
          chars: result.completion.length,
          tokens: result.usage?.total_tokens ?? 0
        });

        const tokensUsed = result.usage?.total_tokens;
        const tokenBreakdown = result.usage?.prompt_tokens !== undefined
          ? ` (prompt: ${result.usage.prompt_tokens.toLocaleString()}, completion: ${result.usage.completion_tokens?.toLocaleString() ?? '?'})`
          : '';
        const tokensInfo = tokensUsed !== undefined
          ? ` | Total tokens used: ${tokensUsed.toLocaleString()}${tokenBreakdown}`
          : '';
        console.log(`[PopQuiz AI] Saved ${quizFileName} (${content.length} chars)${tokensInfo}`);

        return json({
          success: true,
          cached: false,
          markdown: content,
          timestamp: safeTimestamp,
          usage: result.usage
        });
      } catch (err: any) {
        console.error('[PopQuiz Generation Error]', err);
        return error(500, err?.message || 'Failed to generate pop quiz');
      }
    }

    // ---- /api/pop-quiz/submit ----
    if (pathname === '/api/pop-quiz/submit' && method === 'POST') {
      try {
        const body = (await req.json().catch(() => ({}))) as Record<string, any>;
        const rawCourseId = String(body.courseId || '').trim();
        const rawLessonId = String(body.lessonId || '').trim();
        const rawLessonTitle = typeof body.lessonTitle === 'string' ? body.lessonTitle : '';
        const timestamp = String(body.timestamp || new Date().toISOString());
        const testMarkdown = String(body.testMarkdown || '');
        const answers = (body.answers && typeof body.answers === 'object') ? body.answers as Record<string, string> : {};
        const timeSpentSeconds = typeof body.timeSpentSeconds === 'number' ? body.timeSpentSeconds : undefined;
        const timedOut = Boolean(body.timedOut);

        if (!rawCourseId || !rawLessonId || !testMarkdown) {
          return error(400, 'courseId, lessonId, and testMarkdown are required');
        }

        const courseId = assertCourseId(rawCourseId).toLowerCase();
        const lessonId = assertLessonId(rawLessonId);

        // Sanitize lesson title and remove any image references
        let lessonTitle = cleanImageReferences(rawLessonTitle);

        // Parse quiz using QuestionParser
        const parsedQuiz = QuestionParser.parseMarkdown(testMarkdown);

        if (!lessonTitle && parsedQuiz.title) {
          lessonTitle = cleanImageReferences(parsedQuiz.title);
        }

        if (!lessonTitle) {
          try {
            const courseData = CourseService.getCourse(courseId);
            const manifestLesson = courseData?.units
              ?.flatMap((u) => u.lessons || [])
              ?.find((l) => l.id.toLowerCase() === lessonId.toLowerCase());
            if (manifestLesson?.title) {
              lessonTitle = cleanImageReferences(manifestLesson.title);
            }
          } catch {
            // ignore
          }
        }

        let score = 0;

        const evaluatedQuestions: PopQuizQuestionResult[] = parsedQuiz.questions.map((q) => {
          const studentAns = (answers[q.number] || answers[String(parseInt(q.number, 10))] || '').trim();
          const correctAns = (q.correctAnswer || '').trim();
          let isCorrect = false;

          if (q.type === 'fill-in-the-blank') {
            // Normalized comparison: lowercase, remove non-alphanumeric except space, collapse whitespace
            const cleanStudent = studentAns.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
            const cleanCorrect = correctAns.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
            isCorrect = cleanStudent.length > 0 && (cleanStudent === cleanCorrect || cleanCorrect.includes(cleanStudent) || cleanStudent.includes(cleanCorrect));
          } else {
            isCorrect = studentAns.length > 0 && studentAns.toUpperCase() === correctAns.toUpperCase();
          }

          if (isCorrect) score++;

          return {
            number: q.number,
            category: q.category,
            type: q.type || (q.options && q.options.length > 0 ? 'multiple-choice' : 'fill-in-the-blank'),
            prompt: q.prompt,
            options: q.options,
            studentAnswer: studentAns,
            correctAnswer: correctAns,
            isCorrect,
            explanation: q.explanation
          };
        });

        const total = evaluatedQuestions.length;
        const percentage = total > 0 ? Math.round((score / total) * 100) : 0;

        // Dispatch email via TeacherCheckinService
        let emailSent = false;
        let emailError: string | undefined;

        try {
          await TeacherCheckinService.sendQuizResultEmail({
            courseId,
            lessonId,
            lessonTitle: lessonTitle || parsedQuiz.title,
            timestamp,
            timeSpentSeconds,
            timedOut,
            questions: evaluatedQuestions,
            score,
            total,
            percentage
          });
          emailSent = true;
        } catch (err: any) {
          console.warn('[PopQuiz Email Dispatch Notice]', err?.message || err);
          emailError = err?.message || 'Failed to dispatch email';
        }

        return json({
          success: true,
          score,
          total,
          percentage,
          questions: evaluatedQuestions,
          emailSent,
          emailError,
          supervisorSent: emailSent,
          supervisorMessage: 'Updated course supervisor, thank you!'
        });
      } catch (err: any) {
        console.error('[PopQuiz Submission Error]', err);
        return error(500, err?.message || 'Failed to submit pop quiz');
      }
    }

    // ---- /api/backup/export | /api/backup/import ----
    if (pathname === '/api/backup/export' && method === 'GET') {
      try {
        const includeRaw = url.searchParams.get('includeRaw') === 'true';
        const { stream, filename, fileCount, courseCount } = createDataBackupZipStream({
          includeRawArchives: includeRaw
        });

        return new Response(stream, {
          headers: {
            'Content-Type': 'application/zip',
            'Content-Disposition': `attachment; filename="${filename}"`,
            'Cache-Control': 'no-cache',
            'X-File-Count': String(fileCount),
            'X-Course-Count': String(courseCount)
          }
        });
      } catch (err) {
        console.error('[Backup Export Error]', err);
        return error(500, err instanceof Error ? err.message : 'Failed to generate backup archive');
      }
    }

    if (pathname === '/api/backup/import' && method === 'POST') {
      try {
        const formData = await req.formData();
        const file = formData.get('file') as File | null;
        if (!file) {
          return error(400, 'A .zip backup file is required');
        }
        if (!file.name.toLowerCase().endsWith('.zip')) {
          return error(400, 'Invalid file format. Please upload a .zip file.');
        }
        const arrayBuffer = await file.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        const result = restoreDataBackupZip(buffer);
        return json({
          message: `Successfully restored ${result.coursesRestored} courses and ${result.filesRestored} files.`,
          ...result
        });
      } catch (err) {
        if (err instanceof Response) return err;
        console.error('[Backup Import Error]', err);
        return error(500, err instanceof Error ? err.message : 'Failed to restore backup archive');
      }
    }

    // ---- /api/courses ----
    if (pathname === '/api/courses' && method === 'GET') {
      return json({ courses: CourseService.listCourses() });
    }

    // POST /api/courses - create course with optional units/lessons and auto-queue
    if (pathname === '/api/courses' && method === 'POST') {
      const body = ((await req.json().catch(() => ({}))) || {}) as Record<string, unknown>;
      const rawCourseId = typeof body.id === 'string' ? body.id.trim().toLowerCase() : '';
      if (!rawCourseId) {
        return error(400, 'Course ID is required.');
      }
      let courseId: string;
      try {
        courseId = assertCourseId(rawCourseId).toLowerCase();
      } catch {
        return error(400, `Invalid course ID: "${rawCourseId}". Must start with a letter or digit and contain only letters, numbers, dots, hyphens, or underscores.`);
      }

      const title = typeof body.title === 'string' ? body.title.trim() : '';
      if (!title) {
        return error(400, 'Course title is required.');
      }

      const grade = typeof body.grade === 'string' ? body.grade.trim() : '11';
      const level = typeof body.level === 'string' ? body.level.trim() : 'University';
      const description = typeof body.description === 'string' ? body.description.trim() : '';

      try {
        CourseManagerService.createCourse({
          id: courseId,
          title,
          grade,
          level,
          description,
          coursePDF: Boolean(body.coursePDF)
        });

        // If units or lessons are provided, inject them
        const lessonsToInject: Array<{
          id: string;
          title: string;
          unitNumber?: number;
          unitTitle?: string;
          lessonNumber?: number;
          type?: 'lesson' | 'assignment';
          content?: string;
          pageRange?: string;
          readingDescription?: string;
        }> = [];

        if (Array.isArray(body.units)) {
          for (const unit of body.units) {
            const uNum = Number(unit.number) || 1;
            const uTitle = unit.title || `Unit ${uNum}`;
            if (Array.isArray(unit.lessons)) {
              for (let idx = 0; idx < unit.lessons.length; idx++) {
                const l = unit.lessons[idx];
                const lNum = idx + 1;
                const lId = l.id || `${String(uNum).padStart(2, '0')}.${String(lNum).padStart(2, '0')}`;
                lessonsToInject.push({
                  id: lId,
                  title: l.title || `Lesson ${lNum}`,
                  unitNumber: uNum,
                  unitTitle: uTitle,
                  lessonNumber: lNum,
                  type: l.type === 'assignment' ? 'assignment' : 'lesson',
                  content: l.content || `# ${l.title || `Lesson ${lNum}`}\n\n### Overview\nLesson content.`,
                  pageRange: typeof l.pageRange === 'string' ? l.pageRange.trim() : undefined,
                  readingDescription: typeof l.readingDescription === 'string' ? l.readingDescription.trim() : undefined
                });
              }
            }
          }
        } else if (Array.isArray(body.lessons)) {
          for (const l of body.lessons) {
            lessonsToInject.push({
              id: l.id,
              title: l.title,
              unitNumber: l.unitNumber,
              unitTitle: l.unitTitle,
              lessonNumber: l.lessonNumber,
              type: l.type === 'assignment' ? 'assignment' : 'lesson',
              content: l.content,
              pageRange: typeof l.pageRange === 'string' ? l.pageRange.trim() : undefined,
              readingDescription: typeof l.readingDescription === 'string' ? l.readingDescription.trim() : undefined
            });
          }
        }

        if (lessonsToInject.length > 0) {
          CourseManagerService.injectLessons(courseId, lessonsToInject);
        }

        if (body.queueStudyMaterials) {
          try {
            queueManager.enqueueCourseMissing(courseId, ['summary', 'notes', 'test']);
          } catch (qErr) {
            console.warn(`Failed to auto-enqueue study materials for course ${courseId}:`, qErr);
          }
        }

        const freshCourse = CourseManagerService.getCourse(courseId);
        return json({ success: true, courseId, course: freshCourse }, 201);
      } catch (err: any) {
        if (err instanceof ConflictError || err?.name === 'ConflictError') {
          return error(409, err.message || `Course '${courseId}' already exists.`);
        }
        if (err instanceof ValidationError || err?.name === 'ValidationError') {
          return error(400, err.message || 'Validation error.');
        }
        return error(500, err?.message || 'Failed to create course.');
      }
    }

    // ---- /api/builder/prompt ----
    if (pathname === '/api/builder/prompt' && method === 'GET') {
      const promptItem = PromptService.getPrompt('course_builder');
      return json({
        success: true,
        prompt: promptItem?.content || FALLBACK_COURSE_BUILDER_PROMPT
      });
    }

    // ---- /api/builder/propose ----
    if (pathname === '/api/builder/propose' && method === 'POST') {
      const contentType = req.headers.get('content-type') || '';
      let extractedText = '';
      let filename = 'document';
      let instructions = '';
      let customPrompt = '';
      let targetUnits = 0;

      if (contentType.includes('multipart/form-data')) {
        const formData = await req.formData();
        const file = formData.get('file') as File | null;
        instructions = ((formData.get('instructions') as string) || '').trim();
        customPrompt = ((formData.get('customPrompt') as string) || '').trim();
        targetUnits = parseInt((formData.get('targetUnits') as string) || '0', 10);

        if (!file) {
          return error(400, 'No file uploaded.');
        }
        filename = file.name;
        const ext = path.extname(filename).toLowerCase();
        const buffer = Buffer.from(await file.arrayBuffer());

        if (ext === '.pdf') {
          try {
            extractedText = await extractTextFromPdf(buffer);
          } catch (pdfErr: any) {
            return error(400, `Failed to parse PDF: ${pdfErr?.message || String(pdfErr)}`);
          }
        } else if (ext === '.html' || ext === '.htm') {
          try {
            const cheerio = await import('cheerio');
            const html = buffer.toString('utf8');
            const $ = cheerio.load(html);
            $('script, style, nav, footer, noscript').remove();
            extractedText = $('body').text().trim() || $.text().trim();
          } catch (htmlErr: any) {
            return error(400, `Failed to parse HTML: ${htmlErr?.message || String(htmlErr)}`);
          }
        } else {
          extractedText = buffer.toString('utf8').trim();
        }
      } else {
        const body = ((await req.json().catch(() => ({}))) || {}) as Record<string, unknown>;
        extractedText = typeof body.text === 'string' ? body.text.trim() : '';
        filename = typeof body.filename === 'string' ? body.filename : 'outline.txt';
        instructions = typeof body.instructions === 'string' ? body.instructions.trim() : '';
        customPrompt = typeof body.customPrompt === 'string' ? body.customPrompt.trim() : '';
        targetUnits = typeof body.targetUnits === 'number' ? body.targetUnits : 0;
      }

      if (!extractedText) {
        return error(400, 'No readable text content found in the provided document or text is empty.');
      }

      // Safe truncate to avoid exceeding model context
      if (extractedText.length > 60000) {
        extractedText = extractedText.slice(0, 60000) + '\n\n...[content truncated for curriculum planning]...';
      }

      const promptItem = PromptService.getPrompt('course_builder');
      const systemPrompt = customPrompt || promptItem?.content || FALLBACK_COURSE_BUILDER_PROMPT;

      let userPrompt = `Document: ${filename}\n\n=== Content ===\n${extractedText}`;
      if (instructions) {
        userPrompt += `\n\n=== Additional Instructions ===\n${instructions}`;
      }
      if (targetUnits > 0) {
        userPrompt += `\n\nTarget number of units: exactly ${targetUnits} units.`;
      }

      const config = LLMService.loadStoredConfig();
      if (!config || !config.baseUrl) {
        return error(400, 'No active AI model configured. Please configure an AI model in Settings → AI Models.');
      }

      try {
        const result = await LLMService.generateResult(config, systemPrompt, userPrompt, { timeoutMs: 120_000 });
        const rawProposal = extractJsonProposal(result.completion);
        const proposal = normalizeProposal(rawProposal);
        return json({ success: true, proposal, filename });
      } catch (err: any) {
        return error(500, `AI curriculum generation failed: ${err?.message || String(err)}`);
      }
    }

    // ---- /api/builder/generate-lesson ----
    if (pathname === '/api/builder/generate-lesson' && method === 'POST') {
      const body = ((await req.json().catch(() => ({}))) || {}) as Record<string, unknown>;
      const courseTitle = typeof body.courseTitle === 'string' ? body.courseTitle.trim() : '';
      const unitTitle = typeof body.unitTitle === 'string' ? body.unitTitle.trim() : '';
      const lessonTitle = typeof body.lessonTitle === 'string' ? body.lessonTitle.trim() : '';
      const grade = typeof body.grade === 'string' ? body.grade.trim() : '';

      if (!lessonTitle) {
        return error(400, 'Lesson title is required.');
      }

      const config = LLMService.loadStoredConfig();
      if (!config || !config.baseUrl) {
        return error(400, 'No active AI model configured. Please configure an AI model in Settings → AI Models.');
      }

      const systemPrompt = `You are an expert curriculum developer and educator.
Write a comprehensive, engaging starter lesson in Markdown format for high school/university students.
Include:
# ${lessonTitle}

### Learning Goals
- Bullet points of key learning objectives

### Key Concepts & Terminology
- 3-5 core definitions or principles

### Overview & Exploration
- Detailed instructional explanation of the topic with structured headings, practical examples, and clear explanations.

### Practice & Discussion Questions
- 3 thoughtful questions or exercises for self-study.

Respond ONLY with the markdown content (no meta commentary).`;

      const userPrompt = `Course: ${courseTitle || 'General Studies'}
Unit: ${unitTitle || 'Current Unit'}
Lesson Topic: ${lessonTitle}
Grade/Level: ${grade || 'High School'}`;

      try {
        const result = await LLMService.generateResult(config, systemPrompt, userPrompt, { timeoutMs: 90_000 });
        return json({ success: true, content: result.completion.trim() });
      } catch (err: any) {
        return error(500, `Lesson generation failed: ${err?.message || String(err)}`);
      }
    }

    // ---- /api/schedules ----
    // Raw course.schedule.md per course; parsing stays client-side where the
    // scheduleParser lives. Archived courses are excluded — their schedules
    // stay on disk and reappear the moment the course is unarchived.
    if (pathname === '/api/schedules' && method === 'GET') {
      const schedules = CourseService.listCourses()
        .filter((c) => !c.archived)
        .map((c) => {
          const markdown = CourseService.getCourseDocument(c.id, 'schedule');
          return {
            courseId: c.id,
            courseTitle: c.title,
            exists: Boolean(markdown && markdown.trim().length > 0),
            markdown: markdown || ''
          };
        });
      return json({ schedules });
    }

    // ---- /api/checkpoints ----
    // All note and PDF markup checkpoints across non-archived courses, sorted newest to oldest.
    if (pathname === '/api/checkpoints' && method === 'GET') {
      const checkpoints = CourseService.listAllCheckpoints();
      return json({ checkpoints });
    }

    // ---- /api/courses/:course_id/** ----
    const courseMatch = pathname.match(/^\/api\/courses\/([^/]+)(?:\/(.*))?$/);
    if (courseMatch) {
      let courseId: string;
      try {
        courseId = assertCourseId(courseMatch[1]).toLowerCase();
      } catch {
        return error(400, 'Invalid course identifier');
      }
      const subpath = courseMatch[2] || '';

      // GET /api/courses/:course_id
      if (!subpath && method === 'GET') {
        const course = CourseService.getCourse(courseId);
        if (!course) return error(404, `Course ${courseId} not found`);
        return json({ course });
      }

      // DELETE /api/courses/:course_id
      if (!subpath && method === 'DELETE') {
        const permanentParam = url.searchParams.get('permanent');
        const permanent = permanentParam !== null ? permanentParam === 'true' : true;
        try {
          const result = CourseManagerService.deleteCourse(courseId, permanent);
          return json(result);
        } catch (err) {
          if (err instanceof NotFoundError) {
            return error(404, `Course ${courseId} not found`);
          }
          throw err;
        }
      }

      // POST /api/courses/:course_id/open
      if (subpath === 'open' && method === 'POST') {
        const courseDir = safeJoin(CourseService.getCoursesDir(), courseId);
        if (!fs.existsSync(courseDir)) {
          return error(404, `Course folder not found: ${courseDir}`);
        }
        return openWithFileManager(courseDir);
      }

      // PUT /api/courses/:course_id/meta  { title?, description?, archived? }
      if (subpath === 'meta' && method === 'PUT') {
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

        const patch: Partial<Pick<CourseManifest, 'title' | 'description' | 'archived' | 'coursePDF'>> = {};
        if (body.title !== undefined) {
          if (typeof body.title !== 'string' || !body.title.trim()) {
            return error(400, 'title must be a non-empty string');
          }
          patch.title = body.title.trim();
        }
        if (body.description !== undefined) {
          if (typeof body.description !== 'string') {
            return error(400, 'description must be a string');
          }
          patch.description = body.description.trim();
        }
        if (body.archived !== undefined) {
          if (typeof body.archived !== 'boolean') {
            return error(400, 'archived must be a boolean');
          }
          patch.archived = body.archived;
        }
        if (body.coursePDF !== undefined) {
          if (typeof body.coursePDF !== 'boolean') {
            return error(400, 'coursePDF must be a boolean');
          }
          patch.coursePDF = body.coursePDF;
        }
        if (Object.keys(patch).length === 0) {
          return error(400, "Nothing to update — provide 'title', 'description', 'archived', or 'coursePDF'");
        }

        if (!CourseService.getCourse(courseId)) {
          return error(404, `Course ${courseId} not found`);
        }
        const updated = CourseService.updateCourseMeta(courseId, patch);
        if (!updated) {
          return error(500, `Failed to update metadata for course ${courseId}`);
        }
        return json({ success: true, course: CourseService.getCourse(courseId) });
      }

      // POST /api/courses/:course_id/schedule/mark-lesson-done  { lessonId: string }
      if (subpath === 'schedule/mark-lesson-done' && method === 'POST') {
        const course = CourseService.getCourse(courseId);
        if (!course) return error(404, `Course '${courseId}' not found`);

        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        const rawLessonId = String(body.lessonId || '').trim();
        if (!rawLessonId) {
          return error(400, 'lessonId is required');
        }

        let lessonId: string;
        try {
          lessonId = assertLessonId(rawLessonId);
        } catch {
          return error(400, 'Invalid lessonId format');
        }

        // Toggle matching uncompleted event(s) in course schedule markdown
        const scheduleMarkdown = CourseService.getCourseDocument(courseId, 'schedule');
        let toggled = false;
        if (scheduleMarkdown) {
          const parsed = ScheduleParser.parseMarkdown(scheduleMarkdown);
          const targetLessonNormalized = lessonId.toLowerCase();
          const targetWithoutZero = targetLessonNormalized.replace(/^0/, '');

          const targetEvents = parsed.events.filter((e) => {
            const evLesson = (e.lessonId || '').toLowerCase();
            const evWithoutZero = evLesson.replace(/^0/, '');
            return evLesson === targetLessonNormalized || evWithoutZero === targetWithoutZero;
          });

          let updatedMarkdown = scheduleMarkdown;
          for (const ev of targetEvents) {
            if (!ev.done) {
              updatedMarkdown = toggleEventDone(updatedMarkdown, ev.lineIndex);
              toggled = true;
            }
          }

          if (toggled) {
            CourseService.saveCourseDocument(courseId, 'schedule', updatedMarkdown);
          }
        }

        // Find next lesson in the curriculum
        const allLessons = course.units ? course.units.flatMap((u) => u.lessons || []) : [];
        const currentIndex = allLessons.findIndex(
          (l) => l.id.toLowerCase() === lessonId.toLowerCase()
        );
        const nextLesson =
          currentIndex >= 0 && currentIndex < allLessons.length - 1
            ? allLessons[currentIndex + 1]
            : null;

        return json({
          success: true,
          toggled,
          lessonId,
          nextLessonId: nextLesson ? nextLesson.id : null,
          nextLessonTitle: nextLesson ? nextLesson.title : null,
          isLastLesson: !nextLesson
        });
      }

      // POST /api/courses/:course_id/unit-test/submit
      if (subpath === 'unit-test/submit' && method === 'POST') {
        const course = CourseService.getCourse(courseId);
        if (!course) return error(404, `Course '${courseId}' not found`);

        const body = (await req.json().catch(() => ({}))) as Record<string, any>;
        const rawUnitId = String(body.unitId || '').trim();
        const testMarkdown = typeof body.testMarkdown === 'string' ? body.testMarkdown : '';
        const answers = (body.answers && typeof body.answers === 'object') ? (body.answers as Record<string, string>) : {};

        if (!rawUnitId) {
          return error(400, 'unitId is required (e.g. "01.unit" or "course")');
        }

        const isCourseTest = rawUnitId === 'course';

        // Get test content if not passed
        let content = testMarkdown;
        if (!content || !content.trim()) {
          if (isCourseTest) {
            content = CourseService.getCourseDocument(courseId, 'test') || '';
          } else {
            const bundle = CourseService.getLessonContent(courseId, rawUnitId);
            content = bundle?.tabs['test'] || '';
          }
        }
        if (!content || !content.trim()) {
          return error(400, `${isCourseTest ? 'Course practice test' : `Unit test for ${rawUnitId}`} is empty or not found.`);
        }

        const parsedQuiz = QuestionParser.parseMarkdown(content);
        if (parsedQuiz.questions.length === 0) {
          return error(400, 'No questions found in unit test.');
        }

        const evaluations: Record<string, {
          isCorrect: boolean;
          score: number;
          feedback?: string;
          parts?: Array<{
            part?: string;
            label?: string;
            isCorrect: boolean;
            feedback?: string;
          }>;
        }> = {};

        // 1. Evaluate multiple-choice deterministically
        const openEndedQuestions: typeof parsedQuiz.questions = [];

        for (const q of parsedQuiz.questions) {
          const studentAns = (answers[q.number] || answers[String(parseInt(q.number, 10))] || '').trim();

          if (q.type === 'multiple-choice') {
            const isCorrect = Boolean(studentAns && q.correctAnswer && studentAns.toUpperCase() === q.correctAnswer.toUpperCase());
            const evalObj = {
              isCorrect,
              score: isCorrect ? 1 : 0,
              feedback: q.explanation || (isCorrect ? 'Correct.' : `Correct answer was ${q.correctAnswer}.`)
            };
            evaluations[q.number] = evalObj;
            evaluations[String(parseInt(q.number, 10))] = evalObj;
          } else {
            // Fill-in-the-blank or short-answer
            if (!studentAns) {
              const evalObj = {
                isCorrect: false,
                score: 0,
                feedback: 'No response provided.'
              };
              evaluations[q.number] = evalObj;
              evaluations[String(parseInt(q.number, 10))] = evalObj;
            } else {
              openEndedQuestions.push(q);
            }
          }
        }

        // 2. Evaluate open-ended (fill-in-the-blank & short-answer) with LLM
        if (openEndedQuestions.length > 0) {
          const config = LLMService.loadStoredConfig();

          if (config && config.baseUrl) {
            try {
              const timeoutMs = LLMService.resolveRequestTimeoutMs(config, 60_000);
              const systemPrompt = `You are a rigorous, objective Ontario Secondary School curriculum evaluator grading practice test questions.
Grade each question strictly and objectively against the provided Expected Content / Rubric and Detailed Explanation.

CRITICAL GRADING RULES:
1. Fill-in-the-Blank Questions:
   - Check if the student's answer accurately captures the required term, concept, or acceptable curriculum synonym.
   - If correct: "isCorrect": true, "score": 1.
   - If incorrect, blank, or inadequate: "isCorrect": false, "score": 0.

2. Short-Answer / Written Problems (Multi-Part or Multi-Item):
   - You MUST analyze the question prompt and rubric for all distinct sub-questions, parts, or items (e.g. parts a, b, c, d; or items like "Identify two risks", "Recommend a strategy", "Explain impact on two users").
   - You MUST evaluate EACH sub-part individually in a "parts" array.
   - For each part, specify:
     * "part": the letter or index (e.g. "a", "b", "c", "d", or "1", "2")
     * "label": descriptive label (e.g. "Part a: Calculation", "Part b: Interpretation", "Part c: Two risks", "Part d: Recommendation & Tech")
     * "isCorrect": true (if student accurately and adequately answered this specific part) or false (if missing, incorrect, or inadequate)
     * "feedback": concise 1-sentence explanation of why this specific part is correct or what was missed
   - The question's "score" MUST be the exact proportion of correct parts: (number of correct parts) / (total parts).
     * Example: If 2 of 4 parts are correct, "score": 0.5.
     * Example: If 3 of 4 parts are correct, "score": 0.75.
     * Example: If 1 of 2 parts is correct, "score": 0.5.
   - "isCorrect" for the question is true ONLY if ALL parts are correct (score === 1). If any part is wrong, "isCorrect" MUST be false.

3. Single-Part Short-Answer Questions:
   - If the question cannot be broken into sub-parts, evaluate if the required core criteria were met:
     * Fully correct: "score": 1, "isCorrect": true
     * Partially correct: "score": 0.5, "isCorrect": false
     * Incorrect: "score": 0, "isCorrect": false

4. Output Format:
Respond ONLY with a valid JSON array in this exact format:
[
  {
    "number": "09",
    "isCorrect": true,
    "score": 1,
    "feedback": "Correctly identified the term."
  },
  {
    "number": "11",
    "isCorrect": false,
    "score": 0.5,
    "feedback": "Parts a and b are correct, but missed parts c and d.",
    "parts": [
      { "part": "a", "label": "Part a: Calculation", "isCorrect": true, "feedback": "Owner's equity correctly calculated as $55,000." },
      { "part": "b", "label": "Part b: Interpretation", "isCorrect": true, "feedback": "Accurately explained owner claim on assets." },
      { "part": "c", "label": "Part c: Two risks", "isCorrect": false, "feedback": "Did not identify unlimited personal liability." },
      { "part": "d", "label": "Part d: Strategy", "isCorrect": false, "feedback": "Did not propose a technology strategy." }
    ]
  }
]`;

              const userPrompt = `Please evaluate these student responses against the Ontario curriculum expected content and rubrics:
${openEndedQuestions.map(q => `
Question ${q.number} (${q.type}):
Question Prompt:
${q.prompt}

Expected Content / Rubric:
${q.correctAnswer}

Detailed Explanation / Grading Criteria:
${q.explanation || q.correctAnswer || 'None provided'}

Student Response:
${answers[q.number] || answers[String(parseInt(q.number, 10))] || '(No response provided)'}
`).join('\n---\n')}
`;

              const result = await LLMService.generateResult(config, systemPrompt, userPrompt, { timeoutMs });
              CourseService.recordLog({
                courseId,
                lessonDoc: isCourseTest ? 'course.test.md' : `${rawUnitId}.test.md`,
                chars: result.completion.length,
                tokens: result.usage?.total_tokens ?? 0
              });
              const rawJson = result.completion.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
              const parsedArray = JSON.parse(rawJson);

              if (Array.isArray(parsedArray)) {
                for (const item of parsedArray) {
                  const numPadded = String(item.number || '').padStart(2, '0');
                  const numRaw = String(parseInt(item.number, 10));
                  const matchingQ = openEndedQuestions.find(q => q.number === numPadded || q.number === numRaw);
                  const key = matchingQ ? matchingQ.number : numPadded;

                  let itemScore = typeof item.score === 'number' ? item.score : (item.isCorrect ? 1 : 0);
                  let itemIsCorrect = Boolean(item.isCorrect);

                  // Logical calculation: if parts are supplied, derive score directly from parts
                  let parts: Array<{ part?: string; label?: string; isCorrect: boolean; feedback?: string }> | undefined = undefined;
                  if (Array.isArray(item.parts) && item.parts.length > 0) {
                    const mappedParts = item.parts.map((p: any) => ({
                      part: p.part ? String(p.part) : undefined,
                      label: p.label ? String(p.label) : (p.part ? `Part ${p.part}` : undefined),
                      isCorrect: Boolean(p.isCorrect),
                      feedback: p.feedback ? String(p.feedback) : undefined
                    }));
                    const correctPartsCount = mappedParts.filter((p: { isCorrect: boolean }) => p.isCorrect).length;
                    itemScore = Math.round((correctPartsCount / mappedParts.length) * 100) / 100;
                    itemIsCorrect = correctPartsCount === mappedParts.length;
                    parts = mappedParts;
                  } else {
                    itemScore = Math.min(1, Math.max(0, itemScore));
                    if (itemScore < 1) {
                      itemIsCorrect = false;
                    }
                  }

                  const evalObj = {
                    isCorrect: itemIsCorrect,
                    score: itemScore,
                    feedback: typeof item.feedback === 'string' ? item.feedback : undefined,
                    parts
                  };

                  evaluations[key] = evalObj;
                  evaluations[numPadded] = evalObj;
                  evaluations[numRaw] = evalObj;
                }
              }
            } catch (llmErr) {
              console.warn('[Unit Test LLM Evaluation Warning]', llmErr);
            }
          }

          // Fallback for any open-ended question that wasn't evaluated by LLM
          for (const q of openEndedQuestions) {
            if (!evaluations[q.number]) {
              const studentAns = (answers[q.number] || answers[String(parseInt(q.number, 10))] || '').trim();
              if (q.type === 'fill-in-the-blank') {
                const cleanStudent = studentAns.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
                const cleanCorrect = q.correctAnswer.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
                const isCorrect = cleanStudent.length > 0 && (cleanStudent === cleanCorrect || cleanCorrect.includes(cleanStudent) || cleanStudent.includes(cleanCorrect));
                const evalObj = {
                  isCorrect,
                  score: isCorrect ? 1 : 0,
                  feedback: q.explanation || (isCorrect ? 'Correct.' : `Expected: ${q.correctAnswer}`)
                };
                evaluations[q.number] = evalObj;
                evaluations[String(parseInt(q.number, 10))] = evalObj;
              } else {
                // Short answer fallback: Detect sub-parts like a), b), c), d) in prompt
                const subPartMatches = Array.from(q.prompt.matchAll(/(?:^|\n|\s)([a-d]\))/gi)).map(m => m[1].toLowerCase());
                if (subPartMatches.length > 1) {
                  const parts = subPartMatches.map(partKey => {
                    const hasPartInAnswer = studentAns.toLowerCase().includes(partKey);
                    return {
                      part: partKey.replace(')', ''),
                      label: `Part ${partKey.replace(')', '')}`,
                      isCorrect: hasPartInAnswer && studentAns.length > 30,
                      feedback: hasPartInAnswer ? 'Sub-part response detected.' : 'Missing sub-part response.'
                    };
                  });
                  const correctCount = parts.filter((p: { isCorrect: boolean }) => p.isCorrect).length;
                  const score = Math.round((correctCount / parts.length) * 100) / 100;
                  const evalObj = {
                    isCorrect: correctCount === parts.length,
                    score,
                    feedback: `Automated assessment: ${correctCount}/${parts.length} parts identified. Please review rubric.`,
                    parts
                  };
                  evaluations[q.number] = evalObj;
                  evaluations[String(parseInt(q.number, 10))] = evalObj;
                } else {
                  const hasSubstantialResponse = studentAns.length >= 30;
                  const evalObj = {
                    isCorrect: hasSubstantialResponse,
                    score: hasSubstantialResponse ? 0.5 : 0,
                    feedback: hasSubstantialResponse
                      ? 'Automated evaluation: Response noted. Review expected rubric below.'
                      : 'Response was too brief or incomplete.'
                  };
                  evaluations[q.number] = evalObj;
                  evaluations[String(parseInt(q.number, 10))] = evalObj;
                }
              }
            }
          }
        }

        // 3. Compute totals logically
        const total = parsedQuiz.questions.length;
        let score = 0;
        for (const q of parsedQuiz.questions) {
          const ev = evaluations[q.number] || evaluations[String(parseInt(q.number, 10))];
          if (ev) {
            score += (typeof ev.score === 'number' ? ev.score : (ev.isCorrect ? 1 : 0));
          }
        }
        score = Math.round(score * 100) / 100;
        const percentage = total > 0 ? Math.round((score / total) * 100) : 0;
        const today = new Date().toISOString().split('T')[0];

        // 4. Update frontmatter on disk for the unit test file
        // Remember mark and date of doing it, NOT the actual answers!
        const parsedDoc = parseFrontmatter(content);
        const updatedFrontmatter: Record<string, any> = {
          ...parsedDoc.frontmatter,
          lastAttemptDate: today,
          score,
          totalQuestions: total,
          percentage
        };
        // Ensure no actual answers are saved in frontmatter
        delete updatedFrontmatter.answers;
        delete updatedFrontmatter.userAnswers;
        delete updatedFrontmatter.studentAnswers;

        const updatedMarkdown = serializeWithFrontmatter(updatedFrontmatter, parsedDoc.body);
        if (isCourseTest) {
          CourseService.saveCourseDocument(courseId, 'test', updatedMarkdown);
        } else {
          CourseService.saveLessonTab(courseId, rawUnitId, 'test', updatedMarkdown);
        }

        // 5. Construct evaluated question payload for supervisor email
        const evaluatedQuestions: UnitTestQuestionResult[] = parsedQuiz.questions.map((q) => {
          const studentAns = (answers[q.number] || answers[String(parseInt(q.number, 10))] || '').trim();
          const ev = evaluations[q.number] || evaluations[String(parseInt(q.number, 10))];
          const isCorrect = ev ? ev.isCorrect : false;
          const itemScore = ev && typeof ev.score === 'number' ? ev.score : (isCorrect ? 1 : 0);

          return {
            number: q.number,
            category: q.category,
            type: q.type || (q.options && q.options.length > 0 ? 'multiple-choice' : 'fill-in-the-blank'),
            prompt: q.prompt,
            options: q.options,
            studentAnswer: studentAns,
            correctAnswer: q.correctAnswer || '',
            isCorrect,
            score: itemScore,
            explanation: q.explanation,
            feedback: ev?.feedback,
            parts: ev?.parts
          };
        });

        // 6. Dispatch email to Supervisor via TeacherCheckinService
        let emailSent = false;
        let emailError: string | undefined;

        const unitNumMatch = rawUnitId.match(/^(\d+)/);
        const unitNum = unitNumMatch ? parseInt(unitNumMatch[1], 10) : undefined;
        const unitObj = !isCourseTest && unitNum !== undefined ? course.units?.find((u) => u.number === unitNum) : undefined;
        const resolvedUnitTitle = cleanImageReferences(parsedQuiz.title) || (isCourseTest ? `${course.id.toUpperCase()} Practice Exam` : (unitObj ? `Unit ${unitObj.number}: ${cleanImageReferences(unitObj.title)}` : `Unit ${rawUnitId}`));

        try {
          await TeacherCheckinService.sendUnitTestResultEmail({
            courseId,
            unitId: rawUnitId,
            unitTitle: resolvedUnitTitle,
            timestamp: new Date().toLocaleString(),
            questions: evaluatedQuestions,
            score,
            total,
            percentage
          });
          emailSent = true;
        } catch (err: any) {
          console.warn('[Unit Test Email Dispatch Notice]', err?.message || err);
          emailError = err?.message || 'Failed to dispatch email';
        }

        return json({
          success: true,
          score,
          total,
          percentage,
          lastAttemptDate: today,
          evaluations,
          updatedMarkdown,
          emailSent,
          emailError,
          supervisorSent: emailSent,
          supervisorMessage: 'Updated course supervisor, thank you!'
        });
      }

      // GET|POST|DELETE /api/courses/:course_id/locker-docs
      if (subpath === 'locker-docs') {
        const course = CourseService.getCourse(courseId);
        if (!course) return error(404, `Course '${courseId}' not found`);

        if (method === 'GET') {
          const files = CourseService.listLockerDocs(courseId);
          return json({ success: true, courseId, files });
        }

        if (method === 'POST') {
          try {
            const formData = await req.formData();
            const file = formData.get('file') as File | null;
            if (!file) return error(400, 'A file is required');
            const arrayBuffer = await file.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);
            const saved = CourseService.saveLockerDoc(courseId, file.name, buffer);
            return json({ success: true, courseId, file: saved });
          } catch (err) {
            console.error(`Failed to upload locker doc for ${courseId}:`, err);
            return error(500, err instanceof Error ? err.message : 'Failed to save locker document');
          }
        }

        if (method === 'DELETE') {
          const filename = url.searchParams.get('file');
          if (!filename) return error(400, 'file query parameter required');
          const removed = CourseService.deleteLockerDoc(courseId, filename);
          return json({ success: removed });
        }
      }

      // GET /api/courses/:course_id/prompt-context
      if (subpath === 'prompt-context' && method === 'GET') {
        const course = CourseService.getCourse(courseId);
        if (!course) return error(404, `Course '${courseId}' not found`);

        const attachment = url.searchParams.get('attachment') || 'lesson - lessons';
        const lessonId = url.searchParams.get('lessonId') || undefined;
        const content = await CourseService.getPromptContext(courseId, attachment, lessonId);

        return json({
          success: true,
          attachment,
          content,
          charCount: content.length
        });
      }

      // GET|POST|PUT /api/courses/:course_id/course-docs
      if (subpath === 'course-docs') {
        const course = CourseService.getCourse(courseId);
        if (!course) return error(404, `Course '${courseId}' not found`);

        if (method === 'GET') {
          const type = url.searchParams.get('type') as 'notes' | CourseDocType | Tab | null;
          const isPreview = url.searchParams.get('preview') === 'true' || url.searchParams.get('preview') === '1';
          const checkStatus = url.searchParams.get('status') === 'true' || url.searchParams.get('status') === '1';

          if (type && checkStatus) {
            if (type === 'schedule') {
              const qStatus = queueManager.getStatus(courseId);
              const isScheduleActive = qStatus.tasks.some(
                (t) => t.tab === 'schedule' && (t.status === 'pending' || t.status === 'processing')
              );
              if (isScheduleActive) {
                return json({ success: true, status: 'generating' });
              }
            }
            const jobKey = `${courseId.toLowerCase()}:${type}`;
            const job = activeCourseDocJobs.get(jobKey);
            if (job) {
              if (job.status === 'generating') {
                return json({ success: true, status: 'generating', elapsedMs: Date.now() - job.startedAt });
              }
              if (job.status === 'completed' && job.result) {
                activeCourseDocJobs.delete(jobKey);
                return json({
                  success: true,
                  status: 'completed',
                  cached: false,
                  markdown: job.result.markdown,
                  usage: job.result.usage,
                  warnings: job.result.warnings,
                  debug: job.result.debug
                });
              }
              if (job.status === 'failed') {
                const errMsg = job.error || `Failed to generate course ${type}`;
                activeCourseDocJobs.delete(jobKey);
                return json({ success: false, status: 'failed', error: errMsg }, 500);
              }
            }
            const existing = CourseService.getCourseDocument(courseId, type as CourseDocType);
            return json({
              success: true,
              status: 'idle',
              exists: Boolean(existing),
              markdown: existing || ''
            });
          }

          if (type === 'notes') {
            const startedAt = performance.now();
            const markdown = CourseService.buildAggregatedNotes(courseId);
            const builtMs = performance.now() - startedAt;
            const body = JSON.stringify({ success: true, markdown });
            const serializedMs = performance.now() - startedAt - builtMs;
            console.log(
              `[PERF][server] course-docs notes: build=${builtMs.toFixed(1)}ms ` +
                `serialize=${serializedMs.toFixed(1)}ms ` +
                `chars=${markdown.length.toLocaleString()} ` +
                `bytes=${new TextEncoder().encode(body).byteLength.toLocaleString()}`
            );
            return json({ success: true, markdown });
          }
          if (type === 'schedule' && isPreview) {
            const scheduleStats: SchedulePayloadStats = { lessons: 0, assignments: 0, totalWords: 0, density: {} };
            const payload = CourseService.buildSchedulePayload(courseId, scheduleStats);
            return json({
              success: true,
              type: 'schedule',
              preview: true,
              payload,
              stats: scheduleStats
            });
          }
          if (type) {
            const markdown = CourseService.getCourseDocument(courseId, type);
            if (markdown !== null) {
              return json({ success: true, exists: true, markdown });
            }
            return json({ success: true, exists: false, markdown: '' });
          }
          return json({
            success: true,
            courseDocs: course.courseDocs || {
              summary: false,
              notes: false,
              studysheet: false,
              test: false,
              schedule: false
            }
          });
        }

        if (method === 'POST') {
          const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
          const rawType = body.type as string | undefined;
          const type = (rawType === 'studysheet' ? 'notes' : rawType) as CourseDocType | undefined;
          const forceRegenerate = Boolean(body.forceRegenerate);
          const customPrompt = typeof body.customPrompt === 'string' ? body.customPrompt.trim() : undefined;

          if (!type || !(COURSE_DOC_TYPES as readonly string[]).includes(type)) {
            return error(400, "Invalid type. Must be 'summary', 'notes', 'test', 'schedule', or 'logs'");
          }

          if (type === 'logs') {
            return json({
              success: true,
              markdown: CourseService.getLogs(courseId) || '# Course Logs\n\n| Date | Type | Lesson | Tokens |\n| :--- | :--- | :--- | :--- |\n'
            });
          }

          // 1. Cached document unless regeneration is forced
          if (!forceRegenerate) {
            const existing = CourseService.getCourseDocument(courseId, type);
            if (existing && existing.trim().length > 0) {
              return json({ success: true, cached: true, markdown: existing });
            }
          }

          // 2. System prompt template (custom prompt or course-specific, falling back to lesson-level)
          let systemPrompt = customPrompt;
          if (!systemPrompt) {
            const promptItem =
              PromptService.getPrompt(`course_${type}`) ?? PromptService.getPrompt(type);
            systemPrompt = promptItem ? promptItem.content : '';
          }
          if (!systemPrompt || systemPrompt.trim().length === 0) {
            return error(
              400,
              `Core prompt template for course ${type} is missing. Please add course_${type}.md in your prompts directory.`
            );
          }

          // 3. Active or requested LLM config
          const requestedCardId = typeof body.cardId === 'string' && body.cardId.trim() ? body.cardId.trim() : undefined;
          const config = LLMService.loadCardConfig(requestedCardId);
          if (!config || !config.baseUrl) {
            return error(400, 'Active LLM configuration is required. Please configure your LLM settings.');
          }

          // Schedules are enqueued into the background queue to avoid blocking
          if (type === 'schedule') {
            const enqueued = queueManager.enqueue([
              {
                courseId,
                lessonId: 'schedule',
                lessonTitle: 'Course Study Schedule',
                tab: 'schedule',
                customPrompt: systemPrompt,
                preferences: (body.preferences as SchedulePreferences) || undefined,
                cardId: requestedCardId
              }
            ]);
            return json({
              success: true,
              status: 'generating',
              queued: true,
              enqueued,
              message: 'Course schedule generation enqueued in background AI queue'
            });
          }

          const contextAttachment =
            typeof body.contextAttachment === 'string'
              ? body.contextAttachment.trim()
              : `course - ${type === 'summary' ? 'summaries' : type === 'notes' ? 'notes' : 'lessons'}`;
          const customContent = typeof body.customContent === 'string' ? body.customContent : undefined;

          // 4. Aggregated lesson payload for course summary / notes / test
          const payload =
            customContent !== undefined
              ? customContent
              : (await CourseService.getPromptContext(courseId, contextAttachment)) ||
                CourseService.buildAggregatedPayload(courseId, type as 'summary' | 'notes' | 'test');
          if (!payload || payload.trim().length < 50) {
            return error(
              400,
              "No lesson materials found to generate a course-level " +
                type +
                ". Please add lesson content for this course first."
            );
          }

          const customTimeout = typeof body.timeoutMs === 'number' && body.timeoutMs > 0 ? body.timeoutMs : undefined;
          // Per-call override when a caller sends one; otherwise the
          // "Request Timeout" from Settings governs.
          const timeoutMs = customTimeout ?? LLMService.resolveRequestTimeoutMs(config);

          console.log(
            `[Course AI] Generating course.${type}.md for ${courseId.toUpperCase()} using model: ${config.model || 'default'} (timeout: ${Math.round(timeoutMs / 1000)}s)`
          );

          const isAsync = body.async === true;
          const jobKey = `${courseId.toLowerCase()}:${type}`;

          const runGeneration = async () => {
            const result = await LLMService.generateResult(config, systemPrompt, stripLessonMedia(payload), { timeoutMs });
            const repaired = repairMarkdownTables(result.completion.trim());
            const parsed = parseFrontmatter(repaired);
            const content = serializeWithFrontmatter(
              {
                ...parsed.frontmatter,
                type: `course_${type}`,
                updatedAt: new Date().toISOString().split('T')[0],
                prompt: systemPrompt,
                contextAttachment
              },
              parsed.body.trim()
            );
            CourseService.saveCourseDocument(courseId, type, content);
            CourseService.recordLog({
              courseId,
              lessonDoc: courseDocFileName(type),
              chars: result.completion.length,
              tokens: result.usage?.total_tokens ?? 0
            });
            const tokensUsed = result.usage?.total_tokens;
            const tokenBreakdown = result.usage?.prompt_tokens !== undefined
              ? ` (prompt: ${result.usage.prompt_tokens.toLocaleString()}, completion: ${result.usage.completion_tokens?.toLocaleString() ?? '?'})`
              : '';
            const tokensInfo = tokensUsed !== undefined
              ? ` | Total tokens used: ${tokensUsed.toLocaleString()}${tokenBreakdown}`
              : '';
            console.log(
              `[Course AI] Saved course.${type}.md for ${courseId.toUpperCase()} (${content.length.toLocaleString()} chars)${tokensInfo}`
            );

            return {
              success: true,
              cached: false,
              markdown: content,
              usage: result.usage
            };
          };

          if (isAsync) {
            const existingJob = activeCourseDocJobs.get(jobKey);
            if (existingJob && existingJob.status === 'generating' && Date.now() - existingJob.startedAt < 600_000) {
              return json({ success: true, status: 'generating', message: 'Generation already in progress' });
            }

            activeCourseDocJobs.set(jobKey, {
              courseId,
              type,
              status: 'generating',
              startedAt: Date.now()
            });

            runGeneration()
              .then((res) => {
                activeCourseDocJobs.set(jobKey, {
                  courseId,
                  type,
                  status: 'completed',
                  startedAt: Date.now(),
                  result: res
                });
              })
              .catch((err) => {
                console.error(`[Course AI] Background generation failed for course.${type}.md:`, err);
                activeCourseDocJobs.set(jobKey, {
                  courseId,
                  type,
                  status: 'failed',
                  startedAt: Date.now(),
                  error: err instanceof Error ? err.message : `Failed to generate course ${type}`
                });
              });

            return json({ success: true, status: 'generating', message: 'Generation started in background' });
          }

          // 5. Synchronous generate + save
          try {
            const res = await runGeneration();
            return json(res);
          } catch (err) {
            console.error(`[Course AI] Failed to generate course.${type}.md:`, err);
            return error(500, err instanceof Error ? err.message : `Failed to generate course ${type}`);
          }
        }

        if (method === 'PUT') {
          const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
          const tab = typeof body.type === 'string' ? body.type : '';
          const content = body.content as string | undefined;

          try {
            assertTab(tab);
          } catch {
            return error(400, "Invalid type. Must be a valid tab slug");
          }
          if (typeof content !== 'string') {
            return error(400, 'Invalid request: content string required');
          }

          const success = CourseService.saveCourseDocument(courseId, tab, content);
          if (!success) {
            return error(500, `Failed to save course ${tab}`);
          }
          return json({ success: true });
        }
      }

      // GET|HEAD /api/courses/:course_id/assets/**
      const assetsMatch = subpath.match(/^assets\/(.+)$/);
      if (assetsMatch && (method === 'GET' || method === 'HEAD')) {
        // Already decoded once at the top of handleApiRequest — decoding here
        // again would corrupt asset names containing a literal '%'.
        const assetRelativePath = assetsMatch[1];
        const fullPath = CourseService.resolveAssetPath(courseId, assetRelativePath);
        if (!fullPath || !fs.existsSync(fullPath)) {
          return error(404, 'Asset not found');
        }
        return fileResponse(fullPath, { 'Cache-Control': 'public, max-age=86400' });
      }

      // ---- Checkpoints for course ----
      // GET /api/courses/:course_id/annotations
      if (subpath === 'annotations' && method === 'GET') {
        const strokes = CourseService.getAnnotations(courseId);
        return json({ strokes });
      }

      // PUT /api/courses/:course_id/annotations (merge upserts, LWW on date)
      if (subpath === 'annotations' && method === 'PUT') {
        const body = (await req.json().catch(() => ({}))) as { upserts?: unknown[] };
        if (!Array.isArray(body.upserts)) {
          return error(400, 'upserts array is required');
        }
        const { strokes, merged } = CourseService.mergeAnnotations(courseId, body.upserts as MarkupStroke[]);
        return json({ success: true, merged, strokes });
      }

      // GET /api/courses/:course_id/checkpoints
      if (subpath === 'checkpoints' && method === 'GET') {
        const checkpoints = CourseService.getCheckpoints(courseId);
        return json({ checkpoints });
      }

      // POST /api/courses/:course_id/checkpoints (create or update note)
      if (subpath === 'checkpoints' && method === 'POST') {
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        const file = typeof body.file === 'string' ? body.file.trim() : '';
        const verticalPosition = typeof body.verticalPosition === 'number' ? body.verticalPosition : 0;
        if (!file) {
          return error(400, 'file is required');
        }
        const note = CourseService.addOrUpdateNoteCheckpoint(courseId, {
          id: typeof body.id === 'string' ? body.id : undefined,
          file,
          verticalPosition,
          color: typeof body.color === 'string' ? body.color : undefined,
          noteText: typeof body.noteText === 'string' ? body.noteText : undefined
        });
        return json({ success: true, checkpoint: note });
      }

      // POST /api/courses/:course_id/checkpoints/position (debounced position recording)
      if (subpath === 'checkpoints/position' && method === 'POST') {
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        const file = typeof body.file === 'string' ? body.file.trim() : '';
        const verticalPosition = typeof body.verticalPosition === 'number' ? body.verticalPosition : 0;
        if (!file) {
          return error(400, 'file is required');
        }
        const posCheckpoint = CourseService.recordPositionCheckpoint(courseId, file, verticalPosition);
        return json({ success: true, checkpoint: posCheckpoint });
      }

      // DELETE /api/courses/:course_id/checkpoints/:id
      const deleteCpMatch = subpath.match(/^checkpoints\/([^/]+)$/);
      if (deleteCpMatch && method === 'DELETE') {
        const checkpointId = deleteCpMatch[1];
        const success = CourseService.deleteCheckpoint(courseId, checkpointId);
        return json({ success });
      }

      // GET|PUT /api/courses/:course_id/:lesson_id
      const lessonMatch = subpath.match(/^([^/]+)$/);
      if (lessonMatch) {
        const lessonId = lessonMatch[1];
        try {
          assertLessonId(lessonId);
        } catch {
          return error(400, 'Invalid lesson identifier');
        }

        if (method === 'GET') {
          const bundle = CourseService.getLessonContent(courseId, lessonId);
          if (!bundle) return error(404, `Lesson ${lessonId} not found in ${courseId}`);
          return json(bundle);
        }

        if (method === 'PUT') {
          const body = (await req.json()) as Record<string, unknown>;
          const { tab, content } = body;
          try {
            assertTab(tab);
          } catch {
            return error(400, 'Invalid tab');
          }
          if (typeof content !== 'string') {
            return error(400, 'Invalid request: content string required');
          }
          const result = CourseService.saveLessonTab(courseId, lessonId, tab as string, content);
          if (!result.success) {
            return error(500, `Failed to save ${tab} for lesson ${lessonId}`);
          }
          return json(result);
        }

        if (method === 'DELETE') {
          const tab = url.searchParams.get('tab');
          try {
            assertTab(tab);
          } catch {
            return error(400, 'Invalid or missing tab query parameter');
          }
          const removed = CourseService.deleteLessonTab(courseId, lessonId, tab as string);
          return json({ success: true, removed });
        }
      }
    }

    return error(404, `Not found: ${pathname}`);
  } catch (err) {
    if (err instanceof PathValidationError) {
      return error(400, err.message);
    }
    console.error(`[API Error] ${method} ${pathname}:`, err);
    return error(500, err instanceof Error ? err.message : 'Internal server error');
  }
}
