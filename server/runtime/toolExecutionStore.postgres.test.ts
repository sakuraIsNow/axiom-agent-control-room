import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import { PostgresToolExecutionStore, type ToolExecutionClaimInput, type ToolExecutionRecord } from './toolExecutionStore.js';
import type { ToolExecution } from './toolRegistry.js';

const connectionString = process.env.AXIOM_TEST_DATABASE_URL?.trim();
const options = { skip: connectionString ? false : 'AXIOM_TEST_DATABASE_URL is not configured.', timeout: 20_000 };
const input = (tenantId: string, overrides: Partial<ToolExecutionClaimInput> = {}): ToolExecutionClaimInput => ({
  tenantId, taskId: 'tool-task', runId: 'run', stepId: 'step', invocationId: 'call-one', signature: 'signature',
  toolName: 'workspace.read', sideEffect: 'read-only', callId: randomUUID(), auditId: randomUUID(), workerId: 'worker-1', leaseMs: 30_000, ...overrides,
});
const owner = (record: ToolExecutionRecord) => ({ tenantId: record.tenantId, id: record.id, leaseToken: record.leaseToken! });
const receipt = (record: ToolExecutionRecord): ToolExecution => ({
  call: { id: record.callId, name: record.toolName, args: {} }, output: 'durable result', stderr: '', exitCode: 0,
  auditId: record.auditId, signature: record.signature, durationMs: 1, risk: 'low',
});
const expire = (pool: Pool, record: ToolExecutionRecord) => pool.query(`UPDATE tool_execution_ledger SET payload_json=jsonb_set(payload_json::jsonb,'{leaseUntil}',to_jsonb('2000-01-01T00:00:00.000Z'::text))::text WHERE tenant_id=$1 AND id=$2`, [record.tenantId, record.id]);

test('PostgreSQL tool ledger serializes workers and restores the same receipt after reconnecting', options, async () => {
  const tenantId = `tool-ledger-pg-${randomUUID()}`;
  const first = new PostgresToolExecutionStore(connectionString!);
  const second = new PostgresToolExecutionStore(connectionString!);
  const pool = new Pool({ connectionString, max: 1 });
  let reopened: PostgresToolExecutionStore | undefined;
  try {
    await Promise.all([first.initialize(), second.initialize()]);
    const request = input(tenantId);
    const claims = await Promise.all([first.claim(request), second.claim({ ...request, workerId: 'worker-2' })]);
    assert.deepEqual(claims.map((claim) => claim.kind).sort(), ['claimed', 'pending']);
    const record = claims.find((claim) => claim.kind === 'claimed')!.record;
    assert.equal(await second.complete(owner(record), receipt(record)), true);
    await first.close();
    reopened = new PostgresToolExecutionStore(connectionString!);
    const replay = await reopened.claim(request);
    assert.equal(replay.kind, 'replay');
    assert.deepEqual(replay.record.receipt, receipt(record));
    assert.equal((await reopened.claim({ ...request, invocationId: 'deliberate-repeat' })).kind, 'claimed');
    assert.equal(await reopened.get('wrong-tenant', record.id), null);
    assert.deepEqual(await reopened.listForTask('wrong-tenant', request.taskId), []);
  } finally {
    try { await pool.query('DELETE FROM tool_execution_ledger WHERE tenant_id=$1', [tenantId]); }
    finally { await Promise.all([reopened ? reopened.close() : first.close(), second.close(), pool.end()]); }
  }
});

test('PostgreSQL expired writes block replay, while expired reads reject all old-owner outcomes', options, async () => {
  const tenantId = `tool-ledger-fence-pg-${randomUUID()}`;
  const first = new PostgresToolExecutionStore(connectionString!);
  const second = new PostgresToolExecutionStore(connectionString!);
  const pool = new Pool({ connectionString, max: 1 });
  try {
    await Promise.all([first.initialize(), second.initialize()]);
    const request = input(tenantId);
    const original = (await first.claim(request)).record;
    await expire(pool, original);
    const replacement = await second.claim(request);
    assert.equal(replacement.kind, 'claimed');
    assert.equal(await first.complete(owner(original), receipt(original)), false);
    assert.equal(await first.renew(owner(original)), false);
    assert.equal(await first.markUnknown(owner(original), 'old failure'), false);
    assert.equal(await first.releaseUnstarted(owner(original)), false);
    assert.equal(await second.complete(owner(replacement.record), receipt(replacement.record)), true);
    const writeRequest = input(tenantId, { invocationId: 'write', sideEffect: 'write' });
    const write = (await first.claim(writeRequest)).record;
    await expire(pool, write);
    const unknown = await second.claim(writeRequest);
    assert.equal(unknown.kind, 'outcome_unknown');
    assert.equal(unknown.record.attempts, 1);
    const resolution = { tenantId, id: write.id, expectedRevision: unknown.record.revision, operatorId: 'reviewer', decision: 'confirmed-completed' as const, note: 'Verified the operation in destination audit.' };
    const resolved = await Promise.all([first.resolveUnknown(resolution), second.resolveUnknown(resolution)]);
    assert.equal(resolved.filter(Boolean).length, 1);
    const replay = await first.claim(writeRequest);
    assert.equal(replay.kind, 'replay');
    assert.equal(replay.record.receipt, undefined);
    assert.equal(replay.record.receiptSource, 'human-confirmed');
  } finally {
    try { await pool.query('DELETE FROM tool_execution_ledger WHERE tenant_id=$1', [tenantId]); }
    finally { await Promise.all([first.close(), second.close(), pool.end()]); }
  }
});

