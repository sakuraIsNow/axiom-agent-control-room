import assert from 'node:assert/strict';
import test from 'node:test';
import pino from 'pino';
import { z } from 'zod';
import { WorkflowOrchestrator } from './orchestrator.js';
import { SqliteTaskStore } from './sqliteTaskStore.js';
import { SqliteToolExecutionStore } from './toolExecutionStore.js';
import { ToolRegistry } from './toolRegistry.js';
import { EventHub } from './eventHub.js';
import { createContextReadTool } from './contextReadTool.js';
import type { AgentMemory } from './memoryClient.js';
import type { ModelClient, ModelCompletionRequest } from './modelClient.js';
import { runAgentToolLoop, toolLoopScope, type AgentToolLoopRecord } from './agentToolLoop.js';

const memory: AgentMemory = {
  async recall() { return { context: '', itemCount: 0, available: false, items: [], quality: { candidates: 0, expiredFiltered: 0, lowConfidenceFiltered: 0, byLayer: { L1: 0, L2: 0, L3: 0 } } }; },
  async capture(task) { return { capturedCount: 0, skipped: true, reason: 'disabled', cursor: task.updatedAt, contentDigest: '' }; },
};

const fixture = async () => {
  const store = new SqliteTaskStore(':memory:');
  const ledger = new SqliteToolExecutionStore(':memory:');
  await store.initialize();
  await ledger.initialize();
  const previousExecutor = process.env.AXIOM_TOOL_EXECUTOR;
  process.env.AXIOM_TOOL_EXECUTOR = 'docker';
  const tools = new ToolRegistry(undefined, undefined, undefined, undefined, ledger);
  const task = await store.createTask({ tenantId: 'loop-tenant', userId: 'loop-user', sessionId: 'loop-session', title: 'Loop', input: 'Inspect the next item and produce a bounded result.', mode: 'build', plan: {
    summary: 'Use actual observations', routingReason: 'Fixture', approvalStatus: 'approved',
    profile: { kind: 'implementation', difficulty: 'moderate', route: 'team', score: 2, reasons: ['fixture'], maxSteps: 2, requiresReview: false },
    steps: [{ id: 'work', title: 'Inspect', role: 'builder', objective: 'Inspect real tool results before choosing another action.', dependsOn: [], toolNames: ['fixture.action'], acceptanceCriteria: ['Use observed result'] }],
  } });
  const close = async () => { await store.close(); await ledger.close(); if (previousExecutor === undefined) delete process.env.AXIOM_TOOL_EXECUTOR; else process.env.AXIOM_TOOL_EXECUTOR = previousExecutor; };
  return { store, ledger, tools, task, close };
};

const register = (tools: ToolRegistry, handler: (key: string) => Promise<string>, write = false) => tools.register({
  name: 'fixture.action', description: 'Bounded fixture operation', risk: 'low', sideEffect: write ? 'write' : 'read-only', executionBoundary: 'host-bounded', timeoutMs: 1_000,
  parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'], additionalProperties: false }, schema: z.object({ key: z.string() }).strict(),
  handler: async (args, context) => ({ stdout: await handler(String(args.key)), stderr: '', exitCode: 0, durationMs: 1, auditId: context.auditId }),
});

test('an Analyst explicitly assigned context.read can retrieve original text without receiving unrelated tools', async () => {
  const f = await fixture();
  let decisions = 0;
  f.tools.register(createContextReadTool(f.store));
  const model: ModelClient = { model: 'fixture', async complete(request) {
    if (request.system.includes('synthesizer')) return { content: 'Source-grounded result', attempts: 1, durationMs: 1 };
    decisions += 1;
    assert.deepEqual(request.tools?.map((tool) => tool.function.name), ['axiom_context_read']);
    if (decisions === 2) assert.match(request.user, /The original limit was 25 items/);
    return { content: JSON.stringify({ output: 'Used original source', evidence: [], confidence: .8, toolCalls: decisions === 1 ? [{ name: 'context.read', args: { messageIds: ['original'] } }] : [] }), attempts: 1, durationMs: 1 };
  } };
  try {
    await f.store.upsertSession(f.task.tenantId, f.task.userId, { id: f.task.sessionId, title: 'Sources', updatedAt: Date.now(), messages: [{ id: 'original', role: 'user', content: 'The original limit was 25 items', createdAt: Date.now() }] });
    const task = await f.store.updateTask(f.task.id, { plan: { ...f.task.plan!, steps: [{ ...f.task.plan!.steps[0]!, role: 'analyst', toolNames: ['context.read'] }] } });
    const result = await new WorkflowOrchestrator(f.store, new EventHub(), model, memory, pino({ level: 'silent' }), f.tools).run(task, new AbortController().signal);
    assert.equal(result.status, 'completed', result.error ?? '');
    assert.equal(decisions, 2);
    assert.equal(result.stepResults[0]?.toolCalls?.[0]?.name, 'context.read');
  } finally { await f.close(); }
});

