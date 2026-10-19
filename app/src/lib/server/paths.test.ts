import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getMcpServerInfo, getMcpServerPath } from './paths';
import { handleApiRequest } from './api';

describe('MCP Server Path Resolution', () => {
  const origEnv = process.env.APP_SERVER_PATH;
  const origDataDir = process.env.DATA_DIR;
  const origSettings = process.env.APP_SETTINGS_PATH;
  let testScratch = '';

  beforeEach(() => {
    testScratch = fs.mkdtempSync(path.join(os.tmpdir(), 'app-paths-test-'));
    process.env.DATA_DIR = testScratch;
    process.env.APP_SETTINGS_PATH = path.join(testScratch, 'settings.json');
  });

  afterEach(() => {
    if (origEnv !== undefined) {
      process.env.APP_SERVER_PATH = origEnv;
    } else {
      delete process.env.APP_SERVER_PATH;
    }
    if (origDataDir !== undefined) {
      process.env.DATA_DIR = origDataDir;
    } else {
      delete process.env.DATA_DIR;
    }
    if (origSettings !== undefined) {
      process.env.APP_SETTINGS_PATH = origSettings;
    } else {
      delete process.env.APP_SETTINGS_PATH;
    }
    try {
      if (testScratch && fs.existsSync(testScratch)) {
        fs.rmSync(testScratch, { recursive: true, force: true });
      }
    } catch {}
  });

  it('locates the actual server/index.ts file in repository', () => {
    delete process.env.APP_SERVER_PATH;
    const serverPath = getMcpServerPath();
    expect(serverPath).not.toBe('/path/to/app-study-tool/server/index.ts');
    expect(serverPath.endsWith(path.join('server', 'index.ts'))).toBe(true);
    expect(fs.existsSync(serverPath)).toBe(true);

    const info = getMcpServerInfo();
    expect(info.command).toBe('bun');
    expect(info.serverPath).toBe(serverPath);
    expect(info.args).toEqual(['run', serverPath, '--mcp-stdio']);
  });

  it('respects APP_SERVER_PATH override when specified', () => {
    const tmpFile = path.join(os.tmpdir(), `test-server-${Date.now()}.ts`);
    fs.writeFileSync(tmpFile, '// test entrypoint');
    try {
      process.env.APP_SERVER_PATH = tmpFile;
      const info = getMcpServerInfo();
      expect(info.serverPath).toBe(path.resolve(tmpFile));
      expect(info.args).toEqual(['run', path.resolve(tmpFile), '--mcp-stdio']);
    } finally {
      try {
        fs.unlinkSync(tmpFile);
      } catch {}
    }
  });

  it('/api/settings/mcp GET returns serverPath, command, and args', async () => {
    const req = new Request('http://127.0.0.1:3182/api/settings/mcp', { method: 'GET' });
    const url = new URL('http://127.0.0.1:3182/api/settings/mcp');
    const res = await handleApiRequest(req, url);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.serverPath).toBeDefined();
    expect(body.serverPath).not.toBe('/path/to/app-study-tool/server/index.ts');
    expect(body.serverPath.endsWith(path.join('server', 'index.ts'))).toBe(true);
    expect(body.command).toBe('bun');
    expect(body.args).toEqual(['run', body.serverPath, '--mcp-stdio']);
  });
});
