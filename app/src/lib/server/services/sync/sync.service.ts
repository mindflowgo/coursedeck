import fs from 'node:fs';
import path from 'node:path';
import type { ScheduleSyncProvider, SyncResult, ProviderAuthStatus } from './sync.types';
import { GoogleCalendarProvider } from './google.provider';
import { ArcSyncProvider } from './arc.provider';
import { getDataDir, safeJoin } from '../../paths';
import { atomicWriteFileSync } from '../course.service';

export class SyncService {
  private static providers: Map<string, ScheduleSyncProvider> = new Map<string, ScheduleSyncProvider>([
    ['google', new GoogleCalendarProvider()],
    ['arc', new ArcSyncProvider()]
  ]);

  static getProvider(id: string): ScheduleSyncProvider | undefined {
    return this.providers.get(id);
  }

  static async getStatus(courseId?: string): Promise<{
    providers: Record<string, ProviderAuthStatus>;
    courseId?: string;
  }> {
    const statuses: Record<string, ProviderAuthStatus> = {};
    for (const [id, provider] of this.providers.entries()) {
      statuses[id] = await provider.getAuthStatus();
    }
    return { providers: statuses, courseId };
  }

  static async reconcile(
    providerId: string,
    courseId: string,
    calendarId: string = 'primary',
    options?: { defaultTime?: string }
  ): Promise<SyncResult> {
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new Error(`Sync provider '${providerId}' is not supported.`);
    }

    return await provider.reconcileSchedule(courseId, calendarId, options);
  }

  /**
   * Processes pending cleanup items from data/.cleanup_queue.json
   */
  static async processCleanupQueue(): Promise<{ processed: number; remaining: number }> {
    const queuePath = safeJoin(getDataDir(), '.cleanup_queue.json');
    if (!fs.existsSync(queuePath)) {
      return { processed: 0, remaining: 0 };
    }

    try {
      const content = fs.readFileSync(queuePath, 'utf8');
      const queue: Array<{ courseId: string; timestamp: string }> = JSON.parse(content);
      const remaining: typeof queue = [];
      let processed = 0;

      const google = this.providers.get('google');
      for (const item of queue) {
        try {
          if (google) {
            await google.cleanupCourseEvents(item.courseId);
          }
          processed++;
        } catch (e) {
          console.warn(`[SyncService] Failed to cleanup course ${item.courseId}:`, e);
          remaining.push(item);
        }
      }

      atomicWriteFileSync(queuePath, JSON.stringify(remaining, null, 2) + '\n');
      return { processed, remaining: remaining.length };
    } catch (e) {
      console.warn('[SyncService] Failed to process cleanup queue:', e);
      return { processed: 0, remaining: 0 };
    }
  }
}
