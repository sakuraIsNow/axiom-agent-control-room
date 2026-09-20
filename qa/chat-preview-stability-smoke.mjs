import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { createServer } from 'vite';

const scratch = await mkdtemp(join(tmpdir(), 'axiom-chat-preview-'));
const server = await createServer({ envFile: false, cacheDir: join(scratch, '.vite'), server: { host: '127.0.0.1', port: 0, strictPort: true, open: false, proxy: {} } });
let browser;
const results = [];
try {
  const listening = once(server.httpServer, 'listening'); server.httpServer.listen(0, '127.0.0.1'); await listening;
  const address = server.httpServer.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const mainModule = await (await fetch(`${base}/src/main.tsx`)).text();
  const reactUrl = mainModule.match(/["']([^"']*\/react\.js[^"']*)["']/)?.[1];
  const reactDomUrl = mainModule.match(/["']([^"']*\/react-dom_client\.js[^"']*)["']/)?.[1];
  assert.ok(reactUrl && reactDomUrl);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = []; const unexpected = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const filePath = '/api/tasks/fixture-task/artifacts/files/tool%3Afixture-task%3Abuild%3Afile%3Aartifact';
  const imagePath = '/api/tasks/fixture-task/artifacts/media/image';
  const videoPath = '/api/tasks/fixture-task/artifacts/media/video';
  const markdownImagePath = '/api/tasks/fixture-task/artifacts/media/markdown-image';
  const markdownVideoPath = '/api/tasks/fixture-task/artifacts/media/markdown-video';
  const reads = { file: 0, image: 0, video: 0, markdownImage: 0, markdownVideo: 0 };
  const videoBytes = Buffer.from(await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 32;
    const context = canvas.getContext('2d'); const stream = canvas.captureStream(10); const chunks = [];
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
    recorder.ondataavailable = (event) => chunks.push(event.data);
    const stopped = new Promise((resolve) => { recorder.onstop = resolve; }); recorder.start();
    for (let index = 0; index < 10; index += 1) { context.fillStyle = index % 2 ? '#82b7a3' : '#142720'; context.fillRect(0, 0, 32, 32); await new Promise((resolve) => setTimeout(resolve, 100)); }
    recorder.stop(); await stopped; stream.getTracks().forEach((track) => track.stop());
    return Array.from(new Uint8Array(await new Blob(chunks, { type: 'video/webm' }).arrayBuffer()));
  }));
  const html = (id, version = 'first') => `<!doctype html><html><head><style>body{background:#182d29;color:white}button{font:22px sans-serif;padding:12px}</style></head><body data-version="${version}"><button id="counter">0</button><script>parent.postMessage({qaPreviewInit:${JSON.stringify(id)}},'*');let n=0;document.getElementById('counter').onclick=(event)=>event.target.textContent=String(++n)</script></body></html>`;
  const fence = (language, source) => `\`\`\`${language}\n${source}\n\`\`\``;
  const htmlSource = html('inline');
  const htmlMessage = `INLINE HTML\n\n${fence('html', htmlSource)}`;
  const svgMessage = `SVG PREVIEW\n\n${fence('svg', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><circle cx="50" cy="50" r="35" fill="#8bd3b1"/></svg>')}`;
  const fileMessage = `FILE PREVIEW\n\n[animation.html](${filePath})`;
  const mediaMessage = `MEDIA PREVIEW\n\n![Fixture image](${imagePath})\n\n[Fixture video](${videoPath})`;
  const markdownMessage = `MARKDOWN PREVIEW\n\n${fence('markdown', `# Embedded media\n\n![Markdown image](${markdownImagePath})\n\n[Markdown video](${markdownVideoPath})`)}`;
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === filePath) { reads.file += 1; return route.fulfill({ status: 200, headers: { 'content-type': 'application/octet-stream', 'content-disposition': "attachment; filename*=UTF-8''animation.html", 'x-axiom-artifact-mime-type': 'text/html' }, body: html('file') }); }
    if ([imagePath, markdownImagePath].includes(path)) { reads[path === imagePath ? 'image' : 'markdownImage'] += 1; return route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64') }); }
    if ([videoPath, markdownVideoPath].includes(path)) { reads[path === videoPath ? 'video' : 'markdownVideo'] += 1; return route.fulfill({ status: 200, contentType: 'video/webm', body: videoBytes }); }
    unexpected.push(route.request().url()); return route.abort();
  });
  const fixture = `import React from ${JSON.stringify(reactUrl)};import ReactDOM from ${JSON.stringify(reactDomUrl)};
import {DashboardChat} from '/src/components/dashboard/DashboardChat.tsx';
import {UiLanguageProvider,useUiLanguage} from '/src/lib/uiLanguage.tsx';
import '/src/styles.css';import '/src/styles/dashboard.css';
window.qa={initializations:{}};window.addEventListener('message',(event)=>{const id=event.data?.qaPreviewInit;if(id)window.qa.initializations[id]=(window.qa.initializations[id]||0)+1});
const sources=${JSON.stringify([htmlMessage, svgMessage, fileMessage, mediaMessage, markdownMessage, 'TAIL\n\n' + 'Tail paragraph for scrolling.\n\n'.repeat(12)])};
const initialMessages=()=>sources.map((content,index)=>({id:'message-'+index,role:'assistant',content,createdAt:Date.now(),pending:false}));
const noop=()=>{};
function Fixture(){
 const [messages,setMessages]=React.useState(initialMessages),[sessionId,setSessionId]=React.useState('preview-session'),[draft,setDraft]=React.useState(''),[theme,setTheme]=React.useState('obsidian');
 const {setLanguage}=useUiLanguage();
 window.qa.update=(index,content,pending=false)=>setMessages((value)=>value.map((message,i)=>i===index?{...message,content,pending}:message));
 window.qa.append=()=>setMessages((value)=>[...value,{id:'appended-'+value.length,role:'assistant',content:'New sibling message',createdAt:Date.now()}]);
 window.qa.appendStream=(content)=>setMessages((value)=>[...value,{id:'streamed-'+value.length,role:'assistant',content,createdAt:Date.now(),pending:true}]);
 window.qa.theme=setTheme;window.qa.language=setLanguage;
 window.qa.switchSession=()=>{setSessionId('another-session');setMessages(initialMessages())};
 window.qa.replaceMessage=(index)=>setMessages((value)=>value.map((message,i)=>i===index?{...message,id:'replacement-'+message.id}:message));
 const activeSession={id:sessionId,title:'Preview stability',messages,updatedAt:Date.now()};
 return React.createElement('main',{className:'axiom-dashboard','data-theme':theme,style:{display:'block',height:'100vh',padding:16}},React.createElement(DashboardChat,{sessions:[activeSession],activeSession,provider:'Fixture model',phase:'idle',mode:'build',draft,isRunning:false,canGuide:false,guidanceBusy:false,guidanceState:null,onGuidance:noop,routeInsight:null,agentActivity:'',error:null,onDraftChange:setDraft,onModeChange:noop,onSend:noop,onStop:noop,onPause:noop,onResume:noop,onNewTask:noop,onSelectSession:noop,onDeleteSession:noop,attachments:[],onAddAttachments:noop,onRemoveAttachment:noop,agents:[],graph:null,events:[],selectedNodeId:null,onSelectAgent:noop,reviewResult:null,reviewNote:'',reviewBusy:false,onReviewNoteChange:noop,onRequestApprove:noop,onRequestReject:noop,onTaskActionChanged:async()=>{}}));
}
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(UiLanguageProvider,null,React.createElement(Fixture)));`;
  await page.route('**/__qa/chat-preview.html*', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>.dash-chat-workspace{height:100%!important}.dash-chat-messages{min-height:0!important}</style></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>(type)=>type;window.__vite_plugin_react_preamble_installed__=true;await import("/__qa/chat-preview.js");</script></body></html>' }));
  await page.route('**/__qa/chat-preview.js', (route) => route.fulfill({ contentType: 'text/javascript', body: fixture }));
  await page.goto(`${base}/__qa/chat-preview.html`, { waitUntil: 'networkidle' });
  const chat = page.locator('.dash-chat-messages');
  const inline = page.locator('.dash-chat-message').nth(0).locator('iframe');
  const svg = page.locator('.dash-chat-message').nth(1).locator('iframe');
  const file = page.locator('.dash-chat-message').nth(2).locator('iframe');
  await expect(inline).toHaveCount(1); await expect(svg).toHaveCount(1); await expect(file).toHaveCount(1);
  await expect(page.locator('.task-media img')).toHaveCount(2); await expect(page.locator('.task-media video')).toHaveCount(2);
  await page.waitForFunction(() => window.qa.initializations.inline > 0 && window.qa.initializations.file > 0);
  const selectors = ['.dash-chat-message:nth-of-type(1) iframe', '.dash-chat-message:nth-of-type(2) iframe', '.dash-chat-message:nth-of-type(3) iframe', '.dash-chat-message:nth-of-type(4) .task-media img', '.dash-chat-message:nth-of-type(4) .task-media video', '.dash-chat-message:nth-of-type(5) .task-media img', '.dash-chat-message:nth-of-type(5) .task-media video'];
  const inlineFrame = page.frameLocator(selectors[0]); const fileFrame = page.frameLocator(selectors[2]); const svgFrame = page.frameLocator(selectors[1]);
  await inlineFrame.locator('#counter').evaluate((button) => button.click());
  await fileFrame.locator('#counter').evaluate((button) => button.click());
  await svgFrame.locator('body').evaluate((body) => { body.dataset.qaDocumentIdentity = 'retained'; });
  await page.evaluate(async (items) => {
    window.qa.nodes = items.map((selector) => document.querySelector(selector)); window.qa.initial = { ...window.qa.initializations }; window.qa.blobs = items.slice(3).map((selector) => document.querySelector(selector).src);
    for (const video of document.querySelectorAll('.task-media video')) { video.volume = .37; video.loop = true; video.muted = true; video.playbackRate = .75; await video.play(); }
  }, selectors);
  const initialReads = { ...reads };
  const wheel = async (delta) => {
    const box = await chat.boundingBox(); assert.ok(box);
    await page.mouse.move(box.x + box.width - 12, box.y + box.height * .55);
    await page.mouse.wheel(0, delta);
  };
  const measure = async () => ({ ...await page.evaluate((items) => ({ stableNodes: items.map((selector, i) => window.qa.nodes[i] === document.querySelector(selector)), initializations: window.qa.initializations, initial: window.qa.initial, blobSourcesStable: items.slice(3).every((selector,i)=>document.querySelector(selector)?.src===window.qa.blobs[i]), videos: Array.from(document.querySelectorAll('.task-media video'), (video) => ({ volume: video.volume, playing: !video.paused, playbackRate: video.playbackRate, error: video.error?.message ?? null })) }), selectors), reads: { ...reads }, initialReads });
  const preserved = async (label) => {
    await page.waitForTimeout(80);
    const snapshot = await measure();
    assert.ok(snapshot.stableNodes.every(Boolean), `${label}: DOM node identities changed`);
    assert.deepEqual(snapshot.initializations, snapshot.initial, `${label}: document reinitialized`);
    assert.deepEqual(reads, initialReads, `${label}: repeated artifact/media request`);
    assert.ok(snapshot.blobSourcesStable, `${label}: Blob URLs changed`);
    assert.ok(snapshot.videos.every((video) => video.volume === .37 && video.playbackRate === .75 && video.playing && !video.error), `${label}: video playback/state reset`);
    await expect(inlineFrame.locator('#counter')).toHaveText('1'); await expect(fileFrame.locator('#counter')).toHaveText('1');
    await expect(svgFrame.locator('body')).toHaveAttribute('data-qa-document-identity', 'retained');
    results.push(label);
  };
  await wheel(-650);
  await expect(page.locator('[data-conversation-latest]')).toBeVisible();
  await page.waitForTimeout(150);
  const afterWheel = await measure();
  process.stdout.write(`Wheel/showLatest measurement: ${JSON.stringify(afterWheel)}\n`);
  assert.ok(afterWheel.stableNodes.every(Boolean), 'Wheel/showLatest rerender must retain HTML/SVG/file/media DOM nodes.');
  assert.deepEqual(afterWheel.initializations, afterWheel.initial, 'Wheel must not initialize documents again.');
  assert.deepEqual(reads, initialReads, 'Wheel must not fetch generated files again.');
  await preserved('real DashboardChat wheel/showLatest preserves DOM, documents, interaction and media playback');
  await wheel(10_000);
  await expect(page.locator('[data-conversation-latest]')).toHaveCount(0);
  await preserved('wheel back to bottom preserves previews');
  await wheel(-650); await expect(page.locator('[data-conversation-latest]')).toBeVisible();
  await page.locator('[data-conversation-latest]').click(); await expect(page.locator('[data-conversation-latest]')).toHaveCount(0);
  await preserved('return-to-latest action preserves previews');
  await page.getByRole('textbox').fill('Composer input must not restart previews');
  await preserved('composer typing preserves previews and media Blob URLs');
  for (const [index, source] of [[0, htmlMessage], [1, svgMessage], [2, fileMessage], [3, mediaMessage], [4, markdownMessage]]) {
    for (let chunk = 1; chunk <= 3; chunk += 1) {
      await page.evaluate(({ index, content }) => window.qa.update(index, content, true), { index, content: `${source}\n\n${'Streaming explanation. '.repeat(chunk)}` });
      await preserved(`completed artifact ${index + 1}, trailing stream chunk ${chunk}`);
    }
    await page.evaluate(({ index, content }) => window.qa.update(index, content, false), { index, content: `${source}\n\nStreaming explanation complete.` });
    await preserved(`completed artifact ${index + 1}, stream completion`);
  }
  await page.evaluate(() => window.qa.append()); await preserved('sibling message append preserves existing previews');
  await page.evaluate(() => window.qa.theme('ivory')); await preserved('theme update preserves existing previews');
  await page.evaluate(() => window.qa.language('zh-CN')); await preserved('language update preserves existing previews');
  const revisedHtml = html('inline', 'revised');
  await page.evaluate((content) => window.qa.update(0, content), `INLINE HTML\n\n${fence('html', revisedHtml)}`);
  await expect(inlineFrame.locator('body')).toHaveAttribute('data-version', 'revised');
  await expect(inlineFrame.locator('#counter')).toHaveText('0');
  assert.equal(await page.evaluate(() => window.qa.initializations.inline), afterWheel.initial.inline + 1);
  assert.equal(await page.evaluate(() => window.qa.nodes[0] === document.querySelector('.dash-chat-message:nth-of-type(1) iframe')), true);
  results.push('a real source edit updates srcDoc once and resets only that document');
  await page.evaluate(() => window.qa.switchSession());
  await expect(inlineFrame.locator('body')).toHaveAttribute('data-version', 'first');
  await expect(inlineFrame.locator('#counter')).toHaveText('0');
  await expect(fileFrame.locator('#counter')).toHaveText('0');
  assert.equal(await page.evaluate(() => window.qa.nodes[0] === document.querySelector('.dash-chat-message:nth-of-type(1) iframe')), false);
  results.push('another conversation with identical message IDs receives fresh preview state');
  await inlineFrame.locator('#counter').evaluate((button) => button.click());
  await page.evaluate(() => window.qa.replaceMessage(0));
  await expect(inlineFrame.locator('#counter')).toHaveText('0');
  results.push('another message with identical source receives fresh preview state');
  const streamIndex = 6;
  await page.evaluate(() => window.qa.appendStream('STREAMED HTML\n\n```html\n<!doctype html><html><body>'));
  const streamed = page.locator('.dash-chat-message').nth(streamIndex);
  await expect(streamed.getByTestId('chat-artifact-generating')).toBeVisible(); await expect(streamed.locator('iframe')).toHaveCount(0);
  for (const source of ['<html><body><button', html('streamed')]) {
    await page.evaluate(({ index, source }) => window.qa.update(index, `STREAMED HTML\n\n\`\`\`html\n${source}`, true), { index: streamIndex, source });
    await expect(streamed.locator('iframe')).toHaveCount(0);
    assert.equal(await page.evaluate(() => window.qa.initializations.streamed ?? 0), 0);
  }
  await page.evaluate(({ index, content }) => window.qa.update(index, content, true), { index: streamIndex, content: `STREAMED HTML\n\n${fence('html', html('streamed'))}` });
  await expect(streamed.locator('iframe')).toHaveCount(1);
  await page.waitForFunction(() => window.qa.initializations.streamed === 1);
  await page.evaluate(({ index, content }) => window.qa.update(index, content, true), { index: streamIndex, content: `STREAMED HTML\n\n${fence('html', html('streamed'))}\n\nLater streamed explanation` });
  await expect(streamed.locator('iframe')).toHaveCount(1);
  assert.equal(await page.evaluate(() => window.qa.initializations.streamed), 1);
  results.push('incomplete streamed HTML is inert and initializes exactly once after its fence closes');
  await page.evaluate(({ index, content }) => window.qa.update(index, content, true), { index: streamIndex, content: '```svg\n<svg xmlns="http://www.w3.org/2000/svg">' });
  await expect(streamed.getByTestId('chat-artifact-generating')).toBeVisible(); await expect(streamed.locator('iframe')).toHaveCount(0);
  await page.evaluate(({ index, content }) => window.qa.update(index, content, true), { index: streamIndex, content: '```svg\n<svg xmlns="http://www.w3.org/2000/svg"><circle r="10"/></svg>\n```' });
  await expect(streamed.locator('iframe')).toHaveCount(1);
  results.push('incomplete streamed SVG remains inert until the fence closes');
  await page.evaluate(({ index, content }) => window.qa.update(index, content, true), { index: streamIndex, content: html('raw-streamed') });
  await expect(streamed.getByTestId('chat-artifact-generating')).toBeVisible(); await expect(streamed.locator('iframe')).toHaveCount(0);
  await page.evaluate(({ index, content }) => window.qa.update(index, content, false), { index: streamIndex, content: html('raw-streamed') });
  await expect(streamed.locator('iframe')).toHaveCount(1);
  await page.waitForFunction(() => window.qa.initializations['raw-streamed'] === 1);
  results.push('raw streamed HTML waits for message completion before executing');
  const nestedHtml = html('nested-fence');
  const quoteHtml = html('quoted-fence');
  const tildeHtml = html('tilde-fence');
  const fenceCases = [
    { label: 'nested list closing fence renders before stream completion', content: `- outer\n  - inner\n\n    \`\`\`html\n    ${nestedHtml}\n    \`\`\``, ready: true, init: 'nested-fence' },
    { label: 'CRLF blockquote closing fence renders before stream completion', content: `> \`\`\`html\r\n> ${quoteHtml}\r\n> \`\`\``, ready: true, init: 'quoted-fence' },
    { label: 'longer matching tilde closing fence renders before stream completion', content: `~~~~html\r\n${tildeHtml}\r\n~~~~~  `, ready: true, init: 'tilde-fence' },
    { label: 'over-indented fake closing fence remains inert while streaming', content: `\`\`\`html\n${html('fake-close')}\n    \`\`\``, ready: false, init: 'fake-close' },
    { label: 'wrong closing fence marker remains inert while streaming', content: `\`\`\`html\n${html('wrong-close')}\n~~~`, ready: false, init: 'wrong-close' },
  ];
  for (const sample of fenceCases) {
    await page.evaluate(({ index, content }) => window.qa.update(index, content, true), { index: streamIndex, content: sample.content });
    if (sample.ready) {
      await expect(streamed.locator('iframe')).toHaveCount(1);
      await expect(streamed.getByTestId('chat-artifact-generating')).toHaveCount(0);
      await page.waitForFunction((id) => window.qa.initializations[id] === 1, sample.init);
    } else {
      await expect(streamed.getByTestId('chat-artifact-generating')).toBeVisible();
      await expect(streamed.locator('iframe')).toHaveCount(0);
      assert.equal(await page.evaluate((id) => window.qa.initializations[id] ?? 0, sample.init), 0);
    }
    results.push(sample.label);
  }
  assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
  process.stdout.write(`${JSON.stringify({ results, status: 'passed', reads }, null, 2)}\n`);
} finally { await browser?.close(); await server.close(); await rm(scratch, { recursive: true, force: true }); }
