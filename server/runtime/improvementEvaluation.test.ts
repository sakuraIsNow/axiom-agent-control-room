import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import type { ImprovementAnalysis, ImprovementEvaluation, ImprovementEvaluationCase } from '../shared/improvement.js';
import { SqliteBusinessCapabilityStore } from './businessCapabilityStore.js';
import { createImprovementApi } from './improvementApi.js';
import { evaluateContract, hasFixtureContamination, improvementEvaluationSuite, improvementFixtures, runImprovementArm, summarizeImprovementEvaluation } from './improvementEvaluation.js';
import type { ModelClient, ModelCompletion, ModelCompletionRequest } from './modelClient.js';
import { signPrincipal } from './principal.js';
import { SqliteTaskStore } from './sqliteTaskStore.js';

const secret = 'rsi-evaluation-unit-test-signing-secret';
const identity = { tenantId: 'eval-tenant', userId: 'alice', role: 'member' as const };
let previousSecret: string | undefined;
before(() => { previousSecret = process.env.AXIOM_PRINCIPAL_SECRET; process.env.AXIOM_PRINCIPAL_SECRET = secret; });
after(() => { if (previousSecret === undefined) delete process.env.AXIOM_PRINCIPAL_SECRET; else process.env.AXIOM_PRINCIPAL_SECRET = previousSecret; });
const headers = (userId = identity.userId, role: 'member' | 'viewer' = 'member') => {
  const token = signPrincipal({ ...identity, userId, role }, secret); const i = token.indexOf('.');
  return { 'content-type': 'application/json', 'x-axiom-principal': token.slice(0, i), 'x-axiom-principal-signature': token.slice(i + 1) };
};
const fixtureFor = (request: ModelCompletionRequest) => improvementFixtures.find((fixture) => request.user.includes(fixture.marker))!;
const answerFor = (request: ModelCompletionRequest) => Object.fromEntries(Object.entries(fixtureFor(request).expected).map(([key, value]) => [key, value.value]));
const completion = (content: unknown, overrides: Partial<ModelCompletion> = {}): ModelCompletion => ({ content: JSON.stringify(content), attempts: 1, durationMs: 2, finishReason: 'stop', usage: { total_tokens: 30 }, ...overrides });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; };
const guidance: ImprovementAnalysis = { summary: 'Validate evidence', observations: [{ finding: 'Missing source', evidence: 'No citation' }], changes: [{ target: 'verification', suggestion: 'Check references', reason: 'Avoid unsupported facts' }], trialInstruction: 'Check every requirement and source before answering.', validationCases: [{ input: 'Private proposal case, not the comparison fixture.', expectedBehavior: 'Independent evidence.' }], risks: [] };

const harness = async (respond: (request: ModelCompletionRequest) => Promise<ModelCompletion> = async (request) => completion(answerFor(request)), timing?: { evaluationTimeoutMs?: number; callTimeoutMs?: number }) => {
  const records = new SqliteBusinessCapabilityStore(':memory:'); const tasks = new SqliteTaskStore(':memory:');
  await Promise.all([records.initialize(), tasks.initialize()]);
  const created = await tasks.createTask({ ...identity, sessionId: randomUUID(), title: 'Private source', input: 'Compare independent storage systems. PRIVATE_SOURCE_INPUT', mode: 'analyze' });
  const source = await tasks.updateTask(created.id, { status: 'completed', result: 'PRIVATE_SOURCE_OUTPUT' });
  const proposal = await records.create({ ...identity, ownerId: identity.userId, kind: 'improvement-proposal', status: 'draft', data: {
    sourceTaskId: source.id, sourceRevision: source.revision, sourceRunId: source.runId, sourceTitle: source.title, mode: source.mode,
    generation: 1, analysis: guidance, qualityStatus: 'unverified', language: 'en', baseline: { status: source.status, agentCount: 1, tokens: null, durationMs: null, reviewScore: null },
  } });
  const requests: ModelCompletionRequest[] = []; let resolutions = 0;
  const model: ModelClient = { model: 'fixture-model', async complete(request) { requests.push(request); return respond(request); } };
  const makeApi = () => createImprovementApi({ records, tasks, resolveModel: async () => { resolutions += 1; return model; }, evaluationTiming: timing });
  let api = makeApi();
  const request = (path: string, init: RequestInit = {}) => api.request(new Request(`http://eval.test${path}`, { ...init, headers: init.headers ?? headers() }));
  const start = (key = randomUUID(), revision = proposal.revision) => request(`/${proposal.id}/evaluations`, { method: 'POST', body: JSON.stringify({ revision, idempotencyKey: key }) });
  const list = async () => { const response = await request(`/${proposal.id}/evaluations`); assert.equal(response.status, 200, await response.clone().text()); return (await response.json() as { evaluations: ImprovementEvaluation[] }).evaluations; };
  const wait = async () => {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const results = await list(); if (results.length && results.every((record) => record.status !== 'running')) return results[0]!;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('Test comparison did not finish.');
  };
  return { records, tasks, source, proposal, requests, request, start, list, wait, get resolutions() { return resolutions; }, restart() { api = makeApi(); },
    async close() { await Promise.all([records.close(), tasks.close()]); } };
};

