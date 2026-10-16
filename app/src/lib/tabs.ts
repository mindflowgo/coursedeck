/**
 * Shared helpers for lesson tab slugs. Tabs are file-driven: a tab named
 * "Assignment" on lesson 02.03 lives in `02.03.assignment.md`. Slugs are
 * lowercase with underscores so they are valid in filenames, URLs and the
 * tab pattern enforced server-side (paths.ts).
 */

/** Fixed, always-present tabs (rendered with icons in the tab bar). */
export const BUILT_IN_TABS = ['lesson', 'summary', 'cheatsheet', 'test'] as const;

export type BuiltInTab = (typeof BUILT_IN_TABS)[number];

/** Valid tabs for the complete course scope. */
export const COURSE_TABS = ['lesson', 'summary', 'cheatsheet', 'test', 'schedule'] as const;

export type CourseTab = (typeof COURSE_TABS)[number];

export function isCourseTab(slug: string): slug is CourseTab {
  return (COURSE_TABS as readonly string[]).includes(slug);
}

/** Names users may not give a custom tab because the app already uses them. */
export const RESERVED_TABS = [
  'lesson',
  'notes',
  'summary',
  'cheatsheet',
  'test',
  'schedule',
  'course'
] as const;

/** A tab slug: lowercase alphanumerics and underscores, 1–32 chars. */
export const TAB_SLUG_PATTERN = /^[a-z0-9][a-z0-9_]{0,31}$/;

/** Lowercases, trims, turns spaces into underscores and strips the rest. */
export function slugifyTabName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function isTabSlug(slug: string): boolean {
  return TAB_SLUG_PATTERN.test(slug);
}

/** True for any tab slug that is not one of the fixed built-ins or reserved tabs. */
export function isCustomTabSlug(slug: string): boolean {
  return isTabSlug(slug) && !(RESERVED_TABS as readonly string[]).includes(slug);
}

/** `assignment` → `Assignment`, `practice_questions` → `Practice Questions`. */
export function customTabDisplayName(slug: string): string {
  return slug
    .split('_')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export type TabNameValidation =
  | { ok: true; slug: string }
  | { ok: false; error: string };

/**
 * Validates a user-typed tab name against existing tab slugs. `existingSlugs`
 * should include every tab already shown for the lesson (built-ins included).
 */
export function validateTabName(
  name: string,
  existingSlugs: readonly string[]
): TabNameValidation {
  const slug = slugifyTabName(name);
  if (!slug) {
    return { ok: false, error: 'Enter a name with at least one letter or number.' };
  }
  if (!isTabSlug(slug)) {
    return { ok: false, error: 'Tab names can only contain letters, numbers and spaces (max 32 characters).' };
  }
  if ((RESERVED_TABS as readonly string[]).includes(slug)) {
    return { ok: false, error: `"${customTabDisplayName(slug)}" is already a built-in tab.` };
  }
  if (existingSlugs.includes(slug)) {
    return { ok: false, error: `A "${customTabDisplayName(slug)}" tab already exists for this lesson.` };
  }
  return { ok: true, slug };
}

/**
 * Starter system prompt seeded into `data/prompts/<slug>.md` (and the new
 * tab's frontmatter) the first time a tab with this name is created.
 */
export function starterPromptForTab(displayName: string): string {
  return (
    `# ${displayName} Prompt\n\n` +
    `You are an expert Ontario curriculum educator. Create a high-quality "${displayName}" ` +
    `document for this lesson in clean Markdown. Use clear headings and concise, ` +
    `student-friendly language, and organize the content to suit the purpose of a ` +
    `"${displayName}" (e.g. planning, drafting, tracking work to submit).\n`
  );
}

/**
 * Returns the standard markdown filename for a lesson tab (e.g. `01.01.lesson.md`, `02.03.assignment.md`).
 */
export function tabFileName(lessonId: string, tab: string): string {
  return `${lessonId.trim().toLowerCase()}.${tab.trim().toLowerCase()}.md`;
}

/**
 * Returns the standard markdown filename for a course-level document (e.g. `course.summary.md`, `course.schedule.md`).
 */
export function courseDocFileName(tab: string): string {
  return `course.${tab.trim().toLowerCase()}.md`;
}

/**
 * Unified helper returning the markdown filename for either lesson or course scope.
 */
export function docFileName(scope: string, tab: string, isCourseScope = false): string {
  if (isCourseScope || scope.trim().toLowerCase() === 'course') {
    return courseDocFileName(tab);
  }
  return tabFileName(scope, tab);
}

/**
 * Parses a markdown document filename (e.g. `01.01.lesson.md` or `course.summary.md`)
 * back into its scope, lessonId, and tab slug.
 */
export function parseDocFileName(
  file: string
): { isCourseScope: boolean; lessonId: string; tab: string } | null {
  const clean = file.trim();
  const courseMatch = clean.match(/^course\.([a-z0-9_-]+)\.md$/i);
  if (courseMatch) {
    return {
      isCourseScope: true,
      lessonId: 'course',
      tab: courseMatch[1].toLowerCase()
    };
  }

  const lessonMatch = clean.match(/^([0-9]+(?:\.[0-9]+)?(?:_[a-z0-9]+)?)\.([a-z0-9_-]+)\.md$/i);
  if (lessonMatch) {
    return {
      isCourseScope: false,
      lessonId: lessonMatch[1],
      tab: lessonMatch[2].toLowerCase()
    };
  }

  return null;
}

/**
 * Builds the URL path to a course document or lesson tab.
 */
export function courseTabHref(
  courseId: string,
  scope: string,
  tab: string,
  isCourseScope = false
): string {
  const cId = (courseId || '').trim().toLowerCase();
  const cleanTab = (tab || '').trim().toLowerCase();
  if (isCourseScope || scope.trim().toLowerCase() === 'course') {
    return `/courses/${cId}/course/${cleanTab}`;
  }
  return `/courses/${cId}/${encodeURIComponent(scope.trim().toLowerCase())}/${cleanTab}`;
}

