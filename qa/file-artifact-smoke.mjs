import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { createServer } from 'vite';

// Mount the real chat renderer against isolated fixture downloads. No model
// requests or writes to the user's conversation/task history are made.
const scratch = await mkdtemp(join(tmpdir(), 'axiom-artifact-browser-'));
const server = await createServer({ envFile: false, cacheDir: join(scratch, '.vite'), server: { host: '127.0.0.1', port: 0, strictPort: true, open: false, proxy: {} } });
let browser;
try {
  const listening = once(server.httpServer, 'listening'); server.httpServer.listen(0, '127.0.0.1'); await listening;
  const address = server.httpServer.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const mainModule = await (await fetch(`${base}/src/main.tsx`)).text();
  const reactUrl = mainModule.match(/["']([^"']*\/react\.js[^"']*)["']/)?.[1];
  const reactDomUrl = mainModule.match(/["']([^"']*\/react-dom_client\.js[^"']*)["']/)?.[1];
  assert.ok(reactUrl && reactDomUrl);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = []; const unexpectedRequests = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const path = '/api/tasks/fixture-task/artifacts/files/tool%3Afixture-task%3Abuilder%3Acall%3Aartifact';
  const html = '<!doctype html><html><head><style>body{background:#172b28;color:white}svg{width:300px;height:160px}</style></head><body><svg viewBox="0 0 300 160"><circle id="wheel" cx="80" cy="80" r="40" fill="#91e8bd" /></svg><button id="animate">Animate</button><script>document.getElementById("animate").onclick=()=>document.getElementById("wheel").setAttribute("cx","160");try{parent.document.body.dataset.escaped="yes"}catch{document.body.dataset.isolated="yes"}</script></body></html>';
  let fail = false; let reads = 0;
  await page.route('**/api/**', async (route) => {
    if (new URL(route.request().url()).pathname !== path) { unexpectedRequests.push(route.request().url()); return route.abort(); }
    reads += 1;
    if (fail) return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"unavailable"}' });
    return route.fulfill({ status: 200, headers: { 'content-type': 'application/octet-stream', 'content-disposition': "attachment; filename*=UTF-8''animation.html", 'x-axiom-artifact-mime-type': 'text/html' }, body: html });
  });
  const fixture = `import React from ${JSON.stringify(reactUrl)}; import ReactDOM from ${JSON.stringify(reactDomUrl)};
import {ChatMessageMarkdown} from '/src/components/dashboard/ChatArtifact.tsx';
import {UiLanguageProvider} from '/src/lib/uiLanguage.tsx';
import '/src/styles.css'; import '/src/styles/dashboard.css';
const root=ReactDOM.createRoot(document.getElementById('root'));
window.qa={copied:''}; Object.defineProperty(navigator,'clipboard',{value:{writeText:async(value)=>{window.qa.copied=value}},configurable:true});
window.qa.mount=(content,key='first')=>root.render(React.createElement(UiLanguageProvider,null,React.createElement('main',{className:'axiom-dashboard',style:{display:'block',padding:24,minHeight:'100vh'}},React.createElement(ChatMessageMarkdown,{key,content}))));
window.qa.mount(${JSON.stringify(`完成。\n\n[animation.html](${path})`)});`;
  await page.route('**/__qa/file-artifact.html', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>(type)=>type;window.__vite_plugin_react_preamble_installed__=true;await import("/__qa/file-artifact.js");</script></body></html>' }));
  await page.route('**/__qa/file-artifact.js', (route) => route.fulfill({ contentType: 'text/javascript', body: fixture }));
  await page.goto(`${base}/__qa/file-artifact.html`);
  const iframe = page.locator('.dash-chat-artifact iframe');
  await expect(iframe).toBeVisible();
  assert.equal(await iframe.getAttribute('sandbox'), 'allow-scripts');
  const frame = page.frameLocator('.dash-chat-artifact iframe');
  await expect(frame.locator('body')).toHaveAttribute('data-isolated', 'yes');
  await frame.getByRole('button', { name: 'Animate' }).click();
  await expect(frame.locator('#wheel')).toHaveAttribute('cx', '160');
  assert.equal(await page.locator('body').getAttribute('data-escaped'), null);
  assert.match(await iframe.getAttribute('srcdoc'), /connect-src 'none'/);
  await page.getByRole('button', { name: /复制 HTML 源码|Copy HTML source/i }).click();
  assert.equal(await page.evaluate(() => window.qa.copied), html);
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: /下载 HTML|Download HTML/i }).click();
  assert.equal((await downloadEvent).suggestedFilename(), 'animation.html');
  fail = true;
  await page.evaluate((href) => window.qa.mount(`[animation.html](${href})`, 'retry'), path);
  await expect(page.getByTestId('task-file-artifact-status')).toContainText(/File unavailable|文件暂不可用/);
  fail = false;
  await page.getByRole('button', { name: /Retry|重试/ }).click();
  await expect(iframe).toBeVisible();
  assert.equal(reads, 3);
  await page.evaluate((href) => window.qa.mount(`[external](https://external.invalid${href})`, 'external'), path);
  await expect(page.getByRole('link', { name: 'external' })).toBeVisible();
  assert.equal(reads, 3);
  assert.deepEqual(unexpectedRequests, []); assert.deepEqual(errors, []);
  process.stdout.write('PASS: real ChatMessageMarkdown renders downloaded HTML in an opaque sandbox; animation, copy, download, retry and same-origin restrictions verified.\n');
} finally { await browser?.close(); await server.close(); await rm(scratch, { recursive: true, force: true }); }
