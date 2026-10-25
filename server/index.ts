import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { handleApiRequest } from '../app/src/lib/server/api';
import { getDataDir, loadAppSettings } from '../app/src/lib/server/paths';
import { handleMcpHttpRequest } from './mcp/server';
import { runMcpStdio } from './mcp/stdio';

if (!process.env.ILC_SERVER_PATH) {
  const scriptPath = path.resolve(import.meta.dir, 'index.ts');
  if (fs.existsSync(scriptPath)) {
    process.env.ILC_SERVER_PATH = scriptPath;
  }
}

// ── 0. Stdio Mode Check (Claude Desktop / CLI) ───────────────────────────────
// Must be evaluated BEFORE any HTTP binding or stdout logging.
if (process.argv.includes('--mcp-stdio')) {
  runMcpStdio().catch((err) => {
    console.error('[MCP Stdio Fatal Error]', err);
    process.exit(1);
  });
} else {
  startHttpServer();
}

function resolveAppBuildDir(): string | null {
  // 1. Explicit environment variable
  if (process.env.APP_BUILD_DIR) {
    const candidate = path.resolve(process.env.APP_BUILD_DIR);
    if (fs.existsSync(candidate) && fs.existsSync(path.join(candidate, 'index.html'))) {
      return candidate;
    }
  }

  // 2. Embedded inside compiled Bun binary via --asset=app/build
  try {
    const bunfsBuild = path.join(import.meta.dir, 'build');
    if (fs.existsSync(bunfsBuild) && fs.existsSync(path.join(bunfsBuild, 'index.html'))) {
      return bunfsBuild;
    }
  } catch {}

  // 3. Relative to process.cwd() (works whether run from repo root or tauri/ subdirectory)
  const cwd = process.cwd();
  const cwdCandidates = [
    path.resolve(cwd, 'app/build'),
    path.resolve(cwd, '../app/build'),
    path.resolve(cwd, 'build')
  ];
  for (const c of cwdCandidates) {
    try {
      if (fs.existsSync(c) && fs.existsSync(path.join(c, 'index.html'))) {
        return c;
      }
    } catch {}
  }

  // 4. Relative to process.execPath (for packaged desktop app / sidecars)
  try {
    const exeDir = path.dirname(process.execPath);
    const exeCandidates = [
      path.resolve(exeDir, 'app/build'),
      path.resolve(exeDir, '../app/build'),
      path.resolve(exeDir, 'build'),
      path.resolve(exeDir, '../Resources/app/build'),
      path.resolve(exeDir, 'Resources/app/build')
    ];
    for (const c of exeCandidates) {
      if (fs.existsSync(c) && fs.existsSync(path.join(c, 'index.html'))) {
        return c;
      }
    }
  } catch {}

  // 5. Relative to import.meta.dir (when running via `bun run server/index.ts`)
  try {
    const importMetaCandidate = path.resolve(import.meta.dir, '../app/build');
    if (fs.existsSync(importMetaCandidate) && fs.existsSync(path.join(importMetaCandidate, 'index.html'))) {
      return importMetaCandidate;
    }
  } catch {}

  return null;
}