test('RSI frozen suite uses independent data and rejects invented JSON fields/facts/references', () => {
  assert.equal(improvementEvaluationSuite.cases.length, 5);
  assert.equal(improvementEvaluationSuite.modelCalls, 10);
  const fixture = improvementFixtures[0]!;
  const answer = Object.fromEntries(Object.entries(fixture.expected).map(([key, value]) => [key, value.value]));
  assert.ok(evaluateContract(fixture, JSON.stringify(answer)).every((check) => check.passed));
  const invented = evaluateContract(fixture, JSON.stringify({ ...answer, atlasPercent: 99, citations: ['R1', 'fake'], selfScore: 100 }));
  assert.equal(invented.filter((check) => !check.passed).length, 3);
  assert.ok(evaluateContract(fixture, '```json\n{}\n```').every((check) => !check.passed));
  assert.equal(hasFixtureContamination('AX-RSI-RESEARCH-K7'), true);
  assert.equal(hasFixtureContamination('Independent storage comparison'), false);
});

test('RSI comparison persists 10 measured arms, no source data or execution side effects, and reloads history', async () => {
  const h = await harness();
  try {
    const before = await h.tasks.getTask(h.source.id, identity.tenantId);
    const started = await h.start(); assert.equal(started.status, 202);
    const first = (await started.json() as { evaluation: ImprovementEvaluation }).evaluation;
    assert.equal(first.status, 'running'); assert.equal(first.qualityStatus, 'unverified');
    const evaluated = await h.wait();
    assert.equal(evaluated.status, 'completed'); assert.equal(evaluated.qualityStatus, 'no-clear-change');
    assert.equal(evaluated.summary.baselinePassed, evaluated.summary.totalChecks);
    assert.equal(evaluated.summary.candidatePassed, evaluated.summary.totalChecks);
    assert.equal(evaluated.summary.baselineTokens, 150); assert.equal(evaluated.summary.candidateTokens, 150);
    assert.equal(evaluated.summary.monetaryCost, null); assert.equal(evaluated.summary.humanInterventions, null);
    assert.equal(evaluated.progress.completed, 10); assert.equal(h.requests.length, 10); assert.equal(h.resolutions, 1);
    assert.ok(evaluated.cases.every((entry) => entry.baseline!.latencyMs >= 0 && entry.candidate!.latencyMs >= 0));
    for (const request of h.requests) {
      assert.equal(request.toolChoice, 'none'); assert.ok(!request.tools?.length); assert.equal(request.temperature, 0); assert.equal(request.maxTokens, 900);
      assert.equal(request.maxAttempts, 1);
      assert.doesNotMatch(request.user, /PRIVATE_SOURCE_|Private proposal case/);
      assert.doesNotMatch(request.user, /"expected"/);
    }
    assert.equal(h.requests.filter((request) => request.user.includes('untrustedCandidateGuidance')).length, 5);
    assert.deepEqual(await h.tasks.getTask(h.source.id, identity.tenantId), before);
    assert.equal((await h.tasks.listTasks(identity.tenantId, 100)).length, 1);
    assert.equal((await h.tasks.getEvents(h.source.id)).length, 0);
    assert.deepEqual(await h.records.get(h.proposal.id, identity.tenantId), h.proposal);
    h.restart(); assert.deepEqual(await h.list(), [evaluated]); assert.equal(h.requests.length, 10);
  } finally { await h.close(); }
});

