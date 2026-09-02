import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOperationsAlerts } from './operationsAlerts.js';
import type { OperationsSnapshot } from './contracts.js';

const baseSnapshot = (patch: Partial<OperationsSnapshot> = {}): OperationsSnapshot => ({
  generatedAt: '2026-09-02T00:00:00.000Z',
  windowHours: 24,
  workers: { active: 1, leases: [], staleLeases: 0 },
  queue: {
    queued: 0, planning: 0, running: 0, reviewing: 0, awaitingApproval: 0,
    waitingForHuman: 0, paused: 0, totalActive: 0, oldestWaitMs: 0,
  },
  models: [], tools: [], agents: [],
  reviewer: { started: 0, completed: 0, approved: 0, rejected: 0, humanTakeover: 0, approvalRate: null },
  sla: { terminalTasks: 0, completed: 0, failed: 0, cancelled: 0, successRate: null, p50DurationMs: 0, p95DurationMs: 0 },
  ...patch,
});

test('operations alerts prioritize critical runtime risks and expose stable metrics', () => {
  const snapshot = baseSnapshot({
    queue: {
      queued: 55, planning: 0, running: 0, reviewing: 0, awaitingApproval: 0,
      waitingForHuman: 0, paused: 0, totalActive: 55, oldestWaitMs: 1_000_000,
    },
    workers: { active: 1, leases: [], staleLeases: 2 },
    models: [{ model: 'deepseek-chat', calls: 4, successes: 2, failures: 2, successRate: 50, averageLatencyMs: 800, totalTokens: 100, promptCacheHitTokens: 0, promptCacheMissTokens: 0, promptCacheHitRate: null, estimatedCostUsd: 0, health: 'degraded' }],
  });
  const result = buildOperationsAlerts(snapshot, { state: 'blocked', blockers: ['模型服务不可用。'], warnings: [] });
  assert.equal(result.summary.critical, 4);
  assert.equal(result.alerts[0]?.severity, 'critical');
  assert.equal(result.alerts[0]?.id, 'queue-backlog-critical');
  assert.ok(result.alerts.some((alert) => alert.metric === 'workers.staleLeases'));
  assert.ok(result.alerts.some((alert) => alert.metric === 'readiness.state'));
});

test('operations alerts stay quiet for a healthy snapshot while retaining review information', () => {
  const snapshot = baseSnapshot({
    queue: {
      queued: 0, planning: 0, running: 1, reviewing: 0, awaitingApproval: 1,
      waitingForHuman: 0, paused: 0, totalActive: 2, oldestWaitMs: 0,
    },
  });
  const result = buildOperationsAlerts(snapshot, { state: 'ready', blockers: [], warnings: [] });
  assert.equal(result.summary.critical, 0);
  assert.equal(result.summary.warning, 0);
  assert.equal(result.summary.info, 1);
  assert.equal(result.alerts[0]?.id, 'review-backlog');
});

test('operations alerts detect artifact cleanup and tool failure backlog', () => {
  const snapshot = baseSnapshot({
    artifacts: { total: 4, active: 1, orphaned: 1, deletePending: 2, deleted: 1, cleanupFailures: 1, totalBytes: 10 },
    tools: [{ name: 'http.fetch', calls: 4, successes: 2, failures: 2, failureRate: 50 }],
  });
  const result = buildOperationsAlerts(snapshot);
  assert.ok(result.alerts.some((alert) => alert.id === 'artifact-cleanup' && alert.severity === 'warning'));
  assert.ok(result.alerts.some((alert) => alert.id === 'tool-failure:http.fetch'));
});
