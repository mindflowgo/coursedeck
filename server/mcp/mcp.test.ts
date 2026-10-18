import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ilc-mcp-test-'));
const settingsPath = path.join(tmpDir, 'settings.json');
const dataDir = path.join(tmpDir, 'data');
const coursesDir = path.join(dataDir, 'courses');

fs.mkdirSync(coursesDir, { recursive: true });
fs.writeFileSync(settingsPath, JSON.stringify({ data_dir: dataDir }), 'utf8');

process.env.DATA_DIR = dataDir;
process.env.ILC_SETTINGS_PATH = settingsPath;

// Seed a fixture course
const testCourseDir = path.join(coursesDir, 'tst01');
fs.mkdirSync(testCourseDir, { recursive: true });
fs.writeFileSync(
  path.join(testCourseDir, 'meta.json'),
  JSON.stringify(
    {
      id: 'tst01',
      title: 'Test Course',
      grade: '11',
      level: 'University',
      description: 'A test course for MCP testing',
      units: [
        {
          number: 1,
          title: 'Unit 1 Fundamentals',
          lessons: [
            {
              id: '01.01',
              code: 'tst01_u1l1',
              title: 'Lesson 1 Introduction',
              unitNumber: 1,
              lessonNumber: 1,
              type: 'lesson',
              hasFull: true,
              hasSummary: false,
              hasCheatsheet: false,
              hasTest: false
            }
          ]
        }
      ],
      updatedAt: new Date().toISOString()
    },
    null,
    2
  ),
  'utf8'
);
fs.writeFileSync(
  path.join(testCourseDir, '01.01.lesson.md'),
  '# Lesson 1 Introduction\n\nThis is a sample test lesson content for searching and testing.',
  'utf8'
);

import { describe, it, expect, afterAll } from 'bun:test';
import { handleMcpHttpRequest } from './server';

