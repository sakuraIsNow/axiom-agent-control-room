import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeCompletionEvidence } from './completionEvidence.js';

const plan = {
  summary: 'test',
  routingReason: 'test',
  steps: [
    { id: 'research', title: 'research', role: 'researcher', objective: 'research', dependsOn: [], acceptanceCriteria: ['source'], skillIds: [] },
    { id: 'build', title: 'build', role: 'builder', objective: 'build', dependsOn: ['research'], acceptanceCriteria: ['artifact', 'check'], skillIds: [] },
  ],
};

test('completion evidence distinguishes a verified delivery from a partial one', () => {
  const verified = summarizeCompletionEvidence(plan, [
    { stepId: 'research', agentId: 'researcher-research', role: 'researcher', status: 'completed', output: 'facts', evidence: ['source:1'], confidence: .9, attempts: 1, durationMs: 10, artifacts: [{ id: 'a1', kind: 'text', name: 'source' } as never] },
    { stepId: 'build', agentId: 'builder-build', role: 'builder', status: 'completed', output: 'result', evidence: ['check:passed'], confidence: .9, attempts: 1, durationMs: 20, toolCalls: [{ name: 'workspace.write', args: {} }] },
  ], { approved: true, score: 95, summary: 'ok', gaps: [], requiredCorrections: [] }, true);
  assert.equal(verified.status, 'verified');
  assert.equal(verified.evidenceItems, 2);
  assert.equal(verified.acceptanceCriteria, 3);

  const partial = summarizeCompletionEvidence(plan, [
    { stepId: 'research', agentId: 'researcher-research', role: 'researcher', status: 'completed', output: 'facts', evidence: [], confidence: .6, attempts: 1, durationMs: 10 },
    { stepId: 'build', agentId: 'builder-build', role: 'builder', status: 'failed', output: 'failed', evidence: [], confidence: 0, attempts: 2, durationMs: 20 },
  ], { approved: false, score: 40, summary: 'needs work', gaps: ['artifact'], requiredCorrections: [] }, true);
  assert.equal(partial.status, 'partial');
  assert.deepEqual(partial.gaps, ['1 个步骤未完成', '已完成步骤没有附带证据条目', '质量审核尚未通过']);
});

test('structured evidence never treats inference as verified and contradictions lower the delivery gate', () => {
  const summary = summarizeCompletionEvidence(plan, [
    {
      stepId: 'research', agentId: 'researcher-research', role: 'researcher', status: 'completed', output: 'facts',
      evidence: ['tool fact', 'model guess'], confidence: .8, attempts: 1, durationMs: 10,
      evidenceDetails: [
        { id: 'e1', claim: 'tool fact', kind: 'tool-result', source: 'workspace.read', verification: 'verified', confidence: 1 },
        { id: 'e2', claim: 'model guess', kind: 'model-inference', source: 'model', verification: 'contradicted', confidence: .4 },
      ],
    },
    { stepId: 'build', agentId: 'builder-build', role: 'builder', status: 'completed', output: 'result', evidence: ['supported'], confidence: .8, attempts: 1, durationMs: 10 },
  ], undefined, false);
  assert.equal(summary.status, 'partial');
  assert.equal(summary.verifiedEvidenceItems, 1);
  assert.equal(summary.contradictedEvidenceItems, 1);
  assert.ok(summary.gaps.some((gap) => gap.includes('证据存在冲突')));
});

test('a durable failed step recovered by a completed Replanner step is not counted as unresolved', () => {
  const summary = summarizeCompletionEvidence(plan, [
    { stepId: 'research', agentId: 'researcher-research', role: 'researcher', status: 'failed', output: 'failed', evidence: [], confidence: 0, attempts: 2, durationMs: 10, recoveredByStepId: 'research-recovery-1' },
    { stepId: 'research-recovery-1', agentId: 'researcher-recovery', role: 'researcher', status: 'completed', output: 'recovered', evidence: ['bounded evidence'], confidence: .8, attempts: 1, durationMs: 10 },
    { stepId: 'build', agentId: 'builder-build', role: 'builder', status: 'completed', output: 'result', evidence: ['output'], confidence: .8, attempts: 1, durationMs: 10 },
  ], undefined, false);
  assert.equal(summary.failedSteps, 0);
  assert.equal(summary.recoveredFailures, 1);
});
