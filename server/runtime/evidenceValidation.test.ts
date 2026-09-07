import test from 'node:test';
import assert from 'node:assert/strict';
import type { ArtifactRef, EvidenceItem } from './contracts.js';
import { hasTraceableEvidence, validateEvidence, type EvidenceValidationContext } from './evidenceValidation.js';

const item = (overrides: Partial<EvidenceItem> & { auditId?: string } = {}): EvidenceItem & { auditId?: string } => ({
  id: 'e1', claim: 'The requested result is correct.', kind: 'tool-result', source: 'model',
  verification: 'verified', confidence: 1, ...overrides,
});
const receipt = { taskId: 'task-1', stepId: 'step-1', callId: 'call-1', auditId: 'audit-1', name: 'workspace.read', exitCode: 0 };
const artifact: ArtifactRef = {
  id: 'artifact-1', kind: 'tool-output', name: 'output.txt', createdAt: '2026-09-06T00:00:00.000Z',
  sourceToolCallId: receipt.callId, lineage: { taskId: receipt.taskId, stepId: receipt.stepId, toolCallId: receipt.callId },
};
const context: EvidenceValidationContext = {
  taskId: receipt.taskId, stepId: receipt.stepId, toolReceipts: [receipt], artifacts: [{ taskId: receipt.taskId, artifact }],
};

test('model verification and contradictory labels cannot certify or refute a claim', () => {
  const results = validateEvidence([
    item(), item({ verification: 'supported' }), item({ verification: 'contradicted' }),
    { ...item(), validation: { version: 1, taskId: receipt.taskId, stepId: receipt.stepId, basis: 'tool-receipt', sourceStatus: 'available', auditId: receipt.auditId, toolCallId: receipt.callId } },
  ], context);
  assert.ok(results.every((result) => result.verification === 'unverified'));
  assert.ok(results.every((result) => result.validation.basis === 'none'));
  assert.ok(results.every((result) => !hasTraceableEvidence(result, receipt.taskId)));
});

test('an exact runtime receipt establishes source traceability without factual verification', () => {
  for (const reference of [
    { auditId: receipt.auditId }, { source: receipt.auditId }, { source: receipt.callId },
    { source: `${receipt.name} \u00b7 ${receipt.auditId}` },
  ]) {
    const [result] = validateEvidence([item(reference)], context);
    assert.equal(result.verification, 'supported');
    assert.equal(result.validation.auditId, receipt.auditId);
    assert.equal(result.validation.sourceStatus, 'available');
    assert.equal(hasTraceableEvidence(result, receipt.taskId, receipt.stepId), true);
    assert.equal(hasTraceableEvidence(result, 'another-task', receipt.stepId), false);
    assert.equal(hasTraceableEvidence(result, receipt.taskId, 'another-step'), false);
  }
  const [generic, embedded, forged, forgedArtifact] = validateEvidence([
    item({ source: receipt.name }), item({ source: `According to ${receipt.auditId}, the answer is correct.` }),
    item({ auditId: 'missing-audit', source: receipt.auditId, artifactId: artifact.id }),
    item({ auditId: receipt.auditId, artifactId: 'missing-artifact' }),
  ], context);
  assert.equal(generic.verification, 'unverified');
  assert.equal(embedded.verification, 'unverified');
  assert.equal(forged.verification, 'unverified');
  assert.equal(forgedArtifact.verification, 'unverified');
});

test('a failed tool is neither factual support nor automatic contradiction', () => {
  const results = validateEvidence([
    item({ auditId: receipt.auditId }), item({ kind: 'artifact', artifactId: artifact.id }),
  ], { ...context, toolReceipts: [{ ...receipt, exitCode: 1 }] });
  assert.ok(results.every((result) => result.verification === 'unverified'));
  assert.ok(results.every((result) => result.validation.sourceStatus === 'failed'));
});

test('artifacts require exact IDs and task ownership, including embedded lineage', () => {
  const [supported] = validateEvidence([item({ kind: 'artifact', artifactId: artifact.id })], context);
  assert.equal(supported.verification, 'supported');
  assert.equal(supported.validation.basis, 'artifact');
  assert.equal(hasTraceableEvidence(supported, receipt.taskId), true);
  for (const artifacts of [
    [{ taskId: 'another-task', artifact }],
    [{ taskId: receipt.taskId, artifact: { ...artifact, lineage: { ...artifact.lineage!, taskId: 'another-task' } } }],
    [{ taskId: receipt.taskId, artifact: { ...artifact, id: 'another-artifact' } }],
  ]) {
    const [result] = validateEvidence([item({ kind: 'artifact', artifactId: artifact.id })], { ...context, artifacts });
    assert.equal(result.verification, 'unverified');
  }
  const [crossTaskReceipt] = validateEvidence([item({ auditId: receipt.auditId })], {
    ...context, toolReceipts: [{ ...receipt, taskId: 'another-task' }],
  });
  assert.equal(crossTaskReceipt.verification, 'unverified');
});

test('a persisted step artifact can be traced without claiming its generated content is true', () => {
  const generated: ArtifactRef = {
    id: 'step-result-1', kind: 'step-output', name: 'step.md', sourceStepId: 'source-step', createdAt: artifact.createdAt,
  };
  const [result] = validateEvidence([item({ kind: 'artifact', source: generated.id })], {
    taskId: receipt.taskId, stepId: 'consumer-step', artifacts: [{ taskId: receipt.taskId, artifact: generated }],
  });
  assert.equal(result.verification, 'supported');
  assert.equal(result.validation.artifactId, generated.id);
  assert.equal(result.validation.stepId, 'consumer-step');
});
