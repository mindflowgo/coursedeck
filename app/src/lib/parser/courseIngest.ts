import fs from 'node:fs';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { ArchiveExtractor } from './extractor';
import { DomCleaner } from './domCleaner';
import { TurndownConverter } from './turndownConverter';
import { QuestionParser } from './questionParser';
import { serializeWithFrontmatter } from './frontmatter';
import { optimizeCourseImages } from './imageOptimizer';

export interface IngestProgressEvent {
  step: 'scan' | 'unpack' | 'extract' | 'optimize' | 'manifest' | 'complete' | 'error';
  message: string;
  current?: number;
  total?: number;
  details?: string;
}

export type IngestProgressCallback = (event: IngestProgressEvent) => void;

export interface IngestOptions {
  overwriteExisting?: boolean;
  overwriteLessonIds?: string[];
  overwriteFiles?: string[];
  useMarkdownAsLesson?: boolean;
  onProgress?: IngestProgressCallback;
}

export interface CourseManifestLesson {
  id: string; // e.g. "01-02" or "01-06_assign1"
  code: string; // e.g. "clu3m_u1la2"
  title: string;
  unitNumber: number;
  lessonNumber: number;
  type: 'lesson' | 'assignment';
  hasFull: boolean;
  hasSummary: boolean;
  hasNotes: boolean;
  hasTest: boolean;
  pageRange?: string;
  readingDescription?: string;
  format?: 'markdown' | 'html' | 'pdf' | 'video';
  hasCompanion?: boolean;
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
  /** True when the course has an accompanying course PDF book in assets/locker_docs/course.pdf */
  coursePDF?: boolean;
  /** True when the course is archived — hidden from listings, still openable. */
  archived?: boolean;
  path?: string;
  courseDocs?: CourseDocsFlags;
  group?: string;
}

/** Course-level documents stored as `course.<type>.md` (or `logs.md`) in the course folder. */
export type CourseDocType = 'summary' | 'notes' | 'test' | 'schedule' | 'logs';

export interface CourseDocsFlags {
  summary: boolean;
  notes: boolean;
  studysheet?: boolean;
  test: boolean;
  schedule: boolean;
  logs?: boolean;
  [key: string]: boolean | undefined;
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

  /**
   * Scans backupDir for container archives (such as an uploaded Archive.zip containing
   * multiple individual lesson packages) and unpacks the contained packages into backupDir.
   */
  private unpackContainerArchives(backupDir: string, onProgress?: IngestProgressCallback): void {
    if (!fs.existsSync(backupDir)) return;
    const files = fs
      .readdirSync(backupDir)
      .filter((f) => f.toLowerCase().endsWith('.zip') && !f.startsWith('.'));

    for (const f of files) {
      const fullPath = path.join(backupDir, f);
      try {
        const data = fs.readFileSync(fullPath);
        const unzipped = unzipSync(new Uint8Array(data));
        const entries = Object.keys(unzipped).filter(
          (k) => !k.startsWith('__MACOSX') && !path.basename(k).startsWith('._')
        );

        // Check if this zip is a container containing lesson packages (.zip, .mhtml, .mht, .html)
        const nestedPackages = entries.filter((k) => /\.(zip|mhtml|mht|html|htm)$/i.test(k));
        const hasNestedZips = entries.some((k) => /\.(zip|mhtml|mht)$/i.test(k));
        const hasMultipleHtml = entries.filter((k) => /\.(html|htm)$/i.test(k)).length > 1;

        if (hasNestedZips || hasMultipleHtml) {
          onProgress?.({
            step: 'unpack',
            message: `Unpacking container archive "${f}" (${nestedPackages.length} package(s) inside)...`,
            current: 0,
            total: nestedPackages.length,
            details: f
          });
          console.log(`[CourseIngest] Unpacking container archive "${f}" with ${nestedPackages.length} package(s)...`);

          let extractedCount = 0;
          for (let i = 0; i < nestedPackages.length; i++) {
            const entryName = nestedPackages[i];
            const entryData = unzipped[entryName];
            if (!entryData || entryData.length === 0) continue;
            const destFilename = path.basename(entryName);
            const destPath = path.join(backupDir, destFilename);
            if (!fs.existsSync(destPath)) {
              fs.writeFileSync(destPath, Buffer.from(entryData));
              extractedCount++;
            }
            onProgress?.({
              step: 'unpack',
              message: `[${i + 1}/${nestedPackages.length}] Unpacking ${destFilename}...`,
              current: i + 1,
              total: nestedPackages.length,
              details: destFilename
            });
          }

          console.log(`[CourseIngest] Unpacked ${extractedCount} package(s) from "${f}".`);
          onProgress?.({
            step: 'unpack',
            message: `Unpacked ${extractedCount} lesson package(s) from "${f}".`,
            current: nestedPackages.length,
            total: nestedPackages.length,
            details: `${extractedCount} packages extracted`
          });

          // Rename container archive so it is not re-processed as a single lesson
          const renamed = path.join(backupDir, `.${f}.unpacked`);
          try {
            if (fs.existsSync(renamed)) fs.unlinkSync(renamed);
            fs.renameSync(fullPath, renamed);
          } catch {
            // Ignore rename errors
          }
        }
      } catch (err) {
        console.warn(`[CourseIngest] Could not inspect "${f}" as container archive:`, err);
      }
    }
  }

