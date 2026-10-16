import type { Checkpoint } from './checkpoint';
import { parseDocFileName, courseTabHref } from './tabs';

export const RESUME_LAST_POSITION_STORAGE_KEY = 'ilc_resume_last_position';

/**
 * Returns whether the course should resume to the most recently accessed
 * lesson/position when opened generically (e.g. /courses/[course_id]).
 * Defaults to true.
 */
export function getResumeLastPosition(): boolean {
  if (typeof localStorage === 'undefined') return true;
  const val = localStorage.getItem(RESUME_LAST_POSITION_STORAGE_KEY);
  if (val === null) return true;
  return val === 'true';
}

/**
 * Updates the user preference for resuming course to most recent position.
 */
export function setResumeLastPosition(enabled: boolean): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(RESUME_LAST_POSITION_STORAGE_KEY, String(enabled));
}

/**
 * Finds the most recently updated position checkpoint for a course.
 */
export function getMostRecentPositionCheckpoint(checkpoints: Checkpoint[]): Checkpoint | null {
  if (!checkpoints || checkpoints.length === 0) return null;
  const positionCps = checkpoints.filter((c) => c.type === 'position' && Boolean(c.file));
  if (positionCps.length === 0) return null;

  return positionCps.sort((a, b) => {
    const timeA = a.date ? new Date(a.date).getTime() : 0;
    const timeB = b.date ? new Date(b.date).getTime() : 0;
    return timeB - timeA;
  })[0];
}

export interface ResolvedCourseResumeTarget {
  isCourseScope: boolean;
  lessonId: string;
  tab: string;
  verticalPosition: number;
  href: string;
}

/**
 * Robustly matches a target lesson ID against course lessons, handling
 * exact IDs, normalized zero-padding (e.g. "1.5" vs "01.05"), and activity codes.
 */
export function matchLessonId(
  allLessons: Array<{ id: string; code?: string }>,
  targetLessonId: string
): { id: string } | null {
  if (!targetLessonId) return null;
  const clean = targetLessonId.toLowerCase().trim();

  // 1. Exact match
  const exact = allLessons.find((l) => l.id.toLowerCase() === clean);
  if (exact) return exact;

  // 2. Normalized zero-padded / unpadded ID match (e.g. "1.5" <-> "01.05")
  const parts = clean.split('.');
  if (parts.length === 2 && !Number.isNaN(Number(parts[0])) && !Number.isNaN(Number(parts[1]))) {
    const padded = `${parts[0].padStart(2, '0')}.${parts[1].padStart(2, '0')}`;
    const unpadded = `${Number(parts[0])}.${Number(parts[1])}`;
    const match = allLessons.find((l) => {
      const lid = l.id.toLowerCase();
      return lid === padded || lid === unpadded;
    });
    if (match) return match;
  }

  // 3. Activity code match (e.g. "u1la5")
  const codeMatch = allLessons.find(
    (l) => l.code && (l.code.toLowerCase() === clean || l.code.toLowerCase().endsWith(`_${clean}`))
  );
  if (codeMatch) return codeMatch;

  return null;
}

/**
 * Resolves the destination route for generic course navigation when
 * resume is enabled. Returns null if no valid position checkpoint exists
 * or the referenced lesson no longer exists in the manifest.
 */
export function resolveLastAccessedCourseRoute(
  courseId: string,
  checkpoints: Checkpoint[],
  allLessons: Array<{ id: string; code?: string }>
): ResolvedCourseResumeTarget | null {
  const mostRecent = getMostRecentPositionCheckpoint(checkpoints);
  if (!mostRecent) return null;

  const parsed = parseDocFileName(mostRecent.file);
  if (!parsed) return null;

  const cleanCourseId = (courseId || '').toLowerCase();

  if (parsed.isCourseScope) {
    return {
      isCourseScope: true,
      lessonId: 'course',
      tab: parsed.tab,
      verticalPosition: mostRecent.verticalPosition || 0,
      href: `/courses/${cleanCourseId}/course/${parsed.tab}`
    };
  }

  // Lesson scope: verify lesson exists in manifest using robust matching
  const matchedLesson = matchLessonId(allLessons, parsed.lessonId);
  if (!matchedLesson) return null;

  const tabSuffix = parsed.tab !== 'lesson' ? `/${parsed.tab}` : '';
  return {
    isCourseScope: false,
    lessonId: matchedLesson.id,
    tab: parsed.tab,
    verticalPosition: mostRecent.verticalPosition || 0,
    href: `/courses/${cleanCourseId}/${encodeURIComponent(matchedLesson.id)}${tabSuffix}`
  };
}
