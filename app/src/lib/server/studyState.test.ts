import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let scratch: string;
let originalDataDir: string | undefined;

// paths.ts resolves the data dir from DATA_DIR at call time, so pointing it at a
// throwaway directory makes the store read/write real files without touching app data.
beforeAll(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ilc-study-state-'));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = scratch;
});

afterAll(() => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  try {
    fs.rmSync(scratch, { recursive: true, force: true });
  } catch {}
});

async function load() {
  // Import after DATA_DIR is set so any module-level path work sees it.
  return await import('./studyState');
}

describe('study state store', () => {
  it('records shared progress and persists it', async () => {
    const { recordProgress, readStudyState } = await load();
    const result = recordProgress('gwl3o', '01.02', 0.5);
    expect(result.ok).toBe(true);
    expect(readStudyState('gwl3o').progress['01.02']?.shared).toBe(0.5);
    const file = path.join(scratch, 'lessonProgress', 'gwl3o.json');
    expect(fs.existsSync(file)).toBe(true);
  });

  it('records per-tab progress for independent tabs', async () => {
    const { recordProgress, readStudyState } = await load();
    recordProgress('gwl3o', '01.02', 0.25, 'test');
    expect(readStudyState('gwl3o').progress['01.02']?.tabs?.test).toBe(0.25);
  });

  it('drops progress back to zero by deleting the entry', async () => {
    const { recordProgress, readStudyState } = await load();
    recordProgress('gwl3o', '01.02', 0);
    const state = readStudyState('gwl3o');
    expect(state.progress['01.02']?.shared).toBeUndefined();
    expect(state.progress['01.02']?.tabs?.test).toBe(0.25);
  });

  it('removes the file once nothing is left to remember', async () => {
    const { recordProgress } = await load();
    recordProgress('gwl3o', '01.02', 0, 'test');
    const file = path.join(scratch, 'lessonProgress', 'gwl3o.json');
    expect(fs.existsSync(file)).toBe(false);
  });

  it('rejects invalid scopes and tabs', async () => {
    const { recordProgress } = await load();
    expect(recordProgress('gwl3o', '../etc', 0.5).ok).toBe(false);
    expect(recordProgress('gwl3o', '01.02', 0.5, 'bad tab').ok).toBe(false);
  });

  it('records completions', async () => {
    const { recordCompletion, readStudyState } = await load();
    const result = recordCompletion('gwl3o', '02.05_assign1');
    expect(result.ok).toBe(true);
    expect(typeof readStudyState('gwl3o').completions['02.05_assign1']).toBe('string');
  });

  it('enforces the 3 lesson-checkpoint cap', async () => {
    const { createCheckpoint } = await load();
    for (let i = 0; i < 3; i++) {
      expect(createCheckpoint('gwl3o', { lessonId: '01.02', kind: 'lesson', label: `cp${i}`, color: 'blue' }).ok).toBe(true);
    }
    const fourth = createCheckpoint('gwl3o', { lessonId: '01.02', kind: 'lesson', label: 'cp3', color: 'red' });
    expect(fourth.ok).toBe(false);
  });

  it('requires an anchor for location checkpoints', async () => {
    const { createCheckpoint } = await load();
    expect(createCheckpoint('gwl3o', { lessonId: '01.02', kind: 'location', anchor: null }).ok).toBe(false);
    expect(createCheckpoint('gwl3o', { lessonId: '01.02', kind: 'location', anchor: 'Minds On' }).ok).toBe(true);
  });

  it('renames, recolours and deletes checkpoints', async () => {
    const { createCheckpoint, updateCheckpoint, deleteCheckpoint, readStudyState } = await load();
    const created = createCheckpoint('clu3m', { lessonId: '01.01', kind: 'lesson', label: 'First', color: 'blue' });
    if (!created.ok) throw new Error('setup failed');
    const id = created.state.checkpoints[0].id;

    expect(updateCheckpoint('clu3m', id, { label: 'Renamed', color: 'amber' }).ok).toBe(true);
    const updated = readStudyState('clu3m').checkpoints[0];
    expect(updated.label).toBe('Renamed');
    expect(updated.color).toBe('amber');

    expect(updateCheckpoint('clu3m', id, { color: 'not a color' }).ok).toBe(false);
    expect(deleteCheckpoint('clu3m', id).ok).toBe(true);
    expect(readStudyState('clu3m').checkpoints).toHaveLength(0);
  });

  it('renames the Current checkpoint and normalizes junk on read', async () => {
    const { setCurrentLabel, readStudyState, writeStudyState } = await load();
    setCurrentLabel('mcr3u', 'Where I am');
    expect(readStudyState('mcr3u').currentLabel).toBe('Where I am');

    // Simulate a corrupt file.
    const file = path.join(scratch, 'lessonProgress', 'mcr3u.json');
    fs.writeFileSync(file, JSON.stringify({ progress: { '01.01': { shared: 5 } }, checkpoints: [{}], completions: { 'nope!': 3 } }));
    const normalized = readStudyState('mcr3u');
    expect(normalized.progress['01.01'].shared).toBe(1);
    expect(normalized.checkpoints).toHaveLength(0);
    expect(Object.keys(normalized.completions)).toHaveLength(0);
    // keep the module used so linting does not flag the import
    expect(typeof writeStudyState).toBe('function');
  });
});
