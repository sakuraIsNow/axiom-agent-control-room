/**
 * Bounded conversation context for model calls.
 *
 * The UI keeps the complete transcript for history. This module only changes
 * the copy sent to a model when the transcript is large enough to exceed the
 * useful context window. Older turns become a deterministic, auditable
 * summary while the newest turns remain verbatim.
 */

export type ContextPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url?: { url?: string } }
  | { type: 'file'; file?: { file_id?: string } };

export type ContextMessage = {
  role: 'user' | 'assistant';
  content: string | ContextPart[];
};

export type ContextWindowOptions = {
  recentMessages?: number;
  triggerMessages?: number;
  maxMessages?: number;
  maxCharacters?: number;
  maxSummaryCharacters?: number;
  /** Model tokenizer hook. The default is a conservative, deterministic estimate. */
  tokenizer?: (text: string) => number;
  maxTokens?: number;
  summaryVersion?: string;
};

export type ContextWindowResult<T extends ContextMessage> = {
  messages: T[];
  summaryApplied: boolean;
  summarizedMessages: number;
  summaryCharacters: number;
  estimatedTokens: number;
  summaryVersion: string | null;
  summaryCoverage: { start: number; end: number; total: number } | null;
};

/**
 * Approximate common BPE behavior without importing a provider-specific
 * tokenizer. CJK/emoji code points are counted individually; ASCII runs are
 * charged at roughly four characters per token and punctuation gets one.
 * Deployments can provide an exact tokenizer through `ContextWindowOptions`.
 */
export const estimateTokens = (text: string): number => {
  let tokens = 0;
  let asciiRun = 0;
  const flushAscii = () => {
    if (asciiRun > 0) {
      tokens += Math.ceil(asciiRun / 4);
      asciiRun = 0;
    }
  };
  for (const character of text) {
    const codePoint = character.codePointAt(0) ?? 0;
    const isAsciiWord = codePoint <= 0x7f && /[A-Za-z0-9_]/.test(character);
    if (isAsciiWord) {
      asciiRun += 1;
      continue;
    }
    flushAscii();
    if (/\s/.test(character)) continue;
    tokens += codePoint > 0x7f ? 1 : 1;
  }
  flushAscii();
  return tokens;
};

const defaults = {
  recentMessages: 12,
  triggerMessages: 16,
  maxMessages: 24,
  maxCharacters: 48_000,
  maxSummaryCharacters: 8_000,
  tokenizer: estimateTokens,
  maxTokens: 12_000,
  summaryVersion: 'deterministic-v2',
} as const;

const normalize = (value: string) => value
  .replace(/\u0000/g, '')
  .replace(/[ \t]+/g, ' ')
  .replace(/\n{3,}/g, '\n\n')
  .trim();

export const messageText = (message: ContextMessage) => {
  if (typeof message.content === 'string') return normalize(message.content);
  const parts = message.content ?? [];
  const text = parts
    .filter((part): part is { type: 'text'; text: string } => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
  const mediaCount = parts.filter((part) => part.type === 'image_url' || part.type === 'file').length;
  const mediaNote = mediaCount > 0 ? ` [附件 ${mediaCount} 项]` : '';
  return normalize(`${text}${mediaNote}`);
};

const bounded = (value: string, limit: number) => {
  if (value.length <= limit) return value;
  if (limit <= 40) return value.slice(0, Math.max(0, limit));
  const marker = '\n…[中间内容已压缩]…\n';
  const available = Math.max(0, limit - marker.length);
  const head = Math.ceil(available * 0.58);
  const tail = Math.max(0, available - head);
  return `${value.slice(0, head)}${marker}${tail ? value.slice(-tail) : ''}`.slice(0, limit);
};

const dedupeKey = (value: string) => value
  .toLocaleLowerCase()
  .replace(/\s+/g, ' ')
  .replace(/[，。！？、,.!?;；:：]+/g, '')
  .trim();

/** Build a compact, deterministic summary of the oldest turns. */
export const summarizeMessages = (
  messages: ContextMessage[],
  maxCharacters: number = defaults.maxSummaryCharacters,
) => {
  const opening = '【历史上下文摘要】\n';
  const closing = '\n\n以上是较早对话的压缩记录；如与最近消息冲突，以最近消息为准。';
  const contentBudget = Math.max(120, maxCharacters - opening.length - closing.length);
  const seen = new Set<string>();
  const blocks: string[] = [];
  let used = 0;
  messages.forEach((message, index) => {
    const text = messageText(message);
    if (!text) return;
    const key = dedupeKey(text);
    if (!key || seen.has(key)) return;
    seen.add(key);
    const label = message.role === 'user' ? '用户' : 'Agent';
    const available = contentBudget - used - (blocks.length ? 2 : 0);
    if (available < 48) return;
    const block = bounded(`${index + 1}. ${label}：${bounded(text, 1_500)}`, available);
    blocks.push(block);
    used += block.length + (blocks.length > 1 ? 2 : 0);
  });
  if (!blocks.length) return '';
  return `${opening}${blocks.join('\n\n')}${closing}`;
};

const asSummaryMessage = <T extends ContextMessage>(content: string): T => ({
  role: 'assistant',
  content,
} as T);

const boundedMessage = <T extends ContextMessage>(message: T, limit: number): T => {
  if (typeof message.content === 'string') return { ...message, content: bounded(message.content, limit) } as T;
  let remaining = Math.max(0, limit);
  const content = message.content.map((part) => {
    if (part.type !== 'text') return part;
    const text = bounded(part.text, remaining);
    remaining = Math.max(0, remaining - text.length);
    return { ...part, text };
  });
  return { ...message, content } as T;
};

// Keep the newest messages first when a few large attachments would otherwise
// push the request beyond the model context budget.
const fitRecentMessages = <T extends ContextMessage>(
  messages: T[],
  maxCharacters: number,
  maxTokens: number,
  tokenizer: (text: string) => number,
) => {
  let remaining = Math.max(0, maxCharacters);
  let remainingTokens = Math.max(0, maxTokens);
  const kept: T[] = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    const length = messageText(message).length;
    const tokens = tokenizer(messageText(message));
    if (length <= remaining && tokens <= remainingTokens) {
      kept.unshift(message);
      remaining -= length;
      remainingTokens -= tokens;
      continue;
    }
    if (kept.length === 0 && remaining > 0 && remainingTokens > 0) {
      let candidate = boundedMessage(message, remaining);
      let candidateTokens = tokenizer(messageText(candidate));
      if (candidateTokens > remainingTokens) {
        const targetCharacters = Math.max(1, Math.floor(remaining * remainingTokens / candidateTokens));
        candidate = boundedMessage(message, targetCharacters);
        candidateTokens = tokenizer(messageText(candidate));
      }
      if (candidateTokens > 0) {
        kept.unshift(candidate);
        remainingTokens = Math.max(0, remainingTokens - candidateTokens);
        remaining = Math.max(0, remaining - messageText(candidate).length);
      }
    }
  }
  return kept;
};

