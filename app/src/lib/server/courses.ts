import fs from 'node:fs';
import path from 'node:path';
import type { CourseDocType, CourseManifest } from '../parser/courseIngest';
import { parseFrontmatter } from '../parser/frontmatter';
import { computeSummaryDensity, countWords } from '../parser/scheduleMetrics';
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
        const m = file.match(/^course\.([a-z0-9_]+)\.md$/i);
        if (m) {
          flags[m[1].toLowerCase()] = true;
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
      lesson: readSafe(`${lessonId}.lesson.md`),
      tabs
    };
  }

  static getLessonBundle(courseId: string, lessonId: string): LessonContentBundle | null {
    return this.getLessonContent(courseId, lessonId);
  }

  /**
   * True when the lesson tab file exists with real generated content — more
   * than a stub and not a "Not yet generated" placeholder. Used by the
   * queue's missing-scan, which must not regenerate present tabs.
   */
  static hasLessonTabContent(
    courseId: string,
    lessonId: string,
    tab: 'summary' | 'cheatsheet' | 'test'
  ): boolean {
    const courseDir = this.courseDir(courseId);
    if (!fs.existsSync(courseDir)) return false;

    const filePath = safeJoin(courseDir, `${lessonId}.${tab}.md`);
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

    const filename = `${lessonId}.${tab}.md`;
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
    const filePath = safeJoin(courseDir, `${lessonId}.${tab}.md`);
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
    return safeJoin(this.courseDir(courseId), `course.${type}.md`);
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
        const filePath = safeJoin(courseDir, `${lesson.id}.${type}.md`);
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
      const cleanBody = (parsed.body || item.content).trim();
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
   * Body of the lesson's curated tab file (summary/cheatsheet/test), skipping
   * "Not yet generated" stubs. Null when the file is absent or a stub.
   */
  private static readCuratedContent(
    courseDir: string,
    lessonId: string,
    docType: 'summary' | 'cheatsheet' | 'test'
  ): string | null {
    const filePath = safeJoin(courseDir, `${lessonId}.${docType}.md`);
    if (!fs.existsSync(filePath)) return null;
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      if (raw.includes('Not yet generated') && raw.length < 200) {
        return null;
      }
      const parsed = parseFrontmatter(raw);
      const body = (parsed.body || raw).trim();
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
      const lessonFile = safeJoin(courseDir, `${lesson.id}.lesson.md`);
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
    let excerptBudget = 20_000;
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
        const lessonFile = safeJoin(courseDir, `${lesson.id}.lesson.md`);
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
          const perLessonMax = Math.max(300, Math.min(500, Math.floor(excerptBudget / remainingLessons)));
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
}
