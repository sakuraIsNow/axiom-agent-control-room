const baseUrl = process.env.QA_URL ?? 'http://127.0.0.1:4300';
const stamp = Date.now();
const headers = {
  'Content-Type': 'application/json',
  'x-axiom-tenant-id': `qa-workflow-${stamp}`,
  'x-axiom-user-id': 'qa-workflow-owner',
};

let workflowId = null;
let taskId = null;

const json = async (response, label) => {
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${label} (${response.status}): ${body?.error ?? 'unknown error'}`);
  return body;
};

const canvas = {
  schemaVersion: 1,
  nodes: [
    { id: 'input', type: 'input', name: '输入', position: { x: 0, y: 120 } },
    {
      id: 'analyze', type: 'agent', name: '计算分析', position: { x: 240, y: 120 },
      agentRef: { source: 'builtin', id: 'analyst' }, objective: '独立计算用户给出的算式并说明校验过程。',
      acceptanceCriteria: ['给出明确数值', '说明校验过程'], toolNames: [], maxTokens: 1024, failureStrategy: 'retry',
    },
    {
      id: 'verify', type: 'agent', name: '结果复核', position: { x: 500, y: 120 },
      agentRef: { source: 'builtin', id: 'reviewer' }, objective: '复核上游计算结果；若上一轮已正确，保持结论一致。',
      acceptanceCriteria: ['复核数值与计算过程'], toolNames: [], maxTokens: 1024, failureStrategy: 'retry',
    },
    { id: 'output', type: 'output', name: '输出', position: { x: 780, y: 120 } },
  ],
  edges: [
    { id: 'e1', source: 'input', target: 'analyze', kind: 'flow' },
    { id: 'e2', source: 'analyze', target: 'verify', kind: 'flow' },
    { id: 'e3', source: 'verify', target: 'output', kind: 'flow' },
    { id: 'loop-check', source: 'verify', target: 'analyze', kind: 'loop', maxIterations: 2 },
  ],
  scopedAgents: [],
};

const readEvents = async (url) => {
  const response = await fetch(url, { headers: { ...headers, Accept: 'text/event-stream' }, signal: AbortSignal.timeout(180_000) });
  if (!response.ok || !response.body) throw new Error(`SSE 连接失败 (${response.status})`);
  const events = [];
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
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

try {
  const created = await json(await fetch(`${baseUrl}/api/workflows`, {
    method: 'POST', headers,
    body: JSON.stringify({ name: `Loop 在线烟测 ${stamp}`, description: '验证真实工作流调度、SSE 与检查点', visibility: 'private', canvas }),
  }), '创建工作流失败');
  workflowId = created.workflow.id;

  const run = await json(await fetch(`${baseUrl}/api/workflows/${encodeURIComponent(workflowId)}/run`, {
    method: 'POST', headers,
    body: JSON.stringify({ sessionId: `qa-workflow-session-${stamp}`, input: '请计算 12 + 30，并复核结果。' }),
  }), '启动工作流失败');
  taskId = run.task.id;
  const events = await readEvents(`${baseUrl}${run.eventsUrl}`);
  const task = (await json(await fetch(`${baseUrl}/api/tasks/${encodeURIComponent(taskId)}`, { headers }), '读取任务失败')).task;
  const workflowLoopIterations = events.filter((event) => event.type === 'loop.iteration' && event.payload?.scope === 'workflow-loop');
  const startedSteps = events.filter((event) => event.type === 'agent.started').map((event) => event.payload?.stepId);
  const assertions = {
    taskCompleted: task.status === 'completed',
    deterministicPlanUsed: task.plan?.profile?.route === 'full-workflow' && task.plan?.steps?.length === 4,
    boundedLoopExecuted: workflowLoopIterations.length === 2 && workflowLoopIterations.at(-1)?.payload?.maxIterations === 2,
    everyUnrolledStepStarted: ['analyze', 'verify', 'analyze-loop-2', 'verify-loop-2'].every((stepId) => startedSteps.includes(stepId)),
    checkpointsPersisted: events.filter((event) => event.type === 'checkpoint.saved').length >= 4,
    graphUpdatedFromRuntime: events.some((event) => event.type === 'graph.updated' && event.payload?.reason === 'checkpoint'),
    finalOutputPresent: typeof task.result === 'string' && task.result.trim().length > 0,
    sseReachedTerminal: events.some((event) => event.type === 'task.completed'),
  };
  process.stdout.write(`${JSON.stringify({ assertions, workflowId, taskId, eventCount: events.length, startedSteps, loopIterations: workflowLoopIterations.map((event) => event.payload?.iteration), resultPreview: task.result?.slice(0, 240) }, null, 2)}\n`);
  if (Object.values(assertions).some((passed) => !passed)) process.exitCode = 1;
} finally {
  if (taskId) {
    const response = await fetch(`${baseUrl}/api/tasks/${encodeURIComponent(taskId)}`, { headers }).catch(() => null);
    const task = await response?.json().catch(() => null);
    if (!['completed', 'failed', 'cancelled'].includes(task?.task?.status)) {
      await fetch(`${baseUrl}/api/tasks/${encodeURIComponent(taskId)}/cancel`, { method: 'POST', headers }).catch(() => undefined);
    }
    await fetch(`${baseUrl}/api/tasks/${encodeURIComponent(taskId)}`, { method: 'DELETE', headers }).catch(() => undefined);
  }
  if (workflowId) await fetch(`${baseUrl}/api/workflows/${encodeURIComponent(workflowId)}`, { method: 'DELETE', headers }).catch(() => undefined);
}
