import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const baseUrl = (process.env.QA_URL ?? 'http://127.0.0.1:4300').replace(/\/$/, '');
const mainModule = await (await fetch(`${baseUrl}/src/main.tsx`)).text();
const reactUrl = mainModule.match(/["']([^"']*\/react\.js[^"']*)["']/)?.[1];
const reactDomUrl = mainModule.match(/["']([^"']*\/react-dom_client\.js[^"']*)["']/)?.[1];
const languageUrl = mainModule.match(/["']([^"']*\/src\/lib\/uiLanguage\.tsx[^"']*)["']/)?.[1];
const appUrl = mainModule.match(/["']([^"']*\/src\/App\.tsx[^"']*)["']/)?.[1];
assert.ok(reactUrl && reactDomUrl, 'Run this isolated component regression against the Vite dev server.');
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const errors = [];
const results = [];
let apiMutations = 0;
const workflow = { id: 'stability-nexus', name: 'Nexus fixture', description: '', visibility: 'private', version: 1, definition: { kind: 'agent-workflow', workflow: { schemaVersion: 1, nodes: [{ id: 'input', type: 'input', name: 'Input', position: { x: 40, y: 100 } }, { id: 'analyst', type: 'agent', name: 'Analyst', position: { x: 270, y: 100 }, agentRef: { source: 'builtin', id: 'analyst' }, objective: 'Analyze', acceptanceCriteria: [], toolNames: [] }, { id: 'output', type: 'output', name: 'Output', position: { x: 520, y: 100 } }], edges: [{ id: 'a', source: 'input', target: 'analyst', kind: 'flow' }, { id: 'b', source: 'analyst', target: 'output', kind: 'flow' }], scopedAgents: [] } } };
const historyTasks = Array.from({ length: 15 }, (_, index) => ({ id: `nexus-history-${index}`, templateId: workflow.id, sessionId: `agent-nexus-${workflow.id}`, createdAt: new Date(index * 1000).toISOString(), status: 'completed', input: `Question ${index}`, result: 'Historical response. '.repeat(50) }));
page.on('pageerror', (error) => errors.push(error.message));
await page.route('**/api/**', (route) => {
  const request = route.request();
  const { pathname } = new URL(request.url());
  if (request.method() !== 'GET') apiMutations += 1;
  const task = historyTasks.find((item) => pathname === `/api/tasks/${item.id}`);
  let body = { workflows: [], agents: [], tools: [], templates: [], plugins: [], notifications: [], unread: 0, tasks: [], sessions: [], deletedSessionIds: [] };
  if (pathname === '/api/workflows') body = { workflows: [workflow] };
  if (pathname === '/api/tasks') body = { tasks: new URL(request.url()).searchParams.get('limit') === '100' ? historyTasks : [] };
  if (task) body = { task };
  if (pathname.endsWith('/run')) body = { task: { id: 'nexus-new', status: 'completed' } };
  if (pathname === '/api/tasks/nexus-new') body = { task: { id: 'nexus-new', status: 'completed', result: 'Completed the fixture.' } };
  if (pathname === '/api/runtime/readiness') body = { state: 'ready', deployment: 'local-single-node', checkedAt: new Date().toISOString(), checks: [], blockers: [], warnings: [], tools: [] };
  if (pathname === '/api/health') body = { configured: true, model: 'Fixture' };
  if (pathname === '/api/tasks/stats') body = { byStatus: {}, total: 0, createdLast24h: 0, createdPrev24h: 0, reviewApprovalRate: null };
  if (pathname.endsWith('/events')) return route.fulfill({ contentType: 'text/event-stream', body: `event: runtime\ndata: ${JSON.stringify({ id: 'done', sequence: 1, type: 'task.completed', taskId: 'nexus-new', timestamp: new Date().toISOString(), payload: {} })}\n\n` });
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
});
const fixture = `
import React from ${JSON.stringify(reactUrl)};
import ReactDOM from ${JSON.stringify(reactDomUrl)};
import {DashboardChat} from '/src/components/dashboard/DashboardChat.tsx';
import {WorkflowStudio} from '/src/components/dashboard/WorkflowStudio.tsx';
import App from ${JSON.stringify(appUrl ?? '/src/App.tsx')};
import {UiLanguageProvider} from ${JSON.stringify(languageUrl ?? '/src/lib/uiLanguage.tsx')};
import '/src/styles.css';
import '/src/styles/dashboard.css';
const root = ReactDOM.createRoot(document.getElementById('root'));
const noop = () => {};
const graph = {revision: 1, nodes: [{id:'analysis',stepId:'analysis',role:'analyst',title:'Analysis',status:'running',dependsOn:[],skillIds:[]},{id:'build',stepId:'build',role:'builder',title:'Build',status:'queued',dependsOn:['analysis'],skillIds:[]}], edges:[{from:'analysis',to:'build',kind:'dependency'}]};
const session = {id:'stability-fixture',title:'工作总结',updatedAt:Date.now(),messages:Array.from({length:35},(_,i)=>({id:'m'+i,role:i%2?'assistant':'user',content:'Paragraph '+i+'\\n\\n'+('Readable conversation content. '.repeat(15)),createdAt:Date.now()}))};
window.qa = {sent:0,props:{sessions:[session],activeSession:session,provider:'Fixture',phase:'inference',mode:'analyze',draft:'hello',isRunning:false,canGuide:false,guidanceBusy:false,guidanceState:null,routeInsight:null,agentActivity:'Working',error:null,onDraftChange:noop,onModeChange:noop,onSend:()=>window.qa.sent++,onGuidance:noop,onStop:noop,onPause:noop,onResume:noop,onNewTask:noop,onSelectSession:noop,onDeleteSession:noop,attachments:[],onAddAttachments:noop,onRemoveAttachment:noop,agents:[],graph,events:[{id:'event',phase:'inference',message:'Working',at:Date.now()}],selectedNodeId:null,onSelectAgent:id=>window.qa.update({selectedNodeId:id}),reviewResult:null,reviewNote:'',reviewBusy:false,onReviewNoteChange:noop,onRequestApprove:noop,onRequestReject:noop}};
window.qa.update = (patch) => { window.qa.props={...window.qa.props,...patch}; root.render(React.createElement(UiLanguageProvider,null,React.createElement('div',{className:'axiom-dashboard',style:{height:'900px',padding:'20px',display:'block'}},React.createElement(DashboardChat,window.qa.props)))); };
window.qa.mountNexus = () => root.render(React.createElement(UiLanguageProvider,null,React.createElement('div',{className:'axiom-dashboard',style:{height:'900px',padding:'20px',display:'block'}},React.createElement(WorkflowStudio))));
window.qa.mountApp = () => { window.history.replaceState(null,'','?view=chat&lang=en'); root.render(React.createElement(UiLanguageProvider,null,React.createElement(App))); };
window.qa.update({});
`;
await page.route('**/__qa/frontend-stability.html*', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => (type) => type; window.__vite_plugin_react_preamble_installed__ = true; await import("/__qa/frontend-stability.js");</script></body></html>' }));
await page.route('**/__qa/frontend-stability.js', (route) => route.fulfill({ contentType: 'text/javascript', body: fixture }));
const check = async (name, run) => {
  try { await run(); results.push({ name, status: 'passed' }); }
  catch (error) { results.push({ name, status: 'failed', error: error.message }); }
};
try {
  await page.goto(`${baseUrl}/__qa/frontend-stability.html?view=chat&lang=en`);
  await page.locator('.dash-chat-composer textarea').waitFor().catch((error) => { throw new Error(`${error.message}; browser: ${errors.join(' | ')}`); });
  await check('composition Enter does not submit; normal Enter does', async () => {
    const composer = page.locator('.dash-chat-composer textarea');
    await composer.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, bubbles: true });
    assert.equal(await page.evaluate(() => window.qa.sent), 0);
    await composer.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true });
    assert.equal(await page.evaluate(() => window.qa.sent), 1);
  });
  await check('history opens at the bottom and streaming respects upward reading', async () => {
    const list = page.locator('.dash-chat-messages');
    assert.ok(await list.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop < 4));
    await list.evaluate((element) => { element.scrollTop = 150; element.dispatchEvent(new Event('scroll')); });
    await page.evaluate(() => {
      const activeSession = { ...window.qa.props.activeSession, messages: window.qa.props.activeSession.messages.map((message, index) => index === 34 ? { ...message, content: message.content + '\n\nA streamed update.' } : message) };
      window.qa.update({ activeSession });
    });
    await page.waitForTimeout(100);
    assert.ok(await list.evaluate((element) => Math.abs(element.scrollTop - 150) < 4), 'A streaming update pulled the reader to the bottom.');
    const latest = page.locator('button[data-conversation-latest]');
    assert.equal(await latest.count(), 1);
    await latest.click();
    assert.ok(await list.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop < 4));
  });
  await check('Graph telemetry preserves the event panel, rotation, and camera', async () => {
    await page.locator('[data-agent-id="analysis"]').dispatchEvent('click');
    await page.locator('.dash-agent-graph-events').click();
    const stage = page.locator('.dash-agent-graph-stage');
    const bounds = await stage.boundingBox();
    await page.mouse.move(bounds.x + bounds.width * .25, bounds.y + bounds.height * .8);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width * .45, bounds.y + bounds.height * .8, { steps: 6 });
    await page.mouse.up();
    const transform = await page.locator('.dash-agent-graph-world').evaluate((element) => element.style.transform);
    await page.evaluate(() => window.qa.update({ graph: { ...window.qa.props.graph, nodes: window.qa.props.graph.nodes.map((node) => ({ ...node, tokens: 120, status: node.id === 'analysis' ? 'completed' : 'running' })) } }));
    await page.waitForTimeout(150);
    assert.equal(await page.locator('.dash-agent-graph-panel.panel-events').count(), 1, 'Telemetry reopened the node inspector.');
    assert.equal(await page.locator('.dash-agent-graph-world').evaluate((element) => element.style.transform), transform);
    await page.locator('.dash-agent-graph-auto').click();
    await page.evaluate(() => window.qa.update({ graph: { ...window.qa.props.graph, revision: 2 } }));
    await page.waitForTimeout(100);
    assert.equal(await page.locator('.dash-agent-graph-auto').getAttribute('aria-pressed'), 'true');
  });
  await check('English UI preserves user-assigned conversation names', async () => {
    assert.equal(await page.locator('.dash-chat-session-main strong').innerText(), '工作总结');
    assert.equal(await page.locator('.dash-chat-session-delete').getAttribute('aria-label'), 'Delete conversation 工作总结');
  });
  await check('Nexus IME confirmation and history updates preserve upward reading', async () => {
    await page.evaluate(() => window.qa.mountNexus());
    const composer = page.locator('.workflow-runner textarea');
    await composer.waitFor();
    await page.locator('.workflow-runner-messages article').nth(29).waitFor();
    const list = page.locator('.workflow-runner-messages');
    assert.ok(await list.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop < 4));
    await list.evaluate((element) => { element.scrollTop = 150; element.dispatchEvent(new Event('scroll')); });
    const before = apiMutations;
    await composer.fill('Continue the fixture');
    await composer.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, bubbles: true });
    await page.waitForTimeout(80);
    assert.equal(apiMutations, before, 'IME confirmation submitted a Nexus run.');
    await composer.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true });
    await page.getByText('Completed the fixture.', { exact: true }).waitFor();
    assert.equal(apiMutations, before + 1);
    assert.ok(await list.evaluate((element) => Math.abs(element.scrollTop - 150) < 4));
    await page.locator('.workflow-runner [data-conversation-latest]').click();
    assert.ok(await list.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop < 4));
  });
  if (!process.env.QA_STABILITY_BASELINE) {
    await check('browser cache retains large images without localStorage and contains quota failures', async () => {
      const report = await page.evaluate(async () => {
        const cache = await import('/src/lib/browserSessionCache.ts');
        const snapshot = [{ id: 'large', title: 'Large image', updatedAt: Date.now(), messages: [{ id: 'image', role: 'user', content: 'Inspect', createdAt: Date.now(), attachments: [{ id: 'attachment', url: 'data:image/png;base64,' + 'A'.repeat(8 * 1024 * 1024), alt: 'large.png' }] }] }];
        await cache.writeBrowserSessions(snapshot);
        const restored = await cache.readBrowserSessions();
        const original = IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put = () => { throw new DOMException('Full cache', 'QuotaExceededError'); };
        const writer = cache.createSessionCacheWriter(cache.writeBrowserSessions, 10);
        writer.schedule(snapshot);
        const failureContained = await writer.flush() === false;
        writer.dispose();
        IDBObjectStore.prototype.put = original;
        return { length: restored[0]?.messages[0]?.attachments?.[0]?.url?.length, expected: snapshot[0].messages[0].attachments[0].url.length, failureContained, legacy: localStorage.getItem('axiom-agent-sessions-v1') };
      });
      assert.equal(report.length, report.expected);
      assert.equal(report.failureContained, true);
      assert.equal(report.legacy, null);
    });
    await check('App migrates legacy history and survives unavailable preference storage', async () => {
      await page.evaluate(async () => {
        const cache = await import('/src/lib/browserSessionCache.ts');
        await cache.writeBrowserSessions([]);
        localStorage.setItem('axiom-agent-sessions-v1', JSON.stringify([{ id: 'legacy-stability', title: 'Legacy fixture', updatedAt: Date.now(), messages: [{ id: 'legacy-message', role: 'user', content: 'Legacy cached message', createdAt: Date.now() }] }]));
        localStorage.setItem('axiom-onboarding-seen-v2', '1');
        Storage.prototype.setItem = () => { throw new DOMException('Full storage', 'QuotaExceededError'); };
        window.qa.mountApp();
      });
      await page.locator('.dash-chat-session-main strong', { hasText: 'Legacy fixture' }).waitFor();
      await page.waitForFunction(() => localStorage.getItem('axiom-agent-sessions-v1') === null);
      assert.equal(await page.evaluate(async () => (await (await import('/src/lib/browserSessionCache.ts')).readBrowserSessions()).find((session) => session.id === 'legacy-stability')?.messages[0]?.content), 'Legacy cached message');
      assert.equal(await page.locator('.dash-chat-composer textarea').isEnabled(), true);
    });
  }
  console.log(JSON.stringify({ status: results.every((result) => result.status === 'passed') ? 'passed' : 'failed', results }, null, 2));
  assert.deepEqual(errors, [], 'Unexpected browser errors');
  if (results.some((result) => result.status === 'failed')) process.exitCode = 1;
} finally {
  await browser.close();
}
