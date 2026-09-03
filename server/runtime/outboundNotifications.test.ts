import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import type { InAppNotification } from './contracts.js';
import { OutboundNotificationManager, SqliteOutboundNotificationStore, normalizeWebhookEndpoint } from './outboundNotifications.js';

const signingSecret = 'notification-test-secret-12345';
const encryptionSecret = 'notification-encryption-secret';
const notification = (id = 'task-completed:task-1'): InAppNotification => ({
  id,
  kind: 'task_completed',
  severity: 'success',
  title: '任务已完成',
  message: '测试任务已经交付。',
  createdAt: '2026-09-03T10:00:00.000Z',
  read: false,
  target: { view: 'tasks', taskId: 'task-1' },
  action: { kind: 'open', label: '查看结果', resourceId: 'task-1' },
});

const createChannel = (store: SqliteOutboundNotificationStore, patch: Partial<Parameters<typeof store.saveChannel>[0]> = {}) => store.saveChannel({
  tenantId: 'tenant-a',
  userId: 'user-a',
  name: '团队 Webhook',
  endpoint: 'http://127.0.0.1:9999/hook?token=hidden',
  signingSecret,
  location: 'local',
  eventKinds: ['task_completed', 'task_failed'],
  enabled: true,
  ...patch,
});

test('outbound store encrypts channel configuration, isolates owners, and deduplicates notifications', async () => {
  const store = new SqliteOutboundNotificationStore(':memory:', encryptionSecret);
  await store.initialize();
  try {
    const channel = await createChannel(store);
    assert.equal(channel.endpointDisplay, 'http://127.0.0.1:9999/…');
    assert.equal(JSON.stringify(channel).includes('token=hidden'), false);
    assert.equal(JSON.stringify(channel).includes(signingSecret), false);

    const resolved = await store.getChannel(channel.id, 'tenant-a', 'user-a');
    assert.equal(resolved?.endpoint, 'http://127.0.0.1:9999/hook?token=hidden');
    assert.equal(resolved?.signingSecret, signingSecret);
    assert.equal(await store.getChannel(channel.id, 'tenant-a', 'other-user'), null);

    assert.equal((await store.enqueue('tenant-a', 'user-a', notification())).length, 1);
    assert.equal((await store.enqueue('tenant-a', 'user-a', notification())).length, 0);
    assert.equal((await store.listDeliveries('tenant-a', 'user-a')).length, 1);
    assert.equal((await store.listDeliveries('tenant-a', 'other-user')).length, 0);
  } finally { await store.close(); }
});

test('outbound manager signs test payloads and records successful delivery without leaking configuration', async () => {
  const store = new SqliteOutboundNotificationStore(':memory:', encryptionSecret);
  await store.initialize();
  let observed: { body: string; timestamp: string; signature: string; event: string } | undefined;
  const fetcher: typeof fetch = async (_input, init) => {
    const headers = new Headers(init?.headers);
    observed = {
      body: String(init?.body ?? ''),
      timestamp: headers.get('x-axiom-timestamp') ?? '',
      signature: headers.get('x-axiom-signature') ?? '',
      event: headers.get('x-axiom-event') ?? '',
    };
    return new Response(null, { status: 204 });
  };
  const manager = new OutboundNotificationManager(store, fetcher);
  try {
    const channel = await createChannel(store);
    const delivery = await manager.enqueueTest(channel.id, 'tenant-a', 'user-a');
    assert.equal(delivery?.status, 'delivered');
    assert.equal(delivery?.eventKind, 'test');
    assert.equal(delivery?.totalAttempts, 1);
    assert.equal(observed?.event, 'test');
    const expected = createHmac('sha256', signingSecret).update(`${observed?.timestamp}.${observed?.body}`).digest('hex');
    assert.equal(observed?.signature, `v1=${expected}`);
    assert.equal(JSON.stringify(delivery).includes('token=hidden'), false);
  } finally { await manager.stop(); await store.close(); }
});

test('terminal webhook failures enter dead letter and can be explicitly retried', async () => {
  const store = new SqliteOutboundNotificationStore(':memory:', encryptionSecret);
  await store.initialize();
  let status = 400;
  const manager = new OutboundNotificationManager(store, async () => new Response(null, { status }));
  try {
    const channel = await createChannel(store);
    const first = await manager.enqueueTest(channel.id, 'tenant-a', 'user-a');
    assert.equal(first?.status, 'dead_letter');
    assert.equal(first?.responseStatus, 400);
    assert.match(first?.lastError ?? '', /HTTP 400/);
    assert.equal(await store.retry(first!.id, 'tenant-a', 'other-user'), false);
    assert.equal(await store.retry(first!.id, 'tenant-a', 'user-a'), true);
    status = 204;
    await manager.flush(1, first!.id);
    const recovered = await store.getDelivery(first!.id, 'tenant-a', 'user-a');
    assert.equal(recovered?.status, 'delivered');
    assert.equal(recovered?.totalAttempts, 2);
  } finally { await manager.stop(); await store.close(); }
});

test('delivery lease can only be claimed by one worker', async () => {
  const store = new SqliteOutboundNotificationStore(':memory:', encryptionSecret);
  await store.initialize();
  try {
    await createChannel(store);
    const [id] = await store.enqueue('tenant-a', 'user-a', notification());
    const first = await store.claimNext('worker-a', 30_000, id);
    const second = await store.claimNext('worker-b', 30_000, id);
    assert.equal(first?.id, id);
    assert.equal(second, null);
  } finally { await store.close(); }
});

test('internet webhooks reject insecure and private destinations before persistence', () => {
  assert.throws(() => normalizeWebhookEndpoint('http://hooks.example.com/path', 'internet'), /HTTPS/);
  assert.throws(() => normalizeWebhookEndpoint('https://127.0.0.1/hook', 'internet'), /私有网络/);
  assert.throws(() => normalizeWebhookEndpoint('https://user:pass@example.com/hook', 'internet'), /账号/);
  assert.equal(normalizeWebhookEndpoint('https://hooks.example.com/path', 'internet'), 'https://hooks.example.com/path');
});
