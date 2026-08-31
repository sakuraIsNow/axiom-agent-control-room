import type { ChatMessage } from '../types';

export type ConversationContextMessage = Pick<ChatMessage, 'role' | 'content' | 'attachments'>;

export type ConversationContextOptions = {
  recentMessages?: number;
  triggerMessages?: number;
  maxMessages?: number;
  maxCharacters?: number;
  maxSummaryCharacters?: number;
};

export type ConversationContextResult = {
  messages: ConversationContextMessage[];
  summaryApplied: boolean;
  summarizedMessages: number;
  summaryCharacters: number;
};

const defaults = {
  recentMessages: 12,
  triggerMessages: 16,
  maxMessages: 24,
  maxCharacters: 48_000,
  maxSummaryCharacters: 8_000,
} as const;

const normalize = (value: string) => value
  .replace(/\u0000/g, '')
  .replace(/[ \t]+/g, ' ')
  .replace(/\n{3,}/g, '\n\n')
  .trim();

export const contextMessageText = (message: ConversationContextMessage) => {
  const attachmentNote = message.attachments?.length
    ? ` [附件 ${message.attachments.length} 项]`
    : '';
  return normalize(`${message.content}${attachmentNote}`);
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

export const summarizeConversation = (
  messages: ConversationContextMessage[],
  maxCharacters: number = defaults.maxSummaryCharacters,
) => {
  const opening = '【历史上下文摘要】\n';
  const closing = '\n\n以上是较早对话的压缩记录；如与最近消息冲突，以最近消息为准。';
  const contentBudget = Math.max(120, maxCharacters - opening.length - closing.length);
  const seen = new Set<string>();
  const blocks: string[] = [];
  let used = 0;
  messages.forEach((message, index) => {
    const text = contextMessageText(message);
    const key = dedupeKey(text);
    if (!text || !key || seen.has(key)) return;
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

const boundedMessage = (message: ConversationContextMessage, limit: number): ConversationContextMessage => {
  if (!message.attachments?.length) return { ...message, content: bounded(message.content, limit) };
  return { ...message, content: bounded(message.content, limit) };
};

const fitRecentMessages = (messages: ConversationContextMessage[], maxCharacters: number) => {
  let remaining = Math.max(0, maxCharacters);
  const kept: ConversationContextMessage[] = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const current = messages[index]!;
    const length = contextMessageText(current).length;
    if (length <= remaining) {
      kept.unshift(current);
      remaining -= length;
      continue;
    }
    if (kept.length === 0 && remaining > 0) kept.unshift(boundedMessage(current, remaining));
  }
  return kept;
};

export const buildConversationContext = (
  input: ConversationContextMessage[],
  options: ConversationContextOptions = {},
): ConversationContextResult => {
  const config: Required<ConversationContextOptions> = { ...defaults, ...options };
  const messages = input.filter((message) => Boolean(contextMessageText(message)));
  const totalCharacters = messages.reduce((sum, message) => sum + contextMessageText(message).length, 0);
  if (messages.length <= config.triggerMessages && totalCharacters <= config.maxCharacters) {
    return { messages: messages.slice(-config.maxMessages), summaryApplied: false, summarizedMessages: 0, summaryCharacters: 0 };
  }

  const recentCount = Math.min(config.recentMessages, Math.max(1, config.maxMessages - 1));
  let split = Math.max(0, messages.length - recentCount);
  if (split === 0 && messages.length > 1) split = messages.length - 1;
  const older = messages.slice(0, split);
  const recent = messages.slice(split).slice(-recentCount);
  const summary = summarizeConversation(older, config.maxSummaryCharacters);
  if (!summary) {
    return { messages: messages.slice(-config.maxMessages), summaryApplied: false, summarizedMessages: 0, summaryCharacters: 0 };
  }
  const summaryMessage: ConversationContextMessage = { role: 'assistant', content: summary };
  const recentBudget = Math.max(0, config.maxCharacters - contextMessageText(summaryMessage).length);
  return {
    messages: [summaryMessage, ...fitRecentMessages(recent, recentBudget)].slice(-config.maxMessages),
    summaryApplied: true,
    summarizedMessages: older.length,
    summaryCharacters: summary.length,
  };
};
