import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import pino from 'pino';
import type { WorkflowTask } from './contracts.js';
import { deliverySources, digestDelivery, parseDeliveryContract, type DeliveryContract } from './deliveryVerification.js';
import { EventHub } from './eventHub.js';
import type { AgentMemory } from './memoryClient.js';
import type { ModelClient, ModelCompletionRequest } from './modelClient.js';
import { WorkflowOrchestrator } from './orchestrator.js';
import { SqliteTaskStore } from './sqliteTaskStore.js';
import { createTaskApi } from './taskApi.js';
import { ToolRegistry } from './toolRegistry.js';

const input = 'Budget must be 4700. Retention must be 14 days.';
const correctAnswer = 'The approved budget is 4700. Retention is 14 days.';
const arithmeticInput = 'A job requires 600 items at 120 items per hour. Return one JSON object with numeric hours equal to items divided by rate.';
const reversedObjectKeys = <T,>(value: T): T => {
  if (Array.isArray(value)) return value.map((item) => reversedObjectKeys(item)) as T;
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reversedObjectKeys(item)])) as T;
  return value;
};
const memory: AgentMemory = {
  async recall() { return { context: '', itemCount: 0, available: false, items: [], quality: { candidates: 0, expiredFiltered: 0, lowConfidenceFiltered: 0, byLayer: { L1: 0, L2: 0, L3: 0 } } }; },
  async capture(task) { return { capturedCount: 0, skipped: true, reason: 'disabled', cursor: task.updatedAt, contentDigest: '' }; },
};

const stageOf = (request: ModelCompletionRequest) => request.system.startsWith("Extract the current user's delivery requirements") ? 'requirements'
  : request.system.startsWith('Audit the candidate delivery contract against original sources') ? 'contract-audit'
  : request.system.startsWith('Assess the final delivery against every requirement') ? 'verification'
    : request.system.startsWith('You are the final delivery editor') ? 'correction'
      : request.system.includes('You are the synthesizer') ? 'synthesis'
        : request.system.includes('independent reviewer') ? 'review'
          : request.system.includes('conversational agent') ? 'conversation' : 'step';

class DeliveryModel implements ModelClient {
  model = 'local-delivery-gate-fixture';
  calls: string[] = [];
  answer = correctAnswer;
  correctedAnswer = correctAnswer;
  arithmeticRequirement = false;
  wrongExtractedFormula = false;
  auditFailure: 'malformed' | 'throw' | 'truncated' | undefined;
  stepOutput = correctAnswer;
  requirementsFailure: 'malformed' | 'throw' | 'truncated' | undefined;
  assessmentFailure: 'malformed' | 'throw' | 'truncated' | 'reject' | undefined;
  partialStep = false;
  unverifiedEvidence = false;
  truncatedCorrection = false;
  reviewFailure: 'gap' | 'correction' | 'truncated' | undefined;
  useTool = false;
  onStage?: (stage: string, request: ModelCompletionRequest) => Promise<void>;

