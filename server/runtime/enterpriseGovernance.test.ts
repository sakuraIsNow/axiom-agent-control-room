import test from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { GovernanceQuotaError, GovernanceToolUnavailableError, createMemoryEnterpriseGovernanceStore } from './enterpriseGovernance.js';

test('enterprise governance persists tenant policy, usage and metrics', async () => {
  const store = createMemoryEnterpriseGovernanceStore();
  await store.initialize();
  try {
    const first = await store.getPolicy('tenant-a');
    assert.equal(first.toolCallsPerHour > 0, true);
    const updated = await store.updatePolicy('tenant-a', { toolCallsPerHour: 2, concurrentToolCalls: 1, monthlyToolCallBudget: 3 }, first.revision);
    assert.equal(updated.revision, first.revision + 1);
    const reservation = await store.reserveToolCall('tenant-a', 'source-a');
    assert.equal(reservation.usage.hourCalls, 1);
    assert.equal(reservation.usage.activeCalls, 1);
    await assert.rejects(() => store.reserveToolCall('tenant-a', 'source-b'), (error: unknown) => error instanceof GovernanceQuotaError && error.reason === 'concurrent-tool-calls');
    await store.releaseToolCall('tenant-a', reservation.reservationId);
    await store.recordToolOutcome('tenant-a', 'source-a', true, 12);
    await store.recordMetric({ tenantId: 'tenant-a', day: '2026-09-04', name: 'tasks_completed', dimensions: { route: 'team' }, value: 2 });
    await store.recordMetric({ tenantId: 'tenant-a', day: '2026-09-04', name: 'tasks_completed', dimensions: { route: 'team' }, value: 3 });
    const metrics = await store.metrics('tenant-a');
    assert.equal(metrics[0]?.value, 5);
    assert.equal((await store.snapshot('tenant-b')).usage.hourCalls, 0);
  } finally { await store.close(); }
});

test('default circuit recovery admits two sequential probes while excluding concurrent probes', async () => {
  const previous = process.env.AXIOM_TOOL_CIRCUIT_RECOVERY_THRESHOLD;
  delete process.env.AXIOM_TOOL_CIRCUIT_RECOVERY_THRESHOLD;
  const store = createMemoryEnterpriseGovernanceStore();
  await store.initialize();
  try {
    for (let index = 0; index < 3; index++) await store.recordToolOutcome('recovery', 'source', false, 1);
    const db = (store as unknown as { db: DatabaseSync }).db;
    db.prepare('UPDATE axiom_tool_health SET next_probe_at = ?').run('2000-01-01T00:00:00.000Z');
    const first = await store.reserveToolCall('recovery', 'source');
    await assert.rejects(store.reserveToolCall('recovery', 'source'), GovernanceToolUnavailableError);
    await store.recordToolOutcome('recovery', 'source', true, 1, undefined, first.reservationId);
    await store.releaseToolCall('recovery', first.reservationId);
    assert.equal((await store.getToolHealth('recovery', 'source')).status, 'half-open');
    const second = await store.reserveToolCall('recovery', 'source');
    await store.recordToolOutcome('recovery', 'source', true, 1, undefined, second.reservationId);
    await store.releaseToolCall('recovery', second.reservationId);
    assert.equal((await store.getToolHealth('recovery', 'source')).status, 'healthy');
  } finally {
    await store.close();
    if (previous === undefined) delete process.env.AXIOM_TOOL_CIRCUIT_RECOVERY_THRESHOLD;
    else process.env.AXIOM_TOOL_CIRCUIT_RECOVERY_THRESHOLD = previous;
  }
});

test('expired call and probe leases are recovered and stale releases cannot free another call', async () => {
  const store = createMemoryEnterpriseGovernanceStore();
  await store.initialize();
  try {
    await store.updatePolicy('leases', { concurrentToolCalls: 1 });
    const stale = await store.reserveToolCall('leases', 'source');
    const db = (store as unknown as { db: DatabaseSync }).db;
    db.prepare('UPDATE axiom_tool_call_leases SET expires_at = ?').run('2000-01-01T00:00:00.000Z');
    const current = await store.reserveToolCall('leases', 'source');
    await store.releaseToolCall('leases', stale.reservationId);
    assert.equal((await store.snapshot('leases')).usage.activeCalls, 1);
    await store.recordToolOutcome('leases', 'source', false, 1, undefined, stale.reservationId);
    assert.equal((await store.getToolHealth('leases', 'source')).totalCalls, 0);
    await store.releaseToolCall('leases', current.reservationId);
    await store.releaseToolCall('leases', current.reservationId);
    assert.equal((await store.snapshot('leases')).usage.activeCalls, 0);
    for (let index = 0; index < 3; index++) await store.recordToolOutcome('leases', 'source', false, 1);
    db.prepare('UPDATE axiom_tool_health SET next_probe_at = ?').run('2000-01-01T00:00:00.000Z');
    const lostProbe = await store.reserveToolCall('leases', 'source');
    db.prepare('UPDATE axiom_tool_call_leases SET expires_at = ?').run('2000-01-01T00:00:00.000Z');
    const replacement = await store.reserveToolCall('leases', 'source');
    assert.notEqual(replacement.reservationId, lostProbe.reservationId);
    await store.recordToolOutcome('leases', 'source', true, 1, undefined, lostProbe.reservationId);
    assert.equal((await store.getToolHealth('leases', 'source')).consecutiveSuccesses, 0);
    await store.recordToolOutcome('leases', 'source', true, 1, undefined, replacement.reservationId);
    await store.recordToolOutcome('leases', 'source', true, 1, undefined, replacement.reservationId);
    assert.equal((await store.getToolHealth('leases', 'source')).consecutiveSuccesses, 1);
    await store.releaseToolCall('leases', replacement.reservationId);
  } finally { await store.close(); }
});

