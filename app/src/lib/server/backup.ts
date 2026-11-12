import fs from 'node:fs';
import path from 'node:path';
import { Zip, ZipPassThrough, ZipDeflate, zipSync, unzipSync } from 'fflate';
import { getDataDir, safeJoin } from './paths';

export interface RestoreResult {
  success: boolean;
  coursesRestored: number;
  filesRestored: number;
}

export interface BackupOptions {
  includeRawArchives?: boolean;
  onProgress?: (info: { current: number; total: number; percent: number; currentFile: string }) => void;
}

export interface BackupZipStreamResult {
  stream: ReadableStream<Uint8Array>;
  filename: string;
  courseCount: number;
  fileCount: number;
}

const ALREADY_COMPRESSED = /\.(zip|gz|png|jpg|jpeg|webp|pdf|mp4|mp3|woff2|woff)$/i;

/**
 * Creates an asynchronous streaming zip archive containing all course data, prompts, and configs.
 * Uses ZipPassThrough for pre-compressed binaries to prevent high CPU deflate overhead,
 * and yields to the event loop every 20 files so concurrent HTTP requests (/api/queue) never freeze or time out.
 */
export function createDataBackupZipStream(options: BackupOptions = {}): BackupZipStreamResult {
  const includeRawArchives = options.includeRawArchives === true;
  const dataDir = getDataDir();

  const fileList: { absPath: string; relPath: string; size: number }[] = [];
  let courseCount = 0;

  const collectFiles = (absDir: string, relPrefix: string): void => {
    if (!fs.existsSync(absDir)) return;
    for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
      const absPath = path.join(absDir, entry.name);
      const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;

      // Skip raw zip packages in _backup if excluded; never archive prepared
      // sync bundles (they can carry LLM keys and are device-transient).
      if (entry.name === '_sync-tmp') continue;
      if (!includeRawArchives && entry.name === '_backup') {
        continue;
      }

      if (entry.isDirectory()) {
        collectFiles(absPath, relPath);
        if (relPrefix === '' && entry.name === 'courses') {
          const courses = fs.readdirSync(absPath, { withFileTypes: true });
          courseCount = courses.filter((c) => c.isDirectory()).length;
        }
      } else if (entry.isFile()) {
        try {
          const stat = fs.statSync(absPath);
          fileList.push({ absPath, relPath, size: stat.size });
        } catch {}
      }
    }
  };

  collectFiles(dataDir, '');

  const totalFiles = fileList.length;
  console.log(`[Backup Export] Scanned data directory: ${totalFiles} files across ${courseCount} courses (raw archives: ${includeRawArchives ? 'included' : 'excluded'})`);

  let zip: Zip;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      zip = new Zip((err, chunk, isLast) => {
        if (err) {
          console.error('[Backup Export] Streaming compression error:', err);
          controller.error(err);
          return;
        }
        if (chunk && chunk.length > 0) {
          controller.enqueue(chunk);
        }
        if (isLast) {
          console.log(`[Backup Export] Finished streaming all ${totalFiles} files.`);
          controller.close();
        }
      });

      // Pump files asynchronously yielding to event loop
      (async () => {
        try {
          for (let i = 0; i < fileList.length; i++) {
            const { absPath, relPath } = fileList[i];
            const isCompressed = ALREADY_COMPRESSED.test(relPath);
            const data = fs.readFileSync(absPath);
            const file = isCompressed
              ? new ZipPassThrough(relPath)
              : new ZipDeflate(relPath, { level: 1 });
            zip.add(file);
            file.push(new Uint8Array(data), true);

            // Yield every 20 files so other server tasks (/api/queue polling) are never blocked
            if (i % 20 === 0 || i === fileList.length - 1) {
              const percent = Math.round(((i + 1) / totalFiles) * 100);
              console.log(`[Backup Export] Progress: ${i + 1}/${totalFiles} (${percent}%) - ${relPath}`);
              options.onProgress?.({
                current: i + 1,
                total: totalFiles,
                percent,
                currentFile: relPath
              });
              await new Promise((r) => setTimeout(r, 0));
            }
          }
          zip.end();
        } catch (pumpErr) {
          console.error('[Backup Export] Failed during archive generation:', pumpErr);
          controller.error(pumpErr);
        }
      })();
    }
  });

  const today = new Date().toISOString().split('T')[0];
  const filename = `app-study-tool-backup-${today}.zip`;

  return { stream, filename, courseCount, fileCount: totalFiles };
}

