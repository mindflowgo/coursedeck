import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import type {
  ScheduleSyncProvider,
  SyncResult,
  SyncEvent,
  TargetCalendar,
  ProviderAuthStatus,
  ReconciliationStats
} from './sync.types';
import { ScheduleParser } from '../../../parser/scheduleParser';
import { parseFrontmatter } from '../../../parser/frontmatter';
import { ScheduleService } from '../schedule.service';
import { getDataDir, safeJoin } from '../../paths';

interface StoredOAuthSession {
  state: string;
  codeVerifier: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  createdAt: number;
}

interface GoogleConfigFile {
  clientId?: string;
  clientSecret?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  accountEmail?: string;
  datasetId?: string;
  oauthSessions?: StoredOAuthSession[];
}

export type GoogleCredentials = Omit<GoogleConfigFile, 'datasetId' | 'oauthSessions'>;

const DEFAULT_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/userinfo.email'
];

export class GoogleCalendarProvider implements ScheduleSyncProvider {
  readonly id = 'google' as const;
  readonly name = 'Google Calendar';

  private static readConfigFile(): GoogleConfigFile {
    const dataDir = getDataDir();
    const primary = safeJoin(dataDir, '.google_credentials.json');
    let config: GoogleConfigFile = {};

    try {
      if (fs.existsSync(primary)) {
        config = JSON.parse(fs.readFileSync(primary, 'utf8'));
      } else {
        const home = os.homedir();
        const legacyConfigDir =
          process.platform === 'win32'
            ? path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'coursedeck')
            : path.join(home, '.config', 'coursedeck');
        const legacyPath = path.join(legacyConfigDir, 'sync_credentials.json');
        if (fs.existsSync(legacyPath)) {
          config = JSON.parse(fs.readFileSync(legacyPath, 'utf8'));
        }
      }
    } catch (e) {
      console.warn('[GoogleCalendarProvider] Failed to read .google_credentials.json:', e);
    }

    let didMigrate = false;

    // Auto-migrate legacy .dataset_id file if present
    const legacyDatasetIdPath = safeJoin(dataDir, '.dataset_id');
    try {
      if (!config.datasetId && fs.existsSync(legacyDatasetIdPath)) {
        const id = fs.readFileSync(legacyDatasetIdPath, 'utf8').trim();
        if (id.length >= 8) {
          config.datasetId = id;
          didMigrate = true;
        }
        fs.unlinkSync(legacyDatasetIdPath);
      } else if (fs.existsSync(legacyDatasetIdPath)) {
        fs.unlinkSync(legacyDatasetIdPath);
      }
    } catch {}

    // Auto-migrate legacy .oauth_sessions.json if present
    const legacySessionsPath = safeJoin(dataDir, '.oauth_sessions.json');
    try {
      if (fs.existsSync(legacySessionsPath)) {
        const list = JSON.parse(fs.readFileSync(legacySessionsPath, 'utf8'));
        if (Array.isArray(list) && !config.oauthSessions) {
          config.oauthSessions = list;
          didMigrate = true;
        }
        fs.unlinkSync(legacySessionsPath);
      }
    } catch {}

    if (didMigrate) {
      this.writeConfigFile(config);
    }

