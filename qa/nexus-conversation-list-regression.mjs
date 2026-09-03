import { chromium } from '@playwright/test';
import { testAndPublishNexus } from './nexus-release-helper.mjs';

const baseUrl = process.env.QA_URL ?? 'http://127.0.0.1:4300';
const stamp = Date.now();
const workflowName = `Nexus List Regression ${stamp}`;
const headers = {
  'Content-Type': 'application/json',
  'x-axiom-tenant-id': `qa-nexus-list-${stamp}`,
  'x-axiom-user-id': 'qa-nexus-list-owner',
};
const canvas = {
  schemaVersion: 1,
  nodes: [
    { id: 'input', type: 'input', name: 'input', position: { x: 0, y: 120 } },
    {
      id: 'agent', type: 'agent', name: 'analyst', position: { x: 240, y: 120 },
      agentRef: { source: 'builtin', id: 'analyst' }, objective: 'Answer the input clearly.',
      acceptanceCriteria: ['Answer the input'], toolNames: [], maxTokens: 1024, failureStrategy: 'retry',
    },
    { id: 'output', type: 'output', name: 'output', position: { x: 500, y: 120 } },
  ],
  edges: [
    { id: 'e1', source: 'input', target: 'agent', kind: 'flow' },
    { id: 'e2', source: 'agent', target: 'output', kind: 'flow' },
  ],
  scopedAgents: [],
};

const readJson = async (response, label) => {
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${label} (${response.status}): ${body?.error ?? 'unknown error'}`);
  return body;
};

let workflowId = null;
let taskId = null;
const browser = await chromium.launch({ headless: true });

try {
  const created = await readJson(await fetch(`${baseUrl}/api/workflows`, {
    method: 'POST', headers,
    body: JSON.stringify({ name: workflowName, description: 'conversation projection regression', visibility: 'private', canvas }),
  }), 'create workflow');
  workflowId = created.workflow.id;

  await testAndPublishNexus({
    baseUrl,
    workflowId,
    headers,
    testName: '会话隔离发布验收',
    input: 'Please reply: nexus release gate works.',
  });

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, extraHTTPHeaders: headers });
  const page = await context.newPage();
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await page.locator('.dash-nav-rail button[aria-label="Agent Nexus"]').click();
  const savedWorkflow = page.locator('.workflow-saved-list button').first();
  await savedWorkflow.waitFor({ state: 'visible', timeout: 10_000 });
  await savedWorkflow.click();

  const runResponse = page.waitForResponse((response) => response.request().method() === 'POST' && response.url().includes(`/workflows/${workflowId}/run`));
  await page.locator('.workflow-runner footer textarea').fill('Please reply: nexus list sync works.');
  await page.locator('.workflow-runner footer button').click();
  const runHttpResponse = await runResponse;
  const runBody = await readJson(runHttpResponse, 'run published workflow');
  taskId = runBody.task.id;

  const deadline = Date.now() + 120_000;
  let status = 'queued';
  let lastTask = null;
  let reviewApproved = false;
  while (Date.now() < deadline && !['completed', 'failed', 'cancelled'].includes(status)) {
    const response = await fetch(`${baseUrl}/api/tasks/${encodeURIComponent(taskId)}`, { headers });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`read workflow task (${response.status}): ${body?.error ?? 'unknown error'}`);
    lastTask = body?.task ?? lastTask;
    status = lastTask?.status ?? status;
    if (status === 'waiting_for_human' && lastTask?.review && !reviewApproved) {
      await readJson(await fetch(`${baseUrl}/api/tasks/${encodeURIComponent(taskId)}/approve-review`, {
        method: 'POST', headers, body: JSON.stringify({ note: '自动化会话隔离回归已核对结果。' }),
      }), 'approve workflow review');
      reviewApproved = true;
    }
    if (!['completed', 'failed', 'cancelled'].includes(status)) await new Promise((resolve) => setTimeout(resolve, 350));
  }
  if (!['completed', 'failed', 'cancelled'].includes(status)) throw new Error(`workflow did not reach a terminal state; last status: ${status}`);
  await page.waitForTimeout(500);

  const taskResponse = await fetch(`${baseUrl}/api/tasks/${encodeURIComponent(taskId)}`, { headers });
  const taskBody = await taskResponse.json().catch(() => null);
  await page.locator('.dash-nav-rail button:nth-of-type(4)').click();
  await page.waitForTimeout(700);
  const listCount = await page.locator('.dash-chat-session-item').filter({ hasText: workflowName }).count();
  await page.locator('.dash-nav-rail button[aria-label="Agent Nexus"]').click();
  await page.locator('.workflow-runner-messages article').nth(1).waitFor({ state: 'visible', timeout: 15_000 });
  const nexusHistoryCount = await page.locator('.workflow-runner-messages article').count();
  const assertions = {
    absentFromRecentConversations: listCount === 0,
    taskRemainsAvailable: taskResponse.ok && ['completed', 'failed', 'cancelled'].includes(taskBody?.task?.status),
    nexusHistoryContainsOnlyConversation: nexusHistoryCount === 2,
  };
  console.log(JSON.stringify({ assertions, taskId, status, nexusHistoryCount }, null, 2));
  if (Object.values(assertions).some((passed) => !passed)) process.exitCode = 1;
  await context.close();
} finally {
  await browser.close();
  if (taskId) await fetch(`${baseUrl}/api/tasks/${encodeURIComponent(taskId)}`, { method: 'DELETE', headers }).catch(() => undefined);
  if (workflowId) await fetch(`${baseUrl}/api/workflows/${encodeURIComponent(workflowId)}`, { method: 'DELETE', headers }).catch(() => undefined);
}
