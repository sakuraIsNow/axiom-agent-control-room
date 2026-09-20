import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createImprovementApi } from './improvementApi.js';
import { PostgresBusinessCapabilityStore } from './businessCapabilityStore.js';
import { PostgresTaskStore } from './postgresTaskStore.js';
import { signPrincipal } from './principal.js';
import type { ModelClient } from './modelClient.js';
import type { ImprovementProposal } from '../shared/improvement.js';
import type { ImprovementEvaluation } from '../shared/improvement.js';
import { improvementFixtures } from './improvementEvaluation.js';

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

test('PostgreSQL RSI comparisons persist history, deduplicate workers and fence cross-worker cancellation', {
  skip: connectionString ? false : 'AXIOM_TEST_DATABASE_URL is not configured.', timeout: 20_000,
}, async () => {
  const tenantId = `improvement-eval-pg-${randomUUID()}`;
  const userId = 'comparison-owner';
  const secret = 'improvement-eval-pg-only-secret-32-bytes';
  const previousSecret = process.env.AXIOM_PRINCIPAL_SECRET;
  process.env.AXIOM_PRINCIPAL_SECRET = secret;
  const firstRecords = new PostgresBusinessCapabilityStore(connectionString!);
  const secondRecords = new PostgresBusinessCapabilityStore(connectionString!);
  const tasks = new PostgresTaskStore(connectionString!);
  let calls = 0; let release!: () => void; let entered!: () => void;
  let gate = new Promise<void>((resolve) => { release = resolve; });
  let started = new Promise<void>((resolve) => { entered = resolve; });
  const model: ModelClient = { model: 'fake-pg-evaluation', async complete(request) {
    calls += 1; entered(); await gate;
    assert.equal(request.toolChoice, 'none'); assert.ok(!request.tools?.length);
    const fixture = improvementFixtures.find((item) => request.user.includes(item.marker))!;
    return { content: JSON.stringify(Object.fromEntries(Object.entries(fixture.expected).map(([key, expected]) => [key, expected.value]))), attempts: 1, durationMs: 1, finishReason: 'stop', usage: { total_tokens: 10 } };
  } };
  const signedHeaders = (requestedUser = userId) => {
    const token = signPrincipal({ tenantId, userId: requestedUser, role: 'member' }, secret); const split = token.indexOf('.');
    return { 'content-type': 'application/json', 'x-axiom-principal': token.slice(0, split), 'x-axiom-principal-signature': token.slice(split + 1) };
  };
  let sourceId: string | undefined;
  try {
    await firstRecords.initialize(); await secondRecords.initialize(); await tasks.initialize();
    const original = await tasks.createTask({ tenantId, userId, sessionId: randomUUID(), title: 'Isolated RSI evaluation', input: 'Compare storage independently.', mode: 'analyze' });
    sourceId = original.id;
    const source = await tasks.updateTask(original.id, { status: 'completed', result: 'Comparison without references.' });
    const proposal = await firstRecords.create({ tenantId, userId, ownerId: userId, kind: 'improvement-proposal', status: 'draft', data: {
      sourceTaskId: source.id, sourceRevision: source.revision, sourceRunId: source.runId, sourceTitle: source.title, mode: source.mode,
      generation: 1, qualityStatus: 'unverified', baseline: {}, language: 'en',
      analysis: { summary: 'Check facts', observations: [], changes: [], trialInstruction: 'Verify every requirement.', validationCases: [], risks: [] },
    } });
    const first = createImprovementApi({ records: firstRecords, tasks, resolveModel: async () => model });
    const second = createImprovementApi({ records: secondRecords, tasks, resolveModel: async () => model });
    const request = (api: typeof first, path: string, init: RequestInit = {}) => api.request(new Request(`http://eval-pg.test${path}`, { ...init, headers: init.headers ?? signedHeaders() }));
    const path = `/${proposal.id}/evaluations`;
    const body = JSON.stringify({ revision: proposal.revision, idempotencyKey: randomUUID() });
    const firstStart = await request(first, path, { method: 'POST', body }); assert.equal(firstStart.status, 202); await started;
    const duplicate = await request(second, path, { method: 'POST', body }); assert.equal(duplicate.status, 202);
    const different = await request(second, path, { method: 'POST', body: JSON.stringify({ revision: proposal.revision, idempotencyKey: randomUUID() }) }); assert.equal(different.status, 409);
    const firstId = (await firstStart.json() as { evaluation: ImprovementEvaluation }).evaluation.id;
    assert.equal((await duplicate.json() as { evaluation: ImprovementEvaluation }).evaluation.id, firstId); assert.equal(calls, 1);
    release();
    const list = async () => { const response = await request(second, path); assert.equal(response.status, 200); return (await response.json() as { evaluations: ImprovementEvaluation[] }).evaluations; };
    let completed: ImprovementEvaluation | undefined;
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const result = (await list()).find((item) => item.id === firstId)!;
      if (result.status !== 'running') { completed = result; break; }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(completed?.status, 'completed'); assert.equal(completed?.qualityStatus, 'no-clear-change'); assert.equal(calls, 10);
    assert.equal(completed?.summary.baselinePassed, completed?.summary.totalChecks);
    assert.equal((await request(second, path, { headers: signedHeaders('another-user') })).status, 404);
    assert.equal((await request(second, path, { method: 'POST', body })).status, 200); assert.equal(calls, 10);

    // A new independent comparison can be cancelled by another worker, even though
    // that worker does not own the local AbortController.
    gate = new Promise<void>((resolve) => { release = resolve; }); started = new Promise<void>((resolve) => { entered = resolve; });
    const nextStart = await request(first, path, { method: 'POST', body: JSON.stringify({ revision: proposal.revision, idempotencyKey: randomUUID() }) });
    const nextId = (await nextStart.json() as { evaluation: ImprovementEvaluation }).evaluation.id; await started;
    const running = (await list()).find((item) => item.id === nextId)!;
    assert.equal((await request(second, `${path}/${nextId}/cancel`, { method: 'POST', body: JSON.stringify({ revision: running.revision - 1 }) })).status, 409);
    const cancel = await request(second, `${path}/${nextId}/cancel`, { method: 'POST', body: JSON.stringify({ revision: running.revision }) }); assert.equal(cancel.status, 200);
    release(); await new Promise((resolve) => setTimeout(resolve, 75));
    const after = (await list()).find((item) => item.id === nextId)!; assert.equal(after.status, 'cancelled'); assert.equal(after.qualityStatus, 'inconclusive'); assert.equal(calls, 11);
    assert.equal((await list()).length, 2);
    assert.deepEqual(await tasks.getTask(source.id, tenantId), source);
    assert.equal((await tasks.getEvents(source.id)).length, 0);
    assert.deepEqual(await firstRecords.get(proposal.id, tenantId), proposal);
  } finally {
    release(); await new Promise((resolve) => setTimeout(resolve, 30));
    for (const kind of ['improvement-evaluation', 'improvement-proposal'] as const) {
      for (const record of await firstRecords.list(tenantId, kind).catch(() => [])) await firstRecords.delete(record.id, tenantId);
    }
    if (sourceId) await tasks.deleteTask(sourceId, tenantId);
    await Promise.all([firstRecords.close(), secondRecords.close(), tasks.close()]);
    if (previousSecret === undefined) delete process.env.AXIOM_PRINCIPAL_SECRET; else process.env.AXIOM_PRINCIPAL_SECRET = previousSecret;
  }
});