function startHttpServer() {
  const PORT = parseInt(process.env.PORT || '3182', 10);
  const APP_BUILD_DIR = resolveAppBuildDir();

  const ALLOWED_ORIGIN_RE =
    /^(https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?|https?:\/\/tauri\.localhost(:\d+)?|tauri:\/\/localhost|https?:\/\/(192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(:\d+)?|https?:\/\/[\w.-]+\.local(:\d+)?)$/i;

  function corsHeaders(req: Request): Record<string, string> {
    const origin = req.headers.get('origin') || '';
    if (!origin || !ALLOWED_ORIGIN_RE.test(origin)) return {};
    return {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, api-key, x-api-key, mcp-session-id',
      Vary: 'Origin'
    };
  }

  function withCors(response: Response, req: Request): Response {
    const cors = corsHeaders(req);
    if (Object.keys(cors).length === 0) return response;
    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(cors)) {
      headers.set(key, value);
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers
    });
  }

  const STATIC_MIME: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.mjs': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.ico': 'image/x-icon'
  };

  let server: ReturnType<typeof Bun.serve>;

  try {
    server = Bun.serve({
      hostname: process.env.HOST || '0.0.0.0',
      port: PORT,
      // Backups embed the original _backup/*.zip packages and can be several
      // hundred MB; Bun's 128MB default body limit would 413 them.
      maxRequestBodySize: 1024 * 1024 * 1024,
      async fetch(req: Request) {
        const url = new URL(req.url);

        if (req.method === 'OPTIONS') {
          return new Response(null, { status: 204, headers: corsHeaders(req) });
        }

        // ── /health (Identity & Discovery Contract) ──────────────────────────
        if (url.pathname === '/health') {
          const dataDir = getDataDir();
          const datasetId = crypto.createHash('sha256').update(dataDir).digest('hex').slice(0, 8);
          return withCors(
            new Response(
              JSON.stringify({
                status: 'ok',
                app: 'coursedeck',
                version: '0.1.0',
                protocolVersion: '2025-03-26',
                datasetId,
                uptime: process.uptime()
              }),
              {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
              }
            ),
            req
          );
        }

        // ── /api/network-ip (Local LAN IP for iPad pairing) ─────────────────
        if (url.pathname === '/api/network-ip') {
          const interfaces = os.networkInterfaces();
          let localIp = '127.0.0.1';
          for (const name of Object.keys(interfaces)) {
            for (const iface of interfaces[name] || []) {
              if (iface.family === 'IPv4' && !iface.internal) {
                localIp = iface.address;
                break;
              }
            }
            if (localIp !== '127.0.0.1') break;
          }
          return withCors(
            new Response(
              JSON.stringify({ ip: localIp, port: PORT }),
              {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
              }
            ),
            req
          );
        }

        // ── /mcp (Model Context Protocol Streamable HTTP) ─────────────────────
        if (url.pathname === '/mcp' || url.pathname.startsWith('/mcp/')) {
          const settings = loadAppSettings();
          if (settings.mcp_enabled === false) {
            return withCors(
              new Response(
                JSON.stringify({
                  jsonrpc: '2.0',
                  error: { code: -32000, message: 'MCP server is disabled in Settings' }
                }),
                {
                  status: 503,
                  headers: { 'Content-Type': 'application/json' }
                }
              ),
              req
            );
          }
          return withCors(await handleMcpHttpRequest(req), req);
        }

        // ── /api/* (Existing REST APIs) ──────────────────────────────────────
        if (url.pathname.startsWith('/api/')) {
          return withCors(await handleApiRequest(req, url), req);
        }

        // ── Static frontend SPA & PWA serving ──────────────────────────────
        const appBuildDir = APP_BUILD_DIR;
        if (appBuildDir) {
          let reqPath = url.pathname === '/' ? '/index.html' : url.pathname;
          try {
            reqPath = decodeURIComponent(reqPath);
          } catch {}

          const safePath = path.normalize(path.join(appBuildDir, reqPath));
          if (
            safePath.startsWith(appBuildDir) &&
            fs.existsSync(safePath) &&
            fs.statSync(safePath).isFile()
          ) {
            const ext = path.extname(safePath).toLowerCase();
            const headers: Record<string, string> = {
              'Content-Type': STATIC_MIME[ext] || 'application/octet-stream'
            };

            if (reqPath === '/sw.js') {
              headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
              headers['Service-Worker-Allowed'] = '/';
            } else if (ext === '.html' || reqPath === '/manifest.json') {
              headers['Cache-Control'] = 'no-cache';
            } else {
              headers['Cache-Control'] = 'public, max-age=31536000, immutable';
            }

            return withCors(new Response(Bun.file(safePath), { headers }), req);
          }

          // SPA fallback: any non-file client-side route falls back to index.html
          const indexPath = path.join(appBuildDir, 'index.html');
          if (fs.existsSync(indexPath)) {
            return withCors(
              new Response(Bun.file(indexPath), {
                headers: {
                  'Content-Type': 'text/html; charset=utf-8',
                  'Cache-Control': 'no-cache'
                }
              }),
              req
            );
          }
        }

        return withCors(
          new Response('CourseDeck Backend running', {
            headers: { 'Content-Type': 'text/plain' }
          }),
          req
        );
      }
    });
  } catch (err) {
    if (err instanceof Error && /EADDRINUSE|address already in use/i.test(err.message)) {
      console.log(`[ILC Backend] Port ${PORT} already in use — another instance is serving, exiting.`);
      process.exit(0);
    }
    throw err;
  }

  console.log(`[ILC Backend] Running on http://127.0.0.1:${server.port}`);
  console.log(`[ILC Backend] Data directory: ${getDataDir()}`);
  console.log(`[ILC Backend] Frontend dist: ${APP_BUILD_DIR}`);
}
