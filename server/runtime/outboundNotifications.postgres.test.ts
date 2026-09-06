import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import type { InAppNotification } from './contracts.js';
import { PostgresOutboundNotificationStore } from './outboundNotifications.js';

const connectionString = process.env.AXIOM_TEST_DATABASE_URL?.trim();

test('PostgreSQL notification claims recover crashes, fence old owners and bound retries', {
  skip: connectionString ? false : 'AXIOM_TEST_DATABASE_URL is not configured.',
  timeout: 20_000,
}, async () => {
  const first = new PostgresOutboundNotificationStore(connectionString!, 'notification-pg-test-secret');
  const second = new PostgresOutboundNotificationStore(connectionString!, 'notification-pg-test-secret');
  const pool = new Pool({ connectionString, max: 1 });
  const tenantId = `notification-pg-${randomUUID()}`;
  const userId = 'owner';
  const notification = (id: string): InAppNotification => ({
    id, kind: 'task_completed', severity: 'success', title: 'Delivered', message: 'Test result',
    createdAt: new Date().toISOString(), read: false, target: { view: 'tasks' }, action: { kind: 'open', label: 'Open' },
  });
  const expire = (id: string) => pool.query(`UPDATE outbound_notification_deliveries
    SET lease_expires_at=NOW()-INTERVAL '1 second',next_attempt_at=NOW()-INTERVAL '1 second' WHERE id=$1 AND tenant_id=$2`, [id, tenantId]);
  try {
    await Promise.all([first.initialize(), second.initialize()]);
    await first.saveChannel({
      tenantId, userId, name: 'Test Webhook', endpoint: 'http://127.0.0.1:9999/hook',
      signingSecret: 'notification-pg-signing-secret', location: 'local', eventKinds: ['task_completed'], enabled: true,
    });
    const [id] = await first.enqueue(tenantId, userId, notification('lease-race'));
    assert.ok(id);
    const claims = await Promise.all([first.claimNext('shared-worker', 30_000, id), second.claimNext('other-worker', 30_000, id)]);
    assert.equal(claims.filter(Boolean).length, 1);
    const original = claims.find((claim) => claim !== null)!;
    await expire(id);
    await first.markDelivered(id, original.leaseOwner!, original.leaseToken!, 204);
    assert.equal((await second.getDelivery(id, tenantId, userId))?.status, 'delivering');
    const replacement = await second.claimNext(original.leaseOwner!, 30_000, id);
    assert.ok(replacement);
    assert.notEqual(replacement.leaseToken, original.leaseToken);
    assert.equal(replacement.totalAttempts, 2);
    await first.markFailed(id, original.leaseOwner!, original.leaseToken!, 'old failure', 400, true);
    await first.markDelivered(id, original.leaseOwner!, original.leaseToken!, 204);
    assert.equal((await second.getDelivery(id, tenantId, userId))?.status, 'delivering');
    await second.markDelivered(id, replacement.leaseOwner!, replacement.leaseToken!, 204);
    const delivered = await first.getDelivery(id, tenantId, userId);
    assert.equal(delivered?.status, 'delivered');
    assert.equal(delivered?.totalAttempts, 2);
    assert.equal('leaseToken' in delivered!, false);
    assert.equal(await first.retry(id, tenantId, userId), false);

    const [crashId] = await first.enqueue(tenantId, userId, notification('crash-limit'));
    assert.ok(crashId);
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const claim = await second.claimNext(`crash-${attempt}`, 30_000, crashId);
      assert.equal(claim?.attemptCount, attempt);
      await expire(crashId);
    }
    assert.equal(await first.claimNext('no-sixth-attempt', 30_000, crashId), null);
    const dead = await second.getDelivery(crashId, tenantId, userId);
    assert.equal(dead?.status, 'dead_letter');
    assert.equal(dead?.totalAttempts, 5);
    assert.equal(await second.retry(crashId, tenantId, 'other-user'), false);
    assert.equal(await second.retry(crashId, tenantId, userId), true);
    const manual = await first.claimNext('manual-retry', 30_000, crashId);
    assert.equal(manual?.attemptCount, 1);
    assert.equal(manual?.totalAttempts, 6);
    await first.markFailed(crashId, 'manual-retry', manual!.leaseToken!, 'transient failure', 503);
    assert.equal(await second.claimNext('before-backoff', 30_000, crashId), null);
    assert.equal((await first.getDelivery(crashId, tenantId, userId))?.status, 'retrying');
  } finally {
    try {
      await pool.query('DELETE FROM outbound_notification_deliveries WHERE tenant_id=$1', [tenantId]);
      await pool.query('DELETE FROM outbound_notification_channels WHERE tenant_id=$1', [tenantId]);
    } finally { await Promise.all([first.close(), second.close(), pool.end()]); }
  }
});
