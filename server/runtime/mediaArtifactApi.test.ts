import assert from 'node:assert/strict';
import test from 'node:test';
import { createTaskApi } from './taskApi.js';
import { SqliteTaskStore } from './sqliteTaskStore.js';
import { SqliteArtifactCatalog } from './artifactCatalog.js';
import { EventHub } from './eventHub.js';

test('media artifacts require their owning task, tenant and user and cannot render active content', async () => {
  const tasks = new SqliteTaskStore(':memory:'); const catalog = new SqliteArtifactCatalog(':memory:');
  await tasks.initialize(); await catalog.initialize();
  const task = await tasks.createTask({ tenantId: 'tenant', userId: 'owner', sessionId: 'session', title: 'Image', input: 'Draw', mode: 'build' });
  const mediaId = `media:${task.id}:call:0`;
  const binary = new Uint8Array([137, 80, 78, 71]);
  await catalog.register({ id: mediaId, tenantId: 'tenant', taskId: task.id, source: 'tool', bytes: binary.length, mimeType: 'image/png', referenceKey: 'generated' });
  const api = createTaskApi({ store: tasks, hub: new EventHub(), coordinator: { nudge() {}, abort() {} } as never,
    artifactCatalog: catalog, artifactStore: { kind: 'filesystem', getBinary: async () => binary } as never });
  const url = `/tasks/${task.id}/artifacts/media/${encodeURIComponent(mediaId)}`;
  const get = (user = 'owner', tenant = 'tenant') => api.request(url, { headers: { 'x-axiom-tenant-id': tenant, 'x-axiom-user-id': user } });
  try {
    const response = await get(); assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png'); assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), binary);
    assert.equal((await get('other')).status, 404); assert.equal((await get('owner', 'other')).status, 404);
    const second = await tasks.createTask({ tenantId: 'tenant', userId: 'owner', sessionId: 'session', title: 'Other', input: 'Draw', mode: 'build' });
    assert.equal((await api.request(`/tasks/${second.id}/artifacts/media/${encodeURIComponent(mediaId)}`, { headers: { 'x-axiom-tenant-id': 'tenant', 'x-axiom-user-id': 'owner' } })).status, 404);
    await catalog.markDeleted('tenant', mediaId); assert.equal((await get()).status, 404);
    await catalog.register({ id: mediaId, tenantId: 'tenant', taskId: task.id, source: 'tool', bytes: 4, mimeType: 'image/svg+xml', referenceKey: 'active-content' });
    assert.equal((await get()).status, 404);
  } finally { await tasks.close(); await catalog.close(); }
});
