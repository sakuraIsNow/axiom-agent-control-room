import { chromium } from '@playwright/test';
import { testAndPublishNexus } from './nexus-release-helper.mjs';

const baseUrl = process.env.QA_URL ?? 'http://127.0.0.1:4300';
const stamp = Date.now();
const headers = {
  'Content-Type': 'application/json',
  'x-axiom-tenant-id': `qa-workflow-history-${stamp}`,
  'x-axiom-user-id': 'qa-workflow-history-owner',
};

const canvas = {
  schemaVersion: 1,
  nodes: [
    { id: 'input', type: 'input', name: '输入', position: { x: 0, y: 120 } },
    {
      id: 'agent', type: 'agent', name: '分析 Agent', position: { x: 240, y: 120 },
      agentRef: { source: 'builtin', id: 'analyst' }, objective: '回答用户输入并给出清晰结论。',
      acceptanceCriteria: ['回应用户问题'], toolNames: [], maxTokens: 1024, failureStrategy: 'retry',
    },
    { id: 'output', type: 'output', name: '输出', position: { x: 500, y: 120 } },
  ],
  edges: [
    { id: 'e1', source: 'input', target: 'agent', kind: 'flow' },
    { id: 'e2', source: 'agent', target: 'output', kind: 'flow' },
  ],
  scopedAgents: [],
};

const json = async (response, label) => {
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${label} (${response.status}): ${body?.error ?? 'unknown error'}`);
  return body;
};

const readEvents = async (url) => {
  const response = await fetch(url, { headers: { ...headers, Accept: 'text/event-stream' }, signal: AbortSignal.timeout(180_000) });
  if (!response.ok || !response.body) throw new Error(`SSE 连接失败 (${response.status})`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const events = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf('\n\n');
      const eventName = block.split(/\r?\n/).find((line) => line.startsWith('event:'))?.slice(6).trim();
      const data = block.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('');
      if (eventName === 'runtime' && data) events.push(JSON.parse(data));
    }
  }
  return events;
};

let workflowId;
let taskId;
try {
  workflowId = (await json(await fetch(`${baseUrl}/api/workflows`, {
    method: 'POST', headers,
    body: JSON.stringify({ name: `历史恢复回归 ${stamp}`, description: '验证 Agent Nexus 对话恢复', visibility: 'private', canvas }),
  }), '创建 Nexus 失败')).workflow.id;
  await testAndPublishNexus({
    baseUrl,
    workflowId,
    headers,
    testName: '历史恢复发布验收',
    input: '请回复：历史恢复发布验收通过。',
  });
  const run = await json(await fetch(`${baseUrl}/api/workflows/${workflowId}/run`, {
    method: 'POST', headers,
    body: JSON.stringify({ sessionId: `agent-nexus-${workflowId}`, input: '请回复：历史恢复成功。' }),
  }), '启动 Nexus 失败');
  taskId = run.task.id;
  await readEvents(`${baseUrl}${run.eventsUrl}`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, extraHTTPHeaders: headers });
  await context.addInitScript(() => {
    try {
      localStorage.setItem('axiom-ui-language-v1', 'zh-CN');
    } catch {
      // Sandboxed previews intentionally cannot access origin storage.
    }
  });
  const page = await context.newPage();
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Agent Nexus', exact: true }).click();
  await page.locator('.dash-workflow-studio').waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForTimeout(350);
  const firstVisit = await page.locator('.workflow-runner-messages article').count();
  await page.getByRole('button', { name: '对话', exact: true }).click();
  await page.getByRole('button', { name: 'Agent Nexus', exact: true }).click();
  await page.locator('.dash-workflow-studio').waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForTimeout(350);
  const restoredText = await page.locator('.workflow-runner-messages').innerText();
  const secondVisit = await page.locator('.workflow-runner-messages article').count();
  const assertions = {
    firstVisitShowsOnlyConversationHistory: firstVisit === 2,
    historySurvivesWorkspaceSwitch: secondVisit === 2,
    restoredInputVisible: restoredText.includes('历史恢复成功'),
  };
  console.log(JSON.stringify({ assertions, firstVisit, secondVisit }, null, 2));
  await browser.close();
  if (Object.values(assertions).some((passed) => !passed)) process.exitCode = 1;
} finally {
  if (taskId) await fetch(`${baseUrl}/api/tasks/${taskId}`, { method: 'DELETE', headers }).catch(() => undefined);
  if (workflowId) await fetch(`${baseUrl}/api/workflows/${workflowId}`, { method: 'DELETE', headers }).catch(() => undefined);
}
