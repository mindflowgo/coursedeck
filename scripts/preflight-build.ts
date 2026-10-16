/**
 * Build preflight: a running copy of the app holds its own release binaries, so
 * Tauri's resource-copy step (`tauri-build` copies `bundle.resources` next to the
 * target dir) fails with a bare `os error 32`, and a link running at the same
 * time can report `LNK1114 ... error code 5`. Neither names the real cause.
 *
 * Probe the artifacts the build is about to overwrite — an exclusive write open
 * on Windows fails with EBUSY/EPERM for a file that is a running image — and
 * abort with a message that says what to do.
 *
 * Usage: `bun run scripts/preflight-build.ts` (the tauri build scripts call it
 * before invoking the CLI; the portable build calls `assertReleaseArtifactsWritable`).
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT_DIR = path.resolve(__dirname, '..');
const RELEASE_DIR = path.join(ROOT_DIR, 'tauri', 'target', 'release');

/** Release artifacts the build rewrites while an instance of the app may run. */
const RELEASE_ARTIFACTS = ['ilc-study-tool.exe', 'server.exe'];

/** Returns the release artifacts a running process currently holds open. */
export function lockedReleaseArtifacts(releaseDir: string = RELEASE_DIR): string[] {
  const locked: string[] = [];
  for (const name of RELEASE_ARTIFACTS) {
    const filePath = path.join(releaseDir, name);
    if (!fs.existsSync(filePath)) continue;
    try {
      // Not 'w': that would truncate. 'r+' only asks for write access.
      fs.closeSync(fs.openSync(filePath, 'r+'));
    } catch {
      locked.push(filePath);
    }
  }
  return locked;
}

/** Aborts with an actionable message when the release artifacts are locked. */
export function assertReleaseArtifactsWritable(releaseDir?: string): void {
  const locked = lockedReleaseArtifacts(releaseDir);
  if (locked.length === 0) return;
  console.error('[Build Preflight] The build cannot replace its own release binaries.');
  console.error('                 Close the running app (and any server.exe it spawned), then build');
  console.error('                 again — or clear the read-only attribute if these are not in use:');
  for (const file of locked) console.error(`                 - ${file}`);
  process.exit(1);
}

if (import.meta.main) {
  assertReleaseArtifactsWritable();
  console.log('[Build Preflight] Release artifacts are writable.');
}
