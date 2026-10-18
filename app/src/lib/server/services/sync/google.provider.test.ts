import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { GoogleCalendarProvider } from './google.provider';

describe('GoogleCalendarProvider Storage Consolidation', () => {
  let testDir: string;
  let originalDataDir: string | undefined;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coursedeck-google-test-'));
    originalDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = testDir;
  });

  afterEach(() => {
    if (originalDataDir !== undefined) {
      process.env.DATA_DIR = originalDataDir;
    } else {
      delete process.env.DATA_DIR;
    }
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('stores credentials and datasetId in a single .google_credentials.json file', () => {
    const credPath = path.join(testDir, '.google_credentials.json');

    // 1. Initial save
    GoogleCalendarProvider.saveCredentials({
      clientId: 'test-client-id.apps.googleusercontent.com',
      clientSecret: 'secret-123',
      accessToken: 'access-xyz',
      refreshToken: 'refresh-abc',
      accountEmail: 'user@example.com'
    });

    expect(fs.existsSync(credPath)).toBe(true);
    const creds = GoogleCalendarProvider.loadCredentials();
    expect(creds.clientId).toBe('test-client-id.apps.googleusercontent.com');
    expect(creds.accountEmail).toBe('user@example.com');

    // 2. Fetch datasetId
    const datasetId = GoogleCalendarProvider.getDatasetId();
    expect(datasetId).toBeDefined();
    expect(datasetId.length).toBeGreaterThanOrEqual(8);

    // Verify .dataset_id file was NOT created on disk
    expect(fs.existsSync(path.join(testDir, '.dataset_id'))).toBe(false);

    // Verify datasetId is embedded inside .google_credentials.json
    const raw = JSON.parse(fs.readFileSync(credPath, 'utf8'));
    expect(raw.datasetId).toBe(datasetId);
    expect(raw.clientId).toBe('test-client-id.apps.googleusercontent.com');

    // 3. Clear credentials retains datasetId
    GoogleCalendarProvider.clearCredentials();
    const rawAfterClear = JSON.parse(fs.readFileSync(credPath, 'utf8'));
    expect(rawAfterClear.datasetId).toBe(datasetId);
    expect(rawAfterClear.clientId).toBeUndefined();
    expect(rawAfterClear.accessToken).toBeUndefined();
  });

  it('stores OAuth sessions in .google_credentials.json without creating .oauth_sessions.json', () => {
    const credPath = path.join(testDir, '.google_credentials.json');

    const session = GoogleCalendarProvider.createOAuthSession({
      clientId: 'my-client.apps.googleusercontent.com',
      clientSecret: 'my-secret'
    });

    expect(session.state).toBeDefined();
    expect(session.authUrl).toContain('accounts.google.com');

    // Verify no .oauth_sessions.json exists
    expect(fs.existsSync(path.join(testDir, '.oauth_sessions.json'))).toBe(false);

    // Verify session was recorded inside .google_credentials.json
    const raw = JSON.parse(fs.readFileSync(credPath, 'utf8'));
    expect(raw.oauthSessions).toBeDefined();
    expect(Array.isArray(raw.oauthSessions)).toBe(true);
    expect(raw.oauthSessions[0].state).toBe(session.state);
    expect(raw.oauthSessions[0].clientId).toBe('my-client.apps.googleusercontent.com');
  });

  it('automatically migrates legacy .dataset_id and .oauth_sessions.json files', () => {
    const legacyDatasetPath = path.join(testDir, '.dataset_id');
    const legacySessionsPath = path.join(testDir, '.oauth_sessions.json');
    const credPath = path.join(testDir, '.google_credentials.json');

    fs.writeFileSync(legacyDatasetPath, 'legacy_dataset_12345', 'utf8');
    fs.writeFileSync(
      legacySessionsPath,
      JSON.stringify([
        {
          state: 'state999',
          codeVerifier: 'verifier999',
          clientId: 'client999',
          redirectUri: 'http://127.0.0.1:3182/callback',
          createdAt: Date.now()
        }
      ]),
      'utf8'
    );

    // Call getDatasetId to trigger read/migration
    const id = GoogleCalendarProvider.getDatasetId();
    expect(id).toBe('legacy_dataset_12345');

    // Legacy files should be removed
    expect(fs.existsSync(legacyDatasetPath)).toBe(false);
    expect(fs.existsSync(legacySessionsPath)).toBe(false);

    // Everything consolidated in .google_credentials.json
    const raw = JSON.parse(fs.readFileSync(credPath, 'utf8'));
    expect(raw.datasetId).toBe('legacy_dataset_12345');
    expect(raw.oauthSessions[0].state).toBe('state999');
  });

  it('retries when Google returns 403 with userRateLimitExceeded error', async () => {
    let callCount = 0;
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async (url: any, init: any) => {
      callCount++;
      if (callCount === 1) {
        return new Response(
          JSON.stringify({
            error: {
              errors: [{ domain: 'usageLimits', reason: 'userRateLimitExceeded', message: 'User Rate Limit Exceeded' }],
              code: 403,
              message: 'User Rate Limit Exceeded'
            }
          }),
          { status: 403, headers: { 'Content-Type': 'application/json', 'retry-after': '1' } }
        );
      }
      return new Response(JSON.stringify({ id: 'created_event_123' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }) as any;

    try {
      const res = await GoogleCalendarProvider.fetchWithBackoff('https://example.com/calendar/test', undefined, 3);
      expect(res.status).toBe(200);
      expect(callCount).toBe(2);
      const data = await res.json();
      expect(data.id).toBe('created_event_123');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('retries on standard 429 Too Many Requests', async () => {
    let callCount = 0;
    const originalFetch = globalThis.fetch;

    globalThis.fetch = (async (url: any, init: any) => {
      callCount++;
      if (callCount === 1) {
        return new Response('Too Many Requests', { status: 429, headers: { 'retry-after': '1' } });
      }
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }) as any;

    try {
      const res = await GoogleCalendarProvider.fetchWithBackoff('https://example.com/calendar/test', undefined, 3);
      expect(res.status).toBe(200);
      expect(callCount).toBe(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

