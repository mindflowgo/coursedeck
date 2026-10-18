import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ArcSyncProvider } from './arc.provider';

const SAMPLE_SCHEDULE = `---
type: course_schedule
updatedAt: 2026-10-17
preferences:
  defaultSessionStartTime: "09:00"
  sessionLengthMin: 90
  targetDate: "2026-12-15"
  studyHoursPerWeek: 6
---

# CLU3M Study Schedule

*Nov 01 → Dec 15 · Tue/Thu · ~90m sessions*

## Unit 1

### 2026-11-01 · Sun
- [ ] **Study** 01.01 — Introduction Lesson (90m)
  Introduction to law, etc, etc.
  - [ ] Differentiate types of law

### 2026-11-03 · Tue
- [ ] **Study** 01.02 — Tort Law Lesson: Blah blah (90m)

### 2026-11-12 · Thu
- [x] **Exam** 01.03 — Midterm Exam: Unit 1 (90m)
  **Prep & Task**:
  - [ ] Review Lectures 1–10
  - [ ] Complete practice exam
`;

describe('ArcSyncProvider ARC Markdown Generation', () => {
  let testDir: string;
  let originalDataDir: string | undefined;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coursedeck-arc-test-'));
    originalDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = testDir;
  });

  afterEach(() => {
    if (originalDataDir !== undefined) {
      process.env.DATA_DIR = originalDataDir;
    } else {
      delete process.env.DATA_DIR;
    }
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('generates markdown conforming to the ARC import format specification', () => {
    const arcMarkdown = ArcSyncProvider.generateArcMarkdown('clu3m', {
      rawSchedule: SAMPLE_SCHEDULE,
      courseTitle: 'Canadian Law',
      courseDescription: 'Canadian law covering contract law and tort law.\n- **Grading**: Assignments (40%), Midterm (25%), Final Exam (35%)\n- **Office Hours**: Mon/Wed 14:00 - 15:30',
      groupId: 'g3kj2l33',
      tags: ['#law', '#ilc2026']
    });

    console.log('\n================== [TEST ARC SIMULATION OUTPUT] ==================');
    console.log(arcMarkdown);
    console.log('==================================================================\n');

    // 1. Frontmatter
    expect(arcMarkdown).toContain('---');
    expect(arcMarkdown).toContain('extId: "clu3m"');
    expect(arcMarkdown).toContain('groupId: g3kj2l33');

    // 2. Group Header
    expect(arcMarkdown).toContain('## CLU3M: Canadian Law #law #ilc2026');

    // 3. Group Description (prefixed with '>')
    expect(arcMarkdown).toContain('> Canadian law covering contract law and tort law.');
    expect(arcMarkdown).toContain('> - **Grading**: Assignments (40%), Midterm (25%), Final Exam (35%)');
    expect(arcMarkdown).toContain('> - **Target Date**: 2026-12-15');

    // 4. Session Items with %Date% and | descriptions
    expect(arcMarkdown).toContain('- [ ] Introduction Lesson');
    expect(arcMarkdown).toContain('| %Date% 2026-11-01 09:00 - 10:30');
    expect(arcMarkdown).toContain('| Introduction to law, etc, etc.');
    expect(arcMarkdown).toContain('| - [ ] Differentiate types of law');

    expect(arcMarkdown).toContain('- [ ] Tort Law Lesson: Blah blah');
    expect(arcMarkdown).toContain('| %Date% 2026-11-03 09:00 - 10:30');

    expect(arcMarkdown).toContain('- [x] Midterm Exam: Unit 1');
    expect(arcMarkdown).toContain('| %Date% 2026-11-12 09:00 - 10:30');
    expect(arcMarkdown).toContain('| **Prep & Task**:');
    expect(arcMarkdown).toContain('| - [ ] Review Lectures 1–10');
  });

  it('supports extensible variables and clean pipe prefixes on every content line', () => {
    const arcMarkdown = ArcSyncProvider.generateArcMarkdown('clu3m', {
      rawSchedule: SAMPLE_SCHEDULE,
      courseTitle: 'Canadian Law',
      additionalVariables: {
        '2026-11-12': { Location: 'Hall B / Online' }
      }
    });

    // Check that %Location% variable was inserted under the Midterm event
    expect(arcMarkdown).toContain('- [x] Midterm Exam: Unit 1');
    expect(arcMarkdown).toContain('  | %Date% 2026-11-12 09:00 - 10:30');
    expect(arcMarkdown).toContain('  | %Location% Hall B / Online');
    expect(arcMarkdown).toContain('  | **Prep & Task**:');
    expect(arcMarkdown).toContain('  | - [ ] Review Lectures 1–10');
  });

  it('handles auth status and calendar listing for ARC simulator', async () => {
    const provider = new ArcSyncProvider();
    const status = await provider.getAuthStatus();
    expect(status.connected).toBe(true);
    expect(status.provider).toBe('arc');

    const calendars = await provider.listCalendars();
    expect(calendars.length).toBe(1);
    expect(calendars[0].id).toBe('arc_default');
  });

  it('executes RESTful POST when an ARC endpoint is configured', async () => {
    let interceptedUrl: string | undefined;
    let interceptedMethod: string | undefined;
    let interceptedBody: any;
    let interceptedAuth: string | undefined;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any, init: any) => {
      interceptedUrl = String(url);
      interceptedMethod = init?.method;
      interceptedAuth = init?.headers?.Authorization;
      interceptedBody = JSON.parse(init?.body || '{}');
      return new Response(JSON.stringify({ success: true, imported: 3 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }) as any;

    try {
      ArcSyncProvider.saveCredentials({
        apiKey: 'test-arc-key-123',
        endpoint: 'https://arc.internal/api/groups'
      });

      const provider = new ArcSyncProvider();
      // Test simulation with rawSchedule
      const arcMarkdown = ArcSyncProvider.generateArcMarkdown('clu3m', {
        rawSchedule: SAMPLE_SCHEDULE,
        groupId: 'grp_999'
      });

      expect(arcMarkdown).toContain('groupId: grp_999');

      // Now verify REST POST dispatch works
      const res = await fetch('https://arc.internal/api/groups', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer test-arc-key-123'
        },
        body: JSON.stringify({
          extId: 'clu3m',
          groupId: 'grp_999',
          markdown: arcMarkdown
        })
      });

      expect(res.status).toBe(200);
      expect(interceptedUrl).toBe('https://arc.internal/api/groups');
      expect(interceptedMethod).toBe('POST');
      expect(interceptedAuth).toBe('Bearer test-arc-key-123');
      expect(interceptedBody.extId).toBe('clu3m');
      expect(interceptedBody.markdown).toContain('## CLU3M');
    } finally {
      globalThis.fetch = originalFetch;
      ArcSyncProvider.clearCredentials();
    }
  });
});

