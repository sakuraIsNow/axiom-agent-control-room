import { chromium } from '@playwright/test';

const baseUrl = process.env.QA_URL ?? 'http://127.0.0.1:4300';
const taskId = 'qa-live-guidance-task';
const sessionId = 'qa-live-guidance-session';
const runId = 'qa-live-guidance-run';
const now = new Date().toISOString();
const profile = { kind: 'implementation', difficulty: 'moderate', route: 'team', score: 4, reasons: ['需要分析与实现协作'], maxSteps: 2, requiresReview: false };
const graph = {
  nodes: [
    { id: 'orchestrator', agentId: 'orchestrator', role: 'orchestrator', title: '调度 Agent', dependsOn: [], status: 'running' },
    { id: 'analysis', stepId: 'analysis', agentId: 'analyst-analysis', role: 'analyst', title: '分析边界', dependsOn: [], skillIds: ['architecture-design'], status: 'running' },
    { id: 'delivery', stepId: 'delivery', agentId: 'builder-delivery', role: 'builder', title: '形成交付', dependsOn: ['analysis'], skillIds: ['implementation'], status: 'queued' },
  ],
  edges: [
    { from: 'orchestrator', to: 'analysis', kind: 'delegation' },
    { from: 'analysis', to: 'delivery', kind: 'dependency' },
  ],
  revision: 2,
};
const plan = {
  summary: '分析后形成可执行交付。',
  routingReason: '本轮需要分析员和工程师协作。',
  profile,
  steps: [
    { id: 'analysis', title: '分析边界', role: 'analyst', objective: '分析边界。', dependsOn: [], acceptanceCriteria: ['边界明确'], skillIds: ['architecture-design'] },
    { id: 'delivery', title: '形成交付', role: 'builder', objective: '形成交付。', dependsOn: ['analysis'], acceptanceCriteria: ['可执行'], skillIds: ['implementation'] },
  ],
  graph,
  routingDecision: {
    intent: 'task', taskKind: 'implementation', difficulty: 'moderate', requiresExternalFacts: false,
    requiredCapabilities: ['architecture', 'implementation'], candidateAgentIds: ['analyst', 'builder'],
    candidateSkillIds: ['architecture-design', 'implementation'], confidence: 0.93, rationale: '需要先分析边界，再形成交付。',
  },
  schedulingDecision: {
    route: 'team', activeAgentIds: ['analyst', 'builder'], skippedAgentIds: ['researcher'], appendAgentIds: ['analyst', 'builder'],
    selectedSkillIds: ['architecture-design', 'implementation'], executionWaves: [['analysis'], ['delivery']],
    steps: [
      { id: 'analysis', title: '分析边界', agentId: 'analyst', objective: '分析边界。', dependsOn: [], skillIds: ['architecture-design'] },
      { id: 'delivery', title: '形成交付', agentId: 'builder', objective: '形成交付。', dependsOn: ['analysis'], skillIds: ['implementation'] },
    ],
    requiresReview: false, synthesisAgentId: 'synthesizer', reason: '按依赖分两步执行。',
  },
  routingVersion: 'router-scheduler/v1',
  routerModel: 'qa-router-model',
  routerConfidence: 0.93,
  version: 1,
  approvalStatus: 'approved',
};
const summary = {
  id: taskId, runId, sessionId, userId: 'qa-live-guidance', title: '执行中追加要求回归', input: '设计一个可上线的平台。',
  mode: 'build', model: 'qa-model', status: 'running', profile, cancelRequested: false, createdAt: now, updatedAt: now,
  currentStage: 'agent:analysis', durationMs: 1200, tokens: { prompt: 100, completion: 30, total: 130 }, estimatedCostUsd: 0,
  modelCalls: 1, queueWaitMs: 10, attempts: 1, toolCalls: 0, completedSteps: 0, totalSteps: 2, pendingToolApprovals: 0,
};
const task = { ...summary, plan, stepResults: [], toolApprovals: [], review: null };
const session = {
  id: sessionId,
  tenantId: 'local',
  userId: 'local-user',
  title: summary.title,
  activeTaskId: taskId,
  activeAssistantId: 'qa-assistant',
  messages: [
    { id: 'qa-user', role: 'user', content: summary.input, createdAt: Date.now() - 1000 },
    { id: 'qa-assistant', role: 'assistant', content: '', createdAt: Date.now(), pending: true, taskId, route: 'team', agentRole: 'orchestrator' },
  ],
  updatedAt: Date.now(),
  agentGraph: graph,
};
const baseEvents = [
  { id: 'event-1', type: 'routing.decided', sequence: 1, agentId: 'router-agent', payload: { ...plan.routingDecision, profile, routerModel: plan.routerModel } },
  { id: 'event-2', type: 'scheduling.decided', sequence: 2, agentId: 'scheduler-agent', payload: { ...plan.schedulingDecision, profile, graph } },
  { id: 'event-3', type: 'task.started', sequence: 3, payload: { profile } },
  { id: 'event-4', type: 'agent.started', sequence: 4, agentId: 'analyst-analysis', payload: { stepId: 'analysis', role: 'analyst', title: '分析边界', objective: '分析边界。', dependsOn: [], skillIds: ['architecture-design'] } },
].map((event) => ({ ...event, version: 1, taskId, runId, timestamp: now }));

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();
const consoleErrors = [];
let guidancePosted = false;
let guidanceRequests = 0;
let taskCreateRequests = 0;
const eventAfters = [];

