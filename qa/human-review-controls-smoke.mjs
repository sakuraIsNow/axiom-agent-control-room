import { chromium } from '@playwright/test';
import { resolve } from 'node:path';

const baseUrl = process.env.QA_URL ?? 'http://127.0.0.1:4300';
const now = new Date().toISOString();
const taskId = 'qa-human-review-task';
const sessionId = 'qa-human-review-session';
const profile = {
  kind: 'implementation',
  difficulty: 'complex',
  route: 'full-workflow',
  score: 88,
  reasons: ['multiple constraints', 'system-level scope', 'operational constraints'],
  maxSteps: 6,
  requiresReview: true,
};
const review = {
  approved: false,
  score: 75,
  summary: 'Reviewer returned an unstructured response; manual verification is required.',
  gaps: [
    'Evidence tree lacks concrete artifacts for steps 1-5 (e.g., actual plan, research report, analysis report, draft deliverable, review report)',
    'Step 6 and 7 claim implementation but no code snippets or test results are provided',
  ],
  requiredCorrections: [
    'Provide concrete evidence artifacts for each step, such as actual plan JSON, research report, analysis report, draft deliverable, review report, and final response',
  ],
};
const summary = {
  id: taskId,
  runId: 'qa-human-review-run',
  sessionId,
  userId: 'qa-human-review',
  title: '人工审核界面回归任务',
  input: '验证待审核任务的人工审批入口。',
  mode: 'build',
  model: 'qa-model',
  status: 'waiting_for_human',
  profile,
  cancelRequested: false,
  createdAt: now,
  updatedAt: now,
  currentStage: 'quality-gate',
  durationMs: 4200,
  tokens: { prompt: 900, completion: 360, total: 1260 },
  estimatedCostUsd: 0.01,
  modelCalls: 3,
  queueWaitMs: 20,
  attempts: 1,
  toolCalls: 0,
  completedSteps: 2,
  totalSteps: 2,
  reviewScore: review.score,
  pendingToolApprovals: 0,
};
const task = {
  id: taskId,
  runId: summary.runId,
  sessionId,
  title: summary.title,
  input: summary.input,
  mode: summary.mode,
  model: summary.model,
  status: summary.status,
  plan: {
    summary: '完成实现后进入人工质量确认。',
    routingReason: '复杂任务需要质量门禁。',
    profile,
    steps: [],
    graph: {
      nodes: [
        { id: 'orchestrator', role: 'orchestrator', title: '调度 Agent', dependsOn: [], status: 'running' },
        { id: 'research', stepId: 'research', agentId: 'researcher-qa', role: 'researcher', title: '检索 Agent', dependsOn: ['orchestrator'], status: 'completed' },
        { id: 'review', stepId: 'review', agentId: 'reviewer', role: 'reviewer', title: '审查 Agent', dependsOn: ['research'], status: 'completed' },
      ],
      edges: [
        { from: 'orchestrator', to: 'research', kind: 'delegation' },
        { from: 'research', to: 'review', kind: 'review' },
      ],
    },
    version: 1,
    approvalStatus: 'approved',
  },
  stepResults: [{
    stepId: 'review',
    agentId: 'reviewer',
    role: 'reviewer',
    status: 'completed',
    output: review.summary,
    evidence: [],
    confidence: 0.86,
    attempts: 1,
    durationMs: 800,
    tokens: 260,
  }],
  toolApprovals: [],
  review,
  createdAt: now,
  updatedAt: now,
};
const session = {
  id: sessionId,
  tenantId: 'local',
  userId: 'local-user',
  title: summary.title,
  messages: [
    { id: 'qa-user-message', role: 'user', content: summary.input, createdAt: Date.now() - 2_000 },
    { id: 'qa-assistant-message', role: 'assistant', content: `审查 Agent 已完成质量检查（${review.score}/100），当前结果需要你确认。`, createdAt: Date.now() - 1_000, taskId, route: 'full-workflow', agentRole: 'orchestrator' },
  ],
  updatedAt: Date.now(),
};

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 720 } });
await context.addInitScript(() => {
  try {
    localStorage.setItem('axiom-ui-language-v1', 'zh-CN');
  } catch {
    // Sandboxed previews intentionally cannot access origin storage.
  }
});
const page = await context.newPage();
const consoleErrors = [];
const failedResponses = [];
let nativeDialogOpened = false;
let reviewMutationRequests = 0;

