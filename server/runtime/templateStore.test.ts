import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteTemplateStore } from './templateStore.js';

const definition = {
  mode: 'build' as const,
  model: 'tenant-model',
  policy: { requirePlanApproval: true, maxTokens: 50_000 },
  agentIds: ['builder', 'reviewer'],
  toolNames: ['workspace.test'],
  promptPrefix: 'Use evidence and show verification steps.',
};

test('SqliteTemplateStore persists published versions and supports rollback', async () => {
  const store = new SqliteTemplateStore(':memory:');
  await store.initialize();
  try {
    const created = await store.createTemplate({
      tenantId: 'tenant-a',
      createdBy: 'operator-a',
      name: 'Release checklist',
      description: 'Production release workflow',
      definition,
    });
    assert.equal(created.version, 1);
    assert.equal(created.status, 'draft');
    assert.equal(created.visibility, 'private');
    assert.deepEqual(created.definition.agentIds, ['builder', 'reviewer']);

    const published = await store.updateTemplate(created.id, 'tenant-a', {
      status: 'published',
      updatedBy: 'operator-a',
    });
    assert.equal(published.status, 'published');
    assert.equal(published.version, 1);

    const updated = await store.updateTemplate(created.id, 'tenant-a', {
      definition: { ...definition, agentIds: ['analyst', 'builder', 'reviewer'] },
      updatedBy: 'operator-a',
    });
    assert.equal(updated.version, 2);
    assert.equal(updated.status, 'published');
    assert.equal(updated.history.length, 1);

    const rolledBack = await store.rollbackTemplate(created.id, 'tenant-a', 1, 'operator-a');
    assert.equal(rolledBack.version, 3);
    assert.equal(rolledBack.status, 'draft');
    assert.deepEqual(rolledBack.definition.agentIds, ['builder', 'reviewer']);
    assert.equal((await store.getTemplate(created.id, 'tenant-b')), null);
    assert.equal((await store.listTemplates('tenant-a')).length, 1);
  } finally {
    await store.close();
  }
});

test('team templates are visible to tenant members while private templates stay owner-scoped', async () => {
  const store = new SqliteTemplateStore(':memory:');
  await store.initialize();
  try {
    const privateTemplate = await store.createTemplate({
      tenantId: 'tenant-a',
      createdBy: 'operator-a',
      name: 'Private',
      description: '',
      definition,
    });
    const teamTemplate = await store.createTemplate({
      tenantId: 'tenant-a',
      createdBy: 'operator-a',
      name: 'Team',
      description: '',
      definition,
      visibility: 'team',
    });

    const memberTemplates = await store.listTemplates('tenant-a', 50, { userId: 'operator-b', role: 'member' });
    assert.deepEqual(memberTemplates.map((template) => template.id), [teamTemplate.id]);
    assert.equal(await store.getTemplate(privateTemplate.id, 'tenant-a', { userId: 'operator-b', role: 'member' }), null);
    assert.equal((await store.getTemplate(teamTemplate.id, 'tenant-a', { userId: 'operator-b', role: 'member' }))?.visibility, 'team');
    assert.equal((await store.listTemplates('tenant-a', 50, { userId: 'operator-a', role: 'member' })).length, 2);
  } finally {
    await store.close();
  }
});

test('archived templates cannot be edited or rolled back', async () => {
  const store = new SqliteTemplateStore(':memory:');
  await store.initialize();
  try {
    const created = await store.createTemplate({
      tenantId: 'tenant-a',
      createdBy: 'operator-a',
      name: 'Archived',
      description: '',
      definition,
    });
    await store.updateTemplate(created.id, 'tenant-a', { status: 'archived', updatedBy: 'operator-a' });
    await assert.rejects(
      store.updateTemplate(created.id, 'tenant-a', { name: 'new', updatedBy: 'operator-a' }),
      /archived/i,
    );
    await assert.rejects(
      store.rollbackTemplate(created.id, 'tenant-a', 1, 'operator-a'),
      /archived/i,
    );
  } finally {
    await store.close();
  }
});

test('template persistence retains visual Agent workflow definitions and scoped Agents', async () => {
  const store = new SqliteTemplateStore(':memory:');
  await store.initialize();
  try {
    const created = await store.createTemplate({
      tenantId: 'tenant-a',
      createdBy: 'operator-a',
      name: 'Scoped workflow',
      description: '',
      definition: {
        ...definition,
        kind: 'agent-workflow',
        workflow: {
          schemaVersion: 1,
          nodes: [
            { id: 'input', type: 'input', name: '输入', position: { x: 0, y: 0 } },
            { id: 'agent', type: 'agent', name: '私有 Agent', position: { x: 200, y: 0 }, agentRef: { source: 'workflow', id: 'scoped' } },
            { id: 'output', type: 'output', name: '输出', position: { x: 400, y: 0 } },
          ],
          edges: [
            { id: 'e1', source: 'input', target: 'agent', kind: 'flow' },
            { id: 'e2', source: 'agent', target: 'output', kind: 'flow' },
          ],
          scopedAgents: [{
            id: 'scoped',
            roleId: 'scoped-agent',
            name: '私有 Agent',
            description: '',
            systemPromptTemplate: 'Only this workflow can use these instructions.',
            toolAllowlist: [],
          }],
        },
      },
    });
    const loaded = await store.getTemplate(created.id, 'tenant-a');
    assert.equal(loaded?.definition.kind, 'agent-workflow');
    assert.equal(loaded?.definition.workflow?.scopedAgents[0]?.roleId, 'scoped-agent');
  } finally {
    await store.close();
  }
});
