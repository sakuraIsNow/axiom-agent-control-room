import type { AgentMode, ScheduleCadence, ScheduleDraft, ScheduleHealthActionAudit, ScheduleInsights, ScheduledTrigger, WorkflowTaskSummary } from '../types';

const readJson = async <T>(response: Response, fallback: string) => {
  const body = await response.json().catch(() => null) as T & { error?: string } | null;
  if (!response.ok) throw new Error(body?.error ?? `${fallback} (${response.status})`);
  return body as T;
};

export async function listSchedules(signal?: AbortSignal) {
  const response = await fetch('/api/schedules', { signal });
  const body = await readJson<{ schedules?: ScheduledTrigger[]; latestRuns?: Record<string, WorkflowTaskSummary>; healthActions?: ScheduleHealthActionAudit[] }>(response, '日程列表读取失败');
  return { schedules: body.schedules ?? [], latestRuns: body.latestRuns ?? {}, healthActions: body.healthActions ?? [] };
}

export async function getScheduleInsights(days = 35, signal?: AbortSignal) {
  const safeDays = Math.min(42, Math.max(1, Math.floor(days)));
  const response = await fetch(`/api/schedules/insights?days=${safeDays}`, { signal });
  return readJson<ScheduleInsights>(response, '日程计划读取失败');
}

export async function applyScheduleHealthAction(scheduleId: string, suggestionId: string) {
  const response = await fetch(`/api/schedules/${encodeURIComponent(scheduleId)}/health-action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ suggestionId }),
  });
  return readJson<{ schedule: ScheduledTrigger; applied: ScheduleHealthActionAudit }>(response, '日程调整失败');
}

export async function draftSchedule(input: { request: string; sessionId: string; timezone?: string; modelCredentialId?: string }) {
  const response = await fetch('/api/schedules/draft', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...input, timezone: input.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'Asia/Shanghai' }),
  });
  return readJson<{ draft: ScheduleDraft; source: 'schedule-agent' | 'deterministic-fallback'; warning?: string; createsSchedule: false }>(response, '日程草案生成失败');
}

export async function createSchedule(input: {
  sessionId: string;
  title: string;
  input: string;
  mode: AgentMode;
  modelCredentialId?: string;
  inputArtifactTaskId?: string;
  cadence?: ScheduleCadence;
  intervalSeconds?: number;
  enabled?: boolean;
}) {
  const response = await fetch('/api/schedules', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...input, enabled: input.enabled ?? true }),
  });
  return (await readJson<{ schedule: ScheduledTrigger }>(response, '日程创建失败')).schedule;
}

export type ScheduleArtifactCandidate = {
  artifactId: string;
  taskId: string;
  sourceScheduleId?: string;
  title: string;
  createdAt: string;
  bytes: number;
  revision: number;
};

export async function listScheduleArtifactInputs(signal?: AbortSignal) {
  const response = await fetch('/api/schedules/artifact-inputs?limit=50', { signal });
  return (await readJson<{ artifacts?: ScheduleArtifactCandidate[] }>(response, '可接续结果读取失败')).artifacts ?? [];
}

export async function removeSchedule(scheduleId: string) {
  const response = await fetch(`/api/schedules/${encodeURIComponent(scheduleId)}`, { method: 'DELETE' });
  if (!response.ok && response.status !== 204) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error ?? `日程删除失败 (${response.status})`);
  }
}

export async function resumeSchedule(scheduleId: string) {
  const response = await fetch(`/api/schedules/${encodeURIComponent(scheduleId)}/resume`, { method: 'POST' });
  const body = await readJson<{ schedule: ScheduledTrigger }>(response, '日程恢复失败');
  return body.schedule;
}

const requestId = () => typeof crypto !== 'undefined' && 'randomUUID' in crypto
  ? crypto.randomUUID()
  : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

export async function runSchedule(scheduleId: string) {
  const response = await fetch(`/api/schedules/${encodeURIComponent(scheduleId)}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idempotencyKey: requestId() }),
  });
  return readJson<{ task: WorkflowTaskSummary; eventsUrl: string; deduplicated: boolean }>(response, '日程立即运行失败');
}

export async function listScheduleRuns(scheduleId: string, signal?: AbortSignal) {
  const response = await fetch(`/api/schedules/${encodeURIComponent(scheduleId)}/runs?limit=20`, { signal });
  return (await readJson<{ runs?: WorkflowTaskSummary[] }>(response, '日程运行记录读取失败')).runs ?? [];
}
