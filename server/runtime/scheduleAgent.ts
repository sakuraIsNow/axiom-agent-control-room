import { z } from 'zod';
import { scheduleCadenceSchema, type ScheduleCadence } from './scheduleCadence.js';

export const scheduleDraftSchema = z.object({
  title: z.string().min(1).max(120),
  input: z.string().min(1).max(20_000),
  mode: z.enum(['analyze', 'build', 'decide']),
  schedule: scheduleCadenceSchema,
  agentPolicy: z.literal('auto'),
  reason: z.string().min(1).max(600),
}).strict();

export type ScheduleDraft = z.infer<typeof scheduleDraftSchema>;

export const parseScheduleDraft = (content: string): ScheduleDraft => {
  const unfenced = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  try {
    return scheduleDraftSchema.parse(JSON.parse(unfenced));
  } catch (error) {
    const start = unfenced.indexOf('{');
    const end = unfenced.lastIndexOf('}');
    if (start >= 0 && end > start) return scheduleDraftSchema.parse(JSON.parse(unfenced.slice(start, end + 1)));
    throw error;
  }
};

const modeFor = (request: string): ScheduleDraft['mode'] => {
  if (/(?:创建|生成|制作|构建|写入|发布|绘图|视频|代码|实现)/i.test(request)) return 'build';
  if (/(?:决定|决策|选择|推荐|评估是否)/i.test(request)) return 'decide';
  return 'analyze';
};

const adjustedTime = (period: string, hourText: string, minuteText?: string) => {
  let hour = Number(hourText);
  const minute = Number(minuteText ?? 0);
  if ((period === '下午' || period === '晚上') && hour < 12) hour += 12;
  if (period === '中午' && hour < 11) hour += 12;
  if (hour > 23 || minute > 59) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
};

const titleFor = (request: string) => {
  const cleaned = request
    .replace(/^(?:请|帮我|请帮我)\s*/u, '')
    .replace(/(?:每天|每周[一二三四五六日天、至到-]*|每隔?\s*\d+\s*(?:分钟|小时|天))[^，。；;]{0,16}/u, '')
    .replace(/[，。；;].*$/u, '')
    .trim();
  return `${(cleaned || request).slice(0, 36)}${(cleaned || request).endsWith('日程') ? '' : '日程'}`;
};

const weekdayValues = (text: string) => {
  const numberByLabel: Record<string, number> = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };
  if (/一\s*(?:至|到|-)\s*五/u.test(text)) return [1, 2, 3, 4, 5];
  return [...new Set([...text].flatMap((label) => numberByLabel[label] === undefined ? [] : [numberByLabel[label]]))];
};

/**
 * A deliberately narrow fallback for common Chinese schedule phrases. It is
 * returned as an explicit fallback, never presented as a successful model run.
 */
export const fallbackScheduleDraft = (request: string, timezone = 'Asia/Shanghai'): ScheduleDraft | null => {
  const normalized = request.trim();
  if (!normalized) return null;
  let schedule: ScheduleCadence | null = null;

  const interval = normalized.match(/每(?:隔)?\s*(\d+)\s*(分钟|小时|天)/u);
  if (interval) {
    const multiplier = interval[2] === '天' ? 86_400 : interval[2] === '小时' ? 3_600 : 60;
    const seconds = Number(interval[1]) * multiplier;
    if (seconds >= 15 && seconds <= 31_536_000) schedule = { kind: 'interval', intervalSeconds: seconds, timezone };
  }

  const daily = normalized.match(/每天\s*(早上|上午|中午|下午|晚上)?\s*(\d{1,2})(?:[:：点时]\s*(\d{1,2})?\s*分?)?/u);
  if (!schedule && daily) {
    const timeOfDay = adjustedTime(daily[1] ?? '', daily[2]!, daily[3]);
    if (timeOfDay) schedule = { kind: 'daily', timeOfDay, timezone };
  }

  const weekly = normalized.match(/每周\s*([一二三四五六日天、至到\-]+)[^\d]{0,8}?(早上|上午|中午|下午|晚上)?\s*(\d{1,2})(?:[:：点时]\s*(\d{1,2})?\s*分?)?/u);
  if (!schedule && weekly) {
    const weekdays = weekdayValues(weekly[1]!);
    const timeOfDay = adjustedTime(weekly[2] ?? '', weekly[3]!, weekly[4]);
    if (weekdays.length && timeOfDay) schedule = { kind: 'weekly', weekdays, timeOfDay, timezone };
  }

  if (!schedule) return null;
  return scheduleDraftSchema.parse({
    title: titleFor(normalized),
    input: normalized,
    mode: modeFor(normalized),
    schedule,
    agentPolicy: 'auto',
    reason: '已识别常用时间表达；每次触发时由 Router Agent 与调度 Agent 根据当次目标自动选择所需 Agent 和 Skill。',
  });
};

export const scheduleAgentPrompt = (now: Date, timezone: string) => `你是 Axiom 的日程 Agent，只负责把用户的自然语言目标转换为可确认的日程草案，不执行任务。
当前服务端时间：${now.toISOString()}；用户时区：${timezone}。
要求：
1. 标题简短；input 只描述到点后要完成的目标，保留搜索范围、数量、格式、来源等约束。
2. mode 仅可为 analyze、build、decide。
3. schedule.kind 仅可为 once、interval、daily、weekly。once 使用带时区偏移的 ISO runAt；interval 使用 15 至 31536000 秒；daily/weekly 使用 HH:mm；weekdays 使用 0=周日、1=周一...6=周六。
4. timezone 使用用户提供的 IANA 时区。
5. agentPolicy 必须为 auto。不要固定绑定某个 Agent；真正执行时 Router Agent 会重新理解目标，调度 Agent 再选择最小充分的 Agent/Skill 集合。
6. 信息不足以确定执行时间时不要擅自猜测，说明缺少什么。
只返回严格 JSON，不要 Markdown：{"title":"...","input":"...","mode":"analyze|build|decide","schedule":{"kind":"daily","timeOfDay":"09:00","timezone":"${timezone}"},"agentPolicy":"auto","reason":"..."}`;
