import assert from 'node:assert/strict';
import test from 'node:test';
import { aggregateContextSummaryQuality, attachPersistedContextMetadata, buildContextWindow, buildPersistedContextSummary, estimateTokens, messageText, summarizeMessages, validatePersistedContextSummary, type ContextMessage, type DurableContextSourceMessage } from './contextSummary.js';

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

test('persistent summaries update incrementally and rebuild when a covered source message changes', () => {
  const messages = Array.from({ length: 20 }, (_, index): DurableContextSourceMessage => ({
    id: `message-${index}`,
    role: index % 2 ? 'assistant' : 'user',
    content: `第 ${index + 1} 条持久消息：${'上下文 '.repeat(30)}`,
    ...(index === 5 ? { taskId: 'task-context' } : {}),
  }));
  const first = buildPersistedContextSummary('session-context', messages);
  assert.ok(first);
  assert.equal(first.version, 1);
  assert.equal(first.quality?.lastAction, 'created');
  assert.equal(first.quality?.tokenizer.mode, 'estimated');
  assert.notEqual(first.quality?.compressionPercent, null);
  assert.equal(validatePersistedContextSummary(first, messages), true);
  assert.ok(first.coveredMessageIds.length > 0);

  const reused = buildPersistedContextSummary('session-context', messages, first!);
  assert.ok(reused);
  assert.equal(reused.version, 1);
  assert.equal(reused.quality?.lastAction, 'reused');
  assert.equal(reused.quality?.reuseCount, 1);

  const appended = [
    ...messages,
    ...Array.from({ length: 4 }, (_, index): DurableContextSourceMessage => ({
      id: `message-${20 + index}`,
      role: index % 2 ? 'assistant' : 'user',
      content: `新增消息 ${index + 1}：继续推进持久摘要。`,
    })),
  ];
  const second = buildPersistedContextSummary('session-context', appended, first!);
  assert.ok(second);
  assert.equal(second.version, 2);
  assert.equal(second.quality?.lastAction, 'incremental');
  assert.equal(second.quality?.incrementalCount, 1);
  assert.ok(second.coveredMessageIds.length > first!.coveredMessageIds.length);
  assert.equal(validatePersistedContextSummary(second, appended), true);

  const tampered = appended.map((message, index) => index === 1 ? { ...message, content: '已修改的历史内容。' } : message);
  assert.equal(validatePersistedContextSummary(second, tampered), false);
  const rebuilt = buildPersistedContextSummary('session-context', tampered, second!);
  assert.ok(rebuilt);
  assert.equal(rebuilt.version, 3);
  assert.equal(rebuilt.quality?.lastAction, 'rebuilt');
  assert.equal(rebuilt.quality?.rebuildCount, 1);
  assert.notEqual(rebuilt.sourceDigest, second!.sourceDigest);
  assert.equal(validatePersistedContextSummary(rebuilt, tampered), true);
});

test('persistent summary metadata retains artifacts, approvals, human facts, and unresolved work', () => {
  const messages = Array.from({ length: 18 }, (_, index): DurableContextSourceMessage => ({ id: `meta-${index}`, role: index % 2 ? 'assistant' : 'user', content: `消息 ${index}` }));
  const summary = buildPersistedContextSummary('session-metadata', messages);
  assert.ok(summary);
  const enriched = attachPersistedContextMetadata(summary!, {
    artifactIds: ['step-result:task:analysis:abc'],
    approvalEventIds: ['approval-event-1'],
    durableFacts: ['人工要求：保留数据库兼容性。', 'Agent 冲突：两个来源版本不一致。'],
    unresolvedItems: ['审查待处理：补充回滚演练。'],
  });
  assert.deepEqual(enriched.artifactIds, ['step-result:task:analysis:abc']);
  assert.deepEqual(enriched.approvalEventIds, ['approval-event-1']);
  assert.match(enriched.content, /Artifact 引用/);
  assert.match(enriched.content, /人工要求/);
  assert.match(enriched.content, /Agent 冲突/);
  assert.match(enriched.content, /未完成事项/);
  assert.equal(enriched.quality?.summaryCharacters, enriched.content.length);
});

test('summary quality aggregation reports compression, reuse, rebuilds, and tokenizer trust', () => {
  const messages = Array.from({ length: 20 }, (_, index): DurableContextSourceMessage => ({
    id: `quality-${index}`,
    role: index % 2 ? 'assistant' : 'user',
    content: `quality message ${index} ${'repeat '.repeat(24)}`,
  }));
  const tokenizer = (text: string) => text.split(/\s+/u).filter(Boolean).length;
  const first = buildPersistedContextSummary('quality-session', messages, undefined, {
    tokenizer,
    tokenizerName: 'provider-test-tokenizer',
    tokenizerMode: 'exact',
    maxSummaryCharacters: 320,
  });
  assert.ok(first?.quality);
  const reused = buildPersistedContextSummary('quality-session', messages, first!, {
    tokenizer,
    tokenizerName: 'provider-test-tokenizer',
    tokenizerMode: 'exact',
    maxSummaryCharacters: 320,
  });
  assert.ok(reused?.quality);
  const aggregated = aggregateContextSummaryQuality([reused, undefined]);
  assert.equal(aggregated.summaries, 1);
  assert.equal(aggregated.exactSummaries, 1);
  assert.equal(aggregated.estimatedSummaries, 0);
  assert.deepEqual(aggregated.tokenizerNames, ['provider-test-tokenizer']);
  assert.equal(aggregated.reuseCount, 1);
  assert.equal(aggregated.reuseRate, 50);
  assert.ok((aggregated.compressionPercent ?? 0) > 0);
});
