import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { PostgresTaskStore } from './postgresTaskStore.js';

test('PostgreSQL stores and reloads object tool approvals as JSONB', async (t) => {
  const connectionString = process.env.AXIOM_TEST_DATABASE_URL?.trim();
  if (!connectionString) {
    t.skip('AXIOM_TEST_DATABASE_URL is not configured.');
    return;
  }
  const store = new PostgresTaskStore(connectionString);
  const tenantId = `jsonb-regression-${randomUUID()}`;
  await store.initialize();
  let taskId = '';
  try {
    const created = await store.createTask({
      tenantId,
      userId: 'jsonb-regression-user',
      sessionId: randomUUID(),
      title: 'JSONB approval regression',
      input: 'Persist an approval list.',
      mode: 'build',
    });
    taskId = created.id;
    const approval = {
      id: randomUUID(),
      name: 'workspace.write',
      stepId: 'step-jsonb',
      args: { path: 'output.html', content: '<svg><path d="M0 0" /></svg>' },
      signature: randomUUID(),
      risk: 'high' as const,
      status: 'pending' as const,
      requestedAt: new Date().toISOString(),
    };
    const updated = await store.updateTask(taskId, { status: 'waiting_for_human', toolApprovals: [approval] }, created.revision);
    assert.deepEqual(updated.toolApprovals, [approval]);
    assert.deepEqual((await store.getTask(taskId, tenantId))?.toolApprovals, [approval]);
    const approved = { ...approval, status: 'approved' as const, decidedBy: 'jsonb-regression-user', decidedAt: new Date().toISOString() };
    const resumed = await store.updateTask(taskId, { status: 'queued', toolApprovals: [approved] }, updated.revision);
    assert.deepEqual((await store.getTask(taskId, tenantId))?.toolApprovals, [approved]);
    const cleared = await store.updateTask(taskId, { toolApprovals: [] }, resumed.revision);
    assert.deepEqual((await store.getTask(taskId, tenantId))?.toolApprovals, []);
    await store.updateTask(taskId, { toolApprovals: null }, cleared.revision);
    assert.equal((await store.getTask(taskId, tenantId))?.toolApprovals, undefined);
  } finally {
    if (taskId) await store.deleteTask(taskId, tenantId).catch(() => undefined);
    await store.close();
  }
});