  async complete(request: ModelCompletionRequest) {
    const stage = stageOf(request);
    this.calls.push(stage);
    await this.onStage?.(stage, request);
    request.signal.throwIfAborted();
    let content: string;
    if (['requirements', 'contract-audit', 'verification', 'correction'].includes(stage)) {
      assert.equal(request.toolChoice, 'none');
      assert.equal(request.tools?.length ?? 0, 0, 'final delivery stages cannot execute tools');
    }
    if (stage === 'requirements') {
      if (this.requirementsFailure === 'throw') throw new Error('Fixture extraction unavailable.');
      const { sources } = JSON.parse(request.user) as { sources: Array<{ id: string; text: string }> };
      assert.ok(!Object.hasOwn(JSON.parse(request.user), 'finalDelivery'), 'requirements cannot be derived from the draft');
      const requirements = this.arithmeticRequirement ? [{
        id: 'hours', text: 'Return numeric hours calculated as 600 divided by 120.', sourceId: sources[0]!.id, sourceQuote: arithmeticInput,
        calculation: { path: ['hours'], expression: { op: this.wrongExtractedFormula ? 'multiply' : 'divide', args: [
          { sourceId: sources[0]!.id, sourceQuote: '600', value: 600 },
          { sourceId: sources[0]!.id, sourceQuote: '120', value: 120 },
        ] } },
      }] : sources.flatMap((source) => [
        ...(source.text.includes('Budget must be 4700.') ? [{ id: 'budget', text: 'Budget must be 4700.', sourceId: source.id, sourceQuote: 'Budget must be 4700.' }] : []),
        ...(source.text.includes('Retention must be 14 days.') ? [{ id: 'retention', text: 'Retention must be 14 days.', sourceId: source.id, sourceQuote: 'Retention must be 14 days.' }] : []),
      ]);
      content = this.requirementsFailure === 'malformed' ? '{"requirements":[' : JSON.stringify({ requirements });
    } else if (stage === 'contract-audit') {
      if (this.auditFailure === 'throw') throw new Error('Fixture contract audit unavailable.');
      const payload = JSON.parse(request.user) as { sources: Array<{ id: string; text: string }>; candidateContract: DeliveryContract };
      assert.ok(payload.sources.length);
      assert.equal(Object.hasOwn(payload, 'finalDelivery'), false, 'the contract auditor must not see the candidate answer');
      assert.equal(Object.hasOwn(payload, 'executionContext'), false, 'the contract auditor must not derive scope from Agent output');
      const requirements = structuredClone(payload.candidateContract.requirements);
      if (this.wrongExtractedFormula) {
        const calculation = requirements.find((item) => item.id === 'hours')?.calculation;
        assert.ok(calculation && 'op' in calculation.expression);
        assert.equal(calculation.expression.op, 'multiply');
        assert.ok(payload.sources.some((source) => source.text === arithmeticInput));
        calculation.expression.op = 'divide';
      }
      content = this.auditFailure === 'malformed' ? '{"requirements":[' : JSON.stringify({ requirements });
    } else if (stage === 'verification') {
      if (this.assessmentFailure === 'throw') throw new Error('Fixture verification unavailable.');
      const { contract, finalDelivery } = JSON.parse(request.user) as { contract: { requirements: Array<{ id: string }> }; finalDelivery: string };
      content = this.assessmentFailure === 'malformed' ? '{"requirements":[' : JSON.stringify({ requirements: contract.requirements.map((requirement) => {
        if (this.arithmeticRequirement) return { id: requirement.id, status: 'satisfied', reason: 'The fixture model incorrectly approves every arithmetic answer.', outputQuote: finalDelivery };
        const quote = requirement.id === 'budget' ? '4700' : '14 days';
        const satisfied = finalDelivery.includes(quote) && this.assessmentFailure !== 'reject';
        return { id: requirement.id, status: satisfied ? 'satisfied' : 'unsatisfied', reason: satisfied ? `Candidate preserves ${quote}.` : `Candidate does not establish ${quote}.`, outputQuote: satisfied ? quote : '' };
      }) });
    } else if (stage === 'correction') content = this.correctedAnswer;
    else if (stage === 'synthesis') content = this.answer;
    else if (stage === 'review') content = JSON.stringify({ approved: true, score: 100, summary: 'Authored review fixture.',
      gaps: this.reviewFailure === 'gap' ? ['The review still has an unresolved gap.'] : [],
      requiredCorrections: this.reviewFailure === 'correction' ? ['A correction is still required.'] : [] });
    else if (stage === 'conversation') content = 'Hello.';
    else content = JSON.stringify({ output: this.stepOutput, confidence: 0.95,
      evidence: this.unverifiedEvidence ? [{ claim: 'The supplied budget is 4700.', kind: 'model-inference', source: 'authored-fixture', verification: 'unverified', confidence: 0.8 }] : [],
      ...(this.partialStep ? { handoff: { summary: 'The execution remains incomplete.', status: 'partial', artifactIds: [], evidenceIds: [], openQuestions: ['A required execution step is unfinished.'], completionCriteria: [] } } : {}),
      toolCalls: this.useTool && request.system.includes('sub-agent') ? [{ name: 'workspace.read', args: { path: 'facts.txt' } }] : [] });
    if (!['requirements', 'contract-audit', 'verification', 'correction'].includes(stage)) await request.onDelta?.({ content });
    return { content, attempts: 1, durationMs: 1,
      finishReason: stage === 'verification' && this.assessmentFailure === 'truncated' || stage === 'review' && this.reviewFailure === 'truncated'
        || stage === 'requirements' && this.requirementsFailure === 'truncated' || stage === 'contract-audit' && this.auditFailure === 'truncated'
        || stage === 'correction' && this.truncatedCorrection ? 'length' : 'stop' };
  }
}