test('a truncated Agent response is partial and cannot dispatch its unfinished tool requests', async () => {
  const f = await fixture();
  let effects = 0;
  register(f.tools, async () => { effects += 1; return 'Should not be called'; }, true);
  const model: ModelClient = { model: 'fixture', async complete(request) {
    if (request.system.includes('synthesizer')) return { content: 'Partial result: the Agent response was truncated.', attempts: 1, durationMs: 1 };
    return { content: JSON.stringify({ output: 'A partial plan', evidence: [], confidence: .8, toolCalls: [{ name: 'fixture.action', args: { key: 'write' } }] }), finishReason: 'length', attempts: 1, durationMs: 1 };
  } };
  try {
    const result = await new WorkflowOrchestrator(f.store, new EventHub(), model, memory, pino({ level: 'silent' }), f.tools).run(f.task, new AbortController().signal);
    assert.equal(effects, 0);
    assert.equal(result.stepResults[0]?.handoff?.status, 'partial');
    const completed = (await f.store.getEvents(f.task.id)).find((event) => event.type === 'task.completed');
    assert.equal(completed?.payload.partial, true);
    assert.equal((completed?.payload.evidenceSummary as { execution: string }).execution, 'partial');
  } finally { await f.close(); }
});

test('orchestrator selects multiple dependent tool rounds, records real receipts and measured usage', async () => {
  const f = await fixture();
  const calls: string[] = [];
  let decisions = 0;
  register(f.tools, async (key) => { calls.push(key); return key === 'first' ? 'next-key-42' : 'actual final tool result'; });
  const model: ModelClient = { model: 'fixture', async complete(request: ModelCompletionRequest) {
    if (request.system.includes('synthesizer')) return { content: 'Delivered the actual result', attempts: 1, durationMs: 1 };
    decisions += 1;
    if (decisions === 2) assert.match(request.user, /next-key-42/);
    if (decisions === 3) assert.match(request.user, /actual final tool result/);
    return { content: JSON.stringify({ output: decisions < 3 ? 'Working' : 'Actual result delivered', evidence: [], confidence: .8, toolCalls: decisions < 3 ? [{ name: 'fixture.action', args: { key: decisions === 1 ? 'first' : 'next-key-42' } }] : [] }), attempts: 1, durationMs: 1, usage: { total_tokens: 25 } };
  } };
  try {
    const result = await new WorkflowOrchestrator(f.store, new EventHub(), model, memory, pino({ level: 'silent' }), f.tools).run(f.task, new AbortController().signal);
    assert.equal(result.status, 'completed', result.error ?? '');
    assert.deepEqual(calls, ['first', 'next-key-42']);
    assert.equal(decisions, 3);
    assert.equal(result.stepResults[0]?.tokens, 75);
    assert.equal((await f.ledger.listForTask(f.task.tenantId, f.task.id)).length, 2);
    const journal = (await f.store.getEvents(f.task.id)).filter((event) => event.type === 'agent.tool_loop');
    assert.deepEqual(journal.map((event) => event.payload.phase), ['decision', 'observation', 'decision', 'observation', 'decision', 'completed']);
    assert.ok(result.stepResults[0]?.evidenceDetails?.every((item) => item.verification !== 'verified'));
  } finally { await f.close(); }
});

