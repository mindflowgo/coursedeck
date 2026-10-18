import { getOrCreateMcpToken, rotateMcpToken } from '../../app/src/lib/server/services/mcp.service';

export { getOrCreateMcpToken, rotateMcpToken };

const ALLOWED_ORIGIN_PATTERNS = [
  /^https?:\/\/(localhost|127\.0\.0\.1|::1|\[::1\])(:\d+)?$/i,
  /^https?:\/\/tauri\.localhost(:\d+)?$/i,
  /^tauri:\/\/localhost$/i
];

/**
 * Verifies Host, Origin, and Authorization headers for incoming HTTP MCP requests.
 */
export function authenticateMcpRequest(req: Request): { ok: boolean; status?: number; error?: string } {
  // 1. Host Validation - allow IPv4, IPv6, localhost
  const host = req.headers.get('host') || '';
  if (host && !/^(127\.0\.0\.1|localhost|::1|\[::1\])(:\d+)?$/i.test(host)) {
    return { ok: false, status: 400, error: `Invalid Host header: ${host}` };
  }

  const authHeader = req.headers.get('authorization') || req.headers.get('x-mcp-token') || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  const expectedToken = getOrCreateMcpToken();

  // If a valid token is provided, allow immediately
  if (token && token === expectedToken) {
    return { ok: true };
  }

  if (token && token !== expectedToken) {
    return { ok: false, status: 401, error: 'Invalid MCP bearer token' };
  }

  // 2. Origin Validation
  const origin = req.headers.get('origin');
  if (origin) {
    const isAllowed = ALLOWED_ORIGIN_PATTERNS.some((pattern) => pattern.test(origin));
    if (!isAllowed) {
      return { ok: false, status: 403, error: `Untrusted Origin header: ${origin}` };
    }
    return { ok: true };
  }

  // 3. Localhost loopback connection without origin or token is permitted for desktop clients
  return { ok: true };
}
