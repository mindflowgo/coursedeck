import fs from 'node:fs';
import path from 'node:path';
import { ArchiveExtractor } from './extractor';
import { DomCleaner } from './domCleaner';
import { TurndownConverter } from './turndownConverter';
import { QuestionParser } from './questionParser';
import { serializeWithFrontmatter } from './frontmatter';
import { optimizeCourseImages } from './imageOptimizer';
import type { CourseStudySummary } from '../studyStateTypes';

export interface CourseManifestLesson {
  id: string; // e.g. "01.02" or "01.06_assign1"
  code: string; // e.g. "clu3m_u1la2"
  title: string;
  unitNumber: number;
  lessonNumber: number;
  type: 'lesson' | 'assignment';
  hasFull: boolean;
  hasSummary: boolean;
  hasCheatsheet: boolean;
  hasTest: boolean;
}

export interface CourseManifestUnit {
  number: number;
  title: string;
  lessons: CourseManifestLesson[];
}

export interface CourseManifest {
  id: string;
  title: string;
  grade: string;
  level: string;
  description: string;
  units: CourseManifestUnit[];
  updatedAt: string;
  /** True when the course is archived — hidden from listings, still openable. */
  archived?: boolean;
  path?: string;
  courseDocs?: CourseDocsFlags;
  /** Computed per-course study summary (progress/checkpoints); read-time only. */
  study?: CourseStudySummary;
}

/** Course-level documents stored as `course.<type>.md` in the course folder. */
export type CourseDocType = 'summary' | 'cheatsheet' | 'test' | 'schedule';

export interface CourseDocsFlags {
  summary: boolean;
  cheatsheet: boolean;
  test: boolean;
  schedule: boolean;
  [key: string]: boolean;
}

export interface IngestOptions {
  overwriteExisting?: boolean;
  overwriteLessonIds?: string[];
  overwriteFiles?: string[];
}

export interface IngestResult {
  manifest: CourseManifest;
  newLessonsAdded: string[];
  totalLessons: number;
}

export class CourseIngest {
  private turndownConverter: TurndownConverter;

  constructor() {
    this.turndownConverter = new TurndownConverter();
  }

  private loadGenericPrompt(type: 'summary' | 'cheatsheet' | 'test'): string {
    const rootDir = process.cwd().endsWith('/app') ? path.resolve(process.cwd(), '..') : process.cwd();
    const promptsDir = path.join(rootDir, 'data', 'prompts');
    const filename = type === 'test' ? 'test.md' : `${type}.md`;
    const pPath = path.join(promptsDir, filename);
    if (fs.existsSync(pPath)) {
      return fs.readFileSync(pPath, 'utf8').trim();
    }
    if (type === 'test') {
      const kicaPath = path.join(promptsDir, 'test_kica.md');
      if (fs.existsSync(kicaPath)) return fs.readFileSync(kicaPath, 'utf8').trim();
    }
    return '';
  }

