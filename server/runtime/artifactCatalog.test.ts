import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { SqliteArtifactCatalog } from './artifactCatalog.js';

test('SQLite Artifact catalog is idempotent, tenant-scoped, and tracks references', async () => {
  const root = await mkdtemp(join(tmpdir(), 'axiom-artifact-catalog-'));
  const path = join(root, 'catalog.sqlite');
  const workerA = new SqliteArtifactCatalog(path);
  const workerB = new SqliteArtifactCatalog(path);
  try {
    await workerA.initialize();
    await workerB.initialize();
    const first = await workerA.register({
      id: 'result:task-a', tenantId: 'tenant-a', taskId: 'task-a', source: 'result',
      storageKey: 's3://bucket/a', bytes: 42, mimeType: 'text/markdown', referenceKey: 'result',
    });
    assert.equal(first.referenceCount, 1);
    const duplicate = await workerB.register({
      id: 'result:task-a', tenantId: 'tenant-a', taskId: 'task-a', source: 'result',
      storageKey: 's3://bucket/a', bytes: 40, referenceKey: 'result',
    });
    assert.equal(duplicate.referenceCount, 1);
    assert.equal((await workerB.stats('tenant-a')).active, 1);
    assert.equal((await workerB.stats('tenant-b')).total, 0);

    assert.equal(await workerB.removeTaskReferences('tenant-a', 'task-a', ['result:task-a']), 1);
    const orphan = (await workerA.listOrphans('tenant-a'))[0];
    assert.equal(orphan?.id, 'result:task-a');
    assert.equal(orphan?.status, 'orphaned');
    assert.equal((await workerA.stats('tenant-a')).orphaned, 1);
  } finally {
    await workerA.close();
    await workerB.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('Artifact cleanup failures stay retryable and successful cleanup is terminal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'axiom-artifact-cleanup-'));
  const catalog = new SqliteArtifactCatalog(join(root, 'catalog.sqlite'));
  try {
    await catalog.initialize();
    await catalog.register({ id: 'tool:task-b:step:call', tenantId: 'tenant-a', taskId: 'task-b', source: 'tool', bytes: 8 });
    await catalog.markDeletePending('tenant-a', 'tool:task-b:step:call', '任务删除');
    await catalog.recordCleanupFailure('tenant-a', 'tool:task-b:step:call', '对象存储超时');
    const candidate = (await catalog.listCleanupCandidates('tenant-a'))[0];
    assert.equal(candidate?.status, 'delete_pending');
    assert.equal(candidate?.cleanupAttempts, 1);
    assert.equal(candidate?.lastError, '对象存储超时');
    assert.equal((await catalog.stats('tenant-a')).cleanupFailures, 1);
    assert.equal(await catalog.markDeleted('tenant-a', 'tool:task-b:step:call'), true);
    assert.equal((await catalog.listCleanupCandidates('tenant-a')).length, 0);
    assert.equal((await catalog.stats('tenant-a')).deleted, 1);
  } finally {
    await catalog.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('expired Artifacts enter the cleanup candidate queue without crossing tenants', async () => {
  const root = await mkdtemp(join(tmpdir(), 'axiom-artifact-expiry-'));
  const catalog = new SqliteArtifactCatalog(join(root, 'catalog.sqlite'));
  try {
    await catalog.initialize();
    await catalog.register({ id: 'result:expired', tenantId: 'tenant-a', taskId: 'task-c', source: 'result', expiresAt: '2020-01-01T00:00:00.000Z' });
    await catalog.register({ id: 'result:other', tenantId: 'tenant-b', taskId: 'task-d', source: 'result', expiresAt: '2020-01-01T00:00:00.000Z' });
    const candidates = await catalog.listCleanupCandidates('tenant-a');
    assert.deepEqual(candidates.map((item) => item.id), ['result:expired']);
    assert.equal((await catalog.listCleanupCandidates('tenant-b'))[0]?.id, 'result:other');
  } finally {
    await catalog.close();
    await rm(root, { recursive: true, force: true });
  }
});