test('RSI per-check regression dominates aggregate gains, all arms required for a conclusion', () => {
  const cases: ImprovementEvaluationCase[] = improvementFixtures.map((fixture) => {
    const checks = evaluateContract(fixture, JSON.stringify(Object.fromEntries(Object.entries(fixture.expected).map(([key, expected]) => [key, expected.value]))));
    return { fixtureId: fixture.id, title: fixture.title, scope: fixture.scope, baseline: { status: 'completed', checks: structuredClone(checks), output: '{}', tokens: 10, latencyMs: 1, attempts: 1 }, candidate: { status: 'completed', checks: structuredClone(checks), output: '{}', tokens: 20, latencyMs: 2, attempts: 1 } };
  });
  cases[0]!.baseline!.checks[1]!.passed = false; cases[1]!.baseline!.checks[1]!.passed = false;
  assert.equal(summarizeImprovementEvaluation(cases, true).qualityStatus, 'improved');
  cases[2]!.candidate!.checks[1]!.passed = false;
  const mixed = summarizeImprovementEvaluation(cases, true);
  assert.equal(mixed.qualityStatus, 'regressed'); assert.equal(mixed.summary.improvedChecks, 2); assert.equal(mixed.summary.regressedChecks, 1);
  cases[4]!.candidate!.status = 'failed';
  assert.equal(summarizeImprovementEvaluation(cases, true).qualityStatus, 'inconclusive');
  assert.equal(summarizeImprovementEvaluation(cases, false).qualityStatus, 'unverified');
});

test('RSI duplicate requests across API workers claim one durable comparison and reject altered keys', async () => {
  const entered = deferred(); const release = deferred();
  const h = await harness(async (request) => { entered.resolve(); await release.promise; return completion(answerFor(request)); });
  try {
    const key = randomUUID(); const first = await h.start(key); assert.equal(first.status, 202); await entered.promise;
    h.restart(); const second = await h.start(key); assert.equal(second.status, 202);
    assert.equal((await first.json() as { evaluation: ImprovementEvaluation }).evaluation.id, (await second.json() as { evaluation: ImprovementEvaluation }).evaluation.id);
    assert.equal((await h.start(key, 2)).status, 409); assert.equal(h.requests.length, 1);
    release.resolve(); await h.wait(); assert.equal(h.requests.length, 10);
    assert.equal((await h.start(key)).status, 200); assert.equal((await h.list()).length, 1); assert.equal(h.resolutions, 1);
  } finally { release.resolve(); await h.close(); }
});

test('RSI comparisons are private, viewer read-only, malformed and stale requests fail before calls', async () => {
  const h = await harness();
  try {
    for (const suffix of ['/evaluations']) {
      assert.equal((await h.request(`/${h.proposal.id}${suffix}`, { headers: headers('bob') })).status, 404);
      assert.equal((await h.request(`/${h.proposal.id}${suffix}`, { method: 'POST', headers: headers('bob'), body: JSON.stringify({ revision: 1, idempotencyKey: randomUUID() }) })).status, 404);
    }
    assert.equal((await h.request(`/${h.proposal.id}/evaluations`, { method: 'POST', headers: headers('alice', 'viewer'), body: JSON.stringify({ revision: 1, idempotencyKey: randomUUID() }) })).status, 403);
    assert.equal((await h.request(`/${h.proposal.id}/evaluations`, { method: 'POST', body: JSON.stringify({ revision: 1, idempotencyKey: 'short', tools: ['shell.exec'] }) })).status, 400);
    assert.equal((await h.start(randomUUID(), 2)).status, 409); assert.equal(h.resolutions, 0);
    const suite = await h.request('/evaluation-suite'); assert.equal(suite.status, 200);
    assert.equal(JSON.stringify(await suite.json()).includes('atlasPercent'), false);
  } finally { await h.close(); }
});