page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
page.on('pageerror', (error) => consoleErrors.push(error.message));
page.on('response', async (response) => {
  if (response.status() < 500) return;
  const body = await response.text().catch(() => '');
  failedResponses.push({
    method: response.request().method(),
    status: response.status(),
    url: response.url(),
    body: body.slice(0, 500),
  });
});
page.on('dialog', (dialog) => { nativeDialogOpened = true; void dialog.dismiss(); });
page.on('request', (request) => {
  if (request.method() === 'POST' && /\/(approve|reject)-review$/u.test(request.url())) reviewMutationRequests += 1;
});

await page.route('**/api/tasks?limit=30', async (route) => {
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ tasks: [summary] }) });
});
await page.route(`**/api/tasks/${taskId}/checkpoints`, async (route) => {
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ taskId, currentRevision: 1, checkpoints: [], branches: [] }),
  });
});
await page.route(`**/api/tasks/${taskId}`, async (route) => {
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ task }) });
});
await page.route(`**/api/capabilities/tasks/${taskId}/actions`, async (route) => {
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ actions: [] }) });
});
await page.route('**/api/sessions?limit=50', async (route) => {
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ sessions: [session], deletedSessionIds: [] }) });
});
await page.route(`**/api/sessions/${sessionId}`, async (route) => {
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ session }) });
});

