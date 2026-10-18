import fs from 'node:fs';
import path from 'node:path';

/**
 * Atomically writes content to a file by writing to a temporary file first
 * and renaming it into place. Ensures that readers never see partially written files.
 */
export function atomicWriteFileSync(filePath: string, content: string | Uint8Array): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmpPath = path.join(
    dir,
    `.${path.basename(filePath)}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`
  );
  fs.writeFileSync(tmpPath, content);
  fs.renameSync(tmpPath, filePath);
}