async function fixture(options: { persistent?: boolean; requiresReview?: boolean; tool?: boolean; input?: string } = {}) {
  const previousExecutor = process.env.AXIOM_TOOL_EXECUTOR;
  if (options.tool) process.env.AXIOM_TOOL_EXECUTOR = 'docker';
  const directory = options.persistent ? await mkdtemp(join(tmpdir(), 'axiom-delivery-gate-')) : undefined;
  const filename = directory ? join(directory, 'tasks.sqlite') : ':memory:';
  let store = new SqliteTaskStore(filename);
  await store.initialize();
  let toolExecutions = 0;
  const tools = options.tool ? new ToolRegistry({ execute: async () => {
    toolExecutions += 1;
    return { stdout: correctAnswer, stderr: '', exitCode: 0, durationMs: 1, auditId: 'delivery-gate-fixture' };
  } } as never) : undefined;
  const task = await store.createTask({ tenantId: 'delivery-test', userId: 'owner', sessionId: 'delivery-test-session', title: 'Bounded acceptance', input: options.input ?? input, mode: 'build',
    plan: { summary: 'Produce the authored delivery.', routingReason: 'Hard fixture exercises final acceptance.', approvalStatus: 'approved', version: 1,
      profile: { kind: 'implementation', difficulty: 'hard', route: 'full-workflow', score: 5, reasons: ['fixture'], maxSteps: 1, requiresReview: options.requiresReview ?? false },
      steps: [{ id: 'build', title: 'Prepare delivery', role: 'builder', objective: 'Preserve the supplied budget and retention.', dependsOn: [],
        acceptanceCriteria: ['Preserve budget and retention.'], toolNames: options.tool ? ['workspace.read'] : [], writeScopes: [], failureStrategy: 'retry' }] } });
  return {
    task, get store() { return store; }, get toolExecutions() { return toolExecutions; },
    run(current: WorkflowTask, model: ModelClient, signal = AbortSignal.timeout(10_000)) { return new WorkflowOrchestrator(store, new EventHub(), model, memory, pino({ level: 'silent' }), tools).run(current, signal); },
    async approve(current: WorkflowTask) {
      const api = createTaskApi({ store, hub: new EventHub(), memory: memory as never, artifactStore: null, artifactCatalog: null, coordinator: { nudge() {}, abort() {} } as never });
      const response = await api.request(`/tasks/${current.id}/approve-review`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-axiom-tenant-id': current.tenantId, 'x-axiom-user-id': current.userId },
        body: JSON.stringify({ note: 'I explicitly accept the remaining gaps as partial delivery.', expectedRevision: current.revision }) });
      assert.equal(response.status, 202, await response.clone().text());
      return (await response.json() as { task: WorkflowTask }).task;
    },
    async note(current: WorkflowTask, message: string) {
      const api = createTaskApi({ store, hub: new EventHub(), memory: memory as never, artifactStore: null, artifactCatalog: null, coordinator: { nudge() {}, abort() {} } as never });
      const response = await api.request(`/tasks/${current.id}/notes`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-axiom-tenant-id': current.tenantId, 'x-axiom-user-id': current.userId },
        body: JSON.stringify({ message, expectedRevision: current.revision }) });
      assert.equal(response.status, 202, await response.clone().text());
    },
    async reopen() { assert.ok(directory); await store.close(); store = new SqliteTaskStore(filename); await store.initialize(); },
    async close() {
      await store.close();
      if (directory) await rm(directory, { recursive: true, force: true });
      if (options.tool) {
        if (previousExecutor === undefined) delete process.env.AXIOM_TOOL_EXECUTOR; else process.env.AXIOM_TOOL_EXECUTOR = previousExecutor;
      }
    },
  };
}

test('hard delivery derives requirements before synthesis and persists exact-result acceptance', async () => {
  const f = await fixture();
  try {
    const model = new DeliveryModel();
    const result = await f.run(f.task, model);
    assert.equal(result.status, 'completed', result.error);
    assert.deepEqual(model.calls, ['step', 'requirements', 'contract-audit', 'synthesis', 'verification']);
    assert.equal(result.review?.delivery?.status, 'passed');
    assert.equal(result.review?.delivery?.resultDigest, digestDelivery(correctAnswer));
    assert.equal(result.review?.delivery?.factualCorrectness, 'not-independently-verified');
    assert.equal((await f.store.getTask(result.id))?.review?.delivery?.resultDigest, digestDelivery(correctAnswer));
    const events = await f.store.getEvents(result.id);
    assert.equal(events.filter((event) => event.type === 'delivery.assessed').length, 1);
    assert.ok(events.findIndex((event) => event.type === 'delivery.assessed') < events.findIndex((event) => event.type === 'task.completed'));
  } finally { await f.close(); }
});

test('one text-only revision repairs missing requirements without replaying a real tool', async () => {
  const f = await fixture({ tool: true });
  try {
    const model = new DeliveryModel();
    model.useTool = true;
    model.answer = 'The budget is 5200.';
    const result = await f.run(f.task, model);
    assert.equal(result.status, 'completed', result.error);
    assert.equal(result.result, correctAnswer);
    assert.equal(f.toolExecutions, 1);
    assert.equal(model.calls.filter((stage) => stage === 'step').length, 2, 'initial tool call and tool observation only');
    assert.equal(model.calls.filter((stage) => stage === 'correction').length, 1);
    assert.equal(model.calls.filter((stage) => stage === 'verification').length, 2);
    assert.equal(result.review?.delivery?.correctionAttempts, 1);
  } finally { await f.close(); }
});

test('source-only contract audit fixes a mistaken formula without changing an already correct answer', async () => {
  const f = await fixture({ tool: true, input: arithmeticInput });
  try {
    const model = new DeliveryModel();
    model.useTool = true;
    model.arithmeticRequirement = true;
    model.wrongExtractedFormula = true;
    model.answer = '{"hours":5}';
    const result = await f.run(f.task, model);
    assert.equal(result.status, 'completed', result.error);
    assert.equal(result.result, model.answer);
    assert.equal(result.review?.delivery?.status, 'passed');
    assert.equal(result.review?.delivery?.requirements[0]?.calculation?.expected, 5);
    assert.deepEqual(model.calls, ['step', 'step', 'requirements', 'contract-audit', 'synthesis', 'verification']);
    assert.equal(model.calls.includes('correction'), false);
    assert.equal(f.toolExecutions, 1);
    const saved = (await f.store.getEvents(result.id)).filter((event) => event.type === 'delivery.contract.created');
    assert.equal(saved.length, 1, 'only the audited requirement contract is durable and reusable');
    assert.equal(saved[0]?.payload.auditVersion, 1);
    assert.equal(typeof saved[0]?.payload.extractionDigest, 'string');
    assert.notEqual(saved[0]?.payload.extractionDigest, saved[0]?.payload.digest);
    const requirements = saved[0]?.payload.requirements as DeliveryContract['requirements'];
    const expression = requirements[0]?.calculation?.expression;
    assert.ok(expression && 'op' in expression);
    assert.equal(expression.op, 'divide');
  } finally { await f.close(); }
});

