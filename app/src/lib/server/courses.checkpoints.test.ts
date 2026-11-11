import { beforeAll, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'app-checkpoints-'));
process.env.DATA_DIR = scratch;

import { CourseService } from './courses';

const courseId = 'tstcp';
const courseDir = path.join(scratch, 'courses', courseId);

describe('CourseService checkpoint persistence', () => {
  beforeAll(() => {
    fs.mkdirSync(courseDir, { recursive: true });
    fs.writeFileSync(
      path.join(courseDir, '.manifest.json'),
      JSON.stringify({ id: courseId, title: 'Test Course Checkpoints', archived: false })
    );
  });

  it('returns empty array when .checkpoints.json does not exist', () => {
    expect(CourseService.getCheckpoints(courseId)).toEqual([]);
  });

  it('persists source IDs only on explicit migration and separates original from companion', () => {
    const html = '<html><body><p>Original lesson</p></body></html>';
    const markdown = '# Companion\n\nDifferent paragraph.\n';
    const htmlPath = path.join(courseDir, '07.01.lesson.html');
    const mdPath = path.join(courseDir, '07.01.lesson.companion.md');
    fs.writeFileSync(htmlPath, html);
    fs.writeFileSync(mdPath, markdown);
    const original = CourseService.prepareAnnotationSource(courseId, '07.01.lesson.md', 'html');
    expect(original?.sourceFile).toBe('07.01.lesson.html');
    expect(original?.content).toContain('data-anchor-id=');
    expect(fs.readFileSync(htmlPath, 'utf8')).toBe(original!.content);
    expect(fs.readFileSync(mdPath, 'utf8')).toBe(markdown);
    const stat = fs.statSync(htmlPath).mtimeMs;
    expect(CourseService.prepareAnnotationSource(courseId, '07.01.lesson.md', 'html')).toEqual(original);
    expect(fs.statSync(htmlPath).mtimeMs).toBe(stat);
    const companion = CourseService.prepareAnnotationSource(courseId, '07.01.lesson.md', 'markdown');
    expect(companion?.sourceFile).toBe('07.01.lesson.companion.md');
    expect(fs.readFileSync(mdPath, 'utf8')).toBe(companion!.content);
    expect(CourseService.prepareAnnotationSource(courseId, '08.01.lesson.md', 'markdown')).toBeNull();
    expect(() => CourseService.prepareAnnotationSource(courseId, '../escape.md', 'markdown')).toThrow();
  });

  it('serves the source migration contract and rejects stale render IDs before writing', async () => {
    const { handleApiRequest } = await import('./api');
    const sourceFile = '09.01.summary.md';
    const filePath = path.join(courseDir, sourceFile);
    const content = '# Synthetic summary\n\nA paragraph.\n';
    fs.writeFileSync(filePath, content);
    const post = async (body: Record<string, unknown>) => {
      const request = new Request(`http://localhost/api/courses/${courseId}/annotation-anchors`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return handleApiRequest(request, new URL(request.url));
    };
    const stale = await post({ file: sourceFile, renderer: 'markdown', requiredAnchorIds: ['old-render-id'] });
    expect(stale.status).toBe(409);
    expect(fs.readFileSync(filePath, 'utf8')).toBe(content);
    const migrated = await post({ file: sourceFile, renderer: 'markdown' });
    expect(migrated.status).toBe(200);
    const body = await migrated.json();
    expect(body.sourceFile).toBe(sourceFile);
    expect(body.renderer).toBe('markdown');
    expect(body.content).toBe(fs.readFileSync(filePath, 'utf8'));
    expect((await post({ file: '../escape.md', renderer: 'markdown' })).status).toBe(400);
    expect((await post({ file: 'missing.summary.md', renderer: 'markdown' })).status).toBe(404);
    const pushedHtml = '<p data-anchor-id="synced-block">Synthetic original</p>';
    fs.writeFileSync(path.join(courseDir, '09.02.lesson.html'), '<p>Synthetic original</p>');
    const pushRequest = new Request('http://localhost/api/sync/push', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ documents: { [courseId]: [{ filename: '09.02.lesson.html', content: pushedHtml, annotationSourceBase: '<p>Synthetic original</p>', date: new Date().toISOString() }] } }) });
    const pushed = await handleApiRequest(pushRequest, new URL(pushRequest.url));
    expect(pushed.status).toBe(200);
    expect(fs.readFileSync(path.join(courseDir, '09.02.lesson.html'), 'utf8')).toBe(pushedHtml);
  });

  it('rejects stale HTML anchor sync before merging annotations or replacing newer content and IDs', async () => {
    const { handleApiRequest } = await import('./api');
    const file = '09.03.lesson.html';
    const sourcePath = path.join(courseDir, file);
    const base = '<p>Old instructional content</p>';
    const incoming = '<p data-anchor-id="old-device">Old instructional content</p>';
    const push = async (content: string | null, annotationSourceBase?: string) => {
      const request = new Request('http://localhost/api/sync/push', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ documents: { [courseId]: [{ filename: file, content, annotationSourceBase, date: new Date(Date.now() + 60_000).toISOString() }] }, checkpoints: { [courseId]: [{ id: 'should-not-merge', file, verticalPosition: 20, type: 'note', noteText: 'Stale source', date: new Date().toISOString() }] } }) });
      return handleApiRequest(request, new URL(request.url));
    };
    const newer = '<p data-anchor-id="server-new">New instructional content</p>';
    fs.writeFileSync(sourcePath, newer);
    expect((await push(incoming, base)).status).toBe(409);
    expect(fs.readFileSync(sourcePath, 'utf8')).toBe(newer);
    expect(CourseService.getCheckpoints(courseId).some((cp) => cp.id === 'should-not-merge')).toBe(false);
    const existing = '<p data-anchor-id="server-existing">Old instructional content</p>';
    fs.writeFileSync(sourcePath, existing);
    expect((await push(incoming, base)).status).toBe(409);
    expect(fs.readFileSync(sourcePath, 'utf8')).toBe(existing);
    expect((await push(base, base)).status).toBe(409);
    expect((await push(incoming)).status).toBe(409);
    expect((await push(null, base)).status).toBe(409);
    expect((await push(existing, base)).status).toBe(200);
    expect(fs.readFileSync(sourcePath, 'utf8')).toBe(existing);
    CourseService.deleteCheckpoint(courseId, 'should-not-merge');
  });

  it('records and updates position checkpoints into .checkpoints.json only', () => {
    const pos1 = CourseService.recordPositionCheckpoint(courseId, '01.01.lesson.md', 250);
    expect(pos1.type).toBe('position');
    expect(pos1.file).toBe('01.01.lesson.md');
    expect(pos1.verticalPosition).toBe(250);

    const pos2 = CourseService.recordPositionCheckpoint(courseId, '01.01.lesson.md', 780);
    expect(pos2.id).toBe(pos1.id);
    expect(pos2.verticalPosition).toBe(780);

    const all = CourseService.getCheckpoints(courseId);
    expect(all.length).toBe(1);
    expect(all[0].verticalPosition).toBe(780);
    expect(fs.existsSync(path.join(courseDir, '.checkpoints.json'))).toBe(true);
  });

  it('creates, updates, and deletes note checkpoints', () => {
    const note1 = CourseService.addOrUpdateNoteCheckpoint(courseId, {
      file: '01.01.lesson.md',
      verticalPosition: 400,
      color: 'blue',
      noteText: 'Important reminder here'
    });
    expect(note1.type).toBe('note');
    expect(note1.color).toBe('blue');
    expect(note1.noteText).toBe('Important reminder here');
    expect(note1.verticalPosition).toBe(400);

    // Update note1
    const note1Updated = CourseService.addOrUpdateNoteCheckpoint(courseId, {
      id: note1.id,
      file: '01.01.lesson.md',
      verticalPosition: 420,
      color: 'pink',
      noteText: 'Updated reminder'
    });
    expect(note1Updated.id).toBe(note1.id);
    expect(note1Updated.color).toBe('pink');
    expect(note1Updated.noteText).toBe('Updated reminder');
    expect(note1Updated.verticalPosition).toBe(420);

    // Add another note
    const note2 = CourseService.addOrUpdateNoteCheckpoint(courseId, {
      file: '01.02.summary.md',
      verticalPosition: 100,
      color: 'yellow',
      noteText: 'Summary note'
    });

    const all = CourseService.getCheckpoints(courseId);
    // 1 position + 2 notes = 3 total
    expect(all.length).toBe(3);

    // Delete note1
    const deleted = CourseService.deleteCheckpoint(courseId, note1.id);
    expect(deleted).toBe(true);

    const remaining = CourseService.getCheckpoints(courseId);
    expect(remaining.length).toBe(2);
    expect(remaining.find((c) => c.id === note1.id)).toBeUndefined();
  });

  it('lists note checkpoints across courses sorted by date', () => {
    const notes = CourseService.listAllNoteCheckpoints();
    expect(notes.length).toBeGreaterThan(0);
    expect(notes.every((n) => n.type === 'note')).toBe(true);
    expect(notes[0].courseId).toBe(courseId);
    expect(notes[0].courseTitle).toBe('Test Course Checkpoints');
  });

  it('preserves anchor, selection, and AI fields through create, update, and patch', () => {
    const created = CourseService.addOrUpdateNoteCheckpoint(courseId, {
      file: '02.03.lesson.md',
      verticalPosition: 610,
      type: 'ai',
      color: 'lavender',
      noteText: '',
      anchor: { type: 'block', verticalPosition: 610, blockId: 'cd-test', renderer: 'markdown', sourceFile: '02.03.lesson.md' },
      selection: { text: 'the selected passage', startAnchorId: 'cd-test', endAnchorId: 'cd-test', charStart: 3, charEnd: 24, prefix: 'ctx ', suffix: ' end' },
      aiQuestion: 'What does this passage mean?',
      aiStatus: 'pending'
    });
    expect(created.type).toBe('ai');
    expect(created.anchor).toEqual({ type: 'block', verticalPosition: 610, blockId: 'cd-test', renderer: 'markdown', sourceFile: '02.03.lesson.md' });
    expect(created.selection?.text).toBe('the selected passage');
    expect(created.selection?.prefix).toBe('ctx ');
    expect(created.aiQuestion).toBe('What does this passage mean?');
    expect(created.aiStatus).toBe('pending');

    // A plain note-text update must not wipe the AI/selection payload.
    const updated = CourseService.addOrUpdateNoteCheckpoint(courseId, {
      id: created.id,
      file: '02.03.lesson.md',
      verticalPosition: 615,
      noteText: 'edited'
    });
    expect(updated.aiQuestion).toBe('What does this passage mean?');
    expect(updated.aiStatus).toBe('pending');
    expect(updated.selection?.text).toBe('the selected passage');
    expect(updated.anchor?.blockId).toBe('cd-test');

    // AI completion patch normalizes the legacy 'ready' value.
    const patched = CourseService.patchCheckpoint(courseId, created.id, {
      aiAnswer: 'Here is the explanation.',
      aiStatus: 'ready'
    });
    expect(patched).not.toBeNull();
    expect(patched!.aiAnswer).toBe('Here is the explanation.');
    expect(patched!.aiStatus).toBe('done');

    expect(CourseService.patchCheckpoint(courseId, 'does-not-exist', { aiStatus: 'done' })).toBeNull();
  });

  it('normalizes legacy aiStatus values when reading .checkpoints.json', () => {
    const legacyId = 'tstcp';
    const dir = path.join(scratch, 'courses', legacyId);
    const disk = JSON.parse(fs.readFileSync(path.join(dir, '.checkpoints.json'), 'utf8')) as any[];
    disk.push({
      id: 'cp_legacy_ready',
      file: '03.01.lesson.md',
      verticalPosition: 10,
      type: 'ai',
      date: '2026-11-01T00:00:00.000Z',
      aiStatus: 'ready',
      aiAnswer: 'old answer'
    });
    fs.writeFileSync(path.join(dir, '.checkpoints.json'), JSON.stringify(disk, null, 2));

    const cps = CourseService.getCheckpoints(legacyId);
    const legacy = cps.find((c) => c.id === 'cp_legacy_ready');
    expect(legacy).toBeDefined();
    expect(legacy!.aiStatus).toBe('done');
  });

  it('reads and writes .checkpoints.json', () => {
    const cpCourseId = 'dotcp';
    const cpDir = path.join(scratch, 'courses', cpCourseId);
    fs.mkdirSync(cpDir, { recursive: true });
    fs.writeFileSync(
      path.join(cpDir, '.manifest.json'),
      JSON.stringify({ id: cpCourseId, title: 'Dot Checkpoints Course', archived: false })
    );
    fs.writeFileSync(
      path.join(cpDir, '.checkpoints.json'),
      JSON.stringify([
        {
          id: 'cp_dot_1',
          file: '01.01.lesson.md',
          verticalPosition: 300,
          type: 'note',
          color: 'green',
          noteText: 'From dot file',
          date: '2026-10-25T12:00:00Z'
        }
      ])
    );

    const cps = CourseService.getCheckpoints(cpCourseId);
    expect(cps.length).toBe(1);
    expect(cps[0].noteText).toBe('From dot file');

    CourseService.addOrUpdateNoteCheckpoint(cpCourseId, {
      file: '01.02.lesson.md',
      verticalPosition: 50,
      noteText: 'New note'
    });
    expect(fs.existsSync(path.join(cpDir, '.checkpoints.json'))).toBe(true);
    const updated = CourseService.getCheckpoints(cpCourseId);
    expect(updated.length).toBe(2);
  });
});
