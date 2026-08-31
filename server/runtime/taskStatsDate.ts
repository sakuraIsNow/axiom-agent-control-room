import type { TaskStatsDaily } from './contracts.js';

export const DEFAULT_RUNTIME_TIME_ZONE = 'Asia/Shanghai';

export const runtimeTimeZone = () => {
  const configured = process.env.AXIOM_TIME_ZONE?.trim() || DEFAULT_RUNTIME_TIME_ZONE;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: configured }).format(0);
    return configured;
  } catch {
    return DEFAULT_RUNTIME_TIME_ZONE;
  }
};

export const dateKeyInTimeZone = (timestamp: string | number | Date, timeZone = runtimeTimeZone()) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(timestamp));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
};

export const recentDateKeys = (days: number, now = Date.now(), timeZone = runtimeTimeZone()) => {
  const safeDays = Math.min(31, Math.max(1, Math.floor(days)));
  const [year, month, day] = dateKeyInTimeZone(now, timeZone).split('-').map(Number);
  return Array.from({ length: safeDays }, (_, index) => {
    const offset = safeDays - index - 1;
    return new Date(Date.UTC(year, month - 1, day - offset)).toISOString().slice(0, 10);
  });
};

export const fillTaskStatsDaily = (
  values: Iterable<TaskStatsDaily>,
  days: number,
  now = Date.now(),
  timeZone = runtimeTimeZone(),
) => {
  const totals = new Map<string, TaskStatsDaily>();
  for (const value of values) {
    const current = totals.get(value.date);
    totals.set(value.date, {
      date: value.date,
      totalTokens: (current?.totalTokens ?? 0) + value.totalTokens,
      estimatedCostUsd: Number(((current?.estimatedCostUsd ?? 0) + value.estimatedCostUsd).toFixed(6)),
    });
  }
  return recentDateKeys(days, now, timeZone).map((date) => totals.get(date) ?? {
    date,
    totalTokens: 0,
    estimatedCostUsd: 0,
  });
};