for (const failure of ['malformed', 'throw', 'truncated'] as const) test(`contract audit ${failure} does not certify the unaudited candidate or replay tools`, async () => {
  const f = await fixture({ tool: true });
  try {
    const model = new DeliveryModel();
    model.useTool = true;
    model.auditFailure = failure;
    const result = await f.run(f.task, model);
    assert.equal(result.status, 'waiting_for_human');
    assert.equal(result.review?.delivery?.status, 'inconclusive');
    assert.equal(result.review?.delivery?.contractDigest, null);
    assert.equal(result.result, correctAnswer);
    assert.equal(model.calls.filter((stage) => stage === 'contract-audit').length, 1);
    assert.equal(model.calls.includes('verification'), false);
    assert.equal(model.calls.includes('correction'), false);
    assert.equal(model.calls.filter((stage) => stage === 'step').length, 2);
    assert.equal(f.toolExecutions, 1);
    assert.equal((await f.store.getEvents(result.id)).some((event) => event.type === 'delivery.contract.created'), false);
  } finally { await f.close(); }
});

test('a legacy contract without an audit receipt is audited once before it can be reused', async () => {
  const f = await fixture();
  const controller = new AbortController();
  try {
    const legacyContract = parseDeliveryContract(JSON.stringify({ requirements: [
      { id: 'budget', text: 'Budget must be 4700.', sourceId: 'input', sourceQuote: 'Budget must be 4700.' },
      { id: 'retention', text: 'Retention must be 14 days.', sourceId: 'input', sourceQuote: 'Retention must be 14 days.' },
    ] }), deliverySources(f.task, []));
    await f.store.appendEvent(f.task, { type: 'delivery.contract.created', payload: { ...legacyContract } });
    const firstModel = new DeliveryModel();
    firstModel.onStage = async (stage) => { if (stage === 'verification') controller.abort(new DOMException('Runtime shutting down', 'AbortError')); };
    const interrupted = await f.run(f.task, firstModel, controller.signal);
    assert.equal(firstModel.calls.filter((stage) => stage === 'requirements').length, 0);
    assert.equal(firstModel.calls.filter((stage) => stage === 'contract-audit').length, 1);
    const contracts = (await f.store.getEvents(f.task.id)).filter((event) => event.type === 'delivery.contract.created');
    assert.equal(contracts.length, 2);
    assert.equal(contracts.at(-1)?.payload.auditVersion, 1);
    const restored = await f.store.getTask(interrupted.id);
    assert.ok(restored);
    const resumedModel = new DeliveryModel();
    const completed = await f.run(restored, resumedModel);
    assert.equal(completed.status, 'completed', completed.error);
    assert.deepEqual(resumedModel.calls, ['verification'], 'an already audited contract and persisted draft must survive restart without a second audit');
  } finally { await f.close(); }
});

test('an old approval cannot skip contract auditing when its contract has no audit version', async () => {
  const f = await fixture({ tool: true });
  try {
    const appendEvent = f.store.appendEvent.bind(f.store);
    f.store.appendEvent = async (task, event) => {
      if (event.type !== 'delivery.contract.created') return appendEvent(task, event);
      const { auditVersion: _auditVersion, extractionDigest: _extractionDigest, ...legacyPayload } = event.payload;
      return appendEvent(task, { ...event, payload: legacyPayload });
    };
    const firstModel = new DeliveryModel();
    firstModel.useTool = true;
    firstModel.assessmentFailure = 'reject';
    const waiting = await f.run(f.task, firstModel);
    assert.equal(waiting.status, 'waiting_for_human');
    const approved = await f.approve(waiting);
    f.store.appendEvent = appendEvent;
    const resumedModel = new DeliveryModel();
    resumedModel.assessmentFailure = 'reject';
    const result = await f.run(approved, resumedModel);
    assert.equal(result.status, 'waiting_for_human', 'legacy approval cannot silently cover a newly audited contract');
    assert.equal(resumedModel.calls.filter((stage) => stage === 'contract-audit').length, 1);
    assert.equal(resumedModel.calls.filter((stage) => stage === 'verification').length, 1);
    assert.equal(resumedModel.calls.includes('step'), false);
    assert.equal(resumedModel.calls.includes('correction'), false, 'contract auditing must not reset the bounded revision budget');
    assert.equal(f.toolExecutions, 1);
    assert.equal((await f.store.getEvents(result.id)).some((event) => event.type === 'task.completed'), false);
  } finally { await f.close(); }
});

