import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Single source of truth for every server-side filesystem path.
 *
 * Two rules the rest of the server layer depends on:
 *   1. Data locations are resolved here and nowhere else, so `DATA_DIR`
 *      applies uniformly to courses, prompts and the LLM config.
 *   2. Any path built from a request-supplied identifier goes through
 *      `safeJoin()`, which proves the result stays inside the data
 *      directory instead of merely stripping `../` sequences.
 */

/** Raised when a request-supplied identifier or path escapes its allowed shape. */
export class PathValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathValidationError';
  }
}

/**
 * Identifiers we accept: start with an alphanumeric, then alphanumerics,
 * dot, underscore or dash. This covers real lesson ids (`01.01`,
 * `01.06_assign1`), course ids (`baf3m`) and prompt ids (`course_summary`),
 * while excluding separators, traversal and shell metacharacters.
 */
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

function assertId(kind: string, value: unknown): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value) || value === '.' || value === '..') {
    throw new PathValidationError(
      `Invalid ${kind}: ${JSON.stringify(typeof value === 'string' ? value : typeof value)}`
    );
  }
  return value;
}

export const assertCourseId = (value: unknown): string => assertId('course id', value);
export const assertLessonId = (value: unknown): string => assertId('lesson id', value);
export const assertPromptId = (value: unknown): string => assertId('prompt id', value);

/** Tab slugs: lowercase alphanumerics and underscores (built-ins and custom tabs alike). */
const TAB_PATTERN = /^[a-z0-9][a-z0-9_]{0,31}$/;

export function assertTab(value: unknown): string {
  if (typeof value !== 'string' || !TAB_PATTERN.test(value)) {
    throw new PathValidationError(`Invalid tab: ${JSON.stringify(value)}`);
  }
  return value;
}

export interface AppSettings {
  data_dir?: string;
  [key: string]: any;
}

let runtimeCustomDataDir: string | null = null;

/**
 * Returns the path to the application settings JSON file in OS-standard config directories.
 */
export function getAppSettingsPath(): string {
  if (process.env.APP_SETTINGS_PATH?.trim()) {
    return path.resolve(process.env.APP_SETTINGS_PATH.trim());
  }
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'com.ilc.studytool', 'settings.json');
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return path.join(appData, 'com.ilc.studytool', 'settings.json');
  }
  const configHome = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  return path.join(configHome, 'app-study-tool', 'settings.json');
}

export function loadAppSettings(): AppSettings {
  try {
    const p = getAppSettingsPath();
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    }
  } catch (e) {
    console.warn('[paths] Failed to read app settings:', e);
  }
  return {};
}

export function saveAppSettings(settings: Partial<AppSettings>): void {
  try {
    const p = getAppSettingsPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const current = loadAppSettings();
    const updated = { ...current, ...settings };
    fs.writeFileSync(p, JSON.stringify(updated, null, 2), 'utf8');
  } catch (e) {
    console.warn('[paths] Failed to write app settings:', e);
  }
}

/**
 * Returns the conventional default data directory for the host environment.
 */
export function getDefaultDataDir(): string {
  // If running in development repo, ./data or ../data is preferred
  const cwdData = path.resolve(process.cwd(), 'data');
  if (fs.existsSync(cwdData)) return cwdData;

  const parentData = path.resolve(process.cwd(), '..', 'data');
  if (fs.existsSync(parentData)) return parentData;

  // OS standard app data directory
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'com.ilc.studytool', 'data');
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return path.join(appData, 'com.ilc.studytool', 'data');
  }
  const configHome = process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  return path.join(configHome, 'app-study-tool', 'data');
}

/**
 * Resolves the root data directory, checking in order:
 *   1. Explicit runtime override (set in current process)
 *   2. `DATA_DIR` environment variable
 *   3. Custom `data_dir` saved in settings.json
 *   4. Conventional default directory
 */
