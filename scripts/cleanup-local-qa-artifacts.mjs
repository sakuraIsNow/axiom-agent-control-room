const apiOrigin = process.env.AXIOM_API_ORIGIN || 'http://127.0.0.1:8787';
const localHeaders = { 'x-axiom-tenant-id': 'local', 'x-axiom-user-id': 'local-user' };
const apply = process.argv.includes('--apply');
const terminalStatuses = new Set(['completed', 'failed', 'cancelled']);

const exactQaTitles = new Set([
  '请用一句话确认当前对话可以实时返回。',
  '请比较 PostgreSQL 与 SQLite 在多 worker 部署中的风险和取舍',
  '请设计一个生产级多 worker 数据迁移工作流，包含依赖、失败恢复、验证和回滚策略',
  '跨端口恢复验证',
  'Production workflow smoke test',
  'diag test',
  'orbit test',
  '比较 PostgreSQL 和 SQLite 在多 Worker A',
  'Compare PostgreSQL and SQLite for',
  'Compare PostgreSQL and SQLite for multi-worker deployment, including risks, cost, and recovery trade-offs.',
  'say hello in one word',
  'Design a production multi-agent wo',
  'Design a production multi-agent workflow with database migration, queue recovery, dependency graph, acceptance criteria, and observability.',
  '用三点简要说明一个可靠 Agent 服务最重要的工程边界。',
  'ç¨ä¸ç¹ç®è¦è¯´æä¸ä¸ªå¯é  Agent æå¡æéè¦çå·¥ç¨è¾¹çã',
  'Token check',
  'PG smoke',
  'graph-loop-check',
]);
const qaId = /^(?:qa-|diag-|smoke-|orbit-)/i;
const qaTitle = /^(?:QA task delete|QA data isolation)\b/i;
const qaTitlePrefixes = [
  '请比较 PostgreSQL 与 SQLite 在多 worker',
  '请设计一个生产级多 worker 数据迁移工作流',
];
const userTurnPattern = /(?:^|\n\n)USER:\s*([\s\S]*?)(?=\n\n(?:ASSISTANT|USER):|$)/gi;
const latestUserInput = (input = '') => [...input.matchAll(userTurnPattern)].at(-1)?.[1]?.trim() || input.trim();
const isQaText = (value = '') => {
  const normalized = value.trim();
  return exactQaTitles.has(normalized) || qaTitle.test(normalized) || qaTitlePrefixes.some((prefix) => normalized.startsWith(prefix));
};

