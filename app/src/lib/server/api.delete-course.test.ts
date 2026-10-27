import { describe, expect, it, beforeEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { handleApiRequest } from './api';
import { CourseService } from './courses';

describe('DELETE /api/courses/:course_id endpoint', () => {
  const courseId = 'del_test_course';
  const courseDir = path.join(CourseService.getCoursesDir(), courseId);

  beforeEach(() => {
    fs.rmSync(courseDir, { recursive: true, force: true });
    fs.mkdirSync(courseDir, { recursive: true });
    const manifest = {
      id: courseId,
      title: 'Course to Delete',
      description: 'Will be deleted in tests',
      updatedAt: new Date().toISOString(),
      units: []
    };
    fs.writeFileSync(path.join(courseDir, 'meta.json'), JSON.stringify(manifest), 'utf8');
    fs.writeFileSync(path.join(courseDir, '01.01.lesson.md'), '# Lesson Content', 'utf8');
  });

  it('permanently deletes course directory by default', async () => {
    expect(fs.existsSync(courseDir)).toBe(true);

    const req = new Request(`http://127.0.0.1:3182/api/courses/${courseId}`, {
      method: 'DELETE'
    });
    const res = await handleApiRequest(req, new URL(req.url));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.action).toBe('deleted');
    expect(body.permanent).toBe(true);

    // Course folder must no longer exist on disk
    expect(fs.existsSync(courseDir)).toBe(false);
  });

  it('returns 404 when deleting a non-existent course', async () => {
    const req = new Request('http://127.0.0.1:3182/api/courses/non_existent_course', {
      method: 'DELETE'
    });
    const res = await handleApiRequest(req, new URL(req.url));
    expect(res.status).toBe(404);
  });

  it('archives course if permanent=false is passed', async () => {
    expect(fs.existsSync(courseDir)).toBe(true);

    const req = new Request(`http://127.0.0.1:3182/api/courses/${courseId}?permanent=false`, {
      method: 'DELETE'
    });
    const res = await handleApiRequest(req, new URL(req.url));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.action).toBe('archived');
    expect(body.permanent).toBe(false);

    // Directory should still exist, but marked archived in meta.json
    expect(fs.existsSync(courseDir)).toBe(true);
    const meta = JSON.parse(fs.readFileSync(path.join(courseDir, 'meta.json'), 'utf8'));
    expect(meta.archived).toBe(true);

    // Clean up
    fs.rmSync(courseDir, { recursive: true, force: true });
  });
});