test('RSI explicit cancellation fences late provider responses, no second call or quality promotion', async () => {
  const entered = deferred(); const release = deferred();
  const h = await harness(async (request) => { entered.resolve(); await release.promise; return completion(answerFor(request)); });
  try {
    await h.start(); await entered.promise;
    const running = (await h.list())[0]!;
    const endpoint = `/${h.proposal.id}/evaluations/${running.id}/cancel`;
    assert.equal((await h.request(endpoint, { method: 'POST', body: JSON.stringify({ revision: 1 }) })).status, 409);
    assert.equal((await h.request(endpoint, { method: 'POST', headers: headers('bob'), body: JSON.stringify({ revision: running.revision }) })).status, 404);
    const cancelled = await h.request(endpoint, { method: 'POST', body: JSON.stringify({ revision: running.revision }) }); assert.equal(cancelled.status, 200);
    release.resolve(); await new Promise((resolve) => setTimeout(resolve, 15));
    const final = (await h.list())[0]!; assert.equal(final.status, 'cancelled'); assert.equal(final.qualityStatus, 'inconclusive'); assert.equal(final.progress.completed, 0); assert.equal(h.requests.length, 1);
  } finally { release.resolve(); await h.close(); }
});

test('RSI crash lease recovery survives restart and never replays provider calls', async () => {
  const entered = deferred(); const release = deferred();
  const h = await harness(async (request) => { entered.resolve(); await release.promise; return completion(answerFor(request)); });
  try {
    await h.start(); await entered.promise;
    const record = (await h.records.list(identity.tenantId, 'improvement-evaluation'))[0]!;
    await h.records.update(record.id, identity.tenantId, { data: { ...record.data, leaseExpiresAt: new Date(Date.now() - 1000).toISOString() } }, record.revision);
    h.restart(); const recovered = (await h.list())[0]!; assert.equal(recovered.status, 'failed'); assert.equal(recovered.qualityStatus, 'inconclusive');
    release.resolve(); await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal((await h.list())[0]!.revision, recovered.revision); assert.equal(h.requests.length, 1);
  } finally { release.resolve(); await h.close(); }
});

test('RSI source deletion and candidate revision changes stop in-flight comparisons', async () => {
  for (const mutation of ['delete', 'revision']) {
    const entered = deferred(); const release = deferred();
    const h = await harness(async (request) => { entered.resolve(); await release.promise; return completion(answerFor(request)); });
    try {
      await h.start(); await entered.promise;
      if (mutation === 'delete') await h.tasks.deleteTask(h.source.id, identity.tenantId);
      else await h.records.update(h.proposal.id, identity.tenantId, { status: 'dismissed' }, h.proposal.revision);
      release.resolve(); await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal((await h.records.list(identity.tenantId, 'improvement-evaluation'))[0]!.status, 'failed'); assert.equal(h.requests.length, 1);
      if (mutation === 'delete') assert.equal((await h.request(`/${h.proposal.id}/evaluations`)).status, 404);
    } finally { release.resolve(); await h.close(); }
  }
});

test('RSI rejects direct fixture leakage rather than evaluating its own source task', async () => {
  const h = await harness();
  try {
    await h.records.update(h.proposal.id, identity.tenantId, { data: { ...h.proposal.data, analysis: { ...guidance, trialInstruction: 'Use AX-RSI-PLUGIN-M9 answer.' } } }, 1);
    assert.equal((await h.start(randomUUID(), 2)).status, 409); assert.equal(h.requests.length, 0);
  } finally { await h.close(); }
});

