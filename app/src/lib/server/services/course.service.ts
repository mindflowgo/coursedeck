import fs from 'node:fs';
import path from 'node:path';
import type { CourseDocType, CourseManifest, CourseManifestLesson } from '../../parser/courseIngest';
import { CourseService as BaseCourseService, type LessonContentBundle, type LessonEffort } from '../courses';
import {
  assertCourseId,
  normalizeCourseId,
  safeJoin,
  getCoursesDir
} from '../paths';
import { ConflictError, NotFoundError, ValidationError } from './errors';

export interface CreateCourseInput {
  id: string;
  title: string;
  grade?: string;
  level?: string;
  description?: string;
  coursePDF?: boolean;
  group?: string;
}

export interface DeleteCourseResult {
  success: boolean;
  courseId: string;
  action: 'archived' | 'deleted';
  permanent: boolean;
  message: string;
}

export interface LessonSummaryItem {
  id: string;
  unitNumber: number;
  unitTitle: string;
  lessonNumber: number;
  title: string;
  type: 'lesson' | 'assignment';
  tabs: string[];
}

import { atomicWriteFileSync } from '../storage';
import { tabFileName } from '../../tabs';

export { atomicWriteFileSync };

/**
 * Headless Course Service
 * Reusable by both REST controllers and MCP tools.
 */
export class CourseService {
  static listCourses(options?: { includeArchived?: boolean; search?: string }): CourseManifest[] {
    let courses = BaseCourseService.listCourses();
    if (!options?.includeArchived) {
      courses = courses.filter((c) => !c.archived);
    }
    if (options?.search && options.search.trim()) {
      const q = options.search.trim().toLowerCase();
      courses = courses.filter(
        (c) =>
          c.id.toLowerCase().includes(q) ||
          c.title.toLowerCase().includes(q) ||
          (c.description && c.description.toLowerCase().includes(q))
      );
    }
    return courses;
  }

  static getCourse(courseId: string): CourseManifest {
    const id = normalizeCourseId(courseId);
    const course = BaseCourseService.getCourse(id);
    if (!course) {
      throw new NotFoundError('Course', id);
    }
    return course;
  }

  static createCourse(input: CreateCourseInput): CourseManifest {
    const id = normalizeCourseId(input.id);
    if (!input.title || !input.title.trim()) {
      throw new ValidationError('Course title is required and cannot be empty.');
    }

    const courseDir = safeJoin(getCoursesDir(), id);
    if (fs.existsSync(courseDir)) {
      throw new ConflictError(`Course '${id}' already exists.`);
    }

    // Create directories
    fs.mkdirSync(courseDir, { recursive: true });
    fs.mkdirSync(path.join(courseDir, 'assets'), { recursive: true });
    fs.mkdirSync(path.join(courseDir, 'assets', 'locker_docs'), { recursive: true });
    fs.mkdirSync(path.join(courseDir, '_backup'), { recursive: true });

    const now = new Date().toISOString();
    const manifest: CourseManifest = {
      id,
      title: input.title.trim(),
      grade: input.grade?.trim() || '11',
      level: input.level?.trim() || 'University',
      description: input.description?.trim() || '',
      units: [],
      archived: false,
      updatedAt: now
    };
    if (input.coursePDF) {
      manifest.coursePDF = true;
    }
    if (input.group && input.group.trim()) {
      manifest.group = input.group.trim();
    }

    const metaPath = path.join(courseDir, 'meta.json');
    atomicWriteFileSync(metaPath, JSON.stringify(manifest, null, 2) + '\n');
    return manifest;
  }

  static deleteCourse(courseId: string, permanent: boolean = false): DeleteCourseResult {
    const id = normalizeCourseId(courseId);
    const courseDir = safeJoin(getCoursesDir(), id);

    if (!fs.existsSync(courseDir)) {
      throw new NotFoundError('Course', id);
    }

    // Record durable cleanup intent in data/.cleanup_queue.json
    this.queueCalendarCleanup(id);

    if (!permanent) {
      BaseCourseService.updateCourseMeta(id, { archived: true });
      return {
        success: true,
        courseId: id,
        action: 'archived',
        permanent: false,
        message: `Course '${id}' has been archived and hidden from active lists.`
      };
    }

    // Permanent deletion
    fs.rmSync(courseDir, { recursive: true, force: true });
    return {
      success: true,
      courseId: id,
      action: 'deleted',
      permanent: true,
      message: `Course '${id}' and all associated files have been permanently deleted.`
    };
  }