export function getDataDir(): string {
  if (runtimeCustomDataDir) {
    return runtimeCustomDataDir;
  }

  const fromEnv = process.env.DATA_DIR?.trim();
  if (fromEnv) {
    const resolved = path.resolve(fromEnv);
    if (fs.existsSync(resolved)) return resolved;
    console.warn(`[paths] DATA_DIR="${fromEnv}" does not exist; falling back to default.`);
  }

  const settings = loadAppSettings();
  if (settings.data_dir && typeof settings.data_dir === 'string' && settings.data_dir.trim()) {
    const resolved = path.resolve(settings.data_dir.trim());
    if (fs.existsSync(resolved)) {
      return resolved;
    }
    try {
      fs.mkdirSync(resolved, { recursive: true });
      return resolved;
    } catch (e) {
      console.warn(`[paths] Could not create configured data directory ${resolved}:`, e);
    }
  }

  const def = getDefaultDataDir();
  try {
    if (!fs.existsSync(def)) {
      fs.mkdirSync(def, { recursive: true });
    }
  } catch {}
  return def;
}

/**
 * Updates the active data directory and optionally copies existing data.
 */
export function setCustomDataDir(
  newPath: string | null | undefined,
  migrate: boolean = false
): { previousDir: string; newDir: string; migratedFiles: number } {
  const previousDir = getDataDir();
  let migratedFiles = 0;

  if (!newPath || !newPath.trim()) {
    saveAppSettings({ data_dir: undefined });
    runtimeCustomDataDir = null;
    return { previousDir, newDir: getDataDir(), migratedFiles: 0 };
  }

  const resolved = path.resolve(newPath.trim());
  fs.mkdirSync(resolved, { recursive: true });

  if (migrate && previousDir !== resolved && fs.existsSync(previousDir)) {
    const entries = fs.readdirSync(previousDir, { withFileTypes: true });
    for (const entry of entries) {
      const src = path.join(previousDir, entry.name);
      const dst = path.join(resolved, entry.name);
      if (!fs.existsSync(dst)) {
        try {
          fs.cpSync(src, dst, { recursive: true });
          migratedFiles++;
        } catch (e) {
          console.error(`[paths] Failed to migrate ${src} to ${dst}:`, e);
        }
      }
    }
  }

  saveAppSettings({ data_dir: resolved });
  runtimeCustomDataDir = resolved;

  return { previousDir, newDir: resolved, migratedFiles };
}

function calculateDirSize(dirPath: string): number {
  let total = 0;
  try {
    if (!fs.existsSync(dirPath)) return 0;
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        total += calculateDirSize(full);
      } else if (entry.isFile()) {
        total += fs.statSync(full).size;
      }
    }
  } catch {}
  return total;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

export function getDataStorageInfo(): {
  dataDir: string;
  defaultDataDir: string;
  isCustom: boolean;
  courseCount: number;
  coursesCount: number;
  totalSize: number;
  totalSizeBytes: number;
  totalSizeFormatted: string;
} {
  const activeDir = getDataDir();
  const defaultDir = getDefaultDataDir();
  const isCustom = path.resolve(activeDir) !== path.resolve(defaultDir);

  const coursesDir = path.join(activeDir, 'courses');
  let coursesCount = 0;
  if (fs.existsSync(coursesDir)) {
    coursesCount = fs.readdirSync(coursesDir, { withFileTypes: true }).filter((d) => d.isDirectory()).length;
  }

  const totalSizeBytes = calculateDirSize(activeDir);
  const totalSizeFormatted = formatBytes(totalSizeBytes);

  return {
    dataDir: activeDir,
    defaultDataDir: defaultDir,
    isCustom,
    courseCount: coursesCount,
    coursesCount,
    totalSize: totalSizeBytes,
    totalSizeBytes,
    totalSizeFormatted
  };
}

export function getCoursesDir(): string {
  return path.join(getDataDir(), 'courses');
}

export function getPromptsDir(): string {
  return path.join(getDataDir(), 'prompts');
}

export function getLlmConfigPath(): string {
  return path.join(getDataDir(), 'llm_config.json');
}

