import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { createImprovementApi } from './improvementApi.js';
import { SqliteBusinessCapabilityStore } from './businessCapabilityStore.js';
import { SqliteTaskStore } from './sqliteTaskStore.js';
import { signPrincipal, type PrincipalClaims } from './principal.js';
import type { ModelClient, ModelCompletion, ModelCompletionRequest } from './modelClient.js';
import type { TaskStatus, WorkflowTask } from './contracts.js';
import type { ImprovementAnalysis, ImprovementProposal, ImprovementSource, ImprovementTrialDraft } from '../shared/improvement.js';

const secret = 'improvement-api-test-signing-key-32-bytes';
let previousSecret: string | undefined;
before(() => { previousSecret = process.env.AXIOM_PRINCIPAL_SECRET; process.env.AXIOM_PRINCIPAL_SECRET = secret; });
after(() => {
  if (previousSecret === undefined) delete process.env.AXIOM_PRINCIPAL_SECRET;
  else process.env.AXIOM_PRINCIPAL_SECRET = previousSecret;
});

const owner = { tenantId: 'improvement-tenant-a', userId: 'alice', role: 'member' } satisfies PrincipalClaims;
const headers = (claims: PrincipalClaims = owner) => {
  const token = signPrincipal(claims, secret);
  const separator = token.indexOf('.');
  return { 'content-type': 'application/json', 'x-axiom-principal': token.slice(0, separator), 'x-axiom-principal-signature': token.slice(separator + 1) };
};
const json = async <T>(response: Response) => await response.json() as T;
const analysis = (): ImprovementAnalysis => ({
  summary: 'Separate evidence gathering from final delivery.',
  observations: [{ finding: 'The source task omitted a verifiable acceptance check.', evidence: 'The recorded output contains no supporting citation.' }],
  changes: [{ target: 'verification', suggestion: 'Check citations before the final answer.', reason: 'Makes incomplete evidence visible.' }],
  trialInstruction: 'Answer the original question and verify each source. Label unavailable evidence explicitly.',
  validationCases: [{ input: 'Compare two storage options.', expectedBehavior: 'A comparison with dated sources and stated limitations.' }],
  risks: ['This proposal has not been independently evaluated.'],
});
const completion = (content: unknown = analysis(), extra: Partial<ModelCompletion> = {}): ModelCompletion => ({
  content: typeof content === 'string' ? content : JSON.stringify(content), attempts: 1, durationMs: 4,
  finishReason: 'stop', usage: { total_tokens: 42 }, ...extra,
});
const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

const createHarness = async (respond: (request: ModelCompletionRequest) => Promise<ModelCompletion> = async () => completion(), beforeResolve?: () => Promise<void>) => {
  const records = new SqliteBusinessCapabilityStore(':memory:');
  const tasks = new SqliteTaskStore(':memory:');
  await Promise.all([records.initialize(), tasks.initialize()]);
  const requests: ModelCompletionRequest[] = [];
  const resolvedTasks: WorkflowTask[] = [];
  const model: ModelClient = { model: 'isolated-fake-model', async complete(request) { requests.push(request); return respond(request); } };
  const makeApi = () => createImprovementApi({ records, tasks, resolveModel: async (task) => { resolvedTasks.push(task); await beforeResolve?.(); return model; } });
  let api = makeApi();
  const request = async (path: string, init: RequestInit = {}) => api.request(new Request(`http://improvement.test${path}`, { ...init, headers: init.headers ?? headers() }));
  const source = async (options: { tenantId?: string; userId?: string; status?: TaskStatus; title?: string; input?: string; result?: string } = {}) => {
    const task = await tasks.createTask({ tenantId: options.tenantId ?? owner.tenantId, userId: options.userId ?? owner.userId,
      sessionId: `improvement-test-${randomUUID()}`, title: options.title ?? 'Storage comparison', input: options.input ?? 'Compare PostgreSQL and SQLite.', mode: 'analyze', model: model.model });
    return tasks.updateTask(task.id, { status: options.status ?? 'completed', result: options.result ?? 'A useful comparison, but no sources.' });
  };
  const create = (taskId: string, options: Record<string, unknown> = {}, claims: PrincipalClaims = owner) => request('/', {
    method: 'POST', headers: headers(claims), body: JSON.stringify({ taskId, language: 'en', idempotencyKey: randomUUID(), ...options }),
  });
  return { records, tasks, requests, resolvedTasks, request, source, create,
    restart() { api = makeApi(); }, async close() { await Promise.all([records.close(), tasks.close()]); } };
};