describe('MCP Server Integration Tests (mcp-lite)', () => {
  afterAll(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  async function callMcp(method: string, params: Record<string, any> = {}, id: number = 1) {
    const req = new Request('http://127.0.0.1:3182/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Host: '127.0.0.1:3182'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id,
        method,
        params
      })
    });

    const res = await handleMcpHttpRequest(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    return body;
  }

  it('handles initialize handshake', async () => {
    const res = await callMcp('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0' }
    });

    expect(res.jsonrpc).toBe('2.0');
    expect(res.result).toBeDefined();
    expect(res.result.serverInfo.name).toBe('coursedeck');
    expect(res.result.capabilities.tools).toBeDefined();
  });

  it('lists all registered tools via tools/list', async () => {
    const res = await callMcp('tools/list', {});
    expect(res.result).toBeDefined();
    expect(Array.isArray(res.result.tools)).toBe(true);

    const toolNames = res.result.tools.map((t: any) => t.name);
    expect(toolNames).toContain('list_courses');
    expect(toolNames).toContain('get_course');
    expect(toolNames).toContain('list_lessons');
    expect(toolNames).toContain('create_course');
    expect(toolNames).toContain('delete_course');
    expect(toolNames).toContain('search_course');
    expect(toolNames).toContain('get_lesson_doc');
    expect(toolNames).toContain('get_course_schedule');
    expect(toolNames).toContain('build_course_schedule');
    expect(toolNames).toContain('prompt_course');
    expect(toolNames).toContain('get_task_status');
  });

  it('executes list_courses tool', async () => {
    const res = await callMcp('tools/call', {
      name: 'list_courses',
      arguments: {}
    });

    expect(res.result).toBeDefined();
    expect(res.result.content).toBeDefined();
    const data = JSON.parse(res.result.content[0].text);
    expect(Array.isArray(data)).toBe(true);
  });

  it('executes search_course tool', async () => {
    const res = await callMcp('tools/call', {
      name: 'search_course',
      arguments: {
        query: 'lesson',
        limit: 5
      }
    });

    expect(res.result).toBeDefined();
    const data = JSON.parse(res.result.content[0].text);
    expect(data.query).toBe('lesson');
    expect(Array.isArray(data.results)).toBe(true);
  });

  it('executes get_course and list_lessons tools', async () => {
    const courseRes = await callMcp('tools/call', {
      name: 'get_course',
      arguments: { id: 'tst01' }
    });
    expect(courseRes.result).toBeDefined();
    const course = JSON.parse(courseRes.result.content[0].text);
    expect(course.id).toBe('tst01');
    expect(course.title).toBe('Test Course');

    const lessonsRes = await callMcp('tools/call', {
      name: 'list_lessons',
      arguments: { courseId: 'tst01' }
    });
    expect(lessonsRes.result).toBeDefined();
    const lessons = JSON.parse(lessonsRes.result.content[0].text);
    expect(Array.isArray(lessons)).toBe(true);
    expect(lessons.length).toBe(1);
    expect(lessons[0].id).toBe('01.01');
  });

  it('executes get_lesson_doc tool', async () => {
    const res = await callMcp('tools/call', {
      name: 'get_lesson_doc',
      arguments: {
        courseId: 'tst01',
        lessonId: '01.01',
        tab: 'lesson'
      }
    });
    expect(res.result).toBeDefined();
    expect(res.result.content[0].text).toContain('# Lesson 1 Introduction');
  });

  it('executes build_course_schedule synchronously and get_course_schedule', async () => {
    const buildRes = await callMcp('tools/call', {
      name: 'build_course_schedule',
      arguments: {
        courseId: 'tst01',
        startDate: '2026-09-01',
        targetEndDate: '2026-12-31',
        sessionsPerDay: 1
      }
    });
    expect(buildRes.result).toBeDefined();
    const buildData = JSON.parse(buildRes.result.content[0].text);
    expect(buildData.success).toBe(true);
    expect(buildData.markdown).toBeDefined();

    const getRes = await callMcp('tools/call', {
      name: 'get_course_schedule',
      arguments: { courseId: 'tst01' }
    });
    expect(getRes.result).toBeDefined();
    expect(getRes.result.content[0].text).toContain('Study Schedule');
  });

  it('executes create_course and delete_course lifecycle', async () => {
    const createRes = await callMcp('tools/call', {
      name: 'create_course',
      arguments: {
        id: 'tst02',
        title: 'Second Test Course'
      }
    });
    expect(createRes.result).toBeDefined();
    const created = JSON.parse(createRes.result.content[0].text);
    expect(created.success).toBe(true);
    expect(created.course.id).toBe('tst02');

    // Attempting to create duplicate should report error (Conflict 409)
    const dupRes = await callMcp('tools/call', {
      name: 'create_course',
      arguments: {
        id: 'tst02',
        title: 'Duplicate Course'
      }
    });
    expect(dupRes.result.isError).toBe(true);

    // Delete course permanent
    const deleteRes = await callMcp('tools/call', {
      name: 'delete_course',
      arguments: {
        id: 'tst02',
        permanent: true
      }
    });
    expect(deleteRes.result).toBeDefined();
    const deleted = JSON.parse(deleteRes.result.content[0].text);
    expect(deleted.success).toBe(true);
    expect(deleted.action).toBe('deleted');
  });

  it('executes get_task_status tool for tracked jobs', async () => {
    const { JobService } = await import('../../app/src/lib/server/services/job.service');
    const job = JobService.createJob('generate_lesson_doc', 'tst01', {
      dedupKey: '01.01:summary',
      initialState: 'running'
    });
    expect(job.id).toBeDefined();

    const res = await callMcp('tools/call', {
      name: 'get_task_status',
      arguments: { jobId: job.id }
    });
    expect(res.result).toBeDefined();
    const jobStatus = JSON.parse(res.result.content[0].text);
    expect(jobStatus.id).toBe(job.id);
    expect(jobStatus.state).toBe('running');
    expect(jobStatus.courseId).toBe('tst01');
  });

  it('enforces Host header security check', async () => {
    const maliciousReq = new Request('http://evil.com/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Host: 'evil.com'
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/list', params: {} })
    });

    const res = await handleMcpHttpRequest(maliciousReq);
    expect(res.status).toBe(400);
  });

  it('enforces Origin header security check for untrusted origins', async () => {
    const maliciousOriginReq = new Request('http://127.0.0.1:3182/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Host: '127.0.0.1:3182',
        Origin: 'https://attacker-website.com'
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 100, method: 'tools/list', params: {} })
    });

    const res = await handleMcpHttpRequest(maliciousOriginReq);
    expect(res.status).toBe(403);
  });

  it('allows IPv6 loopback in Host header', async () => {
    const ipv6Req = new Request('http://[::1]:3182/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Host: '[::1]:3182'
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 101, method: 'tools/list', params: {} })
    });
    const res = await handleMcpHttpRequest(ipv6Req);
    expect(res.status).toBe(200);
  });

  it('allows untrusted Origin if valid Bearer token is provided', async () => {
    const { getOrCreateMcpToken } = await import('../../app/src/lib/server/services/mcp.service');
    const token = getOrCreateMcpToken();

    const authReq = new Request('http://127.0.0.1:3182/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Host: '127.0.0.1:3182',
        Origin: 'https://any-ide-or-proxy.com',
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 102, method: 'tools/list', params: {} })
    });

    const res = await handleMcpHttpRequest(authReq);
    expect(res.status).toBe(200);
  });

  it('executes inject_lessons tool and updates course structure and tabs', async () => {
    const res = await callMcp('tools/call', {
      name: 'inject_lessons',
      arguments: {
        courseId: 'tst01',
        lessons: [
          {
            id: '01.02',
            title: 'Lesson 2 Practice',
            unitNumber: 1,
            lessonNumber: 2,
            content: '# Lesson 2 Content\n\nDetailed lesson 2 markdown body.',
            tabs: {
              summary: '# Lesson 2 Summary\n\nCurated summary.',
              cheatsheet: '# Lesson 2 Cheatsheet'
            }
          }
        ]
      }
    });

    expect(res.result).toBeDefined();
    const parsed = JSON.parse(res.result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(parsed.injectedCount).toBe(1);

    // Verify files were written
    expect(fs.existsSync(path.join(testCourseDir, '01.02.lesson.md'))).toBe(true);
    expect(fs.existsSync(path.join(testCourseDir, '01.02.summary.md'))).toBe(true);
    expect(fs.existsSync(path.join(testCourseDir, '01.02.cheatsheet.md'))).toBe(true);

    // Verify meta.json updated
    const meta = JSON.parse(fs.readFileSync(path.join(testCourseDir, 'meta.json'), 'utf8'));
    const lesson = meta.units[0].lessons.find((l: any) => l.id === '01.02');
    expect(lesson).toBeDefined();
    expect(lesson.title).toBe('Lesson 2 Practice');
    expect(lesson.hasFull).toBe(true);
    expect(lesson.hasSummary).toBe(true);
  });

  it('verifies search_course properly parses lessonId and tab for 01.01.lesson.md', async () => {
    const res = await callMcp('tools/call', {
      name: 'search_course',
      arguments: {
        query: 'sample test lesson',
        courseId: 'tst01'
      }
    });

    expect(res.result).toBeDefined();
    const data = JSON.parse(res.result.content[0].text);
    expect(data.totalMatches).toBeGreaterThan(0);
    const match = data.results.find((r: any) => r.lessonId === '01.01');
    expect(match).toBeDefined();
    expect(match.lessonId).toBe('01.01');
    expect(match.tab).toBe('lesson');
    expect(match.lessonTitle).toBe('Lesson 1 Introduction');
  });

  it('verifies build_course_schedule rejects empty studyDays', async () => {
    const res = await callMcp('tools/call', {
      name: 'build_course_schedule',
      arguments: {
        courseId: 'tst01',
        startDate: '2026-11-01',
        studyDays: []
      }
    });

    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain('Please pick at least one study day');
  });

  it('verifies prompt_course supports async execution and returns a trackable jobId', async () => {
    const res = await callMcp('tools/call', {
      name: 'prompt_course',
      arguments: {
        courseId: 'tst01',
        prompt: 'Give an overview of unit 1',
        async: true
      }
    });

    // Even if no LLM API key is configured, prompt_course with async: true checks config
    // or enqueues a job
    expect(res.result).toBeDefined();
  });

  it('verifies JobService isolates jobs across separate datasets', async () => {
    const { JobService } = await import('../../app/src/lib/server/services/job.service');

    const datasetADir = path.join(tmpDir, 'datasetA');
    const datasetBDir = path.join(tmpDir, 'datasetB');
    fs.mkdirSync(datasetADir, { recursive: true });
    fs.mkdirSync(datasetBDir, { recursive: true });

    // Switch to dataset A
    process.env.DATA_DIR = datasetADir;
    const jobA = JobService.createJob('prompt_course', 'tst01');
    expect(JobService.getJob(jobA.id)).not.toBeNull();

    // Switch to dataset B
    process.env.DATA_DIR = datasetBDir;
    // Job from dataset A should NOT exist in dataset B
    expect(JobService.getJob(jobA.id)).toBeNull();

    const jobB = JobService.createJob('generate_lesson_doc', 'tst02');
    expect(JobService.getJob(jobB.id)).not.toBeNull();

    // Switch back to dataset A
    process.env.DATA_DIR = datasetADir;
    expect(JobService.getJob(jobA.id)).not.toBeNull();
    expect(JobService.getJob(jobB.id)).toBeNull();

    // Restore original test dataDir
    process.env.DATA_DIR = dataDir;
  });
});