for (const repaired of [true, false]) test(`source-bound arithmetic overrides a mistaken model pass and ${repaired ? 'accepts only the corrected number' : 'keeps a repeated wrong number awaiting review'}`, async () => {
  const f = await fixture({ tool: true, input: arithmeticInput });
  try {
    const model = new DeliveryModel();
    model.useTool = true;
    model.arithmeticRequirement = true;
    model.stepOutput = 'Items: 600. Rate: 120 items per hour.';
    model.answer = '{"hours":1.25}';
    model.correctedAnswer = repaired ? '{"hours":5}' : '{"hours":1.250}';
    model.onStage = async (stage, request) => {
      if (stage !== 'correction') return;
      const { findings } = JSON.parse(request.user) as { findings: Array<{ id: string; status: string; calculation?: { basis: string; path: string[]; status: string; expected: number; actual: number } }> };
      const finding = findings.find((item) => item.id === 'hours');
      assert.equal(finding?.status, 'unsatisfied');
      assert.equal(finding?.calculation?.basis, 'deterministic-arithmetic');
      assert.deepEqual(finding?.calculation?.path, ['hours']);
      assert.equal(finding?.calculation?.status, 'unsatisfied');
      assert.equal(finding?.calculation?.expected, 5);
      assert.equal(finding?.calculation?.actual, 1.25);
    };
    const result = await f.run(f.task, model);
    assert.equal(result.status, repaired ? 'completed' : 'waiting_for_human', result.error);
    assert.equal(result.result, model.correctedAnswer);
    assert.equal(result.review?.delivery?.status, repaired ? 'passed' : 'needs-revision');
    const requirement = result.review?.delivery?.requirements.find((item) => item.id === 'hours');
    assert.equal(requirement?.status, repaired ? 'satisfied' : 'unsatisfied');
    assert.equal(requirement?.calculation?.basis, 'deterministic-arithmetic');
    assert.deepEqual(requirement?.calculation?.path, ['hours']);
    assert.equal(requirement?.calculation?.status, repaired ? 'satisfied' : 'unsatisfied');
    assert.equal(requirement?.calculation?.expected, 5);
    assert.equal(requirement?.calculation?.actual, repaired ? 5 : 1.25);
    assert.equal(result.review?.delivery?.correctionAttempts, 1);
    assert.equal(model.calls.filter((stage) => stage === 'correction').length, 1);
    assert.equal(model.calls.filter((stage) => stage === 'verification').length, 2);
    assert.equal(model.calls.filter((stage) => stage === 'step').length, 2, 'one tool request and its observation, without Agent replay');
    assert.equal(f.toolExecutions, 1);
    const events = await f.store.getEvents(result.id);
    const assessments = events.filter((event) => event.type === 'delivery.assessed');
    assert.equal(assessments[0]?.payload.status, 'needs-revision', 'the first wrong answer must not inherit the model pass');
    assert.equal(events.filter((event) => event.type === 'task.completed').length, repaired ? 1 : 0);
  } finally { await f.close(); }
});

test('unresolved final requirements retain the draft and require explicit partial acceptance', async () => {
  const f = await fixture({ tool: true });
  try {
    const model = new DeliveryModel();
    model.useTool = true;
    model.answer = 'Budget is 5200.';
    model.correctedAnswer = 'Budget remains 5200.';
    const waiting = await f.run(f.task, model);
    assert.equal(waiting.status, 'waiting_for_human');
    assert.equal(waiting.result, 'Budget remains 5200.');
    assert.equal(waiting.review?.approved, false);
    assert.equal(waiting.review?.delivery?.status, 'needs-revision');
    assert.equal((await f.store.getEvents(waiting.id)).some((event) => event.type === 'task.completed'), false);
    const count = model.calls.length;
    const approved = await f.approve(waiting);
    const completed = await f.run(approved, model);
    assert.equal(completed.status, 'completed', completed.error);
    assert.equal(completed.result, waiting.result);
    assert.equal(completed.review?.delivery?.status, 'needs-revision', 'human acceptance must not claim machine verification passed');
    assert.equal(model.calls.length, count, 'accepting this exact draft must not invoke any model again');
    assert.equal(f.toolExecutions, 1);
    assert.equal((await f.store.getEvents(completed.id)).find((event) => event.type === 'task.completed')?.payload.partial, true);
  } finally { await f.close(); }
});

for (const failure of ['malformed', 'throw', 'truncated'] as const) test(`final verification ${failure} fails closed without retries or false completion`, async () => {
  const f = await fixture();
  try {
    const model = new DeliveryModel();
    model.assessmentFailure = failure;
    const result = await f.run(f.task, model);
    assert.equal(result.status, 'waiting_for_human');
    assert.equal(result.result, correctAnswer);
    assert.equal(result.review?.delivery?.status, 'inconclusive');
    assert.equal(model.calls.filter((stage) => stage === 'verification').length, 1);
    assert.equal(model.calls.includes('correction'), false);
    assert.equal((await f.store.getEvents(result.id)).some((event) => event.type === 'task.completed'), false);
  } finally { await f.close(); }
});

for (const failure of ['malformed', 'throw', 'truncated'] as const) test(`requirements extraction ${failure} retains a draft but cannot certify it`, async () => {
  const f = await fixture();
  try {
    const model = new DeliveryModel();
    model.requirementsFailure = failure;
    const result = await f.run(f.task, model);
    assert.equal(result.status, 'waiting_for_human');
    assert.equal(result.result, correctAnswer);
    assert.equal(result.review?.delivery?.status, 'inconclusive');
    assert.equal(result.review?.delivery?.contractDigest, null);
    assert.equal(model.calls.filter((stage) => stage === 'requirements').length, 1);
    assert.equal(model.calls.includes('verification'), false);
    assert.equal(model.calls.includes('correction'), false);
  } finally { await f.close(); }
});

