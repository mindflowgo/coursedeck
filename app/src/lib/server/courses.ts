import fs from 'node:fs';
import path from 'node:path';
import { unzipSync } from 'fflate';
import type { CourseDocType, CourseManifest } from '../parser/courseIngest';
import { derivePdfMarkupCheckpoints, isCheckpointType, normalizeAiStatus, normalizeCheckpointRecord, type Anchor, type Checkpoint, type CheckpointType, type SelectionRange } from '../checkpoint';
import { isMarkupStroke, type MarkupStroke } from '../markup/types';
import { tabFileName, courseDocFileName, parseDocFileName, parseUnitNumber, isUnitScopeId } from '../tabs';
import { parseFrontmatter } from '../parser/frontmatter';
import { computeSummaryDensity, countWords } from '../parser/scheduleMetrics';
import { stripLessonMedia } from '../markdown/stripMedia';
import type { LessonEffort, PlannedSession } from '../scheduleGenerator';
export type { LessonEffort };

export function formatLogDate(date: Date = new Date()): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const h = date.getHours();
  const min = String(date.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${h}:${min}`;
}

export interface CourseLogRecordOptions {
  courseId: string;
  type?: string;
  lessonDoc: string;
  chars?: number;
  tokens?: number;
  date?: Date;
}
import {
  assertCourseId,
  assertLessonId,
  assertTab,
  getCoursesDir as resolveCoursesDir,
  getDataDir,
  normalizeCourseId,
  safeJoin,
  trySafeJoin,
} from './paths';
import { extractTextFromPdf } from './pdfText';

export interface LessonContentBundle {
  courseId: string;
  lessonId: string;
  /** Companion markdown content. For 'html'/'pdf' formats, sourced from .lesson.companion.md.
   *  For 'markdown' format, sourced from .lesson.md. */
  lesson: string;
  /** Every tab file on disk for this lesson, keyed by tab slug (summary, test, assignment, …). */
  tabs: Record<string, string>;
  format: 'markdown' | 'html' | 'pdf' | 'video';
  hasCompanion: boolean;
}

export interface LockerDocItem {
  filename: string;
  size: number;
  updatedAt: string;
  url: string;
  ext: string;
}

export interface SchedulePayloadItem {
  unitNumber: number;
  unitTitle: string;
  lessonId: string;
  lessonTitle: string;
  type: 'lesson' | 'assignment';
  words: number;
  density: string | null;
  conceptsPer100Words?: number;
  excerptChars: number;
}

/** Summary of what went into a schedule-generation payload (debug logging). */
export interface SchedulePayloadStats {
  lessons: number;
  assignments: number;
  totalWords: number;
  /** Count per density rating, plus 'none' for lessons without a summary. */
  density: Record<string, number>;
  /** Itemized breakdown of all lessons and assignments included in the payload. */
  items?: SchedulePayloadItem[];
  /** Total characters in the assembled payload. */
  payloadChars?: number;
  /** Estimated tokens in the assembled payload. */
  estimatedTokens?: number;
}

export class CourseService {
  static getCoursesDir(): string {
    return resolveCoursesDir();
  }

  /** Absolute course directory, validated so the id cannot escape the data dir. */
  private static courseDir(courseId: unknown): string {
    return safeJoin(resolveCoursesDir(), normalizeCourseId(courseId));
  }

  static discoverCourseDocs(courseFolder: string): Record<string, boolean> {
    const flags: Record<string, boolean> = {
      summary: false,
      notes: false,
      test: false,
      schedule: false,
      logs: false
    };
    if (!fs.existsSync(courseFolder)) return flags;
    try {
      if (
        fs.existsSync(path.join(courseFolder, 'logs.md')) ||
        fs.existsSync(path.join(courseFolder, 'course.logs.md'))
      ) {
        flags.logs = true;
      }
      const files = fs.readdirSync(courseFolder);
      for (const file of files) {
        const parsed = parseDocFileName(file);
        if (parsed && parsed.isCourseScope) {
          flags[parsed.tab] = true;
        }
      }
    } catch (e) {
      console.warn(`Failed to read files in ${courseFolder}:`, e);
    }
    return flags;
  }

  static listCourses(): CourseManifest[] {
    const coursesDir = this.getCoursesDir();
    if (!fs.existsSync(coursesDir)) return [];

    const dirs = fs
      .readdirSync(coursesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name);

    const manifests: CourseManifest[] = [];

    for (const dirName of dirs) {
      const courseFolder = path.join(coursesDir, dirName);
      const manifestPath = path.join(courseFolder, '.manifest.json');
      if (fs.existsSync(manifestPath)) {
        try {
          const content = fs.readFileSync(manifestPath, 'utf8');
          const manifest: CourseManifest = JSON.parse(content);
          manifest.path = courseFolder;
          manifest.courseDocs = this.discoverCourseDocs(courseFolder) as any;
          if (!manifest.coursePDF && fs.existsSync(safeJoin(courseFolder, 'assets', 'locker_docs', 'course.pdf'))) {
            manifest.coursePDF = true;
          }
          manifests.push(manifest);
        } catch (e) {
          console.error(`Failed to read manifest for ${dirName}:`, e);
        }
      }
    }

    return manifests;
  }

  static getCourse(courseId: string): CourseManifest | null {
    const courseFolder = this.courseDir(courseId);
    const manifestPath = safeJoin(courseFolder, '.manifest.json');
    if (!fs.existsSync(manifestPath)) return null;

    try {
      const content = fs.readFileSync(manifestPath, 'utf8');
      const manifest: CourseManifest = JSON.parse(content);
      manifest.path = courseFolder;
      manifest.courseDocs = this.discoverCourseDocs(courseFolder) as any;
      if (!manifest.coursePDF && fs.existsSync(safeJoin(courseFolder, 'assets', 'locker_docs', 'course.pdf'))) {
        manifest.coursePDF = true;
      }
      return manifest;
    } catch {
      return null;
    }
  }

  static getManifest(courseId: string): CourseManifest | null {
    return this.getCourse(courseId);
  }

  /**
   * Patch editable .manifest.json fields (title, description, archived). Only the
   * provided fields are touched; the rest of the manifest is preserved
   * verbatim. Unarchiving deletes the flag entirely so active manifests stay
   * clean. Returns the updated manifest, or null when the course or its
   * .manifest.json cannot be read.
   */
  static updateCourseMeta(
    courseId: string,
    patch: Partial<Pick<CourseManifest, 'title' | 'description' | 'archived' | 'coursePDF' | 'group'>>
  ): CourseManifest | null {
    const courseFolder = this.courseDir(courseId);
    const manifestPath = safeJoin(courseFolder, '.manifest.json');
    if (!fs.existsSync(manifestPath)) return null;

    try {
      const manifest: CourseManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (patch.title !== undefined) manifest.title = patch.title;
      if (patch.description !== undefined) manifest.description = patch.description;
      if (patch.archived !== undefined) {
        if (patch.archived) {
          manifest.archived = true;
        } else {
          delete manifest.archived;
        }
      }
      if (patch.coursePDF !== undefined) {
        if (patch.coursePDF) {
          manifest.coursePDF = true;
        } else {
          delete manifest.coursePDF;
        }
      }
      if (patch.group !== undefined) {
        if (patch.group && patch.group.trim()) {
          manifest.group = patch.group.trim();
        } else {
          delete manifest.group;
        }
      }
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
      return manifest;
    } catch (e) {
      console.error(`Failed to update .manifest.json for ${courseId}:`, e);
      return null;
    }
  }

  static getLessonContent(courseId: string, lessonId: string): LessonContentBundle | null {
    const lesson = assertLessonId(lessonId);
    const courseDir = this.courseDir(courseId);
    if (!fs.existsSync(courseDir)) return null;

    // 1. Detect primary format (HTML > PDF > markdown)
    const htmlPath = safeJoin(courseDir, `${lesson}.lesson.html`);
    const pdfPath = safeJoin(courseDir, `${lesson}.lesson.pdf`);
    const mdPath = safeJoin(courseDir, `${lesson}.lesson.md`);
    const companionPath = safeJoin(courseDir, `${lesson}.lesson.companion.md`);

    const format: 'markdown' | 'html' | 'pdf' | 'video' =
      fs.existsSync(htmlPath) ? 'html' :
      fs.existsSync(pdfPath)  ? 'pdf'  : 'markdown';

    // 2. Load companion or lesson markdown
    const readSafe = (p: string): string =>
      fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';

    const lessonContent = format !== 'markdown' ? readSafe(companionPath) : readSafe(mdPath);
    const hasCompanion = format !== 'markdown' &&
      fs.existsSync(companionPath) &&
      readSafe(companionPath).trim().length > 0;

    // 3. Collect other tab files
    // tabFileRegex: matches `${lesson}.${slug}.md`.
    // Does NOT match `${lesson}.lesson.companion.md` (dot in middle segment) → companion excluded naturally
    const escaped = lesson.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const tabFileRegex = new RegExp(`^${escaped}\\.([a-z0-9_]+)\\.md$`, 'i');

    const tabs: Record<string, string> = {};
    for (const f of fs.readdirSync(courseDir)) {
      const match = f.match(tabFileRegex);
      if (!match) continue;
      const slug = match[1].toLowerCase();
      if (slug === 'lesson') continue; // surfaced separately as bundle.lesson
      tabs[slug] = fs.readFileSync(safeJoin(courseDir, f), 'utf8');
    }

    return {
      courseId,
      lessonId: lesson,
      lesson: lessonContent,
      tabs,
      format,
      hasCompanion
    };
  }

  static getLessonBundle(courseId: string, lessonId: string): LessonContentBundle | null {
    return this.getLessonContent(courseId, lessonId);
  }

  /**
   * Strips pictures and inaccessible links from lesson markdown before LLM processing.
   */
  static stripLessonMedia(content: string | null | undefined): string {
    return stripLessonMedia(content);
  }

  /**
   * True when the lesson tab file exists with real generated content — more
   * than a stub and not a "Not yet generated" placeholder. Used by the
   * queue's missing-scan, which must not regenerate present tabs.
   */
  static hasLessonTabContent(
    courseId: string,
    lessonId: string,
    tab: string
  ): boolean {
    const courseDir = this.courseDir(courseId);
    if (!fs.existsSync(courseDir)) return false;

    const effectiveTab = tab === 'studysheet' ? 'notes' : tab;

    if (effectiveTab === 'lesson') {
      const htmlPath = safeJoin(courseDir, `${lessonId}.lesson.html`);
      const pdfPath = safeJoin(courseDir, `${lessonId}.lesson.pdf`);
      const compPath = safeJoin(courseDir, `${lessonId}.lesson.companion.md`);
      const mdPath = safeJoin(courseDir, `${lessonId}.lesson.md`);
      if (fs.existsSync(htmlPath) || fs.existsSync(pdfPath)) {
        if (fs.existsSync(compPath)) {
          try {
            const content = fs.readFileSync(compPath, 'utf8');
            return content.length > 50;
          } catch {}
        }
        return true;
      }
      if (fs.existsSync(mdPath)) {
        try {
          const content = fs.readFileSync(mdPath, 'utf8');
          return content.length > 50;
        } catch {}
      }
      return false;
    }

    const filePath = safeJoin(courseDir, tabFileName(lessonId, effectiveTab));
    if (!fs.existsSync(filePath)) return false;
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      return content.length > 250 && !content.includes('Not yet generated');
    } catch {}
    return false;
  }

  static saveLessonTab(
    courseId: string,
    lessonId: string,
    tab: string,
    content: string
  ): { success: boolean; filename: string } {
    const courseDir = this.courseDir(courseId);
    if (!fs.existsSync(courseDir)) {
      return { success: false, filename: '' };
    }

    let filename: string;
    if (tab === 'lesson') {
      const htmlPath = safeJoin(courseDir, `${lessonId}.lesson.html`);
      const pdfPath = safeJoin(courseDir, `${lessonId}.lesson.pdf`);
      filename = (fs.existsSync(htmlPath) || fs.existsSync(pdfPath))
        ? `${lessonId}.lesson.companion.md`
        : tabFileName(lessonId, tab);
    } else {
      filename = tabFileName(lessonId, tab);
    }

    const filePath = safeJoin(courseDir, filename);

    try {
      fs.writeFileSync(filePath, content, 'utf8');
      return { success: true, filename };
    } catch (e) {
      console.error(`Failed to save ${filename}:`, e);
      return { success: false, filename };
    }
  }

  /** Removes the lesson tab file. Returns false when it didn't exist. */
  static deleteLessonTab(courseId: string, lessonId: string, tab: string): boolean {
    const courseDir = this.courseDir(courseId);
    const filePath = safeJoin(courseDir, tabFileName(lessonId, tab));
    if (!fs.existsSync(filePath)) return false;
    try {
      fs.unlinkSync(filePath);
      return true;
    } catch (e) {
      console.error(`Failed to delete ${filePath}:`, e);
      return false;
    }
  }

  static resolveAssetPath(courseId: string, subPath: string): string | null {
    const coursesDir = resolveCoursesDir();
    const courseDir = safeJoin(coursesDir, normalizeCourseId(courseId));
    if (!fs.existsSync(courseDir)) return null;

    // 1. Direct match: courses/:id/assets/:subPath
    let fullPath = trySafeJoin(courseDir, 'assets', subPath);
    if (fullPath && fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      return fullPath;
    }

    // 2. Direct match under courseDir root (e.g. dependencies/:file)
    fullPath = trySafeJoin(courseDir, subPath);
    if (fullPath && fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
      return fullPath;
    }

    const filename = path.basename(subPath);

    // 3. Category search under assets/ (css, img, icons, locker_docs, fonts, dependencies)
    const candidateDirs = ['css', 'img', 'icons', 'locker_docs', 'fonts', 'dependencies'];
    for (const cat of candidateDirs) {
      const candidate = trySafeJoin(courseDir, 'assets', cat, filename);
      if (candidate && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return candidate;
      }
    }

    // 4. Fallback search directly in assets/
    const inAssets = trySafeJoin(courseDir, 'assets', filename);
    if (inAssets && fs.existsSync(inAssets) && fs.statSync(inAssets).isFile()) {
      return inAssets;
    }

    // 5. Alternate image extensions (e.g. .png requested but optimized to .jpg, or vice-versa)
    const ext = path.extname(filename).toLowerCase();
    const stem = path.basename(filename, ext);
    const RASTER_EXTS = ['.png', '.jpg', '.jpeg', '.webp'];
    if (RASTER_EXTS.includes(ext)) {
      for (const altExt of RASTER_EXTS) {
        if (altExt === ext) continue;
        const altFile = `${stem}${altExt}`;
        for (const cat of candidateDirs) {
          const candidate = trySafeJoin(courseDir, 'assets', cat, altFile);
          if (candidate && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
            return candidate;
          }
        }
        const inAssetsAlt = trySafeJoin(courseDir, 'assets', altFile);
        if (inAssetsAlt && fs.existsSync(inAssetsAlt) && fs.statSync(inAssetsAlt).isFile()) {
          return inAssetsAlt;
        }
      }
    }

    // 6. Self-heal from _backup/*.zip if the asset was packaged inside the archive
    const backupDir = safeJoin(courseDir, '_backup');
    if (fs.existsSync(backupDir)) {
      try {
        const zips = fs.readdirSync(backupDir).filter((f) => f.endsWith('.zip'));
        for (const zipName of zips) {
          const zipPath = safeJoin(backupDir, zipName);
          const entries = unzipSync(new Uint8Array(fs.readFileSync(zipPath)));
          for (const [entryName, data] of Object.entries(entries)) {
            if (path.basename(entryName).toLowerCase() === filename.toLowerCase()) {
              const isLocker = entryName.toLowerCase().includes('locker_docs');
              const targetDir = isLocker
                ? safeJoin(courseDir, 'assets', 'locker_docs')
                : safeJoin(courseDir, 'assets', 'img');
              if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
              const extractedPath = safeJoin(targetDir, filename);
              fs.writeFileSync(extractedPath, Buffer.from(data));
              return extractedPath;
            }
          }
        }
      } catch {}
    }

    return null;
  }

  static listLockerDocs(courseId: string): LockerDocItem[] {
    const courseDir = this.courseDir(courseId);
    const lockerDir = safeJoin(courseDir, 'assets', 'locker_docs');
    if (!fs.existsSync(lockerDir)) return [];

    try {
      const files = fs.readdirSync(lockerDir);
      return files
        .filter((f) => !f.startsWith('.') && !f.endsWith('.companion.md'))
        .map((f) => {
          const filePath = safeJoin(lockerDir, f);
          const stat = fs.statSync(filePath);
          const ext = path.extname(f).replace(/^\./, '').toLowerCase();
          return {
            filename: f,
            size: stat.size,
            updatedAt: stat.mtime.toISOString(),
            url: `/api/courses/${courseId}/assets/locker_docs/${encodeURIComponent(f)}`,
            ext
          };
        })
        .sort((a, b) => a.filename.localeCompare(b.filename));
    } catch (err) {
      console.error(`Failed to list locker docs for ${courseId}:`, err);
      return [];
    }
  }

  static getLockerDocCompanion(courseId: string, filename: string): string | null {
    const courseDir = this.courseDir(courseId);
    const safeName = path.basename(filename);
    const companionPath = safeJoin(courseDir, 'assets', 'locker_docs', `${safeName}.companion.md`);
    if (fs.existsSync(companionPath)) {
      try {
        return fs.readFileSync(companionPath, 'utf8');
      } catch {}
    }
    return null;
  }

  static saveLockerDoc(courseId: string, filename: string, buffer: Buffer): LockerDocItem {
    const courseDir = this.courseDir(courseId);
    const lockerDir = safeJoin(courseDir, 'assets', 'locker_docs');
    if (!fs.existsSync(lockerDir)) {
      fs.mkdirSync(lockerDir, { recursive: true });
    }
    const safeName = path.basename(filename);
    const dest = safeJoin(lockerDir, safeName);
    fs.writeFileSync(dest, buffer);
    if (safeName.toLowerCase() === 'course.pdf') {
      try {
        this.updateCourseMeta(courseId, { coursePDF: true });
      } catch (err) {
        console.warn(`Failed to update coursePDF in .manifest.json for ${courseId}:`, err);
      }
    }
    if (safeName.toLowerCase().endsWith('.pdf')) {
      const companionPath = `${dest}.companion.md`;
      if (!fs.existsSync(companionPath)) {
        extractTextFromPdf(buffer)
          .then((md) => {
            if (md) {
              fs.writeFileSync(companionPath, md, 'utf-8');
            }
          })
          .catch((err) => {
            console.warn(`Failed to generate companion markdown for locker doc ${safeName}:`, err);
          });
      }
    }
    const ext = path.extname(safeName).replace(/^\./, '').toLowerCase();
    return {
      filename: safeName,
      size: buffer.length,
      updatedAt: new Date().toISOString(),
      url: `/api/courses/${courseId}/assets/locker_docs/${encodeURIComponent(safeName)}`,
      ext
    };
  }

  static deleteLockerDoc(courseId: string, filename: string): boolean {
    const courseDir = this.courseDir(courseId);
    const lockerDir = safeJoin(courseDir, 'assets', 'locker_docs');
    const safeName = path.basename(filename);
    const dest = safeJoin(lockerDir, safeName);
    if (fs.existsSync(dest)) {
      try {
        fs.unlinkSync(dest);
        const companionPath = `${dest}.companion.md`;
        if (fs.existsSync(companionPath)) {
          try {
            fs.unlinkSync(companionPath);
          } catch {}
        }
        if (safeName.toLowerCase() === 'course.pdf') {
          try {
            this.updateCourseMeta(courseId, { coursePDF: false });
          } catch (err) {
            console.warn(`Failed to clear coursePDF in .manifest.json for ${courseId}:`, err);
          }
        }
        return true;
      } catch (err) {
        console.error(`Failed to delete locker doc ${dest}:`, err);
        return false;
      }
    }
    return false;
  }

  static async extractLockerDocText(filePath: string): Promise<string> {
    if (!fs.existsSync(filePath)) return '';
    const ext = path.extname(filePath).toLowerCase();
    try {
      if (ext === '.pdf') {
        const fileBuf = fs.readFileSync(filePath);
        return await extractTextFromPdf(fileBuf);
      }
      if (ext === '.html' || ext === '.htm') {
        const cheerio = await import('cheerio');
        const html = fs.readFileSync(filePath, 'utf8');
        const $ = cheerio.load(html);
        $('script, style, nav, footer, noscript').remove();
        return $('body').text().trim() || $.text().trim();
      }
      return fs.readFileSync(filePath, 'utf8').trim();
    } catch (err) {
      console.error(`Failed to extract text from locker doc '${filePath}':`, err);
      return '';
    }
  }

  static getLogsPath(courseId: string): string {
    const dir = this.courseDir(courseId);
    const direct = safeJoin(dir, 'logs.md');
    if (fs.existsSync(direct)) return direct;
    const prefixed = safeJoin(dir, 'course.logs.md');
    if (fs.existsSync(prefixed)) return prefixed;
    return direct;
  }

  static getLogs(courseId: string): string | null {
    const filePath = this.getLogsPath(courseId);
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null;
  }

  static recordLog(opts: CourseLogRecordOptions): void {
    try {
      const courseId = normalizeCourseId(opts.courseId);
      const courseFolder = this.courseDir(courseId);
      if (!fs.existsSync(courseFolder)) {
        fs.mkdirSync(courseFolder, { recursive: true });
      }

      const filePath = safeJoin(courseFolder, 'logs.md');
      const dateStr = formatLogDate(opts.date || new Date());
      const logType = (opts.type || 'llm').trim();
      const coursePrefix = opts.courseId.trim().toUpperCase();
      const rawLesson = opts.lessonDoc.trim();
      const lessonWithPrefix = rawLesson.startsWith(coursePrefix + ':')
        ? rawLesson
        : `${coursePrefix}: ${rawLesson}`;
      const charStr = opts.chars !== undefined ? ` (${Math.round(opts.chars)} chars)` : '';
      const lessonCol = `${lessonWithPrefix}${charStr}`;
      const tokensCol = opts.tokens !== undefined && opts.tokens !== null ? Math.round(opts.tokens) : '-';
      const row = `| ${dateStr} | ${logType} | ${lessonCol} | ${tokensCol} |\n`;

      if (!fs.existsSync(filePath)) {
        const initial = `# Course Logs\n\n| Date | Type | Lesson | Tokens |\n| :--- | :--- | :--- | :--- |\n${row}`;
        fs.writeFileSync(filePath, initial, 'utf8');
      } else {
        const content = fs.readFileSync(filePath, 'utf8');
        let updated = content;
        if (!/\|\s*Date\s*\|\s*Type\s*\|\s*Lesson\s*\|\s*Tokens\s*\|/i.test(content)) {
          updated = (content.trim() ? content.trim() + '\n\n' : '') + `| Date | Type | Lesson | Tokens |\n| :--- | :--- | :--- | :--- |\n`;
        }
        if (!updated.endsWith('\n')) {
          updated += '\n';
        }
        fs.writeFileSync(filePath, updated + row, 'utf8');
      }
    } catch (err) {
      console.warn(`[CourseService] Failed to record log for ${opts.courseId}:`, err);
    }
  }

  static getCourseDocumentPath(courseId: string, type: string): string {
    const clean = type.toLowerCase();
    if (clean === 'logs') {
      return this.getLogsPath(courseId);
    }
    return safeJoin(this.courseDir(courseId), courseDocFileName(type));
  }

  static getCourseDocument(courseId: string, type: string): string | null {
    const clean = type.toLowerCase();
    if (clean === 'logs') {
      const existing = this.getLogs(courseId);
      if (existing !== null) return existing;
      return `# Course Logs\n\n| Date | Type | Lesson | Tokens |\n| :--- | :--- | :--- | :--- |\n`;
    }
    const filePath = this.getCourseDocumentPath(courseId, type);
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null;
  }

  static hasCourseDocument(courseId: string, type: string): boolean {
    const clean = type.toLowerCase();
    if (clean === 'logs') {
      return fs.existsSync(this.getLogsPath(courseId));
    }
    const filePath = this.getCourseDocumentPath(courseId, type);
    return fs.existsSync(filePath);
  }

  static saveCourseDocument(courseId: string, type: string, content: string): boolean {
    const courseDir = this.courseDir(courseId);
    if (!fs.existsSync(courseDir)) {
      fs.mkdirSync(courseDir, { recursive: true });
    }
    const filePath = this.getCourseDocumentPath(courseId, type);
    try {
      fs.writeFileSync(filePath, content, 'utf8');
      return true;
    } catch (e) {
      console.error(`Failed to save ${filePath}:`, e);
      return false;
    }
  }

  static getCheckpointsPath(courseId: string): string {
    return safeJoin(this.courseDir(courseId), '.checkpoints.json');
  }

  static getCheckpoints(courseId: string): Checkpoint[] {
    const filePath = this.getCheckpointsPath(courseId);
    if (!fs.existsSync(filePath)) return [];
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      const normalized: Checkpoint[] = [];
      for (const item of parsed) {
        const cp = normalizeCheckpointRecord(item);
        if (cp) normalized.push(cp);
      }
      return normalized;
    } catch (e) {
      console.warn(`Failed to read checkpoints from ${filePath}:`, e);
      return [];
    }
  }

  static saveCheckpoints(courseId: string, checkpoints: Checkpoint[]): boolean {
    const courseDir = this.courseDir(courseId);
    if (!fs.existsSync(courseDir)) {
      fs.mkdirSync(courseDir, { recursive: true });
    }
    const filePath = safeJoin(courseDir, '.checkpoints.json');
    try {
      const content = JSON.stringify(checkpoints, null, 2);
      fs.writeFileSync(filePath, content, 'utf8');
      return true;
    } catch (e) {
      console.error(`Failed to save checkpoints to ${filePath}:`, e);
      return false;
    }
  }

  // ── Free-hand markup annotations (.annotations.json per course) ───────────

  static getAnnotationsPath(courseId: string): string {
    return safeJoin(this.courseDir(courseId), '.annotations.json');
  }

  static getAnnotations(courseId: string): MarkupStroke[] {
    const filePath = this.getAnnotationsPath(courseId);
    if (!fs.existsSync(filePath)) return [];
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isMarkupStroke);
    } catch (e) {
      console.warn(`Failed to read annotations from ${filePath}:`, e);
      return [];
    }
  }

  static saveAnnotations(courseId: string, strokes: MarkupStroke[]): boolean {
    const courseDir = this.courseDir(courseId);
    if (!fs.existsSync(courseDir)) {
      fs.mkdirSync(courseDir, { recursive: true });
    }
    const filePath = this.getAnnotationsPath(courseId);
    try {
      fs.writeFileSync(filePath, JSON.stringify(strokes, null, 2), 'utf8');
      return true;
    } catch (e) {
      console.error(`Failed to save annotations to ${filePath}:`, e);
      return false;
    }
  }

  /**
   * Merges upserts into the stored strokes (by id, last-write-wins on date).
   * Tombstones are retained so erases/undos survive device sync merges.
   */
  static mergeAnnotations(courseId: string, upserts: MarkupStroke[]): { strokes: MarkupStroke[]; merged: number } {
    const existing = this.getAnnotations(courseId);
    const byId = new Map(existing.map((s) => [s.id, s]));
    let merged = 0;
    for (const up of upserts) {
      if (!isMarkupStroke(up)) continue;
      const cur = byId.get(up.id);
      if (!cur || new Date(up.date).getTime() >= new Date(cur.date).getTime()) {
        byId.set(up.id, up);
        merged++;
      }
    }
    const strokes = Array.from(byId.values());
    this.saveAnnotations(courseId, strokes);
    return { strokes, merged };
  }

  static recordPositionCheckpoint(courseId: string, file: string, verticalPosition: number): Checkpoint {
    const checkpoints = this.getCheckpoints(courseId);
    const now = new Date().toISOString();
    const pos = Math.max(0, Math.floor(verticalPosition));
    const cleanFile = file.trim();

    const existingIdx = checkpoints.findIndex((c) => c.type === 'position' && c.file === cleanFile);
    if (existingIdx !== -1) {
      checkpoints[existingIdx] = {
        ...checkpoints[existingIdx],
        verticalPosition: pos,
        date: now
      };
      this.saveCheckpoints(courseId, checkpoints);
      return checkpoints[existingIdx];
    }

    const newCp: Checkpoint = {
      id: `cp_pos_${Math.random().toString(36).slice(2, 10)}`,
      file: cleanFile,
      verticalPosition: pos,
      type: 'position',
      date: now
    };
    checkpoints.push(newCp);
    this.saveCheckpoints(courseId, checkpoints);
    return newCp;
  }

  static addOrUpdateNoteCheckpoint(
    courseId: string,
    note: {
      id?: string;
      file: string;
      verticalPosition: number;
      type?: string;
      color?: string;
      noteText?: string;
      anchor?: Record<string, unknown>;
      selection?: Record<string, unknown>;
      aiQuestion?: string;
      aiAnswer?: string;
      aiStatus?: string;
    }
  ): Checkpoint {
    const checkpoints = this.getCheckpoints(courseId);
    const now = new Date().toISOString();
    const pos = Math.max(0, Math.floor(note.verticalPosition));
    const cleanFile = note.file.trim();
    const type: CheckpointType = isCheckpointType(note.type) ? note.type : 'note';
    const aiStatus = normalizeAiStatus(note.aiStatus);
    const anchor = note.anchor !== undefined ? (note.anchor as unknown as Anchor) : undefined;
    const selection = note.selection !== undefined ? (note.selection as unknown as SelectionRange) : undefined;

    if (note.id) {
      const idx = checkpoints.findIndex((c) => c.id === note.id);
      if (idx !== -1) {
        checkpoints[idx] = {
          ...checkpoints[idx],
          file: cleanFile,
          verticalPosition: pos,
          type: note.type === undefined ? checkpoints[idx].type : type,
          color: note.color || checkpoints[idx].color || 'yellow',
          noteText: note.noteText ?? checkpoints[idx].noteText ?? '',
          date: now,
          ...(anchor !== undefined && { anchor }),
          ...(selection !== undefined && { selection }),
          ...(note.aiQuestion !== undefined && { aiQuestion: note.aiQuestion }),
          ...(note.aiAnswer !== undefined && { aiAnswer: note.aiAnswer }),
          ...(aiStatus !== undefined && { aiStatus })
        };
        this.saveCheckpoints(courseId, checkpoints);
        return checkpoints[idx];
      }
    }

    const newCp: Checkpoint = {
      id: note.id || `cp_note_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      file: cleanFile,
      verticalPosition: pos,
      type,
      color: note.color || 'yellow',
      noteText: note.noteText || '',
      date: now,
      ...(anchor !== undefined && { anchor }),
      ...(selection !== undefined && { selection }),
      ...(note.aiQuestion !== undefined && { aiQuestion: note.aiQuestion }),
      ...(note.aiAnswer !== undefined && { aiAnswer: note.aiAnswer }),
      ...(aiStatus !== undefined && { aiStatus })
    };
    checkpoints.push(newCp);
    this.saveCheckpoints(courseId, checkpoints);
    return newCp;
  }

  static patchCheckpoint(
    courseId: string,
    id: string,
    patch: { aiAnswer?: string; aiStatus?: string; noteText?: string }
  ): Checkpoint | null {
    const checkpoints = this.getCheckpoints(courseId);
    const idx = checkpoints.findIndex((c) => c.id === id);
    if (idx === -1) return null;
    const { aiStatus, ...rest } = patch;
    const normalizedStatus = normalizeAiStatus(aiStatus);
    checkpoints[idx] = {
      ...checkpoints[idx],
      ...rest,
      ...(normalizedStatus !== undefined && { aiStatus: normalizedStatus }),
      date: new Date().toISOString()
    };
    this.saveCheckpoints(courseId, checkpoints);
    return checkpoints[idx];
  }

  static deleteCheckpoint(courseId: string, checkpointId: string): boolean {
    const checkpoints = this.getCheckpoints(courseId);
    const filtered = checkpoints.filter((c) => c.id !== checkpointId);
    if (filtered.length !== checkpoints.length) {
      this.saveCheckpoints(courseId, filtered);
      return true;
    }
    return false;
  }

  static listAllNoteCheckpoints(): Array<Checkpoint & { courseId: string; courseTitle: string }> {
    const courses = this.listCourses().filter((c) => !c.archived);
    const allNotes: Array<Checkpoint & { courseId: string; courseTitle: string }> = [];

    for (const course of courses) {
      const cps = this.getCheckpoints(course.id);
      for (const cp of cps) {
        if (cp.type === 'note' || cp.type === 'highlight' || cp.type === 'ai') {
          allNotes.push({
            ...cp,
            courseId: course.id,
            courseTitle: course.title
          });
        }
      }
    }

    return allNotes.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  }

  static listAllCheckpoints(): Array<Checkpoint & { courseId: string; courseTitle: string }> {
    const courses = this.listCourses().filter((c) => !c.archived);
    const all: Array<Checkpoint & { courseId: string; courseTitle: string }> = [];

    for (const course of courses) {
      const cps = this.getCheckpoints(course.id);
      for (const cp of cps) {
        if (cp.type === 'note' || cp.type === 'highlight' || cp.type === 'ai') {
          all.push({
            ...cp,
            courseId: course.id,
            courseTitle: course.title
          });
        }
      }
      const annotations = this.getAnnotations(course.id);
      if (annotations.length > 0) {
        const markupCps = derivePdfMarkupCheckpoints(course.id, course.title, annotations);
        all.push(...markupCps);
      }
    }

    return all.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  }

  static gatherLessonFiles(
    courseId: string,
    type: 'lesson' | 'summary' | 'notes' | 'studysheet' | 'test'
  ): Array<{ unitNumber: number; unitTitle: string; lessonId: string; lessonTitle: string; content: string }> {
    const course = this.getCourse(courseId);
    const courseDir = this.courseDir(courseId);
    if (!course || !fs.existsSync(courseDir)) return [];

    const results: Array<{
      unitNumber: number;
      unitTitle: string;
      lessonId: string;
      lessonTitle: string;
      content: string;
    }> = [];

    const effectiveType = type === 'studysheet' ? 'notes' : type;
    for (const unit of course.units) {
      for (const lesson of unit.lessons) {
        const filePath = safeJoin(courseDir, tabFileName(lesson.id, effectiveType));
        const content = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';

        results.push({
          unitNumber: unit.number,
          unitTitle: unit.title,
          lessonId: lesson.id,
          lessonTitle: lesson.title,
          content
        });
      }
    }

    return results;
  }

  static buildAggregatedNotes(courseId: string): string {
    const course = this.getCourse(courseId);
    if (!course) return '';

    const lines: string[] = [];
    lines.push(`# ${course.id.toUpperCase()}: ${course.title}\n\n`);
    if (course.description) {
      lines.push(`> ${course.description}\n\n`);
    }

    const items = this.gatherLessonFiles(courseId, 'lesson');
    let currentUnit = -1;

    for (const item of items) {
      if (!item.content || item.content.trim().length === 0) continue;

      const parsed = parseFrontmatter(item.content);
      const cleanBody = stripLessonMedia((parsed.body || item.content).trim());
      if (!cleanBody) continue;

      if (item.unitNumber !== currentUnit) {
        currentUnit = item.unitNumber;
        lines.push(`\n\n---\n\n# Unit ${item.unitNumber}: ${item.unitTitle}\n\n`);
      }
      lines.push(`## Lesson ${item.lessonId}: ${item.lessonTitle}\n\n`);
      lines.push(cleanBody);
      lines.push('\n\n---\n\n');
    }

    return lines.join('');
  }

  /**
   * Resolves the actual context content to be supplied alongside a prompt,
   * based on the contextAttachment string (e.g. "lesson - lessons", "unit - lessons", etc.)
   */
  static async getPromptContext(
    courseId: string,
    attachment: string,
    lessonId?: string
  ): Promise<string> {
    const course = this.getCourse(courseId);
    const courseDir = this.courseDir(courseId);
    if (!course || !fs.existsSync(courseDir)) return '';

    const norm = attachment.toLowerCase().trim();

    // Check for locker document attachment (e.g. "locker - clu3m_01.03.102.pdf" or "locker:doc.pdf")
    if (norm.startsWith('locker - ') || norm.startsWith('locker:')) {
      const docName = attachment.replace(/^locker\s*[-:]\s*/i, '').trim();
      const lockerDir = safeJoin(courseDir, 'assets', 'locker_docs');
      const safeName = path.basename(docName);
      const filePath = safeJoin(lockerDir, safeName);
      return this.extractLockerDocText(filePath);
    }

    if (norm === 'lesson - lessons' && lessonId) {
      const bundle = this.getLessonContent(courseId, lessonId);
      return bundle?.lesson ? this.cleanLessonText(bundle.lesson) : '';
    }

    if (norm === 'lesson - summaries' && lessonId) {
      return this.readCuratedContent(courseDir, lessonId, 'summary') || '';
    }

    if ((norm === 'lesson - notes' || norm === 'lesson - studysheets') && lessonId) {
      return this.readCuratedContent(courseDir, lessonId, 'notes') || '';
    }

    if (norm === 'unit - lessons') {
      let targetUnit = course.units[0];
      const unitNum = lessonId ? parseUnitNumber(lessonId) : null;
      if (unitNum !== null) {
        const found = course.units.find((u) => u.number === unitNum);
        if (found) targetUnit = found;
      } else if (lessonId) {
        const found = course.units.find((u) => u.lessons.some((l) => l.id === lessonId));
        if (found) targetUnit = found;
      }
      if (!targetUnit) return '';

      const parts: string[] = [];
      for (const l of targetUnit.lessons) {
        const bundle = this.getLessonContent(courseId, l.id);
        if (bundle?.lesson) {
          const clean = this.cleanLessonText(bundle.lesson);
          if (clean.length > 0) {
            parts.push(`## Lesson ${l.id} - ${l.title}\n\n${clean}`);
          }
        }
      }
      return parts.join('\n\n');
    }

    if (norm === 'unit - summaries') {
      let targetUnit = course.units[0];
      const unitNum = lessonId ? parseUnitNumber(lessonId) : null;
      if (unitNum !== null) {
        const found = course.units.find((u) => u.number === unitNum);
        if (found) targetUnit = found;
      } else if (lessonId) {
        const found = course.units.find((u) => u.lessons.some((l) => l.id === lessonId));
        if (found) targetUnit = found;
      }
      if (!targetUnit) return '';

      const parts: string[] = [];
      for (const l of targetUnit.lessons) {
        const summary = this.readCuratedContent(courseDir, l.id, 'summary');
        if (summary && summary.trim()) {
          parts.push(`## Lesson ${l.id} - ${l.title}\n\n${summary.trim()}`);
        }
      }
      return parts.join('\n\n');
    }

    if (norm === 'unit - notes' || norm === 'unit - studysheets') {
      let targetUnit = course.units[0];
      const unitNum = lessonId ? parseUnitNumber(lessonId) : null;
      if (unitNum !== null) {
        const found = course.units.find((u) => u.number === unitNum);
        if (found) targetUnit = found;
      } else if (lessonId) {
        const found = course.units.find((u) => u.lessons.some((l) => l.id === lessonId));
        if (found) targetUnit = found;
      }
      if (!targetUnit) return '';

      const parts: string[] = [];
      for (const l of targetUnit.lessons) {
        const cs = this.readCuratedContent(courseDir, l.id, 'notes');
        if (cs && cs.trim()) {
          parts.push(`## Lesson ${l.id} - ${l.title}\n\n${cs.trim()}`);
        }
      }
      return parts.join('\n\n');
    }

    if (norm === 'course - lessons') {
      const parts: string[] = [];
      for (const u of course.units) {
        for (const l of u.lessons) {
          const bundle = this.getLessonContent(courseId, l.id);
          if (bundle?.lesson) {
            const clean = this.cleanLessonText(bundle.lesson);
            if (clean.length > 0) {
              parts.push(`## Lesson ${l.id} - ${l.title}\n\n${clean}`);
            }
          }
        }
      }
      return parts.join('\n\n');
    }

    if (norm === 'course - summaries') {
      const parts: string[] = [];
      for (const u of course.units) {
        for (const l of u.lessons) {
          const summary = this.readCuratedContent(courseDir, l.id, 'summary');
          if (summary && summary.trim()) {
            parts.push(`## Lesson ${l.id} - ${l.title}\n\n${summary.trim()}`);
          }
        }
      }
      return parts.join('\n\n');
    }

    if (norm === 'course - notes' || norm === 'course - studysheets') {
      const parts: string[] = [];
      for (const u of course.units) {
        for (const l of u.lessons) {
          const cs = this.readCuratedContent(courseDir, l.id, 'notes');
          if (cs && cs.trim()) {
            parts.push(`## Lesson ${l.id} - ${l.title}\n\n${cs.trim()}`);
          }
        }
      }
      return parts.join('\n\n');
    }

    return '';
  }

  /**
   * Strips YAML frontmatter and inaccessible media from raw lesson files.
   */
  private static cleanLessonText(raw: string | null | undefined): string {
    if (!raw) return '';
    const body = parseFrontmatter(raw).body;
    return stripLessonMedia(body).trim();
  }

  /**
   * Body of the lesson's curated tab file (summary/notes/test), skipping
   * "Not yet generated" stubs. Null when the file is absent or a stub.
   */
  private static readCuratedContent(
    courseDir: string,
    lessonId: string,
    docType: 'summary' | 'notes' | 'studysheet' | 'test'
  ): string | null {
    const effectiveType = docType === 'studysheet' ? 'notes' : docType;
    const filePath = safeJoin(courseDir, tabFileName(lessonId, effectiveType));
    if (!fs.existsSync(filePath)) {
      return null;
    }
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      if (raw.includes('Not yet generated') && raw.length < 200) {
        return null;
      }
      const parsed = parseFrontmatter(raw);
      const body = stripLessonMedia((parsed.body || raw).trim());
      return body.length > 0 ? body : null;
    } catch (e) {
      console.warn(`Failed to read curated file ${filePath}:`, e);
      return null;
    }
  }

  private static extractTestQuestionPrompts(testBody: string): string[] {
    const questionsPart = testBody.split(/##\s*Answers/i)[0] || testBody;
    const lines = questionsPart.split('\n');
    const questions: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (/^\d+[\).]\s+/.test(trimmed) && !trimmed.toLowerCase().startsWith('##')) {
        questions.push(trimmed);
      }
    }

    if (questions.length > 0) {
      return questions.slice(0, 10);
    }

    const qSectionMatch = questionsPart.match(/##\s*Questions\s*([\s\S]*)/i);
    if (qSectionMatch && qSectionMatch[1].trim()) {
      const fallbackLines = qSectionMatch[1]
        .split('\n')
        .map((l) => l.trim())
        .filter(
          (l) =>
            l &&
            !l.startsWith('- [ ]') &&
            !l.startsWith('- [x]') &&
            l !== '--' &&
            !l.startsWith('<') &&
            !l.startsWith('##')
        )
        .slice(0, 8);
      return fallbackLines;
    }

    return [];
  }

  private static budgetLessonContent(text: string, maxChars = 4500): string {
    let clean = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    if (clean.length > maxChars) {
      const cutoff = clean.lastIndexOf('\n', maxChars);
      if (cutoff > maxChars * 0.7) {
        clean = clean.slice(0, cutoff).trim() + '\n\n*(Content trimmed for length)*';
      } else {
        clean = clean.slice(0, maxChars).trim() + '\n\n*(Content trimmed for length)*';
      }
    }
    return clean;
  }

  static buildAggregatedPayload(courseId: string, type: 'summary' | 'notes' | 'studysheet' | 'test'): string {
    const course = this.getCourse(courseId);
    const courseDir = this.courseDir(courseId);
    if (!course || !fs.existsSync(courseDir)) return '';

    const lines: string[] = [];
    lines.push(`# Course: ${course.id.toUpperCase()} — ${course.title}\n\n`);
    if (course.description) {
      lines.push(`> ${course.description}\n\n`);
    }

    let currentUnit = -1;
    let curatedCount = 0;

    for (const unit of course.units) {
      for (const lesson of unit.lessons) {
        let lessonContent = '';

        if (type === 'summary') {
          const body =
            this.readCuratedContent(courseDir, lesson.id, 'summary') ??
            this.readCuratedContent(courseDir, lesson.id, 'notes');
          if (body) {
            lessonContent = this.budgetLessonContent(body, 3000);
          }
        } else if (type === 'notes' || (type as string) === 'studysheet') {
          const body =
            this.readCuratedContent(courseDir, lesson.id, 'notes') ??
            this.readCuratedContent(courseDir, lesson.id, 'summary');
          if (body) {
            lessonContent = this.budgetLessonContent(body, 2500);
          }
        } else if (type === 'test') {
          const primaryBody =
            this.readCuratedContent(courseDir, lesson.id, 'summary') ??
            this.readCuratedContent(courseDir, lesson.id, 'notes');
          const testBody = this.readCuratedContent(courseDir, lesson.id, 'test');

          const parts: string[] = [];
          if (primaryBody) {
            parts.push(this.budgetLessonContent(primaryBody, 2200));
          }
          if (testBody) {
            const prompts = this.extractTestQuestionPrompts(testBody);
            if (prompts.length > 0) {
              parts.push(
                `#### Existing Lesson Quiz Coverage:\n${prompts.map((q) => `- ${q}`).join('\n')}`
              );
            } else {
              parts.push(
                `#### Existing Lesson Quiz Context:\n${this.budgetLessonContent(testBody, 1500)}`
              );
            }
          }

          if (parts.length > 0) {
            lessonContent = parts.join('\n\n');
          }
        }

        if (!lessonContent || lessonContent.trim().length === 0) {
          continue;
        }

        curatedCount++;

        if (unit.number !== currentUnit) {
          currentUnit = unit.number;
          lines.push(`\n## Unit ${unit.number}: ${unit.title}\n\n`);
        }
        lines.push(`### Lesson ${lesson.id}: ${lesson.title}\n\n`);
        lines.push(lessonContent);
        lines.push('\n\n');
      }
    }

    if (curatedCount === 0) {
      return '';
    }

    return lines.join('');
  }

  /**
   * Payload for the course-schedule prompt: the COMPLETE unit/lesson
   * inventory (including assignments — the schedule must plan work sessions
   * and submission targets for them) plus per-lesson effort signals —
   * content word count and the information density of the latest curated
   * summary — and budgeted summary excerpts. Inventory lines are always
   * complete; only the excerpts respect the total budget.
   *
   * When `stats` is provided it is filled with a summary of what went into
   * the payload — used by the API for debug logging ( surfaced in the
   * browser console so the user can see exactly what the AI received ).
   */
  static buildSchedulePayload(
    courseId: string,
    stats?: SchedulePayloadStats
  ): string {
    const course = this.getCourse(courseId);
    const courseDir = this.courseDir(courseId);
    if (!course || !fs.existsSync(courseDir)) return '';

    const lines: string[] = [];
    lines.push(`# Course: ${course.id.toUpperCase()} — ${course.title}\n\n`);
    if (course.description) {
      lines.push(`> ${course.description}\n\n`);
    }

    // First pass: per-lesson word counts for the statistics header.
    const allLessons = course.units.flatMap((u) => u.lessons);
    const readLessonText = (lessonId: string): string => {
      const companionFile = safeJoin(courseDir, `${lessonId}.lesson.companion.md`);
      if (fs.existsSync(companionFile)) return fs.readFileSync(companionFile, 'utf8');
      const mdFile = safeJoin(courseDir, tabFileName(lessonId, 'lesson'));
      if (fs.existsSync(mdFile)) return fs.readFileSync(mdFile, 'utf8');
      return '';
    };

    let totalWords = 0;
    for (const lesson of allLessons) {
      const text = readLessonText(lesson.id);
      if (text) {
        totalWords += countWords(text);
      }
    }
    const contentLessons = allLessons.filter((l) => l.type === 'lesson').length;
    const assignments = allLessons.filter((l) => l.type === 'assignment').length;
    lines.push(`## Course Statistics\n`);
    lines.push(`- Content lessons: ${contentLessons} · assignments: ${assignments}`);
    lines.push(
      `- Total lesson content: ${totalWords.toLocaleString()} words (rough pace guide: ~100 words per study minute including practice — adjust using each lesson's density below)`
    );
    lines.push('');

    if (stats) {
      stats.lessons = contentLessons;
      stats.assignments = assignments;
      stats.totalWords = totalWords;
    }

    const items: SchedulePayloadItem[] = [];
    let excerptBudget = 6_000;
    let currentUnit = -1;
    let processedCount = 0;

    for (const unit of course.units) {
      for (const lesson of unit.lessons) {
        processedCount++;
        if (unit.number !== currentUnit) {
          currentUnit = unit.number;
          lines.push(`\n## Unit ${unit.number}: ${unit.title}\n\n`);
        }

        const kind = lesson.type === 'assignment' ? ' (ASSIGNMENT)' : ' (LESSON)';
        lines.push(`### Lesson ${lesson.id}${kind}: ${lesson.title}\n\n`);

        // Effort signals: raw content size + summary information density.
        const lessonText = readLessonText(lesson.id);
        const lessonWords = lessonText ? countWords(lessonText) : 0;
        const summaryBody =
          this.readCuratedContent(courseDir, lesson.id, 'summary') ??
          this.readCuratedContent(courseDir, lesson.id, 'notes');
        const density = summaryBody ? computeSummaryDensity(summaryBody) : null;

        if (density) {
          lines.push(
            `Content: ${lessonWords.toLocaleString()} words · Summary density: ${density.density} ` +
              `(${density.words} summary words, ${density.mathTokens} formula tokens, ` +
              `${density.listItems} list items, ${density.boldTerms} key terms, ${density.headings} headings — ` +
              `${density.conceptsPer100Words} concepts per 100 words)\n\n`
          );
          if (stats) {
            stats.density[density.density] = (stats.density[density.density] || 0) + 1;
          }
        } else {
          lines.push(`Content: ${lessonWords.toLocaleString()} words · Summary: none generated yet\n\n`);
          if (stats) {
            stats.density['none'] = (stats.density['none'] || 0) + 1;
          }
        }

        let excerptChars = 0;
        if (summaryBody && excerptBudget > 0) {
          const remainingLessons = Math.max(1, allLessons.length - processedCount + 1);
          const perLessonMax = Math.max(120, Math.min(250, Math.floor(excerptBudget / remainingLessons)));
          const budgeted = this.budgetLessonContent(summaryBody, Math.min(perLessonMax, excerptBudget));
          excerptBudget -= budgeted.length;
          excerptChars = budgeted.length;
          lines.push(budgeted);
          lines.push('\n\n');
        }

        items.push({
          unitNumber: unit.number,
          unitTitle: unit.title,
          lessonId: lesson.id,
          lessonTitle: lesson.title,
          type: lesson.type,
          words: lessonWords,
          density: density ? density.density : null,
          conceptsPer100Words: density ? density.conceptsPer100Words : undefined,
          excerptChars
        });
      }
    }

    const payloadText = lines.join('');
    if (stats) {
      stats.items = items;
      stats.payloadChars = payloadText.length;
      stats.estimatedTokens = Math.round(payloadText.length / 4);
    }

    return payloadText;
  }

  /**
   * Precomputes word counts, summary information density, and excerpts
   * across all lessons in a course for deterministic schedule planning.
   */
  static computeCourseEfforts(courseId: string): LessonEffort[] {
    const course = this.getCourse(courseId);
    if (!course) return [];

    const courseDir = this.courseDir(courseId);
    if (!fs.existsSync(courseDir)) return [];
    const efforts: LessonEffort[] = [];

    const readLessonText = (lessonId: string): string => {
      const companionFile = safeJoin(courseDir, `${lessonId}.lesson.companion.md`);
      if (fs.existsSync(companionFile)) return fs.readFileSync(companionFile, 'utf8');
      const mdFile = safeJoin(courseDir, tabFileName(lessonId, 'lesson'));
      if (fs.existsSync(mdFile)) return fs.readFileSync(mdFile, 'utf8');
      return '';
    };

    for (const unit of course.units) {
      for (const lesson of unit.lessons) {
        const lessonText = readLessonText(lesson.id);
        const wordCount = lessonText ? countWords(lessonText) : 0;

        const summaryBody =
          this.readCuratedContent(courseDir, lesson.id, 'summary') ??
          this.readCuratedContent(courseDir, lesson.id, 'notes');

        const densityObj = summaryBody ? computeSummaryDensity(summaryBody) : null;
        const summaryDensity: 'low' | 'medium' | 'high' = densityObj?.density || 'medium';

        let excerpt = '';
        if (summaryBody) {
          excerpt = this.budgetLessonContent(summaryBody, 180);
        }

        efforts.push({
          lessonId: lesson.id,
          title: lesson.title,
          type: lesson.type,
          wordCount,
          summaryDensity,
          excerpt
        });
      }
    }

    return efforts;
  }

  /**
   * Builds the compact JSON-oriented payload for LLM enrichment of scheduled sessions.
   */
  static buildEnrichmentPayload(sessions: PlannedSession[], efforts: LessonEffort[]): string {
    const lines: string[] = [];

    lines.push('# Course Lesson Content Excerpts\n');
    for (const effort of efforts) {
      lines.push(`## ${effort.lessonId}: ${effort.title} (${effort.type.toUpperCase()})`);
      if (effort.excerpt) {
        lines.push(`Key Concepts & Topics: ${effort.excerpt.trim()}`);
      }
      lines.push('');
    }

    lines.push('\n# Scheduled Sessions Requiring Enrichment\n');
    lines.push('Generate a title and description for each sessionKey below strictly following the guidelines and instructions provided in the system prompt:\n');

    const sessionsToEnrich = sessions.map((s) => ({
      sessionKey: s.sessionKey,
      lessonId: s.lessonId,
      type: s.type,
      section: s.section || null,
      currentTitle: s.title
    }));

    lines.push(JSON.stringify(sessionsToEnrich, null, 2));

    return lines.join('\n');
  }
}
