import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getDataDir, safeJoin } from '../paths';

let cachedToken: string | null = null;

export function getOrCreateMcpToken(): string {
  if (cachedToken) return cachedToken;

  const dataDir = getDataDir();
  const tokenPath = safeJoin(dataDir, '.mcp-token');

  try {
    if (fs.existsSync(tokenPath)) {
      cachedToken = fs.readFileSync(tokenPath, 'utf8').trim();
      if (cachedToken.length >= 16) {
        return cachedToken;
      }
    }
  } catch {}

  const newToken = crypto.randomBytes(24).toString('hex');
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(tokenPath, newToken, { encoding: 'utf8', mode: 0o600 });
    cachedToken = newToken;
  } catch (e) {
    console.warn('[MCP Auth] Failed to write .mcp-token file, using in-memory token:', e);
    cachedToken = newToken;
  }
  return cachedToken;
}

export function rotateMcpToken(): string {
  const dataDir = getDataDir();
  const tokenPath = safeJoin(dataDir, '.mcp-token');
  const newToken = crypto.randomBytes(24).toString('hex');
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(tokenPath, newToken, { encoding: 'utf8', mode: 0o600 });
    cachedToken = newToken;
  } catch (e) {
    console.warn('[MCP Auth] Failed to write rotated .mcp-token file:', e);
    cachedToken = newToken;
  }
  return cachedToken;
}
