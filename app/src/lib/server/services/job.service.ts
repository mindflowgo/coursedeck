import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { getDataDir, safeJoin } from '../paths';
import { atomicWriteFileSync } from '../storage';

export type JobKind = 'generate_lesson_doc' | 'generate_course_doc' | 'prompt_course';

export type JobState =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancel_requested'
  | 'cancelled'
  | 'interrupted';

export type JobResult =
  | { type: 'document'; courseId: string; lessonId?: string; tab: string; path?: string }
  | { type: 'prompt_answer'; courseId: string; answer: string; tokensUsed?: number }
  | { type: 'schedule'; courseId: string; path?: string };

export interface JobRecord {
  id: string;
  kind: JobKind;
  courseId: string;
  dedupKey?: string;
  state: JobState;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  progress?: { completed: number; total?: number; message?: string };
  result?: JobResult;
  error?: { code: string; message: string; retryable: boolean };
}

interface JobsJournal {
  version: 1;
  jobs: JobRecord[];
}

const JOBS_FILE_NAME = '.jobs.json';
const RETENTION_MS = 24 * 60 * 60 * 1000; // 24 hours

export class JobService {
  /**
   * Jobs map partitioned by normalized data directory path to prevent
   * job state leaks across dataset switches or test fixtures.
   */
  private static datasetJobs: Map<string, Map<string, JobRecord>> = new Map();

  private static getJournalPath(dir: string): string {
    return safeJoin(dir, JOBS_FILE_NAME);
  }

  private static getJobsMap(): { dir: string; map: Map<string, JobRecord> } {
    const dir = path.resolve(getDataDir());
    let map = this.datasetJobs.get(dir);
    if (!map) {
      map = new Map<string, JobRecord>();
      this.datasetJobs.set(dir, map);

      try {
        const journalPath = this.getJournalPath(dir);
        if (fs.existsSync(journalPath)) {
          const content = fs.readFileSync(journalPath, 'utf8');
          const journal: JobsJournal = JSON.parse(content);
          const now = Date.now();

          for (const job of journal.jobs || []) {
            // Any job that was running or queued before process restart is interrupted
            if (job.state === 'running' || job.state === 'queued') {
              job.state = 'interrupted';
              job.updatedAt = new Date().toISOString();
              job.error = {
                code: 'PROCESS_INTERRUPTED',
                message: 'Server process exited while job was pending or executing.',
                retryable: true
              };
            }

            // Prune jobs older than 24 hours in terminal states
            const age = now - new Date(job.createdAt).getTime();
            if (
              age < RETENTION_MS ||
              (job.state !== 'succeeded' &&
                job.state !== 'failed' &&
                job.state !== 'cancelled' &&
                job.state !== 'interrupted')
            ) {
              map.set(job.id, job);
            }
          }
        }
      } catch (e) {
        console.warn(`[JobService] Failed to load jobs journal for ${dir}:`, e);
      }
    }
    return { dir, map };
  }

  private static persist(dir: string, map: Map<string, JobRecord>): void {
    const journalPath = this.getJournalPath(dir);
    const journal: JobsJournal = {
      version: 1,
      jobs: Array.from(map.values())
    };
    atomicWriteFileSync(journalPath, JSON.stringify(journal, null, 2) + '\n');
  }

  /**
   * Enqueues or finds an active deduplicated job.
   */
  static createJob(
    kind: JobKind,
    courseId: string,
    options: {
      id?: string;
      dedupKey?: string;
      initialState?: 'queued' | 'running';
    } = {}
  ): JobRecord {
    const { dir, map } = this.getJobsMap();

    // Check for existing active job matching dedupKey
    if (options.dedupKey) {
      for (const existing of map.values()) {
        if (
          existing.kind === kind &&
          existing.courseId.toLowerCase() === courseId.toLowerCase() &&
          existing.dedupKey === options.dedupKey &&
          (existing.state === 'queued' || existing.state === 'running')
        ) {
          return existing;
        }
      }
    }

    const now = new Date().toISOString();
    const id = options.id || `job_${crypto.randomUUID().slice(0, 12)}`;
    const job: JobRecord = {
      id,
      kind,
      courseId,
      dedupKey: options.dedupKey,
      state: options.initialState || 'queued',
      createdAt: now,
      updatedAt: now,
      startedAt: options.initialState === 'running' ? now : undefined
    };

    map.set(id, job);
    this.persist(dir, map);
    return job;
  }

  static getJob(id: string): JobRecord | null {
    const { map } = this.getJobsMap();
    const direct = map.get(id);
    if (direct) return direct;

    // Check if id matches dedupKey
    for (const job of map.values()) {
      if (job.dedupKey === id) {
        return job;
      }
    }
    return null;
  }

  static listJobs(filter?: {
    courseId?: string;
    kind?: JobKind;
    state?: JobState;
  }): JobRecord[] {
    const { map } = this.getJobsMap();
    let jobs = Array.from(map.values());

    if (filter?.courseId) {
      jobs = jobs.filter((j) => j.courseId.toLowerCase() === filter.courseId!.toLowerCase());
    }
    if (filter?.kind) {
      jobs = jobs.filter((j) => j.kind === filter.kind);
    }
    if (filter?.state) {
      jobs = jobs.filter((j) => j.state === filter.state);
    }

    return jobs.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  static updateJob(
    id: string,
    patch: Partial<Omit<JobRecord, 'id' | 'kind' | 'courseId' | 'createdAt'>>
  ): JobRecord | null {
    const { dir, map } = this.getJobsMap();
    let job = map.get(id);

    if (!job) {
      for (const j of map.values()) {
        if (j.dedupKey === id) {
          job = j;
          break;
        }
      }
    }
    if (!job) return null;

    Object.assign(job, patch, { updatedAt: new Date().toISOString() });
    if (patch.state === 'succeeded' || patch.state === 'failed' || patch.state === 'cancelled') {
      job.finishedAt = new Date().toISOString();
    }
    if (patch.state === 'running' && !job.startedAt) {
      job.startedAt = new Date().toISOString();
    }

    this.persist(dir, map);
    return job;
  }

  static updateJobByDedupKey(
    dedupKey: string,
    patch: Partial<Omit<JobRecord, 'id' | 'kind' | 'courseId' | 'createdAt'>>
  ): JobRecord | null {
    return this.updateJob(dedupKey, patch);
  }

  static cancelJob(id: string): { success: boolean; state: JobState } {
    const { dir, map } = this.getJobsMap();
    const job = this.getJob(id);
    if (!job) return { success: false, state: 'failed' };

    if (job.state === 'queued') {
      job.state = 'cancelled';
      job.updatedAt = new Date().toISOString();
      job.finishedAt = new Date().toISOString();
      this.persist(dir, map);
      return { success: true, state: 'cancelled' };
    }

    if (job.state === 'running') {
      job.state = 'cancel_requested';
      job.updatedAt = new Date().toISOString();
      this.persist(dir, map);
      return { success: true, state: 'cancel_requested' };
    }

    return { success: false, state: job.state };
  }

  /** Clears memory state (primarily for unit tests). */
  static resetForTesting(): void {
    this.datasetJobs.clear();
  }
}