test('a truncated text revision cannot replace the original draft or certify success', async () => {
  const f = await fixture();
  try {
    const model = new DeliveryModel();
    model.answer = 'Budget is 5200.';
    model.truncatedCorrection = true;
    const result = await f.run(f.task, model);
    assert.equal(result.status, 'waiting_for_human');
    assert.equal(result.result, model.answer);
    assert.equal(result.review?.delivery?.status, 'inconclusive');
    assert.equal(result.review?.delivery?.correctionAttempts, 1);
    assert.equal(model.calls.filter((stage) => stage === 'verification').length, 1);
  } finally { await f.close(); }
});

test('a semantically passing draft cannot hide an unfinished execution handoff', async () => {
  const f = await fixture();
  try {
    const model = new DeliveryModel();
    model.partialStep = true;
    const result = await f.run(f.task, model);
    assert.equal(result.status, 'waiting_for_human');
    assert.equal(result.review?.delivery?.status, 'needs-revision');
    assert.ok(result.stepResults.some((step) => step.handoff?.status === 'partial'));
    assert.equal(result.review?.delivery?.runtimeExecution, 'partial');
    assert.ok(result.review?.delivery?.runtimeGaps?.length);
    assert.ok(result.review?.gaps.length);
    assert.equal(model.calls.includes('correction'), false, 'a text editor must not pretend to repair unfinished execution');
  } finally { await f.close(); }
});

test('completed execution with unverified evidence remains complete without inventing factual verification', async () => {
  const f = await fixture();
  try {
    const model = new DeliveryModel();
    model.unverifiedEvidence = true;
    const result = await f.run(f.task, model);
    assert.equal(result.status, 'completed', result.error);
    assert.ok(result.stepResults.some((step) => step.evidenceDetails?.some((evidence) => evidence.verification === 'unverified')));
    assert.equal(result.review?.delivery?.status, 'passed');
    assert.equal(result.review?.delivery?.runtimeExecution, 'completed');
    assert.deepEqual(result.review?.delivery?.runtimeGaps, []);
    assert.equal(result.review?.delivery?.factualCorrectness, 'not-independently-verified');
    const events = await f.store.getEvents(result.id);
    const assessed = events.filter((event) => event.type === 'delivery.assessed').at(-1);
    assert.deepEqual(assessed?.payload.runtimeGaps, []);
    assert.equal(assessed?.payload.factualCorrectness, 'not-independently-verified');
    assert.equal(events.find((event) => event.type === 'task.completed')?.payload.partial, false);
  } finally { await f.close(); }
});

for (const mutation of ['guidance', 'result', 'work'] as const) test(`changing ${mutation} invalidates approval bound to an older delivery`, async () => {
  const f = await fixture();
  try {
    const model = new DeliveryModel();
    model.assessmentFailure = 'reject';
    const waiting = await f.run(f.task, model);
    const approved = await f.approve(waiting);
    if (mutation === 'guidance') await f.store.appendEvent(approved, { type: 'human.note', payload: { author: 'owner', message: 'A later constraint requires source disclosure.' } });
    const changed = mutation === 'guidance' ? approved : await f.store.updateTask(approved.id, mutation === 'result' ? { result: 'A different draft.' }
      : { stepResults: approved.stepResults.map((step) => ({ ...step, output: `${step.output} Evidence changed.` })) });
    const before = model.calls.filter((stage) => stage === 'verification').length;
    const result = await f.run(changed, model);
    assert.equal(result.status, 'waiting_for_human');
    assert.ok(model.calls.filter((stage) => stage === 'verification').length > before);
    assert.equal((await f.store.getEvents(result.id)).some((event) => event.type === 'task.completed'), false);
  } finally { await f.close(); }
});

test('restart after a saved draft resumes final verification without repeating tools or synthesis', async () => {
  const f = await fixture({ persistent: true, tool: true });
  const controller = new AbortController();
  try {
    const model = new DeliveryModel();
    model.useTool = true;
    model.onStage = async (stage) => { if (stage === 'verification') controller.abort(new DOMException('Runtime shutting down', 'AbortError')); };
    const interrupted = await f.run(f.task, model, controller.signal);
    assert.equal(interrupted.result, correctAnswer);
    assert.equal(interrupted.review?.delivery?.status, 'inconclusive');
    assert.notEqual(interrupted.status, 'cancelled');
    await f.reopen();
    const restored = await f.store.getTask(interrupted.id);
    assert.ok(restored);
    const recoveredModel = new DeliveryModel();
    const completed = await f.run(restored, recoveredModel);
    assert.equal(completed.status, 'completed', completed.error);
    assert.deepEqual(recoveredModel.calls, ['verification']);
    assert.equal(f.toolExecutions, 1);
  } finally { await f.close(); }
});

test('restart after a persisted passing receipt reuses the exact draft without any model calls', async () => {
  const f = await fixture({ persistent: true });
  const controller = new AbortController();
  try {
    const updateTask = f.store.updateTask.bind(f.store);
    f.store.updateTask = async (...args) => {
      const updated = await updateTask(...args);
      if (args[1].review?.delivery?.status === 'passed') controller.abort(new DOMException('Runtime shutting down', 'AbortError'));
      return updated;
    };
    const interrupted = await f.run(f.task, new DeliveryModel(), controller.signal);
    assert.equal(interrupted.result, correctAnswer);
    assert.equal(interrupted.review?.delivery?.status, 'passed');
    assert.notEqual(interrupted.status, 'completed');
    await f.reopen();
    const restored = await f.store.getTask(interrupted.id);
    assert.ok(restored);
    const model = new DeliveryModel();
    const completed = await f.run(restored, model);
    assert.equal(completed.status, 'completed', completed.error);
    assert.deepEqual(model.calls, []);
    assert.equal((await f.store.getEvents(completed.id)).filter((event) => event.type === 'task.completed').length, 1);
  } finally { await f.close(); }
});

