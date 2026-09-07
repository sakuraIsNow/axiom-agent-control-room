import { chromium } from '@playwright/test';

const baseUrl = process.env.QA_URL ?? 'http://127.0.0.1:8787';
const qaHeaders = { 'x-axiom-tenant-id': 'qa-session-routing', 'x-axiom-user-id': 'qa-session-routing' };
const terminalStatuses = new Set(['completed', 'failed', 'cancelled']);
const createdTaskIds = [];
const createdSessionIds = new Set();
let observeNavigation = true;
let navigationCancelRequests = 0;
const approvedReviewTaskIds = new Set();
const approvedPlanTaskIds = new Set();
const routingDiagnostics = [];
const taskTimeoutMs = Number(process.env.QA_SESSION_ROUTING_TASK_TIMEOUT_MS ?? 480_000);

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
assert(Number.isFinite(taskTimeoutMs) && taskTimeoutMs >= 30_000 && taskTimeoutMs <= 900_000,
  'QA_SESSION_ROUTING_TASK_TIMEOUT_MS must be between 30000 and 900000 ms.');

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

const waitForTerminalTask = async (taskId, timeoutMs = taskTimeoutMs) => {
  const startedAt = Date.now();
  let lastState;
  while (Date.now() - startedAt < timeoutMs) {
    const task = await taskState(taskId);
    lastState = {
      status: task.status,
      route: task.plan?.profile?.route,
      steps: task.stepResults?.map((step) => ({ id: step.stepId, status: step.status })),
      approvedPlan: approvedPlanTaskIds.has(taskId),
      approvedReview: approvedReviewTaskIds.has(taskId),
    };
    if (terminalStatuses.has(task.status)) return task;
    await advanceApprovalGate(task);
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  throw new Error(`Task ${taskId} did not reach a terminal state within ${timeoutMs} ms. Elapsed: ${Date.now() - startedAt} ms. Last state: ${JSON.stringify(lastState)}. Routing: ${JSON.stringify(routingDiagnostics.slice(-8))}`);
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
page.on('response', async (response) => {
  if (response.request().method() !== 'POST') return;
  const path = new URL(response.url()).pathname;
  if (!['/api/chat/route', '/api/tasks', '/api/chat'].includes(path)) return;
  const diagnostic = { path, status: response.status() };
  routingDiagnostics.push(diagnostic);
  if (path === '/api/chat') return;
  const body = await response.json().catch(() => null);
  if (path === '/api/chat/route' && body?.decision) {
    const { source, intent, execution, workflowRoute, scheduler } = body.decision;
    Object.assign(diagnostic, { source, intent, execution, workflowRoute, activeAgentIds: scheduler?.activeAgentIds });
  }
  if (path === '/api/tasks' && body?.task?.id) {
    const routing = response.request().postDataJSON()?.routing;
    Object.assign(diagnostic, { source: routing?.source, workflowRoute: routing?.workflowRoute });
    if (!createdTaskIds.includes(body.task.id)) createdTaskIds.push(body.task.id);
    if (body.task.sessionId) createdSessionIds.add(body.task.sessionId);
  }
  if (!response.ok()) Object.assign(diagnostic, { error: String(body?.error ?? 'Request failed').slice(0, 300) });
});

const sendWorkflowRequest = async (send) => {
  const sessionId = await page.locator('.dash-chat-session-item.selected').getAttribute('data-session-id');
  if (sessionId) createdSessionIds.add(sessionId);
  const responsePromise = page.waitForResponse(
    (response) => response.request().method() === 'POST'
      && ['/api/tasks', '/api/chat'].includes(new URL(response.url()).pathname),
    { timeout: 60_000 },
  );
  await send.click();
  try {
    const response = await responsePromise;
    if (new URL(response.url()).pathname !== '/api/tasks') {
      throw new Error('The explicit collaboration request entered the direct chat gateway instead of a durable task.');
    }
    const body = await response.json();
    assert(response.ok() && typeof body?.task?.id === 'string', `Task creation failed with HTTP ${response.status()}: ${String(body?.error ?? 'Missing task id').slice(0, 300)}`);
    if (!createdTaskIds.includes(body.task.id)) createdTaskIds.push(body.task.id);
    createdSessionIds.add(body.task.sessionId);
    return body;
  } catch (error) {
    const routeText = await page.locator('.dash-route-insight').innerText().catch(() => 'Route insight unavailable');
    throw new Error(`${error.message}\nRouting diagnostics: ${JSON.stringify(routingDiagnostics.slice(-8))}\nVisible route: ${routeText}`, { cause: error });
  }
};

try {
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await page.locator('.axiom-dashboard').waitFor({ state: 'visible', timeout: 30_000 });
  await page.locator('.dash-nav-new').click();
  await page.locator('.dash-chat-workspace').waitFor({ state: 'visible', timeout: 5_000 });

  const composer = page.locator('.dash-chat-composer textarea');
  const send = page.locator('.dash-chat-controls .send');
  // This suite exercises real Graph/history continuity after collaboration.
  // Previous input: 请基于最新官方资料，比较 PostgreSQL 与 SQLite 在多 worker 部署中的并发、迁移和故障恢复风险，给出选型方案并验证结论
  // Router network failures made that mixed retrieval request fall back to a
  // single search Agent. Compound-retrieval fallback needs separate coverage;
  // this explicit collaboration prompt does not claim to fix that limitation.
  const comparisonPrompt = '请用研究员、分析员和审查员协作比较 PostgreSQL 与 SQLite 的多 worker 部署方案。研究员先根据已有知识梳理并发、迁移与恢复约束；分析员据此给出选型表和回滚方案；审查员独立检查两者的结论与缺口。请实际分配这些独立职责并合并交付，仅使用已有知识，尚未验证的事实要明确标注，总交付控制在600字以内。';
  await composer.fill(comparisonPrompt);
  const comparisonStartedAt = Date.now();
  const firstTaskBody = await sendWorkflowRequest(send);
  const firstTaskId = firstTaskBody?.task?.id;
  assert(typeof firstTaskId === 'string', 'Comparison request did not create a durable workflow task.');

  const firstTask = await waitForTerminalTask(firstTaskId);
  const comparisonDurationMs = Date.now() - comparisonStartedAt;
  const comparisonRouteSource = routingDiagnostics.find((item) => item.path === '/api/tasks')?.source ?? 'unavailable';
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
  const secondTaskBody = await sendWorkflowRequest(send);
  const secondTaskId = secondTaskBody?.task?.id;
  assert(typeof secondTaskId === 'string', 'Running-workflow navigation test did not create a task.');
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
    comparisonRouteSource,
    comparisonFinalStatus: firstTask.status,
    comparisonDurationMs,
    taskTimeoutMs,
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
  // Stop browser persistence before deleting this run's isolated sessions.
  await browser.close();
  for (const taskId of createdTaskIds) await cleanupTask(taskId);
  for (const sessionId of createdSessionIds) {
    await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE', headers: qaHeaders }).catch(() => undefined);
  }
}
