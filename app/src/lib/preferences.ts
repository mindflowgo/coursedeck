import type { Checkpoint } from './checkpoint';
import { parseDocFileName, courseTabHref } from './tabs';

export const RESUME_LAST_POSITION_STORAGE_KEY = 'app_resume_last_position';

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
  pdfPage?: number | null;
}

export interface CourseLastLocation {
  courseId: string;
  lessonId: string;
  tab: string;
  isCourseScope: boolean;
  isUnitScope: boolean;
  pdfPage?: number | null;
  updatedAt: number;
}

export function getCourseLastLocation(courseId: string): CourseLastLocation | null {
  if (typeof localStorage === 'undefined' || !courseId) return null;
  try {
    const raw = localStorage.getItem(`coursedeck_last_location_${courseId.toLowerCase().trim()}`);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.tab === 'string') {
        return {
          courseId: String(parsed.courseId || courseId).toLowerCase(),
          lessonId: String(parsed.lessonId || ''),
          tab: String(parsed.tab),
          isCourseScope: Boolean(parsed.isCourseScope),
          isUnitScope: Boolean(parsed.isUnitScope),
          pdfPage: typeof parsed.pdfPage === 'number' && Number.isFinite(parsed.pdfPage) ? parsed.pdfPage : null,
          updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : Date.now()
        };
      }
    }
  } catch {}
  return null;
}

export function setCourseLastLocation(
  courseId: string,
  loc: {
    lessonId?: string;
    tab: string;
    isCourseScope?: boolean;
    isUnitScope?: boolean;
    pdfPage?: number | null;
  }
): void {
  if (typeof localStorage === 'undefined' || !courseId) return;
  try {
    const cleanId = courseId.toLowerCase().trim();
    const prev = getCourseLastLocation(cleanId);
    const updated: CourseLastLocation = {
      courseId: cleanId,
      lessonId: loc.lessonId !== undefined ? loc.lessonId : (prev?.lessonId || ''),
      tab: loc.tab,
      isCourseScope: loc.isCourseScope !== undefined ? loc.isCourseScope : Boolean(prev?.isCourseScope),
      isUnitScope: loc.isUnitScope !== undefined ? loc.isUnitScope : Boolean(prev?.isUnitScope),
      pdfPage: loc.pdfPage !== undefined ? loc.pdfPage : (prev?.pdfPage ?? null),
      updatedAt: Date.now()
    };
    localStorage.setItem(`coursedeck_last_location_${cleanId}`, JSON.stringify(updated));
  } catch {}
}

export function buildCourseResumeUrl(
  courseId: string,
  location?: CourseLastLocation | null
): string {
  const cleanId = (courseId || '').toLowerCase().trim();
  if (!cleanId) return '/';

  const loc = location !== undefined ? location : getCourseLastLocation(cleanId);
  if (!loc) return `/courses/${cleanId}`;

  const pageParam = (loc.tab === 'book' && typeof loc.pdfPage === 'number' && loc.pdfPage > 0)
    ? `?page=${loc.pdfPage}`
    : '';

  if (loc.isCourseScope || loc.lessonId === 'course') {
    const tab = loc.tab || 'lesson';
    return `/courses/${cleanId}/course/${tab}${pageParam}`;
  }

  if (loc.isUnitScope) {
    const unitLesson = loc.lessonId || 'unit_1';
    const tab = loc.tab || 'assignments';
    return `/courses/${cleanId}/${encodeURIComponent(unitLesson)}/${tab}${pageParam}`;
  }

  if (loc.lessonId) {
    const tab = loc.tab || 'lesson';
    const tabSuffix = tab !== 'lesson' ? `/${tab}` : '';
    return `/courses/${cleanId}/${encodeURIComponent(loc.lessonId)}${tabSuffix}${pageParam}`;
  }

  return `/courses/${cleanId}`;
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
  const cleanCourseId = (courseId || '').toLowerCase().trim();

  // 1. Explicit last visited location takes precedence
  const lastLoc = getCourseLastLocation(cleanCourseId);
  if (lastLoc) {
    if (!lastLoc.isCourseScope && !lastLoc.isUnitScope && lastLoc.lessonId) {
      const matched = matchLessonId(allLessons, lastLoc.lessonId);
      if (matched) {
        return {
          isCourseScope: false,
          lessonId: matched.id,
          tab: lastLoc.tab,
          verticalPosition: 0,
          href: buildCourseResumeUrl(cleanCourseId, { ...lastLoc, lessonId: matched.id }),
          pdfPage: lastLoc.pdfPage ?? null
        };
      }
    } else {
      return {
        isCourseScope: lastLoc.isCourseScope,
        lessonId: lastLoc.lessonId,
        tab: lastLoc.tab,
        verticalPosition: 0,
        href: buildCourseResumeUrl(cleanCourseId, lastLoc),
        pdfPage: lastLoc.pdfPage ?? null
      };
    }
  }

  // 2. Fall back to checkpoint-based resolution
  const mostRecent = getMostRecentPositionCheckpoint(checkpoints);
  if (!mostRecent) return null;

  const parsed = parseDocFileName(mostRecent.file);
  if (!parsed) return null;

  if (parsed.isCourseScope) {
    if (parsed.tab !== 'test') return null;
    return {
      isCourseScope: true,
      lessonId: 'course',
      tab: 'test',
      verticalPosition: mostRecent.verticalPosition || 0,
      href: `/courses/${cleanCourseId}/course/test`
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
