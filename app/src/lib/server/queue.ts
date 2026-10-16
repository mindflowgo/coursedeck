import { LLMService, type LLMConfig } from './llm';
import { PromptService } from './prompts';
import { CourseService, type SchedulePayloadStats } from './courses';
import { parseFrontmatter, serializeWithFrontmatter } from '../parser/frontmatter';
import { validateScheduleMarkdown } from '../parser/scheduleValidation';
import {
  defaultSchedulePreferences,
  buildSchedulePrompt,
  stripStudentPreferencesBlock,
  type SchedulePreferences
} from '../schedule';
import {
  buildScheduleSkeleton,
  applyEnrichmentPatches,
  verifyStructuralEquivalence,
  type SessionEnrichmentPatch,
  type PlannedSession,
  type ScheduleSkeleton
} from '../scheduleGenerator';
import { ScheduleParser } from '../parser/scheduleParser';

export interface ScheduleDebugInfo {
  rruleTimeline: {
    dates: string[];
    totalSessions: number;
    markdownSkeleton: string;
    sessions: PlannedSession[];
  };
  llmRequest: {
    systemPrompt: string;
    userPrompt: string;
    model?: string;
    endpoint?: string;
  };
  llmResponse?: {
    rawCompletion: string;
    patchesCount: number;
    patches: SessionEnrichmentPatch[];
    applied: boolean;
    gatePassed: boolean;
    error?: string;
  };
}

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
  scheduleDebug?: ScheduleDebugInfo;
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

function tryParseJsonArrayOrObject(text: string): SessionEnrichmentPatch[] {
  try {
    // Strip trailing commas before closing braces/brackets
    const sanitized = text.replace(/,\s*([}\]])/g, '$1').trim();

    // Look for JSON array [ ... ]
    const arrayStart = sanitized.indexOf('[');
    const arrayEnd = sanitized.lastIndexOf(']');
    if (arrayStart >= 0 && arrayEnd > arrayStart) {
      const candidate = sanitized.slice(arrayStart, arrayEnd + 1);
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.filter(
          (p) => p && typeof p === 'object' && (p.sessionKey || p.title || p.description)
        );
      }
    }

    // Look for JSON object { ... }
    const objStart = sanitized.indexOf('{');
    const objEnd = sanitized.lastIndexOf('}');
    if (objStart >= 0 && objEnd > objStart) {
      const candidate = sanitized.slice(objStart, objEnd + 1);
      const parsed = JSON.parse(candidate);
      if (typeof parsed === 'object' && parsed !== null) {
        for (const key of ['sessions', 'patches', 'items', 'schedule', 'data', 'enrichment']) {
          if (Array.isArray(parsed[key])) {
            return parsed[key].filter(
              (p: any) => p && typeof p === 'object' && (p.sessionKey || p.title || p.description)
            );
          }
        }
      }
    }

    return [];
  } catch {
    return [];
  }
}

