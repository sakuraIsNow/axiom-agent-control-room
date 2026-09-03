import assert from 'node:assert/strict';
import test from 'node:test';
import { EventHub } from './eventHub.js';
import { SqliteTaskStore } from './sqliteTaskStore.js';
import { createTaskApi } from './taskApi.js';
import { OutboundNotificationManager, SqliteOutboundNotificationStore } from './outboundNotifications.js';

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

test('notification channel API creates, tests, audits, and deletes an isolated Webhook', async () => {
  const store = new SqliteTaskStore(':memory:');
  const outboundStore = new SqliteOutboundNotificationStore(':memory:', 'notification-api-encryption-secret');
  await store.initialize();
  await outboundStore.initialize();
  const manager = new OutboundNotificationManager(outboundStore, async () => new Response(null, { status: 204 }));
  const api = createTaskApi({
    store,
    hub: new EventHub(),
    coordinator: { nudge() {}, abort() {} } as never,
    artifactStore: null,
    outboundNotifications: manager,
  });
  try {
    const createdResponse = await api.request(new Request('http://runtime.test/notification-channels', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: '本地接收器',
        endpoint: 'http://127.0.0.1:8999/private-hook?token=hidden',
        signingSecret: 'webhook-signing-secret-1234',
        location: 'local',
        eventKinds: ['task_completed', 'task_failed'],
        enabled: true,
      }),
    }));
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json() as { channel: { id: string; endpointDisplay: string } };
    assert.equal(created.channel.endpointDisplay, 'http://127.0.0.1:8999/…');
    assert.equal(JSON.stringify(created).includes('token=hidden'), false);
    assert.equal(JSON.stringify(created).includes('webhook-signing-secret'), false);

    const tested = await api.request(new Request(`http://runtime.test/notification-channels/${created.channel.id}/test`, { method: 'POST', headers }));
    assert.equal(tested.status, 200);
    const testBody = await tested.json() as { delivery: { status: string; eventKind: string } };
    assert.equal(testBody.delivery.status, 'delivered');
    assert.equal(testBody.delivery.eventKind, 'test');

    const listed = await api.request(new Request('http://runtime.test/notification-channels', { headers }));
    const catalog = await listed.json() as { channels: unknown[]; deliveries: Array<{ status: string }> };
    assert.equal(catalog.channels.length, 1);
    assert.equal(catalog.deliveries[0]?.status, 'delivered');

    const otherUser = await api.request(new Request('http://runtime.test/notification-channels', {
      headers: { ...headers, 'x-axiom-user-id': 'another-user' },
    }));
    assert.deepEqual((await otherUser.json() as { channels: unknown[] }).channels, []);

    const deleted = await api.request(new Request(`http://runtime.test/notification-channels/${created.channel.id}`, { method: 'DELETE', headers }));
    assert.equal(deleted.status, 204);
    const afterDelete = await api.request(new Request('http://runtime.test/notification-channels', { headers }));
    const retainedAudit = await afterDelete.json() as { channels: unknown[]; deliveries: unknown[] };
    assert.equal(retainedAudit.channels.length, 0);
    assert.equal(retainedAudit.deliveries.length, 1, 'channel secret deletion must retain a bounded audit record');
  } finally {
    await manager.stop();
    await outboundStore.close();
    await store.close();
  }
});
