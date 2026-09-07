import assert from 'node:assert/strict';
import test from 'node:test';
import { createTaskApi } from './taskApi.js';
import { SqliteTaskStore } from './sqliteTaskStore.js';
import { SqliteToolExecutionStore } from './toolExecutionStore.js';
import { ToolRegistry } from './toolRegistry.js';
import { EventHub } from './eventHub.js';
import { signPrincipal } from './principal.js';

const fixture = async () => {
  let now = Date.now();
  let nudges = 0;
  const store = new SqliteTaskStore(':memory:');
  const ledger = new SqliteToolExecutionStore(':memory:', () => now);
  await store.initialize();
  await ledger.initialize();
  const tools = new ToolRegistry(undefined, undefined, undefined, undefined, ledger);
  const api = createTaskApi({ store, toolRegistry: tools, hub: new EventHub(), coordinator: { nudge() { nudges += 1; }, abort() {} } as never });
  const created = await store.createTask({ tenantId: 'tenant', userId: 'user', sessionId: 'session', title: 'Recovery', input: 'Bounded recovery', mode: 'build' });
  const task = await store.updateTask(created.id, { status: 'waiting_for_human' });
  await store.appendEvent(task, { type: 'task.paused', payload: { reason: 'tool-outcome-review' } });
  const claimed = await ledger.claim({ tenantId: task.tenantId, taskId: task.id, runId: task.runId, stepId: 'step', invocationId: 'call', signature: 'signature', toolName: 'workspace.write', sideEffect: 'write', callId: 'call', auditId: 'audit', workerId: 'worker', leaseMs: 100 });
  const send = (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => api.request(new Request(`http://test/tasks/${task.id}/tools${path}`, {
    method, headers: { 'content-type': 'application/json', 'x-axiom-tenant-id': 'tenant', 'x-axiom-user-id': 'user', ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }));
  return { api, store, ledger, task, record: claimed.record, send, nudges: () => nudges, expire: () => { now += 101; }, close: async () => { await store.close(); await ledger.close(); } };
};

test('recovery API reconciles a dead worker, requires evidence, and never resumes implicitly', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.send('/resume', 'POST')).status, 409);
    f.expire();
    const listed = await (await f.send('/executions')).json();
    assert.equal(listed.executions[0].status, 'outcome_unknown');
    assert.equal(listed.canResume, false);
    assert.equal(JSON.stringify(listed).includes('leaseToken'), false);
    assert.equal(JSON.stringify(listed).includes('signature'), false);
    const path = `/executions/${f.record.id}/resolve`;
    const revision = listed.executions[0].revision;
    assert.equal((await f.send(path, 'POST', { expectedRevision: revision, decision: 'confirmed-completed', note: '' })).status, 400);
    assert.equal((await f.send(path, 'POST', { expectedRevision: revision - 1, decision: 'confirmed-completed', note: 'Checked actual file' })).status, 409);
    assert.equal((await f.send(path, 'POST', { expectedRevision: revision, decision: 'confirmed-completed', note: 'Checked actual file' })).status, 200);
    assert.equal((await f.store.getTask(f.task.id))?.status, 'waiting_for_human');
    assert.equal(f.nudges(), 0);
    assert.equal((await f.ledger.get('tenant', f.record.id))?.receipt, undefined, 'Human acceptance must not invent a tool receipt');
    assert.equal((await (await f.send('/executions')).json()).canResume, true);
    assert.equal((await f.send('/resume', 'POST')).status, 202);
    assert.equal(f.nudges(), 1);
    assert.equal((await f.send('/resume', 'POST')).status, 409);
  } finally { await f.close(); }
});

