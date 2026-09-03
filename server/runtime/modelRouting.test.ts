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
  const durable = restored.find((candidate) => candidate.model === 'restored');
  assert.equal(durable?.attempts, 12);
  assert.equal(durable?.successes, 9);
  assert.equal(durable?.failures, 3);
  assert.equal(durable?.successRate, 0.75);
  assert.equal(durable?.averageLatencyMs, 100);
  assert.equal(durable?.totalTokens, 4_800);
  assert.equal(durable?.lastUsedAt, '2026-08-29T02:00:00.000Z');
  assert.equal(durable?.reviewerAttempts, 0);
  assert.equal(durable?.retries, 0);
  assert.equal(durable?.humanTakeovers, 0);
  assert.equal(restored.find((candidate) => candidate.model === 'invalid')?.attempts, 0);
});

test('review quality, retries, takeovers, and user feedback change automatic selection', () => {
  const policy = new ModelRoutingPolicy();
  for (let index = 0; index < 8; index += 1) {
    policy.record({ model: 'stable', success: true, durationMs: 500 });
    policy.record({ model: 'fragile', success: true, durationMs: 500 });
  }
  policy.recordEvent(event('review.completed', { model: 'stable', approved: true, attempt: 1 }, 10));
  policy.recordEvent(event('review.completed', { model: 'fragile', approved: false, attempt: 1 }, 11));
  policy.recordEvent(event('agent.retrying', { model: 'fragile' }, 12));
  policy.recordEvent(event('node.replace_requested', { previousModel: 'fragile' }, 13));
  policy.recordFeedback({ model: 'stable', score: 5 });
  policy.recordFeedback({ model: 'fragile', score: 2, routingIssue: true });
  assert.equal(policy.select(['fragile', 'stable']), 'stable');
  const fragile = policy.snapshot(['fragile']).candidates[0]!;
  assert.equal(fragile.retries, 1);
  assert.equal(fragile.humanTakeovers, 2);
  assert.equal(fragile.averageFeedbackScore, 2);
});