const fitTextToTokenBudget = (
  value: string,
  maxCharacters: number,
  maxTokens: number,
  tokenizer: (text: string) => number,
) => {
  let candidate = bounded(value, maxCharacters);
  let tokens = tokenizer(candidate);
  while (tokens > maxTokens && candidate.length > 1) {
    const nextLength = Math.max(1, Math.floor(candidate.length * maxTokens / tokens));
    if (nextLength >= candidate.length) break;
    candidate = bounded(value, nextLength);
    tokens = tokenizer(candidate);
  }
  return candidate;
};

/**
 * Return a bounded model context without mutating the persisted transcript.
 * The final message is always retained, so a just-sent user turn cannot be
 * hidden by compaction.
 */
export const buildContextWindow = <T extends ContextMessage>(
  input: T[],
  options: ContextWindowOptions = {},
): ContextWindowResult<T> => {
  const config: Required<ContextWindowOptions> = { ...defaults, ...options };
  const messages = input.filter((message) => Boolean(messageText(message)));
  const totalCharacters = messages.reduce((total, message) => total + messageText(message).length, 0);
  const totalTokens = messages.reduce((total, message) => total + config.tokenizer(messageText(message)), 0);
  const withinLimits = messages.length <= config.triggerMessages
    && totalCharacters <= config.maxCharacters
    && totalTokens <= config.maxTokens;
  if (withinLimits) {
    return {
      messages: messages.slice(-config.maxMessages),
      summaryApplied: false,
      summarizedMessages: 0,
      summaryCharacters: 0,
      estimatedTokens: totalTokens,
      summaryVersion: null,
      summaryCoverage: null,
    };
  }

  const recentCount = Math.min(config.recentMessages, Math.max(1, config.maxMessages - 1));
  let split = Math.max(0, messages.length - recentCount);
  // If only a few very large messages caused compaction, still preserve the
  // latest turn and summarize at least one earlier turn when possible.
  if (split === 0 && messages.length > 1) split = messages.length - 1;
  const older = messages.slice(0, split);
  const recent = messages.slice(split).slice(-recentCount);
  const summary = summarizeMessages(older, config.maxSummaryCharacters);
  if (!summary) {
    return {
      messages: messages.slice(-config.maxMessages),
      summaryApplied: false,
      summarizedMessages: 0,
      summaryCharacters: 0,
      estimatedTokens: messages.slice(-config.maxMessages).reduce((total, message) => total + config.tokenizer(messageText(message)), 0),
      summaryVersion: null,
      summaryCoverage: null,
    };
  }
  // Reserve room for the newest user turn before bounding the summary. This
  // preserves the core invariant that a just-sent message is never replaced
  // by a summary when the token budget is tight.
  const latest = recent.at(-1);
  const latestCharacters = latest ? messageText(latest).length : 0;
  const latestTokens = latest ? config.tokenizer(messageText(latest)) : 0;
  const summaryCharacterBudget = Math.max(1, config.maxCharacters - latestCharacters);
  const summaryTokenBudget = Math.max(1, config.maxTokens - latestTokens);
  const boundedSummary = fitTextToTokenBudget(summary, Math.min(config.maxSummaryCharacters, summaryCharacterBudget), summaryTokenBudget, config.tokenizer);
  const summaryMessage = asSummaryMessage<T>(boundedSummary);
  const recentBudget = Math.max(0, config.maxCharacters - messageText(summaryMessage).length);
  const recentTokenBudget = Math.max(0, config.maxTokens - config.tokenizer(messageText(summaryMessage)));
  const result = [summaryMessage, ...fitRecentMessages(recent, recentBudget, recentTokenBudget, config.tokenizer)].slice(-config.maxMessages);
  return {
    messages: result,
    summaryApplied: true,
    summarizedMessages: older.length,
    summaryCharacters: boundedSummary.length,
    estimatedTokens: result.reduce((total, message) => total + config.tokenizer(messageText(message)), 0),
    summaryVersion: config.summaryVersion,
    summaryCoverage: { start: 0, end: Math.max(0, split - 1), total: messages.length },
  };
};
