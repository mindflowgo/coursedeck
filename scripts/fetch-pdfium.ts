/**
 * Fetches precompiled PDFium binaries from bblanchon/pdfium-binaries.
 * Supports macOS (arm64/x64), Windows (x64), and iOS (device/simulator).
 *
 * Usage:
 *   bun run scripts/fetch-pdfium.ts          # fetches current platform + stages for desktop
 *   bun run scripts/fetch-pdfium.ts --all    # fetches all platforms (desktop + iOS)
 *   bun run scripts/fetch-pdfium.ts --ios    # fetches iOS frameworks and creates XCFramework
 *   bun run scripts/fetch-pdfium.ts --force  # re-downloads even if binaries already exist
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const ROOT_DIR = path.resolve(__dirname, '..');
const TAURI_BIN_DIR = path.join(ROOT_DIR, 'tauri', 'bin');
const TAURI_DIR = path.join(ROOT_DIR, 'tauri');
const TAURIPAD_FRAMEWORKS_DIR = path.join(ROOT_DIR, 'tauripad', 'gen', 'apple', 'Frameworks');

const CHROMIUM_VERSION = '8125';
const BASE_URL = `https://github.com/bblanchon/pdfium-binaries/releases/download/chromium/${CHROMIUM_VERSION}`;

interface DownloadTarget {
  name: string;
  archive: string;
  extractPath: string;
  destFile: string;
}

const DESKTOP_TARGETS: Record<string, DownloadTarget> = {
  'darwin-arm64': {
    name: 'macOS arm64',
    archive: 'pdfium-mac-arm64.tgz',
    extractPath: 'lib/libpdfium.dylib',
    destFile: path.join(TAURI_BIN_DIR, 'libpdfium.dylib')
  },
  'darwin-x64': {
    name: 'macOS x64',
    archive: 'pdfium-mac-x64.tgz',
    extractPath: 'lib/libpdfium.dylib',
    destFile: path.join(TAURI_BIN_DIR, 'libpdfium.dylib')
  },
  'win32-x64': {
    name: 'Windows x64',
    archive: 'pdfium-win-x64.tgz',
    extractPath: 'bin/pdfium.dll',
    destFile: path.join(TAURI_BIN_DIR, 'pdfium.dll')
  }
};

async function downloadAndExtract(url: string, extractSubpath: string, outDest: string) {
  const tmpDir = path.join(ROOT_DIR, '.tmp-pdfium-' + Math.random().toString(36).slice(2));
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.mkdirSync(path.dirname(outDest), { recursive: true });

  try {
    console.log(`[fetch-pdfium] Downloading ${url}...`);
    execSync(`curl -sL "${url}" | tar -xz -C "${tmpDir}"`, { stdio: 'inherit' });
    const extractedFile = path.join(tmpDir, extractSubpath);
    if (!fs.existsSync(extractedFile)) {
      throw new Error(`Expected extracted file not found: ${extractedFile}`);
    }
    fs.copyFileSync(extractedFile, outDest);
    console.log(`[fetch-pdfium] Successfully installed to ${path.relative(ROOT_DIR, outDest)}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function fetchDesktopTarget(targetKey: string, force = false) {
  const target = DESKTOP_TARGETS[targetKey];
  if (!target) {
    console.warn(`[fetch-pdfium] Unknown target: ${targetKey}`);
    return;
  }

  if (!force && fs.existsSync(target.destFile) && fs.statSync(target.destFile).size > 0) {
    console.log(`[fetch-pdfium] ${target.name} binary already present at ${path.relative(ROOT_DIR, target.destFile)} (skipping download)`);
    if (targetKey.startsWith('darwin') && process.platform === 'darwin') {
      const rootDylib = path.join(TAURI_DIR, 'libpdfium.dylib');
      if (!fs.existsSync(rootDylib)) {
        fs.copyFileSync(target.destFile, rootDylib);
      }
    }
    return;
  }

  const url = `${BASE_URL}/${target.archive}`;
  await downloadAndExtract(url, target.extractPath, target.destFile);

  // For macOS host machine, also place a copy directly in tauri/ for debug builds
  if (targetKey.startsWith('darwin') && process.platform === 'darwin') {
    const rootDylib = path.join(TAURI_DIR, 'libpdfium.dylib');
    fs.copyFileSync(target.destFile, rootDylib);
  }
}

async function fetchIosFrameworks(force = false) {
  const xcframeworkPath = path.join(TAURIPAD_FRAMEWORKS_DIR, 'pdfium.xcframework');
  if (!force && fs.existsSync(xcframeworkPath)) {
    console.log(`[fetch-pdfium] iOS framework already present at ${path.relative(ROOT_DIR, xcframeworkPath)} (skipping download)`);
    return;
  }

  console.log('[fetch-pdfium] Preparing iOS PDFium frameworks...');
  fs.mkdirSync(TAURIPAD_FRAMEWORKS_DIR, { recursive: true });

  const deviceDir = path.join(TAURIPAD_FRAMEWORKS_DIR, 'device');
  const simDir = path.join(TAURIPAD_FRAMEWORKS_DIR, 'sim');
  fs.mkdirSync(deviceDir, { recursive: true });
  fs.mkdirSync(simDir, { recursive: true });

  console.log('[fetch-pdfium] Downloading iOS device archive...');
  execSync(`curl -sL "${BASE_URL}/pdfium-ios-device-arm64.tgz" | tar -xz -C "${deviceDir}"`, {
    stdio: 'inherit'
  });

  console.log('[fetch-pdfium] Downloading iOS simulator archive...');
  execSync(`curl -sL "${BASE_URL}/pdfium-ios-simulator-arm64.tgz" | tar -xz -C "${simDir}"`, {
    stdio: 'inherit'
  });

  if (fs.existsSync(xcframeworkPath)) {
    fs.rmSync(xcframeworkPath, { recursive: true, force: true });
  }

  const deviceFw = path.join(deviceDir, 'lib', 'pdfium.framework');
  const simFw = path.join(simDir, 'lib', 'pdfium.framework');

  if (fs.existsSync(deviceFw) && fs.existsSync(simFw)) {
    console.log('[fetch-pdfium] Generating dSYMs via dsymutil...');
    const deviceDsym = path.join(deviceDir, 'lib', 'pdfium.framework.dSYM');
    const simDsym = path.join(simDir, 'lib', 'pdfium.framework.dSYM');

    if (fs.existsSync(deviceDsym)) fs.rmSync(deviceDsym, { recursive: true, force: true });
    if (fs.existsSync(simDsym)) fs.rmSync(simDsym, { recursive: true, force: true });

    try {
      execSync(`dsymutil "${path.join(deviceFw, 'pdfium')}" -o "${deviceDsym}" 2>/dev/null || true`);
      execSync(`dsymutil "${path.join(simFw, 'pdfium')}" -o "${simDsym}" 2>/dev/null || true`);
    } catch (err) {
      console.warn('[fetch-pdfium] Warning: dsymutil failed to generate dSYMs:', err);
    }

    console.log('[fetch-pdfium] Creating universal pdfium.xcframework via xcodebuild...');
    try {
      const deviceArgs = fs.existsSync(deviceDsym)
        ? `-framework "${deviceFw}" -debug-symbols "${deviceDsym}"`
        : `-framework "${deviceFw}"`;
      const simArgs = fs.existsSync(simDsym)
        ? `-framework "${simFw}" -debug-symbols "${simDsym}"`
        : `-framework "${simFw}"`;

      execSync(
        `xcodebuild -create-xcframework ${deviceArgs} ${simArgs} -output "${xcframeworkPath}"`,
        { stdio: 'inherit' }
      );
      console.log(`[fetch-pdfium] Created: ${path.relative(ROOT_DIR, xcframeworkPath)}`);
    } catch (err) {
      console.warn('[fetch-pdfium] xcodebuild failed (may need Xcode installed); leaving raw frameworks in place.', err);
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const isAll = args.includes('--all');
  const isIos = args.includes('--ios');
  const isForce = args.includes('--force');

  fs.mkdirSync(TAURI_BIN_DIR, { recursive: true });

  if (isIos || isAll) {
    await fetchIosFrameworks(isForce);
  }

  if (isAll) {
    for (const key of Object.keys(DESKTOP_TARGETS)) {
      await fetchDesktopTarget(key, isForce);
    }
  } else if (!isIos) {
    const currentKey = `${process.platform}-${process.arch}`;
    if (DESKTOP_TARGETS[currentKey]) {
      console.log(`[fetch-pdfium] Checking PDFium for current platform (${currentKey})...`);
      await fetchDesktopTarget(currentKey, isForce);
    } else {
      console.log(`[fetch-pdfium] Current platform ${currentKey} not in presets, defaulting to darwin-arm64`);
      await fetchDesktopTarget('darwin-arm64', isForce);
    }
  }

  console.log('[fetch-pdfium] Complete!');
}

main().catch((err) => {
  console.error('[fetch-pdfium] Error:', err);
  process.exit(1);
});
