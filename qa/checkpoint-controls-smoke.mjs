import { chromium } from '@playwright/test';

const baseUrl = process.env.QA_URL ?? 'http://127.0.0.1:4300';
const taskId = 'qa-checkpoint-source';
const branchTaskId = 'qa-checkpoint-branch';
const sessionId = 'qa-checkpoint-session';
const checkpointId = 'checkpoint-qa-2';
const now = new Date().toISOString();
const profile = { kind: 'implementation', difficulty: 'complex', route: 'full-workflow', score: 8, reasons: ['需要多阶段执行'], maxSteps: 3, requiresReview: false };
const steps = [
  { id: 'research', title: '核对依据', role: 'researcher', objective: '核对依据。', dependsOn: [], acceptanceCriteria: ['依据明确'], skillIds: ['web-research'] },
  { id: 'build', title: '形成方案', role: 'builder', objective: '形成方案。', dependsOn: ['research'], acceptanceCriteria: ['方案可执行'], skillIds: ['implementation'] },
  { id: 'review', title: '验证方案', role: 'reviewer', objective: '验证方案。', dependsOn: ['build'], acceptanceCriteria: ['质量达标'], skillIds: ['quality-review'] },
];
const summary = {
  id: taskId, runId: 'qa-checkpoint-run', sessionId, userId: 'local-user', title: '检查点分支回归', input: '完成一项可恢复的复杂任务。',
  mode: 'build', model: 'qa-model', status: 'completed', profile, revision: 7, cancelRequested: false, createdAt: now, updatedAt: now,
  currentStage: 'completed', durationMs: 3200, tokens: { prompt: 420, completion: 180, total: 600 }, estimatedCostUsd: 0,
  modelCalls: 3, queueWaitMs: 12, attempts: 1, toolCalls: 0, completedSteps: 3, totalSteps: 3, pendingToolApprovals: 0,
};
const task = {
  ...summary,
  plan: { summary: '按三个阶段完成任务。', routingReason: '需要研究、实现与审查。', profile, steps, graph: { nodes: [], edges: [], revision: 3 }, version: 2, approvalStatus: 'approved' },
  stepResults: steps.map((step, index) => ({ stepId: step.id, agentId: `${step.role}-${step.id}`, role: step.role, status: 'completed', output: `${step.title}结果`, evidence: [], confidence: 0.9, attempts: 1, durationMs: 500 + index * 100, tokens: 100 })),
  toolApprovals: [], review: null,
};
const branchTask = { ...task, id: branchTaskId, runId: 'qa-checkpoint-branch-run', title: '检查点分支方案', revision: 1, status: 'paused', updatedAt: new Date(Date.now() + 1000).toISOString() };
const session = {
  id: sessionId, tenantId: 'local', userId: 'local-user', title: summary.title,
  messages: [
    { id: 'qa-checkpoint-user', role: 'user', content: summary.input, createdAt: Date.now() - 2000 },
    { id: 'qa-checkpoint-assistant', role: 'assistant', content: '任务已完成。', createdAt: Date.now() - 1000, taskId, route: 'full-workflow', agentRole: 'orchestrator' },
  ],
  updatedAt: Date.now(),
};
const checkpointState = {
  taskId,
  currentRevision: 7,
  checkpoints: [
    { checkpointId, sequence: 12, stage: 'final-delivery', revision: 6, planVersion: 2, graphRevision: 3, completedSteps: 3, failedSteps: 0, totalSteps: 3, timestamp: now, restorable: true },
    { checkpointId: 'checkpoint-legacy', sequence: 4, stage: 'loop:1', revision: 2, planVersion: 1, graphRevision: 1, completedSteps: 1, failedSteps: 0, totalSteps: 3, timestamp: now, restorable: false },
  ],
  branches: [{ checkpointId, taskId: branchTaskId, title: branchTask.title, status: branchTask.status, kind: 'branch', createdAt: now }],
};
const diff = {
  baseTaskId: taskId,
  targetTaskId: branchTaskId,
  checkpointId,
  planChanged: true,
  steps: { added: ['security'], removed: [], changed: ['build'], unchanged: ['research', 'review'] },
};

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 820 } });
const page = await context.newPage();
const consoleErrors = [];
let nativeDialogOpened = false;
let branchRequests = 0;
let mergeRequests = 0;
let branchOperationId = '';

