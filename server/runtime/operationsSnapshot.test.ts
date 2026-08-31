import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOperationsSnapshot } from './operationsSnapshot.js';

const now = Date.parse('2026-08-29T00:00:00.000Z');

test('builds tenant operations snapshot from leases, events, and terminal task durations', () => {
  const snapshot = buildOperationsSnapshot([
    { id: 'queued', status: 'queued', createdAt: '2026-08-28T23:50:00.000Z', updatedAt: '2026-08-28T23:50:00.000Z' },
    { id: 'running', status: 'running', leaseOwner: 'worker-a', leaseExpiresAt: '2026-08-29T00:02:00.000Z', createdAt: '2026-08-28T23:40:00.000Z', updatedAt: '2026-08-28T23:59:00.000Z' },
    { id: 'stale', status: 'reviewing', leaseOwner: 'worker-b', leaseExpiresAt: '2026-08-28T23:59:00.000Z', createdAt: '2026-08-28T23:30:00.000Z', updatedAt: '2026-08-28T23:59:00.000Z' },
    { id: 'done', status: 'completed', createdAt: '2026-08-28T22:00:00.000Z', updatedAt: '2026-08-28T22:05:00.000Z' },
    { id: 'failed', status: 'failed', createdAt: '2026-08-28T21:00:00.000Z', updatedAt: '2026-08-28T21:20:00.000Z' },
  ], [
    { taskId: 'done', type: 'model.completed', timestamp: '2026-08-28T22:01:00.000Z', payload: { model: 'deepseek-chat', durationMs: 1000, totalTokens: 100, estimatedCostUsd: 0.02 } },
    { taskId: 'done', type: 'agent.started', agentId: 'analyst-1', timestamp: '2026-08-28T22:01:00.000Z', payload: { role: 'analyst' } },
    { taskId: 'done', type: 'agent.completed', agentId: 'analyst-1', timestamp: '2026-08-28T22:04:00.000Z', payload: { role: 'analyst' } },
    { taskId: 'done', type: 'tool.started', timestamp: '2026-08-28T22:02:00.000Z', payload: { name: 'workspace.read' } },
    { taskId: 'done', type: 'tool.completed', timestamp: '2026-08-28T22:02:01.000Z', payload: { name: 'workspace.read' } },
    { taskId: 'done', type: 'review.started', timestamp: '2026-08-28T22:04:00.000Z', payload: {} },
    { taskId: 'done', type: 'review.completed', timestamp: '2026-08-28T22:04:30.000Z', payload: { approved: true } },
    { taskId: 'failed', type: 'agent.failed', agentId: 'builder-1', timestamp: '2026-08-28T21:10:00.000Z', payload: { model: 'deepseek-chat', role: 'builder' } },
    { taskId: 'failed', type: 'tool.failed', timestamp: '2026-08-28T21:11:00.000Z', payload: { name: 'http.fetch' } },
  ], { now, windowHours: 24 });

  assert.equal(snapshot.workers.active, 1);
  assert.equal(snapshot.workers.staleLeases, 1);
  assert.equal(snapshot.queue.queued, 1);
  assert.equal(snapshot.queue.running, 1);
  assert.equal(snapshot.queue.reviewing, 1);
  assert.equal(snapshot.queue.totalActive, 3);
  assert.equal(snapshot.queue.oldestWaitMs, 10 * 60 * 1_000);
  assert.equal(snapshot.sla.terminalTasks, 2);
  assert.equal(snapshot.sla.completed, 1);
  assert.equal(snapshot.sla.failed, 1);
  assert.equal(snapshot.sla.p50DurationMs, 300_000);
  assert.equal(snapshot.sla.p95DurationMs, 1_200_000);
  assert.equal(snapshot.models[0]?.model, 'deepseek-chat');
  assert.equal(snapshot.models[0]?.calls, 1);
  assert.equal(snapshot.models[0]?.failures, 1);
  assert.equal(snapshot.models[0]?.successRate, 50);
  assert.equal(snapshot.models[0]?.health, 'degraded');
  assert.equal(snapshot.tools[0]?.name, 'http.fetch');
  assert.equal(snapshot.tools[0]?.failures, 1);
  assert.equal(snapshot.agents.find((agent) => agent.agentId === 'analyst-1')?.successRate, 100);
  assert.equal(snapshot.reviewer.approvalRate, 100);
});

test('keeps an old queued task visible in queue wait metrics', () => {
  const snapshot = buildOperationsSnapshot([
    { id: 'stuck', status: 'queued', createdAt: '2026-08-26T00:00:00.000Z', updatedAt: '2026-08-26T00:00:00.000Z' },
  ], [], { now, windowHours: 24 });
  assert.equal(snapshot.queue.queued, 1);
  assert.equal(snapshot.queue.oldestWaitMs, 3 * 24 * 60 * 60 * 1_000);
  assert.equal(snapshot.queue.oldestQueuedAt, '2026-08-26T00:00:00.000Z');
});

test('excludes events and terminal tasks outside the requested window', () => {
  const snapshot = buildOperationsSnapshot([
    { id: 'old', status: 'completed', createdAt: '2026-08-27T00:00:00.000Z', updatedAt: '2026-08-27T00:05:00.000Z' },
  ], [
    { taskId: 'old', type: 'model.completed', timestamp: '2026-08-27T00:01:00.000Z', payload: { model: 'old-model', totalTokens: 999 } },
  ], { now, windowHours: 24 });
  assert.equal(snapshot.sla.terminalTasks, 0);
  assert.deepEqual(snapshot.models, []);
});