test('JSONB-like recursive key reordering cannot invalidate approval of unchanged work', async () => {
  const f = await fixture({ persistent: true, tool: true });
  try {
    const model = new DeliveryModel();
    model.useTool = true;
    model.assessmentFailure = 'reject';
    const waiting = await f.run(f.task, model);
    const approved = await f.approve(waiting);
    const reorderedPlan = reversedObjectKeys(approved.plan);
    const reorderedResults = reversedObjectKeys(approved.stepResults);
    assert.deepEqual(reorderedPlan, approved.plan);
    assert.deepEqual(reorderedResults, approved.stepResults);
    assert.notEqual(JSON.stringify(reorderedPlan?.steps), JSON.stringify(approved.plan?.steps));
    assert.notEqual(JSON.stringify(reorderedResults), JSON.stringify(approved.stepResults));
    await f.store.updateTask(approved.id, { plan: reorderedPlan, stepResults: reorderedResults });
    await f.reopen();
    const restored = await f.store.getTask(approved.id);
    assert.ok(restored);
    const resumedModel = new DeliveryModel();
    const completed = await f.run(restored, resumedModel);
    assert.equal(completed.status, 'completed', completed.error);
    assert.equal(completed.result, approved.result);
    assert.equal(completed.review?.delivery?.contextDigest, approved.review?.delivery?.contextDigest);
    assert.deepEqual(resumedModel.calls, [], 'representation-only database changes must not trigger synthesis, verification or tools');
    assert.equal(f.toolExecutions, 1);
  } finally { await f.close(); }
});

test('an operator note accepted during upstream review prevents stale review from being committed', async () => {
  const f = await fixture({ requiresReview: true });
  try {
    const model = new DeliveryModel();
    let noteAccepted = false;
    model.onStage = async (stage) => {
      if (stage !== 'review' || noteAccepted) return;
      const current = await f.store.getTask(f.task.id);
      assert.ok(current);
      await f.note(current, 'Add source disclosure before delivery.');
      noteAccepted = true;
    };
    const result = await f.run(f.task, model);
    assert.equal(noteAccepted, true);
    assert.notEqual(result.status, 'completed');
    assert.equal(result.review, undefined, 'a late review of an older revision must not replace the accepted operator update');
    assert.equal(model.calls.includes('synthesis'), false);
    assert.equal(model.calls.includes('requirements'), false);
    const events = await f.store.getEvents(result.id);
    assert.ok(events.some((event) => event.type === 'human.note' && event.payload.message === 'Add source disclosure before delivery.'));
    assert.equal(events.some((event) => event.type === 'task.completed'), false);
  } finally { await f.close(); }
});

for (const action of ['pause', 'cancel', 'guidance'] as const) test(`${action} during final verification cannot be overwritten by late delivery`, async () => {
  const f = await fixture();
  try {
    const model = new DeliveryModel();
    let changed = false;
    model.onStage = async (stage) => {
      if (stage !== 'verification' || changed) return;
      changed = true;
      const current = await f.store.getTask(f.task.id);
      assert.ok(current);
      if (action === 'guidance') await f.store.appendEvent(current, { type: 'human.note', payload: { author: 'owner', message: 'Add the source disclosure requirement.' } });
      else await f.store.updateTask(current.id, { status: action === 'pause' ? 'paused' : 'cancelled', cancelRequested: action === 'cancel', result: 'Operator-owned draft.' });
    };
    const result = await f.run(f.task, model);
    assert.equal(changed, true);
    assert.equal(result.status, action === 'pause' ? 'paused' : action === 'cancel' ? 'cancelled' : 'waiting_for_human');
    if (action !== 'guidance') assert.equal(result.result, 'Operator-owned draft.');
    else assert.equal(result.review?.delivery?.status, 'inconclusive');
    assert.equal((await f.store.getEvents(result.id)).some((event) => event.type === 'task.completed'), false);
  } finally { await f.close(); }
});

test('changed execution context reruns the upstream reviewer but never completed tools', async () => {
  const f = await fixture({ requiresReview: true, tool: true });
  try {
    const model = new DeliveryModel();
    model.useTool = true;
    model.assessmentFailure = 'reject';
    const waiting = await f.run(f.task, model);
    const approved = await f.approve(waiting);
    const changed = await f.store.updateTask(approved.id, { stepResults: approved.stepResults.map((step) => ({ ...step, output: `${step.output} New unverified evidence.` })) });
    model.reviewFailure = 'gap';
    const result = await f.run(changed, model);
    assert.equal(result.status, 'waiting_for_human');
    assert.equal(model.calls.filter((stage) => stage === 'review').length, 2);
    assert.ok(result.review?.gaps.includes('The review still has an unresolved gap.'));
    assert.equal(f.toolExecutions, 1);
    assert.equal(model.calls.filter((stage) => stage === 'step').length, 2);
  } finally { await f.close(); }
});