test('improvement candidates use a bounded tool-free model request and stay unverified without changing the source', async () => {
  const h = await createHarness();
  try {
    const task = await h.source();
    const before = await h.tasks.getTask(task.id, owner.tenantId);
    const response = await h.create(task.id, { note: 'Please preserve the comparison structure.' });
    assert.equal(response.status, 201, await response.clone().text());
    const { proposal } = await json<{ proposal: ImprovementProposal }>(response);
    assert.equal(proposal.status, 'draft');
    assert.equal(proposal.qualityStatus, 'unverified');
    assert.equal(proposal.sourceTaskId, task.id);
    assert.deepEqual(proposal.analysis, analysis());
    assert.equal(h.requests.length, 1);
    const request = h.requests[0]!;
    assert.ok(!request.tools?.length);
    assert.equal(request.toolChoice, 'none');
    assert.equal(request.responseFormat, 'json');
    assert.ok(request.maxTokens! > 0 && request.maxTokens! <= 4_096);
    assert.ok(request.signal instanceof AbortSignal);
    assert.match(request.user, /Please preserve the comparison structure/);
    assert.deepEqual(await h.tasks.getTask(task.id, owner.tenantId), before);
    assert.equal((await h.tasks.listTasks(owner.tenantId, 100)).length, 1);
    assert.equal((await h.tasks.getEvents(task.id)).length, 0);
    assert.equal(h.resolvedTasks[0]?.userId, owner.userId);
  } finally { await h.close(); }
});

test('improvement sources expose only terminal tasks owned by the current user', async () => {
  const h = await createHarness();
  try {
    const terminal = await Promise.all(['completed', 'failed', 'cancelled'].map((status) => h.source({ status: status as TaskStatus })));
    await h.source({ status: 'running' });
    await h.source({ userId: 'bob' });
    await h.source({ tenantId: 'tenant-b' });
    const response = await h.request('/sources');
    assert.equal(response.status, 200);
    const body = await json<{ tasks: ImprovementSource[] }>(response);
    assert.deepEqual(body.tasks.map((task) => task.id).sort(), terminal.map((task) => task.id).sort());
    assert.ok(body.tasks.every((task) => !('input' in task) && !('result' in task)));
  } finally { await h.close(); }
});

test('improvement source scope is filtered before the recent-task limit', async () => {
  const h = await createHarness();
  try {
    const original = await h.source({ title: 'Older finished task owned by Alice' });
    // Millisecond timestamp ties do not have a defined secondary order in the
    // legacy list. Give the old fixture a genuinely earlier timestamp.
    await new Promise((resolve) => setTimeout(resolve, 5));
    for (let index = 0; index < 101; index += 1) {
      await h.source(index % 2 === 0 ? { userId: 'bob' } : { status: 'running' });
    }
    // Preserve the existing unfiltered API behavior: it still returns the newest 100.
    const unfiltered = await h.tasks.listTasks(owner.tenantId, 100);
    assert.equal(unfiltered.length, 100);
    assert.ok(!unfiltered.some((task) => task.id === original.id));
    const response = await h.request('/sources');
    assert.equal(response.status, 200);
    const { tasks } = await json<{ tasks: ImprovementSource[] }>(response);
    assert.deepEqual(tasks.map((task) => task.id), [original.id]);
    assert.deepEqual(await h.tasks.listTasks(owner.tenantId, 100, { userId: owner.userId, statuses: [] }), []);
  } finally { await h.close(); }
});

test('improvement writes reject active source tasks before invoking a model', async () => {
  const h = await createHarness();
  try {
    for (const status of ['queued', 'running', 'awaiting_approval'] as TaskStatus[]) {
      const task = await h.source({ status });
      assert.equal((await h.create(task.id)).status, 409);
    }
    assert.equal(h.requests.length, 0);
  } finally { await h.close(); }
});