  static listLessons(courseId: string, unitNumber?: number): LessonSummaryItem[] {
    const course = this.getCourse(courseId);
    const courseDir = safeJoin(getCoursesDir(), course.id);
    const items: LessonSummaryItem[] = [];

    for (const unit of course.units) {
      if (unitNumber !== undefined && unit.number !== unitNumber) {
        continue;
      }
      for (const lesson of unit.lessons) {
        const bundle = BaseCourseService.getLessonContent(course.id, lesson.id);
        const tabs = bundle ? Object.keys(bundle.tabs) : [];
        if (bundle?.lesson && !tabs.includes('lesson')) {
          tabs.unshift('lesson');
        }
        items.push({
          id: lesson.id,
          unitNumber: unit.number,
          unitTitle: unit.title,
          lessonNumber: lesson.lessonNumber,
          title: lesson.title,
          type: lesson.type || 'lesson',
          tabs
        });
      }
    }

    return items;
  }

  static getLessonContent(courseId: string, lessonId: string): LessonContentBundle {
    const id = normalizeCourseId(courseId);
    const bundle = BaseCourseService.getLessonContent(id, lessonId);
    if (!bundle) {
      throw new NotFoundError('Lesson', `${id}/${lessonId}`);
    }
    return bundle;
  }

  static getCourseDocument(courseId: string, type: CourseDocType | string): string | null {
    const id = normalizeCourseId(courseId);
    return BaseCourseService.getCourseDocument(id, type);
  }

  static injectLessons(
    courseId: string,
    lessons: Array<{
      id: string;
      title: string;
      unitNumber?: number;
      unitTitle?: string;
      lessonNumber?: number;
      type?: 'lesson' | 'assignment';
      content?: string;
      tabs?: Record<string, string>;
      pageRange?: string;
      readingDescription?: string;
    }>
  ): { success: boolean; courseId: string; injectedCount: number; message: string } {
    const course = this.getCourse(courseId);
    const courseDir = safeJoin(getCoursesDir(), course.id);
    const metaPath = path.join(courseDir, 'meta.json');

    for (const item of lessons) {
      if (!item.id || !item.title) {
        throw new ValidationError('Each lesson must include an id and title.');
      }

      let uNum = item.unitNumber;
      let lNum = item.lessonNumber;
      if (uNum === undefined || lNum === undefined) {
        const parts = item.id.split('.');
        const parsedU = parseInt(parts[0], 10);
        const parsedL = parseInt(parts[1] || '1', 10);
        if (uNum === undefined) uNum = Number.isFinite(parsedU) ? parsedU : 1;
        if (lNum === undefined) lNum = Number.isFinite(parsedL) ? parsedL : 1;
      }

      let unit = course.units.find((u) => u.number === uNum);
      if (!unit) {
        unit = {
          number: uNum,
          title: item.unitTitle || `Unit ${uNum}`,
          lessons: []
        };
        course.units.push(unit);
        course.units.sort((a, b) => a.number - b.number);
      } else if (item.unitTitle && (!unit.title || unit.title === `Unit ${uNum}` || unit.title !== item.unitTitle)) {
        unit.title = item.unitTitle;
      }

      let lesson = unit.lessons.find((l) => l.id === item.id);
      if (!lesson) {
        const newLesson: CourseManifestLesson = {
          id: item.id,
          code: `${course.id}_u${uNum}l${lNum}`,
          title: item.title,
          unitNumber: uNum,
          lessonNumber: lNum,
          type: item.type || 'lesson',
          hasFull: false,
          hasSummary: false,
          hasNotes: false,
          hasTest: false,
          pageRange: item.pageRange,
          readingDescription: item.readingDescription
        };
        unit.lessons.push(newLesson);
        unit.lessons.sort((a, b) => a.lessonNumber - b.lessonNumber);
        lesson = newLesson;
      } else {
        lesson.title = item.title;
        if (item.type) lesson.type = item.type;
        if (item.pageRange !== undefined) lesson.pageRange = item.pageRange;
        if (item.readingDescription !== undefined) lesson.readingDescription = item.readingDescription;
      }

      const activeLesson: CourseManifestLesson = lesson;

      if (typeof item.content === 'string') {
        const fullFileName = tabFileName(item.id, 'lesson');
        atomicWriteFileSync(path.join(courseDir, fullFileName), item.content);
        activeLesson.hasFull = true;
      }

      if (item.tabs && typeof item.tabs === 'object') {
        for (const [tabName, tabContent] of Object.entries(item.tabs)) {
          if (typeof tabContent === 'string') {
            const tabFile = tabFileName(item.id, tabName);
            atomicWriteFileSync(path.join(courseDir, tabFile), tabContent);
            if (tabName === 'summary') activeLesson.hasSummary = true;
            if (tabName === 'notes' || tabName === 'studysheet') activeLesson.hasNotes = true;
            if (tabName === 'test') activeLesson.hasTest = true;
          }
        }
      }
    }

    course.updatedAt = new Date().toISOString();
    atomicWriteFileSync(metaPath, JSON.stringify(course, null, 2) + '\n');

    return {
      success: true,
      courseId: course.id,
      injectedCount: lessons.length,
      message: `Successfully injected ${lessons.length} lesson(s) into course '${course.id}'.`
    };
  }

