import type { WorkflowTaskSummary } from '../types';

export const canHumanReviewTask = (
  task: Pick<WorkflowTaskSummary, 'id' | 'status'> | null,
  reviewResult: unknown,
  reviewApprovalTaskId: string | null,
) => Boolean(
  task
  && task.status === 'waiting_for_human'
  && reviewResult
  && reviewApprovalTaskId === task.id,
);
