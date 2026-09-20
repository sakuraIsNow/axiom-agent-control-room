import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createImprovementApi } from './improvementApi.js';
import { PostgresBusinessCapabilityStore } from './businessCapabilityStore.js';
import { PostgresTaskStore } from './postgresTaskStore.js';
import { signPrincipal } from './principal.js';
import type { ModelClient } from './modelClient.js';
import type { ImprovementProposal } from '../shared/improvement.js';

const connectionString = process.env.AXIOM_TEST_DATABASE_URL?.trim();

test('PostgreSQL improvement candidates deduplicate workers, fence revisions and reload durable private proposals', {
  skip: connectionString ? false : 'AXIOM_TEST_DATABASE_URL is not configured.', timeout: 20_000,
}, async () => {
  const tenantId = `improvement-pg-${randomUUID()}`;
  const userId = 'improvement-owner';
  const secret = 'improvement-pg-only-test-secret-32-bytes';
  const previousSecret = process.env.AXIOM_PRINCIPAL_SECRET;
  process.env.AXIOM_PRINCIPAL_SECRET = secret;
  const firstRecords = new PostgresBusinessCapabilityStore(connectionString!);
  const secondRecords = new PostgresBusinessCapabilityStore(connectionString!);
  const firstTasks = new PostgresTaskStore(connectionString!);
  const secondTasks = new PostgresTaskStore(connectionString!);
  let calls = 0;
  let started!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const model: ModelClient = { model: 'fake-pg-model', async complete(request) {
    calls += 1;
    assert.equal(request.toolChoice, 'none');
    assert.ok(!request.tools?.length);
    started();
    await gate;
    return { attempts: 1, durationMs: 5, finishReason: 'stop', content: JSON.stringify({
      summary: 'Improve evidence quality.', observations: [{ finding: 'No cited source.', evidence: 'The task result is an unsupported claim.' }],
      changes: [{ target: 'verification', suggestion: 'Check sources.', reason: 'Avoid unsupported conclusions.' }],
      trialInstruction: 'Check sources before answering.', validationCases: [{ input: 'Compare storage.', expectedBehavior: 'Cited and qualified claims.' }], risks: [],
    }) };
  } };
  const signedHeaders = (requestedUserId = userId) => {
    const token = signPrincipal({ tenantId, userId: requestedUserId, role: 'owner' }, secret);
    const separator = token.indexOf('.');
    return { 'content-type': 'application/json', 'x-axiom-principal': token.slice(0, separator), 'x-axiom-principal-signature': token.slice(separator + 1) };
  };
  let sourceTaskId: string | undefined;
  let pending: Promise<Response> | undefined;
  try {
    await firstRecords.initialize();
    await firstTasks.initialize();
    await secondRecords.initialize();
    await secondTasks.initialize();
    const task = await firstTasks.createTask({ tenantId, userId, sessionId: randomUUID(), title: 'RSI isolated PostgreSQL regression', input: 'Compare storage options.', mode: 'analyze' });
    sourceTaskId = task.id;
    await firstTasks.updateTask(task.id, { status: 'completed', result: 'An unsupported claim.' });
    const first = createImprovementApi({ records: firstRecords, tasks: firstTasks, resolveModel: async () => model });
    const second = createImprovementApi({ records: secondRecords, tasks: secondTasks, resolveModel: async () => model });
    const request = async (api: typeof first, path: string, init: RequestInit = {}) => api.request(new Request(`http://improvement-pg.test${path}`, { ...init, headers: init.headers ?? signedHeaders() }));
    const sourceResponse = await request(first, '/sources');
    assert.equal(sourceResponse.status, 200);
    assert.deepEqual((await sourceResponse.json() as { tasks: Array<{ id: string }> }).tasks.map((source) => source.id), [task.id]);
    assert.equal((await firstTasks.listTasks(tenantId, 1, { userId: 'another-owner', statuses: ['completed'] })).length, 0);
    assert.equal((await firstTasks.listTasks(tenantId, 1, { userId, statuses: ['running'] })).length, 0);
    assert.equal((await firstTasks.listTasks(tenantId, 1, { userId, statuses: [] })).length, 0);
    const body = JSON.stringify({ taskId: task.id, language: 'en', idempotencyKey: randomUUID() });
    pending = request(first, '/', { method: 'POST', body });
    // Promise.race does not cancel its losing branch. Never consume the shared
    // Response here: the pending branch still settles after model entry wins.
    await Promise.race([entered, pending.then((response) => { throw new Error(`Creation ended before model entry: HTTP ${response.status}`); })]);
    const duplicate = await request(second, '/', { method: 'POST', body });
    assert.equal(duplicate.status, 200, await duplicate.clone().text());
    const waiting = await duplicate.json() as { proposal: ImprovementProposal };
    assert.equal(waiting.proposal.status, 'generating');
    release();
    const created = await pending;
    assert.equal(created.status, 201, await created.clone().text());
    const { proposal } = await created.json() as { proposal: ImprovementProposal };
    assert.equal(proposal.status, 'draft');
    assert.equal(proposal.id, waiting.proposal.id);
    assert.equal(calls, 1);
    assert.equal((await firstRecords.list(tenantId, 'improvement-proposal')).length, 1);
    const restarted = createImprovementApi({ records: secondRecords, tasks: secondTasks, resolveModel: async () => { throw new Error('Read-only reload must not invoke the model.'); } });
    const reloaded = await request(restarted, `/${proposal.id}`);
    assert.equal(reloaded.status, 200);
    assert.deepEqual((await reloaded.json() as { proposal: ImprovementProposal }).proposal, proposal);
    assert.equal((await request(restarted, `/${proposal.id}`, { headers: signedHeaders('another-owner') })).status, 404);
    const patches = await Promise.all([
      request(first, `/${proposal.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'accepted', revision: proposal.revision }) }),
      request(second, `/${proposal.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'dismissed', revision: proposal.revision }) }),
    ]);
    assert.deepEqual(patches.map((response) => response.status).sort(), [200, 409]);
    assert.equal((await firstRecords.get(proposal.id, tenantId))?.revision, proposal.revision + 1);
    assert.equal((await firstTasks.listTasks(tenantId, 100)).length, 1);
    assert.equal(calls, 1);
  } finally {
    release();
    await pending?.catch(() => undefined);
    for (const record of await firstRecords.list(tenantId, 'improvement-proposal').catch(() => [])) await firstRecords.delete(record.id, tenantId);
    if (sourceTaskId) await firstTasks.deleteTask(sourceTaskId, tenantId);
    await Promise.all([firstRecords.close(), secondRecords.close(), firstTasks.close(), secondTasks.close()]);
    if (previousSecret === undefined) delete process.env.AXIOM_PRINCIPAL_SECRET;
    else process.env.AXIOM_PRINCIPAL_SECRET = previousSecret;
  }
});