page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
page.on('pageerror', (error) => consoleErrors.push(error.message));
page.on('request', (request) => {
  const url = new URL(request.url());
  if (request.method() === 'POST' && url.pathname === '/api/tasks') taskCreateRequests += 1;
});

await page.route('**/api/tasks?limit=30', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ tasks: [summary] }) }));
await page.route('**/api/sessions?limit=50', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ sessions: [session], deletedSessionIds: [] }) }));
await page.route(`**/api/sessions/${sessionId}`, async (route) => {
  if (route.request().method() === 'PUT') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ session }) });
  return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ session }) });
});
await page.route(`**/api/tasks/${taskId}`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ task }) }));
await page.route(`**/api/tasks/${taskId}/guidance`, async (route) => {
  guidanceRequests += 1;
  guidancePosted = true;
  const accepted = { id: 'event-5', type: 'human.guidance_accepted', version: 1, taskId, runId, sequence: 5, timestamp: new Date().toISOString(), payload: { guidanceId: 'guidance-qa-1', message: '补充移动端验收。', behavior: 'continue', delivery: 'builtin-next-safe-point' } };
  await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ taskId, guidanceId: 'guidance-qa-1', status: 'accepted', delivery: 'builtin-next-safe-point', accepted }) });
});
await page.route(`**/api/tasks/${taskId}/events**`, async (route) => {
  const after = Number(new URL(route.request().url()).searchParams.get('after') ?? 0);
  eventAfters.push(after);
  if (after >= 4 && !guidancePosted) {
    const deadline = Date.now() + 8_000;
    while (!guidancePosted && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  } else {
    await new Promise((resolve) => setTimeout(resolve, 220));
  }
  const guidanceEvents = guidancePosted ? [
    { id: 'event-5', type: 'human.guidance_accepted', sequence: 5, payload: { guidanceId: 'guidance-qa-1', message: '补充移动端验收。', behavior: 'continue', delivery: 'builtin-next-safe-point' } },
    { id: 'event-6', type: 'human.guidance_applied', sequence: 6, payload: { guidanceId: 'guidance-qa-1', delivery: 'builtin-next-safe-point', applicationPoint: 'loop:1', targetAgentIds: ['analyst-analysis'] } },
  ].map((event) => ({ ...event, version: 1, taskId, runId, timestamp: new Date().toISOString() })) : [];
  const events = [...baseEvents, ...guidanceEvents].filter((event) => event.sequence > after);
  await route.fulfill({ status: 200, contentType: 'text/event-stream', body: events.map((event) => `event: runtime\ndata: ${JSON.stringify(event)}\n\n`).join('') });
});

try {
  await page.goto(`${baseUrl}/?view=chat&session=${sessionId}`, { waitUntil: 'domcontentloaded' });
  const composer = page.locator('.dash-chat-composer textarea');
  await composer.waitFor({ state: 'visible', timeout: 20_000 });
  await page.getByText('Agent 小组', { exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
  const inputEnabledDuringRun = await composer.isEnabled();
  await composer.fill('补充移动端验收。');
  await page.getByRole('button', { name: '加入当前任务' }).click();
  await page.getByText('补充要求：补充移动端验收。', { exact: true }).waitFor({ state: 'visible', timeout: 10_000 });
  const appliedStateVisible = await page.locator('.dash-chat-composer .dash-guidance-feedback', { hasText: '补充要求已应用到当前任务' })
    .waitFor({ state: 'visible', timeout: 10_000 }).then(() => true).catch(() => false);
  const routeText = await page.locator('.dash-route-insight').innerText();
  const guidanceFeedback = await page.locator('.dash-guidance-feedback').allTextContents();
  const assertions = {
    runningTaskAcceptsGuidance: inputEnabledDuringRun,
    guidanceUsesDedicatedEndpointOnce: guidanceRequests === 1,
    guidanceDoesNotCreateSecondTask: taskCreateRequests === 0,
    guidancePersistsInConversationContext: await page.getByText('补充要求：补充移动端验收。', { exact: true }).count() === 1,
    guidanceShowsAppliedState: appliedStateVisible,
    routeInsightUsesDurableDecision: routeText.includes('Agent 小组') && routeText.includes('分析员') && routeText.includes('工程师') && routeText.includes('93%'),
    noBrowserErrors: consoleErrors.length === 0,
  };
  process.stdout.write(`${JSON.stringify({ assertions, routeText, guidanceFeedback, guidanceRequests, taskCreateRequests, eventAfters, consoleErrors }, null, 2)}\n`);
  if (Object.values(assertions).some((passed) => !passed)) process.exitCode = 1;
} finally {
  await browser.close();
}
