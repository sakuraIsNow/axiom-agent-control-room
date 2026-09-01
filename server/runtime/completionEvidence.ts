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
  const failedSteps = results.filter((result) => result.status === 'failed' && !result.skipped).length;
  const acceptanceCriteria = plan?.steps.reduce((sum, step) => sum + step.acceptanceCriteria.length, 0) ?? 0;
  const evidenceItems = completed.reduce((sum, result) => sum + result.evidence.length, 0);
  const artifactRefs = completed.reduce((sum, result) => sum + (result.artifacts?.length ?? 0), 0);
  const toolReceipts = completed.reduce((sum, result) => sum + (result.toolCalls?.length ?? 0), 0);
  const reviewState: CompletionEvidenceSummary['review'] = !requiresReview
    ? 'not-required'
    : review?.approved ? 'approved' : review ? 'rejected' : 'pending';
  const gaps: string[] = [];
  if (failedSteps > 0) gaps.push(`${failedSteps} 个步骤未完成`);
  if (skippedSteps > 0) gaps.push(`${skippedSteps} 个步骤按条件跳过`);
  if (completed.length > 0 && evidenceItems === 0) gaps.push('已完成步骤没有附带证据条目');
  if (requiresReview && reviewState !== 'approved') gaps.push('质量审核尚未通过');
  const status: CompletionEvidenceSummary['status'] = completed.length === 0
    ? 'unverified'
    : failedSteps > 0 || (requiresReview && reviewState !== 'approved')
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
    artifactRefs,
    toolReceipts,
    review: reviewState,
    gaps: gaps.slice(0, 8),
  };
};