test('improvement proposal reads and writes stay private even for another owner or admin', async () => {
  const h = await createHarness();
  try {
    const task = await h.source();
    const { proposal } = await json<{ proposal: ImprovementProposal }>(await h.create(task.id));
    const strangers: PrincipalClaims[] = [
      { ...owner, userId: 'bob', role: 'member' }, { ...owner, userId: 'admin-bob', role: 'admin' },
      { ...owner, userId: 'owner-bob', role: 'owner' }, { ...owner, tenantId: 'other-tenant', role: 'owner' },
    ];
    for (const stranger of strangers) {
      assert.deepEqual((await json<{ proposals: ImprovementProposal[] }>(await h.request('/', { headers: headers(stranger) }))).proposals, []);
      assert.equal((await h.request(`/${proposal.id}`, { headers: headers(stranger) })).status, 404);
      assert.equal((await h.create(task.id, {}, stranger)).status, 404);
      assert.equal((await h.request(`/${proposal.id}`, { method: 'PATCH', headers: headers(stranger), body: JSON.stringify({ status: 'accepted', revision: proposal.revision }) })).status, 404);
      assert.equal((await h.request(`/${proposal.id}/prepare`, { method: 'POST', headers: headers(stranger), body: JSON.stringify({ revision: proposal.revision }) })).status, 404);
    }
    assert.equal(h.requests.length, 1);
  } finally { await h.close(); }
});

test('improvement signed identity fails closed and does not trust conflicting identity headers', async () => {
  const h = await createHarness();
  try {
    const task = await h.source();
    const goodHeaders = headers();
    const rejectedHeaders: HeadersInit[] = [
      { 'x-axiom-user-id': owner.userId, 'x-axiom-tenant-id': owner.tenantId },
      { ...goodHeaders, 'x-axiom-principal-signature': 'tampered' },
      headers({ ...owner, expiresAt: Math.floor(Date.now() / 1_000) - 60 }),
    ];
    for (const invalid of rejectedHeaders) {
      assert.equal((await h.request('/sources', { headers: invalid })).status, 401);
      assert.equal((await h.request('/', { method: 'POST', headers: invalid, body: JSON.stringify({ taskId: task.id, language: 'en', idempotencyKey: randomUUID() }) })).status, 401);
    }
    const response = await h.request('/sources', { headers: { ...goodHeaders, 'x-axiom-user-id': 'bob', 'x-axiom-tenant-id': 'fake-tenant' } });
    assert.equal((await json<{ tasks: ImprovementSource[] }>(response)).tasks[0]?.id, task.id);
    assert.equal(h.requests.length, 0);
  } finally { await h.close(); }
});

test('improvement viewer may read their own records but may not create, accept, dismiss or prepare', async () => {
  const h = await createHarness();
  try {
    const task = await h.source();
    const { proposal } = await json<{ proposal: ImprovementProposal }>(await h.create(task.id));
    const viewer = { ...owner, role: 'viewer' as const };
    assert.equal((await h.request(`/${proposal.id}`, { headers: headers(viewer) })).status, 200);
    assert.equal((await h.create(task.id, {}, viewer)).status, 403);
    for (const status of ['accepted', 'dismissed']) assert.equal((await h.request(`/${proposal.id}`, { method: 'PATCH', headers: headers(viewer), body: JSON.stringify({ status, revision: proposal.revision }) })).status, 403);
    assert.equal((await h.request(`/${proposal.id}/prepare`, { method: 'POST', headers: headers(viewer), body: JSON.stringify({ revision: proposal.revision }) })).status, 403);
  } finally { await h.close(); }
});

test('improvement duplicate idempotency keys reuse the original result and reject changed parameters', async () => {
  const h = await createHarness();
  try {
    const task = await h.source();
    const key = randomUUID();
    const first = await json<{ proposal: ImprovementProposal }>(await h.create(task.id, { idempotencyKey: key, note: 'Focus on evidence.' }));
    h.restart();
    const repeated = await h.create(task.id, { idempotencyKey: key, note: 'Focus on evidence.' });
    assert.equal(repeated.status, 200);
    assert.equal((await json<{ proposal: ImprovementProposal }>(repeated)).proposal.id, first.proposal.id);
    assert.equal((await h.create(task.id, { idempotencyKey: key, note: 'Different objective.' })).status, 409);
    assert.equal((await h.create(task.id, { idempotencyKey: key, note: 'Focus on evidence.', language: 'zh-CN' })).status, 409);
    assert.equal(h.requests.length, 1);
  } finally { await h.close(); }
});

