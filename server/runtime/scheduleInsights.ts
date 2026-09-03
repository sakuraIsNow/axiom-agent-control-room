import { createHash } from 'node:crypto';
import { nextRunAtForCadence, type ScheduleCadence } from './scheduleCadence.js';
import type { ScheduledTrigger } from './scheduler.js';

export type ScheduleRunInsight = {
  id: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  durationMs: number;
  tokens: { total: number };
  evidenceSummary?: { status: 'verified' | 'partial' | 'unverified' | 'not-required' };
};

export type ScheduleOccurrence = {
  id: string;
  scheduleId: string;
  title: string;
  startsAt: string;
  estimatedDurationMinutes: number;
  estimatedLoad: number;
  windowLoad: number;
  capacity: 'available' | 'busy' | 'overloaded';
  conflictScheduleIds: string[];
};

export type ScheduleCapacityConflict = {
  id: string;
  startsAt: string;
  endsAt: string;
  load: number;
  limit: number;
  scheduleIds: string[];
  titles: string[];
};

export type ScheduleHealthSuggestion = {
  id: string;
  scheduleId: string;
  kind: 'failure_streak' | 'cost_spike' | 'quality_decline' | 'capacity_conflict';
  severity: 'attention' | 'warning';
  title: string;
  reason: string;
  evidence: string[];
  recommendedAction: 'pause' | 'resume' | 'reschedule';
  actionLabel: string;
  proposedCadence?: ScheduleCadence;
};

export type ScheduleInsights = {
  generatedAt: string;
  range: { from: string; to: string; days: number; truncated: boolean };
  capacity: { limit: number; peakLoad: number; busyWindows: number; overloadedWindows: number };
  occurrences: ScheduleOccurrence[];
  conflicts: ScheduleCapacityConflict[];
  suggestions: ScheduleHealthSuggestion[];
};

