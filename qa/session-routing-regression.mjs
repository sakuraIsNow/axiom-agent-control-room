import { chromium } from '@playwright/test';

const baseUrl = process.env.QA_URL ?? 'http://127.0.0.1:4300';
const qaHeaders = { 'x-axiom-tenant-id': 'qa-session-routing', 'x-axiom-user-id': 'qa-session-routing' };
const terminalStatuses = new Set(['completed', 'failed', 'cancelled']);
const createdTaskIds = [];
const createdSessionIds = new Set();
let observeNavigation = true;
let navigationCancelRequests = 0;
const approvedReviewTaskIds = new Set();
const approvedPlanTaskIds = new Set();

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

const taskState = async (taskId) => {
  const response = await fetch(`${baseUrl}/api/tasks/${encodeURIComponent(taskId)}`, {
    headers: qaHeaders,
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.task) throw new Error(body?.error ?? `Task lookup failed (${response.status}).`);
  return body.task;
};

// This suite exercises the complete delivery path. Review gates are real
// runtime behavior, so the test operator approves them explicitly instead of
// treating waiting_for_human as a timeout.
const advanceApprovalGate = async (task) => {
  if (task.status === 'waiting_for_human' && task.review && !approvedReviewTaskIds.has(task.id)) {
    const response = await fetch(`${baseUrl}/api/tasks/${encodeURIComponent(task.id)}/approve-review`, {
      method: 'POST',
      headers: { ...qaHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: '自动化回归测试批准审核门禁。' }),
    });
    if (!response.ok && response.status !== 409) {
      throw new Error(`Review approval failed with ${response.status}.`);
    }
    approvedReviewTaskIds.add(task.id);
    return true;
  }
  if (task.status === 'awaiting_approval' && task.plan?.steps?.length && !approvedPlanTaskIds.has(task.id)) {
    const response = await fetch(`${baseUrl}/api/tasks/${encodeURIComponent(task.id)}/approve-plan`, {
      method: 'POST',
      headers: { ...qaHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: '自动化回归测试批准执行计划。' }),
    });
    if (!response.ok && response.status !== 409) {
      throw new Error(`Plan approval failed with ${response.status}.`);
    }
    approvedPlanTaskIds.add(task.id);
    return true;
  }
  return false;
};

const waitForTerminalTask = async (taskId, timeoutMs = 240_000) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const task = await taskState(taskId);
    if (terminalStatuses.has(task.status)) return task;
    await advanceApprovalGate(task);
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  throw new Error(`Task ${taskId} did not reach a terminal state within ${timeoutMs} ms.`);
};

const cleanupTask = async (taskId) => {
  let task = await taskState(taskId).catch(() => null);
  if (!task) return;
  if (!terminalStatuses.has(task.status)) {
    await fetch(`${baseUrl}/api/tasks/${encodeURIComponent(taskId)}/cancel`, { method: 'POST', headers: qaHeaders }).catch(() => undefined);
    task = await waitForTerminalTask(taskId, 20_000).catch(() => task);
  }
  if (terminalStatuses.has(task.status)) {
    await fetch(`${baseUrl}/api/tasks/${encodeURIComponent(taskId)}`, { method: 'DELETE', headers: qaHeaders }).catch(() => undefined);
  }
};

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, extraHTTPHeaders: qaHeaders });
const page = await context.newPage();
page.on('request', (request) => {
  if (observeNavigation && request.method() === 'POST' && /\/api\/tasks\/[^/]+\/cancel$/.test(request.url())) {
    navigationCancelRequests += 1;
  }
});

