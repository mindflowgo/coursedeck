import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { CourseService, type SchedulePayloadStats } from './courses';
import { PromptService } from './prompts';
import { LLMService, type LLMConfig } from './llm';
import { queueManager } from './queue';
import {
  getDataDir,
  getCoursesDir,
  safeJoin,
  assertCourseId,
  assertLessonId,
  assertPromptId,
  assertTab,
  PathValidationError,
  getDataStorageInfo,
  setCustomDataDir,
  loadAppSettings,
  saveAppSettings
} from './paths';
import { parseFrontmatter, serializeWithFrontmatter } from '../parser/frontmatter';
import { CourseIngest, type CourseDocType, type CourseManifest } from '../parser/courseIngest';
import { validateScheduleMarkdown } from '../parser/scheduleValidation';
import type { SchedulePreferences } from '../schedule';
import { ScheduleParser } from '../parser/scheduleParser';
import { optimizeCourseImages } from '../parser/imageOptimizer';
import { createDataBackupZip, createDataBackupZipStream, restoreDataBackupZip } from './backup';

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

type Tab = 'summary' | 'cheatsheet' | 'test';

/** Course-level document types accepted by /api/courses/:id/course-docs. */
const COURSE_DOC_TYPES: readonly CourseDocType[] = ['summary', 'cheatsheet', 'test', 'schedule'];

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

