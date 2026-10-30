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

function formatCoursesMarkdown(courses: Array<{
  id: string;
  title: string;
  grade: string;
  level: string;
  unitCount: number;
  lessonCount: number;
  courseDocs?: Record<string, boolean | undefined>;
}>): string {
  if (courses.length === 0) return 'No courses found.';
  let md = '| ID | Title | Grade | Level | Units | Lessons | Docs |\n';
  md += '| :--- | :--- | :--- | :--- | :--- | :--- | :--- |\n';
  for (const c of courses) {
    const docs = c.courseDocs
      ? Object.entries(c.courseDocs)
          .filter(([, v]) => v)
          .map(([k]) => k)
          .join(', ') || 'none'
      : 'none';
    md += `| **${c.id}** | ${c.title} | ${c.grade} | ${c.level} | ${c.unitCount} | ${c.lessonCount} | ${docs} |\n`;
  }
  return md;
}

function formatCoursesFullMarkdown(courses: Array<{
  id: string;
  title: string;
  grade?: string;
  level?: string;
  description?: string;
  units?: Array<{
    number: number;
    title: string;
    lessons?: Array<{
      id: string;
      title: string;
      type: string;
    }>;
  }>;
}>): string {
  if (courses.length === 0) return 'No courses found.';
  let md = '';
  for (const c of courses) {
    md += `# ${c.title} (${c.id.toUpperCase()})\n`;
    md += `**Grade:** ${c.grade || 'N/A'} | **Level:** ${c.level || 'N/A'}\n\n`;
    if (c.description) md += `${c.description}\n\n`;
    for (const u of c.units || []) {
      md += `### Unit ${u.number}: ${u.title} (${u.lessons?.length || 0} lessons)\n`;
      for (const l of u.lessons || []) {
        md += `- [${l.id}] ${l.title} (${l.type})\n`;
      }
      md += '\n';
    }
    md += '---\n\n';
  }
  return md.trim();
}

function formatLessonsMarkdown(lessons: Array<{
  id: string;
  unitNumber: number;
  unitTitle: string;
  lessonNumber: number;
  title: string;
  type: string;
  tabs: string[];
}>): string {
  if (lessons.length === 0) return 'No lessons found.';
  let md = '| Unit | ID | Title | Type | Available Tabs |\n';
  md += '| :--- | :--- | :--- | :--- | :--- |\n';
  for (const l of lessons) {
    md += `| ${l.unitNumber} | \`${l.id}\` | ${l.title} | ${l.type} | ${l.tabs.join(', ') || 'none'} |\n`;
  }
  return md;
}

function formatSearchMarkdown(result: {
  query: string;
  totalMatches: number;
  results: Array<{
    courseId: string;
    courseTitle: string;
    lessonId?: string;
    lessonTitle?: string;
    tab: string;
    score: number;
    snippet: string;
  }>;
}): string {
  if (result.results.length === 0) {
    return `No matches found for query "${result.query}".`;
  }
  let md = `Found ${result.totalMatches} matches for "${result.query}" (showing ${result.results.length}):\n\n`;
  for (const m of result.results) {
    const loc = m.lessonId
      ? `${m.courseId} / Lesson ${m.lessonId} (${m.tab})`
      : `${m.courseId} / Course (${m.tab})`;
    md += `### [Score: ${m.score}] ${loc}\n> ${m.snippet.replace(/\n+/g, ' ')}\n\n`;
  }
  return md.trim();
}

