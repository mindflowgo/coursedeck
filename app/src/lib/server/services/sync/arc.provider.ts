import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type {
  ScheduleSyncProvider,
  SyncResult,
  TargetCalendar,
  ProviderAuthStatus
} from './sync.types';
import { getDataDir, safeJoin } from '../../paths';
import { ScheduleService } from '../schedule.service';
import { CourseService } from '../course.service';
import { ScheduleParser } from '../../../parser/scheduleParser';
import { parseFrontmatter } from '../../../parser/frontmatter';

export interface ArcCredentials {
  apiKey?: string;
  endpoint?: string;
}

export class ArcSyncProvider implements ScheduleSyncProvider {
  readonly id = 'arc' as const;
  readonly name = 'ARC Sync';

  private static getCredentialsPath(): string {
    try {
      return safeJoin(getDataDir(), '.arc_credentials.json');
    } catch {
      return path.join(os.tmpdir(), '.arc_credentials.json');
    }
  }

  static loadCredentials(): ArcCredentials {
    try {
      const p = this.getCredentialsPath();
      if (fs.existsSync(p)) {
        return JSON.parse(fs.readFileSync(p, 'utf8'));
      }
    } catch (e) {
      console.warn('[ArcSyncProvider] Failed to load credentials:', e);
    }
    return {};
  }

  static saveCredentials(creds: Partial<ArcCredentials>): void {
    try {
      const p = this.getCredentialsPath();
      fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
      const current = this.loadCredentials();
      const merged = { ...current, ...creds };
      fs.writeFileSync(p, JSON.stringify(merged, null, 2), { encoding: 'utf8', mode: 0o600 });
    } catch (e) {
      console.warn('[ArcSyncProvider] Failed to save credentials:', e);
    }
  }

  static clearCredentials(): void {
    try {
      const p = this.getCredentialsPath();
      if (fs.existsSync(p)) {
        fs.unlinkSync(p);
      }
    } catch (e) {
      console.warn('[ArcSyncProvider] Failed to remove credentials:', e);
    }
  }

  async getAuthStatus(): Promise<ProviderAuthStatus> {
    const creds = ArcSyncProvider.loadCredentials();
    const hasApiKey = Boolean(creds.apiKey && creds.apiKey.trim().length > 0);
    const endpoint = creds.endpoint?.trim() || (hasApiKey ? 'http://127.0.0.1:3001/v1/groups' : '');
    return {
      connected: true, // Simulation or live endpoint ready
      provider: 'arc',
      endpoint: endpoint || undefined,
      hasCredentials: hasApiKey,
      accountEmail: hasApiKey ? 'Connected' : (endpoint ? 'Endpoint configured' : 'Simulator Ready'),
      calendars: [{ id: 'arc_default', name: 'Timeflow / ARC Primary Workspace', primary: true }]
    };
  }

  async listCalendars(): Promise<TargetCalendar[]> {
    return [{ id: 'arc_default', name: 'ARC Primary Workspace', primary: true }];
  }

