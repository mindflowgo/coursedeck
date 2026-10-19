/**
 * Write the BAF3M aggregate (and its per-lesson chunks) to disk so the system
 * JavaScriptCore shell can parse them — the same engine WKWebView uses.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseFrontmatter } from '/Users/fil/Code/app-study-tool/app/src/lib/parser/frontmatter.ts';
import { repairMarkdownTables } from '/Users/fil/Code/app-study-tool/app/src/lib/markdown/tableRepair.ts';

const courseDir = process.argv[2] || '/Users/fil/Documents/Evan_Education/ilc/courses/baf3m';
const meta = JSON.parse(fs.readFileSync(path.join(courseDir, 'meta.json'), 'utf8'));

const lines: string[] = [];
const chunks: Array<{ id: string; text: string }> = [];
lines.push(`# ${meta.id.toUpperCase()}: ${meta.title}\n\n`);

for (const unit of meta.units) {
  for (const lesson of unit.lessons) {
    const fp = path.join(courseDir, `${lesson.id}.lesson.md`);
    if (!fs.existsSync(fp)) continue;
    const raw = fs.readFileSync(fp, 'utf8');
    const body = (parseFrontmatter(raw).body || raw).trim();
    if (!body) continue;
    const unitHeader = `\n\n---\n\n# Unit ${unit.number}: ${unit.title}\n\n`;
    const lessonHeader = `## Lesson ${lesson.id}: ${lesson.title}\n\n`;
    lines.push(unitHeader + lessonHeader + body + '\n\n---\n\n');
    chunks.push({ id: lesson.id, text: lessonHeader + body });
  }
}

const aggregate = repairMarkdownTables(lines.join(''));
fs.writeFileSync('/tmp/baf3m-aggregate.md', aggregate, 'utf8');
fs.writeFileSync('/tmp/baf3m-chunks.json', JSON.stringify(chunks), 'utf8');

const filler = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. ';
const synthetic = filler.repeat(Math.ceil(aggregate.length / filler.length)).slice(0, aggregate.length);
fs.writeFileSync('/tmp/baf3m-synthetic.txt', synthetic, 'utf8');

console.log(`aggregate ${aggregate.length.toLocaleString()} chars → /tmp/baf3m-aggregate.md`);
console.log(`chunks ${chunks.length} → /tmp/baf3m-chunks.json`);
console.log(`synthetic ${synthetic.length.toLocaleString()} chars → /tmp/baf3m-synthetic.txt`);
