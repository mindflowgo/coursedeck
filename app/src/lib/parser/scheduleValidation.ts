import { ScheduleParser } from './scheduleParser';
import type { CourseManifest } from './courseIngest';

export interface ScheduleValidationResult {
  /** False only when the output is unusable (nothing parsed). */
  ok: boolean;
  /** Advisory issues: the schedule still saves, but these are worth surfacing. */
  warnings: string[];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Sanity-checks a generated course.schedule.md against the course manifest:
 * every referenced lesson exists, every content lesson is scheduled, every
 * assignment has a Submit entry, and dates are real and chronological.
 */
export function validateScheduleMarkdown(
  markdown: string,
  manifest: CourseManifest | null
): ScheduleValidationResult {
  let events;
  try {
    events = ScheduleParser.parseMarkdown(markdown).events;
  } catch {
    return { ok: false, warnings: ['Schedule output could not be parsed.'] };
  }
  if (events.length === 0) {
    return { ok: false, warnings: ['Schedule output contains no schedulable entries.'] };
  }

  if (!manifest) {
    return {
      ok: true,
      warnings: ['Course manifest unavailable — lesson coverage could not be verified.']
    };
  }

  const warnings: string[] = [];
  const allLessons = manifest.units.flatMap((u) => u.lessons);
  const known = new Set(allLessons.map((l) => l.id));

  const unknown = [...new Set(events.map((e) => e.lessonId).filter((id) => !known.has(id)))];
  if (unknown.length > 0) {
    warnings.push(`References unknown lesson id(s): ${unknown.join(', ')}.`);
  }

  const scheduled = new Set(events.map((e) => e.lessonId));
  const uncovered = allLessons.filter((l) => l.type === 'lesson' && !scheduled.has(l.id));
  if (uncovered.length > 0) {
    warnings.push(`Lesson(s) never scheduled: ${uncovered.map((l) => l.id).join(', ')}.`);
  }

  const submitted = new Set(
    events.filter((e) => e.type === 'submit').map((e) => e.lessonId)
  );
  const noSubmit = allLessons.filter((l) => l.type === 'assignment' && !submitted.has(l.id));
  if (noSubmit.length > 0) {
    warnings.push(`Assignment(s) without a Submit entry: ${noSubmit.map((l) => l.id).join(', ')}.`);
  }

  let invalidDates = 0;
  let lastDate = '';
  let outOfOrder = false;
  for (const e of events) {
    if (!e.date) continue;
    const validDate =
      ISO_DATE.test(e.date) && !Number.isNaN(new Date(`${e.date}T00:00:00`).getTime());
    if (!validDate) {
      invalidDates++;
      continue;
    }
    if (lastDate && e.date < lastDate) outOfOrder = true;
    if (e.date > lastDate) lastDate = e.date;
  }
  if (invalidDates > 0) {
    warnings.push(
      `${invalidDates} ${invalidDates === 1 ? 'entry has' : 'entries have'} an invalid date.`
    );
  }
  if (outOfOrder) {
    warnings.push('Day headers are out of chronological order somewhere in the file.');
  }

  return { ok: true, warnings };
}
