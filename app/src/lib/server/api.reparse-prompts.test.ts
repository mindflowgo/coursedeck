import { describe, expect, it, beforeEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { handleApiRequest } from './api';
import { CourseService } from './courses';
import { queueManager, type GenerationTask } from './queue';

describe('Reparse with Updated Prompts API', () => {
  const courseId = 'reparse_test_course';

  beforeEach(() => {
    // Pause queue and clear existing tasks for clean isolated tests
    queueManager.pause();
    (queueManager as any).tasks.clear();

    const courseDir = path.join(CourseService.getCoursesDir(), courseId);
    fs.mkdirSync(courseDir, { recursive: true });
    const manifest = {
      id: courseId,
      title: 'Reparse Test Course',
      description: 'Test course for prompt reparse',
      updatedAt: new Date().toISOString(),
      units: [
        {
          number: 1,
          title: 'Unit 1: Fundamentals',
          lessons: [
            { id: '01.01', title: 'Lesson 1' },
            { id: '01.02', title: 'Lesson 2' }
          ]
        },
        {
          number: 2,
          title: 'Unit 2: Advanced Topics',
          lessons: [
            { id: '02.01', title: 'Lesson 3' }
          ]
        }
      ]
    };
    fs.writeFileSync(path.join(courseDir, 'meta.json'), JSON.stringify(manifest), 'utf8');

    // Create a dummy lesson file for 01.01
    fs.writeFileSync(
      path.join(courseDir, '01.01.lesson.md'),
      '# Lesson 1\n\nContent for lesson 1.',
      'utf8'
    );
    // Create an existing summary with an old custom prompt in front-matter
    fs.writeFileSync(
      path.join(courseDir, '01.01.summary.md'),
      '---\nprompt: "OLD OUTDATED PROMPT"\ncontextAttachment: "old-attachment"\n---\n# Old Summary',
      'utf8'
    );
    // Create an existing notes doc that should NOT be touched when only summary is selected
    fs.writeFileSync(
      path.join(courseDir, '01.01.notes.md'),
      '---\nprompt: "NOTES PROMPT MUST REMAIN UNTOUCHED"\n---\n# Unchanged Notes',
      'utf8'
    );
  });

  it('rejects requests with no categories selected', async () => {
    const req = new Request('http://localhost:3182/api/maintenance/reparse-prompts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        courseId,
        categories: []
      })
    });

    const res = await handleApiRequest(req, new URL(req.url));
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.message).toContain('At least one category must be selected');
  });

  it('rejects invalid course IDs', async () => {
    const req = new Request('http://localhost:3182/api/maintenance/reparse-prompts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        courseId: 'nonexistent_invalid_course_xyz',
        categories: ['lesson_summaries']
      })
    });

    const res = await handleApiRequest(req, new URL(req.url));
    expect(res.status).toBe(404);
  });

  it('selecting ONLY lesson_summaries enqueues ONLY summary tasks and leaves other categories untouched', async () => {
    const req = new Request('http://localhost:3182/api/maintenance/reparse-prompts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        courseId,
        categories: ['lesson_summaries']
      })
    });

    const res = await handleApiRequest(req, new URL(req.url));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    // 3 lessons total in course (01.01, 01.02, 02.01)
    expect(data.enqueuedCount).toBe(3);

    const queueStatus = queueManager.getStatus(courseId);
    // Every enqueued task must be a 'summary' task for lessons
    for (const task of queueStatus.tasks) {
      expect(task.tab).toBe('summary');
      expect(task.customPrompt).toBeUndefined(); // Fresh latest prompt loaded dynamically
      expect(task.customContent).toBeUndefined(); // Fresh context
      expect(task.contextAttachment).toBe('lesson - lessons');
      // Must NOT be notes, assignments, or unit/course tests
      expect(task.tab).not.toBe('notes');
      expect(task.tab).not.toBe('assignments');
      expect(task.tab).not.toBe('test');
    }

    // Verify notes file on disk is completely untouched
    const notesContent = fs.readFileSync(
      path.join(CourseService.getCoursesDir(), courseId, '01.01.notes.md'),
      'utf8'
    );
    expect(notesContent).toContain('NOTES PROMPT MUST REMAIN UNTOUCHED');
  });

  it('selecting unit_assignments and course_summaries enqueues ONLY those specific scopes', async () => {
    const req = new Request('http://localhost:3182/api/maintenance/reparse-prompts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        courseId,
        categories: ['unit_assignments', 'course_summaries']
      })
    });

    const res = await handleApiRequest(req, new URL(req.url));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    // 2 units (01.unit, 02.unit assignments) + 1 course summary = 3 tasks
    expect(data.enqueuedCount).toBe(3);

    const queueStatus = queueManager.getStatus(courseId);
    const tabsEnqueued = queueStatus.tasks.map((t) => `${t.lessonId}:${t.tab}`);
    expect(tabsEnqueued).toContain('01.unit:assignments');
    expect(tabsEnqueued).toContain('02.unit:assignments');
    expect(tabsEnqueued).toContain('course:summary');

    // Make sure no lesson-level summaries or notes were enqueued
    expect(tabsEnqueued).not.toContain('01.01:summary');
    expect(tabsEnqueued).not.toContain('01.01:notes');
  });

  it('selecting lesson_notes (and legacy aliases) correctly enqueues notes tasks', async () => {
    // 1. Canonical 'lesson_notes'
    const req1 = new Request('http://localhost:3182/api/maintenance/reparse-prompts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        courseId,
        categories: ['lesson_notes']
      })
    });
    const res1 = await handleApiRequest(req1, new URL(req1.url));
    expect(res1.status).toBe(200);
    const data1 = await res1.json();
    expect(data1.success).toBe(true);
    expect(data1.enqueuedCount).toBe(3);

    const queueStatus1 = queueManager.getStatus(courseId);
    for (const task of queueStatus1.tasks) {
      expect(task.tab).toBe('notes');
    }

    // Reset queue for next assertion
    (queueManager as any).tasks.clear();

    // 2. Legacy alias 'lesson_studysheets'
    const req2 = new Request('http://localhost:3182/api/maintenance/reparse-prompts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        courseId,
        categories: ['lesson_studysheets']
      })
    });
    const res2 = await handleApiRequest(req2, new URL(req2.url));
    expect(res2.status).toBe(200);
    const data2 = await res2.json();
    expect(data2.success).toBe(true);
    expect(data2.enqueuedCount).toBe(3);

    const queueStatus2 = queueManager.getStatus(courseId);
    for (const task of queueStatus2.tasks) {
      expect(task.tab).toBe('notes');
    }

    // Reset queue for next assertion
    (queueManager as any).tasks.clear();

    // 3. Legacy alias 'lesson_cheatsheets'
    const req3 = new Request('http://localhost:3182/api/maintenance/reparse-prompts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        courseId,
        categories: ['lesson_cheatsheets']
      })
    });
    const res3 = await handleApiRequest(req3, new URL(req3.url));
    expect(res3.status).toBe(200);
    const data3 = await res3.json();
    expect(data3.success).toBe(true);
    expect(data3.enqueuedCount).toBe(3);
  });

  it('executing a course-level task in queue saves course.<tab>.md with updated frontmatter', async () => {
    const { LLMService } = await import('./llm');
    const origLoad = LLMService.loadStoredConfig;
    const origCardLoad = LLMService.loadCardConfig;
    const origGen = LLMService.generateResult;

    try {
      LLMService.loadStoredConfig = () =>
        ({
          baseUrl: 'http://mock-llm',
          apiKey: 'test-key',
          model: 'test-model'
        }) as any;
      LLMService.loadCardConfig = () =>
        ({
          baseUrl: 'http://mock-llm',
          apiKey: 'test-key',
          model: 'test-model'
        }) as any;

      LLMService.generateResult = async () =>
        ({
          completion: '# Generated Course Summary\n\nSynthesized content here.',
          usage: { total_tokens: 42 }
        }) as any;

      const task: GenerationTask = {
        id: `${courseId}:course:summary`,
        courseId,
        lessonId: 'course',
        lessonTitle: 'Reparse Test Course Summary',
        tab: 'summary',
        status: 'pending',
        createdAt: new Date().toISOString()
      };

      // Call executeTask directly
      await (queueManager as any).executeTask(task);

      expect(task.status).toBe('completed');
      expect(task.tokensUsed).toBe(42);

      const savedDoc = CourseService.getCourseDocument(courseId, 'summary');
      expect(savedDoc).not.toBeNull();
      expect(savedDoc).toContain('# Generated Course Summary');
      expect(savedDoc).toContain('type: course_summary');
    } finally {
      LLMService.loadStoredConfig = origLoad;
      LLMService.loadCardConfig = origCardLoad;
      LLMService.generateResult = origGen;
    }
  });
});
