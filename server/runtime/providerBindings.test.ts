import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ProviderBindingStore, type BoundProviderBundle } from './providerBindings.js';
import { SqliteTaskStore } from './sqliteTaskStore.js';
import { createTaskApi } from './taskApi.js';
import { EventHub } from './eventHub.js';
import { SqlitePluginStore } from './pluginStore.js';
import { fallbackChatRoute } from './chatRouter.js';

const owner = { tenantId: 'binding-tenant', userId: 'binding-user' };
const bundle = (): BoundProviderBundle => ({
  text: { apiKey: 'text-secret', baseUrl: 'https://text.example/v1', model: 'selected-text', location: 'internet' },
  vision: { apiKey: '', baseUrl: 'http://127.0.0.1:9981/v1', model: 'local-vision', location: 'local' },
  image: { apiKey: 'image-secret', baseUrl: 'https://image.example/v1', model: 'selected-image', location: 'internet' },
  video: null,
  search: { apiKey: 'search-secret', baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-flash', location: 'internet' },
});
const previousSecret = process.env.AXIOM_PROVIDER_SECRET;
test.before(() => { process.env.AXIOM_PROVIDER_SECRET = 'provider-binding-test-encryption'; });
test.after(() => { if (previousSecret === undefined) delete process.env.AXIOM_PROVIDER_SECRET; else process.env.AXIOM_PROVIDER_SECRET = previousSecret; });

test('encrypted provider bundles are immutable, owner scoped, and recover after process-store restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'axiom-provider-bindings-'));
  const path = join(directory, 'bindings.sqlite');
  let bindings = new ProviderBindingStore({ sqlitePath: path });
  try {
    await bindings.initialize();
    const providers = bundle();
    const reference = await bindings.create(owner, providers);
    providers.text!.apiKey = 'changed-secret';
    providers.text!.baseUrl = 'https://wrong-cloud.example';
    assert.equal(reference.capabilities?.video, false);
    assert.equal(JSON.stringify(reference).includes('secret'), false);
    await bindings.close();
    bindings = new ProviderBindingStore({ sqlitePath: path });
    await bindings.initialize();
    assert.equal((await bindings.resolve({ ...owner, ...reference }, 'text'))?.apiKey, 'text-secret');
    assert.equal((await bindings.resolve({ ...owner, ...reference }, 'vision'))?.apiKey, '');
    assert.equal(await bindings.resolve({ ...owner, ...reference }, 'video'), null);
    await assert.rejects(bindings.get({ ...owner, ...reference, userId: 'other-user' }), /not owned/);
    await assert.rejects(bindings.get({ ...owner, ...reference, tenantId: 'other-tenant' }), /not owned/);
    const inspection = new DatabaseSync(path);
    const stored = JSON.stringify(inspection.prepare('SELECT * FROM provider_bindings').all());
    inspection.close();
    for (const privateValue of ['text-secret', 'image-secret', 'text.example', 'selected-text']) assert.equal(stored.includes(privateValue), false);
    process.env.AXIOM_PROVIDER_SECRET = 'changed-key';
    await assert.rejects(bindings.get({ ...owner, ...reference }), /could not be decrypted/);
    process.env.AXIOM_PROVIDER_SECRET = 'provider-binding-test-encryption';
  } finally { await bindings.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('task enqueue and whole-task retry retain only the durable bundle reference', async () => {
  const bindings = new ProviderBindingStore();
  const tasks = new SqliteTaskStore(':memory:');
  await bindings.initialize(); await tasks.initialize();
  let captures = 0;
  const api = createTaskApi({ store: tasks, hub: new EventHub(), artifactStore: null,
    coordinator: { nudge() {}, abort() {} } as never,
    bindProviders: async (input, tenantId, userId) => {
      assert.equal(input.providerConfig?.text?.model, 'selected-text');
      captures += 1;
      return bindings.create({ tenantId, userId }, bundle());
    },
  });
  const headers = { 'content-type': 'application/json', 'x-axiom-tenant-id': owner.tenantId, 'x-axiom-user-id': owner.userId };
  try {
    const response = await api.request('/tasks', { method: 'POST', headers, body: JSON.stringify({ sessionId: 'chat', input: 'Analyze a report', providerConfig: { text: { model: 'selected-text', apiUrl: 'https://text.example/v1', apiKey: 'text-secret' } } }) });
    assert.equal(response.status, 202);
    const task = (await response.json()).task;
    assert.equal(task.model, 'selected-text');
    assert.equal((await tasks.getTask(task.id))?.providerBindingId, task.providerBindingId);
    const events = await tasks.getEvents(task.id);
    assert.equal(JSON.stringify({ task, events }).includes('text-secret'), false);
    await tasks.updateTask(task.id, { status: 'failed', error: 'Read interrupted' });
    const retried = await api.request(`/tasks/${task.id}/retry`, { method: 'POST', headers, body: '{}' });
    assert.equal(retried.status, 202);
    assert.equal((await retried.json()).task.providerBindingId, task.providerBindingId);
    assert.equal(captures, 1, 'Retry must not take a new mutable configuration snapshot');
  } finally { await bindings.close(); await tasks.close(); }
});

test('missing encryption secret rejects enqueue as unavailable, without creating a task', async () => {
  const tasks = new SqliteTaskStore(':memory:');
  const bindings = new ProviderBindingStore();
  await tasks.initialize(); await bindings.initialize();
  const api = createTaskApi({ store: tasks, hub: new EventHub(), artifactStore: null,
    coordinator: { nudge() {}, abort() {} } as never, bindProviders: async () => bindings.create(owner, bundle()) });
  try {
    process.env.AXIOM_PROVIDER_SECRET = '';
    const response = await api.request('/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 'chat', input: 'Work' }) });
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /AXIOM_PROVIDER_SECRET/);
    assert.equal((await tasks.listTasks('local', 100)).length, 0);
  } finally { process.env.AXIOM_PROVIDER_SECRET = 'provider-binding-test-encryption'; await tasks.close(); await bindings.close(); }
});

test('Mini App tasks pin user models, enforce plugin scope and never enter ordinary chat history', async () => {
  const tasks = new SqliteTaskStore(':memory:'); const bindings = new ProviderBindingStore(); const plugins = new SqlitePluginStore(':memory:');
  await tasks.initialize(); await bindings.initialize(); await plugins.initialize();
  const api = createTaskApi({ store: tasks, plugins, hub: new EventHub(), artifactStore: null, coordinator: { nudge() {}, abort() {} } as never,
    bindProviders: async (_input, tenantId, userId) => bindings.create({ tenantId, userId }, bundle()) });
  const headers = { 'content-type': 'application/json', 'x-axiom-tenant-id': owner.tenantId, 'x-axiom-user-id': owner.userId };
  try {
    const plugin = await plugins.createPlugin({ tenantId: owner.tenantId, createdBy: owner.userId, name: 'Research app', description: '', visibility: 'private', kind: 'mini-app',
      definition: { mode: 'analyze', htmlContent: '<html><body>Research</body></html>', agentEnabled: true, agentInstructions: 'Keep the plugin research scope.', toolNames: [] } });
    await plugins.updatePlugin(plugin.id, owner.tenantId, { status: 'published', updatedBy: owner.userId });
    const input = { sessionId: `plugin-${plugin.id}-run`, input: 'Analyze this topic', routing: fallbackChatRoute({ message: 'Analyze this topic', mode: 'analyze' }), providerConfig: { text: { model: 'selected-text', apiUrl: 'https://text.example/v1', apiKey: 'text-secret' } } };
    const send = (body: object, userId = owner.userId) => api.request(`/plugins/${plugin.id}/run`, { method: 'POST', headers: { ...headers, 'x-axiom-user-id': userId }, body: JSON.stringify(body) });
    assert.equal((await send({ ...input, sessionId: 'ordinary-session' })).status, 400);
    assert.equal((await send(input, 'someone-else')).status, 404);
    const response = await send(input);
    assert.equal(response.status, 202);
    const task = (await response.json()).task;
    assert.ok(task.providerBindingId); assert.match(task.input, /Keep the plugin research scope/);
    assert.deepEqual(task.policy.toolAllowlist, []);
    await tasks.updateTask(task.id, { status: 'completed', result: 'Result' });
    const sessions = await (await api.request('/sessions', { headers })).json();
    assert.equal(sessions.sessions.length, 0);
    assert.equal((await tasks.listTasks(owner.tenantId, 100)).length, 1);
    const save = await api.request(`/sessions/${input.sessionId}`, { method: 'PUT', headers, body: JSON.stringify({ title: 'Wrong projection', messages: [], updatedAt: 1 }) });
    assert.equal(save.status, 409);
  } finally { await tasks.close(); await bindings.close(); await plugins.close(); }
});

test('daily schedules reuse their pinned bundle on each triggered task instead of resnapshotting settings', async () => {
  const tasks = new SqliteTaskStore(':memory:'); const bindings = new ProviderBindingStore();
  await tasks.initialize(); await bindings.initialize();
  let captures = 0; let resolvedModel = '';
  const api = createTaskApi({ store: tasks, hub: new EventHub(), artifactStore: null, coordinator: { nudge() {}, abort() {} } as never,
    bindProviders: async (input, tenantId, userId) => {
      if (input.providerBindingId) { await bindings.get({ tenantId, userId, providerBindingId: input.providerBindingId }); return { providerBindingId: input.providerBindingId, model: 'selected-text' }; }
      captures += 1; return bindings.create({ tenantId, userId }, bundle());
    },
    boundModelFactory: async (value) => {
      resolvedModel = (await bindings.resolve(value, 'text'))!.model;
      return { model: resolvedModel, complete: async () => ({ content: '{}', durationMs: 1 }) } as never;
    },
  });
  const headers = { 'content-type': 'application/json', 'x-axiom-tenant-id': owner.tenantId, 'x-axiom-user-id': owner.userId };
  try {
    const created = await api.request('/schedules', { method: 'POST', headers, body: JSON.stringify({ sessionId: 'schedule-session', input: 'Summarize progress', intervalSeconds: 86400, enabled: false,
      providerConfig: { text: { model: 'selected-text', apiUrl: 'https://text.example/v1', apiKey: 'text-secret' } } }) });
    assert.equal(created.status, 201); const schedule = (await created.json()).schedule;
    assert.ok(schedule.providerBindingId); assert.equal(JSON.stringify(schedule).includes('text-secret'), false);
    const run = await api.request(`/schedules/${schedule.id}/run`, { method: 'POST', headers, body: '{}' });
    assert.equal(run.status, 202); assert.equal((await run.json()).task.providerBindingId, schedule.providerBindingId);
    assert.equal(captures, 1); assert.equal(resolvedModel, 'selected-text');
  } finally { await tasks.close(); await bindings.close(); }
});
