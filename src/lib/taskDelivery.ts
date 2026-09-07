import type { WorkflowTask } from '../types';

export const taskHasPartialDelivery = (task: Pick<WorkflowTask, 'stepResults'>) => (task.stepResults ?? [])
  .some((step) => step.status === 'failed' || step.skipped || step.handoff?.status === 'partial' || step.handoff?.status === 'blocked');