export interface SyncBundleZipOptions {
  /** Lowercase course ids to include; null/undefined = every course. */
  courseIds?: string[] | null;
  /**
   * Incremental sync: only files whose modification time is after this ISO
   * timestamp (or Date) are archived. Courses with no modified files are
   * skipped entirely; when a course does have changes, its .manifest.json
   * rides along regardless of mtime so the receiving device always ends up
   * with a current course list.
   */
  since?: string | Date | null;
  /**
   * Lowercase course ids that ignore `since` and are archived in full.
   * Selective sync uses this for courses the device doesn't have yet —
   * otherwise an incremental cursor newer than the course's files would
   * produce an empty bundle and the course would never arrive.
   */
  fullCourses?: string[] | null;
  /** JSON-serialized into `_sync/meta.json` inside the archive. */
  syncMeta?: unknown;
  /** Custom compression level for text files (1-9). Defaults to 6 for incremental sync, 1 for full sync. */
  deflateLevel?: 1 | 4 | 6 | 9;
  /**
   * Optional progress observer fired as the archive is packed: once per
   * course when it starts, and throttled per-file while files stream in.
   */
  onProgress?: (info: { courseId: string | null; current: number; total: number; currentFile: string }) => void;
}

/**
 * Streaming zip of the selected course folders — everything except `_backup`
 * and dotfiles — plus a `_sync/meta.json` payload. This is the iPad sync
 * bundle: the app downloads the single archive and extracts it straight into
 * its Documents/courses folder. Entry names are normalized to
 * `courses/<lowercase course id>/...` so the iPad's lowercase lookups match.
 */
