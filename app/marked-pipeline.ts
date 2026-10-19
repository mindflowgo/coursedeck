/**
 * Time marked.parse on the EXACT input the app produces, isolating the
 * contribution of repairMarkdownTables (which joins multi-line table rows
 * into single lines) and reporting the longest resulting line lengths.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Marked } from 'marked';
import { parseFrontmatter } from '/Users/fil/Code/app-study-tool/app/src/lib/parser/frontmatter.ts';
import { repairMarkdownTables } from '/Users/fil/Code/app-study-tool/app/src/lib/markdown/tableRepair.ts';

const courseDir = process.argv[2];
const meta = JSON.parse(fs.readFileSync(path.join(courseDir, 'meta.json'), 'utf8'));
const parser = new Marked({ gfm: true, breaks: true });

const lines: string[] = [];
lines.push(`# ${meta.id.toUpperCase()}: ${meta.title}\n\n`);
if (meta.description) lines.push(`> ${meta.description}\n\n`);
let currentUnit = -1;
for (const unit of meta.units) {
  for (const lesson of unit.lessons) {
    const fp = path.join(courseDir, `${lesson.id}.lesson.md`);
    if (!fs.existsSync(fp)) continue;
    const raw = fs.readFileSync(fp, 'utf8');
    const parsed = parseFrontmatter(raw);
    const body = (parsed.body || raw).trim();
    if (!body) continue;
    if (unit.number !== currentUnit) {
      currentUnit = unit.number;
      lines.push(`\n\n---\n\n# Unit ${unit.number}: ${unit.title}\n\n`);
    }
    lines.push(`## Lesson ${lesson.id}: ${lesson.title}\n\n`);
    lines.push(body);
    lines.push('\n\n---\n\n');
  }
}
const aggregate = lines.join('');

function lineStats(text: string) {
  const ls = text.split('\n');
  let max = 0;
  for (const l of ls) if (l.length > max) max = l.length;
  const over = (n: number) => ls.filter((l) => l.length > n).length;
  return { lines: ls.length, maxLen: max, over5k: over(5000), over20k: over(20000), over50k: over(50000) };
}

function timeParse(label: string, text: string) {
  const t0 = performance.now();
  parser.parse(text);
  const ms = performance.now() - t0;
  console.log(
    `${label}: ${ms.toFixed(0)}ms for ${text.length.toLocaleString()} chars ` +
      `(${(text.length / Math.max(ms, 0.001)).toFixed(0)} chars/ms) · ${JSON.stringify(lineStats(text))}`
  );
  return ms;
}

console.log(`course=${meta.id} aggregate=${aggregate.length.toLocaleString()} chars`);
console.log(`raw aggregate line stats: ${JSON.stringify(lineStats(aggregate))}\n`);

const tRepair = performance.now();
const repaired = repairMarkdownTables(aggregate);
console.log(`repairMarkdownTables: ${(performance.now() - tRepair).toFixed(0)}ms`);
console.log(`repaired line stats:    ${JSON.stringify(lineStats(repaired))}\n`);

console.log('--- marked.parse timing ---');
timeParse('WITHOUT table repair', aggregate);
timeParse('WITH table repair   ', repaired);
