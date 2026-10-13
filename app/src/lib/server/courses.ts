import fs from 'node:fs';
import path from 'node:path';
import type { CourseManifest } from '../parser/courseIngest';
import { parseFrontmatter } from '../parser/frontmatter';
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

export interface LessonFileVersion {
  id: string; // e.g. "summary" or "summary-2"
  filename: string; // e.g. "01.02.summary.md" or "01.02.summary-2.md"
  versionNumber: number; // 1, 2, 3...
  label: string; // "v1", "v2", ...
  content: string;
}

export interface LessonContentBundle {
  courseId: string;
  lessonId: string;
  lesson: string;
  summary: string;
  cheatsheet: string;
  test: string;
  summaries: LessonFileVersion[];
  cheatsheets: LessonFileVersion[];
  tests: LessonFileVersion[];
}

export class CourseService {
  static getCoursesDir(): string {
    return resolveCoursesDir();
  }

  /** Absolute course directory, validated so the id cannot escape the data dir. */
  private static courseDir(courseId: unknown): string {
    return safeJoin(resolveCoursesDir(), normalizeCourseId(courseId));
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
          manifest.courseDocs = {
            summary: fs.existsSync(path.join(courseFolder, 'course.summary.md')),
            cheatsheet: fs.existsSync(path.join(courseFolder, 'course.cheatsheet.md')),
            test: fs.existsSync(path.join(courseFolder, 'course.test.md'))
          };
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
      manifest.courseDocs = {
        summary: fs.existsSync(path.join(courseFolder, 'course.summary.md')),
        cheatsheet: fs.existsSync(path.join(courseFolder, 'course.cheatsheet.md')),
        test: fs.existsSync(path.join(courseFolder, 'course.test.md'))
      };
      return manifest;
    } catch {
      return null;
    }
  }

  static getManifest(courseId: string): CourseManifest | null {
    return this.getCourse(courseId);
  }

  static getLessonContent(courseId: string, lessonId: string): LessonContentBundle | null {
    const lesson = assertLessonId(lessonId);
    const courseDir = this.courseDir(courseId);
    if (!fs.existsSync(courseDir)) return null;

    const files = fs.readdirSync(courseDir);

    const getVersions = (tabPrefix: 'summary' | 'cheatsheet' | 'test'): LessonFileVersion[] => {
      const regex = new RegExp(`^${lessonId.replace('.', '\\.')}\\.${tabPrefix}(?:-(\\d+))?\\.md$`, 'i');
      return files
        .filter((f) => regex.test(f))
        .map((f) => {
          const match = f.match(regex);
          const versionNum = match && match[1] ? parseInt(match[1], 10) : 1;
          const versionId = versionNum === 1 ? tabPrefix : `${tabPrefix}-${versionNum}`;
          const content = fs.readFileSync(path.join(courseDir, f), 'utf8');
          return {
            id: versionId,
            filename: f,
            versionNumber: versionNum,
            label: `v${versionNum}`,
            content
          };
        })
        .sort((a, b) => a.versionNumber - b.versionNumber);
    };

    const summaries = getVersions('summary');
    const cheatsheets = getVersions('cheatsheet');
    const tests = getVersions('test');

    const readSafe = (filename: string): string => {
      const filePath = safeJoin(courseDir, filename);
      return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
    };

    return {
      courseId,
      lessonId: lesson,
      lesson: readSafe(`${lessonId}.lesson.md`),
      summary: summaries[0]?.content || readSafe(`${lessonId}.summary.md`),
      cheatsheet: cheatsheets[0]?.content || readSafe(`${lessonId}.cheatsheet.md`),
      test: tests[0]?.content || readSafe(`${lessonId}.test.md`),
      summaries,
      cheatsheets,
      tests
    };
  }

  static getLessonBundle(courseId: string, lessonId: string): LessonContentBundle | null {
    return this.getLessonContent(courseId, lessonId);
  }

  /** Highest existing version number for a lesson tab file (>= 1, base file = 1). */
  static latestVersionNumber(courseId: string, lessonId: string, tab: string): number {
    const courseDir = this.courseDir(courseId);
    if (!fs.existsSync(courseDir)) return 1;

    const baseTab = tab.replace(/-\d+$/, '');
    const regex = new RegExp(
      `^${lessonId.replace(/\./g, '\\.')}\\.${baseTab}(?:-(\\d+))?\\.md$`,
      'i'
    );
    let max = 1;
    for (const f of fs.readdirSync(courseDir)) {
      const m = f.match(regex);
      if (m) {
        const num = m[1] ? parseInt(m[1], 10) : 1;
        if (num > max) max = num;
      }
    }
    return max;
  }

  /**
   * True when any version (base or -N) of the lesson tab exists with real
   * generated content — more than a stub and not a "Not yet generated"
   * placeholder. Used by the queue's missing-scan, which must not regenerate
   * lessons that only carry versioned files.
   */
  static hasLessonTabContent(
    courseId: string,
    lessonId: string,
    tab: 'summary' | 'cheatsheet' | 'test'
  ): boolean {
    const courseDir = this.courseDir(courseId);
    if (!fs.existsSync(courseDir)) return false;

    const regex = new RegExp(
      `^${lessonId.replace(/\./g, '\\.')}\\.${tab}(?:-\\d+)?\\.md$`,
      'i'
    );
    for (const f of fs.readdirSync(courseDir)) {
      if (!regex.test(f)) continue;
      try {
        const content = fs.readFileSync(path.join(courseDir, f), 'utf8');
        if (content.length > 250 && !content.includes('Not yet generated')) return true;
      } catch {}
    }
    return false;
  }

  static saveLessonTab(
    courseId: string,
    lessonId: string,
    tab: string,
    content: string,
    options?: { asNewVersion?: boolean }
  ): { success: boolean; versionId: string; filename: string } {
    const courseDir = this.courseDir(courseId);
    if (!fs.existsSync(courseDir)) {
      return { success: false, versionId: tab, filename: '' };
    }

    let targetTab = tab;
    const baseTab = tab.replace(/-\d+$/, ''); // 'summary', 'cheatsheet', or 'test'

    if (options?.asNewVersion && ['summary', 'cheatsheet', 'test'].includes(baseTab)) {
      targetTab = `${baseTab}-${this.latestVersionNumber(courseId, lessonId, baseTab) + 1}`;
    }

    const filename = `${lessonId}.${targetTab}.md`;
    const filePath = safeJoin(courseDir, filename);

    try {
      fs.writeFileSync(filePath, content, 'utf8');
      return { success: true, versionId: targetTab, filename };
    } catch (e) {
      console.error(`Failed to save ${filename}:`, e);
      return { success: false, versionId: targetTab, filename };
    }
  }

  static resolveAssetPath(courseId: string, subPath: string): string | null {
    const fullPath = trySafeJoin(resolveCoursesDir(), normalizeCourseId(courseId), 'assets', subPath);
    if (!fullPath || !fs.existsSync(fullPath)) return null;
    return fs.statSync(fullPath).isFile() ? fullPath : null;
  }

  static getCourseDocumentPath(courseId: string, type: 'summary' | 'cheatsheet' | 'test'): string {
    return safeJoin(this.courseDir(courseId), `course.${type}.md`);
  }

  static getCourseDocument(courseId: string, type: 'summary' | 'cheatsheet' | 'test'): string | null {
    const filePath = this.getCourseDocumentPath(courseId, type);
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null;
  }

  static saveCourseDocument(courseId: string, type: 'summary' | 'cheatsheet' | 'test', content: string): boolean {
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

    const files = fs.readdirSync(courseDir);
    const results: Array<{
      unitNumber: number;
      unitTitle: string;
      lessonId: string;
      lessonTitle: string;
      content: string;
    }> = [];

    for (const unit of course.units) {
      for (const lesson of unit.lessons) {
        let content = '';

        if (type === 'lesson') {
          const lessonFile = path.join(courseDir, `${lesson.id}.lesson.md`);
          if (fs.existsSync(lessonFile)) {
            content = fs.readFileSync(lessonFile, 'utf8');
          }
        } else {
          // For summary, cheatsheet, test: find latest version or base
          const regex = new RegExp(`^${lesson.id.replace('.', '\\.')}\\.${type}(?:-(\\d+))?\\.md$`, 'i');
          const matching = files
            .filter((f) => regex.test(f))
            .map((f) => {
              const m = f.match(regex);
              const num = m && m[1] ? parseInt(m[1], 10) : 1;
              return { file: f, version: num };
            })
            .sort((a, b) => b.version - a.version);

          if (matching.length > 0) {
            content = fs.readFileSync(safeJoin(courseDir, matching[0].file), 'utf8');
          } else {
            const fallbackFile = safeJoin(courseDir, `${lesson.id}.${type}.md`);
            if (fs.existsSync(fallbackFile)) {
              content = fs.readFileSync(fallbackFile, 'utf8');
            }
          }
        }

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

  private static findLatestCuratedContent(
    courseDir: string,
    files: string[],
    lessonId: string,
    docType: 'summary' | 'cheatsheet' | 'test'
  ): string | null {
    const escaped = lessonId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`^${escaped}\\.${docType}(?:-(\\d+))?\\.md$`, 'i');
    const matching = files
      .filter((f) => regex.test(f))
      .map((f) => {
        const m = f.match(regex);
        const num = m && m[1] ? parseInt(m[1], 10) : 1;
        return { file: f, version: num };
      })
      .sort((a, b) => b.version - a.version);

    for (const item of matching) {
      const filePath = safeJoin(courseDir, item.file);
      if (!fs.existsSync(filePath)) continue;
      try {
        const raw = fs.readFileSync(filePath, 'utf8');
        if (raw.includes('Not yet generated') && raw.length < 200) {
          continue;
        }
        const parsed = parseFrontmatter(raw);
        const body = (parsed.body || raw).trim();
        if (body.length > 0) {
          return body;
        }
      } catch (e) {
        console.warn(`Failed to read curated file ${filePath}:`, e);
      }
    }

    return null;
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

    const files = fs.readdirSync(courseDir);
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
            this.findLatestCuratedContent(courseDir, files, lesson.id, 'summary') ??
            this.findLatestCuratedContent(courseDir, files, lesson.id, 'cheatsheet');
          if (body) {
            lessonContent = this.budgetLessonContent(body, 3000);
          }
        } else if (type === 'cheatsheet') {
          const body =
            this.findLatestCuratedContent(courseDir, files, lesson.id, 'cheatsheet') ??
            this.findLatestCuratedContent(courseDir, files, lesson.id, 'summary');
          if (body) {
            lessonContent = this.budgetLessonContent(body, 2500);
          }
        } else if (type === 'test') {
          const primaryBody =
            this.findLatestCuratedContent(courseDir, files, lesson.id, 'summary') ??
            this.findLatestCuratedContent(courseDir, files, lesson.id, 'cheatsheet');
          const testBody = this.findLatestCuratedContent(courseDir, files, lesson.id, 'test');

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
}