export function registerMcpTools(mcp: McpServer): void {
  // ─── 1. list_courses ──────────────────────────────────────────────────────────
  mcp.tool('list_courses', {
    description: 'List available courses with metadata and lesson counts. By default returns a lightweight summary; use detail="full" for complete manifests or format="markdown" for a compact table.',
    inputSchema: z.object({
      includeArchived: z.boolean().default(false).describe('Whether to include archived courses'),
      search: z.string().optional().describe('Optional substring filter'),
      detail: z.enum(['summary', 'full']).default('summary').describe('Level of detail: "summary" (default, lightweight overview with unit and lesson counts) or "full" (complete manifest with all units and lessons)'),
      format: z.enum(['markdown', 'json']).default('markdown').describe('Output format: "markdown" (default, compact human-readable table, lowest token usage) or "json" (structured data)')
    }),
    handler: async (args) => {
      try {
        const courses = CourseService.listCourses(args);

        const summary = courses.map((c) => ({
          id: c.id,
          title: c.title,
          grade: c.grade,
          level: c.level,
          unitCount: c.units?.length || 0,
          lessonCount: c.units?.reduce((acc, u) => acc + (u.lessons?.length || 0), 0) || 0,
          archived: c.archived ?? false,
          updatedAt: c.updatedAt,
          courseDocs: c.courseDocs
        }));

        if (args.format === 'markdown') {
          if (args.detail === 'full') {
            return {
              content: [{ type: 'text', text: formatCoursesFullMarkdown(courses) }]
            };
          }
          return {
            content: [{ type: 'text', text: formatCoursesMarkdown(summary) }]
          };
        }

        if (args.detail === 'full') {
          return {
            content: [{ type: 'text', text: JSON.stringify(courses, null, 2) }]
          };
        }

        return {
          content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }]
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
    description:
      'Retrieve course manifest and unit structure. PREFERRED: Use this to explore course curricula instead of browsing filesystem directories. Use includeLessons=false for a unit overview without lesson bloat, or format="json" for the full raw object.',
    inputSchema: z.object({
      id: z.string().describe("Course identifier, e.g. 'mcr3u'"),
      includeLessons: z.boolean().default(true).describe('Whether to include full lesson listings or just unit headers with lesson counts'),
      format: z.enum(['markdown', 'json']).default('markdown').describe('Output format: "markdown" (default, structured syllabus outline) or "json" (raw manifest object)')
    }),
    handler: async (args) => {
      try {
        const course = CourseService.getCourse(args.id);

        let targetCourse: any = course;
        if (!args.includeLessons) {
          targetCourse = {
            ...course,
            units: course.units.map((u) => ({
              number: u.number,
              title: u.title,
              lessonCount: u.lessons?.length || 0,
              lessons: []
            }))
          };
        }

        if (args.format === 'markdown') {
          let md = `# ${course.title} (${course.id.toUpperCase()})\n`;
          md += `**Grade:** ${course.grade} | **Level:** ${course.level}\n\n`;
          if (course.description) md += `${course.description}\n\n`;
          for (const u of course.units) {
            md += `## Unit ${u.number}: ${u.title} (${u.lessons?.length || 0} lessons)\n`;
            if (args.includeLessons && u.lessons) {
              for (const l of u.lessons) {
                md += `- [${l.id}] ${l.title} (${l.type})\n`;
              }
            }
            md += '\n';
          }
          return { content: [{ type: 'text', text: md.trim() }] };
        }

        return {
          content: [{ type: 'text', text: JSON.stringify(targetCourse, null, 2) }]
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
    description:
      'List lessons for a course with unit numbers, titles, types, and existing tab files on disk. PREFERRED: Use this instead of scanning course directories on disk.',
    inputSchema: z.object({
      courseId: z.string().describe("Course ID, e.g. 'mcr3u'"),
      unitNumber: z.number().int().optional().describe('Filter by unit index'),
      format: z.enum(['markdown', 'json']).default('markdown').describe('Output format: "markdown" (default, compact table, lowest token usage) or "json" (structured array)')
    }),
    handler: async (args) => {
      try {
        const lessons = CourseService.listLessons(args.courseId, args.unitNumber);
        if (args.format === 'markdown') {
          return {
            content: [{ type: 'text', text: formatLessonsMarkdown(lessons) }]
          };
        }
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
      description: z.string().optional().default('').describe('Optional course syllabus description'),
      group: z.string().optional().describe('Optional course group name'),
      format: z.enum(['markdown', 'json']).default('markdown').describe('Output format: "markdown" (default, human-readable confirmation) or "json" (structured result)')
    }),
    handler: async (args) => {
      try {
        const course = CourseService.createCourse(args);
        if (args.format === 'markdown') {
          let md = `✓ Course **${course.title}** (\`${course.id}\`) created successfully.\n\n`;
          md += `- **ID:** \`${course.id}\`\n`;
          md += `- **Title:** ${course.title}\n`;
          if (course.grade) md += `- **Grade:** ${course.grade}\n`;
          if (course.level) md += `- **Level:** ${course.level}\n`;
          if (course.description) md += `- **Description:** ${course.description}\n`;
          return { content: [{ type: 'text', text: md.trim() }] };
        }
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
      permanent: z.boolean().default(false).describe('If true, removes folder from disk. If false, marks archived (reversible)'),
      format: z.enum(['markdown', 'json']).default('markdown').describe('Output format: "markdown" (default, human-readable confirmation) or "json" (structured result)')
    }),
    handler: async (args) => {
      try {
        const result = CourseService.deleteCourse(args.id, args.permanent);
        if (args.format === 'markdown') {
          const actionText = result.permanent ? 'permanently deleted from disk' : 'archived';
          return {
            content: [
              {
                type: 'text',
                text: `✓ Course **${args.id.toUpperCase()}** ${actionText}.${result.message ? `\n\n${result.message}` : ''}`
              }
            ]
          };
        }
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
      ).min(1).describe('Array of lesson definitions to inject'),
      format: z.enum(['markdown', 'json']).default('markdown').describe('Output format: "markdown" (default, human-readable confirmation) or "json" (structured result)')
    }),
    handler: async (args) => {
      try {
        const result = CourseService.injectLessons(args.courseId, args.lessons);
        if (args.format === 'markdown') {
          let md = `✓ Successfully injected ${args.lessons.length} lesson(s) into course **${args.courseId.toUpperCase()}**.\n\n`;
          for (const l of args.lessons) {
            md += `- **[${l.id}]** ${l.title} (${l.type || 'lesson'})\n`;
          }
          return { content: [{ type: 'text', text: md.trim() }] };
        }
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
    description: 'Search across course notes, summaries, and lesson content with relevance scoring.',
    inputSchema: z.object({
      query: z.string().min(1).describe('Search term or phrase'),
      courseId: z.string().optional().describe('Optional course ID filter. If omitted, searches all courses.'),
      limit: z.number().int().min(1).max(50).default(10).describe('Max number of matches to return (default: 10)'),
      format: z.enum(['markdown', 'json']).default('markdown').describe('Output format: "markdown" (default, compact ranked list, lowest tokens) or "json" (structured match objects)')
    }),
    handler: async (args) => {
      try {
        const result = SearchService.searchCourses(args.query, args.courseId, args.limit);
        if (args.format === 'markdown') {
          return {
            content: [{ type: 'text', text: formatSearchMarkdown(result) }]
          };
        }
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
    description:
      'Retrieve lesson or course documents (summary, notes, test, lesson, schedule). PREFERRED: Always use this tool instead of running shell scripts (like python or cat) to inspect course files on disk. Generates on-demand if missing.',
    inputSchema: z.object({
      courseId: z.string().describe("Course ID, e.g. 'mcr3u'"),
      lessonId: z.string().optional().describe('Omit to fetch course-scope documents'),
      tab: z.enum([
        'lesson',
        'summary',
        'notes',
        'studysheet',
        'cheatsheet',
        'test',
        'schedule',
        'logs',
        'full',
        'practice-sheet'
      ]).default('summary').describe("Document tab type ('lesson', 'summary', 'notes', 'test', 'schedule', 'logs'). Aliases 'full', 'studysheet', and 'practice-sheet' are accepted."),
      generateIfMissing: z.boolean().default(true).describe('If true, generates on demand using the active LLM if missing (default: true)'),
      async: z.boolean().default(false).describe('If true, starts generation in the background and returns a jobId immediately for polling via get_task_status.'),
      format: z.enum(['markdown', 'json']).default('markdown').describe('Output format: "markdown" (default, markdown content) or "json" (structured job result for async)')
    }),
    handler: async (args) => {
      try {
        // Resolve alias
        const tab =
          args.tab === 'full'
            ? 'lesson'
            : args.tab === 'practice-sheet'
              ? 'test'
              : args.tab === 'cheatsheet' || args.tab === 'studysheet'
                ? 'notes'
                : args.tab;

        // Course-scope doc
        if (!args.lessonId) {
          if (tab === 'notes') {
            const courseDoc = CourseService.getCourseDocument(args.courseId, 'notes');
            if (courseDoc) {
              return { content: [{ type: 'text', text: courseDoc }] };
            }
            const notes = CourseService.buildAggregatedNotes(args.courseId);
            return { content: [{ type: 'text', text: notes || 'No lesson notes found.' }] };
          }
          if (tab === 'schedule') {
            const schedule = ScheduleService.getSchedule(args.courseId);
            return { content: [{ type: 'text', text: schedule || 'No schedule generated yet.' }] };
          }
          if (tab === 'logs') {
            const doc = CourseService.getLogs(args.courseId) || CourseService.getCourseDocument(args.courseId, 'logs');
            return { content: [{ type: 'text', text: doc || '# Course Logs\n\n| Date | Type | Lesson | Tokens |\n| :--- | :--- | :--- | :--- |\n' }] };
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
        if (args.generateIfMissing && (tab === 'summary' || tab === 'notes' || tab === 'test')) {
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
            if (args.format === 'markdown') {
              return {
                content: [
                  {
                    type: 'text',
                    text: `⏳ Document generation queued for **${args.courseId}/${args.lessonId}** (${tab}).\n- **Job ID:** \`${taskId}\`\n- Check progress with \`get_task_status\`.`
                  }
                ]
              };
            }
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
                CourseService.stripLessonMedia(bundle.lesson)
              );
              CourseService.saveLessonTab(args.courseId, args.lessonId, tab, result.completion);
              CourseService.recordLog({
                courseId: args.courseId,
                lessonDoc: `${args.lessonId}.${tab}.md`,
                chars: result.completion.length,
                tokens: result.usage?.total_tokens ?? 0
              });
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
      notes: z.string().optional().describe('Optional user notes stored in schedule frontmatter'),
      format: z.enum(['markdown', 'json']).default('markdown').describe('Output format: "markdown" (default, returns schedule markdown directly, lowest tokens) or "json" (structured object with scheduleFile & status)')
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
        if (args.format === 'markdown') {
          return {
            content: [{ type: 'text', text: result.markdown }]
          };
        }
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
      async: z.boolean().default(false).describe('If true, starts evaluation in background and returns a jobId immediately for polling via get_task_status (default: false)'),
      format: z.enum(['markdown', 'json']).default('markdown').describe('Output format: "markdown" (default, direct markdown completion) or "json" (structured completion object)')
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
              context += `\n\n## Lesson ${lId}\n${CourseService.stripLessonMedia(text)}\n`;
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
              CourseService.recordLog({
                courseId: args.courseId,
                lessonDoc: 'prompt_course',
                chars: result.completion.length,
                tokens: result.usage?.total_tokens ?? 0
              });
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

          if (args.format === 'markdown') {
            return {
              content: [
                {
                  type: 'text',
                  text: `⏳ Prompt evaluation started in background for course **${args.courseId.toUpperCase()}**.\n- **Job ID:** \`${job.id}\`\n- Check status using \`get_task_status\`.`
                }
              ]
            };
          }

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
          CourseService.recordLog({
            courseId: args.courseId,
            lessonDoc: 'prompt_course',
            chars: result.completion.length,
            tokens: result.usage?.total_tokens ?? 0
          });
          JobService.updateJob(job.id, {
            state: 'succeeded',
            result: {
              type: 'prompt_answer',
              courseId: args.courseId,
              answer: result.completion + warning,
              tokensUsed: result.usage?.total_tokens
            }
          });

          if (args.format === 'markdown') {
            return {
              content: [{ type: 'text', text: (result.completion + warning).trim() }]
            };
          }

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
      jobId: z.string().describe('Job identifier or dedup task key, e.g. "job_abc123" or "gwl3o:01.01:summary"'),
      format: z.enum(['markdown', 'json']).default('markdown').describe('Output format: "markdown" (default, human-readable status and result markdown) or "json" (structured job object)')
    }),
    handler: async (args) => {
      const job = JobService.getJob(args.jobId);
      if (!job) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Job '${args.jobId}' not found or expired.` }]
        };
      }
      if (args.format === 'markdown') {
        let md = `### Task Status: \`${job.id}\`\n`;
        md += `- **Kind:** \`${job.kind}\`\n`;
        md += `- **Course:** **${job.courseId.toUpperCase()}**\n`;
        md += `- **State:** **${job.state.toUpperCase()}**\n`;
        md += `- **Created:** ${new Date(job.createdAt).toLocaleString()}\n\n`;

        if (job.state === 'succeeded' && job.result) {
          if (job.result.type === 'prompt_answer') {
            md += `---\n\n${job.result.answer}`;
          } else if (job.result.type === 'document') {
            md += `✓ Successfully generated tab **${job.result.tab}** for lesson \`${job.result.lessonId || 'course'}\`.`;
          } else if (job.result.type === 'schedule') {
            md += `✓ Schedule generated successfully.`;
          } else {
            md += `✓ Task completed successfully.`;
          }
        } else if (job.state === 'failed') {
          md += `❌ **Job Failed:** ${job.error?.message || 'Unknown error'}`;
        } else {
          md += `⏳ Job is still running in background...`;
        }
        return {
          content: [{ type: 'text', text: md.trim() }]
        };
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(job, null, 2) }]
      };
    }
  });
}