test('improvement concurrent duplicate requests invoke the model only once across API instances', async () => {
  const started = deferred();
  const release = deferred();
  const h = await createHarness(async () => { started.resolve(); await release.promise; return completion(); });
  try {
    const task = await h.source();
    const idempotencyKey = randomUUID();
    const pending = h.create(task.id, { idempotencyKey });
    await started.promise;
    h.restart();
    const duplicate = h.create(task.id, { idempotencyKey });
    release.resolve();
    const [first, second] = await Promise.all([pending, duplicate]);
    assert.equal(first.status, 201, await first.clone().text());
    assert.ok([200, 202].includes(second.status), await second.clone().text());
    assert.equal((await json<{ proposal: ImprovementProposal }>(first)).proposal.id, (await json<{ proposal: ImprovementProposal }>(second)).proposal.id);
    assert.equal(h.requests.length, 1);
    assert.equal((await h.records.list(owner.tenantId, 'improvement-proposal')).length, 1);
  } finally { release.resolve(); await h.close(); }
});

test('improvement acceptance records a decision only and prepare returns an unverified new draft without execution', async () => {
  const h = await createHarness();
  try {
    const task = await h.source();
    const before = await h.tasks.getTask(task.id, owner.tenantId);
    const { proposal } = await json<{ proposal: ImprovementProposal }>(await h.create(task.id));
    const accepted = await h.request(`/${proposal.id}`, { method: 'PATCH', body: JSON.stringify({ revision: proposal.revision, status: 'accepted' }) });
    assert.equal(accepted.status, 200);
    const saved = (await json<{ proposal: ImprovementProposal }>(accepted)).proposal;
    assert.equal(saved.status, 'accepted');
    assert.equal(saved.qualityStatus, 'unverified');
    assert.ok(saved.revision > proposal.revision);
    const prepared = await h.request(`/${proposal.id}/prepare`, { method: 'POST', body: JSON.stringify({ revision: saved.revision }) });
    assert.equal(prepared.status, 200, await prepared.clone().text());
    const draft = await json<ImprovementTrialDraft>(prepared);
    assert.equal(draft.proposalId, proposal.id);
    assert.equal(draft.sourceTaskId, task.id);
    assert.equal(draft.mode, task.mode);
    assert.ok(draft.input.includes(analysis().trialInstruction));
    assert.ok(draft.warnings.length > 0);
    for (const forbidden of ['policy', 'plan', 'tools', 'toolAllowlist', 'providerBindingId']) assert.ok(!(forbidden in draft));
    assert.deepEqual(await h.tasks.getTask(task.id, owner.tenantId), before);
    assert.equal((await h.tasks.listTasks(owner.tenantId, 100)).length, 1);
    assert.equal((await h.tasks.getEvents(task.id)).length, 0);
    assert.equal(h.requests.length, 1);
  } finally { await h.close(); }
});

test('improvement decisions and draft preparation reject stale revisions', async () => {
  const h = await createHarness();
  try {
    const task = await h.source();
    const { proposal } = await json<{ proposal: ImprovementProposal }>(await h.create(task.id));
    assert.equal((await h.request(`/${proposal.id}`, { method: 'PATCH', body: JSON.stringify({ revision: proposal.revision - 1, status: 'accepted' }) })).status, 409);
    assert.equal((await h.request(`/${proposal.id}/prepare`, { method: 'POST', body: JSON.stringify({ revision: proposal.revision - 1 }) })).status, 409);
    const dismissed = await h.request(`/${proposal.id}`, { method: 'PATCH', body: JSON.stringify({ revision: proposal.revision, status: 'dismissed' }) });
    assert.equal(dismissed.status, 200);
    const saved = (await json<{ proposal: ImprovementProposal }>(dismissed)).proposal;
    assert.equal((await h.request(`/${proposal.id}/prepare`, { method: 'POST', body: JSON.stringify({ revision: saved.revision }) })).status, 409);
    assert.equal((await h.request(`/${proposal.id}`, { method: 'PATCH', body: JSON.stringify({ revision: proposal.revision, status: 'accepted' }) })).status, 409);
  } finally { await h.close(); }
});