  /**
   * Ingest a course directory, incrementally adding newly added zip packages
   */
  async ingestCourse(courseDir: string, options: IngestOptions = {}): Promise<CourseManifest> {
    const { overwriteExisting = false } = options;
    const courseId = path.basename(courseDir).toLowerCase();
    const backupDir = path.join(courseDir, '_backup');
    const assetsDir = path.join(courseDir, 'assets');
    const metaPath = path.join(courseDir, 'meta.json');

    fs.mkdirSync(assetsDir, { recursive: true });
    fs.mkdirSync(backupDir, { recursive: true });

    // Check courseDir root for any directly placed packages (.zip, .mhtml, .mht, .html)
    // and copy them into _backup/ so they are tracked and processed
    if (fs.existsSync(courseDir)) {
      const rootFiles = fs.readdirSync(courseDir);
      for (const rf of rootFiles) {
        if (/\.(zip|mhtml|mht)$/i.test(rf) && !rf.startsWith('.')) {
          const src = path.join(courseDir, rf);
          const dest = path.join(backupDir, rf);
          if (!fs.existsSync(dest)) {
            fs.copyFileSync(src, dest);
          }
        }
      }
    }

    // Load existing manifest if present to preserve custom course titles & descriptions
    let existingManifest: Partial<CourseManifest> | null = null;
    if (fs.existsSync(metaPath)) {
      try {
        existingManifest = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      } catch (e) {
        console.warn('Could not parse existing meta.json:', e);
      }
    }

    const packageFiles = fs
      .readdirSync(backupDir)
      .filter((f) => /\.(zip|mhtml|mht|html|htm)$/i.test(f) && !f.startsWith('.'))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

    const lessonsMap: Map<string, CourseManifestLesson> = new Map();
    const newLessonsAdded: string[] = [];

    const unitTitles: Record<number, string> = {};

    // Populate existing unit titles from manifest if available
    if (existingManifest?.units) {
      for (const u of existingManifest.units) {
        if (u.title) {
          unitTitles[u.number] = u.title;
        }
      }
    }

    for (const pkgFile of packageFiles) {
      const pkgPath = path.join(backupDir, pkgFile);

      // Extract using universal ArchiveExtractor (.zip, .mhtml, .html)
      const extracted = ArchiveExtractor.extract(pkgPath, assetsDir);
      if (!extracted) continue;

      const { unitNumber, lessonNumber, isAssignment, activityCode } = extracted;
      const unitNumStr = String(unitNumber).padStart(2, '0');
      const lessonNumStr = String(lessonNumber).padStart(2, '0');
      const lessonId = isAssignment
        ? `${unitNumStr}.${lessonNumStr}_assign1`
        : `${unitNumStr}.${lessonNumStr}`;

      const lessonFilename = `${lessonId}.lesson.md`;
      const lessonFilePath = path.join(courseDir, lessonFilename);
      const isExistingLesson = fs.existsSync(lessonFilePath);
      const shouldOverwrite =
        overwriteExisting ||
        Boolean(options.overwriteLessonIds && options.overwriteLessonIds.includes(lessonId)) ||
        Boolean(options.overwriteFiles && options.overwriteFiles.includes(pkgFile));

      // If lesson already exists and overwrite is false, preserve existing files and register
      if (isExistingLesson && !shouldOverwrite) {
        let lessonTitle = extracted.title || `${isAssignment ? 'Assignment' : 'Lesson'} ${unitNumber}.${lessonNumber}`;
        try {
          const content = fs.readFileSync(lessonFilePath, 'utf8');
          const titleMatch = content.match(/^title:\s*['"]?(.*?)['"]?$/m);
          if (titleMatch) lessonTitle = titleMatch[1].trim();
        } catch {}

        lessonsMap.set(lessonId, {
          id: lessonId,
          code: activityCode,
          title: lessonTitle,
          unitNumber,
          lessonNumber,
          type: isAssignment ? 'assignment' : 'lesson',
          hasFull: fs.existsSync(path.join(courseDir, `${lessonId}.lesson.md`)),
          hasSummary: fs.existsSync(path.join(courseDir, `${lessonId}.summary.md`)),
          hasCheatsheet: fs.existsSync(path.join(courseDir, `${lessonId}.cheatsheet.md`)),
          hasTest: fs.existsSync(path.join(courseDir, `${lessonId}.test.md`))
        });
        continue;
      }

      const cleaned = DomCleaner.clean(extracted.htmlContent);
      const unitTitle = unitTitles[extracted.unitNumber] || `Unit ${extracted.unitNumber}`;

      // 1. Write Full Lesson Markdown
      const fullLessonMd = this.turndownConverter.convertToMarkdown(cleaned.cleanedHtml, {
        title: extracted.title,
        activityCode: extracted.activityCode,
        courseId,
        unit: unitTitle,
        unitNumber: extracted.unitNumber,
        lessonNumber: extracted.lessonNumber,
        type: extracted.isAssignment ? 'assignment' : 'lesson',
        savedAt: new Date().toISOString().split('T')[0]
      });

      fs.writeFileSync(lessonFilePath, fullLessonMd, 'utf8');

      // 2. Generate Initial Summary with YAML frontmatter
      const summaryFilename = `${lessonId}.summary.md`;
      const summaryFilePath = path.join(courseDir, summaryFilename);
      if (!fs.existsSync(summaryFilePath) || shouldOverwrite) {
        const summaryPrompt = this.loadGenericPrompt('summary');
        const summaryBody = this.generateInitialSummary(
          courseId,
          extracted.unitNumber,
          extracted.lessonNumber,
          extracted.title,
          cleaned.learningGoals,
          cleaned.successCriteria,
          extracted.isAssignment
        );
        const finalContent = serializeWithFrontmatter(
          {
            prompt: summaryPrompt,
            type: 'summary',
            version: 1,
            updatedAt: new Date().toISOString().split('T')[0]
          },
          summaryBody
        );
        fs.writeFileSync(summaryFilePath, finalContent, 'utf8');
      }

      // 3. Generate Initial Cheatsheet with YAML frontmatter
      const cheatsheetFilename = `${lessonId}.cheatsheet.md`;
      const cheatsheetFilePath = path.join(courseDir, cheatsheetFilename);
      if (!fs.existsSync(cheatsheetFilePath) || shouldOverwrite) {
        const cheatsheetPrompt = this.loadGenericPrompt('cheatsheet');
        const cheatsheetBody = this.generateInitialCheatsheet(
          courseId,
          extracted.unitNumber,
          extracted.lessonNumber,
          extracted.title,
          extracted.isAssignment
        );
        const finalContent = serializeWithFrontmatter(
          {
            prompt: cheatsheetPrompt,
            type: 'cheatsheet',
            version: 1,
            updatedAt: new Date().toISOString().split('T')[0]
          },
          cheatsheetBody
        );
        fs.writeFileSync(cheatsheetFilePath, finalContent, 'utf8');
      }

      // 4. Generate Initial KICA Test with YAML frontmatter
      const testFilename = `${lessonId}.test.md`;
      const testFilePath = path.join(courseDir, testFilename);
      if (!fs.existsSync(testFilePath) || shouldOverwrite) {
        const testPrompt = this.loadGenericPrompt('test');
        const testBody = this.generateInitialTest(
          courseId,
          extracted.unitNumber,
          extracted.lessonNumber,
          extracted.title,
          extracted.isAssignment
        );
        const finalContent = serializeWithFrontmatter(
          {
            prompt: testPrompt,
            type: 'test',
            version: 1,
            updatedAt: new Date().toISOString().split('T')[0]
          },
          testBody
        );
        fs.writeFileSync(testFilePath, finalContent, 'utf8');
      }

      lessonsMap.set(lessonId, {
        id: lessonId,
        code: extracted.activityCode,
        title: extracted.title,
        unitNumber: extracted.unitNumber,
        lessonNumber: extracted.lessonNumber,
        type: extracted.isAssignment ? 'assignment' : 'lesson',
        hasFull: true,
        hasSummary: true,
        hasCheatsheet: true,
        hasTest: true
      });

      newLessonsAdded.push(lessonId);
    }

    // Group lessons by units
    const unitsMap: Map<number, CourseManifestLesson[]> = new Map();
    for (const lesson of lessonsMap.values()) {
      if (!unitsMap.has(lesson.unitNumber)) {
        unitsMap.set(lesson.unitNumber, []);
      }
      unitsMap.get(lesson.unitNumber)!.push(lesson);
    }

    const units: CourseManifestUnit[] = Array.from(unitsMap.entries())
      .sort(([a], [b]) => a - b)
      .map(([num, lessons]) => ({
        number: num,
        title: unitTitles[num] || `Unit ${num}`,
        lessons: lessons.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))
      }));

    const defaultTitle = `${courseId.toUpperCase()}: Course Study Guide`;

    const manifest: CourseManifest = {
      id: courseId,
      title: existingManifest?.title || defaultTitle,
      grade: existingManifest?.grade || 'Grade 11',
      level: existingManifest?.level || 'University/College Preparation',
      description:
        existingManifest?.description ||
        'Comprehensive ILC course study notes, summaries, cheatsheets, and interactive practice questions.',
      units,
      updatedAt: new Date().toISOString(),
      archived: existingManifest?.archived
    };

    fs.writeFileSync(metaPath, JSON.stringify(manifest, null, 2), 'utf8');

    if (newLessonsAdded.length > 0) {
      console.log(`✨ Added ${newLessonsAdded.length} new lesson(s) to [${courseId}]:`, newLessonsAdded);
    }

    // Compress oversized images (>512px) and normalize markdown size specs
    try {
      const imageStats = await optimizeCourseImages(courseDir);
      if (imageStats.converted > 0) {
        console.log(
          `🖼️ [${courseId}] Compressed ${imageStats.converted}/${imageStats.scanned} images ` +
            `(${(imageStats.bytesBefore / 1048576).toFixed(1)}MB → ${(imageStats.bytesAfter / 1048576).toFixed(1)}MB), ` +
            `${imageStats.markdownRefsUpdated} markdown ref(s) updated`
        );
      }
    } catch (err) {
      console.warn(`[ImageOptimizer] Failed for ${courseId}, continuing:`, err);
    }

    return manifest;
  }

