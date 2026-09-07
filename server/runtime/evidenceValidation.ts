import type { ArtifactRef, EvidenceItem } from './contracts.js';

export type EvidenceValidation = {
  version: 1;
  taskId: string;
  stepId: string;
  basis: 'tool-receipt' | 'artifact' | 'none';
  sourceStatus: 'available' | 'failed' | 'missing';
  toolCallId?: string;
  auditId?: string;
  artifactId?: string;
};

export type EvidenceToolReceipt = {
  taskId: string;
  stepId: string;
  callId: string;
  auditId: string;
  name?: string;
  exitCode: number;
};

export type EvidenceValidationContext = {
  taskId: string;
  stepId: string;
  toolReceipts?: readonly EvidenceToolReceipt[];
  artifacts?: readonly { taskId: string; artifact: ArtifactRef }[];
};

type EvidenceCandidate = EvidenceItem & { auditId?: string; validation?: unknown };
export type ValidatedEvidenceItem = EvidenceItem & { auditId?: string; validation: EvidenceValidation };

const referencesReceipt = (item: EvidenceCandidate, receipt: EvidenceToolReceipt) => {
  if (item.auditId !== undefined) return item.auditId.trim() === receipt.auditId;
  const source = item.source.trim();
  return source === receipt.auditId || source === receipt.callId
    || Boolean(receipt.name && source === `${receipt.name} \u00b7 ${receipt.auditId}`);
};

/** Supplied receipts and artifacts must come from runtime observations or a tenant-scoped store. */
export const validateEvidence = (
  items: readonly EvidenceCandidate[],
  context: EvidenceValidationContext,
): ValidatedEvidenceItem[] => {
  const receipts = (context.toolReceipts ?? []).filter((receipt) => receipt.taskId === context.taskId
    && receipt.callId.trim() && receipt.auditId.trim() && Number.isFinite(receipt.exitCode));
  const artifacts = (context.artifacts ?? []).filter((entry) => entry.taskId === context.taskId
    && (!entry.artifact.lineage || entry.artifact.lineage.taskId === context.taskId));

  return items.map((item) => {
    const validation: EvidenceValidation = {
      version: 1, taskId: context.taskId, stepId: context.stepId, basis: 'none', sourceStatus: 'missing',
    };
    const artifactId = item.artifactId?.trim() || (item.kind === 'artifact' ? item.source.trim() : '');
    const artifactEntry = artifactId ? artifacts.find((candidate) => candidate.artifact.id === artifactId) : undefined;
    const missingArtifact = Boolean(item.artifactId && !artifactEntry);
    const receipt = receipts.find((candidate) => referencesReceipt(item, candidate));
    if (receipt && !missingArtifact) {
      Object.assign(validation, {
        basis: 'tool-receipt', sourceStatus: receipt.exitCode === 0 ? 'available' : 'failed',
        toolCallId: receipt.callId, auditId: receipt.auditId,
      });
    } else if (item.auditId === undefined) {
      const entry = artifactEntry;
      if (entry) {
        const callId = entry.artifact.sourceToolCallId ?? entry.artifact.lineage?.toolCallId;
        const artifactReceipt = callId ? receipts.find((candidate) => candidate.callId === callId) : undefined;
        Object.assign(validation, {
          basis: 'artifact', artifactId: entry.artifact.id,
          sourceStatus: artifactReceipt && artifactReceipt.exitCode !== 0 ? 'failed' : 'available',
          ...(callId ? { toolCallId: callId } : {}),
          ...(artifactReceipt ? { auditId: artifactReceipt.auditId } : {}),
        });
      }
    }
    // A durable source establishes traceability, not the factual truth of a model's claim.
    return {
      ...item,
      verification: validation.sourceStatus === 'available' ? 'supported' : 'unverified',
      validation,
    };
  });
};

export const hasTraceableEvidence = (item: EvidenceCandidate, taskId: string, stepId?: string) => {
  const validation = item.validation as Partial<EvidenceValidation> | undefined;
  return Boolean(taskId && item.verification === 'supported' && validation?.version === 1
    && validation.taskId === taskId && (!stepId || validation.stepId === stepId)
    && validation.sourceStatus === 'available'
    && (validation.basis === 'tool-receipt' && validation.auditId && validation.toolCallId
      || validation.basis === 'artifact' && validation.artifactId));
};
