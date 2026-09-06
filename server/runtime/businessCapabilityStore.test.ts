import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SqliteBusinessCapabilityStore, ToolCallQuotaError } from './businessCapabilityStore.js';

test('business records persist revisions, tenant isolation, filters, and project reference cleanup', async () => {
  const store = new SqliteBusinessCapabilityStore(':memory:');
  await store.initialize();
  try {
    const project = await store.create({
      tenantId: 'tenant-a',
      userId: 'owner-a',
      ownerId: 'owner-a',
      kind: 'project',
      status: 'active',
      data: {
        name: '生产项目',
        resources: { task: ['task-a', 'task-b'], session: ['session-a'] },
      },
    });
    await store.create({
      tenantId: 'tenant-b',
      userId: 'owner-b',
      ownerId: 'owner-b',
      kind: 'project',
      status: 'active',
      data: { name: '其他租户项目', resources: { task: ['task-a'] } },
    });
    const comment = await store.create({
      tenantId: 'tenant-a',
      userId: 'editor-a',
      ownerId: 'editor-a',
      projectId: project.id,
      kind: 'project-comment',
      status: 'active',
      data: { body: '第一条评论' },
    });

    assert.equal((await store.get(project.id, 'tenant-b')), null);
    assert.deepEqual((await store.list('tenant-a', 'project-comment', { projectId: project.id })).map((item) => item.id), [comment.id]);

    const updated = await store.update(project.id, 'tenant-a', { data: { ...project.data, name: '生产项目 V2' } }, project.revision);
    assert.equal(updated.revision, 2);
    assert.equal(updated.data.name, '生产项目 V2');
    await assert.rejects(
      store.update(project.id, 'tenant-a', { status: 'archived' }, project.revision),
      /期望版本 1，当前版本 2/,
    );

    assert.equal(await store.unlinkProjectResource('tenant-a', 'task', 'task-a'), 1);
    const cleaned = await store.get(project.id, 'tenant-a');
    assert.deepEqual((cleaned?.data.resources as { task: string[] }).task, ['task-b']);
    const foreign = (await store.list('tenant-b', 'project'))[0];
    assert.deepEqual((foreign?.data.resources as { task: string[] }).task, ['task-a']);
    assert.equal(await store.unlinkProjectResource('tenant-a', 'task', 'missing'), 0);
  } finally {
    await store.close();
  }
});

test('tool execution claims are atomic, survive list windows, and count full source usage', async () => {
  const store = new SqliteBusinessCapabilityStore(':memory:');
  await store.initialize();
  const input = { tenantId: 'tenant', userId: 'user', sourceId: 'source', approvalId: 'approval', data: { signature: 'same' }, hourlyQuota: 1000 };
  try {
    const claims = await Promise.all([store.claimToolCall(input), store.claimToolCall(input)]);
    assert.equal(claims.filter((claim) => claim.claimed).length, 1);
    assert.equal(claims[0].record.id, claims[1].record.id);
    const record = claims[0].record;
    await store.update(record.id, 'tenant', { status: 'completed' }, record.revision);
    for (let index = 0; index < 510; index++) await store.create({ tenantId: 'tenant', userId: 'user', ownerId: 'user', kind: 'task-action', status: 'completed', data: { action: 'tool-call', sourceId: 'unrelated' } });
    const replay = await store.claimToolCall(input);
    assert.equal(replay.claimed, false);
    assert.equal(replay.record.status, 'completed');
    await assert.rejects(store.claimToolCall({ ...input, approvalId: 'other', hourlyQuota: 1 }), ToolCallQuotaError);
    const otherTenant = await store.claimToolCall({ ...input, tenantId: 'other', hourlyQuota: 1 });
    assert.equal(otherTenant.claimed, true);
    const noApproval = { ...input, approvalId: undefined, sourceId: 'quota-source', hourlyQuota: 1 };
    const quotaRace = await Promise.allSettled([store.claimToolCall(noApproval), store.claimToolCall(noApproval)]);
    assert.equal(quotaRace.filter((result) => result.status === 'fulfilled').length, 1);
    assert.ok(quotaRace.some((result) => result.status === 'rejected' && result.reason instanceof ToolCallQuotaError));
  } finally { await store.close(); }
});
