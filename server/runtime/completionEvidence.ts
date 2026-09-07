import type { CompletionEvidenceSummary, ReviewResult, RuntimeEvent, StepResult, WorkflowPlan, WorkflowTask } from './contracts.js';
import { hasTraceableEvidence } from './evidenceValidation.js';

export type { CompletionEvidenceSummary } from './contracts.js';

export const hasCurrentHumanAcceptance = (task: Pick<WorkflowTask, 'id' | 'review'>, input: readonly RuntimeEvent[]) => {
  if (!task.review?.approved) return false;
  const events = input.filter((event) => event.taskId === task.id).sort((a, b) => a.sequence - b.sequence);
  const invalidation = events.filter((event) => ['plan.replanned', 'node.rerun_requested', 'node.retry_requested',
    'node.replace_requested', 'node.skip_requested', 'node.completed_manually'].includes(event.type)
    || event.type === 'checkpoint.merge_created' && event.payload.mergedTaskId === task.id
    || event.type === 'harness.connected' && event.payload.source === 'external-harness').at(-1)?.sequence ?? 0;
  const decision = events.filter((event) => event.type === 'review.approved' || event.type === 'review.rejected').at(-1);
  return decision?.type === 'review.approved' && decision.sequence > invalidation;
};

export const summarizeCompletionEvidence = (
  plan: WorkflowPlan | undefined,
  results: readonly StepResult[],
  review: ReviewResult | undefined,
  requiresReview: boolean,
  options: { taskId?: string; humanAccepted?: boolean } = {},
): CompletionEvidenceSummary => {
  const latestResults = [...new Map(results.map((result) => [result.stepId, result])).values()];
  const totalSteps = plan?.steps.length ?? latestResults.length;
  const completed = latestResults.filter((result) => result.status === 'completed' && !result.skipped);
  const skipped = latestResults.filter((result) => result.skipped);
  const skippedSteps = skipped.length;
  const failedResults = latestResults.filter((result) => result.status === 'failed' && !result.skipped);
  const recoveredFailures = failedResults.filter((result) => result.recoveredByStepId
    && completed.some((candidate) => candidate.stepId === result.recoveredByStepId)).length;
  const failedSteps = Math.max(0, failedResults.length - recoveredFailures);
  const acceptanceCriteria = plan?.steps.reduce((sum, step) => sum + step.acceptanceCriteria.length, 0) ?? 0;
  const evidenceItems = completed.reduce((sum, result) => sum + Math.max(result.evidence.length, result.evidenceDetails?.length ?? 0), 0);
  const supportedEvidenceItems = options.taskId ? completed.reduce((sum, result) => sum
    + (result.evidenceDetails ?? []).filter((item) => hasTraceableEvidence(item, options.taskId!, result.stepId)).length, 0) : 0;
  // There is no independent factual verifier here. Model labels and process exit codes cannot supply one.
  const verifiedEvidenceItems = 0;
  const contradictedEvidenceItems = 0;
  const unverifiedEvidenceItems = evidenceItems - supportedEvidenceItems;
  const artifactRefs = completed.reduce((sum, result) => sum + (result.artifacts?.length ?? 0), 0);
  const toolReceipts = completed.reduce((sum, result) => sum + (result.toolCalls?.length ?? 0), 0);
  const reviewState: CompletionEvidenceSummary['review'] = !requiresReview
    ? 'not-required'
    : review?.approved ? 'approved' : review ? 'rejected' : 'pending';
  const accountedSteps = new Set([...completed, ...skipped, ...failedResults.filter((result) => result.recoveredByStepId
    && completed.some((candidate) => candidate.stepId === result.recoveredByStepId))].map((result) => result.stepId));
  const missingSteps = plan?.steps.filter((step) => !accountedSteps.has(step.id)
    && !failedResults.some((result) => result.stepId === step.id)).length ?? 0;
  const partialHandoffs = completed.filter((result) => result.handoff && result.handoff.status !== 'complete').length;
  const execution: CompletionEvidenceSummary['execution'] = failedSteps > 0 || missingSteps > 0 || partialHandoffs > 0
    ? 'partial' : completed.length > 0 || skippedSteps > 0 ? 'completed' : 'unverified';
  const gaps: string[] = [];
  if (failedSteps > 0) gaps.push(`${failedSteps} 个步骤未完成`);
  if (missingSteps > 0) gaps.push(`${missingSteps} 个计划步骤缺少执行结果`);
  if (partialHandoffs > 0) gaps.push(`${partialHandoffs} 个步骤仍有未完成交接`);
  if (recoveredFailures > 0) gaps.push(`${recoveredFailures} 个失败步骤已由 Replanner 恢复`);
  if (skippedSteps > 0) gaps.push(`${skippedSteps} 个步骤按条件跳过`);
  if (completed.length > 0 && evidenceItems === 0) gaps.push('已完成步骤没有附带证据条目');
  if (evidenceItems > 0 && supportedEvidenceItems === 0) gaps.push('证据来源尚未核对');
  if (requiresReview && reviewState !== 'approved') gaps.push('质量审核尚未通过');
  const status: CompletionEvidenceSummary['status'] = execution === 'partial' || (requiresReview && reviewState !== 'approved')
    ? 'partial' : 'unverified';
  return {
    schemaVersion: 2,
    status,
    execution,
    acceptance: options.humanAccepted ? 'accepted' : 'not-recorded',
    evidenceStatus: supportedEvidenceItems > 0 ? 'supported' : 'unverified',
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

const evidenceStatuses = new Set<CompletionEvidenceSummary['status']>(['verified', 'partial', 'unverified', 'not-required']);
const evidenceReviews = new Set<CompletionEvidenceSummary['review']>(['approved', 'not-required', 'pending', 'rejected']);
const finiteCount = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;

export const parseCompletionEvidence = (value: unknown): CompletionEvidenceSummary | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  if (typeof source.status !== 'string' || !evidenceStatuses.has(source.status as CompletionEvidenceSummary['status'])) return undefined;
  if (typeof source.review !== 'string' || !evidenceReviews.has(source.review as CompletionEvidenceSummary['review'])) return undefined;
  const keys = ['totalSteps', 'completedSteps', 'failedSteps', 'skippedSteps', 'acceptanceCriteria', 'evidenceItems', 'artifactRefs', 'toolReceipts'] as const;
  const parsed = Object.fromEntries(keys.map((key) => [key, finiteCount(source[key])])) as Record<(typeof keys)[number], number | null>;
  if (Object.values(parsed).some((count) => count === null)) return undefined;
  const counts = parsed as Record<(typeof keys)[number], number>;
  const current = source.schemaVersion === 2;
  const countsIncomplete = counts.failedSteps > 0 || counts.completedSteps + counts.skippedSteps < counts.totalSteps;
  const execution = countsIncomplete ? 'partial'
    : current && (source.execution === 'partial' || source.execution === 'unverified') ? source.execution
      : counts.completedSteps + counts.skippedSteps > 0 ? 'completed' : 'unverified';
  const supportedEvidenceItems = current ? Math.min(counts.evidenceItems, finiteCount(source.supportedEvidenceItems) ?? 0) : 0;
  return {
    schemaVersion: 2,
    status: execution === 'partial' || source.review === 'rejected' || source.review === 'pending' ? 'partial' : 'unverified',
    execution,
    acceptance: current && source.acceptance === 'accepted' ? 'accepted' : 'not-recorded',
    evidenceStatus: supportedEvidenceItems > 0 ? 'supported' : 'unverified',
    ...counts,
    verifiedEvidenceItems: 0,
    supportedEvidenceItems,
    unverifiedEvidenceItems: counts.evidenceItems - supportedEvidenceItems,
    contradictedEvidenceItems: 0,
    recoveredFailures: finiteCount(source.recoveredFailures) ?? 0,
    review: source.review as CompletionEvidenceSummary['review'],
    gaps: Array.isArray(source.gaps) && source.gaps.every((gap) => typeof gap === 'string') ? source.gaps.slice(0, 8) as string[] : [],
  };
};

export const canReuseCompletionArtifact = (summary: Pick<CompletionEvidenceSummary, 'schemaVersion' | 'execution' | 'acceptance' | 'evidenceStatus'> | undefined) => summary?.schemaVersion === 2
  && summary.execution === 'completed'
  && (summary.acceptance === 'accepted' || summary.evidenceStatus === 'supported');
