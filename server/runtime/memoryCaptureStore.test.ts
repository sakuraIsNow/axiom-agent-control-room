import assert from 'node:assert/strict';
import test from 'node:test';
import { SqliteMemoryCaptureReceiptStore, type MemoryCaptureIdentity } from './memoryCaptureStore.js';

const identity = (patch: Partial<MemoryCaptureIdentity> = {}): MemoryCaptureIdentity => ({
  tenantId: 'tenant-a',
  userId: 'user-a',
  sessionId: 'session-a',
  taskId: 'task-a',
  contentDigest: 'a'.repeat(64),
  ...patch,
});

test('memory capture receipt allows only one concurrent claimant and records duplicate skips', async () => {
  const store = new SqliteMemoryCaptureReceiptStore(':memory:');
  await store.initialize();
  try {
    const claims = await Promise.all(Array.from({ length: 12 }, () => store.claim(identity())));
    assert.equal(claims.filter((claim) => claim.claimed).length, 1);
    assert.ok(claims.filter((claim) => !claim.claimed).every((claim) => claim.reason === 'in_progress'));

    const owner = claims.find((claim) => claim.claimed)!;
    const completed = await store.complete(owner.receipt.id, owner.claimToken!, {
      cursorTimestamp: '2026-08-29T08:00:00.000Z',
      capturedCount: 2,
      serverTotalCount: 8,
    });
    assert.equal(completed?.status, 'completed');

    const duplicate = await store.claim(identity());
    assert.equal(duplicate.claimed, false);
    assert.equal(duplicate.reason, 'already_completed');
    assert.equal(duplicate.receipt.capturedCount, 2);
    const stats = await store.stats('tenant-a', 'user-a');
    assert.equal(stats.completed, 1);
    assert.equal(stats.capturedMessages, 2);
    assert.equal(stats.duplicateSkips, 1);
  } finally {
    await store.close();
  }
});

test('failed memory capture can be reclaimed without changing a completed receipt', async () => {
  const store = new SqliteMemoryCaptureReceiptStore(':memory:');
  await store.initialize();
  try {
    const first = await store.claim(identity());
    assert.equal(first.claimed, true);
    await store.fail(first.receipt.id, first.claimToken!, 'temporary upstream failure');

    const retry = await store.claim(identity());
    assert.equal(retry.claimed, true);
    assert.equal(retry.receipt.attempts, 2);
    await store.complete(retry.receipt.id, retry.claimToken!, {
      cursorTimestamp: '2026-08-29T09:00:00.000Z', capturedCount: 2,
    });

    const staleFailure = await store.fail(retry.receipt.id, first.claimToken!, 'late worker');
    assert.equal(staleFailure, null);
    assert.equal((await store.get(identity()))?.status, 'completed');
  } finally {
    await store.close();
  }
});

test('memory capture receipts are isolated by tenant and user', async () => {
  const store = new SqliteMemoryCaptureReceiptStore(':memory:');
  await store.initialize();
  try {
    const [tenantA, tenantB, userB] = await Promise.all([
      store.claim(identity()),
      store.claim(identity({ tenantId: 'tenant-b' })),
      store.claim(identity({ userId: 'user-b' })),
    ]);
    assert.equal(tenantA.claimed, true);
    assert.equal(tenantB.claimed, true);
    assert.equal(userB.claimed, true);
    assert.notEqual(tenantA.receipt.id, tenantB.receipt.id);
    assert.notEqual(tenantA.receipt.id, userB.receipt.id);
  } finally {
    await store.close();
  }
});