  /**
   * Generates ARC import markdown format from a course and its schedule.
   * Format conforms to docs/arc.md:
   * - Frontmatter with extId and optional groupId
   * - Group header with '##' and tags
   * - Group description with '>'
   * - Bullet items with '- [ ]' / '- [x]'
   * - Description content prefixed with '  | '
   * - Special adjustment variables like '%Date% YYYY-MM-DD HH:mm - HH:mm'
   */
  static generateArcMarkdown(
    courseId: string,
    options?: {
      defaultTime?: string;
      groupId?: string;
      rawSchedule?: string;
      courseTitle?: string;
      courseDescription?: string;
      tags?: string[];
      additionalVariables?: Record<string, Record<string, string>>;
      eventVariables?: Record<number, Record<string, string>>;
    }
  ): string {
    const raw = options?.rawSchedule || ScheduleService.getSchedule(courseId);
    if (!raw) {
      throw new Error(`No schedule found for course '${courseId}'`);
    }

    let courseTitle = options?.courseTitle;
    let courseDesc = options?.courseDescription;
    if (!courseTitle) {
      try {
        const course = CourseService.getCourse(courseId);
        courseTitle = course.title || courseId.toUpperCase();
        if (!courseDesc && (course as any).description) {
          courseDesc = (course as any).description;
        }
      } catch {
        courseTitle = courseId.toUpperCase();
      }
    }

    const parsedFm = parseFrontmatter(raw);
    const prefs = parsedFm.frontmatter?.preferences || {};
    const parsedSchedule = ScheduleParser.parseMarkdown(parsedFm.body);
    const rawLines = parsedFm.body.split('\n');

    const defaultTime = options?.defaultTime || prefs.defaultSessionStartTime || '09:00';
    const dayTimes = prefs.dayTimes || {};
    const sessionLengthMin = prefs.sessionLengthMin || 60;
    const weekdayNames = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

    const lines: string[] = [];

    // 1. Frontmatter
    lines.push('---');
    lines.push(`extId: ${JSON.stringify(courseId.toLowerCase())}`);
    if (options?.groupId) {
      lines.push(`groupId: ${options.groupId}`);
    }
    lines.push('---');
    lines.push('');

    // 2. Group Header
    const courseTag = `#${courseId.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
    const tags = options?.tags || [courseTag, '#ilc2026'];
    lines.push(`## ${courseId.toUpperCase()}: ${courseTitle} ${tags.join(' ')}`);

    // 3. Group Description (all lines prefixed with '>')
    if (courseDesc) {
      const descLines = courseDesc.split('\n');
      for (const dl of descLines) {
        const trimmed = dl.trim();
        if (trimmed) {
          lines.push(`> ${trimmed}`);
        }
      }
    } else if (parsedSchedule.summaryLine) {
      lines.push(`> ${parsedSchedule.summaryLine}`);
    } else {
      lines.push(`> ${courseTitle} study schedule generated by CourseDeck.`);
    }

    if (prefs.targetDate) {
      lines.push(`> - **Target Date**: ${prefs.targetDate}`);
    }
    if (prefs.studyHoursPerWeek) {
      lines.push(`> - **Study Pace**: ~${prefs.studyHoursPerWeek} hours/week`);
    }
    lines.push('');

    // 4. Session Items
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

      const [hh, mm] = preferredTime.split(':').map(Number);
      const startMin = (isNaN(hh) ? 9 : hh) * 60 + (isNaN(mm) ? 0 : mm);
      const duration = ev.durationMin || sessionLengthMin;
      const endMin = startMin + duration;

      const startH = String(Math.floor(startMin / 60) % 24).padStart(2, '0');
      const startM = String(startMin % 60).padStart(2, '0');
      const endH = String(Math.floor(endMin / 60) % 24).padStart(2, '0');
      const endM = String(endMin % 60).padStart(2, '0');
      const timeRange = `${startH}:${startM} - ${endH}:${endM}`;

      const check = ev.done ? '- [x]' : '- [ ]';
      const itemTitle = ev.title || (ev.lessonId ? `Lesson ${ev.lessonId}` : 'Study Session');

      lines.push(`${check} ${itemTitle}`);

      // Extensible special variables (emitted before regular description lines)
      const itemVariables: Record<string, string | undefined> = {
        Date: `${ev.date} ${timeRange}`,
        ...(options?.additionalVariables?.[ev.date] || {}),
        ...(options?.eventVariables?.[i] || {})
      };

      for (const [varKey, varVal] of Object.entries(itemVariables)) {
        if (varVal) {
          lines.push(`  | %${varKey}% ${varVal}`);
        }
      }

      // Extract distinct description / subtask lines from indented source
      const itemDescLines: string[] = [];
      if (typeof ev.lineIndex === 'number' && ev.lineIndex >= 0) {
        for (let j = ev.lineIndex + 1; j < rawLines.length; j++) {
          const l = rawLines[j];
          if (!l.trim()) break;
          if (/^\s{2,}|\t/.test(l)) {
            // Strip any existing bar prefix so we don't duplicate '| |'
            const clean = l.trim().replace(/^\|\s*/, '');
            if (clean) itemDescLines.push(clean);
          } else {
            break;
          }
        }
      } else if (ev.description) {
        itemDescLines.push(
          ...ev.description
            .split('\n')
            .map((s) => s.trim().replace(/^\|\s*/, ''))
            .filter(Boolean)
        );
      }

      for (const dl of itemDescLines) {
        lines.push(`  | ${dl}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  async reconcileSchedule(
    courseId: string,
    calendarId: string = 'arc_default',
    options?: {
      defaultTime?: string;
      groupId?: string;
      additionalVariables?: Record<string, Record<string, string>>;
      eventVariables?: Record<number, Record<string, string>>;
    }
  ): Promise<SyncResult> {
    const creds = ArcSyncProvider.loadCredentials();
    const raw = ScheduleService.getSchedule(courseId);
    if (!raw) {
      throw new Error(`No schedule found for course '${courseId}'`);
    }

    const arcMarkdown = ArcSyncProvider.generateArcMarkdown(courseId, options);

    // Initial simulation of syncing to ARC
    console.log('\n================== [ARC SYNC SIMULATION] ==================');
    console.log(arcMarkdown);
    console.log('===========================================================\n');

    const parsedFm = parseFrontmatter(raw);
    const parsedSchedule = ScheduleParser.parseMarkdown(parsedFm.body);
    const validEvents = parsedSchedule.events.filter((e) => e.date && /^\d{4}-\d{2}-\d{2}$/.test(e.date));

    // If a REST endpoint is configured or an API key is present, execute the live HTTP POST
    const effectiveEndpoint = creds.endpoint?.trim() || (creds.apiKey ? 'http://127.0.0.1:3001/v1/groups' : '');
    if (effectiveEndpoint && effectiveEndpoint.startsWith('http')) {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json'
      };
      if (creds.apiKey) {
        headers['Authorization'] = `Bearer ${creds.apiKey.trim()}`;
      }

      const bodyPayload = {
        extId: courseId.toLowerCase(),
        groupId: options?.groupId,
        markdown: arcMarkdown,
        itemCount: validEvents.length
      };

      console.log('\n================== [TIMEFLOW POST REQUEST] ==================');
      console.log(`[ArcSyncProvider] URL:     ${effectiveEndpoint}`);
      console.log(`[ArcSyncProvider] API Key: ${creds.apiKey || '(none)'}`);
      console.log(`[ArcSyncProvider] Headers:`, JSON.stringify(headers, null, 2));
      console.log(`[ArcSyncProvider] Payload summary: extId=${bodyPayload.extId}, groupId=${bodyPayload.groupId || '(auto)'}, itemCount=${bodyPayload.itemCount}, markdownLength=${arcMarkdown.length}`);
      console.log(`[ArcSyncProvider] Markdown snippet:\n${arcMarkdown.slice(0, 300)}...`);
      console.log('=============================================================\n');

      try {
        const res = await fetch(effectiveEndpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(bodyPayload)
        });

        if (!res.ok) {
          const errText = await res.text().catch(() => res.statusText);
          console.error(`[ArcSyncProvider] HTTP ${res.status} Error from Timeflow at ${effectiveEndpoint}`);
          console.error(`[ArcSyncProvider] API Key used: ${creds.apiKey}`);
          console.error(`[ArcSyncProvider] Response body:`, errText);
          throw new Error(`Timeflow endpoint returned HTTP ${res.status}: ${errText}`);
        }

        const data = (await res.json().catch(() => ({}))) as Record<string, any>;
        const createdCount = typeof data.itemsCount === 'number' ? data.itemsCount : validEvents.length;
        const calendarCount = typeof data.calendarCount === 'number' ? data.calendarCount : validEvents.length;
        const groupTitle = data.title || courseId.toUpperCase();

        return {
          success: true,
          provider: 'arc',
          courseId,
          calendarId,
          stats: {
            totalDesired: validEvents.length,
            created: createdCount,
            updated: 0,
            unchanged: 0,
            deletedObsolete: 0,
            failed: 0
          },
          syncedAt: new Date().toISOString(),
          message: `Schedule pushed successfully to Timeflow for "${groupTitle}" with ${createdCount} items and ${calendarCount} calendar triggers (${effectiveEndpoint}).`
        };
      } catch (err: any) {
        console.error('[ArcSyncProvider] REST POST failed:', err);
        throw new Error(`Failed to POST schedule to Timeflow at ${effectiveEndpoint}: ${err.message}`);
      }
    }

    // Default simulation result
    return {
      success: true,
      provider: 'arc',
      courseId,
      calendarId,
      stats: {
        totalDesired: validEvents.length,
        created: validEvents.length,
        updated: 0,
        unchanged: 0,
        deletedObsolete: 0,
        failed: 0
      },
      syncedAt: new Date().toISOString(),
      message: `ARC Sync Simulation: Generated ${validEvents.length} items formatted for ARC import (logged to server console).`
    };
  }

  async cleanupCourseEvents(): Promise<{ deleted: number }> {
    return { deleted: 0 };
  }
}