export function createSyncBundleZipStream(options: SyncBundleZipOptions = {}): {
  stream: ReadableStream<Uint8Array>;
  courseCount: number;
  fileCount: number;
} {
  const wanted =
    options.courseIds && options.courseIds.length > 0
      ? new Set(options.courseIds.map((id) => id.toLowerCase()))
      : null;
  const sinceMs =
    options.since === null || options.since === undefined
      ? NaN
      : options.since instanceof Date
        ? options.since.getTime()
        : Date.parse(options.since);
  const fullCourseSet =
    options.fullCourses && options.fullCourses.length > 0
      ? new Set(options.fullCourses.map((id) => id.toLowerCase()))
      : null;
  const coursesDir = path.join(getDataDir(), 'courses');

  const fileList: { absPath: string; relPath: string }[] = [];
  let courseCount = 0;

  const collectCourseFiles = (
    absDir: string,
    relPrefix: string,
    entries: { absPath: string; relPath: string }[],
    full: boolean
  ): void => {
    for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
      const isAllowedDot =
        entry.name === '.manifest.json' ||
        entry.name === '.checkpoints.json' ||
        entry.name === '.annotations.json';
      if ((entry.name.startsWith('.') && !isAllowedDot) || entry.name === '_backup') continue;
      const absPath = path.join(absDir, entry.name);
      const relPath = `${relPrefix}/${entry.name}`;
      if (entry.isDirectory()) {
        collectCourseFiles(absPath, relPath, entries, full);
      } else if (entry.isFile()) {
        // Manifests are handled separately in incremental mode (included
        // whenever the course has any real change, not by their own mtime).
        if (!full && Number.isFinite(sinceMs) && /(?:^|\/)\.manifest\.json$/i.test(relPath)) {
          continue;
        }
        if (!full && Number.isFinite(sinceMs)) {
          try {
            if (fs.statSync(absPath).mtimeMs <= sinceMs) continue;
          } catch {
            continue;
          }
        }
        entries.push({ absPath, relPath });
      }
    }
  };

  if (fs.existsSync(coursesDir)) {
    for (const dir of fs.readdirSync(coursesDir, { withFileTypes: true })) {
      if (!dir.isDirectory() || dir.name.startsWith('.') || dir.name === '_backup') continue;
      const courseFolder = path.join(coursesDir, dir.name);

      // Prefer the manifest id (lowercased) for the entry prefix.
      let courseId = dir.name.toLowerCase();
      const manifestPath = path.join(courseFolder, '.manifest.json');
      if (fs.existsSync(manifestPath)) {
        try {
          const id = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))?.id;
          if (typeof id === 'string' && id.trim()) {
            courseId = id.toLowerCase();
          }
        } catch {}
      }
      if (wanted && !wanted.has(courseId)) continue;
      // No cursor = full sync; with a cursor, courses listed in fullCourses
      // ignore it (device never received them / explicit full re-download).
      const full = !Number.isFinite(sinceMs) || Boolean(fullCourseSet?.has(courseId));

      const courseEntries: { absPath: string; relPath: string }[] = [];
      collectCourseFiles(courseFolder, `courses/${courseId}`, courseEntries, full);
      if (courseEntries.length === 0) {
        continue; // incremental sync: nothing changed in this course
      }
      if (!full && Number.isFinite(sinceMs)) {
        const manifestPath = path.join(courseFolder, '.manifest.json');
        if (fs.existsSync(manifestPath)) {
          courseEntries.unshift({
            absPath: manifestPath,
            relPath: `courses/${courseId}/.manifest.json`
          });
        }
      }

      courseCount++;
      fileList.push(...courseEntries);
    }
  }

  if (options.syncMeta !== undefined) {
    fileList.push({
      absPath: '',
      relPath: '_sync/meta.json'
    });
  }

  const totalFiles = fileList.length;
  console.log(
    `[SyncServer] Zip bundle: ${totalFiles} file(s) across ${courseCount} course(s)` +
      (Number.isFinite(sinceMs) ? ` (incremental since ${new Date(sinceMs).toISOString()})` : '')
  );

  let zip: Zip;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      zip = new Zip((err, chunk, isLast) => {
        if (err) {
          console.error('[SyncServer] Zip bundle compression error:', err);
          controller.error(err);
          return;
        }
        if (chunk && chunk.length > 0) {
          controller.enqueue(chunk);
        }
        if (isLast) {
          controller.close();
        }
      });

      (async () => {
        try {
          let lastCourse: string | null = null;
          for (let i = 0; i < fileList.length; i++) {
            const { absPath, relPath } = fileList[i];
            const data =
              relPath === '_sync/meta.json'
                ? new TextEncoder().encode(JSON.stringify(options.syncMeta))
                : new Uint8Array(fs.readFileSync(absPath));
            const textDeflateLevel = options.deflateLevel ?? (Number.isFinite(sinceMs) ? 6 : 1);
            const file = ALREADY_COMPRESSED.test(relPath)
              ? new ZipPassThrough(relPath)
              : new ZipDeflate(relPath, { level: textDeflateLevel });
            zip.add(file);
            file.push(data, true);

            if (options.onProgress) {
              const courseId = relPath.startsWith('courses/') ? relPath.split('/')[1] ?? null : null;
              if (courseId !== lastCourse || i % 20 === 0) {
                if (courseId && courseId !== lastCourse) {
                  lastCourse = courseId;
                }
                options.onProgress({
                  courseId,
                  current: i + 1,
                  total: totalFiles,
                  currentFile: relPath
                });
              }
            }

            // Yield regularly so concurrent server work is never blocked.
            if (i % 20 === 0) await new Promise((r) => setTimeout(r, 0));
          }
          zip.end();
        } catch (pumpErr) {
          controller.error(pumpErr);
        }
      })();
    }
  });

  return { stream, courseCount, fileCount: totalFiles };
}

/**
 * Synchronous backup generator maintained for legacy compatibility and offline scripts.
 * Uses smart pass-through for pre-compressed binaries to prevent slow CPU locks.
 */
