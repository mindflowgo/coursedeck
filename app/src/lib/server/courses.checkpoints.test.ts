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
      path.join(courseDir, 'meta.json'),
      JSON.stringify({ id: courseId, title: 'Test Course Checkpoints', archived: false })
    );
  });

  it('returns empty array when checkpoints.json does not exist', () => {
    expect(CourseService.getCheckpoints(courseId)).toEqual([]);
  });

  it('records and updates position checkpoints into checkpoints.json only', () => {
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
    expect(fs.existsSync(path.join(courseDir, 'checkpoints.json'))).toBe(true);
    expect(fs.existsSync(path.join(courseDir, 'checkpoint.json'))).toBe(false);
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

  it('reads legacy checkpoint.json (singular) if present, and migrates to checkpoints.json on save', () => {
    const legacyCourseId = 'legacycp';
    const legacyDir = path.join(scratch, 'courses', legacyCourseId);
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(
      path.join(legacyDir, 'meta.json'),
      JSON.stringify({ id: legacyCourseId, title: 'Legacy Checkpoints Course', archived: false })
    );
    fs.writeFileSync(
      path.join(legacyDir, 'checkpoint.json'),
      JSON.stringify([
        {
          id: 'cp_legacy_1',
          file: '01.01.lesson.md',
          verticalPosition: 300,
          type: 'note',
          color: 'green',
          noteText: 'From legacy file',
          date: '2026-10-25T12:00:00Z'
        }
      ])
    );

    const cps = CourseService.getCheckpoints(legacyCourseId);
    expect(cps.length).toBe(1);
    expect(cps[0].noteText).toBe('From legacy file');

    // Saving updates checkpoints.json and removes legacy checkpoint.json
    CourseService.addOrUpdateNoteCheckpoint(legacyCourseId, {
      file: '01.02.lesson.md',
      verticalPosition: 50,
      noteText: 'New note'
    });
    expect(fs.existsSync(path.join(legacyDir, 'checkpoints.json'))).toBe(true);
    expect(fs.existsSync(path.join(legacyDir, 'checkpoint.json'))).toBe(false);
  });
});