test('improvement source deletion hides proposals from list/detail/prepare and prevents idempotent replay', async () => {
  const h = await createHarness();
  try {
    const task = await h.source();
    const idempotencyKey = randomUUID();
    const { proposal } = await json<{ proposal: ImprovementProposal }>(await h.create(task.id, { idempotencyKey }));
    await h.tasks.deleteTask(task.id, owner.tenantId);
    assert.deepEqual((await json<{ proposals: ImprovementProposal[] }>(await h.request('/'))).proposals, []);
    assert.equal((await h.request(`/${proposal.id}`)).status, 404);
    assert.equal((await h.request(`/${proposal.id}/prepare`, { method: 'POST', body: JSON.stringify({ revision: proposal.revision }) })).status, 404);
    assert.equal((await h.create(task.id, { idempotencyKey })).status, 404);
    assert.equal(h.requests.length, 1);
  } finally { await h.close(); }
});

for (const failure of ['invalid-json', 'extra-field', 'empty-changes', 'truncated', 'model-failure'] as const) {
  test(`improvement ${failure} persists a safe failed proposal and permits a new independent attempt`, async () => {
    let attempt = 0;
    const privateKey = 'sk-this-is-a-secret-do-not-store';
    const h = await createHarness(async () => {
      if (attempt++ > 0) return completion();
      if (failure === 'model-failure') throw new Error(`Provider request failed: ${privateKey}`);
      if (failure === 'invalid-json') return completion(`not-json ${privateKey}`);
      if (failure === 'extra-field') return completion({ ...analysis(), toolAllowlist: ['shell.exec'] });
      if (failure === 'empty-changes') return completion({ ...analysis(), changes: [] });
      return completion(analysis(), { finishReason: 'length' });
    });
    try {
      const task = await h.source();
      const response = await h.create(task.id);
      const body = await response.text();
      assert.equal(body.includes(privateKey), false);
      const records = await h.records.list(owner.tenantId, 'improvement-proposal');
      assert.equal(records.length, 1);
      assert.equal(records[0]?.status, 'failed', body);
      assert.equal(JSON.stringify(records).includes(privateKey), false);
      assert.equal((await json<{ proposal: ImprovementProposal }>(await h.create(task.id))).proposal.status, 'draft');
      assert.equal(h.requests.length, 2);
    } finally { await h.close(); }
  });
}

for (const mutation of ['delete', 'active', 'result'] as const) {
  test(`improvement does not publish a candidate if its source changes during generation: ${mutation}`, async () => {
    const started = deferred();
    const release = deferred();
    const h = await createHarness(async () => { started.resolve(); await release.promise; return completion(); });
    try {
      const task = await h.source();
      const pending = h.create(task.id);
      await started.promise;
      if (mutation === 'delete') await h.tasks.deleteTask(task.id, owner.tenantId);
      else await h.tasks.updateTask(task.id, mutation === 'active' ? { status: 'running' } : { result: 'Changed while model was working.' });
      release.resolve();
      const response = await pending;
      const body = await response.text();
      const records = await h.records.list(owner.tenantId, 'improvement-proposal');
      assert.equal(records.length, 1);
      assert.equal(records[0]?.status, 'failed', body);
      assert.equal(h.requests.length, 1);
    } finally { release.resolve(); await h.close(); }
  });
}

test('improvement parents stay private and a later trial may use another source owned by the same user', async () => {
  const h = await createHarness();
  try {
    const task = await h.source();
    const otherTask = await h.source();
    const { proposal } = await json<{ proposal: ImprovementProposal }>(await h.create(task.id));
    const childResponse = await h.create(otherTask.id, { parentId: proposal.id });
    assert.equal(childResponse.status, 201);
    const child = (await json<{ proposal: ImprovementProposal }>(childResponse)).proposal;
    const bob = { ...owner, userId: 'bob' };
    const bobTask = await h.source({ userId: 'bob' });
    assert.equal((await h.create(bobTask.id, { parentId: proposal.id }, bob)).status, 404);
    assert.equal(h.requests.length, 2);
    await h.tasks.deleteTask(task.id, owner.tenantId);
    assert.equal((await h.request(`/${child.id}`)).status, 404);
    assert.deepEqual((await json<{ proposals: ImprovementProposal[] }>(await h.request('/'))).proposals, []);
  } finally { await h.close(); }
});