export function createDataBackupZip(options: BackupOptions = {}): {
  buffer: Buffer;
  filename: string;
  courseCount: number;
  fileCount: number;
} {
  const includeRawArchives = options.includeRawArchives === true;
  const dataDir = getDataDir();
  const files: Record<string, [Uint8Array, { level: number }]> = {};

  let fileCount = 0;
  let courseCount = 0;

  const addTree = (absDir: string, relPrefix: string): void => {
    if (!fs.existsSync(absDir)) return;
    for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
      const absPath = path.join(absDir, entry.name);
      const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.name === '_sync-tmp') continue;
      if (!includeRawArchives && entry.name === '_backup') continue;
      if (entry.isDirectory()) {
        addTree(absPath, relPath);
        if (relPrefix === '' && entry.name === 'courses') {
          const courses = fs.readdirSync(absPath, { withFileTypes: true });
          courseCount = courses.filter((c) => c.isDirectory()).length;
        }
      } else if (entry.isFile()) {
        const isCompressed = ALREADY_COMPRESSED.test(entry.name);
        files[relPath] = [new Uint8Array(fs.readFileSync(absPath)), { level: isCompressed ? 0 : 1 }];
        fileCount++;
      }
    }
  };

  addTree(dataDir, '');

  const today = new Date().toISOString().split('T')[0];
  const filename = `app-study-tool-backup-${today}.zip`;
  const buffer = Buffer.from(zipSync(files as any));

  return { buffer, filename, courseCount, fileCount };
}

export interface RestoreProgress {
  current: number;
  total: number;
  percent: number;
  currentFile: string;
  status: string;
}

/**
 * Safely extracts a zip archive into the active data directory.
 * Defends against Zip Slip by ensuring all destination paths stay inside target directory.
 * Supports progress callbacks, normalizes Windows backslashes, ignores macOS metadata,
 * and yields to the event loop regularly so other tasks and HTTP streams do not stall.
 */
export async function restoreDataBackupZip(
  buffer: Buffer,
  customTargetDir?: string,
  onProgress?: (progress: RestoreProgress) => void
): Promise<RestoreResult> {
  const targetDir = customTargetDir || getDataDir();
  fs.mkdirSync(targetDir, { recursive: true });

  const totalMb = (buffer.length / 1024 / 1024).toFixed(1);
  console.log(`[Backup Import] Unpacking ${totalMb} MB archive into ${targetDir}...`);
  onProgress?.({
    current: 0,
    total: 0,
    percent: 0,
    currentFile: '',
    status: 'Decompressing archive...'
  });

  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(new Uint8Array(buffer));
  } catch (err) {
    console.error('[Backup Import Error] unzipSync failed:', err);
    throw new Error(`Invalid or corrupted zip archive: ${err instanceof Error ? err.message : String(err)}`);
  }

  const allEntries = Object.entries(entries);
  const validFiles = allEntries.filter(([name]) => {
    if (name.endsWith('/')) return false;
    const clean = name.replace(/\\/g, '/').replace(/^\/+/, '');
    if (
      clean.startsWith('__MACOSX/') ||
      clean.includes('/__MACOSX/') ||
      clean.endsWith('/.DS_Store') ||
      clean === '.DS_Store'
    ) {
      return false;
    }
    return true;
  });

  const totalFiles = validFiles.length;
  console.log(`[Backup Import] Found ${totalFiles} file(s) to restore.`);
  let filesRestored = 0;

  for (let i = 0; i < validFiles.length; i++) {
    const [entryName, data] = validFiles[i];

    // Normalize Windows backslashes and defend against Zip Slip
    const cleanName = entryName.replace(/\\/g, '/').replace(/^\/+/, '');
    let destinationPath: string;
    try {
      destinationPath = safeJoin(targetDir, cleanName);
    } catch (slipErr) {
      console.warn(`[Backup Import] Skipping unsafe zip entry "${entryName}":`, slipErr);
      continue;
    }

    if (fs.existsSync(destinationPath) && fs.statSync(destinationPath).isDirectory()) {
      continue;
    }

    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    fs.writeFileSync(destinationPath, Buffer.from(data));
    filesRestored++;

    if (i % 20 === 0 || i === validFiles.length - 1) {
      const percent = totalFiles > 0 ? Math.round(((i + 1) / totalFiles) * 100) : 100;
      onProgress?.({
        current: i + 1,
        total: totalFiles,
        percent,
        currentFile: cleanName,
        status: `Extracting ${cleanName} (${i + 1}/${totalFiles})...`
      });
      // Yield to the event loop so HTTP streams push chunks immediately
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  const coursesDir = path.join(targetDir, 'courses');
  let coursesRestored = 0;
  if (fs.existsSync(coursesDir)) {
    coursesRestored = fs.readdirSync(coursesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory()).length;
  }

  console.log(`[Backup Import] Restored ${coursesRestored} courses and ${filesRestored} files.`);

  return {
    success: true,
    coursesRestored,
    filesRestored
  };
}