  private loadGenericPrompt(type: 'summary' | 'notes' | 'test'): string {
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
    const { overwriteExisting = false, onProgress } = options;
    const courseId = path.basename(courseDir).toLowerCase();
    const backupDir = path.join(courseDir, '_backup');
    const assetsDir = path.join(courseDir, 'assets');
    const manifestPath = path.join(courseDir, '.manifest.json');

    onProgress?.({
      step: 'scan',
      message: `Scanning course archive for [${courseId}]...`
    });

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

    // Unpack any container zip bundles (e.g. Archive.zip containing lesson packages)
    this.unpackContainerArchives(backupDir, onProgress);

    // Load existing manifest if present to preserve custom course titles & descriptions
    let existingManifest: Partial<CourseManifest> | null = null;
    if (fs.existsSync(manifestPath)) {
      try {
        existingManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      } catch (e) {
        console.warn('Could not parse existing .manifest.json:', e);
      }
    }

    const packageFiles = fs
      .readdirSync(backupDir)
      .filter((f) => /\.(zip|mhtml|mht|html|htm)$/i.test(f) && !f.startsWith('.'))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

    onProgress?.({
      step: 'scan',
      message: `Found ${packageFiles.length} lesson package(s) to process`,
      current: 0,
      total: packageFiles.length
    });
    console.log(`[CourseIngest] Processing ${packageFiles.length} lesson package(s) for [${courseId}]...`);

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

    let pkgIndex = 0;
    for (const pkgFile of packageFiles) {
      pkgIndex++;
      const pkgPath = path.join(backupDir, pkgFile);

      onProgress?.({
        step: 'extract',
        message: `[${pkgIndex}/${packageFiles.length}] Extracting ${pkgFile}...`,
        current: pkgIndex,
        total: packageFiles.length,
        details: pkgFile
      });

      // Extract using universal ArchiveExtractor (.zip, .mhtml, .html)
      const extracted = ArchiveExtractor.extract(pkgPath, assetsDir);
      if (!extracted) {
        console.warn(`[CourseIngest] Package "${pkgFile}" did not produce valid lesson content, skipping.`);
        onProgress?.({
          step: 'extract',
          message: `[${pkgIndex}/${packageFiles.length}] Skipped ${pkgFile} (no valid lesson HTML found)`,
          current: pkgIndex,
          total: packageFiles.length,
          details: `Skipped: ${pkgFile}`
        });
        continue;
      }

      const { unitNumber, lessonNumber, isAssignment, activityCode } = extracted;
      const unitNumStr = String(unitNumber).padStart(2, '0');
      const lessonNumStr = String(lessonNumber).padStart(2, '0');
      const lessonId = isAssignment
        ? `${unitNumStr}-${lessonNumStr}_assign1`
        : `${unitNumStr}-${lessonNumStr}`;

      const mdPath = path.join(courseDir, `${lessonId}.lesson.md`);
      const htmlPath = path.join(courseDir, `${lessonId}.lesson.html`);
      const pdfPath = path.join(courseDir, `${lessonId}.lesson.pdf`);

      const preferMarkdown = Boolean(options.useMarkdownAsLesson);
      const targetPrimaryPath = preferMarkdown ? mdPath : htmlPath;
      const isExistingLesson = fs.existsSync(targetPrimaryPath);
      const shouldOverwrite =
        overwriteExisting ||
        Boolean(options.overwriteLessonIds && options.overwriteLessonIds.includes(lessonId)) ||
        Boolean(options.overwriteFiles && options.overwriteFiles.includes(pkgFile));

      // If lesson already exists in requested format and overwrite is false, preserve existing files and register
      if (isExistingLesson && !shouldOverwrite) {
        let lessonTitle = extracted.title || `${isAssignment ? 'Assignment' : 'Lesson'} ${unitNumber}.${lessonNumber}`;
        const existingFilePath = fs.existsSync(targetPrimaryPath) ? targetPrimaryPath : (fs.existsSync(htmlPath) ? htmlPath : mdPath);
        try {
          const content = fs.readFileSync(existingFilePath, 'utf8');
          const titleMatch = content.match(/^title:\s*['"]?(.*?)['"]?$/m);
          if (titleMatch) lessonTitle = titleMatch[1].trim();
        } catch {}

        const detectedFormat: 'markdown' | 'html' | 'pdf' | 'video' = preferMarkdown
          ? 'markdown'
          : (fs.existsSync(htmlPath) ? 'html' : fs.existsSync(pdfPath) ? 'pdf' : 'markdown');

        lessonsMap.set(lessonId, {
          id: lessonId,
          code: activityCode,
          title: lessonTitle,
          unitNumber,
          lessonNumber,
          type: isAssignment ? 'assignment' : 'lesson',
          hasFull: (
            fs.existsSync(htmlPath) ||
            fs.existsSync(pdfPath) ||
            fs.existsSync(mdPath)
          ),
          hasSummary: fs.existsSync(path.join(courseDir, `${lessonId}.summary.md`)),
          hasNotes: fs.existsSync(path.join(courseDir, `${lessonId}.notes.md`)),
          hasTest: fs.existsSync(path.join(courseDir, `${lessonId}.test.md`)),
          format: detectedFormat,
          hasCompanion: detectedFormat !== 'markdown' && fs.existsSync(path.join(courseDir, `${lessonId}.lesson.companion.md`))
        });

        onProgress?.({
          step: 'extract',
          message: `[${pkgIndex}/${packageFiles.length}] ✓ Unit ${unitNumber} Lesson ${lessonNumber}: ${lessonTitle} (already up to date)`,
          current: pkgIndex,
          total: packageFiles.length,
          details: lessonTitle
        });
        continue;
      }

      const cleaned = DomCleaner.clean(extracted.htmlContent);
      const unitTitle = unitTitles[extracted.unitNumber] || `Unit ${extracted.unitNumber}`;

      // Build lesson markdown outline
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

      if (preferMarkdown) {
        // Authoritative Markdown Lesson
        fs.writeFileSync(mdPath, fullLessonMd, 'utf8');

        // Clean up obsolete presentation HTML/companion if converting to markdown
        if (fs.existsSync(htmlPath)) {
          try { fs.unlinkSync(htmlPath); } catch {}
        }
        const companionPath = path.join(courseDir, `${lessonId}.lesson.companion.md`);
        if (fs.existsSync(companionPath)) {
          try { fs.unlinkSync(companionPath); } catch {}
        }
      } else {
        // Authoritative Presentation HTML (sandboxed iframe source — immutable after ingest)
        const presentationHtml = DomCleaner.preparePresentationHtml(extracted.htmlContent);
        fs.writeFileSync(htmlPath, presentationHtml, 'utf8');

        // Companion Markdown (AI context & editor target)
        const companionPath = path.join(courseDir, `${lessonId}.lesson.companion.md`);
        fs.writeFileSync(companionPath, fullLessonMd, 'utf8');

        // Clean up any standalone .lesson.md so primary format remains cleanly HTML
        if (fs.existsSync(mdPath)) {
          try { fs.unlinkSync(mdPath); } catch {}
        }
      }

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

      // 3. Generate Initial Notes with YAML frontmatter
      const notesFilename = `${lessonId}.notes.md`;
      const notesFilePath = path.join(courseDir, notesFilename);
      if (!fs.existsSync(notesFilePath) || shouldOverwrite) {
        const notesPrompt = this.loadGenericPrompt('notes');
        const notesBody = this.generateInitialNotes(
          courseId,
          extracted.unitNumber,
          extracted.lessonNumber,
          extracted.title,
          extracted.isAssignment
        );
        const finalContent = serializeWithFrontmatter(
          {
            prompt: notesPrompt,
            type: 'notes',
            version: 1,
            updatedAt: new Date().toISOString().split('T')[0]
          },
          notesBody
        );
        fs.writeFileSync(notesFilePath, finalContent, 'utf8');
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
        hasNotes: true,
        hasTest: true,
        format: preferMarkdown ? 'markdown' : 'html',
        hasCompanion: !preferMarkdown
      });

      newLessonsAdded.push(lessonId);

      onProgress?.({
        step: 'extract',
        message: `[${pkgIndex}/${packageFiles.length}] ✓ Unit ${extracted.unitNumber} Lesson ${extracted.lessonNumber}: ${extracted.title}`,
        current: pkgIndex,
        total: packageFiles.length,
        details: extracted.title
      });
      console.log(`[CourseIngest] ✓ [${pkgIndex}/${packageFiles.length}] Extracted ${lessonId}: "${extracted.title}"`);
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
        'Comprehensive ILC course study notes, summaries, notes, and interactive practice questions.',
      units,
      updatedAt: new Date().toISOString(),
      archived: existingManifest?.archived
    };

    onProgress?.({
      step: 'manifest',
      message: `Compiling manifest: ${units.length} unit(s), ${lessonsMap.size} lesson(s)...`
    });

    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    if (newLessonsAdded.length > 0) {
      console.log(`✨ Added ${newLessonsAdded.length} new lesson(s) to [${courseId}]:`, newLessonsAdded);
    }

    // Compress oversized images (>512px) and normalize markdown size specs
    onProgress?.({
      step: 'optimize',
      message: 'Optimizing and compressing course images...',
      current: packageFiles.length,
      total: packageFiles.length
    });
    try {
      const imageStats = await optimizeCourseImages(courseDir);
      if (imageStats.converted > 0) {
        console.log(
          `🖼️ [${courseId}] Compressed ${imageStats.converted}/${imageStats.scanned} images ` +
            `(${(imageStats.bytesBefore / 1048576).toFixed(1)}MB → ${(imageStats.bytesAfter / 1048576).toFixed(1)}MB), ` +
            `${imageStats.markdownRefsUpdated} markdown ref(s) updated`
        );
        onProgress?.({
          step: 'optimize',
          message: `Compressed ${imageStats.converted} image(s), updated ${imageStats.markdownRefsUpdated} markdown ref(s)`,
          details: `${(imageStats.bytesBefore / 1048576).toFixed(1)}MB → ${(imageStats.bytesAfter / 1048576).toFixed(1)}MB`
        });
      }
    } catch (err) {
      console.warn(`[ImageOptimizer] Failed for ${courseId}, continuing:`, err);
    }

    onProgress?.({
      step: 'complete',
      message: `Course ingestion complete! ${lessonsMap.size} lesson(s) ready across ${units.length} unit(s).`,
      current: packageFiles.length,
      total: packageFiles.length
    });
    console.log(`[CourseIngest] ✅ Successfully ingested [${courseId}]: ${lessonsMap.size} lessons across ${units.length} units.`);

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

  private generateInitialNotes(
    courseId: string,
    unit: number,
    lesson: number,
    title: string,
    isAssignment: boolean
  ): string {
    return `# Notes: ${title}

*Not yet generated. These notes can be generated using the AI button above or automatically in the background.*
`;
  }

  private generateInitialTest(
    courseId: string,
    unit: number,
    lesson: number,
    title: string,
    isAssignment: boolean
  ): string {
    const courseCode = `${courseId.toUpperCase()}.${String(unit).padStart(2, '0')}-${String(lesson).padStart(2, '0')}`;

    return `course: ${courseCode}

# Practice Test: ${title}

*Not yet generated. This practice test can be generated using the AI button above or automatically in the background.*
`;
  }
}
