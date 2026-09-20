import assert from 'node:assert/strict';
import { chromium, expect } from '@playwright/test';
import { createServer } from 'vite';

// Exercise the real App, its SSE consumer and the existing inline approval UI.
// Every API is intercepted; this does not create tasks or invoke a provider.
const server = await createServer({ server: { host: '127.0.0.1', strictPort: true, open: false }, logLevel: 'error' });
let browser;
const results = [];
const errors = [];
try {
  await new Promise((resolve, reject) => { server.httpServer.once('error', reject); server.httpServer.listen(0, '127.0.0.1', resolve); });
  const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
  for (const language of ['en', 'zh-CN']) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addInitScript((value) => {
      localStorage.setItem('axiom-ui-language-v1', value);
      localStorage.setItem('axiom-onboarding-seen-v2', '1');
    }, language);
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    const taskId = `qa-chat-tool-${language}`;
    const sessionId = `qa-chat-session-${language}`;
    const now = new Date().toISOString();
    const profile = { kind: 'implementation', difficulty: 'moderate', route: 'single-agent', score: 3, reasons: [], maxSteps: 1, requiresReview: false };
    let task = { id: taskId, revision: 4, runId: `run-${taskId}`, sessionId, userId: 'qa-user', tenantId: 'local',
      title: 'Review a real workspace change', input: 'Update an existing project file', model: 'qa-model', mode: 'build', status: 'running',
      plan: { summary: 'Update one bounded file', approvalStatus: 'approved', version: 1, profile,
        steps: [{ id: 'build', title: 'Build', role: 'builder', objective: 'Update an existing file', dependsOn: [], acceptanceCriteria: [] }] },
      stepResults: [], toolApprovals: [], createdAt: now, updatedAt: now, cancelRequested: false };
    // Deliberately stale: the old code waits for this list instead of the SSE boundary.
    const summary = { ...task, profile, currentStage: 'running', tokens: { prompt: 10, completion: 10, total: 20 }, durationMs: 100, completedSteps: 0, totalSteps: 1 };
    let session = { id: sessionId, title: task.title, tenantId: 'local', userId: 'qa-user', updatedAt: Date.now(), activeTaskId: taskId, activeAssistantId: 'assistant',
      messages: [{ id: 'user', role: 'user', content: task.input, createdAt: Date.now() - 1000 }, { id: 'assistant', role: 'assistant', content: '', pending: true, taskId, createdAt: Date.now() }] };
    let releaseStream;
    let streams = 0;
    const mutations = [];
    const requestedAfter = [];
    const event = (sequence, type, payload) => ({ id: `event-${sequence}`, version: 1, taskId, runId: task.runId, sequence, type, timestamp: now, agentId: 'builder-build', payload });
    const encode = (events) => events.map((value) => `id: ${value.sequence}\nevent: runtime\ndata: ${JSON.stringify(value)}\n\n`).join('');
    const unsupported = [];
    await page.route('**/api/**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const path = url.pathname;
      if (path === '/api/tasks') return route.fulfill({ json: { tasks: [summary] } });
      if (path === `/api/tasks/${taskId}`) return route.fulfill({ json: { task, actionPermissions: { canManage: true } } });
      if (path === `/api/tasks/${taskId}/tools/executions`) return route.fulfill({ json: { enabled: true, executions: [], canResume: false } });
      if (path === `/api/tasks/${taskId}/events`) {
        streams += 1;
        requestedAfter.push(url.searchParams.get('after'));
        if (streams === 1) {
          const body = await new Promise((resolve) => { releaseStream = resolve; });
          return route.fulfill({ contentType: 'text/event-stream', body }).catch(() => {});
        }
        task = { ...task, status: 'completed', revision: 7, result: 'Approved change is delivered in this conversation.' };
        return route.fulfill({ contentType: 'text/event-stream', body: encode([event(16, 'task.completed', { result: task.result, route: 'single-agent', profile })]) });
      }
      if (path === `/api/tasks/${taskId}/approve-tool`) {
        const body = request.postDataJSON();
        mutations.push(body);
        assert.equal(body.expectedRevision, 5);
        assert.equal(body.approvalId, 'approval-1');
        task = { ...task, status: 'queued', revision: 6, toolApprovals: task.toolApprovals.map((approval) => ({ ...approval, status: 'approved' })) };
        return route.fulfill({ json: { task, event: event(15, 'tool.approved', {}) } });
      }
      if (path === '/api/sessions') return route.fulfill({ json: { sessions: [session], deletedSessionIds: [] } });
      if (path === `/api/sessions/${sessionId}`) {
        if (request.method() === 'PUT') session = request.postDataJSON();
        return route.fulfill({ json: { session } });
      }
      if (path === '/api/whoami') return route.fulfill({ json: { tenantId: 'local', userId: 'qa-user', role: 'owner' } });
      if (path === '/api/health') return route.fulfill({ json: { configured: true, status: 'ready', model: 'qa-model' } });
      if (path === '/api/runtime/readiness') return route.fulfill({ json: { status: 'ready', score: 100, checks: [], blockers: [], warnings: [], tools: [] } });
      if (path === '/api/runtime/capabilities') return route.fulfill({ json: { execution: { tools: [] } } });
      if (path === '/api/tasks/stats') return route.fulfill({ json: { total: 1, byStatus: { running: 1 }, totalTokens: 20 } });
      if (path === '/api/tasks/stats/daily') return route.fulfill({ json: { days: [] } });
      if (path === '/api/agents') return route.fulfill({ json: { agents: [] } });
      if (path === '/api/notifications') return route.fulfill({ json: { notifications: [], unreadCount: 0 } });
      unsupported.push(`${request.method()} ${path}`);
      return route.fulfill({ json: { agents: [], templates: [], notifications: [], unreadCount: 0, credentials: [], sessions: [] } });
    });
    await page.goto(`${baseUrl}/?view=chat&session=${sessionId}`, { waitUntil: 'domcontentloaded' });
    await expect.poll(() => Boolean(releaseStream)).toBe(true);
    await expect(page.locator('.dash-chat-thinking')).toHaveCount(1);
    await expect(page.getByTestId('task-tool-controls')).toHaveCount(0);
    const approval = { id: 'approval-1', stepId: 'build', name: 'workspace.write', args: { path: 'src/existing.ts', content: 'changed' }, status: 'pending', risk: 'high', signature: 'qa-signature', requestedAt: now };
    task = { ...task, status: 'waiting_for_human', revision: 5, toolApprovals: [approval] };
    const started = Date.now();
    releaseStream(encode([
      event(10, 'tool.approval_requested', { approval, stepId: 'build', name: approval.name, risk: 'high' }),
      // A late/sibling observation must not relight the waiting assistant.
      event(11, 'agent.tool_loop', { phase: 'observation', role: 'builder' }),
      event(12, 'model.delta', { stage: 'single-agent:build', content: 'late incomplete generation' }),
    ]));
    const allow = page.getByTestId('task-tool-controls').getByRole('button', { name: language === 'en' ? 'Allow Once' : '允许此次调用', exact: true });
    await expect(allow).toBeVisible({ timeout: 4000 });
    await expect(page.locator('.dash-chat-thinking')).toHaveCount(0);
    await expect(page.locator('.dash-chat-head small')).toHaveText(language === 'en' ? 'Awaiting confirmation' : '等待确认');
    await expect(page.locator('.dash-chat-messages')).not.toContainText('late incomplete generation');
    assert.ok(Date.now() - started < 5000, 'Approval should arrive before the 15-second catalog poll');
    await allow.click();
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await expect(page.locator('.dash-chat-messages')).toContainText('Approved change is delivered in this conversation.', { timeout: 6000 });
    await expect(page.locator('.dash-chat-thinking')).toHaveCount(0);
    assert.equal(mutations.length, 1);
    assert.equal(requestedAfter.at(-1), '15');
    assert.deepEqual(unsupported, []);
    results.push({ language, status: 'passed', checks: ['SSE refresh with stale task list', 'correct task approval in chat', 'no stale thinking after boundary', 'single-click scoped approval', 'same task resumes after approval', 'delivery replaces waiting text'] });
    await context.close();
  }
  assert.deepEqual(errors, []);
  process.stdout.write(`${JSON.stringify({ results, errors }, null, 2)}\n`);
} catch (error) {
  const page = browser?.contexts().at(-1)?.pages().at(-1);
  process.stderr.write(`${JSON.stringify({ results, errors, error: String(error), body: await page?.locator('body').innerText().catch(() => '') }, null, 2)}\n`);
  throw error;
} finally {
  await browser?.close();
  await server.close();
}