test('improvement recursive candidates have a finite generation limit', async () => {
  const h = await createHarness();
  try {
    const task = await h.source();
    let proposal = (await json<{ proposal: ImprovementProposal }>(await h.create(task.id))).proposal;
    let successful = 1;
    let stopped = false;
    for (let index = 0; index < 7; index += 1) {
      const response = await h.create(task.id, { parentId: proposal.id });
      if (response.status === 409) { stopped = true; break; }
      assert.equal(response.status, 201, await response.clone().text());
      const next = (await json<{ proposal: ImprovementProposal }>(response)).proposal;
      assert.equal(next.parentId, proposal.id);
      assert.equal(next.generation, proposal.generation + 1);
      proposal = next;
      successful += 1;
    }
    assert.equal(stopped, true);
    assert.ok(successful <= 6);
    assert.equal(h.requests.length, successful);
  } finally { await h.close(); }
});

test('improvement interrupted generating records recover after an API restart without re-invoking a model', async () => {
  const h = await createHarness();
  try {
    const task = await h.source();
    const idempotencyKey = randomUUID();
    const { proposal } = await json<{ proposal: ImprovementProposal }>(await h.create(task.id, { idempotencyKey }));
    const record = (await h.records.get(proposal.id, owner.tenantId))!;
    const { analysis: _analysis, ...data } = record.data;
    await h.records.update(record.id, owner.tenantId, { status: 'generating', data: { ...data, generationExpiresAt: new Date(Date.now() - 120_000).toISOString() } }, record.revision);
    h.restart();
    const recovered = (await json<{ proposal: ImprovementProposal }>(await h.request(`/${record.id}`))).proposal;
    assert.equal(recovered.status, 'failed');
    assert.equal(recovered.analysis, undefined);
    assert.match(recovered.error ?? '', /expired|interrupted/i);
    const replay = (await json<{ proposal: ImprovementProposal }>(await h.create(task.id, { idempotencyKey }))).proposal;
    assert.equal(replay.id, record.id);
    assert.equal(replay.status, 'failed');
    assert.equal(h.requests.length, 1);
    assert.equal((await json<{ proposal: ImprovementProposal }>(await h.create(task.id))).proposal.status, 'draft');
  } finally { await h.close(); }
});

test('improvement expired generation is not resurrected by a late model completion', async () => {
  const started = deferred();
  const release = deferred();
  const h = await createHarness(async () => { started.resolve(); await release.promise; return completion(); });
  try {
    const task = await h.source();
    const pending = h.create(task.id);
    await started.promise;
    const record = (await h.records.list(owner.tenantId, 'improvement-proposal'))[0]!;
    await h.records.update(record.id, owner.tenantId, { data: { ...record.data, generationExpiresAt: new Date(Date.now() - 120_000).toISOString() } }, record.revision);
    h.restart();
    assert.equal((await json<{ proposal: ImprovementProposal }>(await h.request(`/${record.id}`))).proposal.status, 'failed');
    release.resolve();
    const response = await pending;
    assert.equal((await json<{ proposal: ImprovementProposal }>(response)).proposal.status, 'failed');
    assert.equal((await h.records.get(record.id, owner.tenantId))?.status, 'failed');
    assert.equal(h.requests.length, 1);
  } finally { release.resolve(); await h.close(); }
});

