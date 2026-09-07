import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import pino from 'pino';
import { createTaskApi } from './taskApi.js';
import { SqliteTaskStore } from './sqliteTaskStore.js';
import { SqliteTemplateStore } from './templateStore.js';
import { EventHub } from './eventHub.js';
import { FileArtifactStore } from './artifactStore.js';
import { SqliteArtifactCatalog } from './artifactCatalog.js';
import { fallbackChatRoute } from './chatRouter.js';
import { WorkflowOrchestrator } from './orchestrator.js';
import type { AgentMemory } from './memoryClient.js';
import type { ModelClient, ModelCompletionRequest } from './modelClient.js';
import type { WorkflowTask } from './contracts.js';
import type { PersistedContextSummary } from './contextSummary.js';
import { buildSourceContextWindow } from './conversationContextService.js';
import { createContextReadTool } from './contextReadTool.js';
import { ToolRegistry } from './toolRegistry.js';
import { loadTaskInputAttachments } from './taskInputAttachments.js';

const headers = { 'content-type': 'application/json', 'x-axiom-tenant-id': 'context-tenant', 'x-axiom-user-id': 'context-owner' };
const request = (api: ReturnType<typeof createTaskApi>, path: string, body?: unknown, method = 'POST', requestHeaders = headers) => api.request(new Request(`http://context.test${path}`, { method, headers: requestHeaders, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
class ContextModel implements ModelClient {
  readonly model = 'context-extraction-fixture';
  extractionCalls = 0;
  documentInput = '';
  async complete(input: ModelCompletionRequest) {
    let content: string;
    if (input.system.includes('Extract durable USER')) {
      this.extractionCalls += 1;
      const data = JSON.parse(input.user) as { existingEntries: Array<{ id: string; status: string }>; messages: Array<{ id: string; role: string; content: string }> };
      const operations = data.messages.flatMap((message): unknown[] => {
        if (message.role !== 'user') return [];
        const source = { messageId: message.id, quote: message.content };
        if (message.content === 'Keep deployment offline.') return [{ action: 'add', id: 'offline', kind: 'constraint', text: message.content, source }];
        if (message.content === 'Replace the offline requirement: allow only audit-server requests.') return [{ action: 'replace', targetId: data.existingEntries.find((entry) => entry.status === 'active')?.id ?? 'offline', kind: 'constraint', text: 'Only audit-server requests are allowed.', source }];
        if (message.content === 'Cancel the audit-server exception.') return [{ action: 'revoke', targetId: data.existingEntries.find((entry) => entry.status === 'active')?.id, source }];
        return [];
      });
      content = JSON.stringify({ operations });
    } else if (input.system.includes('文档分析 Agent')) {
      this.documentInput = input.user;
      content = 'The source document requires 37 retained records.';
    } else if (input.system.includes('synthesizer')) content = 'The image and document have both been analyzed.';
    else content = JSON.stringify({ approved: true, score: 95, summary: 'Complete.', gaps: [], requiredCorrections: [] });
    return { content, attempts: 1, durationMs: 1 };
  }
}
const memory: AgentMemory = {
  async recall() { return { context: '', itemCount: 0, available: false, items: [], quality: { candidates: 0, expiredFiltered: 0, lowConfidenceFiltered: 0, byLayer: { L1: 0, L2: 0, L3: 0 } } }; },
  async capture(task) { return { capturedCount: 0, skipped: true, reason: 'disabled', cursor: task.updatedAt, contentDigest: '' }; },
};

test('session summaries retain structured replacements across compactions and database restarts with owner-scoped sources', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'axiom-context-api-'));
  let store = new SqliteTaskStore(join(directory, 'tasks.sqlite'));
  await store.initialize();
  const model = new ContextModel();
  const api = createTaskApi({ store, hub: new EventHub(), coordinator: { nudge() {}, abort() {} } as never, model: model as never, artifactStore: null });
  const messages = Array.from({ length: 20 }, (_, index) => ({ id: `u${index}`, role: index % 2 && index !== 19 ? 'assistant' as const : 'user' as const, content: index === 0 ? 'Keep deployment offline.' : `Earlier discussion ${index}.`, createdAt: index + 1 }));
  const save = async (updatedAt: number) => {
    const callsBeforeSave = model.extractionCalls;
    const response = await request(api, '/sessions/regular-context', { id: 'regular-context', title: 'Context retention', messages, updatedAt }, 'PUT');
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(model.extractionCalls, callsBeforeSave, 'Saving history must never call a model.');
    const task = await request(api, '/tasks', { sessionId: 'regular-context', input: messages.at(-1)!.content, mode: 'analyze', contextMessages: messages });
    assert.equal(task.status, 202, await task.clone().text());
    const retained = await request(api, '/sessions/regular-context', { id: 'regular-context', title: 'Context retention', messages, updatedAt }, 'PUT');
    return (await retained.json() as { session: { contextSummary: PersistedContextSummary } }).session.contextSummary;
  };
  try {
    const first = await save(20);
    assert.equal(first.structuredContext?.entries[0]?.status, 'active');
    await save(21);
    assert.equal(model.extractionCalls, 1);
    messages.push(...Array.from({ length: 16 }, (_, index) => ({ id: `u${20 + index}`, role: index % 2 && index !== 15 ? 'assistant' as const : 'user' as const, content: index === 0 ? 'Replace the offline requirement: allow only audit-server requests.' : `New discussion ${index}.`, createdAt: 21 + index })));
    const second = await save(40);
    assert.deepEqual(second.structuredContext?.entries.map((entry) => entry.status), ['superseded', 'active']);
    messages.push(...Array.from({ length: 16 }, (_, index) => ({ id: `u${36 + index}`, role: index % 2 && index !== 15 ? 'assistant' as const : 'user' as const, content: index === 0 ? 'Cancel the audit-server exception.' : `Latest discussion ${index}.`, createdAt: 41 + index })));
    const third = await save(60);
    assert.deepEqual(third.structuredContext?.entries.map((entry) => entry.status), ['superseded', 'revoked']);
    await store.close();
    store = new SqliteTaskStore(join(directory, 'tasks.sqlite'));
    await store.initialize();
    const restored = await store.getSession('regular-context', 'context-tenant', 'context-owner');
    assert.deepEqual(restored?.contextSummary?.structuredContext, third.structuredContext);
    assert.equal(restored?.messages[0]?.content, 'Keep deployment offline.');
    const reopenedApi = createTaskApi({ store, hub: new EventHub(), coordinator: { nudge() {}, abort() {} } as never, model: model as never, artifactStore: null });
    const sources = await request(reopenedApi, '/sessions/regular-context/context-sources', { directiveIds: [third.structuredContext!.entries[1]!.id] });
    assert.deepEqual((await sources.json() as { sources: Array<{ messageId: string }> }).sources.map((item) => item.messageId), ['u20', 'u36']);
    const denied = await request(reopenedApi, '/sessions/regular-context/context-sources', { query: 'offline' }, 'POST', { ...headers, 'x-axiom-user-id': 'someone-else' });
    assert.equal(denied.status, 404);
    const window = buildSourceContextWindow(restored!.messages, restored!.contextSummary, { maxTokens: 512, maxCharacters: 2_000 });
    assert.ok(window.estimatedTokens <= 512);
    assert.ok(window.messages.reduce((total, message) => total + String(message.content).length, 0) <= 2_000);
    assert.equal(window.messages.at(-1)?.content, messages.at(-1)?.content);
  } finally {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('Nexus compaction reconstructs complete owned task history and stays out of ordinary conversations', async () => {
  const store = new SqliteTaskStore(':memory:');
  const templates = new SqliteTemplateStore(':memory:');
  await store.initialize();
  await templates.initialize();
  const model = new ContextModel();
  try {
    const definition = {
      kind: 'agent-workflow' as const, mode: 'analyze' as const, policy: { requirePlanApproval: false }, agentIds: ['analyst'], toolNames: [],
      workflow: { schemaVersion: 1 as const, nodes: [], edges: [], scopedAgents: [] },
      plan: { summary: 'Fixed Nexus', routingReason: 'Manual workflow', steps: [{ id: 'analyze', title: 'Analyze', role: 'analyst' as const, objective: 'Analyze user input.', dependsOn: [], acceptanceCriteria: ['Cover the user goal.'] }], approvalStatus: 'approved' as const },
    };
    const template = await templates.createTemplate({ tenantId: 'context-tenant', createdBy: 'context-owner', name: 'Private Nexus', description: '', visibility: 'team', definition });
    await templates.updateTemplate(template.id, 'context-tenant', { status: 'published', updatedBy: 'context-owner' });
    for (let index = 0; index < 12; index += 1) {
      const task = await store.createTask({ tenantId: 'context-tenant', userId: 'context-owner', sessionId: `agent-nexus-${template.id}`, templateId: template.id, title: 'Nexus history', input: `Old compressed input ${index}`, mode: 'analyze' });
      await store.appendEvent(task, { type: 'task.created', payload: { originalTurn: { id: `nexus-u${index}`, role: 'user', content: index === 0 ? 'Keep deployment offline.' : `Raw Nexus turn ${index}` } } });
      await store.updateTask(task.id, { status: 'completed', result: `Nexus answer ${index}` });
    }
    for (let index = 0; index < 105; index += 1) await store.createTask({ tenantId: 'context-tenant', userId: 'other-owner', sessionId: `noise-${index}`, title: `Unrelated ${index}`, input: 'Unrelated input', mode: 'analyze' });
    const api = createTaskApi({ store, templates, model: model as never, hub: new EventHub(), coordinator: { nudge() {}, abort() {} } as never, artifactStore: null });
    const response = await request(api, `/workflows/${template.id}/run`, { sessionId: `agent-nexus-${template.id}`, input: 'Client compacted preview.', conversationTurn: { id: 'nexus-current', role: 'user', content: 'Continue with the accepted requirements.' } });
    assert.equal(response.status, 202, await response.clone().text());
    const task = (await response.json() as { task: WorkflowTask }).task;
    assert.match(task.input, /Keep deployment offline/);
    assert.match(task.input, /Source-linked user constraints/);
    assert.doesNotMatch(task.input, /Client compacted preview/);
    const created = (await store.getEvents(task.id)).find((event) => event.type === 'task.created');
    assert.equal((created?.payload.contextSummary as PersistedContextSummary).structuredContext?.entries[0]?.source.messageId, 'nexus-u0');
    const history = await request(api, `/workflows/${template.id}/history`, undefined, 'GET');
    assert.equal((await history.json() as { messages: unknown[] }).messages.length, 25);
    const otherHistory = await request(api, `/workflows/${template.id}/history`, undefined, 'GET', { ...headers, 'x-axiom-user-id': 'other-owner' });
    assert.deepEqual((await otherHistory.json() as { messages: unknown[] }).messages, []);
    const sources = await request(api, `/workflows/${template.id}/context-sources`, { messageIds: ['nexus-u0'] });
    assert.equal((await sources.json() as { sources: Array<{ content: string }> }).sources[0]?.content, 'Keep deployment offline.');
    await store.updateTask(task.id, { status: 'cancelled', policy: { ...task.policy, requirePlanApproval: true, maxTokens: 4_321 } });
    const retryResponse = await request(api, `/tasks/${task.id}/retry`);
    assert.equal(retryResponse.status, 202, await retryResponse.clone().text());
    const retried = (await retryResponse.json() as { task: WorkflowTask }).task;
    assert.equal(retried.templateId, template.id);
    assert.equal(retried.plan?.approvalStatus, 'pending');
    assert.equal(retried.plan?.approvedAt, undefined);
    assert.equal(retried.policy.maxTokens, 4_321);
    assert.deepEqual(retried.plan?.steps, task.plan?.steps);
    const retryCreated = (await store.getEvents(retried.id)).find((event) => event.type === 'task.created');
    assert.deepEqual(retryCreated?.payload.contextSummary, created?.payload.contextSummary);
    assert.deepEqual(retryCreated?.payload.originalTurn, created?.payload.originalTurn);
    assert.equal(retryCreated?.payload.workflowVersion, created?.payload.workflowVersion);
    const retriedHistory = await request(api, `/workflows/${template.id}/history`, undefined, 'GET');
    assert.equal((await retriedHistory.json() as { messages: Array<{ id: string }> }).messages.filter((message) => message.id === 'nexus-current').length, 1);
    const tools = new ToolRegistry({ execute: async () => { throw new Error('Context lookup must not use the shell.'); } } as never);
    tools.upsert(createContextReadTool(store));
    const previousExecutor = process.env.AXIOM_TOOL_EXECUTOR;
    process.env.AXIOM_TOOL_EXECUTOR = 'docker';
    try {
      const read = await tools.execute(task, 'analyze', { name: 'context.read', args: { messageIds: ['nexus-u0'] } });
      assert.equal(JSON.parse(read.output).sources[0].content, 'Keep deployment offline.');
      assert.equal(read.exitCode, 0);
      const forged = await tools.execute({ ...task, userId: 'other-owner' }, 'analyze', { name: 'context.read', args: { messageIds: ['nexus-u0'] } });
      assert.notEqual(forged.exitCode, 0);
      assert.doesNotMatch(forged.output, /Keep deployment offline/);
    } finally {
      if (previousExecutor === undefined) delete process.env.AXIOM_TOOL_EXECUTOR;
      else process.env.AXIOM_TOOL_EXECUTOR = previousExecutor;
    }
    const sessions = await request(api, '/sessions', undefined, 'GET');
    assert.equal((await sessions.json() as { sessions: Array<{ id: string }> }).sessions.some((session) => session.id.startsWith('agent-nexus-')), false);
    assert.deepEqual(await store.listSessions('context-tenant', 'context-owner', 100), []);
  } finally {
    await templates.close();
    await store.close();
  }
});

test('ordinary mixed-attachment workflow delivers saved exact-turn bytes to real vision and document specialists', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'axiom-composite-execution-'));
  const store = new SqliteTaskStore(join(directory, 'tasks.sqlite'));
  await store.initialize();
  const artifacts = new FileArtifactStore(join(directory, 'artifacts'));
  const artifactCatalog = new SqliteArtifactCatalog(join(directory, 'tasks.sqlite'));
  await artifactCatalog.initialize();
  const model = new ContextModel();
  const originalFetch = globalThis.fetch;
  const keys = ['DEEPSEEK_VISION_API_KEY', 'DEEPSEEK_VISION_API_BASE', 'DEEPSEEK_VISION_MODEL', 'DEEPSEEK_FILES_API'];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  let visualRequest: Array<{ type?: string; image_url?: { url?: string } }> = [];
  const imageUrl = `data:image/png;base64,${Buffer.from('exact-turn-image').toString('base64')}`;
  try {
    process.env.DEEPSEEK_VISION_API_KEY = 'test-only';
    process.env.DEEPSEEK_VISION_API_BASE = 'https://vision.test/v1';
    process.env.DEEPSEEK_VISION_MODEL = 'fixture-vision';
    process.env.DEEPSEEK_FILES_API = 'false';
    globalThis.fetch = async (_url, init) => {
      visualRequest = (JSON.parse(String(init?.body)) as { messages: Array<{ content: typeof visualRequest }> }).messages[1]!.content;
      return new Response(JSON.stringify({ choices: [{ message: { content: 'The supplied image contains a source marker.' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const api = createTaskApi({ store, model: model as never, artifactStore: artifacts, artifactCatalog, hub: new EventHub(), coordinator: { nudge() {}, abort() {} } as never });
    const routing = fallbackChatRoute({ message: 'Compare these inputs.', mode: 'analyze', attachments: [{ name: 'diagram.png' }, { name: 'requirements.txt' }] });
    const response = await request(api, '/tasks', {
      sessionId: 'composite-session', input: 'Compare these inputs.', mode: 'analyze', routing,
      contextMessages: [{ id: 'exact-user-turn', role: 'user', content: 'Compare these inputs.' }],
      inputSource: { messageId: 'exact-user-turn', attachments: [
        { id: 'image', kind: 'image', name: 'diagram.png', url: imageUrl },
        { id: 'document', kind: 'file', name: 'requirements.txt', dataUrl: `data:text/plain;base64,${Buffer.from('Retain exactly 37 records.').toString('base64')}` },
      ] },
    });
    assert.equal(response.status, 202, await response.clone().text());
    const task = (await response.json() as { task: WorkflowTask }).task;
    assert.equal(task.plan?.inputAttachments?.length, 2);
    const result = await new WorkflowOrchestrator(store, new EventHub(), model, memory, pino({ level: 'silent' }), undefined, undefined, undefined, undefined, new FileArtifactStore(join(directory, 'artifacts'))).run(task, new AbortController().signal);
    assert.equal(result.status, 'completed', result.error);
    assert.ok(visualRequest.some((part) => part.image_url?.url === imageUrl));
    assert.match(model.documentInput, /Retain exactly 37 records/);
    assert.doesNotMatch(model.documentInput, /base64/);
    assert.deepEqual(result.stepResults.map((step) => step.role).sort(), ['document-agent', 'vision-agent']);
    await store.updateTask(task.id, { status: 'failed', error: 'Retry fixture failure after initial outputs.' });
    const denied = await request(api, `/tasks/${task.id}/retry`, undefined, 'POST', { ...headers, 'x-axiom-user-id': 'another-owner' });
    assert.equal(denied.status, 404);
    const retriedResponse = await request(api, `/tasks/${task.id}/retry`);
    assert.equal(retriedResponse.status, 202, await retriedResponse.clone().text());
    const retried = (await retriedResponse.json() as { task: WorkflowTask }).task;
    assert.notEqual(retried.runId, task.runId);
    assert.deepEqual(retried.stepResults, []);
    assert.equal(retried.result, undefined);
    assert.deepEqual(retried.plan?.steps, result.plan?.steps);
    assert.deepEqual(retried.plan?.routingDecision, result.plan?.routingDecision);
    assert.deepEqual(retried.plan?.inputAttachments, task.plan?.inputAttachments);
    assert.ok(retried.plan?.graph?.nodes.every((node) => node.status === 'queued' && node.tokens === undefined && node.durationMs === undefined));
    const retryCreated = (await store.getEvents(retried.id)).find((event) => event.type === 'task.created');
    assert.equal((retryCreated?.payload.originalTurn as { id: string }).id, 'exact-user-turn');
    for (const attachment of retried.plan!.inputAttachments!) assert.equal((await artifactCatalog.get(task.tenantId, attachment.artifactId))?.referenceCount, 2);
    const deleted = await request(api, `/tasks/${task.id}`, undefined, 'DELETE');
    assert.equal(deleted.status, 204, await deleted.clone().text());
    const restoredInputs = await loadTaskInputAttachments(retried.plan?.inputAttachments, retried, new FileArtifactStore(join(directory, 'artifacts')));
    assert.equal(restoredInputs.length, 2);
    for (const attachment of restoredInputs) assert.equal((await artifactCatalog.get(task.tenantId, attachment.artifactId))?.referenceCount, 1);
    visualRequest = [];
    model.documentInput = '';
    const retryResult = await new WorkflowOrchestrator(store, new EventHub(), model, memory, pino({ level: 'silent' }), undefined, undefined, undefined, undefined, new FileArtifactStore(join(directory, 'artifacts'))).run(retried, new AbortController().signal);
    assert.equal(retryResult.status, 'completed', retryResult.error);
    assert.ok(visualRequest.some((part) => part.image_url?.url === imageUrl));
    assert.match(model.documentInput, /Retain exactly 37 records/);
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await artifactCatalog.close();
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('whole-task retry reconciles unresolved tool outcomes before allocating a fresh execution', async () => {
  const store = new SqliteTaskStore(':memory:');
  await store.initialize();
  let unresolved = true;
  const checks: string[] = [];
  const executionStore = {
    async reconcileExpiredForTask(tenantId: string, taskId: string) { checks.push(`reconcile:${tenantId}:${taskId}`); },
    async hasUnresolvedForTask(tenantId: string, taskId: string) { checks.push(`check:${tenantId}:${taskId}`); return unresolved; },
  };
  const api = createTaskApi({ store, model: new ContextModel() as never, artifactStore: null, toolRegistry: { executionStore } as never, hub: new EventHub(), coordinator: { nudge() {}, abort() {} } as never });
  try {
    const original = await store.createTask({ tenantId: 'context-tenant', userId: 'context-owner', sessionId: 'retry-ledger', title: 'Retry safety', input: 'Original request', mode: 'analyze' });
    await store.updateTask(original.id, { status: 'failed' });
    const denied = await request(api, `/tasks/${original.id}/retry`);
    assert.equal(denied.status, 409);
    assert.deepEqual(checks, [`reconcile:context-tenant:${original.id}`, `check:context-tenant:${original.id}`]);
    unresolved = false;
    const accepted = await request(api, `/tasks/${original.id}/retry`);
    assert.equal(accepted.status, 202, await accepted.clone().text());
    const retried = (await accepted.json() as { task: WorkflowTask }).task;
    assert.notEqual(retried.id, original.id);
    assert.notEqual(retried.runId, original.runId);
    assert.deepEqual(retried.stepResults, []);
    assert.equal(retried.toolApprovals, undefined);
  } finally {
    await store.close();
  }
});

test('oversized later corrections stay raw-retrievable while the durable ledger is marked prefix-only', async () => {
  const store = new SqliteTaskStore(':memory:');
  await store.initialize();
  const model = new ContextModel();
  const api = createTaskApi({ store, model: model as never, artifactStore: null, hub: new EventHub(), coordinator: { nudge() {}, abort() {} } as never });
  const messages = Array.from({ length: 20 }, (_, index) => ({ id: `large-u${index}`, role: index % 2 && index !== 19 ? 'assistant' as const : 'user' as const, content: index === 0 ? 'Keep deployment offline.' : `Earlier detail ${index}`, createdAt: index + 1 }));
  try {
    const first = await request(api, '/sessions/large-correction', { id: 'large-correction', title: 'Large correction', messages, updatedAt: 1 }, 'PUT');
    assert.equal(first.status, 200, await first.clone().text());
    assert.equal(model.extractionCalls, 0);
    const initialTask = await request(api, '/tasks', { sessionId: 'large-correction', input: messages.at(-1)!.content, mode: 'analyze', contextMessages: messages });
    assert.equal(initialTask.status, 202, await initialTask.clone().text());
    await request(api, '/sessions/large-correction', { id: 'large-correction', title: 'Large correction', messages, updatedAt: 1 }, 'PUT');
    const correction = `${'Earlier supporting detail. '.repeat(1_000)}Cancel the offline requirement.${' Later supporting detail.'.repeat(1_000)}`;
    messages.push(...Array.from({ length: 16 }, (_, index) => ({ id: `large-u${20 + index}`, role: index % 2 && index !== 15 ? 'assistant' as const : 'user' as const, content: index === 0 ? correction : `Later detail ${index}`, createdAt: index + 21 })));
    const correctionTask = await request(api, '/tasks', { sessionId: 'large-correction', input: messages.at(-1)!.content, mode: 'analyze', contextMessages: messages });
    assert.equal(correctionTask.status, 202, await correctionTask.clone().text());
    const saved = await request(api, '/sessions/large-correction', { id: 'large-correction', title: 'Large correction', messages, updatedAt: 2 }, 'PUT');
    assert.equal(saved.status, 200, await saved.clone().text());
    const summary = (await saved.json() as { session: { contextSummary: PersistedContextSummary } }).session.contextSummary;
    assert.equal(summary.structuredContext?.status, 'partial');
    assert.equal(summary.structuredContext?.entries[0]?.status, 'active');
    assert.equal(summary.structuredContext?.pendingMessageIds?.[0], 'large-u20');
    assert.equal(summary.structuredContext?.coveredMessageIds.includes('large-u20'), false);
    const window = buildSourceContextWindow(messages, summary);
    assert.match(String(window.messages[0]?.content), /only the extracted prefix.*not current decisions/);
    assert.match(String(window.messages[0]?.content), /\[source:large-u20\]/);
    const source = await request(api, '/sessions/large-correction/context-sources', { messageIds: ['large-u20'], offset: correction.indexOf('Cancel the offline'), maxCharacters: 100 });
    const retrieved = (await source.json() as { sources: Array<{ content: string; totalCharacters: number }> }).sources[0]!;
    assert.match(retrieved.content, /^Cancel the offline requirement/);
    assert.equal(retrieved.totalCharacters, correction.length);
    assert.equal((await store.getSession('large-correction', 'context-tenant', 'context-owner'))?.messages[20]?.content, correction);
  } finally {
    await store.close();
  }
});

test('session saves stay local and task extraction uses only the selected owned provider without fallback', async () => {
  const store = new SqliteTaskStore(':memory:');
  await store.initialize();
  const defaultModel = new ContextModel();
  const personalModel = new ContextModel();
  const credentialId = '11111111-1111-4111-8111-111111111111';
  let failure: 'none' | 'completion' | 'factory' = 'none';
  let selectedCalls = 0;
  const calls: string[] = [];
  const dependencies = {
    store, model: defaultModel as never, artifactStore: null,
    hub: new EventHub(), coordinator: { nudge() {}, abort() {} } as never,
    async resolveModelCredential(id: string, tenantId: string, userId: string) {
      calls.push(`verify:${id}:${tenantId}:${userId}`);
      return id === credentialId ? { id, model: 'private-local-model' } : null;
    },
    async reportModelFactory(id: string | undefined, tenantId: string, userId: string): Promise<ModelClient> {
      calls.push(`factory:${id}:${tenantId}:${userId}`);
      if (failure === 'factory') throw new Error('Selected local provider unavailable.');
      return { model: 'private-local-model', async complete(input) {
        selectedCalls += 1;
        if (failure === 'completion') throw new Error('Selected local provider disconnected.');
        return personalModel.complete(input);
      } };
    },
  };
  const api = createTaskApi(dependencies);
  const messages = Array.from({ length: 20 }, (_, index) => ({ id: `private-u${index}`, role: 'user' as const, content: index === 0 ? 'Keep deployment offline.' : `Private detail ${index}`, createdAt: index + 1 }));
  const taskInput = (sessionId: string, selectedId: string | undefined = credentialId) => ({ sessionId, input: 'Continue.', mode: 'analyze', contextMessages: messages, ...(selectedId ? { modelCredentialId: selectedId } : {}) });
  try {
    const saved = await request(api, '/sessions/private-context', { id: 'private-context', title: 'Private context', messages, updatedAt: 20 }, 'PUT');
    assert.equal(saved.status, 200, await saved.clone().text());
    assert.equal((await saved.json() as { session: { contextSummary: PersistedContextSummary } }).session.contextSummary.structuredContext, undefined);
    assert.equal(defaultModel.extractionCalls, 0);
    assert.equal(selectedCalls, 0);
    assert.deepEqual(calls, []);
    const selected = await request(api, '/tasks', taskInput('private-context'));
    assert.equal(selected.status, 202, await selected.clone().text());
    assert.equal(selectedCalls, 1);
    assert.equal(defaultModel.extractionCalls, 0);
    assert.deepEqual(calls.slice(0, 2), [`verify:${credentialId}:context-tenant:context-owner`, `factory:${credentialId}:context-tenant:context-owner`]);
    const retained = await request(api, '/sessions/private-context', { id: 'private-context', title: 'Private context', messages, updatedAt: 21 }, 'PUT');
    const summary = (await retained.json() as { session: { contextSummary: PersistedContextSummary } }).session.contextSummary;
    assert.equal(summary.structuredContext?.model, 'private-local-model');
    assert.equal(summary.structuredContext?.entries[0]?.status, 'active');
    assert.equal(selectedCalls, 1);
    assert.equal(defaultModel.extractionCalls, 0);
    failure = 'completion';
    const failedExtraction = await request(api, '/tasks', taskInput('private-failure'));
    assert.equal(failedExtraction.status, 202, await failedExtraction.clone().text());
    const failedTask = (await failedExtraction.json() as { task: WorkflowTask }).task;
    const failedSummary = (await store.getEvents(failedTask.id)).find((event) => event.type === 'task.created')?.payload.contextSummary as PersistedContextSummary;
    assert.equal(failedSummary.structuredContext?.status, 'unavailable');
    assert.equal(defaultModel.extractionCalls, 0);
    failure = 'factory';
    assert.notEqual((await request(api, '/tasks', taskInput('private-factory-failure'))).status, 202);
    const noFactoryApi = createTaskApi({ ...dependencies, reportModelFactory: undefined });
    assert.notEqual((await request(noFactoryApi, '/tasks', taskInput('private-missing-factory'))).status, 202);
    assert.notEqual((await request(api, '/tasks', taskInput('private-wrong-owner', '22222222-2222-4222-8222-222222222222'))).status, 202);
    assert.equal(defaultModel.extractionCalls, 0);
    failure = 'none';
    const defaultRequest = await request(api, '/tasks', { ...taskInput('default-context'), modelCredentialId: undefined });
    assert.equal(defaultRequest.status, 202, await defaultRequest.clone().text());
    assert.equal(defaultModel.extractionCalls, 1, 'The default provider may extract only during an explicit default-model request.');
  } finally {
    await store.close();
  }
});

test('Nexus validates the selected credential before extracting its owner-scoped history', async () => {
  const store = new SqliteTaskStore(':memory:');
  const templates = new SqliteTemplateStore(':memory:');
  await store.initialize();
  await templates.initialize();
  const defaultModel = new ContextModel();
  const selectedModel = new ContextModel();
  const credentialId = '11111111-1111-4111-8111-111111111111';
  const calls: string[] = [];
  const dependencies = {
    store, templates, model: defaultModel as never, artifactStore: null,
    hub: new EventHub(), coordinator: { nudge() {}, abort() {} } as never,
    async resolveModelCredential(id: string, tenantId: string, userId: string) {
      calls.push(`verify:${id}:${tenantId}:${userId}`);
      return id === credentialId ? { id, model: 'selected-nexus-model' } : null;
    },
    async reportModelFactory(id: string | undefined) { calls.push(`factory:${id}`); return selectedModel; },
  };
  const api = createTaskApi(dependencies);
  try {
    const template = await templates.createTemplate({ tenantId: 'context-tenant', createdBy: 'context-owner', name: 'Selected provider Nexus', description: '', visibility: 'private', definition: {
      kind: 'agent-workflow', mode: 'analyze', policy: { requirePlanApproval: false }, agentIds: ['analyst'], toolNames: [],
      workflow: { schemaVersion: 1, nodes: [], edges: [], scopedAgents: [] },
      plan: { summary: 'Nexus provider isolation', routingReason: 'Explicit workflow', steps: [{ id: 'analysis', title: 'Analysis', role: 'analyst', objective: 'Analyze.', dependsOn: [], acceptanceCriteria: ['Complete.'] }] },
    } });
    await templates.updateTemplate(template.id, 'context-tenant', { status: 'published', updatedBy: 'context-owner' });
    for (let index = 0; index < 20; index += 1) {
      const task = await store.createTask({ tenantId: 'context-tenant', userId: 'context-owner', sessionId: `agent-nexus-${template.id}`, templateId: template.id, title: 'Prior turn', input: 'Private prior turn', mode: 'analyze' });
      await store.appendEvent(task, { type: 'task.created', payload: { originalTurn: { id: `selected-nexus-u${index}`, role: 'user', content: index === 0 ? 'Keep deployment offline.' : `Private Nexus detail ${index}` } } });
    }
    const input = { sessionId: `agent-nexus-${template.id}`, input: 'Continue.', modelCredentialId: credentialId, conversationTurn: { id: 'selected-nexus-current', role: 'user', content: 'Continue privately.' } };
    const denied = await request(api, `/workflows/${template.id}/run`, { ...input, modelCredentialId: '22222222-2222-4222-8222-222222222222' });
    assert.equal(denied.status, 409);
    assert.equal(calls.some((call) => call.startsWith('factory:')), false);
    assert.equal(defaultModel.extractionCalls, 0);
    assert.equal(selectedModel.extractionCalls, 0);
    const noFactory = createTaskApi({ ...dependencies, reportModelFactory: undefined });
    assert.equal((await request(noFactory, `/workflows/${template.id}/run`, input)).status, 409);
    assert.equal(defaultModel.extractionCalls, 0);
    const response = await request(api, `/workflows/${template.id}/run`, input);
    assert.equal(response.status, 202, await response.clone().text());
    assert.equal(selectedModel.extractionCalls, 1);
    assert.equal(defaultModel.extractionCalls, 0);
    assert.ok(calls.indexOf(`verify:${credentialId}:context-tenant:context-owner`) < calls.indexOf(`factory:${credentialId}`));
  } finally {
    await templates.close();
    await store.close();
  }
});
