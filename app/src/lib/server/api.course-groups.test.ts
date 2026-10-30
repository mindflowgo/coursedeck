import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { handleApiRequest } from './api';
import { CourseService } from './courses';
import { CourseService as CourseManagerService } from './services/course.service';
import { GroupService } from './services/group.service';
import { getGroupsPath } from './paths';

describe('Generalized Groups API & GroupService', () => {
  const testCourseId = 'group_test_course_99';
  const testCourseDir = path.join(CourseService.getCoursesDir(), testCourseId);
  const groupsPath = getGroupsPath();
  let backupGroupsContent: string | null = null;

  beforeEach(() => {
    if (fs.existsSync(groupsPath)) {
      backupGroupsContent = fs.readFileSync(groupsPath, 'utf8');
    }
    // Seed with clean groups.json
    fs.mkdirSync(path.dirname(groupsPath), { recursive: true });
    fs.writeFileSync(
      groupsPath,
      JSON.stringify([
        { id: 'course-a', name: 'Course Group A', type: 'course' },
        { id: 'course-b', name: 'Course Group B', type: 'course' },
        { id: 'lib-ref', name: 'Reference Books', type: 'library' }
      ]),
      'utf8'
    );

    if (fs.existsSync(testCourseDir)) {
      fs.rmSync(testCourseDir, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    if (backupGroupsContent !== null) {
      fs.writeFileSync(groupsPath, backupGroupsContent, 'utf8');
    } else if (fs.existsSync(groupsPath)) {
      fs.unlinkSync(groupsPath);
    }
    if (fs.existsSync(testCourseDir)) {
      fs.rmSync(testCourseDir, { recursive: true, force: true });
    }
  });

  it('GET /api/settings/groups returns all groups from groups.json', async () => {
    const req = new Request('http://127.0.0.1:3182/api/settings/groups');
    const res = await handleApiRequest(req, new URL(req.url));
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.groups.length).toBe(3);
    const names = data.groups.map((g: any) => g.name);
    expect(names).toContain('Course Group A');
    expect(names).toContain('Reference Books');
  });

  it('GET /api/settings/groups?type=course filters to course groups', async () => {
    const req = new Request('http://127.0.0.1:3182/api/settings/groups?type=course');
    const res = await handleApiRequest(req, new URL(req.url));
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.type).toBe('course');
    expect(data.names).toContain('Course Group A');
    expect(data.names).toContain('Course Group B');
    expect(data.names).not.toContain('Reference Books');
  });

  it('GET /api/settings/groups?type=library filters to library groups', async () => {
    const req = new Request('http://127.0.0.1:3182/api/settings/groups?type=library');
    const res = await handleApiRequest(req, new URL(req.url));
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.type).toBe('library');
    expect(data.names).toContain('Reference Books');
    expect(data.names).not.toContain('Course Group A');
  });

  it('POST /api/settings/groups adds a new group for specified type', async () => {
    const req = new Request('http://127.0.0.1:3182/api/settings/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'course', action: 'add', name: 'Advanced Placement' })
    });
    const res = await handleApiRequest(req, new URL(req.url));
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.names).toContain('Advanced Placement');
  });

  it('POST /api/courses creates course with group metadata', async () => {
    const req = new Request('http://127.0.0.1:3182/api/courses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: testCourseId,
        title: 'Grouped Course Test',
        grade: '11',
        group: 'Course Group A'
      })
    });
    const res = await handleApiRequest(req, new URL(req.url));
    expect(res.status).toBe(201);

    const manifest = CourseService.getCourse(testCourseId);
    expect(manifest).not.toBeNull();
    expect(manifest?.group).toBe('Course Group A');
  });

  it('PUT /api/courses/:id/meta updates group and clears group', async () => {
    CourseManagerService.createCourse({
      id: testCourseId,
      title: 'Meta Group Course',
      group: 'Course Group A'
    });

    const updateReq = new Request(`http://127.0.0.1:3182/api/courses/${testCourseId}/meta`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ group: 'Course Group B' })
    });
    const updateRes = await handleApiRequest(updateReq, new URL(updateReq.url));
    expect(updateRes.status).toBe(200);

    let manifest = CourseService.getCourse(testCourseId);
    expect(manifest?.group).toBe('Course Group B');

    // Clear group
    const clearReq = new Request(`http://127.0.0.1:3182/api/courses/${testCourseId}/meta`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ group: '' })
    });
    const clearRes = await handleApiRequest(clearReq, new URL(clearReq.url));
    expect(clearRes.status).toBe(200);

    manifest = CourseService.getCourse(testCourseId);
    expect(manifest?.group).toBeUndefined();
  });

  it('GroupService.renameGroup(type, oldName, newName) updates groups.json and cascades to courses', async () => {
    CourseManagerService.createCourse({
      id: testCourseId,
      title: 'Cascade Group Course',
      group: 'Course Group A'
    });

    const renameReq = new Request('http://127.0.0.1:3182/api/settings/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'course',
        action: 'rename',
        oldName: 'Course Group A',
        newName: 'Renamed Alpha'
      })
    });
    const renameRes = await handleApiRequest(renameReq, new URL(renameReq.url));
    expect(renameRes.status).toBe(200);

    const data = await renameRes.json();
    expect(data.names).toContain('Renamed Alpha');
    expect(data.names).not.toContain('Course Group A');

    const manifest = CourseService.getCourse(testCourseId);
    expect(manifest?.group).toBe('Renamed Alpha');
  });

  it('POST /api/settings/groups delete action removes group from groups.json', async () => {
    const deleteReq = new Request('http://127.0.0.1:3182/api/settings/groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'course',
        action: 'delete',
        name: 'Course Group B'
      })
    });
    const deleteRes = await handleApiRequest(deleteReq, new URL(deleteReq.url));
    expect(deleteRes.status).toBe(200);

    const data = await deleteRes.json();
    expect(data.names).not.toContain('Course Group B');
  });
});
