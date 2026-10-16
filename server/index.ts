import fs from 'node:fs';
import path from 'node:path';
import { handleApiRequest } from '../app/src/lib/server/api';
import { getDataDir } from '../app/src/lib/server/paths';

const PORT = parseInt(process.env.PORT || '3182', 10);
const APP_BUILD_DIR = path.resolve(import.meta.dir, '../app/build');

/**
 * Compiled Bun sidecar for packaged desktop builds.
 *
 * All API logic lives in the shared `app/src/lib/server/api.ts` handler (the
 * single source of truth also used by the SvelteKit dev server); this file
 * only adds the loopback transport, CORS for the Tauri webview origins, and
 * static SPA serving for repo-checkout runs.
 *
 * The packaged webview (tauri://localhost on macOS, http://tauri.localhost on
 * Windows) and local dev browsers are the only legitimate origins; anything
 * else gets no CORS headers.
 */
const ALLOWED_ORIGIN_RE =
  /^(https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?|https?:\/\/tauri\.localhost(:\d+)?|tauri:\/\/localhost)$/i;

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('origin') || '';
  if (!origin || !ALLOWED_ORIGIN_RE.test(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, api-key, x-api-key',
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

      return new Response('ILC Study Tool Backend running', {
        headers: { 'Content-Type': 'text/plain' }
      });
    }
  });
} catch (err) {
  // Another instance (e.g. one spawned by `tauri dev`) already owns the port:
  // exit cleanly so the running instance keeps serving.
  if (err instanceof Error && /EADDRINUSE|address already in use/i.test(err.message)) {
    console.log(`[ILC Backend] Port ${PORT} already in use — another instance is serving, exiting.`);
    process.exit(0);
  }
  throw err;
}

console.log(`[ILC Backend] Running on http://127.0.0.1:${server.port}`);
console.log(`[ILC Backend] Data directory: ${getDataDir()}`);
// Only meaningful from a repo checkout: inside a compiled sidecar
// `import.meta.dir` points into the bundled executable, so the resolved path
// is not a real directory and static serving is skipped.
if (fs.existsSync(APP_BUILD_DIR)) {
  console.log(`[ILC Backend] Frontend dist: ${APP_BUILD_DIR}`);
}
