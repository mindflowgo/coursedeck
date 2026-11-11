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
const { default: tailwindcss } = await import(pathToFileURL(join(app, 'node_modules/tailwindcss/lib/index.js')).href);
const { buildLessonBridgeScript } = await import(pathToFileURL(join(app, 'src/lib/server/lessonBridge.ts')).href);
const { instrumentHtmlAnchors } = await import(pathToFileURL(join(app, 'src/lib/checkpoint/htmlSourceAnchors.ts')).href);
const { instrumentMarkdownAnchors } = await import(pathToFileURL(join(app, 'src/lib/checkpoint/sourceAnchors.ts')).href);
const paragraph = `FIRST_SELECTED_PASSAGE ${'An intervening explanation creates several independently wrapped lines. '.repeat(24)} SECOND_SELECTED_PASSAGE`;
let htmlSource = `<html><head><style>body{font:16px/24px sans-serif;margin:16px}p{margin:24px 0}</style></head><body><section id="large-section"><div style="height:160px">Synthetic section introduction</div><p id="passage">${paragraph}</p><div style="height:500px">Synthetic section end</div></section></body></html>`;
let markdownSource = `# Synthetic companion\n\n${paragraph}\n\n${'Extra document content. '.repeat(70)}\n`;
const annotationCheckpoints = [];
const playwrightModule = process.env.PLAYWRIGHT_MODULE || 'playwright';
const { chromium } = await import(isAbsolute(playwrightModule) ? pathToFileURL(playwrightModule).href : playwrightModule);
const cacheDir = await mkdtemp(join(tmpdir(), 'coursedeck-trigger-'));
const fixtureHandler = (_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end(`<html><head><style>
    body { margin:0; } .absolute {position:absolute} .inset-0 {inset:0}
    .pointer-events-none {pointer-events:none} .pointer-events-auto {pointer-events:auto}
    .right-2 {right:8px} .flex {display:flex} #fixture button {height:36px;min-width:48px}
    [role=toolbar] {z-index:30}
  </style></head><body><script type="module" src="/__trigger-entry.js"></script></body></html>`);
};
const server = await createServer({
  root: app, configFile: false,
  plugins: [{
    name: 'trigger-fixture',
    configureServer(server) {
      server.middlewares.use('/__trigger', fixtureHandler);
      server.middlewares.use('/__annotation-state', (_req,res) => {
        res.setHeader('Content-Type','application/json');
        res.end(JSON.stringify({markdown:markdownSource,checkpoints:annotationCheckpoints}));
      });
      server.middlewares.use('/api/courses/fixture', async (req, res) => {
        if(req.method==='POST') {
          let body='';for await(const chunk of req)body+=chunk;
          const data=JSON.parse(body);
          res.setHeader('Content-Type','application/json');
          if(req.url?.includes('annotation-anchors')) {
            if(data.renderer==='html') htmlSource=instrumentHtmlAnchors(htmlSource);
            else markdownSource=instrumentMarkdownAnchors(markdownSource);
            res.end(JSON.stringify({sourceFile:data.renderer==='html'?'first.lesson.html':'first.lesson.companion.md',renderer:data.renderer,content:data.renderer==='html'?htmlSource:markdownSource}));
          } else {
            const checkpoint={...data,id:`fixture-${annotationCheckpoints.length+1}`,date:new Date().toISOString()};
            annotationCheckpoints.push(checkpoint);res.end(JSON.stringify({checkpoint}));
          }
          return;
        }
        res.setHeader('Content-Type', 'text/html');
        res.end(instrumentHtmlAnchors(htmlSource).replace('<head>',`<head>${buildLessonBridgeScript('fixture')}`));
      });
    },
    resolveId(id) {
      if (id === '/__trigger-entry.js') return '\0trigger-entry';
      if (id === '$lib/api') return '\0trigger-api';
      if (id === '$app/environment') return '\0trigger-environment';
    },
    load(id) {
      if (id === '\0trigger-environment') return 'export const browser = true; export const dev = true;';
      if (id === '\0trigger-api') return 'export const getApiBaseUrl = () => ""; export const courseAssetBase = () => "/api/courses/fixture"; export const apiFetch = (...args) => fetch(...args);';
      if (id === '\0trigger-entry') return `import {mount} from 'svelte'; import Fixture from ${JSON.stringify('/@fs/' + fixture)}; mount(Fixture, {target: document.body});`;
    }
  }, svelte({ configFile: false })],
  cacheDir,
  css: { postcss: { plugins: [tailwindcss({content:[join(app,'src/**/*.{svelte,ts}'),join(project,'scripts/fixtures/**/*.svelte')]})] } },
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
  // The complete note flow uses real viewer, trigger, modal, and marker
  // components. Only source/checkpoint persistence is a synthetic HTTP store.
  const selectPassage = async (renderer,quote,select=true) => {
    const root = renderer==='html' ? page.frameLocator('iframe').locator('body') : page.locator('.markdown-body');
    return root.evaluate((body,{quote,select})=>{
      const walker=document.createTreeWalker(body,NodeFilter.SHOW_TEXT);let node;
      while((node=walker.nextNode())) {
        const at=node.data.indexOf(quote);if(at<0)continue;
        const range=document.createRange();range.setStart(node,at);range.setEnd(node,at+quote.length);
        if(select) {
          const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);
          body.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,clientX:100,clientY:range.getBoundingClientRect().top}));
        }
        const rect=range.getBoundingClientRect();return {top:rect.top,height:rect.height};
      }
      throw new Error('Synthetic quote not found');
    },{quote,select});
  };
  const markerCenter = async id => {
    const box=await page.locator(`[data-checkpoint-id="${id}"] button`).first().boundingBox();
    return box.y+box.height/2;
  };
  const expectedTop = async (renderer,quote) => {
    const rect=await selectPassage(renderer,quote,false);
    if(renderer==='html')return (await page.locator('iframe').boundingBox()).y+rect.top;
    return rect.top;
  };
  for(const renderer of ['html','markdown']) {
    await page.goto(`http://127.0.0.1:${address.port}/__trigger?annotations=${renderer}`);
    await page.locator(renderer==='html'?'iframe':'.markdown-body').waitFor();
    await page.waitForTimeout(600);
    const toolbar=page.getByRole('toolbar');
    assert.equal(await toolbar.locator('svg').count(),1,'compact trigger has one pen icon');
    for(const quote of ['FIRST_SELECTED_PASSAGE','SECOND_SELECTED_PASSAGE']) {
      await selectPassage(renderer,quote);
      await page.waitForTimeout(400);
      await toolbar.getByRole('button').click();
      await page.getByRole('button',{name:'Note',exact:true}).click();
      await page.locator('#checkpoint-note-textarea').fill(`${renderer}: ${quote}`);
      await page.getByRole('button',{name:'Add Note',exact:true}).click();
      await page.locator('#checkpoint-note-textarea').waitFor({state:'detached'});
      const checkpoint=annotationCheckpoints.at(-1);
      await page.waitForTimeout(350);
      assert.ok(checkpoint.selection?.text.includes(quote),'selected quote survives control/composer focus');
      assert.ok(Math.abs(await markerCenter(checkpoint.id)-await expectedTop(renderer,quote))<3,`${renderer}: marker resolves selected passage, not ancestor section top`);
    }
    assert.ok(renderer==='html'?htmlSource.includes('data-anchor-id='):markdownSource.includes('<!--coursedeck-anchor:'),'source anchors persisted');
    const own=annotationCheckpoints.filter(cp=>cp.anchor.renderer===renderer);
    assert.equal(await page.locator('[data-checkpoint-id]').count(),2,'annotations are file-local');
    const pageBox=await page.locator('[data-test-page]').boundingBox();
    const dot=await page.locator(`[data-checkpoint-id="${own[0].id}"] button`).first().boundingBox();
    assert.ok(dot.x>=pageBox.x+pageBox.width,'marker lies outside page surface in gutter');
    assert.ok(dot.x+dot.width<=1000,'marker remains inside viewport');
    await page.reload();await page.waitForTimeout(900);
    for(const cp of own)assert.ok(Math.abs(await markerCenter(cp.id)-await expectedTop(renderer,cp.selection.text))<3,'saved note restored at passage after reload');
    await page.locator('[data-test-reader]').evaluate(el=>{el.scrollTop=180;});
    await page.waitForTimeout(100);
    for(const cp of own)assert.ok(Math.abs(await markerCenter(cp.id)-await expectedTop(renderer,cp.selection.text))<3,'parent scrolling preserves note alignment');
    await page.setViewportSize({width:700,height:900});await page.waitForTimeout(700);
    for(const cp of own)assert.ok(Math.abs(await markerCenter(cp.id)-await expectedTop(renderer,cp.selection.text))<3,'resize re-resolves saved passage');
    // Position-only notes use the last reading point, not a stale selection.
    const contentRoot=renderer==='html'?page.frameLocator('iframe').locator('#passage'):page.locator('.markdown-body p').first();
    await contentRoot.click({position:{x:40,y:80}});
    await page.waitForTimeout(400);
    await toolbar.getByRole('button').click();
    await page.getByRole('button',{name:'Note',exact:true}).click();
    await page.locator('#checkpoint-note-textarea').fill(`${renderer}: point note`);
    await page.getByRole('button',{name:'Add Note',exact:true}).click();
    await page.locator('#checkpoint-note-textarea').waitFor({state:'detached'});
    const pointNote=annotationCheckpoints.at(-1);
    await page.waitForTimeout(350);
    assert.equal(pointNote.selection,undefined,'position-only note does not reuse old quotation');
    assert.ok(pointNote.anchor.blockId,'position-only note retains source block ID');
    const readerBox=await page.locator('[data-test-reader]').boundingBox();
    const scrollTop=await page.locator('[data-test-reader]').evaluate(el=>el.scrollTop);
    assert.ok(Math.abs(await markerCenter(pointNote.id)-(readerBox.y+pointNote.verticalPosition-scrollTop))<26,'position-only note stays on captured text line');
    await page.setViewportSize({width:390,height:844});await page.waitForTimeout(700);
    const mobilePage=await page.locator('[data-test-page]').boundingBox();
    const mobileDot=await page.locator(`[data-checkpoint-id="${pointNote.id}"] button`).first().boundingBox();
    assert.ok(mobileDot.x>=mobilePage.x+mobilePage.width,'mobile marker remains outside page');
    assert.ok(mobileDot.x+mobileDot.width<=390,'mobile marker remains within viewport');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true,'gutter does not create horizontal scrolling');
    await page.setViewportSize({width:1000,height:900});
    await page.locator('[data-test-reader]').evaluate(el=>{el.scrollTop=0;});
    await page.waitForTimeout(450);
    // Existing dots must remain clickable when the compact trigger occupies
    // precisely the same gutter position. This exercises browser hit testing,
    // not a forced/programmatic marker click.
    const overlapY=await markerCenter(own[0].id);
    await page.locator('[data-test-reader]').evaluate((el,y)=>{
      el.dispatchEvent(new PointerEvent('pointermove',{pointerType:'mouse',bubbles:true,clientX:100,clientY:y}));
    },overlapY);
    await page.waitForTimeout(100);
    const compactBox=await toolbar.boundingBox();
    assert.ok(Math.abs(compactBox.y+compactBox.height/2-overlapY)<1,'compact trigger is directly over existing marker Y');
    const existingDot=page.locator(`[data-checkpoint-id="${own[0].id}"] button`).first();
    await existingDot.click();
    assert.equal(await existingDot.getAttribute('aria-label'),'Close checkpoint note','overlap click opens existing note');
    await page.locator(`[data-checkpoint-id="${own[0].id}"]`).getByText(`${renderer}: FIRST_SELECTED_PASSAGE`,{exact:true}).waitFor();
    assert.equal(await toolbar.getByRole('button').count(),1,'overlap click does not expand new-note toolbar');
    assert.equal(await page.locator('#checkpoint-note-textarea').count(),0,'overlap click does not create a note');
  }
  assert.deepEqual(errors,[]);
  console.log('PASS: trigger alignment, input/focus, HTML height/navigation; HTML and Markdown note save/reload/scroll/reflow, exact same-block passage and point positions, source persistence, file isolation, single icon, desktop/mobile gutter, and overlapping-marker accessibility.');
} finally {
  await browser?.close();
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
}