try {
  await page.goto(`${baseUrl}/?view=chat&session=${sessionId}`, { waitUntil: 'networkidle' });
  const chatControls = page.getByTestId('chat-human-review-controls');
  await chatControls.waitFor({ state: 'visible', timeout: 20_000 });
  const chatControlsVisible = await chatControls.isVisible();
  await page.waitForFunction(() => document.querySelectorAll('.dash-agent-signal-node').length === 3, undefined, { timeout: 20_000 });
  const initialGraphNodeCount = await page.locator('.dash-agent-signal-node').count();
  const chatNote = chatControls.getByRole('textbox', { name: '审核意见' });
  await chatNote.fill('QA：从对话直接补充整改要求。');
  await chatControls.getByRole('button', { name: '按当前结果交付' }).click();
  const chatApproveDialog = page.getByTestId('review-confirm-dialog');
  await chatApproveDialog.waitFor({ state: 'visible' });
  const chatApproveCopyCorrect = await chatApproveDialog.getByText('确认按当前结果交付？', { exact: true }).count() === 1;
  await chatApproveDialog.getByRole('button', { name: '取消' }).click();
  await chatControls.getByRole('button', { name: '继续整改' }).click();
  const chatReviseDialog = page.getByTestId('review-confirm-dialog');
  await chatReviseDialog.waitFor({ state: 'visible' });
  const chatReviseCopyCorrect = await chatReviseDialog.getByText('确认让 Agent 重新整改？', { exact: true }).count() === 1;
  await chatReviseDialog.getByRole('button', { name: '取消' }).click();

  await page.getByRole('button', { name: '任务管理', exact: true }).click();
  const controls = page.getByTestId('human-review-controls');
  await controls.waitFor({ state: 'visible', timeout: 20_000 });

  const note = controls.getByRole('textbox', { name: '审核意见' });
  await note.fill('QA：确认审批入口可用，但不提交真实操作。');
  const noteUsable = await note.inputValue() === 'QA：确认审批入口可用，但不提交真实操作。';
  const panelStyle = await page.locator('.dash-detail-panel').evaluate((element) => {
    const style = getComputedStyle(element);
    return { overflowY: style.overflowY, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight };
  });
  const detailText = await page.locator('.dash-detail-panel').innerText();
  const rightPanelChinese = detailText.includes('实现任务')
    && detailText.includes('完整工作流')
    && detailText.includes('复杂')
    && detailText.includes('包含多项约束')
    && detailText.includes('步骤 1 至 5 的证据树缺少具体产物')
    && detailText.includes('为每个步骤提供具体证据产物')
    && !/(?:implementation|full-workflow|complex|multiple constraints|system-level scope|operational constraints|Evidence tree lacks|Step 6 and 7 claim|Provide concrete evidence)/iu.test(detailText);
  const detailPanel = page.locator('.dash-detail-panel');
  await detailPanel.hover();
  await page.mouse.wheel(0, 420);
  await page.waitForTimeout(120);
  const panelScrollTop = await detailPanel.evaluate((element) => element.scrollTop);
  const controlsStyle = await controls.evaluate((element) => {
    const style = getComputedStyle(element);
    const panel = element.closest('.dash-detail-panel')?.getBoundingClientRect();
    const bounds = element.getBoundingClientRect();
    return {
      position: style.position,
      visibleInPanel: Boolean(panel) && bounds.top >= panel.top - 1 && bounds.bottom <= panel.bottom + 1,
    };
  });
  await page.screenshot({ path: resolve(process.cwd(), 'qa', 'dashboard-human-review.png'), fullPage: false });

  await controls.getByRole('button', { name: '批准交付' }).click();
  const approveDialog = page.getByTestId('review-confirm-dialog');
  await approveDialog.waitFor({ state: 'visible' });
  const approveCopyCorrect = await approveDialog.getByText('确认按当前结果交付？', { exact: true }).count() === 1;
  await approveDialog.getByRole('button', { name: '取消' }).click();

  await controls.getByRole('button', { name: '驳回并整改' }).click();
  const rejectDialog = page.getByTestId('review-confirm-dialog');
  await rejectDialog.waitFor({ state: 'visible' });
  const rejectCopyCorrect = await rejectDialog.getByText('确认让 Agent 重新整改？', { exact: true }).count() === 1;
  await page.waitForTimeout(240);
  await page.screenshot({ path: resolve(process.cwd(), 'qa', 'dashboard-human-review-confirm.png'), fullPage: false });
  await rejectDialog.getByRole('button', { name: '取消' }).click();

  const assertions = {
    initialConversationGraphRestoredWithoutSessionClick: initialGraphNodeCount === 3,
    chatHumanReviewControlsVisible: chatControlsVisible,
    chatReviewConfirmationWorks: chatApproveCopyCorrect && chatReviseCopyCorrect,
    humanReviewControlsVisible: await controls.isVisible(),
    reviewNoteUsable: noteUsable,
    rightPanelUsesChinesePresentation: rightPanelChinese,
    rightDetailPanelScrollable: ['auto', 'scroll'].includes(panelStyle.overflowY)
      && panelStyle.scrollHeight > panelStyle.clientHeight
      && panelScrollTop > 0,
    reviewActionsSticky: controlsStyle.position === 'sticky' && controlsStyle.visibleInPanel,
    approveConfirmationWorks: approveCopyCorrect,
    rejectConfirmationWorks: rejectCopyCorrect,
    cancellingDoesNotMutateTask: reviewMutationRequests === 0,
    noNativeBrowserDialog: !nativeDialogOpened,
    noBrowserErrors: consoleErrors.length === 0,
  };
  process.stdout.write(`${JSON.stringify({ assertions, panelStyle: { ...panelStyle, scrollTop: panelScrollTop }, controlsStyle, consoleErrors, failedResponses }, null, 2)}\n`);
  if (Object.values(assertions).some((passed) => !passed)) process.exitCode = 1;
} finally {
  await browser.close();
}
