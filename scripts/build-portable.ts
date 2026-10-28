/**
 * Windows portable build.
 *
 * Produces, in `tauri/target/release/bundle/portable/`:
 *  1. PRIMARY: a version-stamped folder (main exe + server.exe + README)
 *     plus a distributable .zip and .sha256 — unzip anywhere and run.
 *  2. SECONDARY: a single-file NSIS launcher (silent self-extractor) for
 *     convenience. NOTE: unsigned NSIS self-extractors are a common
 *     antivirus false-positive pattern and re-extract ~90MB on every launch;
 *     prefer distributing the zip on other machines.
 *
 * Must run on Windows (cargo MSVC toolchain + WebView2 target).
 * Usage: bun run tauri:build:portable
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { zipSync } from 'fflate';

const ROOT_DIR = path.resolve(__dirname, '..');
const TAURI_DIR = path.join(ROOT_DIR, 'tauri');
const TAURI_CONF_PATH = path.join(TAURI_DIR, 'tauri.conf.json');

// ---------------------------------------------------------------------------
// Exported helpers (unit-testable without running the build)
// ---------------------------------------------------------------------------

/** Filesystem-safe base name (no spaces) for zip/artifact names. */
export function sanitizeFileBase(name: string): string {
  return name.trim().replace(/\s+/g, '-').replace(/[^a-zA-Z0-9._-]/g, '');
}

export function portableReadmeText(productName: string, version: string): string {
  return `${productName} — Portable Edition (v${version})

HOW TO USE
  1. Unzip this folder anywhere (Desktop, USB stick, ...).
  2. Run "${productName}.exe". Keep "server.exe" and the main .exe in the
     same folder — the app spawns server.exe as its local backend.
  3. All courses and data are stored in the "data" folder next to the exe.
     To move the app to another machine: copy the whole folder, including
     "data". To back up: copy or zip the "data" folder.

REQUIREMENTS
  - Windows 10/11 64-bit
  - Microsoft WebView2 Runtime (pre-installed on current Windows 10/11;
    if the app does not start, install it from:
    https://developer.microsoft.com/microsoft-edge/webview2/)

UPDATING
  Replace everything in the folder EXCEPT the "data" folder.

TROUBLESHOOTING
  - If the window takes a moment to appear: the app waits for its local
    backend to start (usually < 1 second).
  - Backend logs: data/backend.log
`;
}

/** Recursively zips `sourceDir` into `outPath`, wrapping entries in `entryPrefix/`. */
export function zipDirectory(sourceDir: string, outPath: string, entryPrefix: string): void {
  const files: Record<string, Uint8Array> = {};
  const walk = (absDir: string, relPrefix: string): void => {
    for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
      const absPath = path.join(absDir, entry.name);
      const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(absPath, relPath);
      } else if (entry.isFile()) {
        files[relPath] = new Uint8Array(fs.readFileSync(absPath));
      }
    }
  };
  walk(sourceDir, entryPrefix);
  fs.writeFileSync(outPath, zipSync(files, { level: 6 }));
}

export function sha256File(filePath: string): string {
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(fs.readFileSync(filePath));
  return hasher.digest('hex');
}

// ---------------------------------------------------------------------------
// Build pipeline
// ---------------------------------------------------------------------------

function fail(message: string): never {
  console.error(`[Portable Build] ${message}`);
  process.exit(1);
}