test('crash between durable receipt and Agent observation replays without repeating the external effect', async () => {
  const f = await fixture();
  let effects = 0;
  let crash = true;
  register(f.tools, async () => { effects += 1; return 'written once'; }, true);
  const history: AgentToolLoopRecord[] = [];
  const options = {
    scope: 'crash-scope', history, signal: new AbortController().signal, assertActive: async () => {},
    decide: async ({ round }: { round: number }) => ({ decision: { output: 'result', toolCalls: round === 1 ? [{ name: 'fixture.action', args: { key: 'write' } }] : [] }, tokens: 10, attempts: 1 }),
    execute: async (invocation: { name: string; args: Record<string, unknown> }, invocationId: string) => ({ execution: await f.tools.execute(f.task, 'work', invocation, { invocationId }) }),
    persist: async (record: AgentToolLoopRecord) => { if (record.phase === 'observation' && crash) { crash = false; throw new Error('Worker died before observation commit'); } history.push(structuredClone(record)); },
  };
  try {
    await assert.rejects(runAgentToolLoop(options), /Worker died/);
    assert.equal(effects, 1);
    const restored = await runAgentToolLoop({ ...options, history: structuredClone(history) });
    assert.equal(effects, 1);
    assert.equal(restored.observations[0]?.execution?.replayed, true);
    const intentionalRerun = await runAgentToolLoop({ ...options, scope: 'explicit-rerun', history: [] });
    assert.equal(effects, 2);
    assert.equal(intentionalRerun.stopReason, undefined);
  } finally { await f.close(); }
});

test('unknown write outcomes stop the workflow until reviewed and confirmed results are not factual evidence', async () => {
  const f = await fixture();
  let effects = 0;
  let decisions = 0;
  register(f.tools, async () => { effects += 1; throw new Error('Connection lost after dispatch'); }, true);
  const model: ModelClient = { model: 'fixture', async complete(request) {
    if (request.system.includes('synthesizer')) return { content: 'The operator confirmed completion.', attempts: 1, durationMs: 1 };
    decisions += 1;
    return { content: JSON.stringify({ output: 'Operator-confirmed outcome', evidence: [], confidence: .8, toolCalls: decisions === 1 ? [{ name: 'fixture.action', args: { key: 'write' } }] : [] }), attempts: 1, durationMs: 1 };
  } };
  const orchestrator = new WorkflowOrchestrator(f.store, new EventHub(), model, memory, pino({ level: 'silent' }), f.tools);
  try {
    const waiting = await orchestrator.run(f.task, new AbortController().signal);
    assert.equal(waiting.status, 'waiting_for_human', waiting.error ?? '');
    assert.equal(effects, 1);
    assert.equal(waiting.stepResults.length, 0);
    const record = (await f.ledger.listForTask(f.task.tenantId, f.task.id))[0]!;
    assert.equal(record.status, 'outcome_unknown');
    const resolved = await f.tools.resolveExecutionUnknown({ tenantId: f.task.tenantId, id: record.id, expectedRevision: record.revision, decision: 'confirmed-completed', note: 'Checked the actual destination', operatorId: f.task.userId });
    assert.ok(resolved);
    const resumed = await f.store.updateTask(f.task.id, { status: 'queued' });
    const completed = await orchestrator.run(resumed, new AbortController().signal);
    assert.equal(completed.status, 'completed', completed.error ?? '');
    assert.equal(effects, 1);
    assert.equal(decisions, 2, 'Restoration reuses the decision before the interrupted call');
    assert.equal(completed.stepResults[0]?.tokens, undefined, 'Estimated budget is not measured token usage');
    assert.ok(completed.stepResults[0]?.evidenceDetails?.every((item) => item.verification === 'unverified'));
  } finally { await f.close(); }
});

