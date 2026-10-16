import { LLMService, type LLMConfig } from './llm';
import { PromptService } from './prompts';
import { CourseService, type SchedulePayloadStats } from './courses';
import { parseFrontmatter, serializeWithFrontmatter } from '../parser/frontmatter';
import { validateScheduleMarkdown } from '../parser/scheduleValidation';
import { defaultSchedulePreferences, type SchedulePreferences } from '../schedule';
import {
  buildScheduleSkeleton,
  applyEnrichmentPatches,
  verifyStructuralEquivalence,
  type SessionEnrichmentPatch
} from '../scheduleGenerator';

export interface GenerationTask {
  id: string; // e.g. "gwl3o:01.01:summary" or "gwl3o:schedule"
  courseId: string;
  lessonId: string;
  lessonTitle: string;
  tab: string;
  customPrompt?: string;
  preferences?: SchedulePreferences;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  error?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  tokensUsed?: number;
}

export interface QueueLogEntry {
  id: string;
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  message: string;
}

export interface QueueStatus {
  isRunning: boolean;
  isPaused: boolean;
  activeTask: GenerationTask | null;
  pendingCount: number;
  completedCount: number;
  failedCount: number;
  totalTasks: number;
  tasks: GenerationTask[];
  recentLogs: QueueLogEntry[];
}

