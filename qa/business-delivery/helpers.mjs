import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import pino from 'pino';
import { WorkflowOrchestrator } from '../../server/runtime/orchestrator.ts';
import { SqliteTaskStore } from '../../server/runtime/sqliteTaskStore.ts';
import { EventHub } from '../../server/runtime/eventHub.ts';
import { createTaskApi } from '../../server/runtime/taskApi.ts';
import { deliveryModelFixture } from '../../server/runtime/testing/deliveryModelFixture.ts';

export const principal = { tenantId: 'delivery-fixture-tenant', userId: 'delivery-fixture-owner' };
export const headers = { 'content-type': 'application/json', 'x-axiom-tenant-id': principal.tenantId, 'x-axiom-user-id': principal.userId };
export const digest = (value) => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
export const memory = {
  async recall() { return { context: '', itemCount: 0, available: false, items: [], quality: { candidates: 0, expiredFiltered: 0, lowConfidenceFiltered: 0, byLayer: { L1: 0, L2: 0, L3: 0 } } }; },
  async capture(task) { return { capturedCount: 0, skipped: true, reason: 'disabled', cursor: task.updatedAt, contentDigest: '' }; },
};
export const step = (id, role = 'analyst', dependsOn = []) => ({ id, title: id, role, objective: `DELIVERY_STEP:${id}`, dependsOn, acceptanceCriteria: ['Preserve the supplied fixture facts and latest requirements.'], toolNames: [], writeScopes: [], failureStrategy: 'retry' });
export const plan = (steps) => ({ summary: 'Bounded business delivery fixture', routingReason: 'Authored plan, routing quality is not evaluated here.', approvalStatus: 'approved', version: 1,
  profile: { kind: 'implementation', difficulty: 'moderate', route: 'team', score: 3, reasons: ['local acceptance'], maxSteps: steps.length, requiresReview: false }, steps });
export const response = (output) => ({ output, evidence: [], confidence: 0.95, toolCalls: [], handoff: { summary: output, status: 'complete', artifactIds: [], evidenceIds: [], openQuestions: [], completionCriteria: ['Fixture output delivered.'] } });

export class FixtureModel {
  model = 'deterministic-business-delivery-fixture';
  calls = [];
  constructor(answer) { this.answer = answer; }
  async complete(request) {
    const call = { system: request.system, user: request.user, completed: false };
    this.calls.push(call);
    try {
      request.signal?.throwIfAborted();
      const delivery = deliveryModelFixture(request);
      const value = delivery ? delivery.content : await this.answer(request, this.calls.length);
      const content = typeof value === 'string' ? value : JSON.stringify(value);
      await request.onDelta?.({ content: content.slice(0, Math.ceil(content.length / 2)) });
      await request.onDelta?.({ content: content.slice(Math.ceil(content.length / 2)) });
      call.completed = true;
      call.output = content;
      return { content, attempts: 1, durationMs: 1, finishReason: 'stop' };
    } catch (error) { call.error = String(error); throw error; }
  }
}

export const taskModel = (outputs, final = 'Fixture delivery completed.') => new FixtureModel((request) => {
  if (request.system.includes('You are the synthesizer')) return final;
  const id = /Assigned objective:\nDELIVERY_STEP:([^\n]+)/.exec(request.user)?.[1];
  assert.ok(id && Object.hasOwn(outputs, id), `Unexpected model invocation for ${id}: ${request.system.slice(0, 80)}`);
  return response(outputs[id]);
});

export async function fixture(id) {
  const directory = await mkdtemp(join(tmpdir(), `axiom-business-delivery-${id}-`));
  let store = new SqliteTaskStore(join(directory, 'tasks.sqlite'));
  await store.initialize();
  const hub = new EventHub();
  const models = [];
  const extraClosers = [];
  return {
    directory, hub, models,
    get store() { return store; },
    register(model) { models.push(model); return model; },
    async create(input = 'Deliver the supplied fixture.', taskPlan = plan([step('analyze'), step('deliver', 'builder', ['analyze'])])) {
      return store.createTask({ ...principal, sessionId: `${id}-session`, title: id, input, mode: 'build', plan: taskPlan });
    },
    api(options = {}) { return createTaskApi({ store, hub, memory, artifactStore: null, artifactCatalog: null, coordinator: { nudge() {}, abort() {} }, ...options }); },
    async run(task, model, signal = AbortSignal.timeout(15_000)) {
      if (!models.includes(model)) models.push(model);
      return new WorkflowOrchestrator(store, hub, model, memory, pino({ level: 'silent' })).run(task, signal);
    },
    async reopen() { await store.close(); store = new SqliteTaskStore(join(directory, 'tasks.sqlite')); await store.initialize(); },
    closeWith(callback) { extraClosers.push(callback); },
    async close() {
      for (const callback of extraClosers.reverse()) await callback();
      await store.close();
      const resolved = resolve(directory);
      assert.ok(resolved.startsWith(`${resolve(tmpdir())}${sep}`) && resolved.includes('axiom-business-delivery-'));
      await rm(resolved, { recursive: true, force: true });
    },
  };
}

export async function delivered(f, task, model, expected) {
  const completed = await f.run(task, model);
  assert.equal(completed.status, 'completed', completed.error);
  assert.equal(completed.result, expected);
  const apiResponse = await f.api().request(`/tasks/${task.id}`, { headers });
  assert.equal(apiResponse.status, 200);
  const snapshot = await apiResponse.json();
  assert.equal((snapshot.task ?? snapshot).result, expected, 'downloaded API result must match persisted delivery');
  return completed;
}

export function evidence(f, value = {}) {
  return { ...value, modelCalls: f.models.reduce((total, model) => total + model.calls.length, 0),
    fixtureModelFailures: f.models.flatMap((model) => model.calls).filter((call) => !call.completed).length,
    realModelTokens: null, realModelCost: null, realModelQualityEvaluated: false };
}
