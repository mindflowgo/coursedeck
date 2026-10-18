import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { handleApiRequest } from '../app/src/lib/server/api';
import { getDataDir, loadAppSettings } from '../app/src/lib/server/paths';
import { handleMcpHttpRequest } from './mcp/server';
import { runMcpStdio } from './mcp/stdio';

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

function startHttpServer() {
  const PORT = parseInt(process.env.PORT || '3182', 10);
  const APP_BUILD_DIR = path.resolve(import.meta.dir, '../app/build');

  const ALLOWED_ORIGIN_RE =
    /^(https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?|https?:\/\/tauri\.localhost(:\d+)?|tauri:\/\/localhost)$/i;

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
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
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
      hostname: '127.0.0.1',
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

        // Static frontend SPA serving (only meaningful when run from the repo checkout)
        if (fs.existsSync(APP_BUILD_DIR)) {
          let reqPath = url.pathname === '/' ? '/index.html' : url.pathname;
          const safePath = path.normalize(path.join(APP_BUILD_DIR, reqPath));
          if (
            safePath.startsWith(APP_BUILD_DIR) &&
            fs.existsSync(safePath) &&
            fs.statSync(safePath).isFile()
          ) {
            const ext = path.extname(safePath).toLowerCase();
            return new Response(Bun.file(safePath), {
              headers: { 'Content-Type': STATIC_MIME[ext] || 'application/octet-stream' }
            });
          }
          const indexPath = path.join(APP_BUILD_DIR, 'index.html');
          if (fs.existsSync(indexPath)) {
            return new Response(Bun.file(indexPath), {
              headers: { 'Content-Type': 'text/html; charset=utf-8' }
            });
          }
        }

        return new Response('CourseDeck Backend running', {
          headers: { 'Content-Type': 'text/plain' }
        });
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
