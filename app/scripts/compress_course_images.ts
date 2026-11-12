/**
 * Compresses oversized course images and normalizes markdown image specs.
 *
 * Usage:
 *   bun run scripts/compress_course_images.ts            # all courses
 *   bun run scripts/compress_course_images.ts baf3m      # one course
 *   DATA_DIR=/custom/data bun run scripts/compress_course_images.ts
 */
import fs from 'node:fs';
import path from 'node:path';
import { optimizeCourseImages } from '../src/lib/parser/imageOptimizer';

const dataDir = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR, 'courses')
  : path.resolve(process.cwd(), '../data/courses');

const requested = process.argv[2]?.toLowerCase();

if (!fs.existsSync(dataDir)) {
  console.error(`Courses directory not found: ${dataDir}`);
  process.exit(1);
}

const courseIds = requested
  ? [requested]
  : fs
      .readdirSync(dataDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name);

if (requested && !fs.existsSync(path.join(dataDir, requested))) {
  console.error(`Course not found: ${requested} (in ${dataDir})`);
  process.exit(1);
}

const mb = (n: number) => `${(n / 1048576).toFixed(2)}MB`;
const grandTotals = { converted: 0, before: 0, after: 0 };

for (const courseId of courseIds) {
  const t0 = performance.now();
  const s = await optimizeCourseImages(path.join(dataDir, courseId));
  grandTotals.converted += s.converted;
  grandTotals.before += s.bytesBefore;
  grandTotals.after += s.bytesAfter;
  console.log(
    `${courseId.padEnd(8)} scanned=${s.scanned} converted=${s.converted} ` +
      `${s.bytesBefore ? `${mb(s.bytesBefore)}→${mb(s.bytesAfter)} ` : ''}` +
      `mdRefs=${s.markdownRefsUpdated} (${(performance.now() - t0).toFixed(0)}ms)`
  );
}

console.log(
  `\nTotal: ${grandTotals.converted} image(s) compressed, ${mb(grandTotals.before)} → ${mb(grandTotals.after)}`
);
