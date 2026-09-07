import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { createServer } from 'vite';

const server = process.env.QA_URL ? null : await createServer({ server: { host: '127.0.0.1', strictPort: true, open: false } });
let browser;
const errors = [];
const results = [];
try {
  if (server) await new Promise((resolve, reject) => { server.httpServer.once('error', reject); server.httpServer.listen(0, '127.0.0.1', resolve); });
  const address = server?.httpServer.address();
  const baseUrl = process.env.QA_URL?.replace(/\/$/, '') ?? `http://127.0.0.1:${address.port}`;
  const mainModule = await (await fetch(`${baseUrl}/src/main.tsx`)).text();
  const reactUrl = mainModule.match(/["']([^"']*\/react\.js[^"']*)["']/)?.[1];
  const reactDomUrl = mainModule.match(/["']([^"']*\/react-dom_client\.js[^"']*)["']/)?.[1];
  assert.ok(reactUrl && reactDomUrl);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('response', (response) => { if (response.status() >= 500) errors.push(`HTTP ${response.status()} ${response.url()}`); });
  const review = { approved: false, score: 72, summary: 'Original reviewer text, not a translated UI label.', gaps: ['Check the sample'], requiredCorrections: [] };
  const task = (id, status = 'paused') => ({ id, revision: 4, status, runId: `run-${id}`, sessionId: `s-${id}`, title: id, input: 'Question', mode: 'analyze', stepResults: [], toolApprovals: [], plan: { summary: 'Two-stage plan', steps: [{ id: 'analysis', title: 'Analyze', objective: 'Inspect source', dependsOn: [], acceptanceCriteria: [] }], approvalStatus: 'approved' } });
  const tasks = new Map([['a', { ...task('a', 'awaiting_approval'), plan: { ...task('a').plan, approvalStatus: 'pending' } }], ['b', { ...task('b', 'waiting_for_human'), review }], ['nexus-run', task('nexus-run')], ['plugin-run', { ...task('plugin-run', 'waiting_for_human'), review }]]);
  const blocked = new Set();
  const denied = new Set();
  const unavailable = new Set();
  const mutations = [];
  const streams = [];
  let mutationDelay = null;
  let releaseMutation;
  let failureStatus = 0;
  let readDelayTask;
  let releaseRead;
  const workflow = { id: 'nexus-fixture', name: 'Fixture Nexus', description: '', visibility: 'private', version: 1, definition: { kind: 'agent-workflow', workflow: { schemaVersion: 1, nodes: [{ id: 'input', type: 'input', name: 'Input', position: { x: 40, y: 100 } }, { id: 'analysis', type: 'agent', name: 'Analyst', position: { x: 270, y: 100 }, agentRef: { source: 'builtin', id: 'analyst' }, objective: 'Analyze', acceptanceCriteria: [], toolNames: [] }, { id: 'output', type: 'output', name: 'Output', position: { x: 520, y: 100 } }], edges: [{ id: 'a', source: 'input', target: 'analysis', kind: 'flow' }, { id: 'b', source: 'analysis', target: 'output', kind: 'flow' }], scopedAgents: [] } } };
  const operations = { generatedAt: new Date().toISOString(), queue: { totalActive: 1, queued: 0, planning: 0, running: 0, reviewing: 0, awaitingApproval: 0, waitingForHuman: 1, paused: 0 }, workers: { active: 0, staleLeases: 0, leases: [] }, sla: { terminalTasks: 4, successRate: 75, completed: 3, failed: 1, cancelled: 0, p95DurationMs: 4500, p50DurationMs: 3000 }, models: [], tools: [], agents: [], reviewer: { completed: 4, approvalRate: 75, humanTakeover: 1, started: 4, rejected: 1 } };
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const matched = path.match(/^\/api\/tasks\/([^/]+)(?:\/(.*))?$/);
    if (matched) {
      const [, id, action] = matched;
      if (action?.startsWith('artifacts/media/')) return route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5V8AAAAASUVORK5CYII=', 'base64') });
      if (action === 'tools/executions') return route.fulfill({ json: { enabled: true, canResume: false, executions: blocked.has(id) ? [{ id: 'write-1', toolName: 'workspace.write', status: 'outcome_unknown', revision: 1, requiresReview: true, resolution: null }] : [] } });
      if (action === 'events') {
        streams.push({ id, after: Number(url.searchParams.get('after')) });
        tasks.set(id, { ...tasks.get(id), status: 'completed', result: 'Recovered Nexus output', revision: 7 });
        const events = [{ type: 'task.resumed', sequence: 5, payload: {} }, { type: 'model.delta', sequence: 6, payload: { stage: 'synthesizer', content: 'Recovered Nexus output' } }, { type: 'task.completed', sequence: 7, payload: {} }];
        return route.fulfill({ contentType: 'text/event-stream', body: events.map((event) => `event: runtime\ndata: ${JSON.stringify({ ...event, id: `${id}-${event.sequence}`, taskId: id, timestamp: new Date().toISOString() })}\n\n`).join('') });
      }
      if (!action) {
        if (unavailable.has(id)) return route.abort('failed');
        const body = JSON.stringify({ task: tasks.get(id) ?? task(id), actionPermissions: { canManage: !denied.has(id) } });
        if (readDelayTask === id) { readDelayTask = undefined; await new Promise((resolve) => { releaseRead = resolve; }); }
        return route.fulfill({ contentType: 'application/json', body });
      }
      if (request.method() === 'POST') {
        mutations.push({ id, action, body: request.postDataJSON() });
        if (mutationDelay) await mutationDelay;
        if (failureStatus) return route.fulfill({ status: failureStatus, json: { error: 'Fixture rejected the action' } });
        const previous = tasks.get(id);
        const approvals = previous.toolApprovals.map((approval) => approval.id === request.postDataJSON().approvalId ? { ...approval, status: action === 'approve-tool' ? 'approved' : 'rejected' } : approval);
        const updated = { ...previous, revision: previous.revision + 1, status: approvals.some((approval) => approval.status === 'pending') ? 'waiting_for_human' : 'queued', plan: { ...previous.plan, approvalStatus: action === 'reject-plan' ? 'rejected' : 'approved' }, toolApprovals: approvals, review: previous.review ? { ...previous.review, approved: true } : undefined };
        tasks.set(id, updated);
        return route.fulfill({ json: { task: updated, event: { sequence: 4 } } });
      }
    }
    if (path === '/api/qa/complete-plugin') { tasks.set('plugin-run', { ...tasks.get('plugin-run'), status: 'completed', result: 'Plugin result after approval' }); return route.fulfill({ json: { ok: true } }); }
    if (path === '/api/workflows') return route.fulfill({ json: { workflows: [workflow] } });
    if (path === '/api/workflows/validate') return route.fulfill({ json: { valid: false, issues: [{ code: 'missing-acceptance', message: 'Define a clear acceptance criterion for Analyst.', nodeIds: ['analysis'] }, { code: 'missing-objective', message: 'Confirm the input expected by Analyst.', nodeIds: ['analysis'] }] } });
    if (path.endsWith('/history')) return route.fulfill({ json: { activeTaskId: tasks.get('nexus-run').status === 'completed' ? null : 'nexus-run', messages: [{ id: 'nexus-run-user', role: 'user', content: 'Nexus fixture question' }], tasks: [{ id: 'nexus-run', status: tasks.get('nexus-run').status, revision: 4 }] } });
    if (path === '/api/runtime/operations') return route.fulfill({ json: operations });
    if (path === '/api/runtime/alerts') return route.fulfill({ json: { generatedAt: operations.generatedAt, summary: { critical: 1, warning: 9, info: 0 }, alerts: Array.from({ length: 10 }, (_, i) => ({ id: `alert-${i}`, severity: i === 0 ? 'critical' : 'warning', title: `Review item ${i + 1}`, detail: 'A task is waiting for an operator decision.', metric: 'human-review' })) } });
    return route.fulfill({ json: { agents: [], tools: [], workflows: [], tasks: [] } });
  });
  const fixture = `
import React from ${JSON.stringify(reactUrl)};
import ReactDOM from ${JSON.stringify(reactDomUrl)};
import {UiLanguageProvider,useUiLanguage} from '/src/lib/uiLanguage.tsx';
import {TaskActionPanel} from '/src/components/dashboard/TaskActionPanel.tsx';
import {WorkflowStudio} from '/src/components/dashboard/WorkflowStudio.tsx';
import {OperationsConsole} from '/src/components/dashboard/OperationsConsole.tsx';
import {MiniAppWindow} from '/src/components/plugins/MiniAppWindow.tsx';
import {TaskMedia} from '/src/components/dashboard/TaskMedia.tsx';
import '/src/styles.css'; import '/src/styles/dashboard.css';
const root=ReactDOM.createRoot(document.getElementById('root'));
window.qa={changes:[],aborts:0,revoked:[]};
const revoke=URL.revokeObjectURL.bind(URL); URL.revokeObjectURL=(url)=>{window.qa.revoked.push(url);revoke(url)};
function Fixture({kind,id,context}) {
 const {setLanguage}=useUiLanguage(); window.qa.language=setLanguage;
 const [tick,setTick]=React.useState(0); window.qa.rerender=()=>setTick(v=>v+1);
 const plugin={id:'plugin',name:'Fixture Mini App',definition:{type:'mini-app',width:900,height:680,agentEnabled:true,htmlContent:'<button id="request">Ask</button><output id="result"></output><script>document.querySelector("button").onclick=()=>parent.postMessage({type:"axiom.plugin.agent.request",requestId:"r1",prompt:"Analyze"},"*");addEventListener("message",event=>{if(event.data.type==="axiom.plugin.agent.response")document.querySelector("output").textContent=event.data.content||event.data.error});<'+ '/script>'}};
 const requested=async(_plugin,prompt,signal,progress)=>{window.qa.pluginStarts=(window.qa.pluginStarts||0)+1;signal.addEventListener('abort',()=>window.qa.aborts++); progress({taskId:'plugin-run',status:'Agent request queued'}); await new Promise(resolve=>window.qa.releasePlugin=resolve); throw new Error('Connection interrupted')};
 const resume=async(taskId,signal,progress,after)=>{window.qa.resumed={taskId,after};await fetch('/api/qa/complete-plugin',{signal});progress({taskId,status:'Done'});return 'Plugin result after approval'};
 const content=kind==='nexus'?React.createElement(WorkflowStudio):kind==='operations'?React.createElement(OperationsConsole):kind==='plugin'?React.createElement(MiniAppWindow,{plugin,onClose:()=>{},onAgentRequest:requested,onAgentResume:resume}):kind==='media'?React.createElement(TaskMedia,{src:'/api/tasks/media/artifacts/media/'+id,alt:'Generated fixture'}):React.createElement(TaskActionPanel,{taskId:id,refreshKey:tick,context,onChanged:async(value)=>window.qa.changes.push(value)});
 return React.createElement('main',{className:'axiom-dashboard',style:{padding:'18px',position:'relative',height:'100vh',overflow:'auto',display:'block'}},React.createElement('div',{style:{maxWidth:kind==='panel'?'440px':'none'}},content));
}
window.qa.mount=(kind,id='a',context='task')=>root.render(React.createElement(UiLanguageProvider,null,React.createElement(Fixture,{key:kind,kind,id,context})));
window.qa.mount('panel');
`;
  await page.route('**/__qa/task-actions.html*', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>(type)=>type; window.__vite_plugin_react_preamble_installed__=true; await import("/__qa/task-actions.js");</script></body></html>' }));
  await page.route('**/__qa/task-actions.js', (route) => route.fulfill({ contentType: 'text/javascript', body: fixture }));
  const check = async (name, run) => { await run(); results.push({ name, status: 'passed' }); };
  await page.goto(`${baseUrl}/__qa/task-actions.html?lang=en`);
  await check('plan decisions require confirmation and double-click sends one exact-revision request', async () => {
    await page.getByRole('button', { name: 'Approve Plan', exact: true }).click();
    await page.getByRole('alertdialog').waitFor();
    assert.equal(mutations.length, 0);
    mutationDelay = new Promise((resolve) => { releaseMutation = resolve; });
    await page.getByRole('button', { name: 'Confirm', exact: true }).evaluate((button) => { button.click(); button.click(); });
    await expect.poll(() => mutations.length).toBe(1);
    assert.equal(mutations[0].body.expectedRevision, 4);
    releaseMutation(); mutationDelay = null;
    await expect.poll(() => page.evaluate(() => window.qa.changes)).toEqual(['a']);
    await expect(page.getByTestId('task-plan-controls')).toHaveCount(0);
  });
  await check('chat, Nexus and task contexts all expose real quality review without translating reviewer output', async () => {
    for (const context of ['chat', 'nexus', 'task']) {
      await page.evaluate((context) => window.qa.mount('panel', 'b', context), context);
      await expect(page.getByText(review.summary, { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Accept Result', exact: true })).toBeVisible();
    }
    await page.getByRole('textbox', { name: 'Decision Notes' }).fill('User text stays unchanged');
    await page.evaluate(() => window.qa.language('zh-CN'));
    await expect(page.getByRole('textbox', { name: '审核意见' })).toHaveValue('User text stays unchanged');
    await expect(page.getByText(review.summary, { exact: true })).toBeVisible();
    await page.evaluate(() => window.qa.language('en'));
  });
  await check('a stale task action refreshes the state and preserves the note', async () => {
    failureStatus = 409;
    await page.getByRole('button', { name: 'Accept Result' }).click();
    await page.getByTestId('review-confirm-dialog').getByRole('button', { name: /Confirm Delivery|确认交付/ }).click();
    await expect(page.getByRole('alert')).toContainText('The task changed');
    await expect(page.getByRole('textbox', { name: 'Decision Notes' })).toHaveValue('User text stays unchanged');
    failureStatus = 0;
  });
  await check('permission failures remain failures, and read-only operators cannot approve', async () => {
    failureStatus = 403;
    await page.getByRole('button', { name: 'Accept Result' }).click();
    await page.getByTestId('review-confirm-dialog').getByRole('button', { name: /Confirm Delivery|确认交付/ }).click();
    await expect(page.getByRole('alert')).toContainText('permission');
    failureStatus = 0; denied.add('b');
    await page.getByRole('button', { name: 'Refresh task status' }).click();
    await expect(page.getByRole('button', { name: 'Accept Result' })).toBeDisabled();
    denied.delete('b');
  });
  await check('late snapshot cannot replace another selected task or leak confirmation', async () => {
    readDelayTask = 'a';
    await page.evaluate(() => window.qa.mount('panel', 'a'));
    await expect.poll(() => Boolean(releaseRead)).toBe(true);
    await page.evaluate(() => window.qa.mount('panel', 'b'));
    await expect(page.getByText(review.summary, { exact: true })).toBeVisible();
    releaseRead(); releaseRead = undefined;
    await expect(page.getByTestId('task-plan-controls')).toHaveCount(0);
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
  });
  await check('parallel tool approvals keep remaining requests visible, and unknown writes block approval', async () => {
    tasks.set('tools', { ...task('tools', 'waiting_for_human'), toolApprovals: ['first', 'second'].map((id) => ({ id, name: `workspace.write.${id}`, args: { path: `${id}.md` }, status: 'pending' })) });
    await page.evaluate(() => window.qa.mount('panel', 'tools'));
    await expect(page.getByTestId('task-tool-controls')).toHaveCount(2);
    await page.getByTestId('task-tool-controls').first().getByRole('button', { name: 'Allow Once' }).click();
    await page.getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(page.getByTestId('task-tool-controls')).toHaveCount(1);
    assert.equal(mutations.at(-1).body.approvalId, 'first');
    blocked.add('tools');
    await page.getByRole('button', { name: 'Refresh task status' }).click();
    await expect(page.getByRole('button', { name: 'Allow Once' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Continue Task' })).toHaveCount(0);
  });
  await check('Nexus reopens a paused task and resumes the same task through its runner', async () => {
    await page.evaluate(() => { window.qa.language('zh-CN'); window.qa.mount('nexus'); });
    await page.getByRole('button', { name: '继续任务', exact: true }).click();
    await expect(page.locator('.workflow-runner-messages')).toContainText('Recovered Nexus output');
    await expect(page.locator('.workflow-runner')).toContainText('Agent Nexus 执行完成');
    assert.equal(streams.at(-1).id, 'nexus-run');
    assert.equal(streams.at(-1).after, 4);
    assert.equal(mutations.at(-1).action, 'resume');
    await expect(page.locator('.workflow-runner textarea')).toBeEnabled();
  });
  await check('Mini App callbacks can rerender without abort; trusted host approvals resume the original request', async () => {
    await page.evaluate(() => { window.qa.language('en'); window.qa.mount('plugin'); });
    const frame = page.frameLocator('iframe');
    await frame.getByRole('button', { name: 'Ask' }).click();
    await expect.poll(() => page.evaluate(() => Boolean(window.qa.releasePlugin))).toBe(true);
    await page.evaluate(() => window.qa.rerender());
    assert.equal(await page.evaluate(() => window.qa.aborts), 0);
    await page.evaluate(() => window.qa.releasePlugin());
    await page.getByRole('button', { name: 'Accept Result' }).click();
    await page.getByTestId('review-confirm-dialog').getByRole('button', { name: /Confirm Delivery|确认交付/ }).click();
    await expect(frame.locator('#result')).toHaveText('Plugin result after approval');
    assert.equal((await page.evaluate(() => window.qa.resumed)).taskId, 'plugin-run');
    assert.equal((await page.evaluate(() => window.qa.resumed)).after, 4);
  });
  await check('authenticated internal media renders, downloads and revokes replaced blob URLs', async () => {
    await page.evaluate(() => window.qa.mount('media', 'first'));
    await expect.poll(() => page.getByAltText('Generated fixture').evaluate((image) => image.complete && image.naturalWidth > 0)).toBe(true);
    const first = await page.getByAltText('Generated fixture').getAttribute('src');
    const download = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Download' }).click();
    assert.ok((await download).suggestedFilename().startsWith('axiom-image'));
    await page.evaluate(() => window.qa.mount('media', 'second'));
    await expect.poll(() => page.evaluate(() => window.qa.revoked)).toContain(first);
    await expect.poll(() => page.getByAltText('Generated fixture').evaluate((image) => image.complete && image.naturalWidth > 0)).toBe(true);
  });
  await check('Mini App disconnected running or unreadable tasks keep the original request and reconnect without resubmission', async () => {
    for (const inaccessible of [false, true]) {
      tasks.set('plugin-run', task('plugin-run', 'running'));
      await page.evaluate(() => window.qa.mount('panel', 'b'));
      await page.evaluate(() => { window.qa.releasePlugin = null; window.qa.mount('plugin'); });
      const frame = page.frameLocator('iframe');
      await frame.getByRole('button', { name: 'Ask' }).click();
      await expect.poll(() => page.evaluate(() => Boolean(window.qa.releasePlugin))).toBe(true);
      const starts = await page.evaluate(() => window.qa.pluginStarts);
      if (inaccessible) unavailable.add('plugin-run');
      await page.evaluate(() => window.qa.releasePlugin());
      await expect(page.getByRole('button', { name: 'Reconnect', exact: true })).toBeVisible();
      await expect(frame.locator('#result')).toHaveText('');
      await frame.getByRole('button', { name: 'Ask' }).click();
      assert.equal(await page.evaluate(() => window.qa.pluginStarts), starts);
      await expect(frame.locator('#result')).toHaveText('');
      unavailable.delete('plugin-run');
      await page.getByRole('button', { name: 'Reconnect', exact: true }).click();
      await expect(frame.locator('#result')).toHaveText('Plugin result after approval');
      assert.equal(await page.evaluate(() => window.qa.pluginStarts), starts);
      assert.equal((await page.evaluate(() => window.qa.resumed)).taskId, 'plugin-run');
    }
  });
  await check('operations attention rows share neighboring glass and scroll without hidden alerts', async () => {
    await page.evaluate(() => window.qa.mount('operations'));
    await expect(page.locator('.ops-alert-row')).toHaveCount(10);
    const style = await page.locator('.ops-alert-panel').evaluate((element) => {
      const sibling = element.nextElementSibling;
      const main = getComputedStyle(element); const other = getComputedStyle(sibling); const row = getComputedStyle(element.querySelector('.ops-alert-row')); const list = element.querySelector('.ops-alert-list');
      return { sameBackground: main.backgroundImage === other.backgroundImage, sameBlur: main.backdropFilter === other.backdropFilter, rowBackground: row.backgroundColor, rowBorder: row.borderRadius, scrolls: list.scrollHeight > list.clientHeight };
    });
    assert.deepEqual(style, { sameBackground: true, sameBlur: true, rowBackground: 'rgba(0, 0, 0, 0)', rowBorder: '0px', scrolls: true });
    await mkdir('qa', { recursive: true });
    await page.screenshot({ path: 'qa/task-actions-operations.png', fullPage: true });
  });
  await check('human actions remain readable and reachable at desktop and mobile widths', async () => {
    for (const [name, width, height] of [['desktop', 1440, 900], ['mobile', 390, 844]]) {
      await page.setViewportSize({ width, height });
      await page.evaluate(() => window.qa.mount('panel', 'b'));
      await expect(page.getByRole('button', { name: 'Accept Result' })).toBeVisible();
      const box = await page.locator('.task-action-panel').boundingBox();
      assert.ok(box && box.width > 250 && box.x >= 0 && box.x + box.width <= width);
      await page.screenshot({ path: `qa/task-actions-${name}.png`, fullPage: true });
    }
  });
  await check('Nexus validation attention rows match the glass panel and open the corresponding Agent on desktop and mobile', async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.evaluate(() => { window.qa.language('en'); window.qa.mount('nexus'); });
    await page.getByRole('button', { name: 'Validate', exact: true }).click();
    await page.locator('.workflow-node[data-node-id="input"]').click();
    await expect(page.locator('.workflow-inspector-form input').first()).toHaveValue('Input');
    const issues = page.locator('.workflow-issues');
    await expect(issues.locator('button')).toHaveCount(2);
    const styles = await issues.evaluate((element) => {
      const title = getComputedStyle(element.querySelector('strong'));
      const row = getComputedStyle(element.querySelector('button'));
      const section = getComputedStyle(element);
      const panel = getComputedStyle(element.closest('.workflow-inspector-modal-panel'));
      return { titleSize: parseFloat(title.fontSize), rowSize: parseFloat(row.fontSize), rowBackground: row.backgroundColor, sectionBackground: section.backgroundColor, rowRadius: row.borderRadius, sameFont: row.fontFamily === panel.fontFamily, glass: panel.backdropFilter !== 'none' };
    });
    assert.ok(styles.titleSize >= 14 && styles.rowSize >= 13);
    assert.deepEqual({ ...styles, titleSize: undefined, rowSize: undefined }, { titleSize: undefined, rowSize: undefined, rowBackground: 'rgba(0, 0, 0, 0)', sectionBackground: 'rgba(0, 0, 0, 0)', rowRadius: '0px', sameFont: true, glass: true });
    await issues.getByRole('button', { name: 'Define a clear acceptance criterion for Analyst.', exact: true }).click();
    await expect(page.locator('.workflow-inspector-form input').first()).toHaveValue('Analyst');
    await expect(page.locator('.workflow-node[data-node-id="analysis"]')).toHaveClass(/selected/);
    for (const [name, width, height] of [['desktop', 1440, 900], ['mobile', 390, 844]]) {
      await page.setViewportSize({ width, height });
      await issues.getByRole('button').last().scrollIntoViewIfNeeded();
      await expect(issues.getByRole('button').last()).toBeInViewport();
      await issues.getByRole('button').last().click();
      await expect(page.locator('.workflow-inspector-form input').first()).toHaveValue('Analyst');
      const bounds = await page.locator('.workflow-inspector-modal-panel').boundingBox();
      assert.ok(bounds && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= width && bounds.y + bounds.height <= height);
      await page.screenshot({ path: name === 'desktop' ? 'qa/task-actions-nexus-issues.png' : 'qa/task-actions-nexus-issues-mobile.png', fullPage: false });
    }
  });
  assert.deepEqual(errors, []);
  process.stdout.write(`${JSON.stringify({ results, errors, mutations: mutations.length }, null, 2)}\n`);
} catch (error) {
  const page = browser?.contexts()[0]?.pages()[0];
  process.stderr.write(`${JSON.stringify({ errors, passed: results, body: await page?.locator('body').innerText().catch(() => ''), error: String(error) }, null, 2)}\n`);
  throw error;
} finally {
  await browser?.close();
  await server?.close();
}
