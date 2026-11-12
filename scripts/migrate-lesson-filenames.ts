#!/usr/bin/env bun
import fs from 'node:fs';
import path from 'node:path';
import { getDataDir } from '../app/src/lib/server/paths';

/**
 * Migration script to rename legacy dot-separated lesson filenames to hyphenated format:
 *   e.g. 01.01.lesson.md -> 01-01.lesson.md
 *        01.06_assign1.assignment.md -> 01-06_assign1.assignment.md
 *
 * Also updates:
 *   - .manifest.json (lesson.id: "01.01" -> "01-01")
 *   - .checkpoints.json (file and anchor references)
 *   - .annotations.json (file references)
 *   - course.schedule.md (lesson event markers)
 *
 * Usage:
 *   bun run scripts/migrate-lesson-filenames.ts [--dry-run] [--course=<id>]
 */

const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const courseArg = args.find((a) => a.startsWith('--course='))?.split('=')[1]?.toLowerCase();

const LEGACY_FILE_REGEX = /^(\d{2})\.(\d{2}(?:_assign\d+)?)\.(.*)$/;
const LEGACY_ID_REGEX = /^(\d{2})\.(\d{2}(?:_assign\d+)?)$/;

function transformLessonId(id: string): string {
  const match = id.match(LEGACY_ID_REGEX);
  if (match) {
    return `${match[1]}-${match[2]}`;
  }
  return id;
}

function transformFileName(filename: string): string {
  const match = filename.match(LEGACY_FILE_REGEX);
  if (match) {
    return `${match[1]}-${match[2]}.${match[3]}`;
  }
  return filename;
}

