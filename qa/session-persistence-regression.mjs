import { chromium } from '@playwright/test';

const firstOrigin = process.env.QA_URL_A ?? 'http://127.0.0.1:4300';
const secondOrigin = process.env.QA_URL_B ?? 'http://localhost:4300';
const apiOrigin = process.env.QA_API ?? 'http://127.0.0.1:8787';
const qaHeaders = { 'x-axiom-tenant-id': 'qa-session-persistence', 'x-axiom-user-id': 'qa-session-persistence' };
const sessionId = `qa-cross-origin-${Date.now()}`;
const payload = {
  id: sessionId,
  title: '跨端口恢复验证',
  messages: [
    { id: `${sessionId}-user`, role: 'user', content: '跨端口历史测试', createdAt: Date.now() - 1_000 },
    { id: `${sessionId}-assistant`, role: 'assistant', content: '历史仍然存在', createdAt: Date.now(), pending: true, route: 'direct', agentRole: 'direct-responder' },
  ],
  updatedAt: Date.now(),
  agentGraph: {
    nodes: [{
      id: 'direct-search',
      stepId: 'direct-response',
      agentId: 'search-agent',
      role: 'search-agent',
      title: '搜索 Agent',
      dependsOn: [],
      skillIds: ['web-search'],
      status: 'completed',
      tokens: 128,
      durationMs: 420,
    }],
    edges: [],
  },
};
const staleLocalPayload = {
  ...payload,
  updatedAt: payload.updatedAt + 60_000,
  activeTaskId: `${sessionId}-missing-task`,
  activeAssistantId: `${sessionId}-assistant`,
};

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const response = await fetch(`${apiOrigin}/api/sessions/${encodeURIComponent(sessionId)}`, {
  method: 'PUT',
  headers: { ...qaHeaders, 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
});
assert(response.ok, `Could not seed session (${response.status}).`);

const browser = await chromium.launch({ headless: true });
const errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, extraHTTPHeaders: qaHeaders });
  await context.addInitScript(({ storageKey, session }) => {
    localStorage.setItem(storageKey, JSON.stringify([session]));
  }, { storageKey: 'axiom-agent-sessions-v1', session: staleLocalPayload });
  const openAndRead = async (origin, reload = false) => {
    const page = await context.newPage();
    page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(origin, { waitUntil: 'networkidle' });
    await page.locator('.axiom-dashboard').waitFor({ state: 'visible', timeout: 30_000 });
    await page.locator('.dash-nav-new').click();
    await page.locator('.dash-chat-workspace').waitFor({ state: 'visible', timeout: 8_000 });
    if (reload) await page.reload({ waitUntil: 'networkidle' });
    if (reload) {
      await page.locator('.dash-nav-new').click();
      await page.locator('.dash-chat-workspace').waitFor({ state: 'visible', timeout: 8_000 });
    }
    const session = page.locator(`[data-session-id="${sessionId}"]`);
    await session.waitFor({ state: 'visible', timeout: 15_000 });
    await session.locator('.dash-chat-session-main').click();
    await page.locator('.dash-chat-message.user').filter({ hasText: '跨端口历史测试' }).waitFor({ state: 'visible', timeout: 8_000 });
    const assistantLocator = page.locator('.dash-chat-message.assistant').filter({ hasText: '历史仍然存在' });
    const assistant = await assistantLocator.count();
    await page.waitForFunction(() => document.querySelectorAll('.dash-agent-signal-node').length === 1, undefined, { timeout: 8_000 });
    return {
      assistant,
      pending: await assistantLocator.evaluateAll((elements) => elements.filter((element) => element.classList.contains('pending')).length),
      thinkingIndicators: await page.locator('.dash-chat-thinking').count(),
      runningAgents: await page.locator('.dash-agent-signal-node.status-running').count(),
      completedAgents: await page.locator('.dash-agent-signal-node.status-completed').count(),
      graphVisible: await page.locator('.dash-agent-signal-graph').isVisible(),
      graphNodeCount: await page.locator('.dash-agent-signal-graph .dash-agent-signal-node').count(),
      url: page.url(),
    };
  };

  const first = await openAndRead(firstOrigin, true);
  const second = await openAndRead(secondOrigin);
  assert(first.assistant > 0, 'History was not restored after a same-origin reload.');
  assert(second.assistant > 0, 'History was not restored from the second origin.');
  assert(first.pending === 0 && second.pending === 0, 'A stale pending response survived session hydration.');
  assert(first.thinkingIndicators === 0 && second.thinkingIndicators === 0, 'A historical response still rendered an active Agent indicator.');
  assert(first.runningAgents === 0 && second.runningAgents === 0, 'A terminal direct Agent remained in thinking state.');
  assert(first.completedAgents === 1 && second.completedAgents === 1, 'The restored direct Agent was not marked completed.');
  assert(first.graphVisible && second.graphVisible, 'The persisted Agent Graph was not restored.');
  assert(first.graphNodeCount === 1 && second.graphNodeCount === 1, 'The restored Agent Graph node count was not preserved.');
  assert(errors.length === 0, `Browser errors: ${errors.join('; ')}`);
  process.stdout.write(`${JSON.stringify({ ok: true, firstOrigin, secondOrigin, sessionId, reloadRestored: first.assistant > 0, crossOriginRestored: second.assistant > 0, stalePendingCleared: first.pending === 0 && second.pending === 0, restoredAgentCompleted: first.completedAgents === 1 && second.completedAgents === 1, restoredGraph: first.graphVisible && second.graphVisible && first.graphNodeCount === 1 && second.graphNodeCount === 1, browserErrors: errors.length }, null, 2)}\n`);
} finally {
  await fetch(`${apiOrigin}/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE', headers: qaHeaders }).catch(() => undefined);
  await browser.close();
}
