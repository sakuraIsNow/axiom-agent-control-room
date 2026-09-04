import test from 'node:test';
import assert from 'node:assert/strict';
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
    await store.releaseToolCall('tenant-a');
    await store.recordToolOutcome('tenant-a', 'source-a', true, 12);
    await store.recordMetric({ tenantId: 'tenant-a', day: '2026-09-04', name: 'tasks_completed', dimensions: { route: 'team' }, value: 2 });
    await store.recordMetric({ tenantId: 'tenant-a', day: '2026-09-04', name: 'tasks_completed', dimensions: { route: 'team' }, value: 3 });
    const metrics = await store.metrics('tenant-a');
    assert.equal(metrics[0]?.value, 5);
    assert.equal((await store.snapshot('tenant-b')).usage.hourCalls, 0);
  } finally { await store.close(); }
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
    await store.releaseToolCall('tenant-a');
    await store.recordToolOutcome('tenant-a', 'source-a', true, 5);
    assert.equal((await store.getToolHealth('tenant-a', 'source-a')).status, 'healthy');
  } finally {
    await store.close();
    if (previousThreshold === undefined) delete process.env.AXIOM_TOOL_CIRCUIT_FAILURE_THRESHOLD; else process.env.AXIOM_TOOL_CIRCUIT_FAILURE_THRESHOLD = previousThreshold;
    if (previousRecovery === undefined) delete process.env.AXIOM_TOOL_CIRCUIT_RECOVERY_THRESHOLD; else process.env.AXIOM_TOOL_CIRCUIT_RECOVERY_THRESHOLD = previousRecovery;
    if (previousCooldown === undefined) delete process.env.AXIOM_TOOL_CIRCUIT_COOLDOWN_MS; else process.env.AXIOM_TOOL_CIRCUIT_COOLDOWN_MS = previousCooldown;
  }
});
