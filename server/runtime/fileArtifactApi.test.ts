import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTaskApi } from './taskApi.js';
import { SqliteTaskStore } from './sqliteTaskStore.js';
import { SqliteArtifactCatalog } from './artifactCatalog.js';
import { FileArtifactStore } from './artifactStore.js';
import { EventHub } from './eventHub.js';

test('generated documents download as non-executable authenticated attachments with original filenames', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'axiom-file-api-'));
  const tasks = new SqliteTaskStore(':memory:'); const catalog = new SqliteArtifactCatalog(':memory:');
  await tasks.initialize(); await catalog.initialize();
  const storage = new FileArtifactStore(directory);
  const task = await tasks.createTask({ tenantId: 'tenant', userId: 'owner', sessionId: 'session', title: 'Animation', input: 'Create HTML', mode: 'build' });
  const content = '<html><body><svg><circle r="4" /></svg><script>document.body.dataset.ready="yes"</script></body></html>';
  const id = `tool:${task.id}:builder:call:artifact`;
  const stored = await storage.put(id, content, task.tenantId);
  await catalog.register({ id, tenantId: task.tenantId, taskId: task.id, source: 'tool', bytes: stored.bytes, storageKey: stored.key, mimeType: 'text/html', referenceKey: 'builder:call' });
  await tasks.appendEvent(task, { type: 'artifact.created', payload: { id, name: '鹈鹕动画.html', mimeType: 'text/html' } });
  const api = createTaskApi({ store: tasks, hub: new EventHub(), coordinator: { nudge() {}, abort() {} } as never, artifactCatalog: catalog, artifactStore: storage });
  const url = `/tasks/${task.id}/artifacts/files/${encodeURIComponent(id)}`;
  const get = (user = 'owner', tenant = 'tenant') => api.request(url, { headers: { 'x-axiom-tenant-id': tenant, 'x-axiom-user-id': user } });
  try {
    const response = await get(); assert.equal(response.status, 200);
    assert.equal(await response.text(), content);
    assert.equal(response.headers.get('content-type'), 'application/octet-stream');
    assert.equal(response.headers.get('x-axiom-artifact-mime-type'), 'text/html');
    assert.match(response.headers.get('content-disposition') ?? '', new RegExp(`^attachment;.*${encodeURIComponent('鹈鹕动画.html')}`));
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.match(response.headers.get('content-security-policy') ?? '', /sandbox; default-src 'none'/);
    assert.ok(!Array.from(response.headers).some(([, value]) => value.includes(directory)));
    assert.equal((await get('another-user')).status, 404);
    assert.equal((await get('owner', 'another-tenant')).status, 404);
    const other = await tasks.createTask({ tenantId: 'tenant', userId: 'owner', sessionId: 'other', title: 'Other', input: 'Another file', mode: 'build' });
    assert.equal((await api.request(`/tasks/${other.id}/artifacts/files/${encodeURIComponent(id)}`, { headers: { 'x-axiom-tenant-id': 'tenant', 'x-axiom-user-id': 'owner' } })).status, 404);
    await catalog.removeTaskReferences(task.tenantId, task.id, [id]);
    assert.equal((await get()).status, 404);
    await catalog.register({ id, tenantId: task.tenantId, taskId: task.id, source: 'tool', mimeType: 'text/html', referenceKey: 'restored' });
    await catalog.markDeleted(task.tenantId, id);
    assert.equal((await get()).status, 404);
  } finally { await tasks.close(); await catalog.close(); await rm(directory, { recursive: true, force: true }); }
});

test('file delivery rejects expired, unsupported and over-limit artifacts before opening storage', async () => {
  const tasks = new SqliteTaskStore(':memory:'); const catalog = new SqliteArtifactCatalog(':memory:');
  await tasks.initialize(); await catalog.initialize();
  const task = await tasks.createTask({ tenantId: 'tenant', userId: 'owner', sessionId: 'session', title: 'Document', input: 'Create', mode: 'build' });
  let reads = 0;
  const api = createTaskApi({ store: tasks, hub: new EventHub(), coordinator: { nudge() {}, abort() {} } as never,
    artifactCatalog: catalog, artifactStore: { kind: 'filesystem', get: async () => { reads += 1; return '<svg />'; } } as never });
  try {
    for (const [suffix, mimeType, bytes, expiresAt] of [
      ['expired', 'image/svg+xml', 8, '2000-01-01T00:00:00.000Z'],
      ['executable', 'application/javascript', 8, undefined],
      ['large', 'text/plain', 512_001, undefined],
    ] as const) {
      const id = `tool:${task.id}:builder:${suffix}:artifact`;
      await catalog.register({ id, tenantId: task.tenantId, taskId: task.id, source: 'tool', mimeType, bytes, expiresAt, referenceKey: suffix });
      const response = await api.request(`/tasks/${task.id}/artifacts/files/${encodeURIComponent(id)}`, { headers: { 'x-axiom-tenant-id': 'tenant', 'x-axiom-user-id': 'owner' } });
      assert.equal(response.status, 404, suffix);
    }
    assert.equal(reads, 0);
  } finally { await tasks.close(); await catalog.close(); }
});
