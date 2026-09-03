import type { CompletionEvidenceSummary, ReviewResult, StepResult, WorkflowPlan } from './contracts.js';

export type { CompletionEvidenceSummary } from './contracts.js';

/**
 * Build a bounded, model-independent delivery receipt. It deliberately does
 * not claim that a sentence is true merely because a model returned it: the
 * receipt counts durable step results, tool receipts, artifacts and review
 * state so consumers can make an explicit trust decision.
 */
export const summarizeCompletionEvidence = (
  plan: WorkflowPlan | undefined,
  results: readonly StepResult[],
  review: ReviewResult | undefined,
  requiresReview: boolean,
): CompletionEvidenceSummary => {
  const totalSteps = plan?.steps.length ?? results.length;
  const completed = results.filter((result) => result.status === 'completed' && !result.skipped);
  const skippedSteps = results.filter((result) => result.skipped).length;
  const failedResults = results.filter((result) => result.status === 'failed' && !result.skipped);
  const recoveredFailures = failedResults.filter((result) => result.recoveredByStepId
    && completed.some((candidate) => candidate.stepId === result.recoveredByStepId)).length;
  const failedSteps = Math.max(0, failedResults.length - recoveredFailures);
  const acceptanceCriteria = plan?.steps.reduce((sum, step) => sum + step.acceptanceCriteria.length, 0) ?? 0;
  const evidenceItems = completed.reduce((sum, result) => sum + result.evidence.length, 0);
  const structuredEvidence = completed.flatMap((result) => result.evidenceDetails ?? []);
  const verifiedEvidenceItems = structuredEvidence.filter((item) => item.verification === 'verified').length;
  const supportedEvidenceItems = structuredEvidence.filter((item) => item.verification === 'supported').length;
  const unverifiedEvidenceItems = structuredEvidence.filter((item) => item.verification === 'unverified').length;
  const contradictedEvidenceItems = structuredEvidence.filter((item) => item.verification === 'contradicted').length;
  const artifactRefs = completed.reduce((sum, result) => sum + (result.artifacts?.length ?? 0), 0);
  const toolReceipts = completed.reduce((sum, result) => sum + (result.toolCalls?.length ?? 0), 0);
  const reviewState: CompletionEvidenceSummary['review'] = !requiresReview
    ? 'not-required'
    : review?.approved ? 'approved' : review ? 'rejected' : 'pending';
  const gaps: string[] = [];
  if (failedSteps > 0) gaps.push(`${failedSteps} 个步骤未完成`);
  if (recoveredFailures > 0) gaps.push(`${recoveredFailures} 个失败步骤已由 Replanner 恢复`);
  if (skippedSteps > 0) gaps.push(`${skippedSteps} 个步骤按条件跳过`);
  if (completed.length > 0 && evidenceItems === 0) gaps.push('已完成步骤没有附带证据条目');
  if (contradictedEvidenceItems > 0) gaps.push(`${contradictedEvidenceItems} 条证据存在冲突`);
  if (structuredEvidence.length > 0 && verifiedEvidenceItems + supportedEvidenceItems === 0) gaps.push('结构化证据尚未得到工具或来源支持');
  if (requiresReview && reviewState !== 'approved') gaps.push('质量审核尚未通过');
  const status: CompletionEvidenceSummary['status'] = completed.length === 0
    ? 'unverified'
    : failedSteps > 0 || (requiresReview && reviewState !== 'approved')
      ? 'partial'
      : contradictedEvidenceItems > 0
        ? 'partial'
      : evidenceItems > 0 || artifactRefs > 0 || toolReceipts > 0 || !requiresReview
        ? 'verified'
        : 'unverified';
  return {
    status,
    totalSteps,
    completedSteps: completed.length,
    failedSteps,
    skippedSteps,
    acceptanceCriteria,
    evidenceItems,
    verifiedEvidenceItems,
    supportedEvidenceItems,
    unverifiedEvidenceItems,
    contradictedEvidenceItems,
    recoveredFailures,
    artifactRefs,
    toolReceipts,
    review: reviewState,
    gaps: gaps.slice(0, 8),
  };
};
