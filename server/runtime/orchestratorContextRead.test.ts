import assert from 'node:assert/strict';
import test from 'node:test';
import pino from 'pino';
import { WorkflowOrchestrator } from './orchestrator.js';
import { SqliteTaskStore } from './sqliteTaskStore.js';
import { ToolRegistry } from './toolRegistry.js';
import { createContextReadTool } from './contextReadTool.js';
import { EventHub } from './eventHub.js';
import type { AgentStore, WorkflowStep } from './contracts.js';
import type { AgentMemory } from './memoryClient.js';
import type { ModelClient } from './modelClient.js';

const memory: AgentMemory = {
  async recall() { return { context: '', itemCount: 0, available: false, items: [], quality: { candidates: 0, expiredFiltered: 0, lowConfidenceFiltered: 0, byLayer: { L1: 0, L2: 0, L3: 0 } } }; },
  async capture(task) { return { capturedCount: 0, skipped: true, reason: 'disabled', cursor: task.updatedAt, contentDigest: '' }; },
};

const step = (role: string): WorkflowStep => ({ id: 'read-source', title: 'Read original source', role, objective: 'Retrieve the original limit from history before answering.', dependsOn: [], acceptanceCriteria: ['Quote the original limit'] });
const fixture = async (workflowStep: WorkflowStep | null, register = true, enabled = true) => {
  const previousExecutor = process.env.AXIOM_TOOL_EXECUTOR;
  process.env.AXIOM_TOOL_EXECUTOR = enabled ? 'docker' : 'disabled';
  const store = new SqliteTaskStore(':memory:');
  await store.initialize();
  let sandboxCalls = 0;
  const tools = new ToolRegistry({ execute: async () => { sandboxCalls += 1; throw new Error('Unexpected workspace execution'); } } as never);
  if (register) tools.register(createContextReadTool(store));
  const task = await store.createTask({
    tenantId: 'context-tenant', userId: 'context-owner', sessionId: 'context-session', title: 'Original limits',
    input: 'Compare the two alternatives and verify the original requirements before recommending a choice.', mode: 'decide',
    ...(workflowStep ? { plan: {
      summary: 'Verify original messages', routingReason: 'Use task-owned history', approvalStatus: 'approved' as const,
      profile: { kind: 'decision' as const, difficulty: 'moderate' as const, route: 'team' as const, score: 2, reasons: ['fixture'], maxSteps: 3, requiresReview: false },
      steps: [workflowStep],
    } } : {}),
  });
  await store.upsertSession(task.tenantId, task.userId, { id: task.sessionId, title: 'History', updatedAt: Date.now(), messages: [
    { id: 'original-limit', role: 'user', content: 'The original limit is 25 entries per export.', createdAt: Date.now() },
  ] });
  return { store, tools, task, sandboxCalls: () => sandboxCalls, close: async () => {
    await store.close();
    if (previousExecutor === undefined) delete process.env.AXIOM_TOOL_EXECUTOR;
    else process.env.AXIOM_TOOL_EXECUTOR = previousExecutor;
  } };
};

for (const role of ['analyst', 'researcher', 'reviewer']) test(`a built-in ${role} without toolNames reads original history through the real registry`, async () => {
  const f = await fixture(step(role));
  let decisions = 0;
  const model: ModelClient = { model: 'context-test', async complete(request) {
    if (request.system.includes('synthesizer')) return { content: 'The source says 25 entries per export.', attempts: 1, durationMs: 1 };
    decisions += 1;
    assert.deepEqual(request.tools?.map((tool) => tool.function.name), ['axiom_context_read']);
    if (decisions === 2) assert.match(request.user, /The original limit is 25 entries per export/);
    return { content: JSON.stringify({ output: 'Source-grounded answer', evidence: [], confidence: .8, toolCalls: decisions === 1 ? [{ name: 'context.read', args: { messageIds: ['original-limit'] } }] : [] }), attempts: 1, durationMs: 1 };
  } };
  try {
    const result = await new WorkflowOrchestrator(f.store, new EventHub(), model, memory, pino({ level: 'silent' }), f.tools).run(f.task, new AbortController().signal);
    assert.equal(result.status, 'completed', result.error ?? '');
    assert.equal(decisions, 2);
    assert.equal(result.stepResults[0]?.toolCalls?.[0]?.name, 'context.read');
    assert.equal(f.sandboxCalls(), 0);
    const spawned = (await f.store.getEvents(f.task.id)).find((event) => event.type === 'agent.spawned' && event.payload.stepId === 'read-source');
    assert.deepEqual(spawned?.payload.toolNames, ['context.read']);
  } finally { await f.close(); }
});