function main(): void {
  if (process.platform !== 'win32') {
    console.error('[Portable Build] This script produces a Windows portable build and must run on Windows.');
    console.error(`You are on ${process.platform}. For this platform use: bun run tauri:build:mac`);
    process.exit(1);
  }

  // 1. Read product information from tauri.conf.json
  if (!fs.existsSync(TAURI_CONF_PATH)) {
    fail(`Could not find tauri.conf.json at: ${TAURI_CONF_PATH}`);
  }
  const tauriConf = JSON.parse(fs.readFileSync(TAURI_CONF_PATH, 'utf-8'));
  const productName: string = tauriConf.productName || 'CourseDeck';
  const version: string = tauriConf.version || '0.1.0';
  const fileBase = sanitizeFileBase(productName);

  console.log(`[Portable Build] Preparing portable build for ${productName} v${version}...`);

  // 2. Locate makensis.exe (for the optional single-file launcher)
  function findMakeNsis(): string | null {
    const whichCmd = 'where.exe';
    const checkPath = spawnSync(whichCmd, ['makensis'], { encoding: 'utf-8' });
    if (checkPath.status === 0 && checkPath.stdout) {
      const found = checkPath.stdout.trim().split(/\r?\n/)[0];
      if (found && fs.existsSync(found)) return found;
    }
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
      const tauriNsis = path.join(localAppData, 'tauri', 'NSIS', 'makensis.exe');
      if (fs.existsSync(tauriNsis)) return tauriNsis;
    }
    const standardPaths = [
      'C:\\Program Files (x86)\\NSIS\\makensis.exe',
      'C:\\Program Files\\NSIS\\makensis.exe'
    ];
    for (const p of standardPaths) {
      if (fs.existsSync(p)) return p;
    }
    return null;
  }

  const makensisPath = findMakeNsis();
  const wantSingleFileLauncher = makensisPath !== null;
  if (!wantSingleFileLauncher) {
    console.log('[Portable Build] makensis (NSIS) not found — skipping the optional single-file launcher (zip is the primary artifact anyway).');
  } else {
    console.log(`[Portable Build] Using NSIS compiler: ${makensisPath}`);
  }

  // 3. Ensure the backend sidecar is compiled (tauri/server.exe)
  const serverBinaryName = 'server.exe';
  const serverBinaryPath = path.join(TAURI_DIR, serverBinaryName);
  if (!fs.existsSync(serverBinaryPath)) {
    console.log(`[Portable Build] Sidecar binary not found at ${serverBinaryPath}. Compiling sidecar...`);
    const compileRes = spawnSync(
      'bun',
      ['build', '--compile', '--outfile', path.join(TAURI_DIR, 'server'), 'server/index.ts'],
      { cwd: ROOT_DIR, stdio: 'inherit' }
    );
    if (compileRes.status !== 0) {
      fail('Failed to compile server sidecar.');
    }
  }

  // 4. Build the Tauri release executable without bundling. The caller
  //    (tauri:build:portable) already built the frontend, so the config
  //    override skips beforeBuildCommand to avoid a redundant second build.
  const portableConfPath = path.join(TAURI_DIR, 'tauri.portable.conf.json');
  fs.writeFileSync(portableConfPath, JSON.stringify({ build: { beforeBuildCommand: '' } }, null, 2));
  console.log('[Portable Build] Building Tauri binary (release mode, no-bundle)...');
  const tauriBuildRes = spawnSync(
    'bunx',
    ['tauri', 'build', '--no-bundle', '--config', 'tauri.portable.conf.json'],
    { cwd: TAURI_DIR, stdio: 'inherit', shell: true }
  );
  fs.unlinkSync(portableConfPath);
  if (tauriBuildRes.status !== 0) {
    fail('Tauri build failed.');
  }

  // 5. Verify built binaries (cargo names the binary after the package, not productName)
  const releaseDir = path.join(TAURI_DIR, 'target', 'release');
  const mainExeName = 'ilc-study-tool.exe';
  const mainExePath = path.join(releaseDir, mainExeName);
  if (!fs.existsSync(mainExePath)) {
    fail(`Main executable not found at: ${mainExePath}`);
  }

  // 6. Assemble the version-stamped portable folder (PRIMARY artifact)
  const portableBundleDir = path.join(releaseDir, 'bundle', 'portable');
  fs.mkdirSync(portableBundleDir, { recursive: true });

  const folderName = `${fileBase}-${version}-portable-win-x64`;
  const unpackedAppDir = path.join(portableBundleDir, folderName);
  fs.rmSync(unpackedAppDir, { recursive: true, force: true });
  fs.mkdirSync(unpackedAppDir, { recursive: true });

  fs.copyFileSync(mainExePath, path.join(unpackedAppDir, `${productName}.exe`));
  fs.copyFileSync(serverBinaryPath, path.join(unpackedAppDir, serverBinaryName));

  const pdfiumDllPath = path.join(TAURI_DIR, 'bin', 'pdfium.dll');
  if (fs.existsSync(pdfiumDllPath)) {
    fs.copyFileSync(pdfiumDllPath, path.join(unpackedAppDir, 'pdfium.dll'));
    console.log('[Portable Build] Bundled pdfium.dll into portable directory');
  }

  fs.writeFileSync(path.join(unpackedAppDir, 'README-Portable.txt'), portableReadmeText(productName, version), 'utf-8');

  // 7. Zip + checksum (primary distribution artifact)
  const zipPath = path.join(portableBundleDir, `${folderName}.zip`);
  console.log('[Portable Build] Zipping portable folder...');
  zipDirectory(unpackedAppDir, zipPath, folderName);
  const checksum = sha256File(zipPath);
  fs.writeFileSync(`${zipPath}.sha256`, `${checksum}  ${path.basename(zipPath)}\n`, 'utf-8');

  console.log('\n========================================');
  console.log('✓ Portable Build Complete!');
  console.log(`- Portable Zip (primary): ${zipPath}`);
  console.log(`  sha256: ${checksum}`);
  console.log(`- Unpacked Folder:        ${unpackedAppDir}`);

  // 8. Optional single-file NSIS launcher (secondary; AV false-positive risk)
  if (!wantSingleFileLauncher) {
    console.log('- Single-file Launcher:   skipped (makensis not found)');
    console.log('========================================\n');
    return;
  }

  const nsisOutputDir = path.join(releaseDir, 'bundle', 'nsis');
  fs.mkdirSync(nsisOutputDir, { recursive: true });

  const portableExeName = `${fileBase}_${version}_x64-portable.exe`;
  const portableExePath = path.join(nsisOutputDir, portableExeName);
  const iconPath = path.join(TAURI_DIR, 'icons', 'icon.ico');
  const tempNsiPath = path.join(TAURI_DIR, `temp_portable_${Date.now()}.nsi`);
  const ns = (p: string) => p.replace(/\\/g, '\\\\');

  const nsiScript = `Unicode true
RequestExecutionLevel user
SilentInstall silent
AutoCloseWindow true
ShowInstDetails nevershow
SetCompressor /SOLID lzma

!include "FileFunc.nsh"
!include "LogicLib.nsh"
!insertmacro GetParameters

Name "${productName}"
OutFile "${ns(portableExePath)}"
${fs.existsSync(iconPath) ? `Icon "${ns(iconPath)}"` : ''}

VIProductVersion "${version}.0"
VIAddVersionKey "ProductName" "${productName}"
VIAddVersionKey "ProductVersion" "${version}"
VIAddVersionKey "FileVersion" "${version}.0"
VIAddVersionKey "FileDescription" "${productName} (Portable)"
VIAddVersionKey "LegalCopyright" "${productName}"
VIAddVersionKey "OriginalFilename" "${portableExeName}"

Section
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File "${ns(mainExePath)}"
  File "${ns(serverBinaryPath)}"

  \${GetParameters} $R0

  ; Launcher directory as working directory so the portable data folder
  ; resolves next to the launcher, not in the temp extraction dir
  SetOutPath "$EXEDIR"
  \${If} $R0 == ""
    ExecWait '"$PLUGINSDIR\\\\${mainExeName}"'
  \${Else}
    ExecWait '"$PLUGINSDIR\\\\${mainExeName}" $R0'
  \${EndIf}
SectionEnd
`;

  fs.writeFileSync(tempNsiPath, nsiScript, 'utf-8');

  try {
    console.log('[Portable Build] Compiling single-file portable executable with NSIS...');
    const nsisRun = spawnSync(makensisPath!, [tempNsiPath], { stdio: 'inherit' });
    if (nsisRun.status !== 0) {
      console.error('[Portable Build] makensis compilation failed (zip artifact above is still valid).');
      process.exit(1);
    }

    const friendlyCopyPath = path.join(nsisOutputDir, `${productName} Portable.exe`);
    fs.copyFileSync(portableExePath, friendlyCopyPath);

    const stats = fs.statSync(portableExePath);
    const sizeMb = (stats.size / (1024 * 1024)).toFixed(2);
    console.log(`- Single-file Launcher:   ${portableExePath} (${sizeMb} MB)`);
    console.log(`- Convenient Copy:        ${friendlyCopyPath}`);
  } finally {
    if (fs.existsSync(tempNsiPath)) {
      fs.unlinkSync(tempNsiPath);
    }
  }
  console.log('========================================\n');
}

if (import.meta.main) {
  main();
}
