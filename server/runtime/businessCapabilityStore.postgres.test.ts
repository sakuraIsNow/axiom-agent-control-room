import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  BusinessRecordRevisionConflictError,
  PostgresBusinessCapabilityStore,
  type BusinessRecord,
  type BusinessRecordKind,
} from './businessCapabilityStore.js';
import { PostgresIntegrationCredentialStore } from './integrationCredentialStore.js';

const connectionString = process.env.AXIOM_TEST_DATABASE_URL?.trim();

test('PostgreSQL business records preserve CRUD, tenant isolation, revisions, and multi-worker cleanup', {
  skip: connectionString ? false : 'AXIOM_TEST_DATABASE_URL is not configured.',
}, async () => {
  const first = new PostgresBusinessCapabilityStore(connectionString!);
  const second = new PostgresBusinessCapabilityStore(connectionString!);
  const credentials = new PostgresIntegrationCredentialStore(connectionString!);
  const credentialReader = new PostgresIntegrationCredentialStore(connectionString!);
  const suffix = randomUUID();
  const tenantId = `business-pg-${suffix}`;
  const foreignTenantId = `business-pg-foreign-${suffix}`;
  const created: BusinessRecord[] = [];
  const remember = <T extends BusinessRecord>(record: T) => { created.push(record); return record; };
  const previousSecret = process.env.AXIOM_INTEGRATION_SECRET;
  process.env.AXIOM_INTEGRATION_SECRET = 'postgres-integration-test-secret-32-bytes';
  await Promise.all([first.initialize(), second.initialize(), credentials.initialize(), credentialReader.initialize()]);
  try {
    const project = remember(await first.create({
      tenantId, userId: 'owner', ownerId: 'owner', kind: 'project', status: 'active',
      data: { name: 'PostgreSQL 协作项目', resources: { task: ['shared-task', 'keep-task'], schedule: ['schedule-a'] } },
    }));
    const sibling = remember(await first.create({
      tenantId, userId: 'owner', ownerId: 'owner', kind: 'project', status: 'active',
      data: { name: '同租户项目', resources: { task: ['shared-task'] } },
    }));
    const foreign = remember(await first.create({
      tenantId: foreignTenantId, userId: 'foreign', ownerId: 'foreign', kind: 'project', status: 'active',
      data: { name: '其他租户', resources: { task: ['shared-task'] } },
    }));
    const comment = remember(await first.create({
      tenantId, userId: 'editor', ownerId: 'editor', projectId: project.id, kind: 'project-comment', status: 'active',
      data: { body: 'PostgreSQL 评论' },
    }));

    assert.equal(await second.get(project.id, foreignTenantId), null);
    assert.deepEqual((await second.list(tenantId, 'project-comment', { projectId: project.id })).map((item) => item.id), [comment.id]);
    assert.ok((await second.listAll('project')).some((item) => item.id === project.id));

    const concurrent = await Promise.allSettled([
      first.update(project.id, tenantId, { data: { ...project.data, name: 'Worker A' } }, project.revision),
      second.update(project.id, tenantId, { data: { ...project.data, name: 'Worker B' } }, project.revision),
    ]);
    assert.equal(concurrent.filter((result) => result.status === 'fulfilled').length, 1);
    const rejection = concurrent.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    assert.ok(rejection?.reason instanceof BusinessRecordRevisionConflictError);
    const afterRace = await first.get(project.id, tenantId);
    assert.equal(afterRace?.revision, 2);
    assert.ok(['Worker A', 'Worker B'].includes(String(afterRace?.data.name)));

    const cleanup = await Promise.all([
      first.unlinkProjectResource(tenantId, 'task', 'shared-task'),
      second.unlinkProjectResource(tenantId, 'task', 'shared-task'),
    ]);
    assert.equal(cleanup[0] + cleanup[1], 2);
    const cleanedProject = await first.get(project.id, tenantId);
    const cleanedSibling = await first.get(sibling.id, tenantId);
    assert.deepEqual((cleanedProject?.data.resources as { task: string[] }).task, ['keep-task']);
    assert.deepEqual((cleanedSibling?.data.resources as { task: string[] }).task, []);
    assert.deepEqual(((await first.get(foreign.id, foreignTenantId))?.data.resources as { task: string[] }).task, ['shared-task']);

    const archived = await second.update(project.id, tenantId, { status: 'archived' }, cleanedProject!.revision);
    assert.equal(archived.status, 'archived');
    assert.equal(await first.delete(comment.id, tenantId), true);
    assert.equal(await second.get(comment.id, tenantId), null);

    const savedCredential = await credentials.upsert({
      tenantId, userId: 'owner', provider: 'feishu', name: 'PostgreSQL 飞书', authType: 'service-account',
      secrets: { appId: 'cli_postgres', appSecret: 'postgres-never-return-secret' },
    });
    assert.equal(JSON.stringify(savedCredential).includes('postgres-never-return-secret'), false);
    assert.equal((await credentialReader.get(savedCredential.id, tenantId))?.secrets.appSecret, 'postgres-never-return-secret');
    assert.equal(await credentialReader.get(savedCredential.id, foreignTenantId), null);
    await assert.rejects(credentials.upsert({
      tenantId: foreignTenantId, userId: 'foreign', provider: 'feishu', name: '越权覆盖', authType: 'service-account',
      secrets: { appId: 'cli_foreign', appSecret: 'cross-tenant-secret' },
    }, savedCredential.id), /tenant/i);
    assert.equal((await credentialReader.get(savedCredential.id, tenantId))?.secrets.appSecret, 'postgres-never-return-secret');
    assert.equal(await credentials.delete(savedCredential.id, tenantId), true);
  } finally {
    const kinds: BusinessRecordKind[] = ['project-comment', 'project-notification', 'review-assignment', 'memory', 'tool-source', 'nexus-artifact', 'nexus-test-case', 'nexus-test-run', 'nexus-release', 'task-action', 'feedback', 'decision', 'project'];
    for (const record of created) await first.delete(record.id, record.tenantId).catch(() => false);
    for (const kind of kinds) {
      for (const record of await first.list(tenantId, kind, { limit: 500 }).catch(() => [])) await first.delete(record.id, tenantId).catch(() => false);
      for (const record of await first.list(foreignTenantId, kind, { limit: 500 }).catch(() => [])) await first.delete(record.id, foreignTenantId).catch(() => false);
    }
    await Promise.all([first.close(), second.close(), credentials.close(), credentialReader.close()]);
    if (previousSecret === undefined) delete process.env.AXIOM_INTEGRATION_SECRET;
    else process.env.AXIOM_INTEGRATION_SECRET = previousSecret;
  }
});
