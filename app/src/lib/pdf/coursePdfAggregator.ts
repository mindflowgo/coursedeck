import type { CourseManifest } from '$lib/parser/courseIngest';
import { parseFrontmatter } from '$lib/parser/frontmatter';
import { stripLessonMedia } from '$lib/markdown/stripMedia';
import { stripCourseCodePrefix } from '$lib/courses';

export type CoursePdfExportType = 'lesson' | 'summary' | 'notes' | 'studysheet';

export interface AggregatedCourseResult {
  markdown: string;
  itemCount: number;
  categoryTitle: string;
}

/**
 * Fetches content for a given lesson and tab type across Tauri native filesystem,
 * IndexedDB cache, and network fallback.
 */
async function fetchLessonContent(
  courseId: string,
  lessonId: string,
  type: CoursePdfExportType
): Promise<string> {
  // 1. Try local store (Tauri native filesystem or IndexedDB cache)
  try {
    const { getDocument } = await import('$lib/storage/clientStore');
    const tabSlug = type === 'studysheet' ? 'notes' : type;
    const filename = type === 'lesson' ? `${lessonId}.lesson.md` : `${lessonId}.${tabSlug}.md`;
    const doc = await getDocument(courseId, filename);
    if (doc && doc.trim().length > 0) return doc;
  } catch {}

  // 2. Fallback to API endpoint
  try {
    const { apiFetch } = await import('$lib/api');
    const res = await apiFetch(
      `/api/courses/${encodeURIComponent(courseId)}/${encodeURIComponent(lessonId)}`
    );
    if (res.ok) {
      const data = await res.json();
      if (type === 'lesson') {
        return data.lesson || '';
      }
      const tabSlug = type === 'studysheet' ? 'notes' : type;
      return data.tabs?.[tabSlug] || '';
    }
  } catch {}

  return '';
}

/**
 * Gathers lesson files for a course and compiles them into a unified markdown document
 * with clear unit headers, lesson IDs, and horizontal separator marks.
 */
export async function buildCourseAggregatedMarkdown(
  course: CourseManifest,
  type: CoursePdfExportType
): Promise<AggregatedCourseResult> {
  const courseCode = course.id.toUpperCase();
  const cleanTitle = stripCourseCodePrefix(course.title, course.id);

  const titles: Record<CoursePdfExportType, string> = {
    lesson: 'Complete Course Lessons',
    summary: 'All Lesson Summaries',
    notes: 'All Study-Help Notes',
    studysheet: 'All Study-Help Notes'
  };

  const categoryTitle = titles[type];
  const lines: string[] = [];

  // Top cover / title banner
  lines.push(`# ${courseCode}: ${cleanTitle} — ${categoryTitle}\n\n`);
  if (course.description && course.description.trim()) {
    lines.push(`> ${course.description.trim()}\n\n`);
  }

  let itemCount = 0;

  for (const unit of course.units || []) {
    let unitHasContent = false;
    const unitLines: string[] = [];

    unitLines.push(`\n\n---\n\n# Unit ${unit.number}: ${unit.title}\n\n`);

    for (const lesson of unit.lessons || []) {
      const rawContent = await fetchLessonContent(course.id, lesson.id, type);
      if (!rawContent || !rawContent.trim()) continue;

      const parsed = parseFrontmatter(rawContent);
      let cleanBody = (parsed.body || rawContent).trim();

      if (type === 'lesson') {
        cleanBody = stripLessonMedia(cleanBody);
      }

      if (!cleanBody || cleanBody.length === 0) continue;

      unitHasContent = true;
      itemCount++;

      unitLines.push(`\n\n---\n\n## Lesson ${lesson.id} — ${lesson.title}\n\n`);
      unitLines.push(`${cleanBody}\n\n`);
    }

    if (unitHasContent) {
      lines.push(...unitLines);
    }
  }

  return {
    markdown: lines.join(''),
    itemCount,
    categoryTitle
  };
}
