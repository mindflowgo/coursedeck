import { McpServer } from 'mcp-lite';
import { z } from 'zod';
import { CourseService } from '../../app/src/lib/server/services/course.service';
import { SearchService } from '../../app/src/lib/server/services/search.service';
import { ScheduleService } from '../../app/src/lib/server/services/schedule.service';
import { JobService } from '../../app/src/lib/server/services/job.service';
import { queueManager } from '../../app/src/lib/server/queue';
import { PromptService } from '../../app/src/lib/server/prompts';
import { LLMService } from '../../app/src/lib/server/llm';
import type { SchedulePreferences } from '../../app/src/lib/schedule';

const MAX_PROMPT_COURSE_CHARS = 120_000;

export function registerMcpTools(mcp: McpServer): void {
  // ─── 1. list_courses ──────────────────────────────────────────────────────────
  mcp.tool('list_courses', {
    description: 'List all available courses with metadata, lesson counts, and course-level document availability flags.',
    inputSchema: z.object({
      includeArchived: z.boolean().default(false).describe('Whether to include archived courses'),
      search: z.string().optional().describe('Optional substring filter')
    }),
    handler: async (args) => {
      try {
        const courses = CourseService.listCourses(args);
        return {
          content: [{ type: 'text', text: JSON.stringify(courses, null, 2) }]
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [{ type: 'text', text: `Failed to list courses: ${message}` }]
        };
      }
    }
  });

  // ─── 2. get_course ────────────────────────────────────────────────────────────
  mcp.tool('get_course', {
    description: 'Retrieve the complete manifest, unit structure, and metadata for a specific course.',
    inputSchema: z.object({
      id: z.string().describe("Course identifier, e.g. 'mcr3u'")
    }),
    handler: async (args) => {
      try {
        const course = CourseService.getCourse(args.id);
        return {
          content: [{ type: 'text', text: JSON.stringify(course, null, 2) }]
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [{ type: 'text', text: `Failed to get course: ${message}` }]
        };
      }
    }
  });

  // ─── 3. list_lessons ──────────────────────────────────────────────────────────
  mcp.tool('list_lessons', {
    description: 'List lessons for a course with unit numbers, titles, types, and existing tab files on disk.',
    inputSchema: z.object({
      courseId: z.string().describe("Course ID, e.g. 'mcr3u'"),
      unitNumber: z.number().int().optional().describe('Filter by unit index')
    }),
    handler: async (args) => {
      try {
        const lessons = CourseService.listLessons(args.courseId, args.unitNumber);
        return {
          content: [{ type: 'text', text: JSON.stringify(lessons, null, 2) }]
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [{ type: 'text', text: `Failed to list lessons: ${message}` }]
        };
      }
    }
  });

  // ─── 4. create_course ─────────────────────────────────────────────────────────
  mcp.tool('create_course', {
    description: 'Create a new course in the study tool. Fails with 409 Conflict if courseId already exists.',
    inputSchema: z.object({
      id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/).describe("Course slug, e.g. 'mcr3u'"),
      title: z.string().min(1).max(200).describe("Full title, e.g. 'Functions 11'"),
      grade: z.string().optional().default('11').describe("Grade level, e.g. '11' or '12'"),
      level: z.string().optional().default('University').describe("Academic level, e.g. 'University', 'College', or 'Open'"),
      description: z.string().optional().default('').describe('Optional course syllabus description')
    }),
    handler: async (args) => {
      try {
        const course = CourseService.createCourse(args);
        return {
          content: [{ type: 'text', text: JSON.stringify({ success: true, course }, null, 2) }]
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [{ type: 'text', text: `Failed to create course: ${message}` }]
        };
      }
    }
  });

  // ─── 5. delete_course ─────────────────────────────────────────────────────────
  mcp.tool('delete_course', {
    description: 'Archive or permanently delete a course and queue cleanup for synced calendar events.',
    inputSchema: z.object({
      id: z.string().describe("Course ID to delete, e.g. 'mcr3u'"),
      permanent: z.boolean().default(false).describe('If true, removes folder from disk. If false, marks archived (reversible)')
    }),
    handler: async (args) => {
      try {
        const result = CourseService.deleteCourse(args.id, args.permanent);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [{ type: 'text', text: `Failed to delete course: ${message}` }]
        };
      }
    }
  });

  // ─── 6. inject_lessons ────────────────────────────────────────────────────────
  mcp.tool('inject_lessons', {
    description: 'Bulk inject new lessons and tab content into an existing course manifest and filesystem.',
    inputSchema: z.object({
      courseId: z.string().describe("Course code, e.g. 'mcr3u'"),
      lessons: z.array(
        z.object({
          id: z.string().describe("Lesson ID, e.g. '01.01' or '02.03_assign'"),
          title: z.string().describe('Lesson title'),
          unitNumber: z.number().int().optional().describe('Unit number (defaults to parsing from lesson id)'),
          lessonNumber: z.number().int().optional().describe('Lesson number (defaults to parsing from lesson id)'),
          type: z.enum(['lesson', 'assignment']).default('lesson').describe('Lesson type'),
          content: z.string().optional().describe('Full markdown lesson content'),
          tabs: z.record(z.string(), z.string()).optional().describe('Key-value pairs of tab slugs to markdown content, e.g. { summary: "...", cheatsheet: "..." }')
        })
      ).min(1).describe('Array of lesson definitions to inject')
    }),
    handler: async (args) => {
      try {
        const result = CourseService.injectLessons(args.courseId, args.lessons);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [{ type: 'text', text: `Failed to inject lessons: ${message}` }]
        };
      }
    }
  });

  // ─── 7. search_course ─────────────────────────────────────────────────────────
  mcp.tool('search_course', {
    description: 'Search across course notes, summaries, cheatsheets, and lesson content with relevance scoring.',
    inputSchema: z.object({
      query: z.string().min(1).describe('Search term or phrase'),
      courseId: z.string().optional().describe('Optional course ID filter. If omitted, searches all courses.')
    }),
    handler: async (args) => {
      try {
        const result = SearchService.searchCourses(args.query, args.courseId);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [{ type: 'text', text: `Failed to search course: ${message}` }]
        };
      }
    }
  });

  // ─── 8. get_lesson_doc ────────────────────────────────────────────────────────
  mcp.tool('get_lesson_doc', {
    description: 'Retrieve lesson or course documents (summary, cheatsheet, test, lesson, notes, schedule). Generates on-demand if missing.',
    inputSchema: z.object({
      courseId: z.string().describe("Course ID, e.g. 'mcr3u'"),
      lessonId: z.string().optional().describe('Omit to fetch course-scope documents'),
      tab: z.enum([
        'lesson',
        'summary',
        'cheatsheet',
        'test',
        'schedule',
        'notes',
        'full',
        'practice-sheet'
      ]).default('summary').describe("Document tab type ('lesson', 'summary', 'cheatsheet', 'test', 'schedule', 'notes'). Aliases 'full' and 'practice-sheet' are accepted."),
      generateIfMissing: z.boolean().default(true).describe('If true, generates on demand using the active LLM if missing (default: true)'),
      async: z.boolean().default(false).describe('If true, starts generation in the background and returns a jobId immediately for polling via get_task_status.')
    }),
    handler: async (args) => {
      try {
        // Resolve alias
        const tab =
          args.tab === 'full' ? 'lesson' : args.tab === 'practice-sheet' ? 'test' : args.tab;

        // Course-scope doc
        if (!args.lessonId) {
          if (tab === 'notes') {
            const notes = CourseService.buildAggregatedNotes(args.courseId);
            return { content: [{ type: 'text', text: notes || 'No lesson notes found.' }] };
          }
          if (tab === 'schedule') {
            const schedule = ScheduleService.getSchedule(args.courseId);
            return { content: [{ type: 'text', text: schedule || 'No schedule generated yet.' }] };
          }
          const doc = CourseService.getCourseDocument(args.courseId, tab as any);
          if (doc) {
            return { content: [{ type: 'text', text: doc }] };
          }
          return { content: [{ type: 'text', text: `Course-level ${tab} does not exist.` }] };
        }

        // Lesson-scope doc
        const bundle = CourseService.getLessonContent(args.courseId, args.lessonId);
        if (!bundle) {
          return {
            isError: true,
            content: [{ type: 'text', text: `Lesson '${args.lessonId}' not found in course '${args.courseId}'.` }]
          };
        }
        if (tab === 'lesson') {
          return { content: [{ type: 'text', text: bundle.lesson || 'Empty lesson content.' }] };
        }
        if (bundle.tabs && bundle.tabs[tab]) {
          return { content: [{ type: 'text', text: bundle.tabs[tab] }] };
        }

        // Generate on demand if missing and requested
        if (args.generateIfMissing && (tab === 'summary' || tab === 'cheatsheet' || tab === 'test')) {
          if (args.async) {
            const tasks = queueManager.enqueue([
              {
                courseId: args.courseId,
                lessonId: args.lessonId,
                lessonTitle: args.lessonId,
                tab
              }
            ]);
            const taskId = tasks[0]?.id || `${args.courseId.toLowerCase()}:${args.lessonId}:${tab}`;
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(
                    {
                      jobId: taskId,
                      status: 'queued',
                      message: 'Document generation queued. Check progress with get_task_status.'
                    },
                    null,
                    2
                  )
                }
              ]
            };
          }

          const config = LLMService.loadStoredConfig();
          const promptTemplate = PromptService.getPrompt(tab);
          if (config && config.baseUrl && promptTemplate) {
            const job = JobService.createJob('generate_lesson_doc', args.courseId, {
              dedupKey: `${args.courseId.toLowerCase()}:${args.lessonId}:${tab}`,
              initialState: 'running'
            });

            try {
              const result = await LLMService.generateResult(
                config,
                promptTemplate.content,
                bundle.lesson
              );
              CourseService.saveLessonTab(args.courseId, args.lessonId, tab, result.completion);
              JobService.updateJob(job.id, {
                state: 'succeeded',
                result: {
                  type: 'document',
                  courseId: args.courseId,
                  lessonId: args.lessonId,
                  tab
                }
              });
              return { content: [{ type: 'text', text: result.completion }] };
            } catch (err: unknown) {
              const msg = err instanceof Error ? err.message : String(err);
              JobService.updateJob(job.id, {
                state: 'failed',
                error: { code: 'GENERATION_FAILED', message: msg, retryable: true }
              });
              throw err;
            }
          }
        }

        return {
          content: [{ type: 'text', text: `Document '${tab}' not found for lesson '${args.lessonId}'.` }]
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [{ type: 'text', text: `Failed to get lesson doc: ${message}` }]
        };
      }
    }
  });

  // ─── 9. get_course_schedule ───────────────────────────────────────────────────
  mcp.tool('get_course_schedule', {
    description: 'Retrieve the active study schedule for a course.',
    inputSchema: z.object({
      courseId: z.string().describe("Course ID, e.g. 'mcr3u'")
    }),
    handler: async (args) => {
      try {
        const schedule = ScheduleService.getSchedule(args.courseId);
        if (!schedule) {
          return { content: [{ type: 'text', text: `No schedule exists for course '${args.courseId}'. Use build_course_schedule to create one.` }] };
        }
        return { content: [{ type: 'text', text: schedule }] };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [{ type: 'text', text: `Failed to get schedule: ${message}` }]
        };
      }
    }
  });

  // ─── 10. build_course_schedule ────────────────────────────────────────────────
  mcp.tool('build_course_schedule', {
    description: 'Build an adaptive study schedule using deterministic pacing algorithms. Executes synchronously in milliseconds.',
    inputSchema: z.object({
      courseId: z.string().describe("Course code, e.g. 'mcr3u'"),
      startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Start date YYYY-MM-DD'),
      targetEndDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Target completion date YYYY-MM-DD (optional, used in target paceMode)'),
      studyDays: z.array(z.number().int().min(0).max(6)).default([1, 2, 3, 4, 5]).describe('Days of week to study (0=Sun, 1=Mon, ..., 6=Sat). Defaults to Mon-Fri.'),
      sessionLengthMin: z.number().int().min(15).max(360).default(60).describe('Target session duration in minutes (15-360, default: 60)'),
      sessionsPerDay: z.number().int().min(1).max(6).default(1).describe('Number of study sessions per study day (1-6, default: 1)'),
      paceMode: z.enum(['steady', 'target']).default('steady').describe("Pacing strategy: 'steady' spaces evenly; 'target' paces to finish by targetEndDate"),
      includeReviews: z.boolean().default(true).describe('Automatically insert spaced unit review sessions (default: true)'),
      reviewIntensity: z.enum(['light', 'standard', 'heavy']).default('standard').describe("Review frequency: 'light', 'standard', or 'heavy' (default: 'standard')"),
      includeCatchupDays: z.boolean().default(true).describe('Insert periodic buffer catchup days (default: true)'),
      blackoutDates: z.array(z.object({
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Blackout start date YYYY-MM-DD'),
        endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Blackout end date YYYY-MM-DD'),
        label: z.string().optional().describe('Description, e.g. Vacation')
      })).default([]).describe('Vacation or break periods where no sessions should be scheduled'),
      dayTimes: z.record(z.string(), z.array(z.string())).optional().describe("Map of lowercase weekday name (mon, tue, ...) to preferred start times, e.g. { mon: ['16:00'] }"),
      notes: z.string().optional().describe('Optional user notes stored in schedule frontmatter')
    }),
    handler: async (args) => {
      try {
        const prefs: SchedulePreferences = {
          startDate: args.startDate,
          targetEndDate: args.targetEndDate,
          studyDays: args.studyDays,
          sessionLengthMin: args.sessionLengthMin,
          sessionsPerDay: args.sessionsPerDay,
          paceMode: args.paceMode,
          includeReviews: args.includeReviews,
          reviewIntensity: args.reviewIntensity,
          includeCatchupDays: args.includeCatchupDays,
          blackoutDates: args.blackoutDates,
          dayTimes: args.dayTimes as any,
          notes: args.notes
        };

        const result = await ScheduleService.buildAndSaveSchedule(args.courseId, prefs);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [{ type: 'text', text: `Failed to build schedule: ${message}` }]
        };
      }
    }
  });

  // ─── 11. prompt_course ────────────────────────────────────────────────────────
  mcp.tool('prompt_course', {
    description: 'Evaluate an AI question or instruction against course curriculum using a budget-capped context aggregator (max 120k chars).',
    inputSchema: z.object({
      courseId: z.string().describe("Course code, e.g. 'mcr3u'"),
      prompt: z.string().min(1).describe('Instruction or query to run'),
      contextScope: z.enum(['summaries_only', 'full_course', 'specific_lessons']).default('summaries_only').describe("Context scope: 'summaries_only' (recommended), 'full_course', or 'specific_lessons'"),
      lessonIds: z.array(z.string()).optional().describe("Array of lesson IDs to include when contextScope is 'specific_lessons', e.g. ['01.01', '01.02']"),
      async: z.boolean().default(false).describe('If true, starts evaluation in background and returns a jobId immediately for polling via get_task_status (default: false)')
    }),
    handler: async (args) => {
      try {
        const config = LLMService.loadStoredConfig();
        if (!config || !config.baseUrl) {
          return {
            isError: true,
            content: [{ type: 'text', text: 'Active LLM configuration is missing in Settings.' }]
          };
        }

        let context = '';
        if (args.contextScope === 'summaries_only') {
          context = CourseService.buildAggregatedPayload(args.courseId, 'summary');
        } else if (args.contextScope === 'full_course') {
          context = CourseService.buildAggregatedNotes(args.courseId);
        } else if (args.contextScope === 'specific_lessons' && args.lessonIds) {
          for (const lId of args.lessonIds) {
            const bundle = CourseService.getLessonContent(args.courseId, lId);
            if (bundle) {
              const text = (bundle.tabs && bundle.tabs.summary) || bundle.lesson || '';
              context += `\n\n## Lesson ${lId}\n${text}\n`;
            }
          }
        }

        let warning = '';
        if (context.length > MAX_PROMPT_COURSE_CHARS) {
          context = context.slice(0, MAX_PROMPT_COURSE_CHARS);
          warning = `\n\n> [!NOTE] Context truncated to ${MAX_PROMPT_COURSE_CHARS} character budget.`;
        }

        const job = JobService.createJob('prompt_course', args.courseId, {
          initialState: 'running'
        });

        if (args.async) {
          // Asynchronous execution: kick off in background and return job handle immediately
          (async () => {
            try {
              const result = await LLMService.generateResult(config, args.prompt, context);
              JobService.updateJob(job.id, {
                state: 'succeeded',
                result: {
                  type: 'prompt_answer',
                  courseId: args.courseId,
                  answer: result.completion + warning,
                  tokensUsed: result.usage?.total_tokens
                }
              });
            } catch (genErr: unknown) {
              const msg = genErr instanceof Error ? genErr.message : String(genErr);
              JobService.updateJob(job.id, {
                state: 'failed',
                error: {
                  code: 'PROMPT_FAILED',
                  message: msg,
                  retryable: true
                }
              });
            }
          })();

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    jobId: job.id,
                    status: 'running',
                    message: 'Prompt evaluation started in background. Check status using get_task_status.'
                  },
                  null,
                  2
                )
              }
            ]
          };
        }

        // Synchronous execution: await response and return completion with jobId
        try {
          const result = await LLMService.generateResult(config, args.prompt, context);
          JobService.updateJob(job.id, {
            state: 'succeeded',
            result: {
              type: 'prompt_answer',
              courseId: args.courseId,
              answer: result.completion + warning,
              tokensUsed: result.usage?.total_tokens
            }
          });

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  {
                    jobId: job.id,
                    status: 'succeeded',
                    completion: result.completion + warning
                  },
                  null,
                  2
                )
              }
            ]
          };
        } catch (genErr: unknown) {
          const msg = genErr instanceof Error ? genErr.message : String(genErr);
          JobService.updateJob(job.id, {
            state: 'failed',
            error: {
              code: 'PROMPT_FAILED',
              message: msg,
              retryable: true
            }
          });
          throw genErr;
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [{ type: 'text', text: `Failed to prompt course: ${message}` }]
        };
      }
    }
  });

  // ─── 12. get_task_status ──────────────────────────────────────────────────────
  mcp.tool('get_task_status', {
    description: 'Check status, progress, or result of an asynchronous generation or evaluation job.',
    inputSchema: z.object({
      jobId: z.string().describe('Job identifier or dedup task key, e.g. "job_abc123" or "gwl3o:01.01:summary"')
    }),
    handler: async (args) => {
      const job = JobService.getJob(args.jobId);
      if (!job) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Job '${args.jobId}' not found or expired.` }]
        };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(job, null, 2) }]
      };
    }
  });
}
