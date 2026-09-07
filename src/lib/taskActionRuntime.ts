import type { WorkflowTask } from '../types';

export type TaskHumanAction = 'approve-plan' | 'reject-plan' | 'approve-tool' | 'reject-tool' | 'approve-review' | 'reject-review' | 'resume' | 'replan';
export class TaskActionError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

export async function getTaskHumanSnapshot(taskId: string, signal?: AbortSignal) {
  const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}`, { signal });
  const body = await response.json().catch(() => null) as { task?: WorkflowTask; actionPermissions?: { canManage: boolean }; error?: string } | null;
  if (!response.ok || !body?.task) throw new TaskActionError(response.status, body?.error ?? 'Task state is unavailable.');
  return { task: body.task, canManage: body.actionPermissions?.canManage === true };
}

export const taskNeedsHumanAction = (task: Pick<WorkflowTask, 'status' | 'plan' | 'toolApprovals' | 'review'>) => {
  const terminal = ['completed', 'failed', 'cancelled'].includes(task.status);
  return {
    plan: !terminal && ['awaiting_approval', 'paused'].includes(task.status) && task.plan?.approvalStatus === 'pending',
    planRejected: !terminal && task.plan?.approvalStatus === 'rejected',
    tools: terminal ? [] : (task.toolApprovals ?? []).filter((approval) => approval.status === 'pending'),
    review: !terminal && ['waiting_for_human', 'paused'].includes(task.status) && task.review?.approved === false,
    paused: task.status === 'paused',
  };
};

export async function submitTaskHumanAction(task: Pick<WorkflowTask, 'id' | 'revision'>, action: TaskHumanAction, note: string, approvalId?: string) {
  if (!Number.isInteger(task.revision)) throw new TaskActionError(409, 'The task revision is unavailable.');
  const response = await fetch(`/api/tasks/${encodeURIComponent(task.id)}/${action}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ expectedRevision: task.revision, note, ...(approvalId ? { approvalId } : {}), ...(action === 'replan' ? { instruction: note, preserveCompleted: true } : {}) }),
  });
  const body = await response.json().catch(() => null) as { task?: WorkflowTask; event?: { sequence: number }; error?: string } | null;
  if (!response.ok || !body?.task) throw new TaskActionError(response.status, body?.error ?? 'Task action was not completed.');
  return { task: body.task, afterSequence: body.event?.sequence };
}
