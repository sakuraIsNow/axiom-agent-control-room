const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const responseJson = async (response, label) => {
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${label} (${response.status}): ${body?.error ?? 'unknown error'}`);
  return body;
};

const waitForTask = async ({ baseUrl, headers, taskId, timeoutMs }) => {
  const deadline = Date.now() + timeoutMs;
  let lastTask = null;
  let reviewApproved = false;
  while (Date.now() < deadline) {
    const body = await responseJson(
      await fetch(`${baseUrl}/api/tasks/${encodeURIComponent(taskId)}`, { headers }),
      `读取 Nexus 测试任务 ${taskId}`,
    );
    lastTask = body.task;
    if (lastTask.status === 'waiting_for_human' && lastTask.review && !reviewApproved) {
      await responseJson(await fetch(`${baseUrl}/api/tasks/${encodeURIComponent(taskId)}/approve-review`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ note: '自动化发布门禁已核对测试结果。' }),
      }), `批准 Nexus 测试任务 ${taskId}`);
      reviewApproved = true;
    }
    if (['completed', 'failed', 'cancelled'].includes(lastTask.status)) return lastTask;
    await delay(350);
  }
  throw new Error(`Nexus 测试任务 ${taskId} 未在 ${timeoutMs}ms 内结束，最后状态：${lastTask?.status ?? 'unknown'}`);
};

export const testAndPublishNexus = async ({
  baseUrl,
  workflowId,
  headers,
  testName = '自动化发布验收',
  input = '请简洁回复：Nexus 发布验收通过。',
  timeoutMs = 180_000,
}) => {
  await responseJson(await fetch(`${baseUrl}/api/capabilities/nexus/${encodeURIComponent(workflowId)}/tests`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: testName, input, expectedIncludes: [] }),
  }), '创建 Nexus 测试用例');

  const testRun = await responseJson(await fetch(`${baseUrl}/api/capabilities/nexus/${encodeURIComponent(workflowId)}/test-run`, {
    method: 'POST',
    headers,
  }), '启动 Nexus 测试');
  if (!Array.isArray(testRun.runs) || testRun.runs.length === 0) throw new Error('Nexus 测试没有生成任何运行任务。');

  const tasks = [];
  for (const run of testRun.runs) {
    const task = await waitForTask({ baseUrl, headers, taskId: run.taskId, timeoutMs });
    tasks.push(task);
    if (task.status !== 'completed') {
      throw new Error(`Nexus 测试任务 ${task.id} 未完成：${task.status} ${task.error ?? ''}`.trim());
    }
  }

  const deadline = Date.now() + 15_000;
  let reconciledRuns = [];
  while (Date.now() < deadline) {
    const body = await responseJson(
      await fetch(`${baseUrl}/api/capabilities/nexus/${encodeURIComponent(workflowId)}/test-runs`, { headers }),
      '读取 Nexus 测试结果',
    );
    reconciledRuns = body.runs.filter((run) => testRun.runs.some((candidate) => candidate.id === run.id));
    if (reconciledRuns.length === testRun.runs.length && reconciledRuns.every((run) => run.status !== 'running')) break;
    await delay(200);
  }
  if (reconciledRuns.length !== testRun.runs.length || reconciledRuns.some((run) => run.status !== 'passed')) {
    throw new Error(`Nexus 发布测试未全部通过：${reconciledRuns.map((run) => `${run.id}:${run.status}`).join(', ') || '无结果'}`);
  }

  const published = await responseJson(await fetch(`${baseUrl}/api/capabilities/nexus/${encodeURIComponent(workflowId)}/releases`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ note: '自动化生产门禁固定版本' }),
  }), '发布 Nexus 固定版本');
  return { release: published.release, testRuns: reconciledRuns, tasks };
};
