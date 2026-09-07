import type { EvidenceItem, WorkflowTaskSummary } from '../types';

export const evidenceSourceStatus = (item: EvidenceItem, taskId: string): 'supported' | 'unverified' => {
  const validation = item.validation;
  return item.verification === 'supported' && validation?.version === 1 && validation.taskId === taskId
    && validation.sourceStatus === 'available'
    && (validation.basis === 'tool-receipt' && validation.auditId && validation.toolCallId
      || validation.basis === 'artifact' && validation.artifactId) ? 'supported' : 'unverified';
};

export const completionSourceStatus = (summary: WorkflowTaskSummary['evidenceSummary']): 'supported' | 'unverified' =>
  summary?.schemaVersion === 2 && summary.evidenceStatus === 'supported' && (summary.supportedEvidenceItems ?? 0) > 0
    ? 'supported' : 'unverified';

export const evidenceSourceLabels = { supported: '\u6765\u6e90\u53ef\u8ffd\u6eaf', unverified: '\u6765\u6e90\u672a\u6838\u5bf9' } as const;
