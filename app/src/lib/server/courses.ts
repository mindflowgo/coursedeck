import fs from 'node:fs';
import path from 'node:path';
import type { CourseDocType, CourseManifest } from '../parser/courseIngest';
import type { Checkpoint } from '../checkpoint';
import { isMarkupStroke, type MarkupStroke } from '../markup/types';
import { tabFileName, courseDocFileName, parseDocFileName, parseUnitNumber, isUnitScopeId } from '../tabs';
import { parseFrontmatter } from '../parser/frontmatter';
import { computeSummaryDensity, countWords } from '../parser/scheduleMetrics';
import { stripLessonMedia } from '../markdown/stripMedia';
import type { LessonEffort, PlannedSession } from '../scheduleGenerator';
export type { LessonEffort };
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

export interface LessonContentBundle {
  courseId: string;
  lessonId: string;
  lesson: string;
  /** Every tab file on disk for this lesson, keyed by tab slug (summary, test, assignment, …). */
  tabs: Record<string, string>;
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
      cheatsheet: false,
      test: false,
      schedule: false
    };
    if (!fs.existsSync(courseFolder)) return flags;
    try {
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
      const metaPath = path.join(courseFolder, 'meta.json');
      if (fs.existsSync(metaPath)) {
        try {
          const content = fs.readFileSync(metaPath, 'utf8');
          const manifest: CourseManifest = JSON.parse(content);
          manifest.path = courseFolder;
          manifest.courseDocs = this.discoverCourseDocs(courseFolder) as any;
          manifests.push(manifest);
        } catch (e) {
          console.error(`Failed to read meta.json for ${dirName}:`, e);
        }
      }
    }

    return manifests;
  }

  static getCourse(courseId: string): CourseManifest | null {
    const courseFolder = this.courseDir(courseId);
    const metaPath = safeJoin(courseFolder, 'meta.json');
    if (!fs.existsSync(metaPath)) return null;

    try {
      const content = fs.readFileSync(metaPath, 'utf8');
      const manifest: CourseManifest = JSON.parse(content);
      manifest.path = courseFolder;
      manifest.courseDocs = this.discoverCourseDocs(courseFolder) as any;
      return manifest;
    } catch {
      return null;
    }
  }

  static getManifest(courseId: string): CourseManifest | null {
    return this.getCourse(courseId);
  }

  /**
   * Patch editable meta.json fields (title, description, archived). Only the
   * provided fields are touched; the rest of the manifest is preserved
   * verbatim. Unarchiving deletes the flag entirely so active manifests stay
   * clean. Returns the updated manifest, or null when the course or its
   * meta.json cannot be read.
   */
  static updateCourseMeta(
    courseId: string,
    patch: Partial<Pick<CourseManifest, 'title' | 'description' | 'archived'>>
  ): CourseManifest | null {
    const courseFolder = this.courseDir(courseId);
    const metaPath = safeJoin(courseFolder, 'meta.json');
    if (!fs.existsSync(metaPath)) return null;

    try {
      const manifest: CourseManifest = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      if (patch.title !== undefined) manifest.title = patch.title;
      if (patch.description !== undefined) manifest.description = patch.description;
      if (patch.archived !== undefined) {
        if (patch.archived) {
          manifest.archived = true;
        } else {
          delete manifest.archived;
        }
      }
      fs.writeFileSync(metaPath, JSON.stringify(manifest, null, 2), 'utf8');
      return manifest;
    } catch (e) {
      console.error(`Failed to update meta.json for ${courseId}:`, e);
      return null;
    }
  }

  static getLessonContent(courseId: string, lessonId: string): LessonContentBundle | null {
    const lesson = assertLessonId(lessonId);
    const courseDir = this.courseDir(courseId);
    if (!fs.existsSync(courseDir)) return null;

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

    const readSafe = (filename: string): string => {
      const filePath = safeJoin(courseDir, filename);
      return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
    };

    return {
      courseId,
      lessonId: lesson,
      lesson: readSafe(tabFileName(lesson, 'lesson')),
      tabs
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

    const filePath = safeJoin(courseDir, tabFileName(lessonId, tab));
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

    const filename = tabFileName(lessonId, tab);
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
    const fullPath = trySafeJoin(resolveCoursesDir(), normalizeCourseId(courseId), 'assets', subPath);
    if (!fullPath || !fs.existsSync(fullPath)) return null;
    return fs.statSync(fullPath).isFile() ? fullPath : null;
  }

  static getCourseDocumentPath(courseId: string, type: string): string {
    return safeJoin(this.courseDir(courseId), courseDocFileName(type));
  }

  static getCourseDocument(courseId: string, type: string): string | null {
    const filePath = this.getCourseDocumentPath(courseId, type);
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null;
  }

  static hasCourseDocument(courseId: string, type: string): boolean {
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
    return safeJoin(this.courseDir(courseId), 'checkpoint.json');
  }

  static getCheckpoints(courseId: string): Checkpoint[] {
    const filePath = this.getCheckpointsPath(courseId);
    if (!fs.existsSync(filePath)) return [];
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (item): item is Checkpoint =>
          Boolean(item && typeof item === 'object' && item.id && item.file && typeof item.verticalPosition === 'number' && item.type)
      );
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
    const filePath = this.getCheckpointsPath(courseId);
    try {
      fs.writeFileSync(filePath, JSON.stringify(checkpoints, null, 2), 'utf8');
      return true;
    } catch (e) {
      console.error(`Failed to save checkpoints to ${filePath}:`, e);
      return false;
    }
  }

  // ── Free-hand markup annotations (annotations.json per course) ────────────

  static getAnnotationsPath(courseId: string): string {
    return safeJoin(this.courseDir(courseId), 'annotations.json');
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
      color?: string;
      noteText?: string;
    }
  ): Checkpoint {
    const checkpoints = this.getCheckpoints(courseId);
    const now = new Date().toISOString();
    const pos = Math.max(0, Math.floor(note.verticalPosition));
    const cleanFile = note.file.trim();

    if (note.id) {
      const idx = checkpoints.findIndex((c) => c.id === note.id);
      if (idx !== -1) {
        checkpoints[idx] = {
          ...checkpoints[idx],
          file: cleanFile,
          verticalPosition: pos,
          color: note.color || checkpoints[idx].color || 'yellow',
          noteText: note.noteText ?? checkpoints[idx].noteText ?? '',
          date: now
        };
        this.saveCheckpoints(courseId, checkpoints);
        return checkpoints[idx];
      }
    }

    const newCp: Checkpoint = {
      id: note.id || `cp_note_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      file: cleanFile,
      verticalPosition: pos,
      type: 'note',
      color: note.color || 'yellow',
      noteText: note.noteText || '',
      date: now
    };
    checkpoints.push(newCp);
    this.saveCheckpoints(courseId, checkpoints);
    return newCp;
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
        if (cp.type === 'note') {
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

  static gatherLessonFiles(
    courseId: string,
    type: 'lesson' | 'summary' | 'cheatsheet' | 'test'
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

    for (const unit of course.units) {
      for (const lesson of unit.lessons) {
        const filePath = safeJoin(courseDir, tabFileName(lesson.id, type));
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
  static getPromptContext(
    courseId: string,
    attachment: string,
    lessonId?: string
  ): string {
    const course = this.getCourse(courseId);
    const courseDir = this.courseDir(courseId);
    if (!course || !fs.existsSync(courseDir)) return '';

    const norm = attachment.toLowerCase().trim();

    if (norm === 'lesson - lessons' && lessonId) {
      const bundle = this.getLessonContent(courseId, lessonId);
      return bundle?.lesson ? this.cleanLessonText(bundle.lesson) : '';
    }

    if (norm === 'lesson - summaries' && lessonId) {
      return this.readCuratedContent(courseDir, lessonId, 'summary') || '';
    }

    if (norm === 'lesson - cheatsheets' && lessonId) {
      return this.readCuratedContent(courseDir, lessonId, 'cheatsheet') || '';
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

    if (norm === 'unit - cheatsheets') {
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
        const cs = this.readCuratedContent(courseDir, l.id, 'cheatsheet');
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

    if (norm === 'course - cheatsheets') {
      const parts: string[] = [];
      for (const u of course.units) {
        for (const l of u.lessons) {
          const cs = this.readCuratedContent(courseDir, l.id, 'cheatsheet');
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
   * Body of the lesson's curated tab file (summary/cheatsheet/test), skipping
   * "Not yet generated" stubs. Null when the file is absent or a stub.
   */
  private static readCuratedContent(
    courseDir: string,
    lessonId: string,
    docType: 'summary' | 'cheatsheet' | 'test'
  ): string | null {
    const filePath = safeJoin(courseDir, tabFileName(lessonId, docType));
    if (!fs.existsSync(filePath)) return null;
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

  static buildAggregatedPayload(courseId: string, type: 'summary' | 'cheatsheet' | 'test'): string {
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
            this.readCuratedContent(courseDir, lesson.id, 'cheatsheet');
          if (body) {
            lessonContent = this.budgetLessonContent(body, 3000);
          }
        } else if (type === 'cheatsheet') {
          const body =
            this.readCuratedContent(courseDir, lesson.id, 'cheatsheet') ??
            this.readCuratedContent(courseDir, lesson.id, 'summary');
          if (body) {
            lessonContent = this.budgetLessonContent(body, 2500);
          }
        } else if (type === 'test') {
          const primaryBody =
            this.readCuratedContent(courseDir, lesson.id, 'summary') ??
            this.readCuratedContent(courseDir, lesson.id, 'cheatsheet');
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
    let totalWords = 0;
    for (const lesson of allLessons) {
      const lessonFile = safeJoin(courseDir, tabFileName(lesson.id, 'lesson'));
      if (fs.existsSync(lessonFile)) {
        totalWords += countWords(fs.readFileSync(lessonFile, 'utf8'));
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
        const lessonFile = safeJoin(courseDir, tabFileName(lesson.id, 'lesson'));
        const lessonWords = fs.existsSync(lessonFile)
          ? countWords(fs.readFileSync(lessonFile, 'utf8'))
          : 0;
        const summaryBody =
          this.readCuratedContent(courseDir, lesson.id, 'summary') ??
          this.readCuratedContent(courseDir, lesson.id, 'cheatsheet');
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

    for (const unit of course.units) {
      for (const lesson of unit.lessons) {
        const lessonFile = safeJoin(courseDir, tabFileName(lesson.id, 'lesson'));
        const wordCount = fs.existsSync(lessonFile)
          ? countWords(fs.readFileSync(lessonFile, 'utf8'))
          : 0;

        const summaryBody =
          this.readCuratedContent(courseDir, lesson.id, 'summary') ??
          this.readCuratedContent(courseDir, lesson.id, 'cheatsheet');

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
