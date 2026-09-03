import assert from 'node:assert/strict';
import test from 'node:test';
import { EventHub } from './eventHub.js';
import { SqliteTaskStore } from './sqliteTaskStore.js';
import { createTaskApi } from './taskApi.js';

const headers = {
  'content-type': 'application/json',
  'x-axiom-tenant-id': 'tenant-notifications',
  'x-axiom-user-id': 'user-notifications',
};

test('notification API derives task state and persists per-user read receipts', async () => {
  const store = new SqliteTaskStore(':memory:');
  await store.initialize();
  const api = createTaskApi({
    store,
    hub: new EventHub(),
    coordinator: { nudge() {}, abort() {} } as never,
    artifactStore: null,
  });
  try {
    const created = await store.createTask({
      tenantId: 'tenant-notifications',
      userId: 'user-notifications',
      sessionId: 'session-notifications',
      title: '生产通知闭环',
      input: '验证通知',
      mode: 'analyze',
    });
    await store.appendEvent(created, { type: 'task.created', payload: { source: 'conversation' } });
    const completed = await store.updateTask(created.id, { status: 'completed', result: '已完成' });
    await store.appendEvent(completed, {
      type: 'task.completed',
      payload: { evidenceSummary: { status: 'verified', gaps: [] } },
    });

    const response = await api.request(new Request('http://runtime.test/notifications', { headers }));
    assert.equal(response.status, 200);
    const first = await response.json() as { unreadCount: number; notifications: Array<{ id: string; kind: string; read: boolean }> };
    assert.equal(first.unreadCount, 1);
    assert.equal(first.notifications[0]?.kind, 'task_completed');
    assert.equal(first.notifications[0]?.read, false);

    const read = await api.request(new Request('http://runtime.test/notifications/read', {
      method: 'POST',
      headers,
      body: JSON.stringify({ ids: [first.notifications[0]!.id], all: false }),
    }));
    assert.equal(read.status, 200);
    assert.equal((await read.json() as { unreadCount: number }).unreadCount, 0);

    const second = await api.request(new Request('http://runtime.test/notifications', { headers }));
    const persisted = await second.json() as { unreadCount: number; notifications: Array<{ read: boolean }> };
    assert.equal(persisted.unreadCount, 0);
    assert.equal(persisted.notifications[0]?.read, true);

    const otherUser = await api.request(new Request('http://runtime.test/notifications', {
      headers: { ...headers, 'x-axiom-user-id': 'another-user' },
    }));
    assert.equal((await otherUser.json() as { notifications: unknown[] }).notifications.length, 0);
  } finally {
    await store.close();
  }
});

test('notification API rejects receipt ids that are not present in the current feed', async () => {
  const store = new SqliteTaskStore(':memory:');
  await store.initialize();
  const api = createTaskApi({
    store,
    hub: new EventHub(),
    coordinator: { nudge() {}, abort() {} } as never,
    artifactStore: null,
  });
  try {
    const response = await api.request(new Request('http://runtime.test/notifications/read', {
      method: 'POST',
      headers,
      body: JSON.stringify({ ids: ['invented-notification'], all: false }),
    }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { marked: 0, unreadCount: 0 });
    assert.deepEqual(await store.getReadNotificationIds('tenant-notifications', 'user-notifications', ['invented-notification']), []);
  } finally {
    await store.close();
  }
});
