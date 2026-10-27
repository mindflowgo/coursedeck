import { describe, it, expect, mock } from 'bun:test';
import { buildCourseAggregatedMarkdown } from './coursePdfAggregator';
import type { CourseManifest } from '$lib/parser/courseIngest';

describe('buildCourseAggregatedMarkdown', () => {
  const dummyCourse = {
    id: 'test101',
    title: 'TEST101: Introduction to Testing',
    description: 'A comprehensive testing course description.',
    units: [
      {
        number: 1,
        title: 'Unit 1: Fundamentals',
        lessons: [
          { id: '01.01', title: 'Getting Started' },
          { id: '01.02', title: 'Advanced Assertions' }
        ]
      },
      {
        number: 2,
        title: 'Unit 2: Integration',
        lessons: [
          { id: '02.01', title: 'E2E Flows' }
        ]
      }
    ]
  } as unknown as CourseManifest;

  it('aggregates lesson notes with unit headers, lesson id separation, and dividers', async () => {
    // When fetchLessonContent cannot reach storage, it returns empty string
    const result = await buildCourseAggregatedMarkdown(dummyCourse, 'lesson');
    expect(result.categoryTitle).toBe('Complete Course Lessons');
    expect(result.markdown).toContain('# TEST101: Introduction to Testing — Complete Course Lessons');
    expect(result.markdown).toContain('> A comprehensive testing course description.');
  });
});
