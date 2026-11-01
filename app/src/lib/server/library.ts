import fs from 'node:fs';
import path from 'node:path';
import { getLibraryDir, safeJoin } from './paths';
import { isMarkupStroke, type MarkupStroke } from '../markup/types';
import { type Checkpoint } from '../checkpoint';

export type LibraryDocumentFormat = 'pdf' | 'epub' | 'mobi';

export interface LibraryDocument {
  id: string;
  filename: string;
  format: LibraryDocumentFormat;
  title: string;
  description: string;
  additionDate: string;
  thumbnail?: string;
  pages?: number;
  lastPage?: number;
  fileSize?: number;
  position: number;
  group?: string;
}

export interface LibraryManifest {
  version: number;
  documents: LibraryDocument[];
}

function detectFormat(filename: string): LibraryDocumentFormat | null {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.pdf') return 'pdf';
  if (ext === '.epub') return 'epub';
  if (ext === '.mobi') return 'mobi';
  return null;
}

function formatTitleFromFilename(filename: string): string {
  const base = path.basename(filename, path.extname(filename));
  return base
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Writes JSON via `<file>.tmp` + rename so a crash mid-write can never
 * truncate an existing file (rename is atomic within a directory).
 */
function writeJsonFileAtomic(filePath: string, data: unknown): void {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

async function extractPdfPageCountAndTitle(
  buffer: Buffer
): Promise<{ pages?: number; title?: string }> {
  try {
    const { PDFParse } = (await import('pdf-parse')) as any;
    const worker = (await import('pdf-parse/worker')) as any;
    if (worker && typeof worker.getData === 'function' && typeof PDFParse.setWorker === 'function') {
      PDFParse.setWorker(worker.getData());
    }
    const parser = new PDFParse(new Uint8Array(buffer));
    const info = await parser.getInfo();
    const pages = typeof info?.total === 'number' && info.total > 0 ? info.total : undefined;
    const rawTitle = info?.info?.Title;
    const title = typeof rawTitle === 'string' && rawTitle.trim() ? rawTitle.trim() : undefined;
    return { pages, title };
  } catch {
    return {};
  }
}

export class LibraryService {
  static getDir(): string {
    return getLibraryDir();
  }

  static getManifestPath(): string {
    return safeJoin(this.getDir(), '.manifest.json');
  }

  static getAnnotationsPath(): string {
    return safeJoin(this.getDir(), '.annotations.json');
  }

  static getCheckpointsPath(): string {
    return safeJoin(this.getDir(), '.checkpoints.json');
  }

  // ── Manifest Management ──────────────────────────────────────────────────

  static loadManifest(): LibraryManifest {
    const p = this.getManifestPath();
    if (!fs.existsSync(p)) {
      return { version: 1, documents: [] };
    }
    try {
      const raw = fs.readFileSync(p, 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return { version: 1, documents: parsed };
      }
      if (parsed && Array.isArray(parsed.documents)) {
        return { version: parsed.version || 1, documents: parsed.documents };
      }
    } catch (e) {
      console.warn(`[Library] Failed to read manifest from ${p}:`, e);
    }
    return { version: 1, documents: [] };
  }

  static saveManifest(manifest: LibraryManifest): boolean {
    const p = this.getManifestPath();
    try {
      writeJsonFileAtomic(p, manifest);
      return true;
    } catch (e) {
      console.error(`[Library] Failed to write manifest to ${p}:`, e);
      return false;
    }
  }

  /**
   * Scans <dataDir>/library/ for .pdf, .epub, and .mobi files directly in the root directory.
   * Auto-indexes newly found files, removes missing files, and normalizes positions.
   */
  static async syncWithDisk(): Promise<LibraryDocument[]> {
    const dir = this.getDir();
    const manifest = this.loadManifest();
    const docMap = new Map<string, LibraryDocument>(
      manifest.documents.map((d) => [d.filename, d])
    );

    let changed = false;
    const diskFiles = fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));

    // Track active disk filenames
    const activeFilenames = new Set<string>();

    for (const entry of diskFiles) {
      if (!entry.isFile()) continue;
      const fmt = detectFormat(entry.name);
      if (!fmt) continue;

      activeFilenames.add(entry.name);
      const fullPath = safeJoin(dir, entry.name);
      const stat = fs.statSync(fullPath);

      if (!docMap.has(entry.name)) {
        // Discovered new file on disk
        let pages: number | undefined;
        let titleFromPdf: string | undefined;

        if (fmt === 'pdf') {
          try {
            const buf = fs.readFileSync(fullPath);
            const extracted = await extractPdfPageCountAndTitle(buf);
            pages = extracted.pages;
            titleFromPdf = extracted.title;
          } catch {}
        }

        const newDoc: LibraryDocument = {
          id: entry.name,
          filename: entry.name,
          format: fmt,
          title: titleFromPdf || formatTitleFromFilename(entry.name),
          description: '',
          additionDate: stat.birthtime?.toISOString?.() || stat.mtime?.toISOString?.() || new Date().toISOString(),
          pages: pages || (fmt === 'pdf' ? 1 : undefined),
          lastPage: 1,
          fileSize: stat.size,
          position: docMap.size
        };

        docMap.set(entry.name, newDoc);
        changed = true;
      } else {
        // Update file size if changed
        const existing = docMap.get(entry.name)!;
        if (existing.fileSize !== stat.size) {
          existing.fileSize = stat.size;
          changed = true;
        }
      }
    }

    // Prune removed files
    for (const filename of Array.from(docMap.keys())) {
      if (!activeFilenames.has(filename)) {
        docMap.delete(filename);
        changed = true;
      }
    }

    // Normalize positions
    const docs = Array.from(docMap.values());
    docs.sort((a, b) => {
      const posA = typeof a.position === 'number' ? a.position : 999999;
      const posB = typeof b.position === 'number' ? b.position : 999999;
      if (posA !== posB) return posA - posB;
      const dateA = new Date(a.additionDate).getTime();
      const dateB = new Date(b.additionDate).getTime();
      if (dateA !== dateB) return dateB - dateA;
      return a.filename.localeCompare(b.filename);
    });

    docs.forEach((doc, idx) => {
      if (doc.position !== idx) {
        doc.position = idx;
        changed = true;
      }
    });

    if (changed) {
      manifest.documents = docs;
      this.saveManifest(manifest);
    }

    return docs;
  }

  static async listDocuments(): Promise<LibraryDocument[]> {
    return this.syncWithDisk();
  }

  static getDocument(id: string): LibraryDocument | null {
    const manifest = this.loadManifest();
    const cleanId = id.trim().toLowerCase();
    return manifest.documents.find((d) => d.id.toLowerCase() === cleanId || d.filename.toLowerCase() === cleanId) || null;
  }

  static async saveDocument(
    filename: string,
    buffer: Buffer,
    meta?: { title?: string; description?: string; group?: string }
  ): Promise<LibraryDocument> {
    const cleanName = path.basename(filename).trim();
    const fmt = detectFormat(cleanName);
    if (!fmt) {
      throw new Error(`Unsupported document format for "${cleanName}". Allowed: .pdf, .epub, .mobi`);
    }

    const fullPath = safeJoin(this.getDir(), cleanName);
    fs.writeFileSync(fullPath, buffer);

    let pages: number | undefined;
    let extractedTitle: string | undefined;

    if (fmt === 'pdf') {
      const extracted = await extractPdfPageCountAndTitle(buffer);
      pages = extracted.pages;
      extractedTitle = extracted.title;
    }

    const manifest = this.loadManifest();
    const existingIdx = manifest.documents.findIndex(
      (d) => d.filename.toLowerCase() === cleanName.toLowerCase()
    );

    const docGroup = meta?.group?.trim() || (existingIdx >= 0 ? manifest.documents[existingIdx].group : undefined);

    const doc: LibraryDocument = {
      id: cleanName,
      filename: cleanName,
      format: fmt,
      title: meta?.title?.trim() || extractedTitle || formatTitleFromFilename(cleanName),
      description: meta?.description?.trim() || '',
      additionDate: new Date().toISOString(),
      pages: pages || (fmt === 'pdf' ? 1 : undefined),
      lastPage: existingIdx >= 0 ? manifest.documents[existingIdx].lastPage || 1 : 1,
      fileSize: buffer.length,
      position: existingIdx >= 0 ? manifest.documents[existingIdx].position : manifest.documents.length,
      ...(docGroup ? { group: docGroup } : {})
    };

    if (existingIdx >= 0) {
      manifest.documents[existingIdx] = doc;
    } else {
      manifest.documents.push(doc);
    }

    this.saveManifest(manifest);
    return doc;
  }

  static updateDocumentMeta(
    id: string,
    patch: { title?: string; description?: string; lastPage?: number; position?: number; thumbnail?: string; group?: string | null }
  ): LibraryDocument | null {
    const manifest = this.loadManifest();
    const cleanId = id.trim().toLowerCase();
    const idx = manifest.documents.findIndex(
      (d) => d.id.toLowerCase() === cleanId || d.filename.toLowerCase() === cleanId
    );
    if (idx === -1) return null;

    const doc = manifest.documents[idx];
    if (patch.title !== undefined) doc.title = patch.title.trim();
    if (patch.description !== undefined) doc.description = patch.description.trim();
    if (typeof patch.lastPage === 'number' && patch.lastPage >= 1) doc.lastPage = patch.lastPage;
    if (typeof patch.position === 'number') doc.position = patch.position;
    if (patch.thumbnail !== undefined) doc.thumbnail = patch.thumbnail;
    if (patch.group !== undefined) {
      if (patch.group === null || !patch.group.trim()) {
        delete doc.group;
      } else {
        doc.group = patch.group.trim();
      }
    }

    this.saveManifest(manifest);
    return doc;
  }

  static reorderDocuments(orderedIds: string[]): LibraryDocument[] {
    const manifest = this.loadManifest();
    const byId = new Map(manifest.documents.map((d) => [d.id.toLowerCase(), d]));

    const reordered: LibraryDocument[] = [];
    const used = new Set<string>();

    orderedIds.forEach((rawId, index) => {
      const id = rawId.toLowerCase();
      const doc = byId.get(id);
      if (doc) {
        doc.position = index;
        reordered.push(doc);
        used.add(id);
      }
    });

    // Append any documents not in orderedIds to preserve them
    let nextPos = reordered.length;
    for (const doc of manifest.documents) {
      if (!used.has(doc.id.toLowerCase())) {
        doc.position = nextPos++;
        reordered.push(doc);
      }
    }

    manifest.documents = reordered;
    this.saveManifest(manifest);
    return reordered;
  }

  static deleteDocument(id: string): boolean {
    const manifest = this.loadManifest();
    const cleanId = id.trim().toLowerCase();
    const doc = manifest.documents.find(
      (d) => d.id.toLowerCase() === cleanId || d.filename.toLowerCase() === cleanId
    );
    if (!doc) return false;

    // Delete file
    const filePath = safeJoin(this.getDir(), doc.filename);
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (e) {
      console.warn(`[Library] Failed to delete file ${filePath}:`, e);
    }

    // Delete from manifest
    manifest.documents = manifest.documents.filter((d) => d.id !== doc.id && d.filename !== doc.filename);
    manifest.documents.forEach((d, i) => (d.position = i));
    this.saveManifest(manifest);

    // Clean up associated annotations and checkpoints
    this.deleteAnnotationsForFile(doc.filename);
    this.deleteCheckpointsForFile(doc.filename);

    return true;
  }

  // ── Annotations (.annotations.json in /library root) ──────────────────────

  static getAnnotations(): MarkupStroke[] {
    const filePath = this.getAnnotationsPath();
    if (!fs.existsSync(filePath)) return [];
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isMarkupStroke);
    } catch (e) {
      console.warn(`[Library] Failed to read annotations from ${filePath}:`, e);
      return [];
    }
  }

  static saveAnnotations(strokes: MarkupStroke[]): boolean {
    const filePath = this.getAnnotationsPath();
    try {
      writeJsonFileAtomic(filePath, strokes);
      return true;
    } catch (e) {
      console.error(`[Library] Failed to save annotations to ${filePath}:`, e);
      return false;
    }
  }

  static mergeAnnotations(upserts: MarkupStroke[]): { strokes: MarkupStroke[]; merged: number } {
    const existing = this.getAnnotations();
    const byId = new Map(existing.map((s) => [s.id, s]));
    let merged = 0;
    for (const up of upserts) {
      if (!isMarkupStroke(up)) continue;
      const cur = byId.get(up.id);
      if (!cur || new Date(up.date).getTime() >= new Date(cur.date).getTime()) {
        byId.set(up.id, up);
        merged++;
      }
    }
    const strokes = Array.from(byId.values());
    this.saveAnnotations(strokes);
    return { strokes, merged };
  }

  private static deleteAnnotationsForFile(filename: string): void {
    const existing = this.getAnnotations();
    const prefix = `${filename}:`;
    const filtered = existing.filter((s) => !s.file.startsWith(prefix) && s.file !== filename);
    if (filtered.length !== existing.length) {
      this.saveAnnotations(filtered);
    }
  }

  // ── Checkpoints (.checkpoints.json in /library root) ───────────────────────

  static getCheckpoints(): Checkpoint[] {
    const filePath = this.getCheckpointsPath();
    if (!fs.existsSync(filePath)) return [];
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      console.warn(`[Library] Failed to read checkpoints from ${filePath}:`, e);
      return [];
    }
  }

  static saveCheckpoints(checkpoints: Checkpoint[]): boolean {
    const filePath = this.getCheckpointsPath();
    try {
      writeJsonFileAtomic(filePath, checkpoints);
      return true;
    } catch (e) {
      console.error(`[Library] Failed to save checkpoints to ${filePath}:`, e);
      return false;
    }
  }

  static recordPositionCheckpoint(filename: string, pageNumber: number): Checkpoint {
    const cleanFile = path.basename(filename).trim();
    const fileKey = `${cleanFile}:p${pageNumber}`;
    const checkpoints = this.getCheckpoints();
    const now = new Date().toISOString();

    const existingIdx = checkpoints.findIndex(
      (c) => c.type === 'position' && (c.file.startsWith(`${cleanFile}:p`) || c.file === cleanFile)
    );

    let posCp: Checkpoint;
    if (existingIdx !== -1) {
      posCp = {
        ...checkpoints[existingIdx],
        file: fileKey,
        verticalPosition: pageNumber,
        date: now
      };
      checkpoints[existingIdx] = posCp;
    } else {
      posCp = {
        id: `pos_library_${cleanFile.replace(/[^a-z0-9_-]/gi, '_')}`,
        courseId: 'library',
        file: fileKey,
        verticalPosition: pageNumber,
        type: 'position',
        date: now
      };
      checkpoints.push(posCp);
    }

    this.saveCheckpoints(checkpoints);

    // Keep manifest lastPage updated in sync
    this.updateDocumentMeta(cleanFile, { lastPage: pageNumber });

    return posCp;
  }

  static addOrUpdateNoteCheckpoint(note: {
    id?: string;
    file: string;
    verticalPosition: number;
    color?: string;
    noteText?: string;
  }): Checkpoint {
    const checkpoints = this.getCheckpoints();
    const now = new Date().toISOString();

    if (note.id) {
      const idx = checkpoints.findIndex((c) => c.id === note.id);
      if (idx !== -1) {
        checkpoints[idx] = {
          ...checkpoints[idx],
          file: note.file,
          verticalPosition: note.verticalPosition,
          color: note.color || checkpoints[idx].color || 'yellow',
          noteText: note.noteText ?? checkpoints[idx].noteText ?? '',
          date: now
        };
        this.saveCheckpoints(checkpoints);
        return checkpoints[idx];
      }
    }

    const newCp: Checkpoint = {
      id: note.id || `library_note_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      courseId: 'library',
      file: note.file,
      verticalPosition: note.verticalPosition,
      type: 'note',
      color: note.color || 'yellow',
      noteText: note.noteText || '',
      date: now
    };

    checkpoints.push(newCp);
    this.saveCheckpoints(checkpoints);
    return newCp;
  }

  static deleteCheckpoint(checkpointId: string): boolean {
    const checkpoints = this.getCheckpoints();
    const filtered = checkpoints.filter((c) => c.id !== checkpointId);
    if (filtered.length !== checkpoints.length) {
      this.saveCheckpoints(filtered);
      return true;
    }
    return false;
  }

  private static deleteCheckpointsForFile(filename: string): void {
    const checkpoints = this.getCheckpoints();
    const prefix = `${filename}:`;
    const filtered = checkpoints.filter((c) => !c.file.startsWith(prefix) && c.file !== filename);
    if (filtered.length !== checkpoints.length) {
      this.saveCheckpoints(filtered);
    }
  }
}
