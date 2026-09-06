import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import { GovernanceQuotaError, GovernanceToolUnavailableError, PostgresEnterpriseGovernanceStore } from './enterpriseGovernance.js';

const connectionString = process.env.AXIOM_TEST_DATABASE_URL?.trim();

test('PostgreSQL governance recovers call and probe leases with fenced multi-worker releases', {
  skip: connectionString ? false : 'AXIOM_TEST_DATABASE_URL is not configured.',
}, async () => {
  const first = new PostgresEnterpriseGovernanceStore(connectionString!);
  const second = new PostgresEnterpriseGovernanceStore(connectionString!);
  const db = new Pool({ connectionString });
  const tenantId = `governance-leases-${randomUUID()}`;
  const previous = process.env.AXIOM_TOOL_CIRCUIT_RECOVERY_THRESHOLD;
  delete process.env.AXIOM_TOOL_CIRCUIT_RECOVERY_THRESHOLD;
  await Promise.all([first.initialize(), second.initialize()]);
  try {
    await first.updatePolicy(tenantId, { concurrentToolCalls: 1 });
    const claims = await Promise.allSettled([first.reserveToolCall(tenantId, 'source'), second.reserveToolCall(tenantId, 'source')]);
    assert.equal(claims.filter((item) => item.status === 'fulfilled').length, 1);
    assert.ok(claims.some((item) => item.status === 'rejected' && item.reason instanceof GovernanceQuotaError));
    const stale = claims.find((item) => item.status === 'fulfilled')!;
    assert.equal(stale.status, 'fulfilled');
    if (stale.status !== 'fulfilled') throw new Error('Expected a reservation.');
    await db.query('UPDATE axiom_tool_call_leases SET expires_at=NOW()-INTERVAL \'1 second\' WHERE tenant_id=$1', [tenantId]);
    assert.equal(await first.renewToolCall(tenantId, stale.value.reservationId), false);
    const live = await second.reserveToolCall(tenantId, 'source');
    await first.releaseToolCall(tenantId, stale.value.reservationId);
    await first.recordToolOutcome(tenantId, 'source', false, 1, undefined, stale.value.reservationId);
    assert.equal((await first.snapshot(tenantId)).usage.activeCalls, 1);
    assert.equal((await first.getToolHealth(tenantId, 'source')).totalCalls, 0);
    assert.equal(await second.renewToolCall(tenantId, live.reservationId), true);
    await second.releaseToolCall(tenantId, live.reservationId);
    await second.releaseToolCall(tenantId, live.reservationId);
    assert.equal((await first.snapshot(tenantId)).usage.activeCalls, 0);
    for (let index = 0; index < 3; index++) await first.recordToolOutcome(tenantId, 'source', false, 1);
    await db.query('UPDATE axiom_tool_health SET next_probe_at=NOW()-INTERVAL \'1 second\' WHERE tenant_id=$1', [tenantId]);
    const abandonedProbe = await first.reserveToolCall(tenantId, 'source');
    await assert.rejects(second.reserveToolCall(tenantId, 'source'), GovernanceToolUnavailableError);
    await db.query('UPDATE axiom_tool_call_leases SET expires_at=NOW()-INTERVAL \'1 second\' WHERE tenant_id=$1', [tenantId]);
    const probe = await second.reserveToolCall(tenantId, 'source');
    await first.recordToolOutcome(tenantId, 'source', true, 1, undefined, abandonedProbe.reservationId);
    assert.equal((await second.getToolHealth(tenantId, 'source')).consecutiveSuccesses, 0);
    await second.recordToolOutcome(tenantId, 'source', true, 1, undefined, probe.reservationId);
    await second.recordToolOutcome(tenantId, 'source', true, 1, undefined, probe.reservationId);
    assert.equal((await first.getToolHealth(tenantId, 'source')).consecutiveSuccesses, 1);
    await second.releaseToolCall(tenantId, probe.reservationId);
    const secondProbe = await first.reserveToolCall(tenantId, 'source');
    await first.recordToolOutcome(tenantId, 'source', true, 1, undefined, secondProbe.reservationId);
    await first.releaseToolCall(tenantId, secondProbe.reservationId);
    assert.equal((await second.getToolHealth(tenantId, 'source')).status, 'healthy');
    await first.updatePolicy(tenantId, { concurrentToolCalls: 12 });
    const ordinary = [];
    for (let index = 0; index < 5; index++) ordinary.push(await first.reserveToolCall(tenantId, 'generation'));
    for (const call of ordinary.slice(0, 3)) {
      await first.recordToolOutcome(tenantId, 'generation', false, 1, undefined, call.reservationId);
      await first.releaseToolCall(tenantId, call.reservationId);
    }
    await second.recordToolOutcome(tenantId, 'generation', true, 1, undefined, ordinary[3].reservationId);
    assert.equal((await first.getToolHealth(tenantId, 'generation')).consecutiveSuccesses, 0);
    await db.query('UPDATE axiom_tool_health SET next_probe_at=clock_timestamp()-INTERVAL \'1 second\' WHERE tenant_id=$1 AND source_id=$2', [tenantId, 'generation']);
    const currentProbe = await first.reserveToolCall(tenantId, 'generation');
    await second.recordToolOutcome(tenantId, 'generation', true, 1, undefined, ordinary[4].reservationId);
    assert.equal((await first.getToolHealth(tenantId, 'generation')).consecutiveSuccesses, 0);
    await first.recordToolOutcome(tenantId, 'generation', true, 1, undefined, currentProbe.reservationId);
    await first.releaseToolCall(tenantId, currentProbe.reservationId);
    assert.equal((await second.getToolHealth(tenantId, 'generation')).status, 'half-open');
    const recoveryProbe = await second.reserveToolCall(tenantId, 'generation');
    await second.recordToolOutcome(tenantId, 'generation', true, 1, undefined, recoveryProbe.reservationId);
    assert.equal((await first.getToolHealth(tenantId, 'generation')).status, 'healthy');

    const blockedOutcome = await first.reserveToolCall(tenantId, 'lock-expiry');
    const locker = await db.connect();
    try {
      await db.query('UPDATE axiom_tool_call_leases SET expires_at=clock_timestamp()+INTERVAL \'500 milliseconds\' WHERE id=$1', [blockedOutcome.reservationId]);
      await locker.query('BEGIN');
      await locker.query('SELECT tenant_id FROM axiom_tenant_tool_usage WHERE tenant_id=$1 FOR UPDATE', [tenantId]);
      const waiting = second.recordToolOutcome(tenantId, 'lock-expiry', true, 1, undefined, blockedOutcome.reservationId);
      await new Promise((resolve) => setTimeout(resolve, 650));
      await locker.query('COMMIT');
      await waiting;
      assert.equal((await first.getToolHealth(tenantId, 'lock-expiry')).totalCalls, 0);
      const blockedRenewal = await first.reserveToolCall(tenantId, 'lock-renewal');
      await db.query('UPDATE axiom_tool_call_leases SET expires_at=clock_timestamp()+INTERVAL \'500 milliseconds\' WHERE id=$1', [blockedRenewal.reservationId]);
      await locker.query('BEGIN');
      await locker.query('SELECT id FROM axiom_tool_call_leases WHERE id=$1 FOR UPDATE', [blockedRenewal.reservationId]);
      const renewal = second.renewToolCall(tenantId, blockedRenewal.reservationId);
      await new Promise((resolve) => setTimeout(resolve, 650));
      await locker.query('COMMIT');
      assert.equal(await renewal, false);
    } finally { await locker.query('ROLLBACK').catch(() => undefined); locker.release(); }
  } finally {
    for (const table of ['axiom_tool_call_leases', 'axiom_tool_health', 'axiom_tenant_tool_usage', 'axiom_tenant_governance_policies']) await db.query(`DELETE FROM ${table} WHERE tenant_id=$1`, [tenantId]);
    await Promise.all([first.close(), second.close(), db.end()]);
    if (previous === undefined) delete process.env.AXIOM_TOOL_CIRCUIT_RECOVERY_THRESHOLD;
    else process.env.AXIOM_TOOL_CIRCUIT_RECOVERY_THRESHOLD = previous;
  }
});
