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

      // Skip raw zip packages in _backup if excluded
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

/**
 * Safely extracts a zip archive into the active data directory.
 * Defends against Zip Slip by ensuring all destination paths stay inside target directory.
 */
export function restoreDataBackupZip(buffer: Buffer, customTargetDir?: string): RestoreResult {
  const targetDir = customTargetDir || getDataDir();
  fs.mkdirSync(targetDir, { recursive: true });

  const entries = unzipSync(new Uint8Array(buffer));
  let filesRestored = 0;

  for (const [entryName, data] of Object.entries(entries)) {
    if (entryName.endsWith('/')) continue;

    // Defend against Zip Slip
    const cleanName = entryName.replace(/^[/\\]+/, '');
    const destinationPath = safeJoin(targetDir, cleanName);

    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    fs.writeFileSync(destinationPath, Buffer.from(data));
    filesRestored++;
  }

  const coursesDir = path.join(targetDir, 'courses');
  let coursesRestored = 0;
  if (fs.existsSync(coursesDir)) {
    coursesRestored = fs.readdirSync(coursesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory()).length;
  }

  return {
    success: true,
    coursesRestored,
    filesRestored
  };
}
