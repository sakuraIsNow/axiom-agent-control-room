import test from 'node:test';
import assert from 'node:assert/strict';
import type { EvidenceItem, StepResult, WorkflowPlan } from './contracts.js';
import { canReuseCompletionArtifact, parseCompletionEvidence, summarizeCompletionEvidence } from './completionEvidence.js';
import { validateEvidence } from './evidenceValidation.js';

const plan: WorkflowPlan = {
  summary: 'test', routingReason: 'test',
  steps: [
    { id: 'research', title: 'research', role: 'researcher', objective: 'research', dependsOn: [], acceptanceCriteria: ['source'], skillIds: [] },
    { id: 'build', title: 'build', role: 'builder', objective: 'build', dependsOn: ['research'], acceptanceCriteria: ['artifact', 'check'], skillIds: [] },
  ],
};
const result = (stepId: string, overrides: Partial<StepResult> = {}): StepResult => ({
  stepId, agentId: `${stepId}-agent`, role: 'builder', status: 'completed', output: 'result',
  evidence: [], confidence: .9, attempts: 1, durationMs: 10, ...overrides,
});
const evidence: EvidenceItem = {
  id: 'e1', claim: 'The tool proves the entire result is correct.', kind: 'tool-result',
  source: 'audit-1', verification: 'verified', confidence: 1,
};
const review = { approved: true, score: 95, summary: 'ok', gaps: [], requiredCorrections: [] };

test('execution, reviewer approval, and human acceptance never certify factual claims', () => {
  for (const humanAccepted of [false, true]) {
    const summary = summarizeCompletionEvidence(plan, [
      result('research', { evidence: ['source:1'], evidenceDetails: [evidence] }),
      result('build', { evidence: ['check:passed'], toolCalls: [{ name: 'workspace.write' }] }),
    ], review, true, { taskId: 'task-1', humanAccepted });
    assert.equal(summary.execution, 'completed');
    assert.equal(summary.acceptance, humanAccepted ? 'accepted' : 'not-recorded');
    assert.equal(summary.status, 'unverified');
    assert.equal(summary.evidenceStatus, 'unverified');
    assert.equal(summary.verifiedEvidenceItems, 0);
    assert.equal(summary.unverifiedEvidenceItems, 2);
    assert.equal(summary.acceptanceCriteria, 3);
  }
  const direct = summarizeCompletionEvidence(undefined, [result('direct')], undefined, false);
  assert.equal(direct.execution, 'completed');
  assert.equal(direct.status, 'unverified');
  assert.equal(direct.review, 'not-required');
});

test('only a scoped server validation contributes source traceability', () => {
  const validated = validateEvidence([evidence], {
    taskId: 'task-1', stepId: 'research',
    toolReceipts: [{ taskId: 'task-1', stepId: 'research', callId: 'call-1', auditId: 'audit-1', exitCode: 0 }],
  });
  const results = [result('research', { evidence: [evidence.claim], evidenceDetails: validated }), result('build')];
  const summary = summarizeCompletionEvidence(plan, results, undefined, false, { taskId: 'task-1' });
  assert.equal(summary.evidenceStatus, 'supported');
  assert.equal(summary.supportedEvidenceItems, 1);
  assert.equal(summary.verifiedEvidenceItems, 0);
  assert.equal(summary.status, 'unverified');
  assert.equal(summary.execution, 'completed');
  assert.equal(canReuseCompletionArtifact(summary), true);
  for (const taskId of [undefined, 'another-task']) {
    assert.equal(summarizeCompletionEvidence(plan, results, undefined, false, { taskId }).supportedEvidenceItems, 0);
  }
  const wrongStep = [result('build', { evidence: [evidence.claim], evidenceDetails: validated })];
  assert.equal(summarizeCompletionEvidence(undefined, wrongStep, undefined, false, { taskId: 'task-1' }).supportedEvidenceItems, 0);
});

test('model contradictions and failed tool exits do not become factual counterevidence', () => {
  const failed = validateEvidence([evidence], {
    taskId: 'task-1', stepId: 'research',
    toolReceipts: [{ taskId: 'task-1', stepId: 'research', callId: 'call-1', auditId: 'audit-1', exitCode: 1 }],
  });
  const summary = summarizeCompletionEvidence(undefined, [result('research', {
    evidence: ['model contradiction', 'failed tool'], evidenceDetails: [{ ...evidence, verification: 'contradicted' }, ...failed],
  })], undefined, false, { taskId: 'task-1' });
  assert.equal(summary.contradictedEvidenceItems, 0);
  assert.equal(summary.verifiedEvidenceItems, 0);
  assert.equal(summary.unverifiedEvidenceItems, 2);
});