function extractJsonPatches(completion: string, skeleton?: ScheduleSkeleton): SessionEnrichmentPatch[] {
  try {
    // 1. Strip reasoning / thinking tags (<think>...</think>)
    const cleaned = completion.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

    // 2. Try markdown code fences first
    const codeFenceRegex = /```(?:json)?\s*([\s\S]*?)\s*```/g;
    let fenceMatch: RegExpExecArray | null;
    while ((fenceMatch = codeFenceRegex.exec(cleaned)) !== null) {
      const codeBlock = fenceMatch[1].trim();
      const parsed = tryParseJsonArrayOrObject(codeBlock);
      if (parsed.length > 0) return parsed;
    }

    // 3. Try parsing directly or finding bracketed array in cleaned text
    const directParsed = tryParseJsonArrayOrObject(cleaned);
    if (directParsed.length > 0) return directParsed;

    // 4. Fallback: If the model generated a full Markdown schedule (e.g. - [ ] **Study** ...),
    // extract titles and descriptions from the markdown events and match to skeleton sessions!
    if (skeleton && skeleton.sessions.length > 0 && cleaned.includes('- [ ]')) {
      const parsedSchedule = ScheduleParser.parseMarkdown(cleaned);
      if (parsedSchedule.events.length > 0) {
        const patchesFromMd: SessionEnrichmentPatch[] = [];
        const usedIndices = new Set<number>();
        for (const ev of parsedSchedule.events) {
          const idx = skeleton.sessions.findIndex(
            (s, i) =>
              !usedIndices.has(i) &&
              s.lessonId === ev.lessonId &&
              s.type.toLowerCase() === ev.type.toLowerCase()
          );
          if (idx >= 0) {
            usedIndices.add(idx);
            const sess = skeleton.sessions[idx];
            patchesFromMd.push({
              sessionKey: sess.sessionKey,
              title: ev.title && ev.title !== ev.type ? ev.title : undefined,
              description: ev.description
            });
          }
        }
        if (patchesFromMd.length > 0) {
          console.log(`[Schedule] Fallback parser recovered ${patchesFromMd.length} patches from Markdown schedule output.`);
          return patchesFromMd;
        }
      }
    }

    return [];
  } catch (err) {
    console.warn('[Schedule] extractJsonPatches error:', err);
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

        const uniqueDates = Array.from(new Set(skeleton.sessions.map((s) => s.date)));

        // Output full RRule course-timeline to console.log
        console.log('\n=================== [SCHEDULE BUILDER: RRULE TIMELINE] ===================');
        console.log(`Course:               ${nextTask.courseId.toUpperCase()}`);
        console.log(`Study Days Filter:    ${[...prefs.studyDays].sort().join(', ')}`);
        console.log(`Total Dates (RRule):  ${uniqueDates.length} days (${uniqueDates[0] || 'none'} → ${uniqueDates[uniqueDates.length - 1] || 'none'})`);
        console.log(`Dates Generated:      ${uniqueDates.join(', ')}`);
        console.log(`Total Planned Slots:  ${skeleton.sessions.length} sessions`);
        console.log('\n--- FULL SKELETON MARKDOWN (Generated by RRule) ---');
        console.log(skeleton.markdown);
        console.log('\n--- STRUCTURED PLANNED SESSIONS ---');
        console.log(JSON.stringify(skeleton.sessions, null, 2));
        console.log('==========================================================================\n');

        this.addLog(
          'info',
          `[Schedule] Deterministic calendar generated for ${nextTask.courseId.toUpperCase()} (${skeleton.sessions.length} sessions across preferred study days).`
        );

        // Clean base prompt (stripping any previous STUDENT PREFERENCES block)
        const rawPrompt = nextTask.customPrompt?.trim();
        const basePrompt = stripStudentPreferencesBlock(
          rawPrompt ||
          PromptService.getPrompt('course_schedule')?.content ||
          ''
        );

        let systemPromptForLLM = basePrompt;
        if (!systemPromptForLLM || systemPromptForLLM.trim().length === 0) {
          systemPromptForLLM =
            'You are an Ontario academic learning coach. Return a JSON array of session enrichment objects with "sessionKey", "title", and "description" (active-recall retrieval tasks). Output ONLY valid JSON.';
        }

        // Student preferences are handled client-side when we generate the calendar.
        // The LLM does not need preferences, so we do not send them to the model.
        // Commented out as we may re-enable in the future:
        /*
        if (prefs.notes && prefs.notes.trim().length > 0 && !systemPromptForLLM.includes(prefs.notes.trim())) {
          systemPromptForLLM += `\n\nStudent Notes & Focus Areas:\n${prefs.notes.trim()}`;
        }
        */

        if (!/sessionKey/i.test(systemPromptForLLM)) {
          systemPromptForLLM +=
            '\n\n## Output Format\nReturn ONLY a valid JSON array of session enrichment objects with "sessionKey", "title", and "description". Follow the description guidelines specified above for each session.';
        }

        const enrichmentPayload = CourseService.buildEnrichmentPayload(skeleton.sessions, efforts);

        const effectiveConfig: LLMConfig = {
          ...config,
          model: config.model ? config.model.trim() : '',
          sessionId: config.sessionId || `${nextTask.courseId}-schedule`
        };

        // Output actual content sent to the LLM to console.log
        console.log('\n=================== [SCHEDULE BUILDER: CONTENT SENT TO LLM] ===================');
        console.log(`Course:      ${nextTask.courseId.toUpperCase()}`);
        console.log(`Endpoint:    ${effectiveConfig.baseUrl}`);
        console.log(`Model:       ${effectiveConfig.model || '(server default)'}`);
        console.log(`Session ID:  ${effectiveConfig.sessionId}`);
        console.log(`\n--- SYSTEM PROMPT (${systemPromptForLLM.length.toLocaleString()} chars) ---`);
        console.log(systemPromptForLLM);
        console.log(`\n--- USER PROMPT / ENRICHMENT PAYLOAD (${enrichmentPayload.length.toLocaleString()} chars, ~${Math.round(enrichmentPayload.length / 4).toLocaleString()} tokens) ---`);
        console.log(enrichmentPayload);
        console.log('===============================================================================\n');

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

        let rawCompletion = '';
        let patches: SessionEnrichmentPatch[] = [];
        let applied = false;
        let gatePassed = false;
        let enrichmentError: string | undefined;

        // 2. Attempt lightweight LLM JSON Patch Enrichment
        try {
          // 120s floor gives reasoning models ample headroom without timing out
          const timeoutMs = LLMService.resolveRequestTimeoutMs(effectiveConfig, 120_000, { isFloor: true });
          const result = await LLMService.generateResult(effectiveConfig, systemPromptForLLM, enrichmentPayload, {
            timeoutMs,
            onLog: (level, message) => this.addLog(level, message)
          });

          tokensUsed = result.usage?.total_tokens;
          rawCompletion = result.completion;

          patches = extractJsonPatches(result.completion, skeleton);
          if (patches.length > 0) {
            const enriched = applyEnrichmentPatches(skeleton, patches);
            gatePassed = verifyStructuralEquivalence(skeleton, enriched);
            if (gatePassed) {
              finalMarkdown = enriched;
              applied = true;
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
              `[Schedule] No valid JSON patches found in LLM response (${result.completion.length.toLocaleString()} chars). Retaining deterministic skeleton.`
            );
          }

          // Output exact data sent back from the LLM to console.log
          console.log('\n=================== [SCHEDULE BUILDER: EXACT DATA RECEIVED FROM LLM] ===================');
          console.log(`Course:                            ${nextTask.courseId.toUpperCase()}`);
          console.log(`Total Tokens:                      ${tokensUsed ?? 'unknown'}`);
          console.log(`Extracted Patches Count:           ${patches.length}`);
          console.log(`Structural Equivalence Gate:       ${gatePassed ? 'PASSED' : 'FAILED'}`);
          console.log(`Patches Applied to Skeleton:       ${applied ? 'YES' : 'NO'}`);
          console.log('\n--- EXACT RAW LLM RESPONSE ---');
          console.log(rawCompletion);
          console.log('\n--- PARSED JSON PATCHES ---');
          console.log(JSON.stringify(patches, null, 2));
          console.log('========================================================================================\n');
        } catch (enrichErr: any) {
          enrichmentError = enrichErr?.message || String(enrichErr);
          console.error('\n=================== [SCHEDULE BUILDER: LLM ERROR] ===================');
          console.error(`Course: ${nextTask.courseId.toUpperCase()}`);
          console.error('LLM Enrichment Error Details:', enrichErr);
          console.error('====================================================================\n');
          this.addLog(
            'warn',
            `[Schedule] LLM enrichment skipped (${enrichmentError}). Retaining deterministic skeleton.`
          );
        }

        // Attach debug information to nextTask
        nextTask.scheduleDebug = {
          rruleTimeline: {
            dates: uniqueDates,
            totalSessions: skeleton.sessions.length,
            markdownSkeleton: skeleton.markdown,
            sessions: skeleton.sessions
          },
          llmRequest: {
            systemPrompt: systemPromptForLLM,
            userPrompt: enrichmentPayload,
            model: effectiveConfig.model || '(server default)',
            endpoint: effectiveConfig.baseUrl
          },
          llmResponse: {
            rawCompletion,
            patchesCount: patches.length,
            patches,
            applied,
            gatePassed,
            error: enrichmentError
          }
        };

        // 3. Serialize frontmatter with provenance preferences and updated prompt
        // Clear previous (## STUDENT PREFERENCES (authoritative)) before appending new ones in frontmatter
        const frontmatterPrompt = buildSchedulePrompt(basePrompt, prefs);
        const parsed = parseFrontmatter(finalMarkdown.trim());
        const finalWithFrontmatter = serializeWithFrontmatter(
          {
            ...parsed.frontmatter,
            type: 'course_schedule',
            updatedAt: new Date().toISOString().split('T')[0],
            preferences: prefs,
            prompt: frontmatterPrompt
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