test('improvement source, note, feedback and model output scrub known secrets and exclude another user feedback', async () => {
  const privateKey = 'sk-secret-that-must-not-enter-the-review';
  const otherFeedback = 'Private feedback from another user must not be included.';
  const h = await createHarness(async () => completion({ ...analysis(), summary: `No credential may be disclosed: ${privateKey}` }));
  try {
    const task = await h.source({ title: `Review ${privateKey}`, input: `Compare databases. Bearer ${privateKey}`, result: `api_key=${privateKey}` });
    await h.records.create({ tenantId: owner.tenantId, userId: 'bob', ownerId: 'bob', kind: 'feedback', status: 'active', data: { taskId: task.id, note: otherFeedback, score: 1 } });
    await h.records.create({ tenantId: owner.tenantId, userId: owner.userId, ownerId: owner.userId, kind: 'feedback', status: 'active', data: { taskId: task.id, note: `My feedback with ${privateKey}`, score: 3 } });
    const response = await h.create(task.id, { note: `Keep this key private: ${privateKey}` });
    const body = await response.text();
    assert.equal(response.status, 201, body);
    assert.equal(body.includes(privateKey), false);
    assert.equal(h.requests[0]!.user.includes(privateKey), false);
    assert.equal(h.requests[0]!.user.includes(otherFeedback), false);
    assert.match(h.requests[0]!.user, /My feedback/);
    assert.equal(JSON.stringify(await h.records.list(owner.tenantId, 'improvement-proposal')).includes(privateKey), false);
    assert.equal((await h.request('/sources')).status, 200);
    assert.equal((await h.request('/sources').then((result) => result.text())).includes(privateKey), false);
  } finally { await h.close(); }
});

test('improvement model-supplied tool calls fail closed and never create executable work', async () => {
  const h = await createHarness(async () => completion(analysis(), { toolCalls: [{ name: 'shell.exec', args: { command: 'do-not-execute' } }] }));
  try {
    const task = await h.source();
    const { proposal } = await json<{ proposal: ImprovementProposal }>(await h.create(task.id));
    assert.equal(proposal.status, 'failed');
    assert.equal(proposal.analysis, undefined);
    assert.equal((await h.tasks.listTasks(owner.tenantId, 100)).length, 1);
    assert.equal((await h.tasks.getEvents(task.id)).length, 0);
  } finally { await h.close(); }
});

test('improvement malformed input and resource identifiers are rejected before model resolution', async () => {
  const h = await createHarness();
  try {
    const task = await h.source();
    for (const options of [{ language: 'unsupported' }, { idempotencyKey: 'short' }, { note: 'x'.repeat(4_001) }, { parentId: 'not-a-uuid' }, { tools: ['shell.exec'] }]) {
      assert.equal((await h.create(task.id, options)).status, 400);
    }
    assert.equal((await h.create('not-a-uuid')).status, 400);
    assert.equal((await h.request('/not-a-uuid')).status, 404);
    assert.equal((await h.request('/not-a-uuid', { method: 'PATCH', body: JSON.stringify({ revision: 1, status: 'accepted' }) })).status, 404);
    assert.equal((await h.request('/not-a-uuid/prepare', { method: 'POST', body: JSON.stringify({ revision: 1 }) })).status, 404);
    assert.equal(h.requests.length, 0);
    assert.equal(h.resolvedTasks.length, 0);
    assert.equal((await h.records.list(owner.tenantId, 'improvement-proposal')).length, 0);
  } finally { await h.close(); }
});

test('improvement draft preparation requires an explicit saved decision', async () => {
  const h = await createHarness();
  try {
    const task = await h.source();
    const { proposal } = await json<{ proposal: ImprovementProposal }>(await h.create(task.id));
    assert.equal((await h.request(`/${proposal.id}/prepare`, { method: 'POST', body: JSON.stringify({ revision: proposal.revision }) })).status, 409);
    assert.equal((await h.records.get(proposal.id, owner.tenantId))?.status, 'draft');
    assert.equal((await h.tasks.listTasks(owner.tenantId, 100)).length, 1);
  } finally { await h.close(); }
});

test('improvement source deletion during model resolution prevents the paid completion call', async () => {
  const started = deferred();
  const release = deferred();
  const h = await createHarness(async () => completion(), async () => { started.resolve(); await release.promise; });
  try {
    const task = await h.source();
    const pending = h.create(task.id);
    await started.promise;
    await h.tasks.deleteTask(task.id, owner.tenantId);
    release.resolve();
    assert.equal((await pending).status, 404);
    assert.equal(h.resolvedTasks.length, 1);
    assert.equal(h.requests.length, 0);
    assert.equal((await h.records.list(owner.tenantId, 'improvement-proposal'))[0]?.status, 'failed');
  } finally { release.resolve(); await h.close(); }
});