  static getLessonBundle(courseId: string, lessonId: string): LessonContentBundle | null {
    return BaseCourseService.getLessonBundle(normalizeCourseId(courseId), lessonId);
  }

  static stripLessonMedia(content: string | null | undefined): string {
    return BaseCourseService.stripLessonMedia(content);
  }

  static saveLessonTab(
    courseId: string,
    lessonId: string,
    tab: string,
    content: string
  ): { success: boolean; filename: string } {
    return BaseCourseService.saveLessonTab(normalizeCourseId(courseId), lessonId, tab, content);
  }

  static buildAggregatedPayload(courseId: string, tab: 'summary' | 'notes' | 'studysheet' | 'test'): string {
    return BaseCourseService.buildAggregatedPayload(normalizeCourseId(courseId), tab);
  }

  static buildAggregatedNotes(courseId: string): string {
    return BaseCourseService.buildAggregatedNotes(normalizeCourseId(courseId));
  }

  static hasLessonTabContent(
    courseId: string,
    lessonId: string,
    tab: 'summary' | 'notes' | 'studysheet' | 'test' | string
  ): boolean {
    return BaseCourseService.hasLessonTabContent(normalizeCourseId(courseId), lessonId, tab);
  }

  static computeCourseEfforts(courseId: string): LessonEffort[] {
    return BaseCourseService.computeCourseEfforts(normalizeCourseId(courseId));
  }

  static getLogsPath(courseId: string): string {
    return BaseCourseService.getLogsPath(normalizeCourseId(courseId));
  }

  static getLogs(courseId: string): string | null {
    return BaseCourseService.getLogs(normalizeCourseId(courseId));
  }

  static recordLog(opts: {
    courseId: string;
    type?: string;
    lessonDoc: string;
    chars?: number;
    tokens?: number;
    date?: Date;
  }): void {
    BaseCourseService.recordLog(opts);
  }

  private static queueCalendarCleanup(courseId: string): void {
    try {
      const dataDir = getCoursesDir();
      const parentDir = path.dirname(dataDir);
      const queueFile = path.join(parentDir, '.cleanup_queue.json');
      let queue: Array<{ courseId: string; queuedAt: string }> = [];
      if (fs.existsSync(queueFile)) {
        try {
          queue = JSON.parse(fs.readFileSync(queueFile, 'utf8'));
        } catch {}
      }
      if (!queue.some((item) => item.courseId === courseId)) {
        queue.push({ courseId, queuedAt: new Date().toISOString() });
        atomicWriteFileSync(queueFile, JSON.stringify(queue, null, 2) + '\n');
      }
    } catch (e) {
      console.warn('[CourseService] Could not record calendar cleanup intent:', e);
    }
  }
}
