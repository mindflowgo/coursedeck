/**
 * Shared helpers for lesson tab slugs. Tabs are file-driven: a tab named
 * "Assignment" on lesson 02.03 lives in `02.03.assignment.md`. Slugs are
 * lowercase with underscores so they are valid in filenames, URLs and the
 * tab pattern enforced server-side (paths.ts).
 */

/** Fixed, always-present tabs for lessons (rendered with icons in the tab bar). */
export const BUILT_IN_TABS = ['lesson', 'summary', 'studysheet'] as const;

export type BuiltInTab = (typeof BUILT_IN_TABS)[number];

/** Valid tabs for the complete course scope. */
export const COURSE_TABS = ['lesson', 'summary', 'schedule', 'test', 'logs'] as const;

export type CourseTab = (typeof COURSE_TABS)[number];

export function isCourseTab(slug: string): slug is CourseTab {
  return (COURSE_TABS as readonly string[]).includes(slug);
}

/** Valid tabs for unit scope. */
export const UNIT_TABS = ['assignments', 'test'] as const;

export type UnitTab = (typeof UNIT_TABS)[number];

export function isUnitTab(slug: string): slug is UnitTab {
  return (UNIT_TABS as readonly string[]).includes(slug);
}

/**
 * Parses all 1-based page numbers out of a page range string (e.g. "14-28" -> [14, 28], "14, 22-25" -> [14, 22, 25], "p. 42" -> [42]).
 */
export function parsePageNumbers(rangeStr?: string | null): number[] {
  if (!rangeStr) return [];
  const matches = rangeStr.match(/\b\d+\b/g);
  if (!matches) return [];
  const nums = matches.map((m) => parseInt(m, 10)).filter((n) => Number.isFinite(n) && n > 0);
  return Array.from(new Set(nums)).sort((a, b) => a - b);
}

/**
 * Parses the 1-based start page from a page range string (e.g. "14-28" -> 14).
 */
export function parseStartPage(rangeStr?: string | null): number | null {
  const nums = parsePageNumbers(rangeStr);
  return nums.length > 0 ? nums[0] : null;
}

/** Names users may not give a custom tab because the app already uses them. */
export const RESERVED_TABS = [
  'lesson',
  'book',
  'notes',
  'studysheet',
  'test',
  'schedule',
  'course',
  'assignments'
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
    `"${displayName}" (e.g. planning, drafting, tracking work to submit).\n\n` +
    `## Table Formatting Rules:\n` +
    `- Keep every table row on a single line — never break a row across multiple lines.\n` +
    `- Every single table row MUST contain the exact same number of columns as the header.\n` +
    `- For empty or non-applicable cells, always write a visible placeholder like "—" or spaces (| — | or |   |) — never omit columns or leave bare empty pipes like "||".\n`
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
  const clean = tab.trim().toLowerCase();
  if (clean === 'logs') {
    return 'logs.md';
  }
  return `course.${clean}.md`;
}

/**
 * Formats a unit scope identifier (e.g. 1 -> "01.unit", "02" -> "02.unit").
 */
export function formatUnitScopeId(unitNumber: number | string): string {
  const num = typeof unitNumber === 'number' ? unitNumber : parseInt(String(unitNumber).replace(/\.unit$/i, ''), 10);
  const pad = isNaN(num) ? String(unitNumber) : String(num).padStart(2, '0');
  return `${pad}.unit`;
}

/**
 * Checks whether an identifier represents a unit scope (e.g. "01.unit", "2.unit").
 */
export function isUnitScopeId(id: string | null | undefined): boolean {
  if (!id) return false;
  return /^\d+\.unit$/i.test(id.trim());
}

/**
 * Parses the unit number out of a unit scope ID or lesson ID (e.g. "01.unit" -> 1, "02.03" -> 2).
 */
export function parseUnitNumber(id: string | null | undefined): number | null {
  if (!id) return null;
  const clean = id.trim();
  const unitMatch = clean.match(/^(\d+)\.unit$/i);
  if (unitMatch) return parseInt(unitMatch[1], 10);
  const lessonMatch = clean.match(/^(\d+)\.\d+/);
  if (lessonMatch) return parseInt(lessonMatch[1], 10);
  const rawNum = clean.match(/^(\d+)$/);
  if (rawNum) return parseInt(rawNum[1], 10);
  return null;
}

/**
 * Returns the standard markdown filename for a unit-level document (e.g. `01.unit.assignments.md`, `01.unit.test.md`).
 */
export function unitDocFileName(unitNumberOrId: number | string, tab: string): string {
  const cleanTab = tab.trim().toLowerCase();
  const num = parseUnitNumber(String(unitNumberOrId));
  const pad = num !== null ? String(num).padStart(2, '0') : String(unitNumberOrId).trim().toLowerCase();
  return `${pad}.unit.${cleanTab}.md`;
}

/**
 * Unified helper returning the markdown filename for lesson, unit, or course scope.
 */
export function docFileName(scope: string, tab: string, isCourseScope = false): string {
  if (isCourseScope || scope.trim().toLowerCase() === 'course') {
    return courseDocFileName(tab);
  }
  if (isUnitScopeId(scope)) {
    return unitDocFileName(scope, tab);
  }
  return tabFileName(scope, tab);
}

export interface ParsedDocFileName {
  isCourseScope: boolean;
  isUnitScope: boolean;
  unitNumber?: number;
  lessonId: string;
  tab: string;
}

/**
 * Parses a markdown document filename (e.g. `01.01.lesson.md`, `01.unit.test.md`, or `course.summary.md`)
 * back into its scope, lessonId, and tab slug.
 */
export function parseDocFileName(
  file: string
): ParsedDocFileName | null {
  const clean = file.trim();
  if (clean.toLowerCase() === 'logs.md') {
    return {
      isCourseScope: true,
      isUnitScope: false,
      lessonId: 'course',
      tab: 'logs'
    };
  }
  const courseMatch = clean.match(/^course\.([a-z0-9_-]+)\.md$/i);
  if (courseMatch) {
    return {
      isCourseScope: true,
      isUnitScope: false,
      lessonId: 'course',
      tab: courseMatch[1].toLowerCase()
    };
  }

  const unitMatch = clean.match(/^(\d+)\.unit\.([a-z0-9_-]+)\.md$/i);
  if (unitMatch) {
    const unitNum = parseInt(unitMatch[1], 10);
    return {
      isCourseScope: false,
      isUnitScope: true,
      unitNumber: unitNum,
      lessonId: `${unitMatch[1].padStart(2, '0')}.unit`,
      tab: unitMatch[2].toLowerCase()
    };
  }

  const lessonMatch = clean.match(/^([0-9]+(?:\.[0-9]+)?(?:_[a-z0-9]+)?)\.([a-z0-9_-]+)\.md$/i);
  if (lessonMatch) {
    return {
      isCourseScope: false,
      isUnitScope: false,
      lessonId: lessonMatch[1],
      tab: lessonMatch[2].toLowerCase()
    };
  }

  return null;
}

/**
 * Builds the URL path to a course document, unit tab, or lesson tab.
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

