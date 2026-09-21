import type { WorkflowTask } from '../types';

export const taskHasPartialDelivery = (task: Pick<WorkflowTask, 'stepResults' | 'review'>) => {
  const receipt = task.review?.delivery;
  return Boolean(receipt && (receipt.status !== 'passed' || receipt.runtimeExecution !== 'completed'
    || receipt.upstreamReviewApproved === false || receipt.runtimeGaps?.length))
    || (task.stepResults ?? []).some((step) => step.status === 'failed' || step.skipped || step.handoff?.status === 'partial' || step.handoff?.status === 'blocked');
};
