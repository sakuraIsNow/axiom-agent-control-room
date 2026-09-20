import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { createServer } from 'vite';

// Mount the real component against a private, deterministic API. No real task,
// model, database, tool, or user history is touched by this browser regression.
const scratch = await mkdtemp(join(tmpdir(), 'axiom-rsi-ui-'));
const vite = await createServer({ envFile: false, cacheDir: join(scratch, '.vite'), server: { host: '127.0.0.1', port: 0, strictPort: true, open: false, proxy: {} } });
const checks = [];
let browser;
try {
  const listening = once(vite.httpServer, 'listening'); vite.httpServer.listen(0, '127.0.0.1'); await listening;
  const address = vite.httpServer.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const main = await (await fetch(`${base}/src/main.tsx`)).text();
  const react = main.match(/["']([^"']*\/react\.js[^"']*)["']/)?.[1];
  const reactDom = main.match(/["']([^"']*\/react-dom_client\.js[^"']*)["']/)?.[1];
  assert.ok(react && reactDom);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
  const page = await context.newPage();
  const errors = [], unexpected = [], requests = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const source = { id: 'source-task', title: 'Paper research · Keep my original title', status: 'completed', updatedAt: new Date().toISOString(), mode: 'analyze' };
  const secondSource = { ...source, id: 'followup-task', title: 'Follow-up task' };
  let sources = [source, secondSource], proposals = [], conflict = false, loadFailure = false;
  let releaseGeneration;
  const candidate = () => ({ id: 'candidate-one', revision: 2, status: 'draft', sourceTaskId: source.id,
    sourceTitle: source.title, mode: source.mode, createdAt: source.updatedAt, updatedAt: source.updatedAt,
    generation: 1, qualityStatus: 'unverified', model: 'fixture-text-model', usageTokens: 321,
    baseline: { status: 'completed', model: 'fixture-text-model', agentCount: 2, tokens: null, durationMs: 45200, reviewScore: 80 },
    analysis: { summary: 'The recorded report omits DOI verification. This is a hypothesis, not a measured gain.',
      observations: [{ finding: 'DOI evidence is absent.', evidence: 'The supplied report has a bibliography without DOI.' }],
      changes: [{ target: 'verification', suggestion: 'Check DOI against the source before final delivery.', reason: 'This may improve citation traceability.' }],
      trialInstruction: 'Preserve the original scope and verify DOI only where source evidence exists.',
      validationCases: [{ input: 'Research an unrelated domain with five papers.', expectedBehavior: 'Mark missing DOI instead of inventing it.' }],
      risks: ['More verification can add latency. No evaluation has been run.'] } });
  const trial = { input: 'Original request: research papers.\nUnverified guidance: check DOI.', mode: 'analyze', sourceTaskId: source.id, proposalId: 'candidate-one', warnings: ['No task has been executed.', 'Attachments are not carried over.'] };
  const evaluationSuite = { id: 'fixture-comparison', version: '1', digest: 'fixture-digest', cases: [{ id: 'independent-fixture', title: 'Synthetic document contract', scope: 'Fixed text only' }], modelCalls: 2, maxOutputTokensPerCall: 900, timeoutMs: 180000, limitations: ['Not real workflow execution.'] };
  let evaluations = [], evaluationConflict = false;
  const evaluation = () => ({ id: 'evaluation-one', revision: 1, proposalId: 'candidate-one', proposalRevision: proposals[0].revision,
    suiteId: evaluationSuite.id, suiteVersion: '1', suiteDigest: 'fixture-digest', status: 'running', qualityStatus: 'unverified', model: 'fixture-text-model',
    createdAt: source.updatedAt, updatedAt: source.updatedAt, progress: { completed: 0, total: 2 },
    cases: [{ fixtureId: 'independent-fixture', title: 'Synthetic document contract', scope: 'Fixed text only' }],
    summary: { baselinePassed: 0, candidatePassed: 0, totalChecks: 2, baselineTokens: null, candidateTokens: null, baselineLatencyMs: null, candidateLatencyMs: null, monetaryCost: null, humanInterventions: null, improvedChecks: 0, regressedChecks: 0 }, limitations: ['Fixed cases only. Not a blind benchmark. No policy changes.'] });
  await page.route('**/api/**', async (route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname.replace(/\/$/, ''), method = request.method();
    requests.push({ path, method, body: request.postDataJSON() });
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (method === 'GET' && path === '/api/improvements/evaluation-suite') return json({ suite: evaluationSuite });
    if (method === 'GET' && path === '/api/improvements/candidate-one/evaluations') return json({ evaluations });
    if (method === 'POST' && path === '/api/improvements/candidate-one/evaluations') {
      if (evaluationConflict) return json({ error: 'Evaluation changed.' }, 409);
      const body = request.postDataJSON(); assert.equal(body.revision, proposals[0].revision); assert.ok(body.idempotencyKey?.length >= 8);
      evaluations = [evaluation(), ...evaluations.filter((item) => item.id !== 'evaluation-one')]; return json({ evaluation: evaluations[0] }, 202);
    }
    if (method === 'POST' && path === '/api/improvements/candidate-one/evaluations/evaluation-one/cancel') {
      assert.equal(request.postDataJSON().revision, evaluations[0].revision);
      evaluations = [{ ...evaluations[0], status: 'cancelled', qualityStatus: 'inconclusive', revision: evaluations[0].revision + 1 }];
      return json({ evaluation: evaluations[0] });
    }
    if (method === 'GET' && path === '/api/improvements/sources') return json({ tasks: sources });
    if (method === 'GET' && path === '/api/improvements') return loadFailure ? json({ error: 'fixture unavailable' }, 503) : json({ proposals });
    if (method === 'POST' && path === '/api/improvements') {
      const body = request.postDataJSON();
      assert.ok(body.idempotencyKey?.length >= 8); assert.equal(body.language, 'en');
      await new Promise((resolveGeneration) => { releaseGeneration = resolveGeneration; });
      proposals = [candidate()]; return json({ proposal: proposals[0] }, 201);
    }
    if (method === 'PATCH' && path === '/api/improvements/candidate-one') {
      if (conflict) return json({ error: 'This candidate changed.' }, 409);
      const body = request.postDataJSON(); assert.equal(body.revision, proposals[0].revision);
      proposals = [{ ...proposals[0], status: body.status, revision: proposals[0].revision + 1 }];
      return json({ proposal: proposals[0] });
    }
    if (method === 'POST' && path === '/api/improvements/candidate-one/prepare') {
      assert.equal(proposals[0].status, 'accepted'); assert.equal(request.postDataJSON().revision, proposals[0].revision);
      return json(trial);
    }
    unexpected.push(`${method} ${path}`); return json({ error: 'Unexpected test request' }, 500);
  });
  const fixture = `import React from ${JSON.stringify(react)};import ReactDOM from ${JSON.stringify(reactDom)};
import {ImprovementWorkspace} from '/src/components/dashboard/ImprovementWorkspace.tsx';
import {UiLanguageProvider,useUiLanguage} from '/src/lib/uiLanguage.tsx';
import '/src/styles.css';import '/src/styles/dashboard.css';
window.qa={drafts:[]};function Fixture(){const {setLanguage}=useUiLanguage();const [hasDraft,setHasDraft]=React.useState(false);window.qa.language=setLanguage;window.qa.hasDraft=setHasDraft;
return React.createElement('main',{className:'axiom-dashboard','data-theme':'obsidian',style:{display:'block',height:'100vh',overflow:'auto',padding:16}},React.createElement(ImprovementWorkspace,{hasExistingDraft:hasDraft,onPrepareConversation:(draft)=>window.qa.drafts.push(draft)}));}
ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(UiLanguageProvider,null,React.createElement(Fixture)));`;
  await page.route('**/__qa/improvements.html*', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>(type)=>type;window.__vite_plugin_react_preamble_installed__=true;await import("/__qa/improvements.js");</script></body></html>' }));
  await page.route('**/__qa/improvements.js', (route) => route.fulfill({ contentType: 'text/javascript', body: fixture }));
  const check = async (name, run) => { await run(); checks.push(name); };
  await page.goto(`${base}/__qa/improvements.html`, { waitUntil: 'networkidle' });
  await check('English entry and no model call on open', async () => {
    await expect(page.getByRole('heading', { name: 'Task improvements', exact: true })).toBeVisible();
    await expect(page.locator('#improvement-source')).toHaveValue(source.id);
    assert.equal(requests.filter((request) => request.method === 'POST').length, 0);
  });
  await page.locator('#improvement-note').fill('Improve citation quality without changing the existing workflow.');
  await page.getByRole('button', { name: 'Generate suggestions', exact: true }).click();
  await check('Immediate progress and no duplicate submission', async () => {
    await expect(page.locator('.improvement-composer button[type="submit"]')).toBeDisabled();
    await expect(page.locator('.improvement-composer [role="status"]')).toBeVisible();
    assert.equal(requests.filter((request) => request.method === 'POST').length, 1);
    await expect(page.locator('#improvement-source')).toBeDisabled();
  });
  releaseGeneration();
  await expect(page.getByRole('button', { name: 'Save suggestion', exact: true })).toBeVisible();
  await check('Recorded metrics, original content and unverified status', async () => {
    await expect(page.locator('.improvement-detail h2')).toHaveText(source.title);
    await expect(page.locator('.improvement-unverified')).toHaveText('Not validated');
    await expect(page.locator('.improvement-metrics')).toContainText('321');
    await expect(page.locator('.improvement-metrics')).toContainText(/not recorded|unavailable|unknown/i);
    await expect(page.locator('.improvement-model')).toContainText('fixture-text-model');
    await expect(page.locator('.improvement-summary')).toHaveText(candidate().analysis.summary);
  });
  await check('Suggested tests are explicitly unexecuted', async () => {
    const tests = page.locator('.improvement-tests').first(); await tests.locator('summary').click();
    await expect(tests).toContainText(/not run|not executed/i);
    await expect(tests).toContainText(candidate().analysis.validationCases[0].expectedBehavior);
  });
  await page.getByRole('button', { name: 'Save suggestion', exact: true }).click();
  await check('Saved advice does not execute or become verified', async () => {
    await expect(page.getByRole('button', { name: 'Try in a new conversation', exact: true })).toBeVisible();
    assert.equal(proposals[0].status, 'accepted');
    assert.equal(await page.evaluate(() => window.qa.drafts.length), 0);
    assert.equal(requests.some((request) => /\/tasks|\/chat|\/nexus|\/plugins/.test(request.path)), false);
    await expect(page.locator('.improvement-unverified')).toHaveText('Not validated');
  });
  await check('Follow-up task can reference prior task suggestion', async () => {
    await page.locator('#improvement-source').selectOption(secondSource.id);
    await expect(page.locator('#improvement-parent')).toBeVisible();
    await page.locator('#improvement-parent').selectOption('candidate-one');
    await expect(page.locator('#improvement-parent')).toHaveValue('candidate-one');
  });
  await page.getByRole('button', { name: 'Try in a new conversation', exact: true }).click();
  await check('Preparing is only an editable unsent draft', async () => {
    await expect(page.locator('.improvement-trial')).toBeVisible();
    assert.equal(await page.evaluate(() => window.qa.drafts.length), 0);
    await expect(page.locator('.improvement-trial')).toContainText(/attach/i);
    await page.locator('.improvement-trial textarea').fill('User-edited trial request');
    await page.getByRole('button', { name: 'Open new conversation', exact: true }).click();
    assert.equal(await page.evaluate(() => window.qa.drafts[0].input), 'User-edited trial request');
  });
  await check('Existing unsent draft requires explicit preservation acknowledgement', async () => {
    await page.evaluate(() => window.qa.hasDraft(true));
    const replacement = page.getByRole('button', { name: 'Replace input and open a new conversation', exact: true });
    await expect(replacement).toBeDisabled();
    await page.getByRole('checkbox', { name: 'I have kept my original input and attachments', exact: true }).check();
    await expect(replacement).toBeEnabled();
    assert.equal(await page.evaluate(() => window.qa.drafts.length), 1);
    await page.evaluate(() => window.qa.hasDraft(false));
  });
  await check('Stale revision is visible, not silently accepted', async () => {
    conflict = true;
    await page.getByRole('button', { name: 'Dismiss suggestion', exact: true }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    assert.equal(proposals[0].status, 'accepted'); conflict = false;
    await page.getByRole('button', { name: 'Refresh improvements', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveCount(0);
  });
  await check('Dismiss without changing the original task', async () => {
    await page.getByRole('button', { name: 'Dismiss suggestion', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Try in a new conversation', exact: true })).toHaveCount(0);
    assert.equal(proposals[0].status, 'dismissed'); assert.equal(source.status, 'completed');
  });
  await check('Restore an ignored suggestion without another model request', async () => {
    const generations = requests.filter((request) => request.method === 'POST' && request.path === '/api/improvements').length;
    await page.getByRole('button', { name: 'Save suggestion', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Try in a new conversation', exact: true })).toBeVisible();
    assert.equal(proposals[0].status, 'accepted');
    assert.equal(requests.filter((request) => request.method === 'POST' && request.path === '/api/improvements').length, generations);
  });
  await check('Refresh failure is visible and recoverable', async () => {
    loadFailure = true; await page.getByRole('button', { name: 'Refresh improvements', exact: true }).click();
    await expect(page.getByRole('alert')).toBeVisible(); loadFailure = false;
    await page.getByRole('button', { name: 'Refresh improvements', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveCount(0);
  });
  await check('Comparison requires explicit usage acknowledgement and remains tool-free', async () => {
    const panel = page.getByTestId('improvement-evaluation');
    const start = panel.getByRole('button', { name: 'Start comparison', exact: true });
    await expect(start).toBeDisabled();
    await panel.getByRole('checkbox').check(); await expect(start).toBeEnabled(); await start.click();
    await expect(panel.getByRole('button', { name: 'Stop comparison', exact: true })).toBeVisible();
    await expect(panel.locator('progress')).toHaveAttribute('value', '0');
    assert.equal(requests.filter((item) => item.method === 'POST' && item.path.endsWith('/evaluations')).length, 1);
    assert.equal(requests.some((item) => /\/tasks|\/chat|\/nexus|\/plugins/.test(item.path)), false);
    await expect(page.locator('.improvement-unverified')).toHaveText('Not validated');
  });
  await check('Stopping a comparison preserves a visible record, not a successful result', async () => {
    const panel = page.getByTestId('improvement-evaluation');
    await panel.getByRole('button', { name: 'Stop comparison', exact: true }).click();
    await expect(panel.locator('.improvement-evaluation-result')).toHaveAttribute('data-outcome', 'inconclusive');
    await expect(panel.locator('.improvement-evaluation-heading').last()).toContainText('Comparison stopped');
    assert.equal(evaluations[0].status, 'cancelled');
  });
  await check('Comparison conflict stays recoverable without silently restarting', async () => {
    const panel = page.getByTestId('improvement-evaluation'); evaluationConflict = true;
    await panel.getByRole('checkbox').check(); await panel.getByRole('button', { name: 'Start comparison', exact: true }).click();
    await expect(panel.getByRole('alert')).toBeVisible(); assert.equal(evaluations[0].status, 'cancelled');
    evaluationConflict = false; await panel.getByRole('button', { name: 'Refresh comparisons', exact: true }).click();
    await expect(panel.getByRole('alert')).toHaveCount(0);
  });
  await check('Independent result exposes paired evidence and unknown usage without global promotion', async () => {
    const arm = { status: 'completed', output: '{"finding":"No external tools executed"}', checks: [{ id: 'requirement', category: 'requirements', passed: true, detail: 'Required document fields match fixture evidence.' }], latencyMs: 500, tokens: null, attempts: 1 };
    evaluations = [{ ...evaluation(), status: 'completed', qualityStatus: 'improved', progress: { completed: 2, total: 2 },
      cases: [{ fixtureId: 'independent-fixture', title: 'Synthetic document contract', scope: 'Fixed text only', baseline: { ...arm, checks: [{ ...arm.checks[0], passed: false }] }, candidate: arm }],
      summary: { ...evaluation().summary, baselinePassed: 0, candidatePassed: 1, totalChecks: 1, baselineLatencyMs: 500, candidateLatencyMs: 500, improvedChecks: 1 } }];
    const panel = page.getByTestId('improvement-evaluation');
    await panel.getByRole('button', { name: 'Refresh comparisons', exact: true }).click();
    await expect(panel.locator('.improvement-evaluation-result')).toHaveAttribute('data-outcome', 'improved');
    await expect(panel.getByRole('table')).toContainText('Not recorded');
    await expect(panel.getByRole('table')).toContainText('Not measured, not zero');
    await panel.getByText('Inspect case evidence', { exact: true }).click();
    await expect(panel.locator('.improvement-evaluation-arms')).toContainText('Required document fields');
    await expect(page.locator('.improvement-unverified')).toHaveText('Not validated');
    await expect(panel).toContainText('has not been applied');
    await mkdir(resolve('qa'), { recursive: true });
    await panel.screenshot({ path: 'qa/improvements-comparison.png' });
  });
  await check('Comparison survives remount and does not launch another model request', async () => {
    const count = requests.filter((item) => item.method === 'POST' && item.path.endsWith('/evaluations')).length;
    await page.reload();
    await expect(page.getByTestId('improvement-evaluation').locator('.improvement-evaluation-result')).toHaveAttribute('data-outcome', 'improved');
    assert.equal(requests.filter((item) => item.method === 'POST' && item.path.endsWith('/evaluations')).length, count);
  });
  await check('Language switching preserves model/user text', async () => {
    await page.evaluate(() => window.qa.language('zh-CN'));
    await expect(page.getByRole('heading', { name: '任务改进', exact: true })).toBeVisible();
    await expect(page.locator('.improvement-unverified')).toHaveText('尚未验证');
    await expect(page.locator('.improvement-summary')).toHaveText(candidate().analysis.summary);
    await expect(page.getByTestId('improvement-evaluation')).toContainText('先对照，再决定');
  });
  await mkdir(resolve('qa'), { recursive: true });
  await page.locator('.improvement-detail').evaluate((element) => { element.scrollTop = 0; });
  await page.screenshot({ path: 'qa/improvements-desktop.png', fullPage: true });
  await check('Mobile remains readable and scrollable', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole('heading', { name: '任务改进', exact: true })).toBeVisible();
    const layout = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: innerWidth, font: getComputedStyle(document.querySelector('.improvement-summary')).fontSize }));
    assert.ok(layout.width <= layout.viewport + 1, JSON.stringify(layout)); assert.ok(parseFloat(layout.font) >= 14);
    await page.locator('.improvement-actions').scrollIntoViewIfNeeded();
    await expect(page.getByRole('button', { name: '复制建议', exact: true })).toBeVisible();
    await page.screenshot({ path: 'qa/improvements-mobile.png', fullPage: true });
  });
  await check('Persisted failure remains a failure and can be retried', async () => {
    proposals = [{ ...candidate(), status: 'failed', analysis: undefined, error: 'Fixture model timed out.' }];
    await page.getByRole('button', { name: '刷新改进记录', exact: true }).click();
    await expect(page.locator('.improvement-failed')).toBeVisible();
    await expect(page.getByRole('button', { name: '重新选择此任务', exact: true })).toBeEnabled();
    await expect(page.locator('.improvement-summary')).toHaveCount(0);
  });
  await check('No source / deleted source empty state', async () => {
    sources = []; proposals = [];
    await page.getByRole('button', { name: '刷新改进记录', exact: true }).click();
    await expect(page.locator('.improvement-composer button[type="submit"]')).toBeDisabled();
    await expect(page.locator('.improvement-empty')).toBeVisible();
    await expect(page.locator('.improvement-summary')).toHaveCount(0);
  });
  assert.deepEqual(errors, []); assert.deepEqual(unexpected, []);
  checks.push('No browser errors or unexpected API/side effects');
  const report = { suite: 'controlled-rsi-ui-v2', passed: checks.length, failed: 0, checks, model: 'deterministic browser fixture', realModelQualityEvaluated: false };
  await writeFile('qa/improvements-results.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close(); await vite.close();
  const target = relative(tmpdir(), scratch);
  if (!target.startsWith('axiom-rsi-ui-') || target.includes('..') || /[\\/]/.test(target)) throw new Error('Unexpected RSI test cleanup target.');
  await rm(scratch, { recursive: true, force: true });
}
