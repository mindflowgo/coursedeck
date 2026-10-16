/**
 * Offline verification for the vector PDF pipeline.
 *
 * Compiles real course documents through the same compiler modules the app
 * uses (markdown/blocks, quiz, document), stubs the browser image store,
 * renders actual PDFs with pdfmake + the bundled DejaVu fonts, and checks
 * page counts, ToUnicode text maps, and timing.
 *
 * Usage: bun run scripts/pdf-smoke.ts
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pdfMake from 'pdfmake';

const APP_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = join(APP_ROOT, '..', 'data', 'courses');
const FONT_DIR = join(APP_ROOT, 'src', 'lib', 'pdf', 'assets');

const { compileMarkdownContent } = await import('../src/lib/pdf/markdown/blocks');
const { compileQuizContent } = await import('../src/lib/pdf/quiz');
const { buildDocDefinition } = await import('../src/lib/pdf/document');
import type { CompileContext, EmbeddedImage, ImageSpec } from '../src/lib/pdf/types';

// --- Valid 8x6 red PNG to stand in for real course images ---------------
const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAGCAYAAAD+Bd/7AAAAEklEQVR42mO4ExDwHx9mGAoKAATQdxEAHNb0AAAAAElFTkSuQmCC';

let embeddedImages = 0;
const stubEmbed = (_url: string, _spec: ImageSpec, mode: 'block' | 'inline'): EmbeddedImage => {
  embeddedImages++;
  if (mode === 'inline') return { text: '🔹' };
  return { image: TINY_PNG, width: 240, height: 140 };
};

const ctx: CompileContext = { courseId: 'baf3m', embedImage: stubEmbed };

// --- Register DejaVu on the server pdfmake build ---------------------------
const b64 = (p: string) => readFileSync(p).toString('base64');
for (const f of readdirSync(FONT_DIR).filter((f) => f.endsWith('.ttf'))) {
  (pdfMake as any).virtualfs.writeFileSync(f, b64(join(FONT_DIR, f)), 'base64');
}
(pdfMake as any).addFonts({
  DejaVu: {
    normal: 'DejaVuSans.ttf',
    bold: 'DejaVuSans-Bold.ttf',
    italics: 'DejaVuSans-Oblique.ttf',
    bolditalics: 'DejaVuSans-BoldOblique.ttf'
  },
  DejaVuMono: {
    normal: 'DejaVuSansMono.ttf',
    bold: 'DejaVuSansMono-Bold.ttf',
    italics: 'DejaVuSansMono.ttf',
    bolditalics: 'DejaVuSansMono-Bold.ttf'
  }
});

interface Case {
  name: string;
  file: string;
  tab: 'lesson' | 'summary' | 'cheatsheet' | 'test';
}

function firstLessonFile(courseId: string): string {
  try {
    return courseId + '/' + (readdirSync(join(DATA_DIR, courseId)).find((f) => f.endsWith('.lesson.md')) ?? '');
  } catch {
    return '';
  }
}

const cases: Case[] = [
  { name: 'lesson-rich', file: 'baf3m/02.06.lesson.md', tab: 'lesson' },
  { name: 'lesson-details', file: firstLessonFile('clu3m'), tab: 'lesson' },
  { name: 'summary', file: 'baf3m/03.05.summary.md', tab: 'summary' },
  { name: 'test', file: 'gwl3o/04.03.test.md', tab: 'test' }
];

let failed = 0;
let skipped = 0;

for (const c of cases) {
  if (!c.file || c.file.endsWith('/')) continue;
  // This smoke test compiles real ingested courses; skip cases whose fixture
  // is not present in the local data dir instead of crashing the whole suite.
  if (!existsSync(join(DATA_DIR, c.file))) {
    skipped++;
    console.log(`- ${c.name}: skipped (no fixture at data/courses/${c.file})`);
    continue;
  }
  const raw = readFileSync(join(DATA_DIR, c.file), 'utf-8');
  const t0 = performance.now();
  let doc: any;
  try {
    const body = c.tab === 'test' ? compileQuizContent(raw) : compileMarkdownContent(raw, ctx);
    const docJson = JSON.stringify(body);
    if (docJson.includes('undefined')) throw new Error('undefined leaked into content');
    doc = buildDocDefinition(
      {
        courseCode: c.file.split('/')[0].toUpperCase(),
        courseTitle: 'Financial Accounting Fundamentals',
        lessonId: c.file.split('/').pop()!.split('.')[0] + '.' + c.file.split('/').pop()!.split('.')[1],
        lessonTitle: 'Smoke Test Lesson',
        tab: c.tab,
        tabDisplayName: c.tab === 'test' ? 'Practice Test' : c.tab,
        rawMarkdown: raw,
        version: 2
      },
      body
    );
  } catch (err) {
    console.error(`✗ ${c.name}: COMPILE FAILED`, err);
    failed++;
    continue;
  }
  const compileMs = performance.now() - t0;

  const t1 = performance.now();
  try {
    const buffer = await (pdfMake as any).createPdf(doc).getBuffer();
    const ab = Buffer.isBuffer(buffer) ? buffer : Buffer.from(await new Response(buffer).arrayBuffer());
    const out = `/tmp/pdf-smoke-${c.name}.pdf`;
    writeFileSync(out, ab);

    const pages = (ab.toString('binary').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
    const hasTounicode = ab.toString('binary').includes('/ToUnicode');
    const sizeKb = Math.round(ab.length / 1024);

    console.log(
      `✓ ${c.name.padEnd(15)} compile=${compileMs.toFixed(0).padStart(4)}ms render=${(performance.now() - t1).toFixed(0).padStart(4)}ms  pages=${pages}  ${sizeKb}KB  ToUnicode=${hasTounicode}`
    );
    if (pages === 0 || !hasTounicode) {
      console.error(`  ✗ sanity check failed for ${c.name}`);
      failed++;
    }
  } catch (err) {
    console.error(`✗ ${c.name}: RENDER FAILED`, err);
    failed++;
  }
}

console.log(`\nEmbedded images stubbed: ${embeddedImages}`);
if (skipped > 0) {
  console.log(`${skipped} case(s) skipped (missing local course fixtures).`);
}
if (failed > 0) {
  console.error(`${failed} case(s) FAILED`);
  process.exit(1);
}
console.log('All PDF smoke cases passed.');
