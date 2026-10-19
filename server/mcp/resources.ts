import type { McpServer } from 'mcp-lite';
import { CourseService } from '../../app/src/lib/server/services/course.service';
import { ScheduleService } from '../../app/src/lib/server/services/schedule.service';

/**
 * Registers read-only, cachable MCP resources.
 * Resources allow AI clients and IDEs to inspect course data and schedules
 * directly without burning tool-calling cycles.
 */
export function registerMcpResources(mcp: McpServer): void {
  // ─── 1. coursedeck://courses ────────────────────────────────────────────────
  mcp.resource(
    'coursedeck://courses',
    {
      name: 'Course Catalog',
      description: 'Compact overview catalog of all available courses with metadata and lesson counts.',
      mimeType: 'application/json'
    },
    async (uri) => {
      try {
        const courses = CourseService.listCourses({ includeArchived: false });
        const catalog = courses.map((c) => ({
          id: c.id,
          title: c.title,
          grade: c.grade,
          level: c.level,
          unitCount: c.units.length,
          lessonCount: c.units.reduce((acc, u) => acc + (u.lessons?.length || 0), 0),
          courseDocs: c.courseDocs
        }));

        return {
          contents: [
            {
              uri: uri.href,
              type: 'text',
              text: JSON.stringify(catalog, null, 2)
            }
          ]
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          contents: [
            {
              uri: uri.href,
              type: 'text',
              text: JSON.stringify({ error: message })
            }
          ]
        };
      }
    }
  );

  // ─── 2. coursedeck://courses/{courseId} ─────────────────────────────────────
  mcp.resource(
    'coursedeck://courses/{courseId}',
    {
      name: 'Course Manifest',
      description: 'Complete manifest and curriculum tree for a specific course.',
      mimeType: 'application/json'
    },
    async (uri, params) => {
      try {
        const course = CourseService.getCourse(params.courseId);
        return {
          contents: [
            {
              uri: uri.href,
              type: 'text',
              text: JSON.stringify(course, null, 2)
            }
          ]
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          contents: [
            {
              uri: uri.href,
              type: 'text',
              text: JSON.stringify({ error: message })
            }
          ]
        };
      }
    }
  );

  // ─── 3. coursedeck://courses/{courseId}/schedule ────────────────────────────
  mcp.resource(
    'coursedeck://courses/{courseId}/schedule',
    {
      name: 'Course Schedule',
      description: 'Active study schedule markdown for a specific course.',
      mimeType: 'text/markdown'
    },
    async (uri, params) => {
      try {
        const schedule = ScheduleService.getSchedule(params.courseId);
        return {
          contents: [
            {
              uri: uri.href,
              type: 'text',
              text: schedule || `No schedule generated yet for course '${params.courseId}'.`
            }
          ]
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          contents: [
            {
              uri: uri.href,
              type: 'text',
              text: `# Error\n\n${message}`
            }
          ]
        };
      }
    }
  );
}