/**
 * Joins `segments` onto `baseDir` and guarantees the result stays inside it.
 *
 * `path.normalize` alone is not enough: stripping leading `../` misses
 * traversal that reappears mid-path, and `path.join` happily discards an
 * earlier segment when a later one is absolute. Resolving and then comparing
 * against the base is the check that actually holds.
 */
export function safeJoin(baseDir: string, ...segments: string[]): string {
  const base = path.resolve(baseDir);
  const target = path.resolve(base, ...segments);
  const relative = path.relative(base, target);

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new PathValidationError(`Path escapes its base directory: ${segments.join('/')}`);
  }

  return target;
}

/**
 * Safe variant for read-only lookups that should simply miss rather than
 * fail the request (asset probing, document existence checks).
 */
export function trySafeJoin(baseDir: string, ...segments: string[]): string | null {
  try {
    return safeJoin(baseDir, ...segments);
  } catch {
    return null;
  }
}

/** Normalises a course id the way the service layer stores it. */
export function normalizeCourseId(value: unknown): string {
  return assertCourseId(value).toLowerCase();
}

export interface McpServerInfo {
  serverPath: string;
  command: string;
  args: string[];
}

/**
 * Resolves the absolute path and stdio command args for the MCP server.
 * Prefers the real `server/index.ts` file in the repository or installation,
 * falls back to standalone compiled executable if packaged, or placeholder.
 */
export function getMcpServerInfo(): McpServerInfo {
  // 1. Explicit env override
  if (process.env.APP_SERVER_PATH && fs.existsSync(process.env.APP_SERVER_PATH)) {
    const sPath = path.resolve(process.env.APP_SERVER_PATH);
    return {
      serverPath: sPath,
      command: 'bun',
      args: ['run', sPath, '--mcp-stdio']
    };
  }

  // 2. Search upwards from process.cwd() for server/index.ts
  try {
    let curr = path.resolve(process.cwd());
    for (let i = 0; i < 5; i++) {
      const candidate = path.join(curr, 'server', 'index.ts');
      if (fs.existsSync(candidate)) {
        return {
          serverPath: candidate,
          command: 'bun',
          args: ['run', candidate, '--mcp-stdio']
        };
      }
      const parent = path.dirname(curr);
      if (parent === curr) break;
      curr = parent;
    }
  } catch {}

  // 3. Search upwards from module location if available (import.meta.url or import.meta.dir)
  try {
    let metaDir = '';
    if (typeof import.meta !== 'undefined') {
      if ((import.meta as any).dir) {
        metaDir = (import.meta as any).dir;
      } else if (import.meta.url) {
        metaDir = path.dirname(fileURLToPath(import.meta.url));
      }
    }
    if (metaDir) {
      for (let i = 0; i < 6; i++) {
        const candidate = path.join(metaDir, 'server', 'index.ts');
        if (fs.existsSync(candidate)) {
          return {
            serverPath: candidate,
            command: 'bun',
            args: ['run', candidate, '--mcp-stdio']
          };
        }
        const direct = path.join(metaDir, 'index.ts');
        if (path.basename(metaDir) === 'server' && fs.existsSync(direct)) {
          return {
            serverPath: direct,
            command: 'bun',
            args: ['run', direct, '--mcp-stdio']
          };
        }
        const parent = path.dirname(metaDir);
        if (parent === metaDir) break;
        metaDir = parent;
      }
    }
  } catch {}

  // 4. Check if current process is a standalone compiled binary
  try {
    const execPath = process.execPath;
    const basename = path.basename(execPath).toLowerCase();
    if (
      fs.existsSync(execPath) &&
      !basename.startsWith('bun') &&
      !basename.startsWith('node') &&
      !basename.startsWith('deno')
    ) {
      return {
        serverPath: execPath,
        command: execPath,
        args: ['--mcp-stdio']
      };
    }
  } catch {}

  // 5. Default fallback placeholder
  const fallback = '/path/to/app-study-tool/server/index.ts';
  return {
    serverPath: fallback,
    command: 'bun',
    args: ['run', fallback, '--mcp-stdio']
  };
}

export function getMcpServerPath(): string {
  return getMcpServerInfo().serverPath;
}