test('RSI provider failures, tool calls and truncation are inconclusive without leaking errors', async () => {
  for (const mode of ['error', 'tool', 'length']) {
    const h = await harness(async (request) => {
      if (mode === 'error') throw new Error('https://private.test?api_key=sk-sensitivecredential987');
      return completion(answerFor(request), mode === 'tool' ? { toolCalls: [{ name: 'shell.exec', args: {} }] } : { finishReason: 'length' });
    });
    try {
      await h.start(); const result = await h.wait(); assert.equal(result.qualityStatus, 'inconclusive'); assert.equal(result.summary.baselineTokens, mode === 'error' ? null : 150);
      assert.doesNotMatch(JSON.stringify(result), /sk-sensitive|private.test|shell.exec/);
      assert.equal((await h.tasks.listTasks(identity.tenantId, 100)).length, 1);
    } finally { await h.close(); }
  }
});

test('RSI different request keys cannot start concurrent paid comparisons across workers', async () => {
  const entered = deferred(); const release = deferred();
  const h = await harness(async (request) => { entered.resolve(); await release.promise; return completion(answerFor(request)); });
  try {
    const responses = await Promise.all([h.start(), h.start()]);
    assert.deepEqual(responses.map((response) => response.status).sort(), [202, 409]);
    await entered.promise; h.restart(); assert.equal((await h.start()).status, 409);
    assert.equal(h.requests.length, 1); assert.equal((await h.list()).length, 1);
    release.resolve(); await h.wait(); assert.equal(h.requests.length, 10);
    assert.equal((await h.start()).status, 202); await h.wait(); assert.equal((await h.list()).length, 2);
  } finally { release.resolve(); await h.close(); }
});

test('RSI idempotent replay rechecks source after record awaits and hides deleted source', async () => {
  const h = await harness();
  try {
    const key = randomUUID(); await h.start(key); const result = await h.wait();
    const originalGet = h.records.get.bind(h.records); let deleted = false;
    h.records.get = async (id, tenantId) => {
      const record = await originalGet(id, tenantId);
      if (id === result.id && !deleted) { deleted = true; await h.tasks.deleteTask(h.source.id, identity.tenantId); }
      return record;
    };
    const replay = await h.start(key); assert.equal(replay.status, 404); assert.doesNotMatch(await replay.text(), /atlasPercent/);
  } finally { await h.close(); }
});

test('RSI evaluation history filters by candidate before the recent-record limit', async () => {
  const h = await harness();
  try {
    await h.start(); const result = await h.wait();
    const unrelatedProposalId = randomUUID();
    for (let index = 0; index < 501; index += 1) await h.records.create({ ...identity, ownerId: identity.userId, kind: 'improvement-evaluation', status: 'completed', data: { proposalId: unrelatedProposalId } });
    const history = await h.list(); assert.equal(history.length, 1); assert.equal(history[0]!.id, result.id);
  } finally { await h.close(); }
});

test('RSI bounded model calls time out even when a provider ignores cancellation', async () => {
  const h = await harness(async () => new Promise<ModelCompletion>(() => undefined), { evaluationTimeoutMs: 35, callTimeoutMs: 10 });
  try {
    await h.start(); const result = await h.wait(); assert.equal(result.status, 'failed'); assert.equal(result.qualityStatus, 'inconclusive');
    assert.ok(h.requests.length <= 4); const revision = result.revision;
    await new Promise((resolve) => setTimeout(resolve, 20)); assert.equal((await h.list())[0]!.revision, revision);
  } finally { await h.close(); }
});

test('RSI missing usage stays null, tokens are not invented, and output is scrubbed before storage', async () => {
  const result = await runImprovementArm({ client: { model: 'fake', async complete() { return completion({ secret: 'sk-sensitivecredential987' }, { usage: undefined }); } }, fixture: improvementFixtures[0]!, signal: new AbortController().signal, redact: (value) => value.replace('sk-sensitivecredential987', '[redacted]') });
  assert.equal(result.tokens, null); assert.doesNotMatch(result.output, /sk-sensitive/); assert.match(result.output, /redacted/);
});