test('parallel Agent approval requests merge durably without losing either request', async () => {
  const f = await fixture();
  let effects = 0;
  f.tools.register({ name: 'fixture.action', description: 'Approved write', risk: 'high', sideEffect: 'write', executionBoundary: 'host-bounded', timeoutMs: 1_000,
    parameters: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'], additionalProperties: false }, schema: z.object({ key: z.string() }),
    handler: async (_args, context) => { effects += 1; return { stdout: 'ok', stderr: '', exitCode: 0, durationMs: 1, auditId: context.auditId }; },
  });
  const model: ModelClient = { model: 'fixture', async complete(request) {
    const content = JSON.stringify({ output: 'Approval needed', evidence: [], confidence: .8, toolCalls: [{ name: 'fixture.action', args: { key: request.user.includes('Unique objective B') ? 'b' : 'a' } }] });
    return { content, attempts: 1, durationMs: 1 };
  } };
  try {
    const plan = f.task.plan!;
    const task = await f.store.updateTask(f.task.id, { plan: { ...plan, steps: [
      { ...plan.steps[0]!, id: 'work-a', objective: 'Unique objective A', writeScopes: ['a'] },
      { ...plan.steps[0]!, id: 'work-b', objective: 'Unique objective B', writeScopes: ['b'] },
    ] } });
    const waiting = await new WorkflowOrchestrator(f.store, new EventHub(), model, memory, pino({ level: 'silent' }), f.tools).run(task, new AbortController().signal);
    assert.equal(waiting.status, 'waiting_for_human');
    assert.equal(effects, 0);
    assert.deepEqual(waiting.toolApprovals?.map((approval) => approval.stepId).sort(), ['work-a', 'work-b']);
    assert.equal((await f.store.getEvents(task.id)).filter((event) => event.type === 'tool.approval_requested').length, 2);
  } finally { await f.close(); }
});

test('schema-default drift after a durable write stops recovery without another decision or side effect', async () => {
  const f = await fixture();
  let effects = 0;
  let decisions = 0;
  const definition = (defaultKey: string) => ({
    name: 'fixture.action', description: 'Write with a versioned default', risk: 'low' as const, sideEffect: 'write' as const,
    executionBoundary: 'host-bounded' as const, timeoutMs: 1_000,
    parameters: { type: 'object' as const, properties: { key: { type: 'string' as const } }, required: [], additionalProperties: false },
    schema: z.object({ key: z.string().default(defaultKey) }).strict(),
    handler: async () => { effects += 1; return { stdout: `written-${defaultKey}`, stderr: '', exitCode: 0, durationMs: 1, auditId: `receipt-${effects}` }; },
  });
  const model: ModelClient = { model: 'fixture', async complete() {
    decisions += 1;
    return { content: JSON.stringify({ output: 'Attempted automatic correction', evidence: [], confidence: .8,
      toolCalls: [{ name: 'fixture.action', args: { key: 'changed' } }] }), attempts: 1, durationMs: 1 };
  } };
  try {
    f.tools.upsert(definition('original'));
    const step = f.task.plan!.steps[0]!;
    const scope = toolLoopScope(f.task.runId, { id: step.id, objective: step.objective, role: step.role, contract: step.agentContract, toolNames: step.toolNames }, 0);
    const invocation = { name: 'fixture.action', args: {} };
    await f.store.appendEvent(f.task, { type: 'agent.tool_loop', agentId: 'builder-work', payload: {
      version: 1, scope, round: 1, phase: 'decision', tokens: 10, attempts: 1, stepId: step.id,
      decision: { output: 'Execute the requested write', evidence: [], confidence: .8, toolCalls: [invocation] },
    } });
    await f.tools.execute(f.task, step.id, invocation, { invocationId: `${scope}:1:0` });
    assert.equal(effects, 1);
    // Recovery starts after the tool receipt, before the observation journal.
    f.tools.upsert(definition('changed'));
    const result = await new WorkflowOrchestrator(f.store, new EventHub(), model, memory, pino({ level: 'silent' }), f.tools).run(f.task, new AbortController().signal);
    assert.equal(result.status, 'failed');
    assert.equal(effects, 1);
    assert.equal(decisions, 0, 'a binding conflict must not invite the model to produce a fresh invocation');
    const records = await f.ledger.listForTask(f.task.tenantId, f.task.id);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.status, 'completed', 'the confirmed original write must not become an unknown outcome');
    assert.equal(records[0]?.receipt?.output, 'written-original');
    assert.equal((await f.store.getEvents(f.task.id)).filter((event) => event.type === 'agent.tool_loop' && event.payload.phase === 'decision').length, 1);
  } finally { await f.close(); }
});