test('a complex template plan without a profile cannot silently bypass final acceptance', async () => {
  const f = await fixture();
  try {
    const task = await f.store.createTask({ tenantId: 'delivery-test', userId: 'owner', sessionId: 'legacy-template', templateId: 'legacy-template', title: 'Complex legacy template',
      input: `Design and implement a complete production platform with authentication, database migrations, architecture, deployment, observability, rollback, and acceptance testing. ${input}`, mode: 'build',
      plan: { ...f.task.plan!, profile: undefined } });
    const model = new DeliveryModel();
    const result = await f.run(task, model);
    assert.equal(result.status, 'completed', result.error);
    assert.ok(result.plan?.profile);
    assert.equal(model.calls.filter((stage) => stage === 'requirements').length, 1);
    assert.equal(model.calls.filter((stage) => stage === 'verification').length, 1);
    assert.equal(result.review?.delivery?.status, 'passed');
  } finally { await f.close(); }
});

test('simple conversation does not invoke the complex-delivery gate', async () => {
  const f = await fixture();
  try {
    const model = new DeliveryModel();
    const task = await f.store.createTask({ tenantId: 'delivery-test', userId: 'owner', sessionId: 'chat', title: 'Hello', input: 'hello', mode: 'analyze' });
    const result = await f.run(task, model);
    assert.equal(result.status, 'completed');
    assert.deepEqual(model.calls, ['conversation']);
    assert.equal(result.review?.delivery, undefined);
  } finally { await f.close(); }
});

for (const failure of ['gap', 'correction', 'truncated'] as const) test(`a high review score with ${failure} cannot be silently treated as approval`, async () => {
  const oldRounds = process.env.AGENT_REVIEW_CORRECTION_ROUNDS;
  process.env.AGENT_REVIEW_CORRECTION_ROUNDS = '0';
  const f = await fixture({ requiresReview: true });
  try {
    const model = new DeliveryModel();
    model.reviewFailure = failure;
    const result = await f.run(f.task, model);
    assert.notEqual(result.status, 'completed');
    assert.ok(!result.review?.approved);
    assert.equal(model.calls.includes('synthesis'), false);
    assert.equal((await f.store.getEvents(result.id)).some((event) => event.type === 'task.completed'), false);
  } finally {
    if (oldRounds === undefined) delete process.env.AGENT_REVIEW_CORRECTION_ROUNDS; else process.env.AGENT_REVIEW_CORRECTION_ROUNDS = oldRounds;
    await f.close();
  }
});

test('a passing final assessment cannot erase unresolved upstream review gaps even with legacy approval disabled', async () => {
  const previous = { rounds: process.env.AGENT_REVIEW_CORRECTION_ROUNDS, approval: process.env.AGENT_REQUIRE_REVIEW_APPROVAL };
  process.env.AGENT_REVIEW_CORRECTION_ROUNDS = '0';
  process.env.AGENT_REQUIRE_REVIEW_APPROVAL = 'false';
  const f = await fixture({ requiresReview: true });
  try {
    const model = new DeliveryModel();
    model.reviewFailure = 'gap';
    const waiting = await f.run(f.task, model);
    assert.equal(waiting.status, 'waiting_for_human');
    assert.equal(waiting.review?.delivery?.status, 'passed');
    assert.equal(waiting.review?.delivery?.upstreamReviewApproved, false);
    assert.equal(waiting.review?.approved, false);
    assert.ok(waiting.review?.gaps.includes('The review still has an unresolved gap.'));
    const queued = await f.store.updateTask(waiting.id, { status: 'queued' });
    const restored = await f.run(queued, model);
    assert.equal(restored.status, 'waiting_for_human', 'a cached final pass cannot bypass the unresolved upstream review on restart');
    assert.ok(restored.review?.gaps.includes('The review still has an unresolved gap.'));
    assert.equal((await f.store.getEvents(waiting.id)).some((event) => event.type === 'task.completed'), false);
    const beforeApprovalCalls = model.calls.length;
    const approved = await f.approve(restored);
    const approval = (await f.store.getEvents(approved.id)).filter((event) => event.type === 'review.approved').at(-1);
    assert.equal(approval?.payload.acceptedPartial, true, 'acceptance of unresolved upstream review must be explicitly partial');
    const completed = await f.run(approved, model);
    assert.equal(completed.status, 'completed', completed.error);
    assert.equal(completed.review?.delivery?.status, 'passed');
    assert.equal(completed.review?.delivery?.upstreamReviewApproved, false, 'human acceptance cannot rewrite the machine review outcome');
    assert.equal(model.calls.length, beforeApprovalCalls);
    assert.equal((await f.store.getEvents(completed.id)).find((event) => event.type === 'task.completed')?.payload.partial, true);
  } finally {
    if (previous.rounds === undefined) delete process.env.AGENT_REVIEW_CORRECTION_ROUNDS; else process.env.AGENT_REVIEW_CORRECTION_ROUNDS = previous.rounds;
    if (previous.approval === undefined) delete process.env.AGENT_REQUIRE_REVIEW_APPROVAL; else process.env.AGENT_REQUIRE_REVIEW_APPROVAL = previous.approval;
    await f.close();
  }
});
