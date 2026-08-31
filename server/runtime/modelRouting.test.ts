import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ModelRoutingPolicy, parseModelCostCatalog } from './modelRouting.js';
import type { RuntimeEvent } from './contracts.js';

const event = (type: RuntimeEvent['type'], payload: Record<string, unknown>, sequence: number): RuntimeEvent => ({
  id: `event-${sequence}`,
  type,
  version: 1,
  taskId: 'task-a',
  runId: 'run-a',
  sequence,
  timestamp: new Date(1_700_000_000_000 + sequence).toISOString(),
  payload,
});

test('parses optional model cost hints without throwing on malformed input', () => {
  const costs = parseModelCostCatalog('{"fast":{"inputCostPer1kUsd":0.001,"outputCostPer1kUsd":0.002,"kinds":["research"],"roles":["researcher"]}}');
  assert.equal(costs.get('fast')?.inputCostPer1kUsd, 0.001);
  assert.deepEqual(costs.get('fast')?.kinds, ['research']);
  assert.deepEqual(costs.get('fast')?.roles, ['researcher']);
  assert.equal(parseModelCostCatalog('{bad-json}').size, 0);
});

test('selects from the explicit candidate catalog and learns from runtime events', () => {
  const policy = new ModelRoutingPolicy(new Map([
    ['slow', { inputCostPer1kUsd: 0.01, outputCostPer1kUsd: 0.01 }],
    ['fast', { inputCostPer1kUsd: 0.001, outputCostPer1kUsd: 0.001 }],
  ]));
  assert.equal(policy.select(['slow', 'fast']), 'fast', 'lower cold-start cost wins when health data is equal');
  policy.recordEvent(event('model.completed', { model: 'fast', durationMs: 120, totalTokens: 40 }, 1));
  policy.recordEvent(event('model.completed', { model: 'fast', durationMs: 140, totalTokens: 50 }, 2));
  policy.recordEvent(event('agent.failed', { model: 'slow' }, 3));
  assert.equal(policy.select(['slow', 'fast']), 'fast');
  const snapshot = policy.snapshot(['slow', 'fast']);
  assert.equal(snapshot.candidates.find((candidate) => candidate.model === 'fast')?.successRate, 1);
  assert.equal(snapshot.candidates.find((candidate) => candidate.model === 'slow')?.failures, 1);
});

test('deduplicates candidates and never selects an unlisted model', () => {
  const policy = new ModelRoutingPolicy();
  assert.equal(policy.select(['alpha', 'alpha', '', 'beta']), 'alpha');
  assert.equal(policy.snapshot(['alpha', 'beta']).candidates.length, 2);
});

test('uses configured task-kind and Agent-role affinity in model selection', () => {
  const policy = new ModelRoutingPolicy(new Map([
    ['general', { inputCostPer1kUsd: 0.001 }],
    ['research-specialist', { inputCostPer1kUsd: 0.002, kinds: ['research'], roles: ['researcher'] }],
  ]));
  assert.equal(policy.select(['general', 'research-specialist'], { kind: 'research', role: 'researcher' }), 'research-specialist');
  assert.equal(policy.select(['general', 'research-specialist'], { kind: 'conversation', role: 'analyst' }), 'general');
});

test('restores durable observations without trusting invalid counters', () => {
  const policy = new ModelRoutingPolicy();
  policy.restore([{
    model: 'restored', attempts: 12, successes: 9, failures: 3,
    totalLatencyMs: 1_200, totalTokens: 4_800, lastUsedAt: '2026-08-29T02:00:00.000Z',
  }, {
    model: 'invalid', attempts: -2, successes: 99, failures: 99, totalLatencyMs: -10, totalTokens: -2,
  }]);
  const restored = policy.snapshot(['restored', 'invalid']).candidates;
  assert.deepEqual(restored.find((candidate) => candidate.model === 'restored'), {
    model: 'restored', attempts: 12, successes: 9, failures: 3,
    successRate: 0.75, averageLatencyMs: 100, totalTokens: 4_800, lastUsedAt: '2026-08-29T02:00:00.000Z',
  });
  assert.equal(restored.find((candidate) => candidate.model === 'invalid')?.attempts, 0);
});
