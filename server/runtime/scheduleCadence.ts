import { z } from 'zod';

const timeOfDaySchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, 'timeOfDay must use HH:mm.');
const timezoneSchema = z.string().min(1).max(100).refine((value) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}, 'timezone must be a valid IANA timezone.');

export const scheduleCadenceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('once'),
    runAt: z.string().refine((value) => Number.isFinite(Date.parse(value)), 'runAt must be an ISO date-time.'),
    timezone: timezoneSchema,
  }).strict(),
  z.object({
    kind: z.literal('interval'),
    intervalSeconds: z.number().int().min(15).max(31_536_000),
    timezone: timezoneSchema,
  }).strict(),
  z.object({
    kind: z.literal('daily'),
    timeOfDay: timeOfDaySchema,
    timezone: timezoneSchema,
  }).strict(),
  z.object({
    kind: z.literal('weekly'),
    timeOfDay: timeOfDaySchema,
    weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7)
      .refine((values) => new Set(values).size === values.length, 'weekdays must be unique.'),
    timezone: timezoneSchema,
  }).strict(),
]);

export type ScheduleCadence = z.infer<typeof scheduleCadenceSchema>;

type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

const formatters = new Map<string, Intl.DateTimeFormat>();

const formatterFor = (timezone: string) => {
  const existing = formatters.get(timezone);
  if (existing) return existing;
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  formatters.set(timezone, formatter);
  return formatter;
};

const zonedParts = (date: Date, timezone: string): ZonedParts => {
  const values = Object.fromEntries(
    formatterFor(timezone).formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  ) as Partial<ZonedParts>;
  return {
    year: values.year!,
    month: values.month!,
    day: values.day!,
    hour: values.hour!,
    minute: values.minute!,
    second: values.second!,
  };
};

const localDatePlusDays = (parts: Pick<ZonedParts, 'year' | 'month' | 'day'>, days: number) => {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
};

const localDateToUtc = (parts: ZonedParts, timezone: string) => {
  const target = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  let candidate = target;
  // Time-zone offsets can cross a day boundary and can change around DST.
  // Re-evaluating the formatted candidate converges without a timezone package.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = zonedParts(new Date(candidate), timezone);
    const actualAsUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
    const correction = target - actualAsUtc;
    if (correction === 0) break;
    candidate += correction;
  }
  return new Date(candidate);
};

const atLocalTime = (
  date: Pick<ZonedParts, 'year' | 'month' | 'day'>,
  timeOfDay: string,
  timezone: string,
) => {
  const [hour, minute] = timeOfDay.split(':').map(Number);
  return localDateToUtc({ ...date, hour: hour!, minute: minute!, second: 0 }, timezone);
};

export const legacyIntervalCadence = (intervalSeconds: number, timezone = 'Asia/Shanghai'): ScheduleCadence => ({
  kind: 'interval',
  intervalSeconds: Math.max(15, Math.min(31_536_000, Math.floor(intervalSeconds))),
  timezone,
});

export const normalizeScheduleCadence = (input: {
  cadence?: unknown;
  intervalSeconds?: number;
  timezone?: string;
}): ScheduleCadence => {
  if (input.cadence !== undefined) return scheduleCadenceSchema.parse(input.cadence);
  return legacyIntervalCadence(input.intervalSeconds ?? 3_600, input.timezone ?? 'Asia/Shanghai');
};

/** A compatibility/backoff interval for persisted legacy columns. */
export const cadenceIntervalSeconds = (cadence: ScheduleCadence) => {
  if (cadence.kind === 'interval') return cadence.intervalSeconds;
  if (cadence.kind === 'weekly') return 7 * 24 * 60 * 60;
  if (cadence.kind === 'daily') return 24 * 60 * 60;
  return 60;
};

/** Returns the first cadence occurrence strictly after `after`. */
export const nextRunAtForCadence = (cadence: ScheduleCadence, after: Date): string | null => {
  const afterMs = after.getTime();
  if (!Number.isFinite(afterMs)) throw new Error('Cannot calculate a schedule from an invalid date.');
  if (cadence.kind === 'once') {
    const runAt = Date.parse(cadence.runAt);
    return runAt > afterMs ? new Date(runAt).toISOString() : null;
  }
  if (cadence.kind === 'interval') {
    return new Date(afterMs + cadence.intervalSeconds * 1_000).toISOString();
  }

  const localNow = zonedParts(after, cadence.timezone);
  if (cadence.kind === 'daily') {
    let localDate = { year: localNow.year, month: localNow.month, day: localNow.day };
    let candidate = atLocalTime(localDate, cadence.timeOfDay, cadence.timezone);
    if (candidate.getTime() <= afterMs) {
      localDate = localDatePlusDays(localDate, 1);
      candidate = atLocalTime(localDate, cadence.timeOfDay, cadence.timezone);
    }
    return candidate.toISOString();
  }

  const allowed = new Set(cadence.weekdays);
  const localDate = { year: localNow.year, month: localNow.month, day: localNow.day };
  for (let offset = 0; offset <= 7; offset += 1) {
    const date = localDatePlusDays(localDate, offset);
    const weekday = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
    if (!allowed.has(weekday)) continue;
    const candidate = atLocalTime(date, cadence.timeOfDay, cadence.timezone);
    if (candidate.getTime() > afterMs) return candidate.toISOString();
  }
  throw new Error('Unable to calculate the next weekly schedule occurrence.');
};

export const cadenceDescription = (cadence: ScheduleCadence) => {
  if (cadence.kind === 'once') return `单次执行 · ${new Date(cadence.runAt).toLocaleString('zh-CN', { timeZone: cadence.timezone })}`;
  if (cadence.kind === 'interval') {
    if (cadence.intervalSeconds % 3_600 === 0) return `每 ${cadence.intervalSeconds / 3_600} 小时`;
    if (cadence.intervalSeconds % 60 === 0) return `每 ${cadence.intervalSeconds / 60} 分钟`;
    return `每 ${cadence.intervalSeconds} 秒`;
  }
  if (cadence.kind === 'daily') return `每天 ${cadence.timeOfDay}`;
  const labels = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  return `${cadence.weekdays.map((day) => labels[day]).join('、')} ${cadence.timeOfDay}`;
};