try {
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await page.locator('.axiom-dashboard').waitFor({ state: 'visible', timeout: 30_000 });
  await page.locator('.dash-nav-new').click();
  await page.locator('.dash-chat-workspace').waitFor({ state: 'visible', timeout: 5_000 });

  const composer = page.locator('.dash-chat-composer textarea');
  const send = page.locator('.dash-chat-controls .send');
  const comparisonPrompt = '请基于最新官方资料，比较 PostgreSQL 与 SQLite 在多 worker 部署中的并发、迁移和故障恢复风险，给出选型方案并验证结论';
  await composer.fill(comparisonPrompt);
  const firstTaskResponsePromise = page.waitForResponse(
    (response) => response.request().method() === 'POST' && response.url().endsWith('/api/tasks'),
    { timeout: 60_000 },
  );
  await send.click();
  const firstTaskBody = await (await firstTaskResponsePromise).json();
  const firstTaskId = firstTaskBody?.task?.id;
  assert(typeof firstTaskId === 'string', 'Comparison request did not create a durable workflow task.');
  createdTaskIds.push(firstTaskId);

  const firstTask = await waitForTerminalTask(firstTaskId);
  createdSessionIds.add(firstTask.sessionId);
  assert(firstTask.status === 'completed', `Comparison workflow ended with ${firstTask.status}.`);
  assert(['team', 'full-workflow'].includes(firstTask.plan?.profile?.route), `Comparison workflow routed to ${firstTask.plan?.profile?.route ?? 'unknown'} instead of a multi-Agent route.`);
  assert((firstTask.plan?.steps?.length ?? 0) >= 2, 'Comparison workflow did not create multiple Agent steps.');
  await page.waitForFunction(() => {
    const answer = document.querySelector('.dash-chat-message.assistant:last-of-type');
    return Boolean(answer && !answer.classList.contains('pending') && answer.querySelector('.dash-chat-message-content')?.textContent?.trim());
  }, undefined, { timeout: 30_000 });
  await page.waitForFunction(() => document.querySelectorAll('.dash-agent-signal-node').length >= 2, undefined, { timeout: 15_000 });

  const firstAnswerBefore = (await page.locator('.dash-chat-message.assistant .dash-chat-message-content').first().innerText()).trim();
  const graphBefore = await page.locator('.dash-agent-signal-node').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-agent-id') ?? '').sort());
  assert(firstAnswerBefore.length > 0, 'The comparison answer is empty before the follow-up.');
  assert(graphBefore.length >= 2, 'The substantive Agent Graph does not contain multiple nodes.');

  await composer.fill('你在吗');
  await send.click();
  await page.waitForFunction(() => {
    const answers = [...document.querySelectorAll('.dash-chat-message.assistant')];
    const latest = answers.at(-1);
    return answers.length >= 2 && Boolean(latest && !latest.classList.contains('pending') && latest.querySelector('.dash-chat-message-content')?.textContent?.trim());
  }, undefined, { timeout: 120_000 });

  const firstAnswerAfter = (await page.locator('.dash-chat-message.assistant .dash-chat-message-content').first().innerText()).trim();
  const graphAfter = await page.locator('.dash-agent-signal-node').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-agent-id') ?? '').sort());
  const firstTaskAfterFollowUp = await taskState(firstTaskId);
  assert(firstAnswerAfter === firstAnswerBefore, 'A simple follow-up overwrote the earlier workflow answer.');
  assert(graphBefore.every((id) => graphAfter.includes(id)), 'A simple follow-up removed Agents from the cumulative session Graph.');
  assert(graphAfter.length > graphBefore.length, 'The direct Agent used by the follow-up was not appended to the cumulative session Graph.');
  assert(firstTaskAfterFollowUp.status === 'completed', `Follow-up changed the prior task status to ${firstTaskAfterFollowUp.status}.`);
  assert(navigationCancelRequests === 0, 'A follow-up unexpectedly issued a task cancellation request.');

  await composer.fill('现在有哪些可用智能体');
  await send.click();
  await page.waitForFunction(() => {
    const answers = [...document.querySelectorAll('.dash-chat-message.assistant')];
    const latest = answers.at(-1);
    return answers.length >= 3 && Boolean(latest && !latest.classList.contains('pending') && latest.querySelector('.dash-chat-message-content')?.textContent?.trim());
  }, undefined, { timeout: 60_000 });
  const graphAfterRegistry = await page.locator('.dash-agent-signal-node').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-agent-id') ?? '').sort());
  assert(graphAfterRegistry.length > graphAfter.length, 'A specialist registry turn did not append a node to the existing Agent Graph.');

  const draftSessionIds = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.locator('.dash-nav-new').click();
    draftSessionIds.push(await page.locator('.dash-chat-session-item.selected').getAttribute('data-session-id'));
  }
  assert(new Set(draftSessionIds).size === 1, 'Repeated new-task clicks created multiple local blank drafts.');
  const visibleSessionIds = (await page.locator('.dash-chat-session-item').evaluateAll((items) => items
    .map((item) => item.getAttribute('data-session-id'))
    .filter(Boolean)));
  assert(visibleSessionIds.length === new Set(visibleSessionIds).size, 'The conversation list rendered a session more than once.');
  await page.waitForTimeout(800);
  const remoteSessionsResponse = await fetch(`${baseUrl}/api/sessions?limit=100`, { headers: qaHeaders });
  const remoteSessionsBody = await remoteSessionsResponse.json();
  assert(remoteSessionsResponse.ok, 'Could not inspect isolated session persistence.');
  assert(!remoteSessionsBody.sessions.some((session) => session.messages.length === 0 && !session.activeTaskId), 'A blank draft was persisted remotely.');

  const firstSessionItem = page.locator(`[data-session-id="${firstTask.sessionId}"]`);
  await firstSessionItem.locator('.dash-chat-session-main').click();
  await page.waitForFunction((expected) => {
    const ids = [...document.querySelectorAll('.dash-agent-signal-node')]
      .map((node) => node.getAttribute('data-agent-id') ?? '')
      .sort();
    return JSON.stringify(ids) === JSON.stringify(expected);
  }, graphAfterRegistry, { timeout: 15_000 });
  const restoredGraph = await page.locator('.dash-agent-signal-node').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-agent-id') ?? '').sort());
  assert(JSON.stringify(restoredGraph) === JSON.stringify(graphAfterRegistry), 'Selecting the conversation restored the wrong cumulative Agent Graph.');
  const historicalAgentsCompleted = await page.locator('.dash-agent-signal-node.status-running').count() === 0;
  assert(historicalAgentsCompleted, 'A completed historical Agent remained in thinking state.');

  await page.locator('.dash-nav-new').click();
  const runningPrompt = '请设计一个生产级多 worker 数据迁移工作流，包含依赖、失败恢复、验证和回滚策略';
  await composer.fill(runningPrompt);
  const secondTaskResponsePromise = page.waitForResponse(
    (response) => response.request().method() === 'POST' && response.url().endsWith('/api/tasks'),
    { timeout: 60_000 },
  );
  await send.click();
  const secondTaskBody = await (await secondTaskResponsePromise).json();
  const secondTaskId = secondTaskBody?.task?.id;
  assert(typeof secondTaskId === 'string', 'Running-workflow navigation test did not create a task.');
  createdTaskIds.push(secondTaskId);
  if (typeof secondTaskBody?.task?.sessionId === 'string') createdSessionIds.add(secondTaskBody.task.sessionId);

  await page.locator('.dash-nav-new').click();
  await page.waitForTimeout(800);
  const secondTaskAfterNavigation = await taskState(secondTaskId);
  assert(secondTaskAfterNavigation.status !== 'cancelled', 'Starting a new conversation cancelled the durable workflow.');
  assert(navigationCancelRequests === 0, 'Conversation navigation issued POST /cancel.');

  process.stdout.write(`${JSON.stringify({
    ok: true,
    comparisonTaskId: firstTaskId,
    comparisonRoute: firstTask.plan.profile.route,
    comparisonAgentCount: graphBefore.length,
    answerPreserved: firstAnswerAfter === firstAnswerBefore,
    graphPreserved: graphBefore.every((id) => graphAfter.includes(id)),
    directTurnAppendedGraph: graphAfter.length > graphBefore.length,
    specialistTurnAppendedGraph: graphAfterRegistry.length > graphAfter.length,
    repeatedNewTaskReusesDraft: new Set(draftSessionIds).size === 1,
    visibleConversationIdsUnique: visibleSessionIds.length === new Set(visibleSessionIds).size,
    blankDraftPersisted: false,
    selectedSessionGraphRestored: JSON.stringify(restoredGraph) === JSON.stringify(graphAfterRegistry),
    historicalAgentsCompleted,
    navigationTaskStatus: secondTaskAfterNavigation.status,
    navigationCancelRequests,
  }, null, 2)}\n`);
} finally {
  observeNavigation = false;
  for (const taskId of createdTaskIds) await cleanupTask(taskId);
  for (const sessionId of createdSessionIds) {
    await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE', headers: qaHeaders }).catch(() => undefined);
  }
  await browser.close();
}
