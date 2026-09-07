import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Pool } from 'pg';
import type { PersistedSession, TaskStore } from './contracts.js';
import type { ModelClient } from './modelClient.js';
import { EventHub } from './eventHub.js';
import { PostgresTaskStore } from './postgresTaskStore.js';
import { SqliteTaskStore } from './sqliteTaskStore.js';
import { createTaskApi } from './taskApi.js';

const historyContract = async (store: TaskStore, tenantId = `history-scale-${randomUUID()}`) => {
  await store.initialize();
  const userId = 'history-owner';
  const headers = { 'content-type': 'application/json', 'x-axiom-tenant-id': tenantId, 'x-axiom-user-id': userId };
  let modelCalls = 0;
  const model = { async complete() { modelCalls += 1; return { content: '# Historical report\n\nVerified test fixture.', finishReason: 'stop' }; } } as unknown as ModelClient;
  const api = createTaskApi({ store, hub: new EventHub(), coordinator: { nudge() {}, abort() {} } as never, reportModelFactory: () => model });
  const request = (path: string, init?: RequestInit) => api.request(new Request(`http://history.test${path}`, { headers, ...init }));
  const messages = Array.from({ length: 20 }, (_, index) => ({
    id: `message-${index}`, role: (index % 2 ? 'assistant' : 'user') as 'assistant' | 'user',
    content: `Historical message ${index}: retain the approved constraints.`, createdAt: 100 + index,
  }));
  const save = (body: object) => request('/sessions/old-session', { method: 'PUT', headers, body: JSON.stringify(body) });
  const original = await save({ id: 'old-session', title: 'Historical report', messages, updatedAt: 1000 });
  assert.equal(original.status, 200);
  const first = (await original.json() as { session: PersistedSession }).session;
  assert.equal(first.contextSummary?.version, 1);
  const terminal = await store.createTask({ tenantId, userId, sessionId: 'old-session', title: 'Old completed task', input: 'test', mode: 'analyze' });
  await store.updateTask(terminal.id, { status: 'completed', result: 'Completed' });
  const active = await store.createTask({ tenantId, userId, sessionId: 'old-session', title: 'Active task', input: 'test', mode: 'analyze' });
  await store.updateTask(active.id, { status: 'running' });
  const otherUser = await store.createTask({ tenantId, userId: 'another-owner', sessionId: 'old-session', title: 'Other owner', input: 'test', mode: 'analyze' });
  await store.updateTask(otherUser.id, { status: 'completed' });
  for (let index = 0; index < 150; index += 1) {
    await store.upsertSession(tenantId, userId, { id: `new-session-${index}`, title: 'Newer history', messages: [], updatedAt: 2000 + index });
    await store.createTask({ tenantId, userId: 'another-owner', sessionId: `new-session-${index}`, title: 'Newer task', input: 'test', mode: 'analyze' });
  }
  assert.equal((await store.listSessions(tenantId, userId, 100)).some((item) => item.id === 'old-session'), false);
  assert.equal((await store.listTasks(tenantId, 100)).some((item) => item.id === terminal.id), false);
  assert.equal((await store.getSession('old-session', tenantId, userId))?.contextSummary?.version, 1);
  assert.equal(await store.getSession('old-session', tenantId, 'another-owner'), null);
  assert.equal(await store.getSession('old-session', 'another-tenant', userId), null);
  assert.equal(await store.deleteTask(terminal.id, tenantId, terminal.revision), false, 'Stale revisions cannot delete a changed task.');
  const exported = await request('/reports/export', {
    method: 'POST', headers, body: JSON.stringify({ sessionId: 'old-session', format: 'md', scope: 'conversation', instruction: 'Export this conversation.' }),
  });
  assert.equal(exported.status, 200, await exported.clone().text());
  assert.match(await exported.text(), /Historical report/);
  const forbidden = await request('/reports/export', {
    method: 'POST', headers: { ...headers, 'x-axiom-user-id': 'another-owner' },
    body: JSON.stringify({ sessionId: 'old-session', format: 'md', scope: 'conversation', instruction: 'Export.' }),
  });
  assert.equal(forbidden.status, 404);
  assert.equal(modelCalls, 1);
  const updated = await save({ id: 'old-session', title: 'Historical report', messages: [...messages, ...messages.slice(0, 4).map((message, index) => ({ ...message, id: `new-message-${index}`, createdAt: 5000 + index }))], updatedAt: 5000 });
  assert.equal(updated.status, 200);
  const second = (await updated.json() as { session: PersistedSession }).session;
  assert.equal(second.contextSummary?.version, 2, 'An old session must retain its prior summary version.');
  const deleted = await request('/sessions/old-session', { method: 'DELETE', headers });
  assert.equal(deleted.status, 204);
  assert.equal(await store.getTask(terminal.id, tenantId), null, 'Cascade deletion must not depend on the most recent task page.');
  assert.ok(await store.getTask(active.id, tenantId), 'Active tasks retain the existing cancellation contract.');
  assert.ok(await store.getTask(otherUser.id, tenantId), 'Other users must not be affected.');
  const deletedExport = await request('/reports/export', {
    method: 'POST', headers, body: JSON.stringify({ sessionId: 'old-session', format: 'md', scope: 'conversation', instruction: 'Export.' }),
  });
  assert.equal(deletedExport.status, 404);
};

test('history operations remain complete beyond the recent-page boundary (SQLite)', async () => {
  const store = new SqliteTaskStore(':memory:');
  try { await historyContract(store); } finally { await store.close(); }
});

test('history operations remain complete beyond the recent-page boundary (PostgreSQL)', { skip: !process.env.AXIOM_TEST_DATABASE_URL }, async () => {
  const store = new PostgresTaskStore(process.env.AXIOM_TEST_DATABASE_URL!);
  const tenantId = `history-scale-${randomUUID()}`;
  const pool = new Pool({ connectionString: process.env.AXIOM_TEST_DATABASE_URL, max: 1 });
  try { await historyContract(store, tenantId); }
  finally {
    try {
      await pool.query('DELETE FROM tasks WHERE tenant_id=$1', [tenantId]);
      await pool.query('DELETE FROM sessions WHERE tenant_id=$1', [tenantId]);
    } finally { await Promise.all([store.close(), pool.end()]); }
  }
});

test('session cleanup preserves a task resumed after the relationship lookup', async () => {
  const store = new SqliteTaskStore(':memory:');
  await store.initialize();
  try {
    const task = await store.createTask({ tenantId: 'local', userId: 'operator', sessionId: 'racing-session', title: 'Resumed task', input: 'test', mode: 'analyze' });
    await store.updateTask(task.id, { status: 'completed' });
    const remove = store.deleteTask.bind(store);
    store.deleteTask = async (...args) => {
      await store.updateTask(task.id, { status: 'queued' });
      return remove(...args);
    };
    const api = createTaskApi({ store, hub: new EventHub(), coordinator: { nudge() {}, abort() {} } as never });
    assert.equal((await api.request('/sessions/racing-session', { method: 'DELETE', headers: { 'x-axiom-tenant-id': 'local', 'x-axiom-user-id': 'operator' } })).status, 204);
    assert.equal((await store.getTask(task.id))?.status, 'queued');
  } finally { await store.close(); }
});
