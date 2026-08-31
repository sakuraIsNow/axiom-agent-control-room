import type { AgentMode, ScheduledTrigger } from '../types';

const readJson = async <T>(response: Response, fallback: string) => {
  const body = await response.json().catch(() => null) as T & { error?: string } | null;
  if (!response.ok) throw new Error(body?.error ?? `${fallback} (${response.status})`);
  return body as T;
};

export async function listSchedules(signal?: AbortSignal) {
  const response = await fetch('/api/schedules', { signal });
  const body = await readJson<{ schedules?: ScheduledTrigger[] }>(response, '日程列表读取失败');
  return body.schedules ?? [];
}

export async function createSchedule(input: {
  sessionId: string;
  title: string;
  input: string;
  mode: AgentMode;
  intervalSeconds: number;
  enabled?: boolean;
}) {
  const response = await fetch('/api/schedules', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...input, enabled: input.enabled ?? true }),
  });
  return (await readJson<{ schedule: ScheduledTrigger }>(response, '日程创建失败')).schedule;
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
  const body = await readJson<{ schedule: ScheduledTrigger }>(response, '鏃ョ▼鎭㈠澶辫触');
  return body.schedule;
}
