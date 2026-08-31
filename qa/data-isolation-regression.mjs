const apiOrigin = process.env.AXIOM_API_ORIGIN || 'http://127.0.0.1:8787';
const localHeaders = { 'x-axiom-tenant-id': 'local', 'x-axiom-user-id': 'local-user' };
const qaHeaders = { 'x-axiom-tenant-id': 'qa-data-isolation', 'x-axiom-user-id': 'qa-data-isolation' };
const sessionId = `qa-data-isolation-${Date.now()}`;
let taskId = null;

const request = async (path, headers, init = {}) => {
  const response = await fetch(`${apiOrigin}${path}`, {
    ...init,
    headers: { ...headers, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(15_000),
  });
  const body = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${init.method ?? 'GET'} ${path} returned ${response.status}: ${body?.error ?? 'unknown error'}`);
  return body;
};

const localSnapshot = async () => {
  const [sessions, tasks] = await Promise.all([
    request('/api/sessions?limit=100', localHeaders),
    request('/api/tasks?limit=100', localHeaders),
  ]);
  return {
    sessions: (sessions.sessions ?? []).map((session) => session.id).sort(),
    tasks: (tasks.tasks ?? []).map((task) => task.id).sort(),
  };
};

const before = await localSnapshot();
try {
  await request(`/api/sessions/${encodeURIComponent(sessionId)}`, qaHeaders, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: sessionId,
      title: 'QA data isolation',
      messages: [{ id: `${sessionId}-user`, role: 'user', content: 'isolated', createdAt: Date.now() }],
      updatedAt: Date.now(),
    }),
  });
  const created = await request('/api/tasks', qaHeaders, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, title: 'QA data isolation', input: 'say isolated', mode: 'analyze' }),
  });
  taskId = created.task?.id ?? null;

  const after = await localSnapshot();
  if (JSON.stringify(after) !== JSON.stringify(before)) {
    throw new Error('QA principal changed the local/local-user task or session namespace.');
  }
  process.stdout.write(`${JSON.stringify({ ok: true, localSessions: before.sessions.length, localTasks: before.tasks.length, qaSessionId: sessionId, qaTaskId: taskId }, null, 2)}\n`);
} finally {
  if (taskId) {
    await fetch(`${apiOrigin}/api/tasks/${encodeURIComponent(taskId)}/cancel`, { method: 'POST', headers: qaHeaders }).catch(() => undefined);
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const response = await fetch(`${apiOrigin}/api/tasks/${encodeURIComponent(taskId)}`, { headers: qaHeaders }).catch(() => null);
      const body = await response?.json().catch(() => null);
      if (!response?.ok) break;
      if (['completed', 'failed', 'cancelled'].includes(body?.task?.status)) {
        await fetch(`${apiOrigin}/api/tasks/${encodeURIComponent(taskId)}`, { method: 'DELETE', headers: qaHeaders }).catch(() => undefined);
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  await fetch(`${apiOrigin}/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE', headers: qaHeaders }).catch(() => undefined);
}