test('the Planner advertises and persists the same default source tool available at execution', async () => {
  const f = await fixture(null);
  let planned = false;
  const decisions = new Map<string, number>();
  const model: ModelClient = { model: 'context-test', async complete(request) {
    if (request.system.includes('planner in a production')) {
      planned = true;
      assert.match(request.system, /context\.read to retrieve original messages/);
      return { content: JSON.stringify({ summary: 'Ground the comparison', routingReason: 'Use independent research and analysis', steps: ['researcher', 'analyst'].map((role) => ({ ...step(role), id: role })) }), attempts: 1, durationMs: 1 };
    }
    if (request.system.includes('independent reviewer')) return { content: JSON.stringify({ approved: true, score: 100, summary: 'Sources are traceable', gaps: [], requiredCorrections: [] }), attempts: 1, durationMs: 1 };
    if (request.system.includes('synthesizer')) return { content: 'Source-grounded comparison.', attempts: 1, durationMs: 1 };
    const role = request.system.match(/^You are a (\w+)/)?.[1] ?? 'unknown';
    const round = (decisions.get(role) ?? 0) + 1;
    decisions.set(role, round);
    assert.deepEqual(request.tools?.map((tool) => tool.function.name), ['axiom_context_read']);
    if (round === 2) assert.match(request.user, /The original limit is 25 entries per export/);
    return { content: JSON.stringify({ output: 'Original requirement confirmed', evidence: [], confidence: .9, toolCalls: round === 1 ? [{ name: 'context.read', args: { messageIds: ['original-limit'] } }] : [] }), attempts: 1, durationMs: 1 };
  } };
  try {
    const result = await new WorkflowOrchestrator(f.store, new EventHub(), model, memory, pino({ level: 'silent' }), f.tools).run(f.task, new AbortController().signal);
    assert.equal(planned, true);
    assert.equal(result.status, 'completed', result.error ?? '');
    assert.deepEqual([...decisions], [['researcher', 2], ['analyst', 2]]);
    assert.ok(result.plan?.steps.every((item) => JSON.stringify(item.toolNames) === JSON.stringify(['context.read'])));
    assert.equal(f.sandboxCalls(), 0);
  } finally { await f.close(); }
});

test('default source access does not enable a non-Builder workspace allowlist', async () => {
  const f = await fixture({ ...step('analyst'), toolNames: ['workspace.read'] });
  let decisions = 0;
  const model: ModelClient = { model: 'context-test', async complete(request) {
    if (request.system.includes('synthesizer')) return { content: 'Only the historical source was used.', attempts: 1, durationMs: 1 };
    decisions += 1;
    assert.deepEqual(request.tools?.map((tool) => tool.function.name), ['axiom_context_read']);
    return { content: JSON.stringify({ output: 'Use bounded context', evidence: [], confidence: .8, toolCalls: decisions === 1 ? [{ name: 'workspace.read', args: { path: 'README.md' } }, { name: 'context.read', args: { messageIds: ['original-limit'] } }] : [] }), attempts: 1, durationMs: 1 };
  } };
  try {
    const result = await new WorkflowOrchestrator(f.store, new EventHub(), model, memory, pino({ level: 'silent' }), f.tools).run(f.task, new AbortController().signal);
    assert.equal(result.status, 'completed', result.error ?? '');
    assert.equal(f.sandboxCalls(), 0);
    const events = await f.store.getEvents(f.task.id);
    assert.ok(events.some((event) => event.type === 'tool.failed' && event.payload.name === 'workspace.read'));
    assert.ok(events.some((event) => event.type === 'tool.completed' && event.payload.name === 'context.read'));
  } finally { await f.close(); }
});

for (const boundary of ['nexus', 'custom', 'not-registered', 'disabled'] as const) test(`default context.read respects the ${boundary} boundary`, async () => {
  const role = boundary === 'custom' ? 'custom-reader' : 'analyst';
  const workflowStep = { ...step(role), ...(boundary === 'nexus' ? { agentContract: { source: 'builtin' as const, agentId: 'analyst', displayName: 'Nexus analyst', toolAllowlist: [] } } : {}) };
  const f = await fixture(workflowStep, boundary !== 'not-registered', boundary !== 'disabled');
  const agents = boundary === 'custom' ? { listAgents: async () => [{ id: 'custom-id', roleId: role, status: 'published', name: 'Custom reader', definition: { toolAllowlist: [], systemPromptTemplate: 'Read only what is supplied', memoryRecall: false } }] } as unknown as AgentStore : undefined;
  let decisions = 0;
  const offeredTools: string[][] = [];
  const model: ModelClient = { model: 'context-test', async complete(request) {
    if (request.system.includes('synthesizer')) return { content: 'No original-source tool was available.', attempts: 1, durationMs: 1 };
    decisions += 1;
    offeredTools.push(request.tools?.map((tool) => tool.function.name) ?? []);
    return { content: JSON.stringify({ output: 'No source access', evidence: [], confidence: .5, toolCalls: decisions === 1 ? [{ name: 'context.read', args: { messageIds: ['original-limit'] } }] : [] }), attempts: 1, durationMs: 1 };
  } };
  try {
    await new WorkflowOrchestrator(f.store, new EventHub(), model, memory, pino({ level: 'silent' }), f.tools, agents).run(f.task, new AbortController().signal);
    assert.equal(decisions, 2);
    assert.deepEqual(offeredTools, [[], []]);
    assert.equal(f.sandboxCalls(), 0);
    assert.equal((await f.store.getEvents(f.task.id)).some((event) => event.type === 'tool.completed'), false);
  } finally { await f.close(); }
});

test('the default Builder catalogue still contains its existing tools and the registered source reader', async () => {
  const f = await fixture(step('builder'));
  let offeredTools: string[] = [];
  const model: ModelClient = { model: 'context-test', async complete(request) {
    if (request.system.includes('synthesizer')) return { content: 'No operation was needed.', attempts: 1, durationMs: 1 };
    offeredTools = request.tools?.map((tool) => tool.function.name) ?? [];
    return { content: JSON.stringify({ output: 'Existing Builder permissions preserved', evidence: [], confidence: .8, toolCalls: [] }), attempts: 1, durationMs: 1 };
  } };
  try {
    const result = await new WorkflowOrchestrator(f.store, new EventHub(), model, memory, pino({ level: 'silent' }), f.tools).run(f.task, new AbortController().signal);
    assert.equal(result.status, 'completed', result.error ?? '');
    assert.ok(offeredTools.includes('axiom_context_read'));
    assert.ok(offeredTools.includes('axiom_workspace_read'));
    assert.equal(offeredTools.length, Math.min(24, f.tools.catalog().length));
    assert.equal(f.sandboxCalls(), 0);
  } finally { await f.close(); }
});
