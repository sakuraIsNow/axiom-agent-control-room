import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeMetrics } from './metrics.js';
import type { RuntimeEvent } from './contracts.js';

const event = (type: RuntimeEvent['type'], payload: Record<string, unknown>): RuntimeEvent => ({
  id: crypto.randomUUID(),
  type,
  version: 1,
  taskId: 'task-metrics',
  runId: 'run-metrics',
  sequence: 1,
  timestamp: new Date().toISOString(),
  payload,
});

test('runtime metrics derive route, quality, tool, and phase latency counters from events', () => {
  const metrics = new RuntimeMetrics();
  metrics.recordEvent(event('task.planning', { profile: { route: 'full-workflow' } }));
  metrics.recordEvent(event('review.started', {}));
  metrics.recordEvent(event('review.approval_requested', { score: 62 }));
  metrics.recordEvent(event('review.completed', { approved: true, score: 92 }));
  metrics.recordEvent(event('tool.started', { name: 'workspace.read' }));
  metrics.recordEvent(event('tool.completed', { name: 'workspace.read' }));
  metrics.recordEvent(event('model.completed', { stage: 'planner', durationMs: 120, totalTokens: 12 }));
  metrics.recordEvent(event('model.completed', { stage: 'agent:research', durationMs: 380, totalTokens: 20 }));

  const snapshot = metrics.snapshot();
  assert.equal(snapshot.routes['full-workflow'], 1);
  assert.deepEqual(snapshot.review, { started: 1, approved: 1, rejected: 0, humanTakeover: 1 });
  assert.deepEqual(snapshot.tools, { started: 1, completed: 1, failed: 0 });
  assert.equal(snapshot.latency.p50Ms, 120);
  assert.equal(snapshot.latency.p95Ms, 380);
  assert.equal(snapshot.latency.samples, 2);
});
