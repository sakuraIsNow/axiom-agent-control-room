import assert from 'node:assert/strict';
import test from 'node:test';
import { buildConversationContext, summarizeConversation, type ConversationContextMessage } from './conversationContext.js';

const message = (role: ConversationContextMessage['role'], content: string): ConversationContextMessage => ({ role, content });

test('workflow context preserves the latest input while compacting earlier turns', () => {
  const input = Array.from({ length: 19 }, (_, index) => message(index % 2 ? 'assistant' : 'user', `历史第 ${index} 轮`));
  input.push(message('user', '最新 Nexus 输入'));
  const result = buildConversationContext(input);
  assert.equal(result.summaryApplied, true);
  assert.match(String(result.messages[0]?.content), /历史上下文摘要/);
  assert.equal(result.messages.at(-1)?.content, '最新 Nexus 输入');
  assert.ok(result.messages.length <= 24);
});

test('workflow context does not alter a small transcript', () => {
  const input = [message('user', '输入'), message('assistant', '输出')];
  assert.deepEqual(buildConversationContext(input).messages, input);
  assert.match(summarizeConversation(input), /历史上下文摘要/);
});