test('old ordinary successes cannot count as current circuit recovery probes', async () => {
  const store = createMemoryEnterpriseGovernanceStore();
  await store.initialize();
  const previous = process.env.AXIOM_TOOL_CIRCUIT_RECOVERY_THRESHOLD;
  delete process.env.AXIOM_TOOL_CIRCUIT_RECOVERY_THRESHOLD;
  try {
    const pending = [];
    for (let index = 0; index < 5; index++) pending.push(await store.reserveToolCall('generation', 'source'));
    for (const call of pending.slice(0, 3)) {
      await store.recordToolOutcome('generation', 'source', false, 1, undefined, call.reservationId);
      await store.releaseToolCall('generation', call.reservationId);
    }
    assert.equal((await store.getToolHealth('generation', 'source')).status, 'open');
    await store.recordToolOutcome('generation', 'source', true, 1, undefined, pending[3].reservationId);
    assert.equal((await store.getToolHealth('generation', 'source')).consecutiveSuccesses, 0);
    const db = (store as unknown as { db: DatabaseSync }).db;
    db.prepare('UPDATE axiom_tool_health SET next_probe_at = ?').run('2000-01-01T00:00:00.000Z');
    const first = await store.reserveToolCall('generation', 'source');
    await store.recordToolOutcome('generation', 'source', true, 1, undefined, pending[4].reservationId);
    assert.equal((await store.getToolHealth('generation', 'source')).consecutiveSuccesses, 0);
    await store.recordToolOutcome('generation', 'source', true, 1, undefined, first.reservationId);
    await store.releaseToolCall('generation', first.reservationId);
    assert.equal((await store.getToolHealth('generation', 'source')).status, 'half-open');
    const second = await store.reserveToolCall('generation', 'source');
    await store.recordToolOutcome('generation', 'source', true, 1, undefined, second.reservationId);
    assert.equal((await store.getToolHealth('generation', 'source')).status, 'healthy');
  } finally {
    await store.close();
    if (previous === undefined) delete process.env.AXIOM_TOOL_CIRCUIT_RECOVERY_THRESHOLD;
    else process.env.AXIOM_TOOL_CIRCUIT_RECOVERY_THRESHOLD = previous;
  }
});

test('three consecutive tool failures open a circuit and a successful probe closes it', async () => {
  const previousThreshold = process.env.AXIOM_TOOL_CIRCUIT_FAILURE_THRESHOLD;
  const previousRecovery = process.env.AXIOM_TOOL_CIRCUIT_RECOVERY_THRESHOLD;
  const previousCooldown = process.env.AXIOM_TOOL_CIRCUIT_COOLDOWN_MS;
  process.env.AXIOM_TOOL_CIRCUIT_FAILURE_THRESHOLD = '3';
  process.env.AXIOM_TOOL_CIRCUIT_RECOVERY_THRESHOLD = '1';
  process.env.AXIOM_TOOL_CIRCUIT_COOLDOWN_MS = '1000';
  const store = createMemoryEnterpriseGovernanceStore();
  await store.initialize();
  try {
    for (let index = 0; index < 3; index += 1) await store.recordToolOutcome('tenant-a', 'source-a', false, 20, 'provider down');
    assert.equal((await store.getToolHealth('tenant-a', 'source-a')).status, 'open');
    await assert.rejects(() => store.reserveToolCall('tenant-a', 'source-a'), (error: unknown) => error instanceof GovernanceToolUnavailableError && error.reason === 'circuit-open');
    const health = await store.getToolHealth('tenant-a', 'source-a');
    assert.ok(health.nextProbeAt);
    await new Promise((resolve) => setTimeout(resolve, 1_050));
    const probe = await store.reserveToolCall('tenant-a', 'source-a');
    assert.equal(probe.health.status, 'half-open');
    await store.recordToolOutcome('tenant-a', 'source-a', true, 5, undefined, probe.reservationId);
    await store.releaseToolCall('tenant-a', probe.reservationId);
    assert.equal((await store.getToolHealth('tenant-a', 'source-a')).status, 'healthy');
  } finally {
    await store.close();
    if (previousThreshold === undefined) delete process.env.AXIOM_TOOL_CIRCUIT_FAILURE_THRESHOLD; else process.env.AXIOM_TOOL_CIRCUIT_FAILURE_THRESHOLD = previousThreshold;
    if (previousRecovery === undefined) delete process.env.AXIOM_TOOL_CIRCUIT_RECOVERY_THRESHOLD; else process.env.AXIOM_TOOL_CIRCUIT_RECOVERY_THRESHOLD = previousRecovery;
    if (previousCooldown === undefined) delete process.env.AXIOM_TOOL_CIRCUIT_COOLDOWN_MS; else process.env.AXIOM_TOOL_CIRCUIT_COOLDOWN_MS = previousCooldown;
  }
});
