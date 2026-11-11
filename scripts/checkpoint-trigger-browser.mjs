import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';

// Run with Bun after installing app dependencies. Playwright is optional:
// install it locally or set PLAYWRIGHT_MODULE to its module file. Set
// PLAYWRIGHT_EXECUTABLE_PATH only when using a separately installed Chromium.
const project = fileURLToPath(new URL('../', import.meta.url));
const app = join(project, 'app');
const fixture = join(project, 'scripts/fixtures/CheckpointTrigger.svelte').replaceAll('\\', '/');
const { createServer } = await import(pathToFileURL(join(app, 'node_modules/vite/dist/node/index.js')).href);
const { svelte } = await import(pathToFileURL(join(app, 'node_modules/@sveltejs/vite-plugin-svelte/src/index.js')).href);
const { buildLessonBridgeScript } = await import(pathToFileURL(join(app, 'src/lib/server/lessonBridge.ts')).href);
const playwrightModule = process.env.PLAYWRIGHT_MODULE || 'playwright';
const { chromium } = await import(isAbsolute(playwrightModule) ? pathToFileURL(playwrightModule).href : playwrightModule);
const cacheDir = await mkdtemp(join(tmpdir(), 'coursedeck-trigger-'));
const fixtureHandler = (_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end(`<html><head><style>
    body { margin:0; } .absolute {position:absolute} .inset-0 {inset:0}
    .pointer-events-none {pointer-events:none} .pointer-events-auto {pointer-events:auto}
    .right-2 {right:8px} .flex {display:flex} button {height:36px;min-width:48px}
    [role=toolbar] {z-index:30}
  </style></head><body><script type="module" src="/__trigger-entry.js"></script></body></html>`);
};
const server = await createServer({
  root: app, configFile: false,
  plugins: [{
    name: 'trigger-fixture',
    configureServer(server) {
      server.middlewares.use('/__trigger', fixtureHandler);
      server.middlewares.use('/api/courses/fixture', (_req, res) => {
        res.setHeader('Content-Type', 'text/html');
        res.end(`<html><head>${buildLessonBridgeScript('fixture')}</head><body><p id="passage">Synthetic lesson passage.</p></body></html>`);
      });
    },
    resolveId(id) {
      if (id === '/__trigger-entry.js') return '\0trigger-entry';
      if (id === '$lib/api') return '\0trigger-api';
    },
    load(id) {
      if (id === '\0trigger-api') return 'export const getApiBaseUrl = () => "";';
      if (id === '\0trigger-entry') return `import {mount} from 'svelte'; import Fixture from ${JSON.stringify('/@fs/' + fixture)}; mount(Fixture, {target: document.body});`;
    }
  }, svelte({ configFile: false })],
  cacheDir,
  optimizeDeps: { include: ['svelte', 'lucide-svelte'] },
  resolve: { dedupe: ['svelte'], alias: { '$lib': join(app, 'src/lib').replaceAll('\\', '/') } },
  server: { host: '127.0.0.1', port: 0, fs: { allow: [project] } }
});
await server.listen();
const address = server.httpServer.address();
let browser;
try {
  browser = await chromium.launch(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {});
  const page = await browser.newPage({viewport:{width:1000,height:900}});
  const errors = [];
  page.on('pageerror', e => { errors.push(e.message); console.log('PAGE ERROR', e.stack); });
  page.on('console', message => { if(message.type()==='error') console.log('CONSOLE ERROR',message.text()); });
  page.on('response', response => {if(response.status()>=400)console.log('HTTP ERROR',response.status(),response.url());});
  await page.goto(`http://127.0.0.1:${address.port}/__trigger`);
  const control = page.getByRole('toolbar');
  await control.waitFor();
  const center = async () => { const b = await control.boundingBox(); return b.y + b.height/2; };
  for (const y of [400, 450, 451, 449, 500, 400]) {
    await page.mouse.move(300,y);
    await page.waitForTimeout(40);
    assert.ok(Math.abs(await center()-y)<1, `pointer ${y}, control ${await center()}`);
  }
  await page.evaluate(() => { document.querySelector('#reader').scrollTop=700; });
  await page.mouse.move(300,470);
  await page.waitForTimeout(30);
  assert.ok(Math.abs(await center()-470)<1,'scroll must not move control from pointer');
  await page.evaluate(() => window.fixture.external(250));
  await page.waitForTimeout(30);
  assert.ok(Math.abs(await center()-430)<1,'iframe coordinates');
  await page.mouse.move(300,520);
  await page.waitForTimeout(30);
  assert.ok(Math.abs(await center()-520)<1,'old iframe position must not override parent movement');
  await control.getByRole('button').click();
  await page.mouse.move(300,600);
  assert.ok(Math.abs(await center()-520)<1,'expanded control frozen');
  await page.mouse.click(300,600);
  await page.waitForTimeout(30);
  assert.ok(Math.abs(await center()-520)<1,'collapse must not replay old iframe position');
  await page.mouse.move(300,530);
  await page.waitForTimeout(30);
  await control.getByRole('button').click();
  await page.getByRole('button',{name:'Note',exact:true}).click();
  assert.equal(await page.evaluate(()=>window.lastAction),1050,'saved position includes scroll exactly once');
  await page.evaluate(() => {
    const el=document.querySelector('#reader');
    el.dispatchEvent(new PointerEvent('pointerdown',{pointerType:'touch',pointerId:1,clientX:300,clientY:400,bubbles:true}));
    el.dispatchEvent(new PointerEvent('pointerup',{pointerType:'touch',pointerId:1,clientX:300,clientY:480,bubbles:true}));
  });
  await page.waitForTimeout(30);
  assert.ok(Math.abs(await center()-480)<1,'touch end position');
  await page.mouse.move(300,190);
  await page.waitForTimeout(30);
  assert.equal(await center(),236,'top clearance');
  await page.mouse.move(300,779);
  await page.waitForTimeout(30);
  assert.equal(await center(),760,'bottom clearance');
  // Keyboard access freezes the control, preserves focus within the menu,
  // and Escape restores focus to the compact trigger without replaying an
  // old iframe event.
  await control.getByRole('button').focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Highlight selected text');
  await page.mouse.move(300,400);
  assert.equal(await center(),760,'keyboard menu stays at its anchor');
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Checkpoint actions (selection captured)');
  assert.equal(await center(),760,'Escape must not replay stale iframe position');
  await page.mouse.click(300,400);
  await page.evaluate(() => {
    const el=document.querySelector('#reader');
    el.dispatchEvent(new PointerEvent('pointerdown',{pointerType:'touch',pointerId:2,clientX:300,clientY:400,bubbles:true}));
    el.dispatchEvent(new PointerEvent('pointercancel',{pointerType:'touch',pointerId:2,bubbles:true}));
    el.dispatchEvent(new PointerEvent('pointerup',{pointerType:'touch',pointerId:2,clientX:300,clientY:480,bubbles:true}));
  });
  await page.waitForTimeout(30);
  assert.equal(await center(),760,'cancelled touch must not move control');
  await page.goto(`http://127.0.0.1:${address.port}/__trigger?html`);
  const frame = page.locator('iframe');
  await frame.waitFor();
  await page.waitForTimeout(2500);
  const height = (await frame.boundingBox()).height;
  await page.waitForTimeout(1200);
  assert.equal((await frame.boundingBox()).height,height,'bridge viewport height reports must settle');
  // Repeated viewport-inclusive reports reproduce the former +24px growth.
  await page.frameLocator('iframe').locator('#passage').evaluate(() => {
    for(let i=0;i<5;i++) window.dispatchEvent(new Event('load'));
  });
  await page.waitForTimeout(350);
  assert.equal((await frame.boundingBox()).height,height,'repeated height reports must be idempotent');
  await page.getByRole('button',{name:'Change synthetic lesson'}).click();
  await page.waitForTimeout(600);
  assert.ok((await frame.getAttribute('src')).includes('/second/content'),'HTML navigation replaces the document');
  assert.deepEqual(errors,[]);
  console.log('PASS: trigger alignment, repeated movement, scroll, iframe events, freeze, action coordinates, touch release/cancel, clamps, keyboard/Escape; real HTML bridge height stability and document navigation.');
} finally {
  await browser?.close();
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
}
