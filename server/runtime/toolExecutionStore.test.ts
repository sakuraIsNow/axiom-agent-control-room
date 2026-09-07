import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolExecution } from './toolRegistry.js';
import { SqliteToolExecutionStore, ToolExecutionIdentityConflictError, type ToolExecutionClaimInput, type ToolExecutionRecord } from './toolExecutionStore.js';

const input = (overrides: Partial<ToolExecutionClaimInput> = {}): ToolExecutionClaimInput => ({
  tenantId: 'tenant', taskId: 'task', runId: 'run', stepId: 'step', invocationId: 'logical-call-1',
  signature: 'args-signature', toolName: 'workspace.read', sideEffect: 'read-only',
  callId: 'call-1', auditId: 'audit-1', workerId: 'worker-1', leaseMs: 1_000, ...overrides,
});
const owner = (record: ToolExecutionRecord) => ({ tenantId: record.tenantId, id: record.id, leaseToken: record.leaseToken! });
const receipt = (record: ToolExecutionRecord): ToolExecution => ({
  call: { id: record.callId, name: record.toolName, args: {} }, output: 'verified tool output', stderr: '', exitCode: 0,
  durationMs: 10, auditId: record.auditId, signature: record.signature, risk: 'low',
});

test('SQLite invocation claims serialize across instances and replay durable receipts after reopening', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'axiom-tool-ledger-'));
  const path = join(directory, 'ledger.sqlite');
  const first = new SqliteToolExecutionStore(path);
  const second = new SqliteToolExecutionStore(path);
  let reopened: SqliteToolExecutionStore | undefined;
  try {
    await first.initialize();
    await second.initialize();
    const claims = await Promise.all([first.claim(input()), second.claim(input({ workerId: 'worker-2' }))]);
    assert.deepEqual(claims.map((claim) => claim.kind), ['claimed', 'pending']);
    const record = claims[0]!.record;
    assert.equal(await first.complete(owner(record), receipt(record)), true);
    assert.equal((await second.claim(input())).kind, 'replay');
    await first.close();
    await second.close();
    reopened = new SqliteToolExecutionStore(path);
    await reopened.initialize();
    const restored = await reopened.claim(input());
    assert.equal(restored.kind, 'replay');
    assert.deepEqual(restored.record.receipt, receipt(record));
    assert.equal(restored.record.attempts, 1);
    assert.equal((await reopened.claim(input({ invocationId: 'intentional-repeat' }))).kind, 'claimed');
    assert.equal((await reopened.claim(input({ runId: 'next-turn' }))).kind, 'claimed');
    assert.equal(await reopened.get('other-tenant', record.id), null);
    assert.deepEqual(await reopened.listForTask('other-tenant', 'task'), []);
  } finally {
    if (reopened) await reopened.close();
    else { await first.close().catch(() => undefined); await second.close().catch(() => undefined); }
    await rm(directory, { recursive: true, force: true });
  }
});

test('one logical invocation cannot be rebound to changed arguments, tool, or side effects', async () => {
  const store = new SqliteToolExecutionStore(':memory:');
  try {
    await store.initialize();
    await store.claim(input());
    for (const change of [{ signature: 'different' }, { toolName: 'workspace.write' }, { sideEffect: 'write' as const }]) {
      await assert.rejects(store.claim(input(change)), ToolExecutionIdentityConflictError);
    }
  } finally { await store.close(); }
});

test('read-only recovery fences the expired owner and bounds repeated crash recovery', async () => {
  let now = Date.now();
  const store = new SqliteToolExecutionStore(':memory:', () => now);
  try {
    await store.initialize();
    const original = (await store.claim(input())).record;
    now += 1_001;
    assert.equal(await store.renew(owner(original)), false);
    assert.equal(await store.complete(owner(original), receipt(original)), false);
    const replacement = await store.claim(input({ workerId: 'worker-2' }));
    assert.equal(replacement.kind, 'claimed');
    assert.notEqual(replacement.record.leaseToken, original.leaseToken);
    assert.equal(await store.markUnknown(owner(original), 'late failure'), false);
    assert.equal(await store.releaseUnstarted(owner(original)), false);
    now += 1_001;
    assert.equal((await store.claim(input())).kind, 'claimed');
    now += 1_001;
    assert.equal((await store.claim(input())).kind, 'outcome_unknown');
    assert.equal((await store.get('tenant', original.id))?.attempts, 3);
  } finally { await store.close(); }
});

test('expired writes remain unknown until a revision-checked human decision, without inventing a receipt', async () => {
  let now = Date.now();
  const store = new SqliteToolExecutionStore(':memory:', () => now);
  try {
    await store.initialize();
    const writeInput = input({ toolName: 'agent.propose', sideEffect: 'write' });
    const original = (await store.claim(writeInput)).record;
    now += 1_001;
    const unknown = await store.claim(writeInput);
    assert.equal(unknown.kind, 'outcome_unknown');
    assert.equal(unknown.record.attempts, 1);
    assert.equal(await store.complete(owner(original), receipt(original)), false);
    const resolution = { tenantId: 'tenant', id: original.id, expectedRevision: unknown.record.revision, operatorId: 'reviewer', decision: 'confirmed-completed' as const, note: 'Verified the existing draft in the destination system.' };
    assert.equal(await store.resolveUnknown({ ...resolution, tenantId: 'other-tenant' }), null);
    assert.equal(await store.resolveUnknown({ ...resolution, expectedRevision: original.revision }), null);
    await assert.rejects(store.resolveUnknown({ ...resolution, note: '' }), /verified/);
    const resolved = await store.resolveUnknown(resolution);
    assert.equal(resolved?.receipt, undefined);
    assert.equal(resolved?.receiptSource, 'human-confirmed');
    assert.equal(resolved?.resolutions[0]?.operatorId, 'reviewer');
    assert.equal((await store.claim(writeInput)).kind, 'replay');
    assert.equal(await store.resolveUnknown(resolution), null);
  } finally { await store.close(); }
});

