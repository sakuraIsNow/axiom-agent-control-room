import assert from 'node:assert/strict';
import test from 'node:test';
import { buildContextWindow, estimateTokens, messageText, summarizeMessages, type ContextMessage } from './contextSummary.js';

const turn = (role: ContextMessage['role'], content: string): ContextMessage => ({ role, content });

test('context window keeps the latest turn and summarizes older turns', () => {
  const input = [
    turn('user', '项目目标：构建一个可恢复的 Agent 工作流。'),
    turn('assistant', '已确认需要任务持久化与事件回放。'),
    turn('user', '重复的历史问题'),
    turn('assistant', '重复的历史问题'),
    ...Array.from({ length: 14 }, (_, index) => turn(index % 2 ? 'assistant' : 'user', `第 ${index + 5} 轮讨论：验证协作事件和人工审核。`)),
    turn('user', '这是最新输入，必须原样保留。'),
  ];

  const result = buildContextWindow(input);
  assert.equal(result.summaryApplied, true);
  assert.ok(result.summarizedMessages > 0);
  assert.ok(result.messages.length <= 24);
  assert.ok(result.messages.reduce((sum, message) => sum + messageText(message).length, 0) <= 48_000);
  assert.equal(result.messages.at(-1)?.content, '这是最新输入，必须原样保留。');
  assert.match(String(result.messages[0]?.content), /历史上下文摘要/);
  assert.equal(result.messages.filter((message) => message.content === '重复的历史问题').length, 0);
});

test('short conversations remain untouched', () => {
  const input = [turn('user', '你好'), turn('assistant', '你好，有什么可以帮你？')];
  const result = buildContextWindow(input);
  assert.equal(result.summaryApplied, false);
  assert.deepEqual(result.messages, input);
  assert.match(summarizeMessages(input), /历史上下文摘要/);
});

test('attachment parts are represented in summaries without leaking binary data', () => {
  const input: ContextMessage[] = [
    { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,very-large-secret' } }] },
    turn('assistant', '已识别图片中的流程图。'),
    ...Array.from({ length: 16 }, (_, index) => turn('user', `补充问题 ${index}`)),
    turn('user', '最后一个问题'),
  ];
  const result = buildContextWindow(input);
  const summary = result.messages.find((message) => typeof message.content === 'string' && message.content.includes('历史上下文摘要'));
  assert.ok(summary);
  assert.match(String(summary?.content), /附件 1 项/);
  assert.doesNotMatch(String(summary?.content), /very-large-secret/);
  assert.equal(messageText(input[0]!), '[附件 1 项]');
});

test('summary respects configured character bound', () => {
  const input = Array.from({ length: 20 }, (_, index) => turn('user', `${index} ${'长文本 '.repeat(800)}`));
  const result = buildContextWindow(input, { maxSummaryCharacters: 1_200 });
  assert.equal(result.summaryApplied, true);
  const summary = String(result.messages[0]?.content);
  assert.ok(summary.length <= 1_400);
  assert.equal(String(result.messages.at(-1)?.content).startsWith('19 '), true);
});

test('large recent turns are bounded without dropping the newest message', () => {
  const input = Array.from({ length: 18 }, (_, index) => turn(index % 2 ? 'assistant' : 'user', `${index} ${'内容 '.repeat(12_000)}`));
  const result = buildContextWindow(input, { maxCharacters: 4_000, maxSummaryCharacters: 1_000, recentMessages: 4 });
  assert.equal(result.summaryApplied, true);
  assert.ok(result.messages.reduce((sum, message) => sum + messageText(message).length, 0) <= 4_000);
  assert.ok(String(result.messages.at(-1)?.content).startsWith('17 '));
});

test('very small budgets still remain bounded', () => {
  const input = Array.from({ length: 18 }, (_, index) => turn(index % 2 ? 'assistant' : 'user', `${index} ${'x'.repeat(200)}`));
  const result = buildContextWindow(input, { maxCharacters: 512, maxSummaryCharacters: 320, recentMessages: 2 });
  assert.ok(result.messages.reduce((sum, item) => sum + messageText(item).length, 0) <= 512);
});

test('token budgets are enforced and summary metadata identifies its coverage', () => {
  const input = Array.from({ length: 6 }, (_, index) => turn(index % 2 ? 'assistant' : 'user', `turn-${index} ${'内容 '.repeat(40)}`));
  const result = buildContextWindow(input, {
    triggerMessages: 2,
    maxCharacters: 10_000,
    maxTokens: 120,
    maxSummaryCharacters: 500,
  });
  assert.equal(result.summaryApplied, true);
  assert.equal(result.summaryVersion, 'deterministic-v2');
  assert.deepEqual(result.summaryCoverage, { start: 0, end: 4, total: 6 });
  assert.ok(result.estimatedTokens <= 120);
  assert.ok(estimateTokens('你好 world') > 0);
});

test('an exact tokenizer hook can tighten the context budget', () => {
  const input = [turn('user', 'one two three four'), turn('assistant', 'five six seven eight'), turn('user', 'newest')];
  const result = buildContextWindow(input, {
    triggerMessages: 1,
    maxCharacters: 500,
    maxTokens: 10,
    maxSummaryCharacters: 80,
    tokenizer: (text) => text.split(/\s+/).filter(Boolean).length,
  });
  assert.equal(result.summaryApplied, true);
  assert.ok(result.estimatedTokens <= 10);
  assert.equal(result.messages.at(-1)?.content, 'newest');
});
