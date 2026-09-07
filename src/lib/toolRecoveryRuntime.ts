export type ToolRecoveryRecord = {
  id: string;
  stepId: string;
  toolName: string;
  status: 'executing' | 'completed' | 'outcome_unknown' | 'retryable';
  revision: number;
  attempts: number;
  updatedAt: string;
  receiptSource?: 'tool' | 'human-confirmed';
  requiresReview: boolean;
  resolution: { decision: 'confirmed-completed' | 'confirmed-not-executed'; resolvedAt: string } | null;
};
export type ToolRecoverySnapshot = { enabled: boolean; canResume: boolean; executions: ToolRecoveryRecord[] };

export const getToolRecovery = async (taskId: string, signal?: AbortSignal): Promise<ToolRecoverySnapshot> => {
  const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/tools/executions`, { signal });
  const body = await response.json().catch(() => null);
  if (!response.ok || !Array.isArray(body?.executions)) throw new Error(body?.error ?? '执行记录暂时不可用。');
  return body as ToolRecoverySnapshot;
};

export const resolveToolRecovery = async (taskId: string, record: ToolRecoveryRecord, decision: 'confirmed-completed' | 'confirmed-not-executed', note: string) => {
  const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/tools/executions/${encodeURIComponent(record.id)}/resolve`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision: record.revision, decision, note }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error ?? '核对结果未保存。');
};

export const resumeAfterToolRecovery = async (taskId: string, expectedRevision?: number) => {
  const response = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/tools/resume`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision }) });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error ?? '任务暂时不能继续。');
};