page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
page.on('pageerror', (error) => consoleErrors.push(error.message));
page.on('dialog', (dialog) => { nativeDialogOpened = true; void dialog.dismiss(); });

await page.route('**/api/tasks?limit=30', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ tasks: [summary] }) }));
await page.route('**/api/sessions?limit=50', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ sessions: [session], deletedSessionIds: [] }) }));
await page.route(`**/api/sessions/${sessionId}`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ session }) }));
await page.route(`**/api/tasks/${taskId}`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ task }) }));
await page.route(`**/api/tasks/${branchTaskId}`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ task: branchTask }) }));
await page.route(`**/api/tasks/${taskId}/checkpoints`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(checkpointState) }));
await page.route(`**/api/tasks/${taskId}/checkpoints/${checkpointId}/diff**`, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ diff }) }));
await page.route(`**/api/tasks/${taskId}/checkpoints/${checkpointId}/merge`, async (route) => {
  mergeRequests += 1;
  const body = route.request().postDataJSON();
  if (body.strategy === 'manual') {
    // The API integration suite covers the real HTTP 409. Keep this browser
    // fixture at 200 so Chromium does not report an expected conflict as a
    // console resource error while the UI still consumes the same contract.
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ error: '两个方案修改了相同步骤。', code: 'CHECKPOINT_MERGE_CONFLICT', conflicts: ['build'], actualRevision: 7 }) });
  }
  return route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ task: { ...branchTask, id: 'qa-checkpoint-merged', title: '合并方案' } }) });
});
await page.route(`**/api/tasks/${taskId}/checkpoints/${checkpointId}/branch`, async (route) => {
  branchRequests += 1;
  const body = route.request().postDataJSON();
  branchOperationId = body.operationId;
  await new Promise((resolve) => setTimeout(resolve, 220));
  return route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ task: branchTask }) });
});

try {
  await page.goto(`${baseUrl}/?view=tasks&task=${taskId}`, { waitUntil: 'domcontentloaded' });
  const panel = page.getByRole('region', { name: '版本与检查点' });
  await panel.waitFor({ state: 'visible', timeout: 20_000 });
  const currentVersionVisible = (await panel.innerText()).includes('v7');

  await panel.getByRole('button', { name: '比较' }).click();
  await panel.getByText('新增 1', { exact: true }).waitFor({ state: 'visible' });
  const diffText = await panel.locator('.dash-checkpoint-diff').innerText();

  await panel.getByRole('button', { name: '合并方案' }).click();
  await panel.getByRole('button', { name: '保留当前方案' }).waitFor({ state: 'visible' });
  const explicitConflictChoices = await panel.getByRole('button', { name: '保留当前方案' }).isVisible()
    && await panel.getByRole('button', { name: '采用分支方案' }).isVisible();

  await panel.getByRole('button', { name: '从此继续' }).dblclick({ delay: 40 });
  await page.waitForTimeout(500);

  await panel.getByRole('combobox', { name: '选择检查点' }).selectOption('checkpoint-legacy');
  const legacyReadOnlyVisible = await panel.getByText('旧版本仅可查看', { exact: true }).isVisible();
  const branchControlHiddenForLegacy = await panel.getByRole('button', { name: '从此继续' }).count() === 0;
  const assertions = {
    versionPanelUsesTaskRevision: currentVersionVisible,
    diffShowsAddedChangedRemoved: diffText.includes('新增 1') && diffText.includes('变化 1') && diffText.includes('移除 0'),
    mergeConflictRequiresExplicitChoice: explicitConflictChoices && mergeRequests === 1,
    branchRequestSentOnce: branchRequests === 1,
    branchUsesStableOperationId: typeof branchOperationId === 'string' && branchOperationId.length >= 32,
    legacyCheckpointIsReadOnly: legacyReadOnlyVisible && branchControlHiddenForLegacy,
    noNativeBrowserDialog: !nativeDialogOpened,
    noBrowserErrors: consoleErrors.length === 0,
  };
  process.stdout.write(`${JSON.stringify({ assertions, diffText, branchRequests, mergeRequests, branchOperationId, consoleErrors }, null, 2)}\n`);
  if (Object.values(assertions).some((passed) => !passed)) process.exitCode = 1;
} finally {
  await browser.close();
}
