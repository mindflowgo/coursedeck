import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { LibraryService } from './library';

describe('LibraryService', () => {
  let scratch = '';
  const origDataDir = process.env.DATA_DIR;

  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'library-test-'));
    process.env.DATA_DIR = scratch;
  });

  afterEach(() => {
    if (origDataDir !== undefined) {
      process.env.DATA_DIR = origDataDir;
    } else {
      delete process.env.DATA_DIR;
    }
    try {
      if (scratch && fs.existsSync(scratch)) {
        fs.rmSync(scratch, { recursive: true, force: true });
      }
    } catch {}
  });

  it('initializes empty manifest when /library is empty', () => {
    const manifest = LibraryService.loadManifest();
    expect(manifest.version).toBe(1);
    expect(manifest.documents).toEqual([]);
  });

  it('saves and reads documents directly in root /library directory', async () => {
    const dummyPdf = Buffer.from('%PDF-1.4 dummy content');
    const doc = await LibraryService.saveDocument('sample_test.pdf', dummyPdf, {
      title: 'Sample Physics',
      description: 'Test description'
    });

    expect(doc.filename).toBe('sample_test.pdf');
    expect(doc.format).toBe('pdf');
    expect(doc.title).toBe('Sample Physics');
    expect(doc.description).toBe('Test description');
    expect(doc.position).toBe(0);

    // Verify file is directly in root /library/
    const filePath = path.join(scratch, 'library', 'sample_test.pdf');
    expect(fs.existsSync(filePath)).toBe(true);

    // Verify manifest was saved
    const manifest = LibraryService.loadManifest();
    expect(manifest.documents.length).toBe(1);
    expect(manifest.documents[0].filename).toBe('sample_test.pdf');
  });

  it('auto-discovers unindexed PDF, EPUB, and MOBI files in /library', async () => {
    const libDir = path.join(scratch, 'library');
    fs.mkdirSync(libDir, { recursive: true });

    // Place files directly in /library root
    fs.writeFileSync(path.join(libDir, 'book1.pdf'), '%PDF-1.4 sample');
    fs.writeFileSync(path.join(libDir, 'book2.epub'), 'PK dummy epub');
    fs.writeFileSync(path.join(libDir, 'book3.mobi'), 'BOOKMOBI dummy mobi');

    const docs = await LibraryService.listDocuments();
    expect(docs.length).toBe(3);

    const pdfDoc = docs.find((d) => d.filename === 'book1.pdf');
    const epubDoc = docs.find((d) => d.filename === 'book2.epub');
    const mobiDoc = docs.find((d) => d.filename === 'book3.mobi');

    expect(pdfDoc?.format).toBe('pdf');
    expect(epubDoc?.format).toBe('epub');
    expect(mobiDoc?.format).toBe('mobi');

    expect(pdfDoc?.position).toBe(0);
    expect(epubDoc?.position).toBe(1);
    expect(mobiDoc?.position).toBe(2);
  });

  it('updates document metadata and reorders positions', async () => {
    const dummy = Buffer.from('dummy');
    await LibraryService.saveDocument('a.pdf', dummy, { title: 'Doc A' });
    await LibraryService.saveDocument('b.epub', dummy, { title: 'Doc B' });
    await LibraryService.saveDocument('c.mobi', dummy, { title: 'Doc C' });

    // Reorder: C, A, B
    const reordered = LibraryService.reorderDocuments(['c.mobi', 'a.pdf', 'b.epub']);
    expect(reordered[0].id).toBe('c.mobi');
    expect(reordered[0].position).toBe(0);
    expect(reordered[1].id).toBe('a.pdf');
    expect(reordered[1].position).toBe(1);
    expect(reordered[2].id).toBe('b.epub');
    expect(reordered[2].position).toBe(2);

    // Update metadata
    const updated = LibraryService.updateDocumentMeta('a.pdf', {
      title: 'Renamed Doc A',
      lastPage: 12
    });
    expect(updated?.title).toBe('Renamed Doc A');
    expect(updated?.lastPage).toBe(12);
  });

  it('records reading position checkpoints and syncs lastPage into manifest', async () => {
    const dummy = Buffer.from('dummy');
    await LibraryService.saveDocument('reader_test.pdf', dummy);

    const cp = LibraryService.recordPositionCheckpoint('reader_test.pdf', 15);
    expect(cp.file).toBe('reader_test.pdf:p15');
    expect(cp.verticalPosition).toBe(15);
    expect(cp.courseId).toBe('library');

    // Verify manifest lastPage was synchronized
    const doc = LibraryService.getDocument('reader_test.pdf');
    expect(doc?.lastPage).toBe(15);

    // Verify .checkpoints.json on disk
    const cps = LibraryService.getCheckpoints();
    expect(cps.length).toBe(1);
    expect(cps[0].verticalPosition).toBe(15);
  });

  it('merges markup annotations with last-write-wins', () => {
    const stroke1 = {
      id: 's1',
      file: 'doc.pdf:p1',
      tool: 'marker' as const,
      color: 'yellow' as const,
      points: [10, 10, 20, 20],
      authorWidth: 600,
      date: '2026-10-30T10:00:00.000Z'
    };

    LibraryService.mergeAnnotations([stroke1]);
    expect(LibraryService.getAnnotations().length).toBe(1);

    // Upsert with newer date
    const stroke1Updated = {
      ...stroke1,
      points: [10, 10, 30, 30],
      date: '2026-10-30T11:00:00.000Z'
    };
    LibraryService.mergeAnnotations([stroke1Updated]);

    const annotations = LibraryService.getAnnotations();
    expect(annotations.length).toBe(1);
    expect(annotations[0].points).toEqual([10, 10, 30, 30]);
  });

  it('writes manifest, annotations, and checkpoints atomically with no .tmp leftovers', async () => {
    const dummy = Buffer.from('dummy');
    await LibraryService.saveDocument('atomic.pdf', dummy);
    LibraryService.mergeAnnotations([
      {
        id: 's_atomic',
        file: 'atomic.pdf:p1',
        tool: 'marker',
        color: 'yellow',
        points: [1, 2],
        authorWidth: 500,
        date: new Date().toISOString()
      }
    ]);
    LibraryService.recordPositionCheckpoint('atomic.pdf', 2);

    const libDir = path.join(scratch, 'library');
    for (const dotfile of ['.manifest.json', '.annotations.json', '.checkpoints.json']) {
      const filePath = path.join(libDir, dotfile);
      expect(fs.existsSync(filePath)).toBe(true);
      expect(fs.existsSync(`${filePath}.tmp`)).toBe(false);
      // The rename must have landed complete, valid JSON
      expect(() => JSON.parse(fs.readFileSync(filePath, 'utf8'))).not.toThrow();
    }
  });

  it('deletes document, removes file from disk, and purges annotations and checkpoints', async () => {
    const dummy = Buffer.from('dummy');
    await LibraryService.saveDocument('to_delete.pdf', dummy);
    LibraryService.recordPositionCheckpoint('to_delete.pdf', 4);
    LibraryService.mergeAnnotations([
      {
        id: 'stroke_del',
        file: 'to_delete.pdf:p4',
        tool: 'marker',
        color: 'yellow',
        points: [1, 2],
        authorWidth: 500,
        date: new Date().toISOString()
      }
    ]);

    expect(fs.existsSync(path.join(scratch, 'library', 'to_delete.pdf'))).toBe(true);

    const deleted = LibraryService.deleteDocument('to_delete.pdf');
    expect(deleted).toBe(true);
    expect(fs.existsSync(path.join(scratch, 'library', 'to_delete.pdf'))).toBe(false);

    const manifest = LibraryService.loadManifest();
    expect(manifest.documents.find((d) => d.id === 'to_delete.pdf')).toBeUndefined();
    expect(LibraryService.getCheckpoints().find((c) => c.file.startsWith('to_delete.pdf'))).toBeUndefined();
    expect(LibraryService.getAnnotations().find((s) => s.file.startsWith('to_delete.pdf'))).toBeUndefined();
  });

  it('supports group metadata in saveDocument and updateDocumentMeta', async () => {
    const dummy = Buffer.from('dummy');
    const doc = await LibraryService.saveDocument('grouped.pdf', dummy, {
      title: 'Grouped Doc',
      group: 'Math References'
    });
    expect(doc.group).toBe('Math References');

    // Persisted in manifest
    const manifest1 = LibraryService.loadManifest();
    expect(manifest1.documents.find((d) => d.id === 'grouped.pdf')?.group).toBe('Math References');

    // Update group
    const updated = LibraryService.updateDocumentMeta('grouped.pdf', {
      group: 'Advanced Math'
    });
    expect(updated?.group).toBe('Advanced Math');

    const manifest2 = LibraryService.loadManifest();
    expect(manifest2.documents.find((d) => d.id === 'grouped.pdf')?.group).toBe('Advanced Math');

    // Clear group
    const cleared = LibraryService.updateDocumentMeta('grouped.pdf', {
      group: null
    });
    expect(cleared?.group).toBeUndefined();

    const manifest3 = LibraryService.loadManifest();
    expect(manifest3.documents.find((d) => d.id === 'grouped.pdf')?.group).toBeUndefined();
  });

  it('handles /api/library/refresh endpoint to scan disk and rebuild manifest', async () => {
    const { handleApiRequest } = await import('./api');
    const libDir = path.join(scratch, 'library');
    fs.mkdirSync(libDir, { recursive: true });

    // Place a new file on disk without manifest entry
    fs.writeFileSync(path.join(libDir, 'manual_addition.epub'), 'dummy epub content');

    const req = new Request('http://127.0.0.1:3182/api/library/refresh', { method: 'POST' });
    const res = await handleApiRequest(req, new URL(req.url));
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.success).toBe(true);
    expect(Array.isArray(data.documents)).toBe(true);
    const found = data.documents.find((d: any) => d.filename === 'manual_addition.epub');
    expect(found).toBeDefined();
    expect(found.format).toBe('epub');
  });
});