const request = async (path, init = {}) => {
  const response = await fetch(`${apiOrigin}${path}`, {
    ...init,
    headers: { ...localHeaders, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(15_000),
  });
  const body = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path} returned ${response.status}: ${body?.error ?? 'unknown error'}`);
  return body;
};

const [sessionBody, taskBody] = await Promise.all([
  request('/api/sessions?limit=100'),
  request('/api/tasks?limit=100'),
]);
const sessions = sessionBody.sessions ?? [];
const tasks = taskBody.tasks ?? [];
const taskDetails = [];
for (const summary of tasks) {
  const detail = await request(`/api/tasks/${encodeURIComponent(summary.id)}`).catch(() => null);
  taskDetails.push(detail?.task ?? summary);
}
const isQaSessionIdentity = (session) => {
  const empty = (session.messages?.length ?? 0) === 0 && !session.activeTaskId;
  return empty || qaId.test(session.id) || isQaText(session.title);
};
const sessionCandidates = sessions.filter(isQaSessionIdentity);
const candidateSessionIds = new Set(sessionCandidates.map((session) => session.id));
const taskCandidates = taskDetails.filter((task) => candidateSessionIds.has(task.sessionId)
  || qaId.test(task.sessionId)
  || isQaText(task.title)
  || isQaText(latestUserInput(task.input)));
const candidateTaskIds = new Set(taskCandidates.map((task) => task.id));
const sessionRepairs = sessions
  .filter((session) => !candidateSessionIds.has(session.id)
    && session.messages?.some((message) => message.role === 'user' && isQaText(message.content)))
  .map((session) => {
    const keptMessages = [];
    let skipAssistant = false;
    for (const message of session.messages ?? []) {
      if (message.role === 'user') {
        skipAssistant = isQaText(message.content);
        if (!skipAssistant) keptMessages.push(message);
      } else if (!skipAssistant) {
        keptMessages.push({ ...message, pending: false });
      }
    }
    const sourceTasks = taskDetails
      .filter((task) => task.sessionId === session.id && !candidateTaskIds.has(task.id) && task.result)
      .sort((left, right) => new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime());
    const restoredMessages = keptMessages.length > 0 ? keptMessages : sourceTasks.flatMap((task) => {
      const route = task.plan?.profile?.route ?? 'workflow';
      return [
        { id: `restored-${task.id}-user`, role: 'user', content: latestUserInput(task.input), createdAt: new Date(task.createdAt).getTime() },
        { id: `restored-${task.id}-assistant`, role: 'assistant', content: task.result, createdAt: new Date(task.updatedAt).getTime(), pending: false, taskId: task.id, route, agentRole: route === 'direct' ? 'direct-responder' : 'orchestrator' },
      ];
    });
    return {
      ...session,
      messages: restoredMessages,
      activeTaskId: undefined,
      activeAssistantId: undefined,
      updatedAt: Math.max(session.updatedAt, ...restoredMessages.map((message) => message.createdAt)),
      removedMessages: (session.messages?.length ?? 0) - keptMessages.length,
      sourceTaskIds: sourceTasks.map((task) => task.id),
    };
  });

const report = {
  mode: apply ? 'apply' : 'dry-run',
  sessions: sessionCandidates.map((session) => ({ id: session.id, title: session.title, messages: session.messages?.length ?? 0 })),
  tasks: taskCandidates.map((task) => ({ id: task.id, sessionId: task.sessionId, title: task.title, status: task.status })),
  repairs: sessionRepairs.map((session) => ({
    id: session.id,
    title: session.title,
    removedMessages: session.removedMessages,
    restoredMessages: session.messages.length,
    sourceTaskIds: session.sourceTaskIds,
  })),
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

if (!apply) {
  process.stdout.write('Dry run only. Re-run with --apply after reviewing the candidates.\n');
  process.exit(0);
}

let removedTasks = 0;
for (const task of taskCandidates) {
  let status = task.status;
  if (!terminalStatuses.has(status)) {
    if (status === 'paused') {
      const resumed = await request(`/api/tasks/${encodeURIComponent(task.id)}/resume`, { method: 'POST' }).catch(() => null);
      status = resumed?.task?.status ?? status;
    }
    await fetch(`${apiOrigin}/api/tasks/${encodeURIComponent(task.id)}/cancel`, { method: 'POST', headers: localHeaders }).catch(() => undefined);
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const current = await request(`/api/tasks/${encodeURIComponent(task.id)}`).catch(() => null);
      status = current?.task?.status ?? status;
      if (terminalStatuses.has(status)) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  if (terminalStatuses.has(status)) {
    await request(`/api/tasks/${encodeURIComponent(task.id)}`, { method: 'DELETE' });
    if (!await request(`/api/tasks/${encodeURIComponent(task.id)}`).catch(() => null)) removedTasks += 1;
  }
}
let removedSessions = 0;
for (const session of sessionCandidates) {
  await request(`/api/sessions/${encodeURIComponent(session.id)}`, { method: 'DELETE' });
  removedSessions += 1;
}
for (const session of sessionRepairs) {
  await request(`/api/sessions/${encodeURIComponent(session.id)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: session.id,
      title: session.title,
      messages: session.messages,
      updatedAt: session.updatedAt,
    }),
  });
}
process.stdout.write(`${JSON.stringify({ removedSessions, removedTasks, repairedSessions: sessionRepairs.length }, null, 2)}\n`);