function extractJsonPatches(completion: string): SessionEnrichmentPatch[] {
  try {
    const trimmed = completion.trim();
    const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    const candidate = fenceMatch ? fenceMatch[1].trim() : trimmed;
    const arrayStart = candidate.indexOf('[');
    const arrayEnd = candidate.lastIndexOf(']');
    if (arrayStart >= 0 && arrayEnd > arrayStart) {
      const parsed = JSON.parse(candidate.slice(arrayStart, arrayEnd + 1));
      if (Array.isArray(parsed)) return parsed;
    }
    const parsed = JSON.parse(candidate);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

class GenerationQueue {
  private tasks: Map<string, GenerationTask> = new Map();
  private recentLogs: QueueLogEntry[] = [];
  private isProcessing = false;
  private isPaused = false;
  private activeTaskId: string | null = null;

  /**
   * A task stuck 'processing' longer than this is treated as stalled and
   * failed so the worker can continue. A legitimate attempt is bounded by the
   * LLM client's timeout — schedule tasks ~5 minutes per attempt, everything
   * else up to the configured Request Timeout (max 150s) × retries — so 15
   * minutes leaves a wide safety margin.
   */
  private static readonly STALE_PROCESSING_MS = 15 * 60 * 1000;

  constructor() {
    // Self-healing sweep: recovers the queue if a worker ever wedges
    // (e.g. an LLM stream that dies in a way even the client timeout missed).
    setInterval(() => this.sweepStalledTasks(), 60_000);
  }

  addLog(level: 'info' | 'warn' | 'error', message: string) {
    const entry: QueueLogEntry = {
      id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      timestamp: new Date().toISOString(),
      level,
      message
    };
    this.recentLogs.push(entry);
    if (this.recentLogs.length > 80) {
      this.recentLogs.shift();
    }

    if (level === 'error') {
      console.error(`[Queue ${entry.timestamp.slice(11, 19)}] ${message}`);
    } else if (level === 'warn') {
      console.warn(`[Queue ${entry.timestamp.slice(11, 19)}] ${message}`);
    } else {
      console.log(`[Queue ${entry.timestamp.slice(11, 19)}] ${message}`);
    }
  }

  private makeId(courseId: string, lessonId: string, tab: string): string {
    if (tab === 'schedule') {
      return `${courseId.toLowerCase()}:schedule`;
    }
    return `${courseId.toLowerCase()}:${lessonId}:${tab}`;
  }

  /**
   * Enqueue specific tasks. The model is resolved per task at processing time
   * from the active Settings card, so queued work follows the active model.
   */
  enqueue(
    items: Array<{
      courseId: string;
      lessonId?: string;
      lessonTitle?: string;
      tab: string;
      customPrompt?: string;
      preferences?: SchedulePreferences;
    }>
  ): GenerationTask[] {
    const enqueued: GenerationTask[] = [];

    for (const item of items) {
      const lessonId = item.lessonId || (item.tab === 'schedule' ? 'schedule' : '');
      const lessonTitle = item.lessonTitle || (item.tab === 'schedule' ? 'Course Schedule' : lessonId);
      const id = this.makeId(item.courseId, lessonId, item.tab);
      const existing = this.tasks.get(id);

      // If already pending or processing, don't duplicate
      if (existing && (existing.status === 'pending' || existing.status === 'processing')) {
        continue;
      }

      const task: GenerationTask = {
        id,
        courseId: item.courseId.toLowerCase(),
        lessonId,
        lessonTitle,
        tab: item.tab,
        customPrompt: item.customPrompt,
        preferences: item.preferences,
        status: 'pending',
        createdAt: new Date().toISOString()
      };

      this.tasks.set(id, task);
      enqueued.push(task);
    }

    this.triggerProcessing();
    return enqueued;
  }

  /**
   * Automatically scan a course and enqueue tasks for any missing / ungenerated tabs
   */
  enqueueCourseMissing(
    courseId: string,
    tabs: Array<'summary' | 'cheatsheet' | 'test'> = ['summary', 'cheatsheet', 'test']
  ): GenerationTask[] {
    const manifest = CourseService.getManifest(courseId);
    if (!manifest) return [];

    const tasksToEnqueue: Array<{
      courseId: string;
      lessonId: string;
      lessonTitle: string;
      tab: 'summary' | 'cheatsheet' | 'test';
    }> = [];

    for (const unit of manifest.units) {
      for (const lesson of unit.lessons) {
        for (const tab of tabs) {
          // Counts any version file (-N included) with real content — lessons
          // that only carry versioned files are present, not missing.
          if (!CourseService.hasLessonTabContent(courseId, lesson.id, tab)) {
            tasksToEnqueue.push({
              courseId,
              lessonId: lesson.id,
              lessonTitle: lesson.title,
              tab
            });
          }
        }
      }
    }

    return this.enqueue(tasksToEnqueue);
  }

  /**
   * Get current queue state
   */
  getStatus(courseId?: string): QueueStatus {
    const all = Array.from(this.tasks.values());
    const filtered = courseId ? all.filter((t) => t.courseId === courseId.toLowerCase()) : all;

    const activeTask = this.activeTaskId ? this.tasks.get(this.activeTaskId) || null : null;
    const pendingCount = filtered.filter((t) => t.status === 'pending').length;
    const completedCount = filtered.filter((t) => t.status === 'completed').length;
    const failedCount = filtered.filter((t) => t.status === 'failed').length;

    return {
      isRunning: this.isProcessing,
      isPaused: this.isPaused,
      activeTask,
      pendingCount,
      completedCount,
      failedCount,
      totalTasks: filtered.length,
      tasks: filtered.slice(-50).reverse(), // Return recent 50
      recentLogs: this.recentLogs.slice(-40)
    };
  }

  pause(): void {
    this.isPaused = true;
    if (!this.activeTaskId) {
      this.isProcessing = false;
    }
  }

  resume(): void {
    this.isPaused = false;
    this.isProcessing = false;
    this.triggerProcessing();
  }

  cancelAll(courseId?: string): void {
    if (courseId) {
      for (const [id, task] of this.tasks.entries()) {
        if (task.courseId === courseId.toLowerCase() && task.status === 'pending') {
          this.tasks.delete(id);
        }
      }
    } else {
      for (const [id, task] of this.tasks.entries()) {
        if (task.status === 'pending') {
          this.tasks.delete(id);
        }
      }
    }
    if (!this.activeTaskId) {
      this.isProcessing = false;
    }
  }

  retryFailed(courseId?: string): void {
    for (const task of this.tasks.values()) {
      if ((!courseId || task.courseId === courseId.toLowerCase()) && task.status === 'failed') {
        task.status = 'pending';
        task.error = undefined;
      }
    }
    this.triggerProcessing();
  }

  private triggerProcessing(): void {
    if (this.isProcessing || this.isPaused) return;
    this.processNext().catch((err) => {
      console.error('[GenerationQueue Worker Error]', err);
      this.isProcessing = false;
    });
  }

  /**
   * Watchdog: fail tasks that have been 'processing' implausibly long and
   * clear a wedged isProcessing flag, then kick the worker again.
   */
  private sweepStalledTasks(): void {
    const now = Date.now();
    let changed = false;

    for (const task of this.tasks.values()) {
      if (
        task.status === 'processing' &&
        task.startedAt &&
        now - Date.parse(task.startedAt) > GenerationQueue.STALE_PROCESSING_MS
      ) {
        task.status = 'failed';
        task.error = 'Task stalled (processing for over 15 minutes) — recovered by queue watchdog';
        this.addLog('warn', `[Queue Watchdog] Marked stalled task as failed: ${task.id}`);
        if (this.activeTaskId === task.id) {
          this.activeTaskId = null;
        }
        changed = true;
      }
    }

    // Defensive unstick: worker flag set but nobody is actually processing
    if (
      this.isProcessing &&
      !this.activeTaskId &&
      !Array.from(this.tasks.values()).some((t) => t.status === 'processing')
    ) {
      this.isProcessing = false;
      changed = true;
    }

    if (changed && !this.isPaused) {
      this.triggerProcessing();
    }
  }

  private async processNext(): Promise<void> {
    if (this.isPaused) {
      this.isProcessing = false;
      this.activeTaskId = null;
      return;
    }

    // Find next pending task
    let nextTask: GenerationTask | null = null;
    for (const task of this.tasks.values()) {
      if (task.status === 'pending') {
        nextTask = task;
        break;
      }
    }

    if (!nextTask) {
      this.isProcessing = false;
      this.activeTaskId = null;
      return;
    }

    this.isProcessing = true;
    this.activeTaskId = nextTask.id;
    nextTask.status = 'processing';
    nextTask.startedAt = new Date().toISOString();
    const taskStartedAt = nextTask.startedAt;

    try {
      const config = LLMService.loadStoredConfig();
      if (!config || !config.baseUrl) {
        throw new Error('LLM not configured. Please open Settings or AI configuration modal to set up API endpoint.');
      }

      if (nextTask.tab === 'schedule') {
        const course = CourseService.getCourse(nextTask.courseId);
        if (!course) {
          throw new Error(`Course ${nextTask.courseId.toUpperCase()} not found.`);
        }

        const efforts = CourseService.computeCourseEfforts(nextTask.courseId);
        const prefs: SchedulePreferences = nextTask.preferences || defaultSchedulePreferences();

        // 1. Build deterministic schedule skeleton (instant, 100% valid calendar dates & inventory coverage)
        const skeleton = buildScheduleSkeleton(course, prefs, efforts);
        let finalMarkdown = skeleton.markdown;
        let tokensUsed: number | undefined;

        this.addLog(
          'info',
          `[Schedule] Deterministic calendar generated for ${nextTask.courseId.toUpperCase()} (${skeleton.sessions.length} sessions across preferred study days).`
        );

        // 2. Attempt lightweight LLM JSON Patch Enrichment
        try {
          let systemPrompt = PromptService.getPrompt('course_schedule_enrichment')?.content;
          if (!systemPrompt || systemPrompt.trim().length === 0) {
            systemPrompt =
              'You are an Ontario academic learning coach. Return a JSON array of session enrichment objects with "sessionKey", "title", and "description" (active-recall retrieval tasks). Output ONLY valid JSON.';
          }
          if (prefs.notes && prefs.notes.trim().length > 0) {
            systemPrompt += `\n\nStudent Notes & Focus Areas:\n${prefs.notes.trim()}`;
          }

          const enrichmentPayload = CourseService.buildEnrichmentPayload(skeleton.sessions, efforts);

          const effectiveConfig: LLMConfig = {
            ...config,
            model: config.model ? config.model.trim() : '',
            sessionId: config.sessionId || `${nextTask.courseId}-schedule`
          };

          this.addLog(
            'info',
            `\n=================== [ILC AI Request: SCHEDULE ENRICHMENT] ===================\n` +
            `Course:      ${nextTask.courseId.toUpperCase()}\n` +
            `Endpoint:    ${effectiveConfig.baseUrl}\n` +
            `Model:       ${effectiveConfig.model || '(server default)'}\n` +
            `Session ID:  ${effectiveConfig.sessionId}\n` +
            `Payload:     ${enrichmentPayload.length.toLocaleString()} chars (~${Math.round(enrichmentPayload.length / 4).toLocaleString()} tokens), ${skeleton.sessions.length} sessions to enrich\n` +
            `========================================================================`
          );

          // 120s floor gives reasoning models ample headroom without timing out
          const timeoutMs = LLMService.resolveRequestTimeoutMs(effectiveConfig, 120_000, { isFloor: true });
          const result = await LLMService.generateResult(effectiveConfig, systemPrompt, enrichmentPayload, {
            timeoutMs,
            onLog: (level, message) => this.addLog(level, message)
          });

          tokensUsed = result.usage?.total_tokens;

          const patches = extractJsonPatches(result.completion);
          if (patches.length > 0) {
            const enriched = applyEnrichmentPatches(skeleton, patches);
            if (verifyStructuralEquivalence(skeleton, enriched)) {
              finalMarkdown = enriched;
              this.addLog(
                'info',
                `[Schedule] LLM enrichment applied successfully (${patches.length} patches spliced).`
              );
            } else {
              this.addLog(
                'warn',
                `[Schedule] Enriched output failed structural equivalence gate. Retaining deterministic skeleton.`
              );
            }
          } else {
            this.addLog(
              'warn',
              `[Schedule] No valid JSON patches found in LLM response. Retaining deterministic skeleton.`
            );
          }
        } catch (enrichErr: any) {
          this.addLog(
            'warn',
            `[Schedule] LLM enrichment skipped (${enrichErr?.message || 'timeout/error'}). Retaining deterministic skeleton.`
          );
        }

        // 3. Serialize frontmatter with provenance preferences
        const parsed = parseFrontmatter(finalMarkdown.trim());
        const finalWithFrontmatter = serializeWithFrontmatter(
          {
            ...parsed.frontmatter,
            type: 'course_schedule',
            updatedAt: new Date().toISOString().split('T')[0],
            preferences: prefs
          },
          parsed.body.trim()
        );

        CourseService.saveCourseDocument(nextTask.courseId, 'schedule', finalWithFrontmatter);

        const validation = validateScheduleMarkdown(finalWithFrontmatter, course);

        nextTask.status = 'completed';
        nextTask.completedAt = new Date().toISOString();
        nextTask.tokensUsed = tokensUsed;

        const tokensInfo = tokensUsed !== undefined ? ` (tokens: ${tokensUsed})` : '';
        const warningsInfo = validation.warnings.length > 0 ? ` [${validation.warnings.length} warning(s)]` : '';
        const tookS = taskStartedAt ? Math.round((Date.now() - Date.parse(taskStartedAt)) / 1000) : null;
        this.addLog(
          'info',
          `[ILC AI Received: COURSE SCHEDULE] ${nextTask.courseId.toUpperCase()}: Generated ${finalWithFrontmatter.length.toLocaleString()} characters${tookS !== null ? ` in ${tookS}s` : ''}${tokensInfo}${warningsInfo}\n`
        );
      } else {
        const bundle = CourseService.getLessonBundle(nextTask.courseId, nextTask.lessonId);
        if (!bundle || !bundle.lesson) {
          throw new Error(`Lesson file not found for ${nextTask.courseId} / ${nextTask.lessonId}`);
        }

        // Load prompt template
        let systemPrompt = nextTask.customPrompt;
        if (!systemPrompt) {
          let promptKey = nextTask.tab;
          let promptItem = PromptService.getPrompt(promptKey);
          if (!promptItem && nextTask.tab === 'test') {
            promptItem = PromptService.getPrompt('test_kica');
          }

          systemPrompt =
            promptItem?.content ||
            `You are an expert Ontario curriculum educator. Produce a high quality ${nextTask.tab} in Markdown format.`;
        }

        const userPrompt = `Course: ${nextTask.courseId.toUpperCase()}\nLesson: ${nextTask.lessonTitle}\n\nFull Lesson Material:\n${bundle.lesson}`;

        // Use the CURRENT active settings: clean model (blank if not specified) and session_id
        const effectiveConfig: LLMConfig = {
          ...config,
          model: config.model ? config.model.trim() : '',
          sessionId: config.sessionId || `${nextTask.courseId}-${nextTask.tab}`
        };

        const systemPreview = systemPrompt.length > 250 ? systemPrompt.slice(0, 250) + '...' : systemPrompt;
        const userPreview = userPrompt.length > 250 ? userPrompt.slice(0, 250) + '...' : userPrompt;

        this.addLog(
          'info',
          `\n=================== [ILC AI Request: ${nextTask.tab.toUpperCase()}] ===================\n` +
          `Course:      ${nextTask.courseId.toUpperCase()} | Lesson: ${nextTask.lessonId} ("${nextTask.lessonTitle}")\n` +
          `Endpoint:    ${effectiveConfig.baseUrl}\n` +
          `Model:       ${effectiveConfig.model || '(server default)'}\n` +
          `Session ID:  ${effectiveConfig.sessionId}\n` +
          `Auth Header: ${effectiveConfig.apiKey ? (effectiveConfig.authHeaderType === 'api_key' ? 'api-key: ***' : 'Bearer ***') : 'None'}\n` +
          `System Prompt Preview:\n${systemPreview}\n\n` +
          `User Prompt Length: ${userPrompt.length.toLocaleString()} chars (~${Math.round(userPrompt.length / 4).toLocaleString()} tokens)\n` +
          `User Prompt Preview:\n${userPreview}\n` +
          `========================================================================`
        );

        const result = await LLMService.generateResult(effectiveConfig, systemPrompt, userPrompt, {
          onLog: (level, message) => this.addLog(level, message)
        });
        const parsed = parseFrontmatter(result.completion.trim());
        const frontmatter = {
          ...parsed.frontmatter,
          type: nextTask.tab,
          updatedAt: new Date().toISOString().split('T')[0],
          prompt: systemPrompt
        };

        const finalMarkdown = serializeWithFrontmatter(frontmatter, parsed.body.trim());

        // Save to disk
        CourseService.saveLessonTab(nextTask.courseId, nextTask.lessonId, nextTask.tab, finalMarkdown);

        nextTask.status = 'completed';
        nextTask.completedAt = new Date().toISOString();
        nextTask.tokensUsed = result.usage?.total_tokens;

        const tokensInfo = result.usage?.total_tokens !== undefined ? ` (tokens: ${result.usage.total_tokens})` : '';
        this.addLog(
          'info',
          `[ILC AI Received: ${nextTask.tab.toUpperCase()}] ${nextTask.lessonId}: Generated ${result.completion.length.toLocaleString()} characters in ${Math.round((Date.now() - Date.parse(taskStartedAt)) / 1000)}s${tokensInfo}\n`
        );
      }
    } catch (err: any) {
      nextTask.status = 'failed';
      nextTask.error = err?.message || 'Generation failed';
      this.addLog(
        'error',
        `[ILC AI Error: ${nextTask.tab.toUpperCase()}] ${nextTask.lessonId}: ${err?.message || 'Generation failed'}`
      );
    } finally {
      this.activeTaskId = null;
      if (this.isPaused) {
        this.isProcessing = false;
      } else {
        // Small breather between LLM calls to avoid aggressive rate-limits
        setTimeout(() => {
          this.processNext().catch((err) => {
            console.error('[GenerationQueue Worker Error]', err);
            this.isProcessing = false;
          });
        }, 300);
      }
    }
  }
}

export const queueManager = new GenerationQueue();