const modeLoad: Record<ScheduledTrigger['mode'], number> = { analyze: 1, decide: 1, build: 2 };
const validNumber = (value: number, fallback = 0) => Number.isFinite(value) ? value : fallback;
const average = (values: number[]) => values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const boundedDays = (days: number) => Math.min(42, Math.max(1, Math.floor(validNumber(days, 7))));
const digest = (parts: unknown[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 20);
const bucketStart = (timestamp: string) => {
  const date = new Date(timestamp);
  date.setUTCMinutes(Math.floor(date.getUTCMinutes() / 30) * 30, 0, 0);
  return date.toISOString();
};

const nextOccurrence = (schedule: ScheduledTrigger, after: Date) => nextRunAtForCadence(schedule.cadence, after);

const occurrencesFor = (schedule: ScheduledTrigger, from: Date, to: Date, max = 64) => {
  if (!schedule.enabled || schedule.lastRunStatus === 'dead-letter') return { values: [] as string[], truncated: false };
  let cursor = Date.parse(schedule.nextRunAt) >= from.getTime()
    ? new Date(schedule.nextRunAt).toISOString()
    : nextOccurrence(schedule, new Date(from.getTime() - 1));
  const values: string[] = [];
  let truncated = false;
  while (cursor && Date.parse(cursor) <= to.getTime()) {
    if (Date.parse(cursor) >= from.getTime()) values.push(cursor);
    if (values.length >= max) {
      truncated = Boolean(nextOccurrence(schedule, new Date(cursor)));
      break;
    }
    cursor = nextOccurrence(schedule, new Date(cursor));
  }
  return { values, truncated };
};

const loadFor = (schedule: ScheduledTrigger, latest?: ScheduleRunInsight) => {
  const tokenLoad = (latest?.tokens.total ?? 0) >= 60_000 ? 2 : (latest?.tokens.total ?? 0) >= 20_000 ? 1 : 0;
  const durationLoad = (latest?.durationMs ?? 0) >= 10 * 60_000 ? 1 : 0;
  return Math.min(5, modeLoad[schedule.mode] + tokenLoad + durationLoad);
};

const durationFor = (latest?: ScheduleRunInsight) => Math.round(Math.min(120, Math.max(5, (latest?.durationMs ?? 15 * 60_000) / 60_000)));

const shiftedCadence = (cadence: ScheduleCadence): ScheduleCadence => {
  if (cadence.kind === 'once') {
    return { ...cadence, runAt: new Date(Date.parse(cadence.runAt) + 30 * 60_000).toISOString() };
  }
  if (cadence.kind === 'interval') {
    return { ...cadence, intervalSeconds: Math.min(31_536_000, Math.max(15, cadence.intervalSeconds * 2)) };
  }
  const [hour, minute] = cadence.timeOfDay.split(':').map(Number);
  const current = hour * 60 + minute;
  const shifted = current >= 23 * 60 + 30 ? current - 30 : current + 30;
  const timeOfDay = `${String(Math.floor(shifted / 60)).padStart(2, '0')}:${String(shifted % 60).padStart(2, '0')}`;
  return { ...cadence, timeOfDay };
};

const suggestion = (
  schedule: ScheduledTrigger,
  kind: ScheduleHealthSuggestion['kind'],
  values: Omit<ScheduleHealthSuggestion, 'id' | 'scheduleId' | 'kind'>,
  evidenceKey: unknown,
): ScheduleHealthSuggestion => ({
  id: `schedule-health:${digest([schedule.id, kind, evidenceKey, values.recommendedAction, values.proposedCadence])}`,
  scheduleId: schedule.id,
  kind,
  ...values,
});

export const buildScheduleInsights = ({
  schedules,
  runsBySchedule = {},
  now = new Date(),
  days = 35,
  capacityLimit = 4,
}: {
  schedules: ScheduledTrigger[];
  runsBySchedule?: Record<string, ScheduleRunInsight[]>;
  now?: Date;
  days?: number;
  capacityLimit?: number;
}): ScheduleInsights => {
  const safeDays = boundedDays(days);
  const safeCapacity = Math.min(32, Math.max(1, Math.floor(validNumber(capacityLimit, 4))));
  const from = new Date(now);
  const to = new Date(from.getTime() + safeDays * 86_400_000);
  let truncated = false;
  const raw = schedules.flatMap((schedule) => {
    const expanded = occurrencesFor(schedule, from, to);
    truncated ||= expanded.truncated;
    const latest = runsBySchedule[schedule.id]?.[0];
    return expanded.values.map((startsAt) => ({
      schedule,
      startsAt,
      estimatedLoad: loadFor(schedule, latest),
      estimatedDurationMinutes: durationFor(latest),
    }));
  }).sort((left, right) => Date.parse(left.startsAt) - Date.parse(right.startsAt)).slice(0, 500);
  if (raw.length >= 500) truncated = true;

  const windows = new Map<string, typeof raw>();
  for (const item of raw) {
    const key = bucketStart(item.startsAt);
    windows.set(key, [...(windows.get(key) ?? []), item]);
  }

  const conflicts: ScheduleCapacityConflict[] = [];
  let peakLoad = 0;
  let busyWindows = 0;
  let overloadedWindows = 0;
  const windowState = new Map<string, { load: number; capacity: ScheduleOccurrence['capacity']; ids: string[] }>();
  for (const [startsAt, items] of windows) {
    const load = items.reduce((sum, item) => sum + item.estimatedLoad, 0);
    peakLoad = Math.max(peakLoad, load);
    const capacity = load > safeCapacity ? 'overloaded' : load >= Math.max(2, Math.ceil(safeCapacity * 0.75)) ? 'busy' : 'available';
    if (capacity === 'busy') busyWindows += 1;
    if (capacity === 'overloaded') overloadedWindows += 1;
    const ids = [...new Set(items.map((item) => item.schedule.id))];
    windowState.set(startsAt, { load, capacity, ids });
    if (capacity === 'overloaded' && ids.length > 1) {
      conflicts.push({
        id: `capacity:${digest([startsAt, ids])}`,
        startsAt,
        endsAt: new Date(Date.parse(startsAt) + 30 * 60_000).toISOString(),
        load,
        limit: safeCapacity,
        scheduleIds: ids,
        titles: [...new Set(items.map((item) => item.schedule.title))],
      });
    }
  }

  const occurrences: ScheduleOccurrence[] = raw.map((item) => {
    const window = windowState.get(bucketStart(item.startsAt))!;
    return {
      id: `${item.schedule.id}:${item.startsAt}`,
      scheduleId: item.schedule.id,
      title: item.schedule.title,
      startsAt: item.startsAt,
      estimatedDurationMinutes: item.estimatedDurationMinutes,
      estimatedLoad: item.estimatedLoad,
      windowLoad: window.load,
      capacity: window.capacity,
      conflictScheduleIds: window.ids.filter((id) => id !== item.schedule.id),
    };
  });

  const suggestions: ScheduleHealthSuggestion[] = [];
  for (const schedule of schedules) {
    const runs = (runsBySchedule[schedule.id] ?? []).filter((run) => ['completed', 'failed', 'cancelled'].includes(run.status));
    if (schedule.lastRunStatus === 'dead-letter') {
      suggestions.push(suggestion(schedule, 'failure_streak', {
        severity: 'attention',
        title: '检查后恢复日程',
        reason: `“${schedule.title}”连续失败 ${schedule.failureCount} 次，系统已停止自动触发。`,
        evidence: [`连续失败 ${schedule.failureCount} 次`, schedule.lastRunAt ? `最近运行 ${schedule.lastRunAt}` : '没有可用运行时间'],
        recommendedAction: 'resume',
        actionLabel: '确认恢复',
      }, [schedule.failureCount, schedule.deadLetteredAt]));
    } else if (schedule.enabled && schedule.failureCount >= 2) {
      suggestions.push(suggestion(schedule, 'failure_streak', {
        severity: 'attention',
        title: '暂停日程以免持续失败',
        reason: `“${schedule.title}”已连续失败 ${schedule.failureCount} 次，暂停后可先检查模型、搜索或工具服务。`,
        evidence: [`连续失败 ${schedule.failureCount} 次`, schedule.lastError ? '最近一次运行有错误回执' : '运行未形成可验证结果'],
        recommendedAction: 'pause',
        actionLabel: '确认暂停',
      }, [schedule.failureCount, schedule.lastRunAt]));
    }

    if (schedule.enabled && runs.length >= 4) {
      const recent = runs.slice(0, 2);
      const baseline = runs.slice(2, 6);
      const recentTokens = average(recent.map((run) => run.tokens.total));
      const baselineTokens = average(baseline.map((run) => run.tokens.total));
      if (baselineTokens >= 1_000 && recentTokens >= Math.max(10_000, baselineTokens * 1.75)) {
        const proposedCadence = shiftedCadence(schedule.cadence);
        suggestions.push(suggestion(schedule, 'cost_spike', {
          severity: 'warning',
          title: '降低高成本日程频率',
          reason: `“${schedule.title}”最近两次平均 Token 明显高于此前运行。`,
          evidence: [`近期平均 ${Math.round(recentTokens).toLocaleString()} Token`, `此前平均 ${Math.round(baselineTokens).toLocaleString()} Token`],
          recommendedAction: 'reschedule',
          actionLabel: '确认调整',
          proposedCadence,
        }, [recent.map((run) => run.id), Math.round(recentTokens), Math.round(baselineTokens)]));
      }

      const recentQuality = recent.map((run) => run.evidenceSummary?.status);
      const baselineVerified = baseline.some((run) => run.evidenceSummary?.status === 'verified');
      if (baselineVerified && recentQuality.every((status) => status === 'partial' || status === 'unverified')) {
        suggestions.push(suggestion(schedule, 'quality_decline', {
          severity: 'attention',
          title: '暂停并检查交付质量',
          reason: `“${schedule.title}”最近两次没有形成完整验证结果，而此前运行曾通过验证。`,
          evidence: ['最近两次为部分验证或未验证', '此前运行存在已验证交付'],
          recommendedAction: 'pause',
          actionLabel: '确认暂停',
        }, recent.map((run) => [run.id, run.evidenceSummary?.status])));
      }
    }

    const conflict = conflicts.find((item) => item.scheduleIds.includes(schedule.id));
    if (conflict && schedule.enabled) {
      const proposedCadence = shiftedCadence(schedule.cadence);
      suggestions.push(suggestion(schedule, 'capacity_conflict', {
        severity: 'warning',
        title: '错开集中执行时间',
        reason: `“${schedule.title}”与 ${conflict.scheduleIds.length - 1} 个日程集中在同一执行窗口，预计负载 ${conflict.load}/${conflict.limit}。`,
        evidence: [`冲突时间 ${conflict.startsAt}`, `同时执行：${conflict.titles.join('、')}`],
        recommendedAction: 'reschedule',
        actionLabel: '确认错开',
        proposedCadence,
      }, [conflict.id, proposedCadence]));
    }
  }

  return {
    generatedAt: now.toISOString(),
    range: { from: from.toISOString(), to: to.toISOString(), days: safeDays, truncated },
    capacity: { limit: safeCapacity, peakLoad, busyWindows, overloadedWindows },
    occurrences,
    conflicts,
    suggestions: suggestions.sort((left, right) => left.severity === right.severity ? left.title.localeCompare(right.title, 'zh-CN') : left.severity === 'attention' ? -1 : 1),
  };
};
