/**
 * Test whether marked's cost depends on how the input string was built.
 *
 * The app never parses the raw file text: it parses the output of
 * extractMathFromMarkdown, whose parenthesis scan rebuilds the document with
 * one `res += char` per character. That produces a deeply nested cons/rope
 * string. This measures marked on the same content in three shapes:
 *   - flat         (straight from the file / a replace chain)
 *   - as the app builds it (extractMathFromMarkdown output)
 *   - force-flattened (app output passed through a flat-string round trip)
 */
import fs from 'node:fs';
import path from 'node:path';
import { Marked } from 'marked';
import { parseFrontmatter } from '/Users/fil/Code/ilc-study-tool/app/src/lib/parser/frontmatter.ts';
import { repairMarkdownTables } from '/Users/fil/Code/ilc-study-tool/app/src/lib/markdown/tableRepair.ts';
import { extractMathFromMarkdown } from '/Users/fil/Code/ilc-study-tool/app/src/lib/markdown/mathRenderer.ts';

const courseDir = process.argv[2];
const meta = JSON.parse(fs.readFileSync(path.join(courseDir, 'meta.json'), 'utf8'));
const parser = new Marked({ gfm: true, breaks: true });

const lines: string[] = [];
lines.push(`# ${meta.id.toUpperCase()}: ${meta.title}\n\n`);
for (const unit of meta.units) {
  for (const lesson of unit.lessons) {
    const fp = path.join(courseDir, `${lesson.id}.lesson.md`);
    if (!fs.existsSync(fp)) continue;
    const raw = fs.readFileSync(fp, 'utf8');
    const body = (parseFrontmatter(raw).body || raw).trim();
    if (!body) continue;
    lines.push(`\n\n---\n\n# Unit ${unit.number}: ${unit.title}\n\n`);
    lines.push(`## Lesson ${lesson.id}: ${lesson.title}\n\n`);
    lines.push(body);
    lines.push('\n\n---\n\n');
  }
}
const aggregateRepaired = repairMarkdownTables(lines.join(''));

/** Flat-string round trip: defeats cons/rope representation. */
const flatten = (s: string): string => JSON.parse(JSON.stringify(s)) as string;

function timeParse(label: string, text: string) {
  const t0 = performance.now();
  const html = parser.parse(text) as string;
  const ms = performance.now() - t0;
  console.log(
    `${label.padEnd(34)} ${ms.toFixed(0).padStart(8)}ms  in=${text.length.toLocaleString()} out=${html.length.toLocaleString()}  ` +
      `(${(text.length / Math.max(ms, 0.001)).toFixed(0)} chars/ms)`
  );
  return ms;
}

console.log(`course=${meta.id}  engine=${typeof Bun !== 'undefined' ? 'JavaScriptCore (Bun)' : 'V8 (Node) '}`);
console.log(`repaired aggregate = ${aggregateRepaired.length.toLocaleString()} chars\n`);

const tExtract = performance.now();
const { processedMarkdown } = extractMathFromMarkdown(aggregateRepaired);
console.log(`extractMathFromMarkdown = ${(performance.now() - tExtract).toFixed(0)}ms → ${processedMarkdown.length.toLocaleString()} chars\n`);

timeParse('flat (file/replace chain)', aggregateRepaired);
timeParse('as app builds it (cons/rope)', processedMarkdown);
const flatExtracted = flatten(processedMarkdown);
timeParse('force-flattened copy of same', flatExtracted);

// Control: build a rope by hand from a short string to see if the effect is
// a property of the string shape rather than of this particular content.
const base = 'The quick brown fox jumps over the lazy dog. ';
let rope = '';
for (let i = 0; i < 20000; i++) rope += base[i % base.length];
console.log(`\ncontrol rope built by += (${rope.length.toLocaleString()} chars):`);
timeParse('  control rope as built', rope);
timeParse('  control rope flattened', flatten(rope));