async function run() {
  const dataDir = getDataDir();
  const coursesDir = path.join(dataDir, 'courses');

  console.log(`\n================================================================`);
  console.log(` CourseDeck Legacy Lesson Filename Migration (01.01 -> 01-01)`);
  console.log(` Data Directory : ${dataDir}`);
  console.log(` Mode           : ${isDryRun ? 'DRY RUN (no files modified)' : 'EXECUTE'}`);
  if (courseArg) {
    console.log(` Filter Course  : ${courseArg}`);
  }
  console.log(`================================================================\n`);

  if (!fs.existsSync(coursesDir)) {
    console.error(`Courses directory not found at: ${coursesDir}`);
    process.exit(1);
  }

  const allCourseDirs = fs
    .readdirSync(coursesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => d.name)
    .filter((c) => !courseArg || c.toLowerCase() === courseArg);

  let grandTotalFilesRenamed = 0;
  let grandTotalManifestLessons = 0;
  let grandTotalCheckpoints = 0;
  let grandTotalAnnotations = 0;
  let grandTotalScheduleLines = 0;

  for (const courseId of allCourseDirs) {
    const cDir = path.join(coursesDir, courseId);
    let filesRenamed = 0;
    let manifestLessonsUpdated = 0;
    let checkpointsUpdated = 0;
    let annotationsUpdated = 0;
    let scheduleLinesUpdated = 0;

    console.log(`▶ Processing course [${courseId}]...`);

    // 1. Rename files on disk
    const entries = fs.readdirSync(cDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const oldName = entry.name;
      if (LEGACY_FILE_REGEX.test(oldName)) {
        const newName = transformFileName(oldName);
        const oldPath = path.join(cDir, oldName);
        const newPath = path.join(cDir, newName);

        if (fs.existsSync(newPath)) {
          console.warn(`  [WARN] Destination file already exists: ${newName} (skipping ${oldName})`);
          continue;
        }

        if (!isDryRun) {
          fs.renameSync(oldPath, newPath);
        }
        filesRenamed++;
      }
    }

    // 2. Update .manifest.json
    const manifestPath = path.join(cDir, '.manifest.json');
    if (fs.existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        let changed = false;
        if (Array.isArray(manifest.units)) {
          for (const unit of manifest.units) {
            if (Array.isArray(unit.lessons)) {
              for (const lesson of unit.lessons) {
                if (lesson.id && LEGACY_ID_REGEX.test(lesson.id)) {
                  const newId = transformLessonId(lesson.id);
                  lesson.id = newId;
                  manifestLessonsUpdated++;
                  changed = true;
                }
              }
            }
          }
        }
        if (changed && !isDryRun) {
          fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
        }
      } catch (err) {
        console.error(`  [ERROR] Failed to update .manifest.json for ${courseId}:`, err);
      }
    }

    // 3. Update .checkpoints.json
    const checkpointsPath = path.join(cDir, '.checkpoints.json');
    if (fs.existsSync(checkpointsPath)) {
      try {
        const checkpoints = JSON.parse(fs.readFileSync(checkpointsPath, 'utf8'));
        let changed = false;
        if (Array.isArray(checkpoints)) {
          for (const cp of checkpoints) {
            if (cp.file && LEGACY_FILE_REGEX.test(cp.file)) {
              cp.file = transformFileName(cp.file);
              checkpointsUpdated++;
              changed = true;
            }
            if (cp.anchor?.sourceFile && LEGACY_FILE_REGEX.test(cp.anchor.sourceFile)) {
              cp.anchor.sourceFile = transformFileName(cp.anchor.sourceFile);
              changed = true;
            }
            if (cp.anchor?.file && LEGACY_FILE_REGEX.test(cp.anchor.file)) {
              cp.anchor.file = transformFileName(cp.anchor.file);
              changed = true;
            }
          }
        }
        if (changed && !isDryRun) {
          fs.writeFileSync(checkpointsPath, JSON.stringify(checkpoints, null, 2), 'utf8');
        }
      } catch (err) {
        console.error(`  [ERROR] Failed to update .checkpoints.json for ${courseId}:`, err);
      }
    }

    // 4. Update .annotations.json
    const annotationsPath = path.join(cDir, '.annotations.json');
    if (fs.existsSync(annotationsPath)) {
      try {
        const annotations = JSON.parse(fs.readFileSync(annotationsPath, 'utf8'));
        let changed = false;
        if (Array.isArray(annotations)) {
          for (const ann of annotations) {
            if (ann.file && LEGACY_FILE_REGEX.test(ann.file)) {
              ann.file = transformFileName(ann.file);
              annotationsUpdated++;
              changed = true;
            }
          }
        }
        if (changed && !isDryRun) {
          fs.writeFileSync(annotationsPath, JSON.stringify(annotations, null, 2), 'utf8');
        }
      } catch (err) {
        console.error(`  [ERROR] Failed to update .annotations.json for ${courseId}:`, err);
      }
    }

    // 5. Update course.schedule.md
    const schedulePath = path.join(cDir, 'course.schedule.md');
    if (fs.existsSync(schedulePath)) {
      try {
        const content = fs.readFileSync(schedulePath, 'utf8');
        const lines = content.split('\n');
        let changed = false;
        const newLines = lines.map((line) => {
          // Replace patterns like "**Study** 01.01 —", "**Submit** 01.05_assign1/assignment", etc.
          const updated = line.replace(
            /(\*\*[A-Za-z]+\*\*\s+)(\d{2})\.(\d{2}(?:_assign\d+)?)/gi,
            '$1$2-$3'
          );
          if (updated !== line) {
            scheduleLinesUpdated++;
            changed = true;
            return updated;
          }
          return line;
        });

        if (changed && !isDryRun) {
          fs.writeFileSync(schedulePath, newLines.join('\n'), 'utf8');
        }
      } catch (err) {
        console.error(`  [ERROR] Failed to update course.schedule.md for ${courseId}:`, err);
      }
    }

    console.log(
      `  ✓ ${courseId}: ${filesRenamed} files renamed | ` +
        `${manifestLessonsUpdated} manifest lessons | ` +
        `${checkpointsUpdated} checkpoints | ` +
        `${annotationsUpdated} annotations | ` +
        `${scheduleLinesUpdated} schedule lines`
    );

    grandTotalFilesRenamed += filesRenamed;
    grandTotalManifestLessons += manifestLessonsUpdated;
    grandTotalCheckpoints += checkpointsUpdated;
    grandTotalAnnotations += annotationsUpdated;
    grandTotalScheduleLines += scheduleLinesUpdated;
  }

  console.log(`\n----------------------------------------------------------------`);
  console.log(`Migration Summary (${isDryRun ? 'DRY RUN' : 'COMPLETED'}):`);
  console.log(`  Courses processed       : ${allCourseDirs.length}`);
  console.log(`  Files renamed           : ${grandTotalFilesRenamed}`);
  console.log(`  Manifest lessons updated: ${grandTotalManifestLessons}`);
  console.log(`  Checkpoints updated     : ${grandTotalCheckpoints}`);
  console.log(`  Annotations updated     : ${grandTotalAnnotations}`);
  console.log(`  Schedule events updated : ${grandTotalScheduleLines}`);
  console.log(`================================================================\n`);
}

run().catch((err) => {
  console.error('Fatal error during migration:', err);
  process.exit(1);
});
