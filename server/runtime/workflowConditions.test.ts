import assert from 'node:assert/strict';
import test from 'node:test';
import type { StepResult } from './contracts.js';
import { evaluateWorkflowCondition, evaluateWorkflowConditions, explainWorkflowConditions } from './workflowConditions.js';

const result = (output: string, confidence = 0.8): StepResult => ({
  stepId: 'source', agentId: 'agent-source', role: 'analyst', status: 'completed', output,
  evidence: [], confidence, attempts: 1, durationMs: 1,
});

test('evaluates bounded output and confidence predicates without executing code', () => {
  assert.equal(evaluateWorkflowCondition('not_empty', result('ready')), true);
  assert.equal(evaluateWorkflowCondition('contains("ready")', result('READY to ship')), true);
  assert.equal(evaluateWorkflowCondition('equals(\'ready\')', result('ready')), true);
  assert.equal(evaluateWorkflowCondition('confidence >= 0.7', result('x', 0.7)), true);
  assert.equal(evaluateWorkflowCondition('confidence < 0.5', result('x', 0.7)), false);
  assert.equal(evaluateWorkflowCondition('globalThis.process.exit()', result('x')), false);
});

test('applies branch polarity and reports unavailable dependencies', () => {
  const source = result('approved', 0.9);
  const results = new Map([['source', source]]);
  assert.deepEqual(evaluateWorkflowConditions([
    { sourceStepId: 'source', expression: 'contains("approved")', branch: 'true' },
  ], results), { ready: true, selected: true, missing: [] });
  assert.deepEqual(evaluateWorkflowConditions([
    { sourceStepId: 'source', expression: 'contains("approved")', branch: 'false' },
  ], results), { ready: true, selected: false, missing: [] });
  assert.deepEqual(evaluateWorkflowConditions([
    { sourceStepId: 'missing', expression: 'not_empty', branch: 'true' },
  ], results), { ready: false, selected: false, missing: ['missing'] });
});

test('explains branch decisions with bounded upstream facts instead of leaking full output', () => {
  const source = result('approved'.repeat(500), 0.9);
  const evaluations = explainWorkflowConditions([
    { sourceStepId: 'source', expression: 'contains("approved")', branch: 'true' },
    { sourceStepId: 'missing', expression: 'not_empty', branch: 'true' },
  ], new Map([['source', source]]));
  assert.equal(evaluations[0]?.selected, true);
  assert.equal(evaluations[0]?.sourceOutputChars, source.output.length);
  assert.equal(evaluations[0]?.sourceConfidence, 0.9);
  assert.equal(evaluations[1]?.sourceAvailable, false);
  assert.equal('output' in (evaluations[0] ?? {}), false);
});