test('missing steps, failed steps, and unfinished handoffs retain incomplete execution', () => {
  for (const results of [
    [result('research')],
    [result('research'), result('build', { status: 'failed' })],
    [result('research'), result('build', { handoff: { summary: 'partial', status: 'partial', artifactIds: [], evidenceIds: [], openQuestions: ['remaining'], completionCriteria: [] } })],
  ]) {
    const summary = summarizeCompletionEvidence(plan, results, review, true, { humanAccepted: true });
    assert.equal(summary.execution, 'partial');
    assert.equal(summary.status, 'partial');
    assert.equal(canReuseCompletionArtifact(summary), false);
  }
  const partial = summarizeCompletionEvidence(plan, [result('research'), result('build', { status: 'failed' })], {
    approved: false, score: 40, summary: 'needs work', gaps: ['artifact'], requiredCorrections: [],
  }, true);
  assert.equal(partial.failedSteps, 1);
  assert.equal(partial.review, 'rejected');
});

test('recovery and repeated checkpoints do not inflate completed evidence counts', () => {
  const summary = summarizeCompletionEvidence(plan, [
    result('research', { status: 'failed', recoveredByStepId: 'research-recovery-1' }),
    result('research-recovery-1', { evidence: ['bounded evidence'] }),
    result('build', { status: 'failed' }), result('build'),
  ], undefined, false);
  assert.equal(summary.execution, 'completed');
  assert.equal(summary.failedSteps, 0);
  assert.equal(summary.recoveredFailures, 1);
  assert.equal(summary.completedSteps, 2);
});

test('legacy summary labels and model counts are downgraded at the API boundary', () => {
  const legacy = {
    status: 'verified', totalSteps: 1, completedSteps: 1, failedSteps: 0, skippedSteps: 0,
    acceptanceCriteria: 1, evidenceItems: 3, artifactRefs: 1, toolReceipts: 1,
    verifiedEvidenceItems: 3, supportedEvidenceItems: 3, contradictedEvidenceItems: 3,
    review: 'approved', acceptance: 'accepted', evidenceStatus: 'supported', gaps: [],
  };
  const parsed = parseCompletionEvidence(legacy)!;
  assert.equal(parsed.status, 'unverified');
  assert.equal(parsed.execution, 'completed');
  assert.equal(parsed.acceptance, 'not-recorded');
  assert.equal(parsed.evidenceStatus, 'unverified');
  assert.equal(parsed.verifiedEvidenceItems, 0);
  assert.equal(parsed.supportedEvidenceItems, 0);
  assert.equal(parsed.unverifiedEvidenceItems, 3);
  assert.equal(parsed.contradictedEvidenceItems, 0);
  assert.equal(canReuseCompletionArtifact(parsed), false);
  assert.equal(parseCompletionEvidence({ ...legacy, evidenceItems: -1 }), undefined);
});

test('current summaries preserve separate acceptance and traceability while bounding counts', () => {
  const accepted = summarizeCompletionEvidence(undefined, [result('research')], review, true, { humanAccepted: true });
  assert.equal(canReuseCompletionArtifact(parseCompletionEvidence(accepted)), true);
  const sourced = parseCompletionEvidence({ ...accepted, evidenceItems: 2, acceptance: 'not-recorded', supportedEvidenceItems: 20 });
  assert.equal(sourced?.evidenceStatus, 'supported');
  assert.equal(sourced?.supportedEvidenceItems, 2);
  assert.equal(sourced?.unverifiedEvidenceItems, 0);
  assert.equal(canReuseCompletionArtifact(sourced), true);
  assert.equal(canReuseCompletionArtifact({ ...accepted, execution: 'partial' }), false);
  assert.equal(canReuseCompletionArtifact({ ...accepted, acceptance: 'not-recorded' }), false);
  const inconsistent = parseCompletionEvidence({ ...accepted, failedSteps: 1, execution: 'completed' });
  assert.equal(inconsistent?.execution, 'partial');
  assert.equal(canReuseCompletionArtifact(inconsistent), false);
});
