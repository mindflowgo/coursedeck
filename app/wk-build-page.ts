/**
 * Build a self-contained HTML page that runs marked on the real BAF3M
 * aggregate inside a WKWebView. Both the marked ESM source and the content
 * travel as base64 so no library/HTML escaping can interfere, and every stage
 * plus any error is reported back through window.__state.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseFrontmatter } from '/Users/fil/Code/app-study-tool/app/src/lib/parser/frontmatter.ts';
import { repairMarkdownTables } from '/Users/fil/Code/app-study-tool/app/src/lib/markdown/tableRepair.ts';

const courseDir = process.argv[2] || '/Users/fil/Documents/Evan_Education/ilc/courses/baf3m';
const meta = JSON.parse(fs.readFileSync(path.join(courseDir, 'meta.json'), 'utf8'));

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
const content = repairMarkdownTables(lines.join(''));
const markedEsm = fs.readFileSync('/Users/fil/Code/app-study-tool/app/node_modules/marked/lib/marked.esm.js', 'utf8');

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>wk-marked-bench</title></head>
<body>
<script id="marked-src" type="text/plain">${b64(markedEsm)}</script>
<script id="md-src" type="text/plain">${b64(content)}</script>
<script>
window.__state = { stage: 'boot' };
window.onerror = function (msg, src, line, col, err) {
  window.__state = { stage: 'error', message: String(msg), line: line, col: col, stack: err && err.stack ? String(err.stack).slice(0, 400) : null };
};
window.addEventListener('unhandledrejection', function (e) {
  window.__state = { stage: 'rejection', message: String(e.reason && e.reason.message || e.reason) };
});
function decode(id) {
  const b = document.getElementById(id).textContent.trim();
  const bytes = Uint8Array.from(atob(b), (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
(async function () {
  try {
    window.__state = { stage: 'decoding' };
    const src = decode('marked-src');
    const content = decode('md-src');
    window.__state = { stage: 'decoded', markedSrcChars: src.length, contentChars: content.length };

    const blobUrl = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    const mod = await import(blobUrl);
    const MarkedCtor = mod.Marked || mod.marked;
    window.__state = { stage: 'module-loaded', exports: Object.keys(mod).join(','), hasMarked: !!MarkedCtor };

    const parser = new MarkedCtor({ gfm: true, breaks: true });
    parser.use({ renderer: { image: function (token) { return '<img src="' + token.href + '">'; } } });

    let t0 = performance.now();
    const out = parser.parse(content);
    const parseMs = +(performance.now() - t0).toFixed(1);

    t0 = performance.now();
    parser.parse(content);
    const parseMsWarm = +(performance.now() - t0).toFixed(1);

    t0 = performance.now();
    const tokens = parser.lexer(content);
    const lexerMs = +(performance.now() - t0).toFixed(1);

    const filler = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. ';
    const plain = filler.repeat(Math.ceil(content.length / filler.length)).slice(0, content.length);
    t0 = performance.now();
    parser.parse(plain);
    const parseSyntheticMs = +(performance.now() - t0).toFixed(1);

    window.__state = {
      stage: 'done',
      userAgent: navigator.userAgent,
      contentChars: content.length,
      outChars: out.length,
      tokenCount: tokens.length,
      parseMs: parseMs,
      parseMsWarm: parseMsWarm,
      lexerMs: lexerMs,
      parseSyntheticPlainTextMs: parseSyntheticMs
    };
  } catch (e) {
    window.__state = { stage: 'threw', message: String(e && e.message || e), stack: String(e && e.stack || '').slice(0, 500) };
  }
})();
</script>
</body></html>`;

fs.writeFileSync('/tmp/wk-marked-test.html', html, 'utf8');
console.log(`wrote /tmp/wk-marked-test.html (content ${content.length.toLocaleString()} chars, page ${html.length.toLocaleString()} chars)`);
