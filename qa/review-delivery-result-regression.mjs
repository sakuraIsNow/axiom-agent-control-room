import { chromium } from '@playwright/test';

const baseUrl = process.env.QA_URL ?? 'http://127.0.0.1:4300';
const taskId = 'qa-review-delivery-task';
const sessionId = 'qa-review-delivery-session';
const finalResult = '## 最终交付\n\n审批后的任务结果已经回填到当前对话。';
const now = new Date().toISOString();
const profile = { kind: 'implementation', difficulty: 'complex', route: 'full-workflow', score: 6, reasons: ['质量门禁'], maxSteps: 2, requiresReview: true };
const review = { approved: false, score: 70, summary: '自动审查未通过，需要人工决定。', gaps: ['缺少最终确认'], requiredCorrections: ['确认是否按当前结果交付'] };
const graph = {
  nodes: [
    { id: 'orchestrator', agentId: 'orchestrator', role: 'orchestrator', title: '调度 Agent', dependsOn: [], status: 'running' },
    { id: 'delivery', stepId: 'delivery', agentId: 'builder-delivery', role: 'builder', title: '实现 Agent', dependsOn: [], status: 'completed' },
    { id: 'synthesizer', agentId: 'synthesizer', role: 'synthesizer', title: '汇总交付', dependsOn: ['delivery'], status: 'queued' },
  ],
  edges: [{ from: 'orchestrator', to: 'delivery', kind: 'delegation' }, { from: 'delivery', to: 'synthesizer', kind: 'dependency' }],
};
let status = 'waiting_for_human';
let result;
let approveCalls = 0;
let requestedAfter = null;
const task = () => ({
  id: taskId, runId: 'qa-review-delivery-run', sessionId, title: '审批结果回填回归', input: '生成一份可交付结果。', mode: 'build', model: 'qa-model', status,
  plan: { summary: '执行并审核。', routingReason: '复杂任务需要质量门禁。', profile, steps: [], graph, version: 1, approvalStatus: 'approved' },
  stepResults: [{ stepId: 'delivery', agentId: 'builder-delivery', role: 'builder', status: 'completed', output: '阶段结果', evidence: [], confidence: 0.8, attempts: 1, durationMs: 10 }],
  review: status === 'completed' ? { ...review, approved: true } : review,
  ...(result ? { result } : {}),
  toolApprovals: [], createdAt: now, updatedAt: now,
});
const summary = () => ({
  id: taskId, runId: 'qa-review-delivery-run', sessionId, userId: 'qa-user', title: '审批结果回填回归', input: '生成一份可交付结果。', mode: 'build', model: 'qa-model', status,
  profile, cancelRequested: false, createdAt: now, updatedAt: now, currentStage: status === 'completed' ? 'completed' : 'human review', durationMs: 100,
  tokens: { prompt: 10, completion: 20, total: 30 }, estimatedCostUsd: 0, modelCalls: 2, queueWaitMs: 0, attempts: 1, toolCalls: 0, completedSteps: 1, totalSteps: 1, reviewScore: 70, pendingToolApprovals: 0,
});
const session = {
  id: sessionId, tenantId: 'local', userId: 'qa-user', title: '审批结果回填回归', updatedAt: Date.now(),
  messages: [
    { id: 'qa-user', role: 'user', content: '生成一份可交付结果。', createdAt: Date.now() - 2_000 },
    { id: 'qa-assistant', role: 'assistant', content: '审查员暂停交付：自动审查未通过，需要人工决定。', createdAt: Date.now() - 1_000, pending: false, taskId, route: 'full-workflow', agentRole: 'orchestrator' },
  ],
};

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 800 } });
const page = await context.newPage();
const errors = [];
page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
page.on('pageerror', (error) => errors.push(error.message));

await page.route('**/api/tasks?limit=30', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ tasks: [summary()] }) }));
await page.route(`**/api/tasks/${taskId}/approve-review`, async (route) => {
  approveCalls += 1;
  status = 'queued';
  await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ task: task(), event: { id: 'approval-event', type: 'review.approved', version: 1, taskId, runId: 'qa-review-delivery-run', sequence: 73, agentId: 'operator-review', timestamp: now, payload: { score: 70 } } }) });
});
await page.route(`**/api/tasks/${taskId}/events?after=*`, async (route) => {
  requestedAfter = new URL(route.request().url()).searchParams.get('after');
  status = 'completed';
  result = finalResult;
  const event = { id: 'completed-event', type: 'task.completed', version: 1, taskId, runId: 'qa-review-delivery-run', sequence: 74, timestamp: new Date().toISOString(), payload: { result: finalResult, route: 'full-workflow', profile, graph } };
  await route.fulfill({ status: 200, contentType: 'text/event-stream; charset=utf-8', body: `id: 74\nevent: runtime\ndata: ${JSON.stringify(event)}\n\n` });
});
await page.route(`**/api/tasks/${taskId}`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ task: task() }) }));
await page.route('**/api/sessions?limit=50', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ sessions: [session], deletedSessionIds: [] }) }));
await page.route(`**/api/sessions/${sessionId}`, async (route) => {
  if (route.request().method() === 'PUT') {
    const body = route.request().postDataJSON();
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ session: body }) });
  } else await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ session }) });
});

try {
  await page.goto(`${baseUrl}/?view=chat&session=${sessionId}`, { waitUntil: 'networkidle' });
  const controls = page.getByTestId('chat-human-review-controls');
  await controls.waitFor({ state: 'visible', timeout: 20_000 });
  await controls.getByRole('button', { name: '按当前结果交付' }).click();
  await page.getByTestId('review-confirm-dialog').getByRole('button', { name: '确认交付' }).click();
  await page.getByText('最终交付', { exact: true }).waitFor({ state: 'visible', timeout: 20_000 });
  const transcript = await page.locator('.dash-chat-messages').innerText();
  const assertions = {
    approvalSubmittedOnce: approveCalls === 1,
    streamContinuesAfterApprovalEvent: requestedAfter === '73',
    completedResultRendered: transcript.includes('审批后的任务结果已经回填到当前对话'),
    staleReviewMessageReplaced: !transcript.includes('审查员暂停交付'),
    pendingIndicatorCleared: !transcript.includes('正在恢复执行状态'),
    noBrowserErrors: errors.length === 0,
  };
  process.stdout.write(`${JSON.stringify({ assertions, requestedAfter, errors }, null, 2)}\n`);
  if (Object.values(assertions).some((value) => !value)) process.exitCode = 1;
} finally {
  await browser.close();
}