test('PostgreSQL lease completion and renewal use time after a blocking row lock', options, async () => {
  const tenantId = `tool-ledger-clock-pg-${randomUUID()}`;
  const store = new PostgresToolExecutionStore(connectionString!);
  const pool = new Pool({ connectionString, max: 2 });
  const blocker = await pool.connect();
  let pending: Promise<boolean> | undefined;
  try {
    await store.initialize();
    for (const operation of ['renew', 'complete'] as const) {
      const record = (await store.claim(input(tenantId, { invocationId: operation, leaseMs: 100 }))).record;
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM tool_execution_ledger WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [tenantId, record.id]);
      pending = operation === 'renew' ? store.renew(owner(record)) : store.complete(owner(record), receipt(record));
      await new Promise((resolve) => setTimeout(resolve, 200));
      await blocker.query('COMMIT');
      assert.equal(await pending, false, `${operation} must not accept a lease that expired while waiting`);
      pending = undefined;
    }
  } finally {
    await blocker.query('ROLLBACK');
    blocker.release();
    await pending;
    try { await pool.query('DELETE FROM tool_execution_ledger WHERE tenant_id=$1', [tenantId]); }
    finally { await Promise.all([store.close(), pool.end()]); }
  }
});

test('PostgreSQL reconciliation fences expired owners and exposes reviewable writes without affecting other tenants', options, async () => {
  const tenantId = `tool-ledger-reconcile-pg-${randomUUID()}`;
  const first = new PostgresToolExecutionStore(connectionString!);
  const second = new PostgresToolExecutionStore(connectionString!);
  const pool = new Pool({ connectionString, max: 1 });
  try {
    await Promise.all([first.initialize(), second.initialize()]);
    const read = (await first.claim(input(tenantId))).record;
    const write = (await first.claim(input(tenantId, { invocationId: 'write', sideEffect: 'write' }))).record;
    assert.equal(await second.reconcileExpiredForTask(tenantId, 'tool-task'), 0);
    await expire(pool, read);
    await expire(pool, write);
    assert.equal(await second.reconcileExpiredForTask('wrong-tenant', 'tool-task'), 0);
    const reconciled = await Promise.all([first.reconcileExpiredForTask(tenantId, 'tool-task'), second.reconcileExpiredForTask(tenantId, 'tool-task')]);
    assert.equal(reconciled.reduce((sum, count) => sum + count, 0), 2);
    assert.equal((await first.get(tenantId, read.id))?.status, 'retryable');
    assert.equal((await first.get(tenantId, write.id))?.status, 'outcome_unknown');
    assert.equal(await first.complete(owner(read), receipt(read)), false);
    assert.equal(await first.complete(owner(write), receipt(write)), false);
    assert.equal(await first.hasUnresolvedForTask(tenantId, 'tool-task'), true);
    for (let index = 0; index < 201; index += 1) {
      const completed = (await first.claim(input(tenantId, { invocationId: `recent-${index}` }))).record;
      await first.complete(owner(completed), receipt(completed));
    }
    assert.equal((await second.listForTask(tenantId, 'tool-task', 200))[0]?.id, write.id, 'old unknown writes stay reachable ahead of completed history');
    const unknown = (await first.get(tenantId, write.id))!;
    await second.resolveUnknown({ tenantId, id: write.id, expectedRevision: unknown.revision, operatorId: 'reviewer', decision: 'confirmed-completed', note: 'Verified the destination record.' });
    assert.equal(await first.hasUnresolvedForTask(tenantId, 'tool-task'), false);
  } finally {
    try { await pool.query('DELETE FROM tool_execution_ledger WHERE tenant_id=$1', [tenantId]); }
    finally { await Promise.all([first.close(), second.close(), pool.end()]); }
  }
});
