import test from 'node:test';
import assert from 'node:assert/strict';
import type { EvidenceItem, WorkflowTaskSummary } from '../types';
import { completionSourceStatus, evidenceSourceStatus } from './evidencePresentation';

const item: EvidenceItem = {
  id: 'e1', claim: 'Claim', source: 'model', kind: 'tool-result', verification: 'verified', confidence: 1,
};

test('legacy model verification and unrelated task validations are never shown as traced evidence', () => {
  assert.equal(evidenceSourceStatus(item, 'task-1'), 'unverified');
  const validated: EvidenceItem = {
    ...item, verification: 'supported', validation: {
      version: 1, taskId: 'task-1', stepId: 'step-1', basis: 'tool-receipt', sourceStatus: 'available', auditId: 'audit-1', toolCallId: 'call-1',
    },
  };
  assert.equal(evidenceSourceStatus(validated, 'task-1'), 'supported');
  assert.equal(evidenceSourceStatus(validated, 'task-2'), 'unverified');
  assert.equal(evidenceSourceStatus({ ...validated, validation: { ...validated.validation!, sourceStatus: 'failed' } }, 'task-1'), 'unverified');
});

test('completion presentation requires the current source contract, not completed or approved labels', () => {
  const summary: NonNullable<WorkflowTaskSummary['evidenceSummary']> = {
    status: 'verified', totalSteps: 1, completedSteps: 1, failedSteps: 0, skippedSteps: 0,
    acceptanceCriteria: 1, evidenceItems: 1, artifactRefs: 1, toolReceipts: 1, review: 'approved', gaps: [],
  };
  assert.equal(completionSourceStatus(summary), 'unverified');
  assert.equal(completionSourceStatus({ ...summary, schemaVersion: 2, acceptance: 'accepted' }), 'unverified');
  assert.equal(completionSourceStatus({ ...summary, schemaVersion: 2, evidenceStatus: 'supported', supportedEvidenceItems: 1 }), 'supported');
});