test('verified non-execution permits the same invocation to retry and preserves review history', async () => {
  const store = new SqliteToolExecutionStore(':memory:');
  try {
    await store.initialize();
    const writeInput = input({ sideEffect: 'write' });
    const original = (await store.claim(writeInput)).record;
    assert.equal(await store.markUnknown(owner(original), 'Connection lost after dispatch.'), true);
    const unknown = (await store.get('tenant', original.id))!;
    assert.equal((await store.claim(writeInput)).kind, 'outcome_unknown');
    await store.resolveUnknown({ tenantId: 'tenant', id: original.id, expectedRevision: unknown.revision, operatorId: 'reviewer', decision: 'confirmed-not-executed', note: 'Destination audit confirms no operation was accepted.' });
    const retried = await store.claim(writeInput);
    assert.equal(retried.kind, 'claimed');
    assert.equal(retried.record.attempts, 2);
    assert.equal(retried.record.resolutions.length, 1);
    assert.notEqual(retried.record.leaseToken, original.leaseToken);
    assert.equal(await store.complete(owner(retried.record), receipt(retried.record)), true);
    assert.equal((await store.get('tenant', original.id))?.receiptSource, 'tool');
  } finally { await store.close(); }
});

test('pre-dispatch release is retryable and receipt artifacts can only annotate the original completed call', async () => {
  const store = new SqliteToolExecutionStore(':memory:');
  try {
    await store.initialize();
    const original = (await store.claim(input())).record;
    assert.equal(await store.releaseUnstarted(owner(original)), true);
    const next = (await store.claim(input())).record;
    assert.equal(await store.complete(owner(next), receipt(next)), true);
    assert.equal(await store.annotateReceipt('tenant', next.id, 'wrong-call', { artifactError: 'incorrect' }), false);
    assert.equal(await store.annotateReceipt('tenant', next.id, next.callId, { artifactError: 'Object storage unavailable.' }), true);
    const replayed = await store.claim(input());
    assert.equal(replayed.record.receipt?.output, 'verified tool output');
    assert.equal(replayed.record.receipt?.artifactError, 'Object storage unavailable.');
    assert.equal(await store.markUnknown(owner(next), 'late callback'), false);
  } finally { await store.close(); }
});

test('old unresolved executions remain reviewable ahead of more than 1000 completed receipts', async () => {
  let now = Date.now();
  const store = new SqliteToolExecutionStore(':memory:', () => now);
  try {
    await store.initialize();
    const unknown = (await store.claim(input({ invocationId: 'old-unknown', sideEffect: 'write' }))).record;
    await store.markUnknown(owner(unknown), 'Unconfirmed old write.');
    for (let index = 0; index < 1001; index += 1) {
      now += 1;
      const record = (await store.claim(input({ invocationId: `later-${index}` }))).record;
      await store.complete(owner(record), receipt(record));
    }
    assert.equal((await store.listForTask('tenant', 'task', 200))[0]?.id, unknown.id);
    assert.equal(await store.hasUnresolvedForTask('tenant', 'task'), true);
    assert.equal(await store.hasUnresolvedForTask('wrong-tenant', 'task'), false);
    assert.equal(await store.hasUnresolvedForTask('tenant', 'wrong-task'), false);
    const pending = (await store.get('tenant', unknown.id))!;
    await store.resolveUnknown({ tenantId: 'tenant', id: unknown.id, expectedRevision: pending.revision, operatorId: 'reviewer', decision: 'confirmed-completed', note: 'Checked the remote operation.' });
    assert.equal(await store.hasUnresolvedForTask('tenant', 'task'), false);
  } finally { await store.close(); }
});

test('expired-record reconciliation unblocks reads, exposes unknown writes and fences late owners', async () => {
  let now = Date.now();
  const store = new SqliteToolExecutionStore(':memory:', () => now);
  try {
    await store.initialize();
    const read = (await store.claim(input())).record;
    const write = (await store.claim(input({ invocationId: 'write', sideEffect: 'write' }))).record;
    assert.equal(await store.reconcileExpiredForTask('tenant', 'task'), 0);
    now += 800;
    assert.equal(await store.renew(owner(read), 2000), true);
    now += 201;
    assert.equal(await store.reconcileExpiredForTask('wrong-tenant', 'task'), 0);
    assert.equal(await store.reconcileExpiredForTask('tenant', 'task'), 1);
    assert.equal((await store.get('tenant', write.id))?.status, 'outcome_unknown');
    assert.equal((await store.get('tenant', read.id))?.status, 'executing', 'renewed reads survive a stale reconciliation scan');
    assert.equal(await store.complete(owner(write), receipt(write)), false);
    now += 2000;
    assert.equal(await store.reconcileExpiredForTask('tenant', 'task'), 1);
    assert.equal((await store.get('tenant', read.id))?.status, 'retryable');
    assert.equal(await store.complete(owner(read), receipt(read)), false);
    assert.equal(await store.reconcileExpiredForTask('tenant', 'task'), 0);
    assert.equal((await store.claim(input())).kind, 'claimed');
    assert.equal((await store.claim(input({ invocationId: 'write', sideEffect: 'write' }))).kind, 'outcome_unknown');
  } finally { await store.close(); }
});