const DEFAULT_LESSON_TABS: readonly Tab[] = ['summary', 'cheatsheet', 'test'];

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
        const config = LLMService.loadStoredConfig();
        return json({
          hasConfig: Boolean(config && config.baseUrl),
          config: config
            ? {
                provider: config.provider,
                baseUrl: config.baseUrl,
                model: config.model,
                authHeaderType: config.authHeaderType,
                temperature: config.temperature,
                timeoutSeconds: config.timeoutSeconds,
                hasApiKey: Boolean(config.apiKey)
              }
            : null
        });
      }

      if (method === 'POST') {
        const body = (await req.json()) as Record<string, unknown>;
        const action = body.action as string | undefined;
        const config = body.config as LLMConfig | undefined;
        const { systemPrompt, userPrompt, sessionId } = body;
        if (!config) return error(400, 'LLM config is required');

        if (config.baseUrl) {
          LLMService.saveStoredConfig(config);
        }
        if (sessionId && !config.sessionId) {
          config.sessionId = sessionId as string;
        }

        if (action === 'save_config') {
          return json({ success: true, message: 'LLM configuration saved' });
        }
        if (action === 'test') {
          const result = await LLMService.testConnection(config);
          return json(result);
        }
        if (action === 'generate') {
          if (!systemPrompt || !userPrompt) {
            return error(400, 'systemPrompt and userPrompt are required for generation');
          }
          try {
            const result = await LLMService.generateResult(
              config,
              systemPrompt as string,
              userPrompt as string
            );
            return json({ success: true, completion: result.completion, usage: result.usage });
          } catch (err) {
            console.error('[LLM] Generation failed:', err);
            return error(500, err instanceof Error ? err.message : 'LLM generation failed');
          }
        }
        return error(400, `Unknown action: ${action}`);
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
          customPrompt,
          customConfig
        } = body;

        if (customConfig) {
          LLMService.saveStoredConfig(customConfig as LLMConfig);
        }

        if (action === 'enqueue') {
          if (!courseId) {
            return error(400, 'courseId is required to enqueue tasks');
          }

          const singleTab = typeof body.tab === 'string' ? body.tab : undefined;
          const bulkTabs = Array.isArray(body.tabs) ? (body.tabs as unknown[]) : undefined;

          if (singleTab !== undefined) {
            // One tab for one lesson — any valid tab slug, custom tabs included.
            // The schedule is a queue-only pseudo-tab for the whole course.
            try {
              assertTab(singleTab);
            } catch {
              return error(400, `Invalid tab: ${JSON.stringify(singleTab)}`);
            }
            if (!lessonId && singleTab !== 'schedule') {
              return error(400, 'lessonId is required to generate a lesson tab');
            }

            const items = [
              {
                courseId: String(courseId),
                lessonId: singleTab === 'schedule' ? 'schedule' : String(lessonId),
                lessonTitle:
                  singleTab === 'schedule' ? 'Course Schedule' : String(lessonTitle || lessonId),
                tab: singleTab,
                customPrompt: (customPrompt || prompt) as string | undefined,
                preferences: body.preferences as SchedulePreferences | undefined
              }
            ];
            const enqueued = queueManager.enqueue(items, customConfig as LLMConfig | undefined);
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
            (t): t is Tab =>
              typeof t === 'string' && (DEFAULT_LESSON_TABS as readonly string[]).includes(t)
          );
          if (!valid) {
            return error(
              400,
              "Invalid tabs. Bulk generation supports 'summary', 'cheatsheet', and 'test'"
            );
          }
          const lessonTabs = requested as Tab[];

          if (lessonId) {
            const items = lessonTabs.map((t) => ({
              courseId: String(courseId),
              lessonId: String(lessonId),
              lessonTitle: String(lessonTitle || lessonId),
              tab: t
            }));
            const enqueued = queueManager.enqueue(items, customConfig as LLMConfig | undefined);
            return json({
              success: true,
              enqueued,
              skipped: items.length - enqueued.length,
              status: queueManager.getStatus(String(courseId))
            });
          }

          const enqueued = queueManager.enqueueCourseMissing(
            String(courseId),
            lessonTabs,
            customConfig as LLMConfig | undefined
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
            'course_cheatsheet',
            'course_schedule',
            'course_test',
            'summary',
            'cheatsheet',
            'test',
            'test_kica',
            'lesson'
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

        const patch: Partial<Pick<CourseManifest, 'title' | 'description' | 'archived'>> = {};
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
        if (Object.keys(patch).length === 0) {
          return error(400, "Nothing to update — provide 'title', 'description', or 'archived'");
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
              cheatsheet: false,
              test: false,
              schedule: false
            }
          });
        }

        if (method === 'POST') {
          const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
          const type = body.type as CourseDocType | undefined;
          const forceRegenerate = Boolean(body.forceRegenerate);
          const customPrompt = typeof body.customPrompt === 'string' ? body.customPrompt.trim() : undefined;

          if (!type || !(COURSE_DOC_TYPES as readonly string[]).includes(type)) {
            return error(400, "Invalid type. Must be 'summary', 'cheatsheet', 'test', or 'schedule'");
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

          // 3. Active LLM config
          const config = (body.customConfig as LLMConfig) || LLMService.loadStoredConfig();
          if (!config || !config.baseUrl) {
            return error(400, 'Active LLM configuration is required. Please configure your LLM settings.');
          }

          // Schedules are enqueued into the background queue to avoid blocking
          if (type === 'schedule') {
            const enqueued = queueManager.enqueue(
              [
                {
                  courseId,
                  lessonId: 'schedule',
                  lessonTitle: 'Course Study Schedule',
                  tab: 'schedule',
                  customPrompt: systemPrompt
                }
              ],
              config
            );
            return json({
              success: true,
              status: 'generating',
              queued: true,
              enqueued,
              message: 'Course schedule generation enqueued in background AI queue'
            });
          }

          // 4. Aggregated lesson payload for course summary / cheatsheet / test
          const payload = CourseService.buildAggregatedPayload(courseId, type);
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
            const result = await LLMService.generateResult(config, systemPrompt, payload, { timeoutMs });
            const parsed = parseFrontmatter(result.completion.trim());
            const content = serializeWithFrontmatter(
              {
                ...parsed.frontmatter,
                type: `course_${type}`,
                updatedAt: new Date().toISOString().split('T')[0],
                prompt: systemPrompt
              },
              parsed.body.trim()
            );
            CourseService.saveCourseDocument(courseId, type, content);
            console.log(
              `[Course AI] Saved course.${type}.md for ${courseId.toUpperCase()} (${content.length.toLocaleString()} chars)`
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

      // GET /api/courses/:course_id/assets/**
      const assetsMatch = subpath.match(/^assets\/(.+)$/);
      if (assetsMatch && method === 'GET') {
        // Already decoded once at the top of handleApiRequest — decoding here
        // again would corrupt asset names containing a literal '%'.
        const assetRelativePath = assetsMatch[1];
        const fullPath = CourseService.resolveAssetPath(courseId, assetRelativePath);
        if (!fullPath || !fs.existsSync(fullPath)) {
          return error(404, 'Asset not found');
        }
        return fileResponse(fullPath, { 'Cache-Control': 'public, max-age=86400' });
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
