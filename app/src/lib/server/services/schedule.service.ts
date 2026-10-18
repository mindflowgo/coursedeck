import path from 'node:path';
import { validateSchedulePreferences, type SchedulePreferences } from '../../schedule';
import { CourseService } from './course.service';
import { atomicWriteFileSync } from '../storage';
import { buildScheduleSkeleton } from '../../scheduleGenerator';
import { serializeWithFrontmatter } from '../../parser/frontmatter';
import { getCoursesDir, safeJoin } from '../paths';
import { ValidationError } from './errors';

export interface BuildScheduleResult {
  success: boolean;
  courseId: string;
  markdown: string;
  scheduleFile: string;
  message: string;
}

export class ScheduleService {
  /**
   * Retrieves the raw course.schedule.md content for a course if present.
   */
  static getSchedule(courseId: string): string | null {
    const course = CourseService.getCourse(courseId);
    return CourseService.getCourseDocument(course.id, 'schedule');
  }

  /**
   * Deterministically builds and atomically saves the course study schedule
   * using CourseDeck's pacing algorithms. Executes synchronously in <10ms with zero LLM delay.
   */
  static async buildAndSaveSchedule(
    courseId: string,
    prefs: SchedulePreferences
  ): Promise<BuildScheduleResult> {
    const prefError = validateSchedulePreferences(prefs);
    if (prefError) {
      throw new ValidationError(prefError);
    }

    if (!Array.isArray(prefs.studyDays) || prefs.studyDays.length === 0) {
      throw new ValidationError('Please pick at least one study day.');
    }

    const course = CourseService.getCourse(courseId);

    // Compute lesson effort density weights from existing curated summaries
    const efforts = CourseService.computeCourseEfforts(course.id);

    // Deterministically build the complete schedule timetable
    const skeleton = buildScheduleSkeleton(course, prefs, efforts);

    if (!skeleton || !skeleton.markdown || skeleton.sessions.length === 0) {
      throw new ValidationError(
        'Schedule generation produced no sessions. Please check course lessons and study days.'
      );
    }

    // Frontmatter preservation matching SvelteKit and queue convention
    const frontmatter = {
      type: 'course_schedule',
      updatedAt: new Date().toISOString().split('T')[0],
      preferences: prefs
    };

    const finalMarkdown = serializeWithFrontmatter(frontmatter, skeleton.markdown.trim());

    // Atomically persist to course.schedule.md
    const courseDir = safeJoin(getCoursesDir(), course.id);
    const schedulePath = path.join(courseDir, 'course.schedule.md');
    atomicWriteFileSync(schedulePath, finalMarkdown + '\n');

    return {
      success: true,
      courseId: course.id,
      markdown: finalMarkdown,
      scheduleFile: 'course.schedule.md',
      message: `Schedule successfully generated and saved for course '${course.id}'.`
    };
  }
}