  private generateInitialSummary(
    courseId: string,
    unit: number,
    lesson: number,
    title: string,
    goals: string[],
    criteria: string[],
    isAssignment: boolean
  ): string {
    const goalsSection = goals.length > 0 ? `\n\n### Learning Goals\n${goals.map((g) => `- ${g}`).join('\n')}` : '';
    const criteriaSection = criteria.length > 0 ? `\n\n### Success Criteria\n${criteria.map((c) => `- ${c}`).join('\n')}` : '';

    return `# Summary: ${title}

*Not yet generated. This summary can be generated using the AI button above or automatically in the background.*${goalsSection}${criteriaSection}
`;
  }

  private generateInitialCheatsheet(
    courseId: string,
    unit: number,
    lesson: number,
    title: string,
    isAssignment: boolean
  ): string {
    return `# Cheatsheet: ${title}

*Not yet generated. This cheatsheet can be generated using the AI button above or automatically in the background.*
`;
  }

  private generateInitialTest(
    courseId: string,
    unit: number,
    lesson: number,
    title: string,
    isAssignment: boolean
  ): string {
    const courseCode = `${courseId.toUpperCase()}.${String(unit).padStart(2, '0')}.${String(lesson).padStart(2, '0')}`;

    return `course: ${courseCode}

# Practice Test: ${title}

*Not yet generated. This practice test can be generated using the AI button above or automatically in the background.*
`;
  }
}