    return config;
  }

  private static writeConfigFile(config: GoogleConfigFile): void {
    try {
      const p = safeJoin(getDataDir(), '.google_credentials.json');
      fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
      fs.writeFileSync(p, JSON.stringify(config, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    } catch (e) {
      console.warn('[GoogleCalendarProvider] Failed to write .google_credentials.json:', e);
    }
  }

  static loadCredentials(): GoogleCredentials {
    const config = this.readConfigFile();
    return {
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      accessToken: config.accessToken,
      refreshToken: config.refreshToken,
      expiresAt: config.expiresAt,
      accountEmail: config.accountEmail
    };
  }

  static saveCredentials(creds: Partial<GoogleCredentials>): void {
    const config = this.readConfigFile();
    if (creds.clientId !== undefined) config.clientId = creds.clientId;
    if (creds.clientSecret !== undefined) config.clientSecret = creds.clientSecret;
    if (creds.accessToken !== undefined) config.accessToken = creds.accessToken;
    if (creds.refreshToken !== undefined) config.refreshToken = creds.refreshToken;
    if (creds.expiresAt !== undefined) config.expiresAt = creds.expiresAt;
    if (creds.accountEmail !== undefined) config.accountEmail = creds.accountEmail;
    this.writeConfigFile(config);
  }

  static clearCredentials(): void {
    try {
      const config = this.readConfigFile();
      delete config.clientId;
      delete config.clientSecret;
      delete config.accessToken;
      delete config.refreshToken;
      delete config.expiresAt;
      delete config.accountEmail;
      delete config.oauthSessions;
      // Retain datasetId so events are not orphaned across re-connects
      this.writeConfigFile(config);

      try {
        const home = os.homedir();
        const legacyPath = path.join(
          process.platform === 'win32'
            ? path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'coursedeck')
            : path.join(home, '.config', 'coursedeck'),
          'sync_credentials.json'
        );
        if (fs.existsSync(legacyPath)) {
          fs.unlinkSync(legacyPath);
        }
      } catch {}
    } catch (e) {
      console.warn('[GoogleCalendarProvider] Failed to clear credentials:', e);
    }
  }

  static getDatasetId(): string {
    const config = this.readConfigFile();
    if (config.datasetId && config.datasetId.trim().length >= 8) {
      return config.datasetId.trim();
    }

    const dataDir = getDataDir();
    const newId = crypto.createHash('sha256').update(dataDir + ':' + Date.now()).digest('hex').slice(0, 8);
    config.datasetId = newId;
    this.writeConfigFile(config);
    return newId;
  }

  static async fetchWithBackoff(url: string, init?: RequestInit, maxRetries = 4): Promise<Response> {
    let attempt = 0;
    while (attempt < maxRetries) {
      try {
        const res = await fetch(url, init);

        let isRateLimit = res.status === 429;
        const isServerError = res.status >= 500;

        // Google APIs often return HTTP 403 for rate limits / quota exceeded
        if (res.status === 403) {
          try {
            const bodyPeek = await res.clone().text();
            if (
              bodyPeek.includes('rateLimitExceeded') ||
              bodyPeek.includes('userRateLimitExceeded') ||
              bodyPeek.includes('quotaExceeded') ||
              bodyPeek.toLowerCase().includes('rate limit')
            ) {
              isRateLimit = true;
            }
          } catch {}
        }

        if (isRateLimit || isServerError) {
          attempt++;
          if (attempt >= maxRetries) return res;

          const retryAfter = res.headers.get('retry-after');
          let delayMs = isRateLimit
            ? 1500 * Math.pow(2, attempt) + Math.random() * 500
            : 1000 * Math.pow(2, attempt) + Math.random() * 300;

          if (retryAfter) {
            const sec = parseInt(retryAfter, 10);
            if (!isNaN(sec) && sec > 0) delayMs = sec * 1000;
          }
          console.warn(
            `[GoogleCalendarProvider] ${isRateLimit ? 'Rate-limited (quota/burst)' : `HTTP ${res.status}`} from ${url}. Retrying in ${Math.round(delayMs)}ms (attempt ${attempt}/${maxRetries})...`
          );
          await new Promise((r) => setTimeout(r, delayMs));
          continue;
        }
        return res;
      } catch (err) {
        attempt++;
        if (attempt >= maxRetries) throw err;
        const delayMs = 1000 * Math.pow(2, attempt) + Math.random() * 300;
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
    return fetch(url, init);
  }

  private static loadOAuthSessions(): Map<string, StoredOAuthSession> {
    const map = new Map<string, StoredOAuthSession>();
    try {
      const config = this.readConfigFile();
      const list = config.oauthSessions || [];
      const now = Date.now();
      for (const item of list) {
        if (item && item.state && now - (item.createdAt || 0) < 15 * 60 * 1000) {
          map.set(item.state, item);
        }
      }
    } catch (e) {
      console.warn('[GoogleCalendarProvider] Failed to read OAuth sessions:', e);
    }
    return map;
  }

  private static saveOAuthSessions(map: Map<string, StoredOAuthSession>): void {
    try {
      const config = this.readConfigFile();
      const validSessions = Array.from(map.values());
      if (validSessions.length > 0) {
        config.oauthSessions = validSessions;
      } else {
        delete config.oauthSessions;
      }
      this.writeConfigFile(config);
    } catch (e) {
      console.warn('[GoogleCalendarProvider] Failed to write OAuth sessions:', e);
    }
  }

  static createOAuthSession(options: {
    clientId: string;
    clientSecret?: string;
    redirectUri?: string;
  }): { authUrl: string; state: string; redirectUri: string } {
    const { clientId, clientSecret } = options;
    if (!clientId || !clientId.trim()) {
      throw new Error('Google Client ID is required to start authorization.');
    }

    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    const state = crypto.randomBytes(16).toString('hex');
    const redirectUri = options.redirectUri || 'http://127.0.0.1:3182/api/sync/oauth/google/callback';

    const sessions = this.loadOAuthSessions();
    sessions.set(state, {
      state,
      codeVerifier,
      clientId: clientId.trim(),
      clientSecret: clientSecret?.trim() || undefined,
      redirectUri,
      createdAt: Date.now()
    });
    this.saveOAuthSessions(sessions);

    const params = new URLSearchParams({
      client_id: clientId.trim(),
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: DEFAULT_SCOPES.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state
    });

    const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
    return { authUrl, state, redirectUri };
  }

  static async handleOAuthCallback(
    code: string,
    state: string
  ): Promise<{ success: boolean; accountEmail?: string }> {
    const sessions = this.loadOAuthSessions();
    const session = sessions.get(state);
    if (!session) {
      throw new Error('Invalid or expired authorization state. Please restart authorization from CourseDeck.');
    }
    sessions.delete(state);
    this.saveOAuthSessions(sessions);

    const existing = this.loadCredentials();
    const effectiveSecret = session.clientSecret || existing.clientSecret;

    const bodyParams = new URLSearchParams({
      client_id: session.clientId,
      code,
      code_verifier: session.codeVerifier,
      grant_type: 'authorization_code',
      redirect_uri: session.redirectUri
    });
    if (effectiveSecret) {
      bodyParams.set('client_secret', effectiveSecret);
    }

    const tokenRes = await this.fetchWithBackoff('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: bodyParams
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      let friendlyMsg = `Google token exchange failed (${tokenRes.status}): ${errText}`;
      if (errText.includes('invalid_client')) {
        friendlyMsg = 'Google rejected the client credentials. If you created a Web application client in Google Cloud Console, a Client Secret is required. If using a Desktop client, check your Client ID.';
      } else if (errText.includes('redirect_uri_mismatch')) {
        friendlyMsg = `Redirect URI mismatch. Please ensure '${session.redirectUri}' is listed in Authorized Redirect URIs in Google Cloud Console.`;
      }
      throw new Error(friendlyMsg);
    }

    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      throw new Error('Google token response did not contain an access_token.');
    }

    let accountEmail: string | undefined;
    try {
      const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${tokenData.access_token}` }
      });
      if (userRes.ok) {
        const userData = await userRes.json();
        accountEmail = userData.email;
      }
    } catch (e) {
      console.warn('[GoogleCalendarProvider] Failed to fetch account email:', e);
    }

    this.saveCredentials({
      clientId: session.clientId,
      clientSecret: session.clientSecret || existing.clientSecret,
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token || existing.refreshToken,
      expiresAt: Date.now() + (tokenData.expires_in || 3600) * 1000,
      accountEmail: accountEmail || existing.accountEmail
    });

    return { success: true, accountEmail };
  }

  private async getValidAccessToken(): Promise<string> {
    const creds = GoogleCalendarProvider.loadCredentials();
    const now = Date.now();
    if (creds.accessToken && creds.expiresAt && creds.expiresAt > now + 60_000) {
      return creds.accessToken;
    }

    if (!creds.refreshToken || !creds.clientId) {
      throw new Error('Google Calendar is not connected. Please authenticate first.');
    }

    // Refresh the access token
    const refreshParams = new URLSearchParams({
      client_id: creds.clientId,
      refresh_token: creds.refreshToken,
      grant_type: 'refresh_token'
    });
    if (creds.clientSecret) {
      refreshParams.set('client_secret', creds.clientSecret);
    }

    const res = await GoogleCalendarProvider.fetchWithBackoff('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: refreshParams
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Failed to refresh Google token (${res.status}): ${err}`);
    }

    const data = await res.json();
    const newExpiresAt = Date.now() + (data.expires_in || 3600) * 1000;
    GoogleCalendarProvider.saveCredentials({
      accessToken: data.access_token,
      // Google omits refresh_token on refresh, keep existing!
      refreshToken: data.refresh_token || creds.refreshToken,
      expiresAt: newExpiresAt
    });

    return data.access_token;
  }

  async getAuthStatus(): Promise<ProviderAuthStatus> {
    const creds = GoogleCalendarProvider.loadCredentials();
    if (!creds.accessToken && !creds.refreshToken && !creds.clientId) {
      return { connected: false, provider: 'google', hasCredentials: false };
    }

    const isValid = Boolean(creds.refreshToken || (creds.expiresAt && creds.expiresAt > Date.now()));
    return {
      connected: isValid,
      provider: 'google',
      hasCredentials: Boolean(creds.clientId || creds.refreshToken),
      clientId: creds.clientId,
      accountEmail: creds.accountEmail || (creds.clientId ? `Client ID: ${creds.clientId.slice(0, 16)}...` : undefined),
      expiresAt: creds.expiresAt ? new Date(creds.expiresAt).toISOString() : undefined
    };
  }

  async listCalendars(): Promise<TargetCalendar[]> {
    const token = await this.getValidAccessToken();
    const res = await GoogleCalendarProvider.fetchWithBackoff('https://www.googleapis.com/calendar/v3/users/me/calendarList', {
      headers: { Authorization: `Bearer ${token}` }
    });

    if (!res.ok) {
      throw new Error(`Failed to list Google Calendars: ${res.statusText}`);
    }

    const data = await res.json();
    return (data.items || []).map((cal: any) => ({
      id: cal.id,
      name: cal.summary,
      primary: Boolean(cal.primary)
    }));
  }

  /**
   * Projects schedule sessions into deterministic SyncEvents.
   */
  projectScheduleEvents(courseId: string, options?: { defaultTime?: string; timeZone?: string }): SyncEvent[] {
    const raw = ScheduleService.getSchedule(courseId);
    if (!raw) {
      throw new Error(`No schedule found for course '${courseId}'`);
    }

    const datasetId = GoogleCalendarProvider.getDatasetId();
    const parsedFm = parseFrontmatter(raw);
    const prefs = parsedFm.frontmatter?.preferences || {};
    const parsedSchedule = ScheduleParser.parseMarkdown(parsedFm.body);

    const defaultTime = options?.defaultTime || '09:00';
    const dayTimes = prefs.dayTimes || {};
    const sessionLengthMin = prefs.sessionLengthMin || 60;
    const timeZone =
      prefs.timeZone ||
      options?.timeZone ||
      Intl.DateTimeFormat().resolvedOptions().timeZone ||
      'America/Toronto';

    const events: SyncEvent[] = [];
    const weekdayNames = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

    for (let i = 0; i < parsedSchedule.events.length; i++) {
      const ev = parsedSchedule.events[i];
      if (!ev.date || !/^\d{4}-\d{2}-\d{2}$/.test(ev.date)) continue;

      const dateObj = new Date(ev.date + 'T00:00:00');
      const dayNum = dateObj.getDay();
      const dayName = weekdayNames[dayNum];
      const preferredTime =
        dayTimes[dayName]?.[0] ||
        dayTimes[dayNum]?.[0] ||
        prefs.defaultSessionStartTime ||
        defaultTime;
      const sessionKey = `${ev.date}:${ev.lessonId || 'session'}:${ev.type || 'study'}:${i}`;

      // Deterministic ID conforming to Google Calendar [a-v0-9]{5,1024}
      const idHash = crypto
        .createHash('sha256')
        .update(`${datasetId}:${courseId.toLowerCase()}:${sessionKey}`)
        .digest('hex')
        .slice(0, 32);

      // Calculate start and end ISO
      const [hh, mm] = preferredTime.split(':').map(Number);
      const start = new Date(ev.date);
      start.setHours(hh || 9, mm || 0, 0, 0);
      const end = new Date(start.getTime() + (ev.durationMin || sessionLengthMin) * 60 * 1000);

      const title = `[${courseId.toUpperCase()}] ${ev.type ? ev.type.toUpperCase() + ': ' : ''}${ev.title || 'Study Session'}`;
      const description = `CourseDeck Study Session\nCourse: ${courseId.toUpperCase()}\nLesson: ${ev.lessonId || 'N/A'}\nDuration: ${ev.durationMin || sessionLengthMin}m\n\nGenerated by CourseDeck`;

      const contentHash = crypto
        .createHash('sha256')
        .update(`${title}|${description}|${start.toISOString()}|${end.toISOString()}`)
        .digest('hex')
        .slice(0, 16);

      events.push({
        id: idHash,
        sessionKey,
        courseId: courseId.toLowerCase(),
        title,
        description,
        startDateTime: start.toISOString(),
        endDateTime: end.toISOString(),
        timeZone,
        contentHash
      });
    }

    return events;
  }

  /**
   * Reconciles schedule with Google Calendar using paced concurrency pool and backoff.
   */
  async reconcileSchedule(
    courseId: string,
    calendarId: string = 'primary',
    options?: { defaultTime?: string; timeZone?: string }
  ): Promise<SyncResult> {
    const token = await this.getValidAccessToken();
    const datasetId = GoogleCalendarProvider.getDatasetId();
    const desiredEvents = this.projectScheduleEvents(courseId, options);

    // 1. Discover existing CourseDeck events for this course (with pagination support)
    const existingItems: any[] = [];
    let pageToken: string | undefined = undefined;

    do {
      const url = new URL(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`
      );
      url.searchParams.set('privateExtendedProperty', 'appId=coursedeck');
      url.searchParams.set('maxResults', '250');
      if (pageToken) {
        url.searchParams.set('pageToken', pageToken);
      }

      const listRes = await GoogleCalendarProvider.fetchWithBackoff(url.toString(), {
        headers: { Authorization: `Bearer ${token}` }
      });

      if (!listRes.ok) {
        throw new Error(`Failed to query existing calendar events: ${listRes.statusText}`);
      }

      const listData = await listRes.json();
      if (Array.isArray(listData.items)) {
        for (const item of listData.items) {
          const priv = item.extendedProperties?.private || {};
          if (
            priv.appId === 'coursedeck' &&
            priv.datasetId === datasetId &&
            priv.courseId === courseId.toLowerCase()
          ) {
            existingItems.push(item);
          }
        }
      }
      pageToken = listData.nextPageToken || undefined;
    } while (pageToken);

    const existingMap = new Map<string, any>();
    for (const item of existingItems) {
      existingMap.set(item.id, item);
    }

    const stats: ReconciliationStats = {
      totalDesired: desiredEvents.length,
      created: 0,
      updated: 0,
      unchanged: 0,
      deletedObsolete: 0,
      failed: 0
    };

    const errors: Array<{ eventId: string; error: string }> = [];

    // 2. Concurrency pool execution (paced at 2 workers with 60ms spacing to prevent Google burst throttling)
    const CONCURRENCY = 2;
    const PACING_DELAY_MS = 60;
    let index = 0;

    async function worker() {
      while (index < desiredEvents.length) {
        const item = desiredEvents[index++];
        const existing = existingMap.get(item.id);

        if (existing) {
          const currentHash = existing.extendedProperties?.private?.contentHash;
          if (currentHash === item.contentHash) {
            stats.unchanged++;
            continue;
          }
        }

        const payload = {
          id: item.id,
          summary: item.title,
          description: item.description,
          start: { dateTime: item.startDateTime, timeZone: item.timeZone },
          end: { dateTime: item.endDateTime, timeZone: item.timeZone },
          extendedProperties: {
            private: {
              appId: 'coursedeck',
              datasetId,
              courseId: item.courseId,
              sessionKey: item.sessionKey,
              contentHash: item.contentHash
            }
          }
        };

        try {
          if (existing) {
            // Update existing event
            const updateRes = await GoogleCalendarProvider.fetchWithBackoff(
              `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${item.id}`,
              {
                method: 'PUT',
                headers: {
                  Authorization: `Bearer ${token}`,
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload)
              }
            );

            if (updateRes.ok) {
              stats.updated++;
            } else if (updateRes.status === 404) {
              // Try insert on 404
              const insertRes = await GoogleCalendarProvider.fetchWithBackoff(
                `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
                {
                  method: 'POST',
                  headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json'
                  },
                  body: JSON.stringify(payload)
                }
              );
              if (insertRes.ok) stats.created++;
              else throw new Error(`Insert failed: ${insertRes.statusText}`);
            } else {
              throw new Error(`Update failed (${updateRes.status}): ${await updateRes.text()}`);
            }
          } else {
            // Insert new event
            const insertRes = await GoogleCalendarProvider.fetchWithBackoff(
              `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
              {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${token}`,
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify(payload)
              }
            );

            if (insertRes.ok) {
              stats.created++;
            } else if (insertRes.status === 409) {
              // Conflict: exists, fallback to PUT
              const putRes = await GoogleCalendarProvider.fetchWithBackoff(
                `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${item.id}`,
                {
                  method: 'PUT',
                  headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json'
                  },
                  body: JSON.stringify(payload)
                }
              );
              if (putRes.ok) stats.updated++;
              else throw new Error(`Conflict update failed: ${putRes.statusText}`);
            } else {
              throw new Error(`Insert failed (${insertRes.status}): ${await insertRes.text()}`);
            }
          }
        } catch (err: any) {
          stats.failed++;
          errors.push({ eventId: item.id, error: err.message });
        }

        // Pacing delay between writes
        if (PACING_DELAY_MS > 0) {
          await new Promise((r) => setTimeout(r, PACING_DELAY_MS));
        }
      }
    }

    const workers = Array.from({ length: Math.min(CONCURRENCY, desiredEvents.length) }, () => worker());
    await Promise.all(workers);

    // 3. Remove obsolete managed events for this course ONLY IF all writes succeeded
    // If any event creation or update failed (e.g. 503, rate-limit), abort obsolete deletion
    // to prevent deleting valid calendar entries during network instability.
    if (stats.failed === 0) {
      const desiredIdSet = new Set(desiredEvents.map((d) => d.id));
      for (const [existingId] of existingMap.entries()) {
        if (!desiredIdSet.has(existingId)) {
          try {
            const delRes = await GoogleCalendarProvider.fetchWithBackoff(
              `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${existingId}`,
              {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${token}` }
              }
            );
            if (delRes.ok || delRes.status === 404) {
              stats.deletedObsolete++;
            }
          } catch {}
          if (PACING_DELAY_MS > 0) {
            await new Promise((r) => setTimeout(r, PACING_DELAY_MS));
          }
        }
      }
    } else {
      console.warn(
        `[GoogleCalendarProvider] Skipping obsolete event deletion for '${courseId}' because ${stats.failed} write(s) failed.`
      );
    }

    return {
      success: stats.failed === 0,
      provider: 'google',
      courseId,
      calendarId,
      stats,
      syncedAt: new Date().toISOString(),
      errors: errors.length > 0 ? errors : undefined,
      message: `Reconciliation complete: ${stats.created} created, ${stats.updated} updated, ${stats.unchanged} unchanged, ${stats.deletedObsolete} deleted.`
    };
  }

  async cleanupCourseEvents(courseId: string, calendarId: string = 'primary'): Promise<{ deleted: number }> {
    const token = await this.getValidAccessToken();
    const datasetId = GoogleCalendarProvider.getDatasetId();
    const toDelete: any[] = [];
    let pageToken: string | undefined = undefined;

    do {
      const url = new URL(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`
      );
      url.searchParams.set('privateExtendedProperty', 'appId=coursedeck');
      url.searchParams.set('maxResults', '250');
      if (pageToken) {
        url.searchParams.set('pageToken', pageToken);
      }

      const res = await GoogleCalendarProvider.fetchWithBackoff(url.toString(), {
        headers: { Authorization: `Bearer ${token}` }
      });

      if (!res.ok) break;
      const data = await res.json();
      if (Array.isArray(data.items)) {
        for (const item of data.items) {
          const priv = item.extendedProperties?.private || {};
          if (
            priv.appId === 'coursedeck' &&
            priv.datasetId === datasetId &&
            priv.courseId === courseId.toLowerCase()
          ) {
            toDelete.push(item);
          }
        }
      }
      pageToken = data.nextPageToken || undefined;
    } while (pageToken);

    let count = 0;
    for (const item of toDelete) {
      try {
        const delRes = await GoogleCalendarProvider.fetchWithBackoff(
          `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${item.id}`,
          {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${token}` }
          }
        );
        if (delRes.ok || delRes.status === 404) count++;
      } catch {}
      await new Promise((r) => setTimeout(r, 40));
    }
    return { deleted: count };
  }
}
