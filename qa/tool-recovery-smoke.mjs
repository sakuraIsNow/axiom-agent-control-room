import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { createServer } from 'vite';

const server = process.env.QA_URL ? null : await createServer({ server: { host: '127.0.0.1', port: 0, strictPort: true, open: false } });
let browser;
const errors = [];
const results = [];
try {
  await server?.listen();
  const address = server?.httpServer.address();
  if (!process.env.QA_URL && (!address || typeof address === 'string')) throw new Error('Recovery QA server failed to bind.');
  const baseUrl = process.env.QA_URL?.replace(/\/$/, '') ?? `http://127.0.0.1:${address.port}`;
  const mainModule = await (await fetch(`${baseUrl}/src/main.tsx`)).text();
  const reactUrl = mainModule.match(/["']([^"']*\/react\.js[^"']*)["']/)?.[1];
  const reactDomUrl = mainModule.match(/["']([^"']*\/react-dom_client\.js[^"']*)["']/)?.[1];
  assert.ok(reactUrl && reactDomUrl);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (error) => errors.push(error.message));
  const record = (id) => ({ id: `execution-${id}`, stepId: 'build', toolName: `workspace.write-${id}`, status: 'outcome_unknown', revision: 1, attempts: 1, updatedAt: '2026-09-07T00:00:00.000Z', requiresReview: true, resolution: null });
  const snapshots = new Map(['a', 'b'].map((id) => [id, { enabled: true, canResume: false, executions: [record(id)] }]));
  let mutations = 0;
  let reads = 0;
  let mutationGate = null;
  let mutationRelease;
  let readGateTask = null;
  let readRelease;
  let failMutation = false;
  const notes = [];
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const recovery = path.match(/^\/api\/tasks\/([^/]+)\/tools\/(.*)$/);
    if (recovery) {
      const [, taskId, operation] = recovery;
      if (request.method() === 'GET') {
        reads += 1;
        const body = JSON.stringify(snapshots.get(taskId));
        if (readGateTask === taskId) {
          readGateTask = null;
          await new Promise((resolve) => { readRelease = resolve; });
        }
        return route.fulfill({ status: 200, contentType: 'application/json', body });
      }
      mutations += 1;
      if (request.postData()) notes.push(request.postDataJSON().note);
      if (mutationGate) await mutationGate;
      if (failMutation) return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'Changed externally' }) });
      snapshots.set(taskId, operation === 'resume' ? { enabled: true, canResume: false, executions: [] } : {
        enabled: true, canResume: true, executions: [{ ...record(taskId), status: 'completed', revision: 2, requiresReview: false, receiptSource: 'human-confirmed' }],
      });
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    }
    const taskId = path.match(/^\/api\/tasks\/([^/]+)$/)?.[1];
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      task: taskId ? { id: taskId, revision: 1, status: 'waiting_for_human', stepResults: [], plan: { steps: [] } } : undefined,
      actionPermissions: { canManage: true },
      actions: [], checkpoints: [], branches: [], currentRevision: 1, feedback: [],
    }) });
  });
  const fixture = `
import React from ${JSON.stringify(reactUrl)};
import ReactDOM from ${JSON.stringify(reactDomUrl)};
import {UiLanguageProvider,useUiLanguage} from '/src/lib/uiLanguage.tsx';
import {TaskDetailPanel} from '/src/components/dashboard/TaskDetailPanel.tsx';
import {ToolRecoveryPanel} from '/src/components/dashboard/ToolRecoveryPanel.tsx';
import '/src/styles.css';
import '/src/styles/dashboard.css';
const root=ReactDOM.createRoot(document.getElementById('root'));
window.qa={changes:[]};
const noop=()=>{};
const changed=async(id)=>{window.qa.changes.push(id)};
function Fixture({id,detail,status}) {
 const {setLanguage}=useUiLanguage(); window.qa.language=setLanguage;
 const task={id,title:'Recovery fixture',input:'Write a document',userId:'fixture',status,currentStage:status,tokens:{total:0},totalSteps:1,completedSteps:0,profile:{kind:'build',difficulty:'medium',route:'team',reasons:[]}};
 return React.createElement('main',{className:'axiom-dashboard',style:{padding:'16px',minHeight:'100vh',display:'block'}},React.createElement('div',{style:{width:'min(420px,100%)'}},detail?React.createElement(TaskDetailPanel,{task,sessionTopic:'Fixture',taskProfile:null,reviewResult:null,reviewApprovalTaskId:null,reviewNote:'',reviewBusy:false,onReviewNoteChange:noop,onRequestApprove:noop,onRequestReject:noop,onResubmit:noop,onDeleteTask:noop,onCheckpointTaskCreated:changed,onRecoveryChanged:changed}):React.createElement(ToolRecoveryPanel,{taskId:id,taskStatus:status,onChanged:changed})));
}
window.qa.mount=(id,detail=false,status='waiting_for_human')=>root.render(React.createElement(UiLanguageProvider,null,React.createElement(Fixture,{id,detail,status})));
window.qa.mount('a',true);
`;
  await page.route('**/__qa/tool-recovery.html*', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>(type)=>type; window.__vite_plugin_react_preamble_installed__=true; await import("/__qa/tool-recovery.js");</script></body></html>' }));
  await page.route('**/__qa/tool-recovery.js', (route) => route.fulfill({ contentType: 'text/javascript', body: fixture }));
  const check = async (name, run) => { await run(); results.push({ name, status: 'passed' }); };
  await page.goto(`${baseUrl}/__qa/tool-recovery.html?lang=en`);
  await check('Task detail mounts recovery controls and language changes retain notes without refetching', async () => {
    await page.getByRole('button', { name: 'Confirm Completed', exact: true }).waitFor();
    await page.getByRole('textbox', { name: 'Verification notes' }).fill('Checked the external record.');
    const before = reads;
    await page.evaluate(() => window.qa.language('zh-CN'));
    await expect(page.getByRole('textbox', { name: '\u6838\u5bf9\u4f9d\u636e' })).toHaveValue('Checked the external record.');
    assert.equal(reads, before);
    await page.evaluate(() => window.qa.language('en'));
  });
  await check('double confirmation sends one mutation and resume uses the task refresh callback', async () => {
    mutationGate = new Promise((resolve) => { mutationRelease = resolve; });
    const before = mutations;
    await page.getByRole('button', { name: 'Confirm Completed', exact: true }).evaluate((button) => { button.click(); button.click(); });
    await expect.poll(() => mutations).toBe(before + 1);
    mutationRelease(); mutationGate = null;
    await page.getByRole('button', { name: 'Continue Task', exact: true }).waitFor();
    assert.equal(mutations, before + 1);
    assert.equal(notes.at(-1), 'Checked the external record.');
    await page.getByRole('button', { name: 'Continue Task', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.qa.changes)).toEqual(['a']);
  });
  await check('a late action refresh cannot overwrite the newly selected task', async () => {
    snapshots.set('a', { enabled: true, canResume: false, executions: [record('a')] });
    await page.evaluate(() => window.qa.mount('a'));
    await page.getByRole('textbox', { name: 'Verification notes' }).fill('Checked A externally.');
    readGateTask = 'a';
    await page.getByRole('button', { name: 'Confirm Completed', exact: true }).click();
    await expect.poll(() => Boolean(readRelease)).toBe(true);
    await page.evaluate(() => window.qa.mount('b'));
    await page.getByText('workspace.write-b', { exact: true }).waitFor();
    const staleResponse = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/tasks/a/tools/executions');
    readRelease(); readRelease = undefined;
    await (await staleResponse).finished();
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await expect(page.getByText('workspace.write-b', { exact: true })).toBeVisible();
    await expect(page.getByText('workspace.write-a', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Continue Task', exact: true })).toHaveCount(0);
  });
  await check('in-flight failures use the current language and retain the review note', async () => {
    await page.getByRole('textbox', { name: 'Verification notes' }).fill('Checked B externally.');
    mutationGate = new Promise((resolve) => { mutationRelease = resolve; });
    failMutation = true;
    const before = mutations;
    await page.getByRole('button', { name: 'Confirm Not Executed', exact: true }).click();
    await expect.poll(() => mutations).toBe(before + 1);
    await page.evaluate(() => window.qa.language('zh-CN'));
    mutationRelease(); mutationGate = null;
    await expect(page.getByRole('alert')).toContainText('\u64cd\u4f5c\u672a\u5b8c\u6210');
    await expect(page.getByRole('textbox', { name: '\u6838\u5bf9\u4f9d\u636e' })).toHaveValue('Checked B externally.');
    failMutation = false;
  });
  await check('failed and cancelled tasks allow outcome review but never resume', async () => {
    snapshots.set('b', { enabled: true, canResume: true, executions: [record('b')] });
    await page.evaluate(() => window.qa.language('en'));
    for (const status of ['failed', 'cancelled']) {
      await page.evaluate((value) => window.qa.mount('b', false, value), status);
      await expect(page.getByRole('button', { name: 'Confirm Completed', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Continue Task', exact: true })).toHaveCount(0);
    }
  });
  await check('system retry eligibility is distinct from a human non-execution confirmation', async () => {
    snapshots.set('b', { enabled: true, canResume: false, executions: [{ ...record('b'), status: 'retryable', requiresReview: false }] });
    await page.evaluate(() => window.qa.mount('b', false, 'paused'));
    await expect(page.getByText('Safe to retry', { exact: true })).toBeVisible();
    snapshots.set('b', { enabled: true, canResume: false, executions: [{ ...record('b'), status: 'retryable', requiresReview: false, resolution: { decision: 'confirmed-not-executed', resolvedAt: '2026-09-07T00:00:00.000Z' } }] });
    await page.getByRole('button', { name: 'Refresh records', exact: true }).click();
    await expect(page.getByText('Confirmed not executed', { exact: true })).toBeVisible();
    snapshots.set('b', { enabled: true, canResume: false, executions: [] });
    await page.getByRole('button', { name: 'Refresh records', exact: true }).click();
    await expect(page.locator('.tool-recovery')).toHaveCount(0);
  });
  await check('desktop and mobile recovery controls fit their panel', async () => {
    snapshots.set('b', { enabled: true, canResume: false, executions: [record('b')] });
    await page.evaluate(() => { window.qa.language('en'); window.qa.mount('b', true); });
    await page.getByRole('textbox', { name: 'Verification notes' }).waitFor();
    await mkdir('qa', { recursive: true });
    for (const [name, width, height] of [['desktop', 1440, 900], ['mobile', 390, 844]]) {
      await page.setViewportSize({ width, height });
      await expect(page.getByRole('textbox', { name: 'Verification notes' })).toBeVisible();
      await page.locator('.tool-recovery').scrollIntoViewIfNeeded();
      await page.screenshot({ path: `qa/tool-recovery-${name}.png`, fullPage: true });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.equal(await page.locator('.tool-recovery').evaluate((panel) => [...panel.querySelectorAll('button,textarea')].every((element) => {
        const bounds = element.getBoundingClientRect(); const parent = panel.getBoundingClientRect();
        return bounds.width > 0 && bounds.height > 0 && bounds.left >= parent.left && bounds.right <= parent.right + 1;
      })), true);
      assert.equal(await page.locator('.tool-recovery').evaluate((panel) => {
        const summary = panel.parentElement.querySelector('.dash-task-detail-summary');
        return !summary || summary.getBoundingClientRect().bottom <= panel.getBoundingClientRect().top;
      }), true);
    }
  });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status: 'passed', results }, null, 2));
} finally {
  await browser?.close();
  await server?.close();
}
