import assert from 'node:assert/strict';
import test from 'node:test';
import { createTaskApi } from './taskApi.js';
import { SqliteTaskStore } from './sqliteTaskStore.js';
import { EventHub } from './eventHub.js';

const fixture = async () => {
  const store = new SqliteTaskStore(':memory:'); await store.initialize();
  const hub = new EventHub(); let nudges = 0;
  const api = createTaskApi({ store, hub, artifactStore: null, coordinator: { nudge() { nudges += 1; }, abort() {} } as never });
  const created = await store.createTask({ tenantId: 'tenant', userId: 'user', sessionId: 'session', title: 'Review', input: 'Action', mode: 'build' });
  const task = await store.updateTask(created.id, { status: 'waiting_for_human', toolApprovals: ['one', 'two'].map((id) => ({ id, name: 'workspace.write', stepId: id, args: {}, signature: id, risk: 'high', status: 'pending', requestedAt: new Date().toISOString() })) });
  const send = (path: string, body: object, user = 'user') => api.request(`/tasks/${task.id}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-axiom-tenant-id': 'tenant', 'x-axiom-user-id': user }, body: JSON.stringify(body) });
  return { store, hub, api, task, send, nudges: () => nudges };
};

test('parallel pending approvals require fresh revisions and only the last accepted action queues the task', async () => {
  const f = await fixture();
  try {
    const snapshot = await f.api.request(`/tasks/${f.task.id}`, { headers: { 'x-axiom-tenant-id': 'tenant', 'x-axiom-user-id': 'user' } });
    assert.equal((await snapshot.json()).actionPermissions.canManage, true);
    const other = await f.api.request(`/tasks/${f.task.id}`, { headers: { 'x-axiom-tenant-id': 'tenant', 'x-axiom-user-id': 'other-user' } });
    assert.equal((await other.json()).actionPermissions.canManage, false);
    assert.equal((await f.send('approve-tool', { approvalId: 'one', expectedRevision: f.task.revision }, 'other-user')).status, 403);
    const one = await f.send('approve-tool', { approvalId: 'one', expectedRevision: f.task.revision });
    assert.equal(one.status, 202);
    const first = (await one.json()).task;
    assert.equal(first.status, 'waiting_for_human'); assert.equal(f.nudges(), 0);
    const stale = await f.send('approve-tool', { approvalId: 'two', expectedRevision: f.task.revision });
    assert.equal(stale.status, 409); assert.equal((await stale.json()).code, 'TASK_REVISION_CONFLICT');
    const two = await f.send('approve-tool', { approvalId: 'two', expectedRevision: first.revision });
    assert.equal(two.status, 202); assert.equal((await two.json()).task.status, 'queued'); assert.equal(f.nudges(), 1);
    assert.equal((await f.send('approve-tool', { approvalId: 'two' })).status, 409);
  } finally { await f.store.close(); }
});

test('pending quality review cannot be bypassed through tool approval or generic resume', async () => {
  const f = await fixture();
  try {
    const waiting = await f.store.updateTask(f.task.id, { toolApprovals: [], review: { approved: false, score: 40, summary: 'Review required', gaps: [], requiredCorrections: [] } });
    assert.equal((await f.send('approve-review', { expectedRevision: waiting.revision }, 'other-user')).status, 403);
    const paused = await f.store.updateTask(f.task.id, { status: 'paused' });
    assert.equal((await f.send('resume', { expectedRevision: paused.revision })).status, 409);
    assert.equal((await f.send('approve-review', { expectedRevision: paused.revision, note: 'Reviewed sources while paused' })).status, 202);
  } finally { await f.store.close(); }
});

test('SSE replay of an old pause keeps the resumed task connected and delivers its later completion', async () => {
  const f = await fixture();
  const controller = new AbortController();
  try {
    await f.store.appendEvent(f.task, { type: 'task.paused', payload: { reason: 'operator' } });
    const running = await f.store.updateTask(f.task.id, { status: 'running', toolApprovals: [] });
    const response = await f.api.request(`/tasks/${f.task.id}/events`, { headers: { 'x-axiom-tenant-id': 'tenant' }, signal: controller.signal });
    const body = response.text();
    await new Promise((resolveWait) => setTimeout(resolveWait, 60));
    const completed = await f.store.updateTask(running.id, { status: 'completed', result: 'Finished' });
    f.hub.publish(await f.store.appendEvent(completed, { type: 'task.completed', payload: { result: 'Finished' } }));
    const content = await body;
    assert.match(content, /task\.paused/); assert.match(content, /task\.completed/);
  } finally { controller.abort(); await f.store.close(); }
});

test('approving the last parallel call does not implicitly override another rejection, but explicit replanning supersedes it', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.send('reject-tool', { approvalId: 'one', expectedRevision: f.task.revision, note: 'Do not write this file' })).status, 202);
    const waiting = (await f.store.getTask(f.task.id))!;
    const second = await f.send('approve-tool', { approvalId: 'two', expectedRevision: waiting.revision });
    assert.equal(second.status, 202); const paused = (await second.json()).task;
    assert.equal(paused.status, 'paused'); assert.equal(f.nudges(), 0);
    const replan = await f.send('replan', { expectedRevision: paused.revision, instruction: 'Choose a different read-only approach', preserveCompleted: true });
    assert.equal(replan.status, 202);
    const next = await f.store.updateTask(f.task.id, { status: 'waiting_for_human', toolApprovals: [...paused.toolApprovals, { id: 'new', stepId: 'new-step', signature: 'new', name: 'workspace.write', args: {}, risk: 'high', status: 'pending', requestedAt: new Date().toISOString() }] });
    const accepted = await f.send('approve-tool', { approvalId: 'new', expectedRevision: next.revision });
    assert.equal(accepted.status, 202); assert.equal((await accepted.json()).task.status, 'queued');
  } finally { await f.store.close(); }
});

test('an update between middleware validation and handler read cannot approve a changed task', async () => {
  const f = await fixture();
  const originalGet = f.store.getTask.bind(f.store); let reads = 0;
  try {
    f.store.getTask = async (...args) => {
      reads += 1;
      if (reads === 2) await f.store.updateTask(f.task.id, { error: 'New operator guidance' });
      return originalGet(...args);
    };
    const response = await f.send('approve-tool', { expectedRevision: f.task.revision, approvalId: 'one' });
    assert.equal(response.status, 409);
    assert.equal((await originalGet(f.task.id))?.toolApprovals?.[0].status, 'pending');
    assert.equal(f.nudges(), 0);
  } finally { await f.store.close(); }
});