test('recovery cannot bypass another owner, tenant, viewer role, or pending approval', async () => {
  const f = await fixture();
  const previousSecret = process.env.AXIOM_PRINCIPAL_SECRET;
  process.env.AXIOM_PRINCIPAL_SECRET = 'recovery-test-only-secret';
  try {
    assert.equal((await f.send('/executions', 'GET', undefined, { 'x-axiom-user-id': 'someone-else' })).status, 404);
    assert.equal((await f.send('/executions', 'GET', undefined, { 'x-axiom-tenant-id': 'other' })).status, 404);
    const signed = signPrincipal({ tenantId: 'tenant', userId: 'user', role: 'viewer' }).split('.');
    const viewer = { 'x-axiom-principal': signed[0]!, 'x-axiom-principal-signature': signed[1]! };
    assert.equal((await f.send('/resume', 'POST', {}, viewer)).status, 403);
    assert.equal((await f.send(`/executions/${f.record.id}/resolve`, 'POST', {}, viewer)).status, 403);
    f.expire();
    const record = (await (await f.send('/executions')).json()).executions[0];
    assert.equal((await f.send(`/executions/${record.id}/resolve`, 'POST', { expectedRevision: record.revision, decision: 'confirmed-not-executed', note: 'External system has no write' })).status, 200);
    await f.store.updateTask(f.task.id, { toolApprovals: [{ id: 'approval', stepId: 'other-step', name: 'workspace.write', args: {}, risk: 'high', signature: 'other', status: 'pending', requestedAt: new Date().toISOString() }] });
    assert.equal((await (await f.send('/executions')).json()).canResume, false);
    assert.equal((await f.send('/resume', 'POST')).status, 409);
    assert.equal(f.nudges(), 0);
  } finally {
    if (previousSecret === undefined) delete process.env.AXIOM_PRINCIPAL_SECRET;
    else process.env.AXIOM_PRINCIPAL_SECRET = previousSecret;
    await f.close();
  }
});

test('expired reads become safely retryable while recent unexpired invocations stay blocked', async () => {
  const f = await fixture();
  try {
    await f.ledger.releaseUnstarted({ tenantId: 'tenant', id: f.record.id, leaseToken: f.record.leaseToken! });
    const read = await f.ledger.claim({ tenantId: 'tenant', taskId: f.task.id, runId: f.task.runId, stepId: 'read', invocationId: 'read', signature: 'read', toolName: 'workspace.read', sideEffect: 'read-only', callId: 'read-call', auditId: 'read-audit', workerId: 'dead', leaseMs: 100 });
    assert.equal((await f.send('/resume', 'POST')).status, 409);
    f.expire();
    assert.equal((await f.send('/resume', 'POST')).status, 202);
    assert.equal((await f.ledger.get('tenant', read.record.id))?.status, 'retryable');
    assert.equal(await f.ledger.renew({ tenantId: 'tenant', id: read.record.id, leaseToken: read.record.leaseToken! }), false);
  } finally { await f.close(); }
});

test('cancelled tasks can settle uncertain outcomes without restarting cancelled work', async () => {
  const f = await fixture();
  try {
    f.expire();
    await f.store.updateTask(f.task.id, { status: 'cancelled', cancelRequested: true });
    const record = (await (await f.send('/executions')).json()).executions[0];
    const response = await f.send(`/executions/${record.id}/resolve`, 'POST', { expectedRevision: record.revision, decision: 'confirmed-not-executed', note: 'The destination confirms no action took place' });
    assert.equal(response.status, 200);
    assert.equal((await f.store.getTask(f.task.id))?.status, 'cancelled');
    assert.equal((await f.send('/resume', 'POST')).status, 409);
    assert.equal(f.nudges(), 0);
  } finally { await f.close(); }
});

test('alternative restart and replanning controls cannot bypass unresolved tool outcomes', async () => {
  const f = await fixture();
  try {
    for (const suffix of ['resume', 'retry', 'replan', 'approve-plan', 'approve-review', 'approve-tool', 'reject-review', 'reject-tool', 'harness/start', 'harness/resume', 'nodes/step/rerun', 'nodes/step/replace', 'nodes/step/complete', 'checkpoints/checkpoint/branch', 'checkpoints/checkpoint/merge', 'guidance']) {
      const response = await f.api.request(new Request(`http://test/tasks/${f.task.id}/${suffix}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-axiom-tenant-id': 'tenant', 'x-axiom-user-id': 'user' }, body: JSON.stringify({ behavior: 'replan' }) }));
      assert.equal(response.status, 409, suffix);
      assert.equal((await response.json()).code, 'TOOL_OUTCOME_REVIEW_REQUIRED', suffix);
    }
    assert.equal(f.nudges(), 0);
  } finally { await f.close(); }
});

test('malformed task IDs are rejected before reaching a PostgreSQL UUID column', async () => {
  const f = await fixture();
  try {
    f.store.getTask = async () => { throw new Error('Invalid ID reached storage'); };
    for (const [path, method] of [['tools/executions', 'GET'], ['tools/executions/id/resolve', 'POST'], ['tools/resume', 'POST'], ['resume', 'POST']]) {
      const response = await f.api.request(new Request(`http://test/tasks/not-a-uuid/${path}`, { method }));
      assert.equal(response.status, 404, path);
    }
  } finally { await f.close(); }
});
