import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createBusinessCapabilityApi } from './businessCapabilities.js';
import { SqliteBusinessCapabilityStore } from './businessCapabilityStore.js';
import { SqliteTaskStore } from './sqliteTaskStore.js';
import { SqliteTemplateStore } from './templateStore.js';
import type { ProviderBindingReference, ProviderConfig } from './providerBindings.js';

const fixture = async (bindProviders?: Parameters<typeof createBusinessCapabilityApi>[0]['bindProviders'], service = 'builder') => {
  const records = new SqliteBusinessCapabilityStore(':memory:');
  const tasks = new SqliteTaskStore(':memory:');
  const templates = new SqliteTemplateStore(':memory:');
  await records.initialize(); await tasks.initialize(); await templates.initialize();
  const workflow = await templates.createTemplate({ tenantId: 'nexus-binding', createdBy: 'owner', name: 'Bound Nexus', description: 'Test', definition: {
    kind: 'agent-workflow', mode: 'build', policy: { maxConcurrentSteps: 6, requirePlanApproval: false }, agentIds: [service], toolNames: [], model: 'old-definition-model',
    plan: { summary: 'Test', routingReason: 'Test', steps: [] },
    workflow: { schemaVersion: 1, scopedAgents: [], nodes: [
      { id: 'input', type: 'input', name: 'Input', position: { x: 0, y: 0 } },
      { id: 'agent', type: 'agent', name: 'Agent', position: { x: 200, y: 0 }, agentRef: { source: 'builtin', id: service } },
      { id: 'output', type: 'output', name: 'Output', position: { x: 400, y: 0 } },
    ], edges: [{ id: 'a', source: 'input', target: 'agent', kind: 'flow' }, { id: 'b', source: 'agent', target: 'output', kind: 'flow' }] },
  } });
  for (const input of ['first input', 'second input']) await records.create({ tenantId: 'nexus-binding', userId: 'owner', ownerId: 'owner', kind: 'nexus-test-case', status: 'active', data: { workflowId: workflow.id, input, expectedIncludes: [] } });
  const api = createBusinessCapabilityApi({ records, tasks, templates, bindProviders, coordinator: { nudge() {} } as never });
  const run = (body?: unknown, user = 'owner') => api.request(`/nexus/${workflow.id}/test-run`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-axiom-tenant-id': 'nexus-binding', 'x-axiom-user-id': user }, ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}) });
  return { records, tasks, workflow, run, close: async () => { await templates.close(); await tasks.close(); await records.close(); } };
};

test('Nexus test cases bind one owner-selected provider snapshot and override the stale definition model', async () => {
  const id = randomUUID();
  let configs: ProviderConfig | undefined;
  let bindings = 0;
  const f = await fixture(async (input, tenantId, userId) => {
    bindings += 1; configs = input.providerConfig;
    assert.equal(tenantId, 'nexus-binding'); assert.equal(userId, 'owner');
    return { providerBindingId: id, model: 'selected-local-text' };
  });
  try {
    const response = await f.run({ providerConfig: { text: { model: 'selected-local-text', apiUrl: 'http://127.0.0.1:9009/v1', location: 'local' } } });
    assert.equal(response.status, 202, await response.clone().text());
    assert.equal(bindings, 1);
    assert.equal(configs?.text?.model, 'selected-local-text');
    const result = await response.json() as { runs: Array<{ taskId: string }> };
    assert.equal(result.runs.length, 2);
    for (const run of result.runs) {
      const task = await f.tasks.getTask(run.taskId);
      assert.equal(task?.providerBindingId, id);
      assert.equal(task?.model, 'selected-local-text');
      assert.equal(task?.sessionId, `agent-nexus-test-${f.workflow.id}`);
    }
  } finally { await f.close(); }
});

test('Nexus rejects malformed, unavailable and non-owner provider requests before creating tasks', async () => {
  const f = await fixture(async () => { throw new Error('Credential not owned'); });
  try {
    assert.equal((await f.run('{invalid')).status, 400);
    assert.equal((await f.run({ providerBindingId: randomUUID() })).status, 400);
    assert.equal((await f.run({}, 'other-user')).status, 404);
    assert.equal((await f.tasks.listTasks('nexus-binding')).length, 0);
  } finally { await f.close(); }
});

test('Nexus allows a configured user image provider without global keys and rejects missing bound capability', async () => {
  const reference: ProviderBindingReference = { providerBindingId: randomUUID(), model: 'selected', capabilities: { vision: false, image: true, video: false, search: false } };
  const f = await fixture(async () => reference, 'drawing-agent');
  try {
    assert.equal((await f.run()).status, 202);
    reference.capabilities!.image = false;
    assert.equal((await f.run()).status, 409);
    assert.equal((await f.tasks.listTasks('nexus-binding')).length, 2);
  } finally { await f.close(); }
});
