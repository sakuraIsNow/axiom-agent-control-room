import { randomUUID } from 'node:crypto';

const baseUrl = process.env.QA_URL ?? 'http://127.0.0.1:8787';
const sessionId = `qa-context-${randomUUID()}`;
const headers = {
  'content-type': 'application/json',
  'x-axiom-tenant-id': 'qa-context-tenant',
  'x-axiom-user-id': 'qa-context-user',
};

const request = async (path, init = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { ...headers, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(20_000),
  });
  const body = response.status === 204 ? null : await response.json().catch(() => null);
  return { response, body };
};

const assertions = {};
let failure;

try {
  const originalMessages = Array.from({ length: 22 }, (_, index) => ({
    id: `${sessionId}-message-${index}`,
    role: index % 2 ? 'assistant' : 'user',
    content: `第 ${index + 1} 条上下文：${'保留可恢复约束。'.repeat(18)}`,
    createdAt: Date.now() + index,
  }));
  const first = await request(`/api/sessions/${sessionId}`, {
    method: 'PUT',
    body: JSON.stringify({ id: sessionId, title: '摘要回归', messages: originalMessages, updatedAt: Date.now() }),
  });
  const firstSummary = first.body?.session?.contextSummary;
  assertions.initialSummaryCreated = first.response.ok && firstSummary?.version === 1 && firstSummary.coveredMessageIds?.length > 0;

  const listed = await request('/api/sessions?limit=100');
  const restored = listed.body?.sessions?.find((session) => session.id === sessionId)?.contextSummary;
  assertions.summaryRestoredFromApi = listed.response.ok && restored?.summaryId === firstSummary?.summaryId && restored?.sourceDigest === firstSummary?.sourceDigest;

  const appendedMessages = [...originalMessages, ...Array.from({ length: 4 }, (_, index) => ({
    id: `${sessionId}-message-${22 + index}`,
    role: index % 2 ? 'assistant' : 'user',
    content: `追加消息 ${index + 1}：继续执行。`,
    createdAt: Date.now() + 100 + index,
  }))];
  const second = await request(`/api/sessions/${sessionId}`, {
    method: 'PUT',
    body: JSON.stringify({ id: sessionId, title: '摘要回归', messages: appendedMessages, updatedAt: Date.now() + 200 }),
  });
  const secondSummary = second.body?.session?.contextSummary;
  assertions.incrementalVersionAdvanced = second.response.ok
    && secondSummary?.version === 2
    && secondSummary.coveredMessageIds.length > firstSummary.coveredMessageIds.length;

  const changedMessages = appendedMessages.map((message, index) => index === 1
    ? { ...message, content: '已修改的历史约束：必须重新验证摘要来源。' }
    : message);
  const third = await request(`/api/sessions/${sessionId}`, {
    method: 'PUT',
    body: JSON.stringify({ id: sessionId, title: '摘要回归', messages: changedMessages, updatedAt: Date.now() + 300 }),
  });
  const thirdSummary = third.body?.session?.contextSummary;
  assertions.sourceDriftRebuilt = third.response.ok
    && thirdSummary?.version === 3
    && thirdSummary.sourceDigest !== secondSummary.sourceDigest;
  assertions.sourceMessageIdsRetained = changedMessages.every((message) => third.body?.session?.messages?.some((stored) => stored.id === message.id));
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
} finally {
  await request(`/api/sessions/${sessionId}`, { method: 'DELETE' }).catch(() => undefined);
}

const passed = !failure && Object.values(assertions).every(Boolean);
console.log(JSON.stringify({ suite: 'context-summary-api-regression', passed, assertions, ...(failure ? { failure } : {}) }, null, 2));
if (!passed) process.exitCode = 1;
