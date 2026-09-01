import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventHub } from './eventHub.js';
import type { ModelClient } from './modelClient.js';
import { SqliteTaskStore } from './sqliteTaskStore.js';
import { createTaskApi } from './taskApi.js';

const model: ModelClient = {
  model: 'report-api-test',
  async complete() {
    return { content: '# 会话报告\n\n这是服务端会话生成的报告。', attempts: 1, durationMs: 1, finishReason: 'stop' };
  },
};

test('report export API serves owned sessions and rejects cross-user access', async () => {
  const store = new SqliteTaskStore(':memory:');
  await store.initialize();
  await store.upsertSession('tenant-a', 'owner', {
    id: 'owned-session', title: '服务端会话', updatedAt: Date.now(),
    messages: [
      { id: 'u1', role: 'user', content: '分析问题', createdAt: 1 },
      { id: 'a1', role: 'assistant', content: '分析结论', createdAt: 2 },
    ],
  });
  const api = createTaskApi({
    store,
    hub: new EventHub(),
    coordinator: { nudge() {}, abort() {} } as never,
    reportModelFactory: async () => model,
  });
  const body = JSON.stringify({ sessionId: 'owned-session', scope: 'last-answer', format: 'md', instruction: '导出以上回答' });
  try {
    const owned = await api.request(new Request('http://runtime.test/reports/export', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-axiom-tenant-id': 'tenant-a', 'x-axiom-user-id': 'owner' }, body,
    }));
    assert.equal(owned.status, 200);
    assert.match(owned.headers.get('content-type') ?? '', /^text\/markdown/);
    assert.match(owned.headers.get('content-disposition') ?? '', /\.md/);
    assert.match(await owned.text(), /会话报告/);

    const foreign = await api.request(new Request('http://runtime.test/reports/export', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-axiom-tenant-id': 'tenant-a', 'x-axiom-user-id': 'other-user' }, body,
    }));
    assert.equal(foreign.status, 404);
  } finally {
    await store.close();
  }
});
