import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import pino from 'pino';
import { SqliteTaskStore } from './sqliteTaskStore.js';
import { SqliteToolExecutionStore, ToolExecutionIdentityConflictError } from './toolExecutionStore.js';
import { ToolExecutionPendingError, ToolExecutionUnknownError, ToolRegistry } from './toolRegistry.js';
import { executeSpecialistGeneration, measuredSpecialistTokens } from './specialistExecution.js';
import { executeWorkflowSpecialist, type SpecialistProviderResolver } from './workflowSpecialists.js';
import { WorkflowOrchestrator } from './orchestrator.js';
import { EventHub } from './eventHub.js';
import type { AgentMemory } from './memoryClient.js';
import type { ModelClient } from './modelClient.js';
import type { ArtifactStore } from './artifactStore.js';
import { SqliteArtifactCatalog } from './artifactCatalog.js';
import { z } from 'zod';

const memory: AgentMemory = {
  async recall() { return { context: '', itemCount: 0, available: false, items: [], quality: { candidates: 0, expiredFiltered: 0, lowConfidenceFiltered: 0, byLayer: { L1: 0, L2: 0, L3: 0 } } }; },
  async capture(task) { return { capturedCount: 0, skipped: true, reason: 'disabled', cursor: task.updatedAt, contentDigest: '' }; },
};
const fixture = async () => {
  let now = Date.now();
  const tasks = new SqliteTaskStore(':memory:');
  const store = new SqliteToolExecutionStore(':memory:', () => now);
  await tasks.initialize();
  await store.initialize();
  const task = await tasks.createTask({ tenantId: 'specialist-test', userId: 'owner', sessionId: 'generation', title: 'Generation', input: 'Draw a diagram', mode: 'build' });
  const context = { store, task, stepId: 'draw', invocationId: 'generation-1' };
  const tools = new ToolRegistry(undefined, undefined, undefined, undefined, store);
  return { tasks, store, task, context, tools, advance: (ms: number) => { now += ms; }, close: async () => { await tasks.close(); await store.close(); } };
};
const request = (context: Awaited<ReturnType<typeof fixture>>['context']) => ({
  context, toolName: 'service.image.generate' as const, url: 'https://media.example/v1/images/generations', apiKey: 'private-provider-key',
  body: { model: 'test-image', prompt: 'A diagram' }, signal: new AbortController().signal, timeoutMs: 5_000,
});
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

test('a generation POST accepted before real HTTP disconnection is not resent on retry or recovery', async () => {
  const f = await fixture();
  let posts = 0;
  const server = createServer((req) => { req.resume(); req.on('end', () => { posts += 1; req.socket.destroy(); }); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const input = { ...request(f.context), url: `http://127.0.0.1:${address.port}/generate` };
  try {
    await assert.rejects(executeSpecialistGeneration(input), ToolExecutionUnknownError);
    await assert.rejects(executeSpecialistGeneration(input), ToolExecutionUnknownError);
    assert.equal(posts, 1);
    const record = (await f.store.listForTask(f.task.tenantId, f.task.id))[0]!;
    assert.equal(record.status, 'outcome_unknown');
    assert.doesNotMatch(JSON.stringify(record), /private-provider-key|A diagram/);
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); await f.close(); }
});

test('generation receipt replay and a lost commit acknowledgement never repeat POST', async () => {
  const f = await fixture();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  const complete = f.store.complete.bind(f.store);
  f.store.complete = async (owner, receipt) => { await complete(owner, receipt); throw new Error('Commit acknowledgement lost'); };
  globalThis.fetch = async () => { calls += 1; return json({ data: [{ url: 'https://cdn.example/image.png' }], usage: { total_tokens: 12 } }); };
  try {
    const first = await executeSpecialistGeneration(request(f.context));
    const second = await executeSpecialistGeneration(request(f.context));
    assert.equal(calls, 1);
    assert.equal(first.receipt.call.id, second.receipt.call.id);
    assert.equal(second.receipt.replayed, true);
    assert.equal(second.response?.payload.usage && measuredSpecialistTokens(second.response.payload.usage as Record<string, number>), 12);
  } finally { globalThis.fetch = originalFetch; await f.close(); }
});

test('expired generation ownership fences late success and requires review before dispatch', async () => {
  const f = await fixture();
  const originalFetch = globalThis.fetch;
  let release!: () => void;
  let accepted!: () => void;
  let posts = 0;
  const waitAccepted = new Promise<void>((resolve) => { accepted = resolve; });
  globalThis.fetch = async () => { posts += 1; accepted(); await new Promise<void>((resolve) => { release = resolve; }); return json({ data: [{ url: 'https://cdn.example/late.png' }] }); };
  try {
    const first = executeSpecialistGeneration(request(f.context));
    const firstRejected = assert.rejects(first, ToolExecutionUnknownError);
    await waitAccepted;
    f.advance(400_000);
    await assert.rejects(executeSpecialistGeneration(request(f.context)), ToolExecutionUnknownError);
    release();
    await firstRejected;
    assert.equal(posts, 1);
    assert.equal((await f.store.listForTask(f.task.tenantId, f.task.id))[0]?.status, 'outcome_unknown');
  } finally { globalThis.fetch = originalFetch; await f.close(); }
});

test('cancel after acceptance does not accept a late response or repeat the generation', async () => {
  const f = await fixture();
  const originalFetch = globalThis.fetch;
  const abort = new AbortController();
  let posts = 0;
  globalThis.fetch = async () => { posts += 1; abort.abort(); return json({ data: [{ url: 'https://cdn.example/late.png' }] }); };
  try {
    await assert.rejects(executeSpecialistGeneration({ ...request(f.context), signal: abort.signal }), ToolExecutionUnknownError);
    await assert.rejects(executeSpecialistGeneration(request(f.context)), ToolExecutionUnknownError);
    assert.equal(posts, 1);
  } finally { globalThis.fetch = originalFetch; await f.close(); }
});

test('generation recovery uses the normal outcome API and human confirmation cannot fabricate an image', async () => {
  const f = await fixture();
  const originalFetch = globalThis.fetch;
  let posts = 0;
  globalThis.fetch = async () => { posts += 1; throw new Error('Accepted then disconnected'); };
  const providerResolver: SpecialistProviderResolver = async () => ({ apiKey: 'private-provider-key', baseUrl: 'https://media.example', model: 'test-image' });
  const execute = () => executeWorkflowSpecialist('drawing-agent', 'A diagram', new AbortController().signal, [], undefined,
    { task: f.task, execution: f.context, providerResolver });
  try {
    await assert.rejects(execute(), ToolExecutionUnknownError);
    const record = (await f.store.listForTask(f.task.tenantId, f.task.id))[0]!;
    assert.ok(await f.tools.resolveExecutionUnknown({ tenantId: f.task.tenantId, id: record.id, expectedRevision: record.revision,
      operatorId: f.task.userId, decision: 'confirmed-completed', note: 'Inspected the supplier portal and downloaded the generated file.' }));
    const result = await execute();
    assert.equal(posts, 1);
    assert.equal(result.execution?.receiptSource, 'human-confirmed');
    assert.equal(result.completionStatus, 'partial');
    assert.equal(result.usage, undefined);
    assert.equal(result.evidence.length, 0);
    assert.doesNotMatch(result.output, /!\[/);
  } finally { globalThis.fetch = originalFetch; await f.close(); }
});

test('confirmed-not-executed authorizes the original invocation; only explicit reruns create a new call', async () => {
  const f = await fixture();
  const originalFetch = globalThis.fetch;
  let posts = 0;
  globalThis.fetch = async () => { posts += 1; if (posts === 1) throw new Error('Network loss'); return json({ data: [{ url: 'https://cdn.example/image.png' }] }); };
  try {
    await assert.rejects(executeSpecialistGeneration(request(f.context)), ToolExecutionUnknownError);
    const record = (await f.store.listForTask(f.task.tenantId, f.task.id))[0]!;
    assert.ok(await f.tools.resolveExecutionUnknown({ tenantId: f.task.tenantId, id: record.id, expectedRevision: record.revision,
      operatorId: f.task.userId, decision: 'confirmed-not-executed', note: 'Provider audit confirms no request was accepted.' }));
    const retried = await executeSpecialistGeneration(request(f.context));
    assert.equal(retried.receipt.call.id, record.callId);
    await executeSpecialistGeneration(request(f.context));
    assert.equal(posts, 2);
    await executeSpecialistGeneration(request({ ...f.context, invocationId: 'explicit-regeneration' }));
    assert.equal(posts, 3);
    await assert.rejects(executeSpecialistGeneration({ ...request(f.context), body: { model: 'test-image', prompt: 'Changed' } }), ToolExecutionIdentityConflictError);
    await assert.rejects(executeSpecialistGeneration({ ...request(f.context), apiKey: 'different-provider' }), ToolExecutionIdentityConflictError);
    assert.equal(posts, 3);
  } finally { globalThis.fetch = originalFetch; await f.close(); }
});

test('async video receipt is persisted before status lookup and resume performs GET only', async () => {
  const f = await fixture();
  const originalFetch = globalThis.fetch;
  let posts = 0;
  let queries = 0;
  globalThis.fetch = async (_url, init) => {
    if (init?.method === 'POST') { posts += 1; return json({ id: 'job-17', status: 'queued' }, 202); }
    queries += 1;
    assert.equal((await f.store.listForTask(f.task.tenantId, f.task.id))[0]?.status, 'completed');
    if (queries === 1) throw new Error('Status temporarily disconnected');
    return json({ id: 'job-17', status: 'completed', url: 'https://cdn.example/video.mp4', usage: { input_tokens: 7, output_tokens: 3 } });
  };
  const execute = () => executeWorkflowSpecialist('video-agent', 'A video', new AbortController().signal, [], undefined,
    { execution: f.context, task: f.task, providerResolver: async () => ({ apiKey: '', baseUrl: 'https://media.example', model: 'video', location: 'local' }) });
  try {
    await assert.rejects(execute(), ToolExecutionPendingError);
    const result = await execute();
    assert.equal(posts, 1);
    assert.equal(queries, 2);
    assert.equal(result.completionStatus, 'complete');
    assert.match(result.output, /video\.mp4/);
    assert.equal(measuredSpecialistTokens(result.usage), 10);
  } finally { globalThis.fetch = originalFetch; await f.close(); }
});

test('video status links cannot send the selected credential to a different provider', async () => {
  const f = await fixture();
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return json({ id: 'job-17', status_url: 'https://other.example/steal' }, 202); };
  try {
    await assert.rejects(executeWorkflowSpecialist('video-agent', 'A video', new AbortController().signal, [], undefined,
      { execution: f.context, task: f.task, providerResolver: async () => ({ apiKey: 'secret', baseUrl: 'https://media.example', model: 'video' }) }), /不属于/);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = originalFetch; await f.close(); }
});

test('async video processing is automatically polled and legacy nested relative output remains usable', async () => {
  const f = await fixture();
  const originalFetch = globalThis.fetch;
  let posts = 0;
  let queries = 0;
  globalThis.fetch = async (url, init) => {
    if (init?.method === 'POST') { posts += 1; return json({ status_url: '/jobs/17' }, 202); }
    queries += 1;
    assert.equal(String(url), 'https://media.example/jobs/17');
    return json(queries < 3 ? { status: 'processing' } : { status: 'completed', result: { video_url: '/output/final.mp4' } });
  };
  try {
    const result = await executeWorkflowSpecialist('video-agent', 'Generate', new AbortController().signal, [], undefined,
      { task: f.task, execution: f.context, videoPollIntervalMs: 1,
        providerResolver: async () => ({ apiKey: '', baseUrl: 'https://media.example', model: 'video', location: 'local' }) });
    assert.equal(posts, 1);
    assert.equal(queries, 3);
    assert.equal(result.completionStatus, 'complete');
    assert.match(result.output, /https:\/\/media.example\/output\/final.mp4/);
  } finally { globalThis.fetch = originalFetch; await f.close(); }
});

test('explicit image request options preserve generation mode and editing rejects a missing original before POST', async () => {
  const f = await fixture();
  const originalFetch = globalThis.fetch;
  let posts = 0;
  globalThis.fetch = async (url, init) => {
    posts += 1;
    assert.equal(String(url), 'https://media.example/v1/images/generations');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.size, '1536x1024'); assert.equal(body.n, 3); assert.equal(body.quality, 'high');
    return json({ data: [{ url: 'https://cdn.example/image.png' }] });
  };
  const providerResolver: SpecialistProviderResolver = async () => ({ apiKey: '', baseUrl: 'https://media.example', model: 'image', location: 'local' });
  const content = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  try {
    const task = { ...f.task, plan: { summary: '', routingReason: '', steps: [], mediaRequest: { mode: 'generate' as const, size: '1536x1024', count: 3, quality: 'high' as const } } };
    await executeWorkflowSpecialist('drawing-agent', 'Generate a new picture', new AbortController().signal,
      [{ artifactRecordId: 'a', artifactId: 'a', name: 'source.png', mimeType: 'image/png', bytes: content.length, digest: 'b'.repeat(64), storageEncoding: 'binary', content }], undefined,
      { task, execution: { ...f.context, task }, providerResolver });
    const editing = { ...task, plan: { ...task.plan, mediaRequest: { mode: 'edit' as const } } };
    await assert.rejects(executeWorkflowSpecialist('drawing-agent', 'Edit', new AbortController().signal, [], undefined,
      { task: editing, execution: { ...f.context, task: editing, invocationId: 'edit' }, providerResolver }), /原图/);
    assert.equal(posts, 1);
  } finally { globalThis.fetch = originalFetch; await f.close(); }
});

test('image editing sends original bytes and persists large base64 output without repeating POST after storage failure', async () => {
  const f = await fixture();
  const catalog = new SqliteArtifactCatalog(':memory:');
  await catalog.initialize();
  const originalFetch = globalThis.fetch;
  const source = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const generatedBytes = Buffer.alloc(42_000, 17);
  let posts = 0;
  let failStore = true;
  const binaries = new Map<string, Uint8Array>();
  const artifacts: ArtifactStore = {
    kind: 'filesystem', async put() { return { key: '', bytes: 0 }; }, async get() { return null; }, async delete() {},
    async health() { return { configured: true, reachable: true, detail: 'fixture' }; },
    async putBinary(id, content) { if (failStore) { failStore = false; throw new Error('Temporary artifact outage'); } binaries.set(id, Uint8Array.from(content)); return { key: id, bytes: content.length }; },
  };
  globalThis.fetch = async (url, init) => {
    posts += 1;
    assert.equal(String(url), 'https://media.example/v1/images/edits');
    assert.ok(init?.body instanceof FormData);
    assert.equal(new Headers(init.headers).has('content-type'), false);
    const image = init.body.get('image');
    assert.ok(image instanceof Blob);
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), source);
    return json({ data: [{ b64_json: generatedBytes.toString('base64') }] });
  };
  const execute = () => executeWorkflowSpecialist('drawing-agent', 'Edit this image', new AbortController().signal, [{
    artifactRecordId: 'input', artifactId: 'input', name: 'source.png', mimeType: 'image/png', bytes: source.length, digest: 'a'.repeat(64), storageEncoding: 'binary', content: source,
  }], undefined, { task: f.task, execution: f.context, artifactStore: artifacts, artifactCatalog: catalog,
    providerResolver: async () => ({ apiKey: '', baseUrl: 'https://media.example', model: 'image', location: 'local' }) });
  try {
    await assert.rejects(execute(), ToolExecutionPendingError);
    const result = await execute();
    assert.equal(posts, 1);
    assert.match(result.output, /\/api\/tasks\/.+\/artifacts\/media\//);
    assert.doesNotMatch(result.output, /base64/);
    assert.equal(result.artifacts?.length, 1);
    const artifact = result.artifacts![0]!;
    assert.equal((await catalog.get(f.task.tenantId, artifact.id))?.taskId, f.task.id);
    assert.deepEqual(Buffer.from(binaries.get(artifact.id)!), generatedBytes);
    assert.equal(result.usage, undefined);
  } finally { globalThis.fetch = originalFetch; await catalog.close(); await f.close(); }
});

test('inline video output is stored as a tenant-owned artifact and never embedded in task text', async () => {
  const f = await fixture();
  const catalog = new SqliteArtifactCatalog(':memory:');
  await catalog.initialize();
  const originalFetch = globalThis.fetch;
  const content = Buffer.from('fixture-video-binary');
  let stored: Uint8Array | undefined;
  const artifacts: ArtifactStore = {
    kind: 'filesystem', async put() { return { key: '', bytes: 0 }; }, async get() { return null; }, async delete() {},
    async health() { return { configured: true, reachable: true, detail: 'fixture' }; },
    async putBinary(id, bytes, tenantId, mimeType) { assert.equal(tenantId, f.task.tenantId); assert.equal(mimeType, 'video/mp4'); stored = bytes; return { key: id, bytes: bytes.length }; },
  };
  globalThis.fetch = async () => json({ video_base64: content.toString('base64') });
  try {
    const result = await executeWorkflowSpecialist('video-agent', 'Make video', new AbortController().signal, [], undefined,
      { task: f.task, execution: f.context, artifactStore: artifacts, artifactCatalog: catalog,
        providerResolver: async () => ({ apiKey: '', baseUrl: 'https://media.example', model: 'video', location: 'local' }) });
    assert.deepEqual(stored, content);
    assert.match(result.output, /\/artifacts\/media\//);
    assert.doesNotMatch(result.output, /base64/);
    assert.equal(result.artifacts?.[0]?.mimeType, 'video/mp4');
  } finally { globalThis.fetch = originalFetch; await catalog.close(); await f.close(); }
});

test('search preserves incomplete output and actual usage without claiming successful completion', async () => {
  const f = await fixture();
  const originalFetch = globalThis.fetch;
  const originalSearchEnabled = process.env.DEEPSEEK_NATIVE_SEARCH;
  // This is the enabled-provider fixture. Do not inherit a developer's global
  // feature switch: clean release tests deliberately disable real integrations.
  process.env.DEEPSEEK_NATIVE_SEARCH = 'true';
  globalThis.fetch = async () => new Response('event: response.output_text.delta\ndata: {"delta":"Source: https://example.com/paper"}\n\nevent: response.incomplete\ndata: {"response":{"incomplete_details":{"reason":"max_output_tokens"},"usage":{"input_tokens":11,"output_tokens":5}}}\n\n', { headers: { 'content-type': 'text/event-stream' } });
  try {
    const result = await executeWorkflowSpecialist('academic-search-agent', 'Find papers', new AbortController().signal, [], undefined,
      { task: f.task, providerResolver: async () => ({ apiKey: 'fake', baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-flash' }) });
    assert.equal(result.completionStatus, 'partial');
    assert.equal(result.finishReason, 'max_output_tokens');
    assert.equal(measuredSpecialistTokens(result.usage), 16);
    assert.match(result.output, /example.com/);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalSearchEnabled === undefined) delete process.env.DEEPSEEK_NATIVE_SEARCH;
    else process.env.DEEPSEEK_NATIVE_SEARCH = originalSearchEnabled;
    await f.close();
  }
});

test('disabled native search rejects even a bound provider before making any HTTP request', async () => {
  const f = await fixture();
  const originalFetch = globalThis.fetch;
  const originalSearchEnabled = process.env.DEEPSEEK_NATIVE_SEARCH;
  process.env.DEEPSEEK_NATIVE_SEARCH = 'false';
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error('A disabled integration must not use the network.'); };
  try {
    await assert.rejects(executeWorkflowSpecialist('academic-search-agent', 'Find papers', new AbortController().signal, [], undefined,
      { task: f.task, providerResolver: async () => ({ apiKey: 'fake', baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-flash' }) }), /原生搜索尚未配置/);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalSearchEnabled === undefined) delete process.env.DEEPSEEK_NATIVE_SEARCH;
    else process.env.DEEPSEEK_NATIVE_SEARCH = originalSearchEnabled;
    await f.close();
  }
});

test('document partial output carries measured usage while omitted usage stays unknown', async () => {
  const content = Buffer.from('Budget 200');
  const attachments = [{ artifactRecordId: 'record', artifactId: 'artifact', name: 'plan.txt', mimeType: 'text/plain', bytes: content.byteLength, digest: 'a'.repeat(64), storageEncoding: 'binary' as const, content }];
  const model: ModelClient = { model: 'text', async complete() { return { content: 'Incomplete analysis', finishReason: 'length', usage: { total_tokens: 33 }, attempts: 1, durationMs: 1 }; } };
  const result = await executeWorkflowSpecialist('document-agent', 'Analyze', new AbortController().signal, attachments, model);
  assert.equal(result.completionStatus, 'partial');
  assert.equal(measuredSpecialistTokens(result.usage), 33);
  assert.equal(measuredSpecialistTokens(undefined), undefined);
  assert.equal(measuredSpecialistTokens({ prompt_tokens: 7 }), undefined);
});

test('vision preserves provider truncation and usage with the selected local no-key model', async () => {
  const f = await fixture();
  const originalFetch = globalThis.fetch;
  const content = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), 'http://127.0.0.1:9011/v1/chat/completions');
    assert.equal(new Headers(init?.headers).has('authorization'), false);
    return json({ choices: [{ message: { content: 'Visible part of the image' }, finish_reason: 'length' }], usage: { prompt_tokens: 50, completion_tokens: 30, total_tokens: 80 } });
  };
  try {
    const result = await executeWorkflowSpecialist('vision-agent', 'Analyze image', new AbortController().signal,
      [{ artifactRecordId: 'a', artifactId: 'a', name: 'source.png', mimeType: 'image/png', bytes: content.length, digest: 'b'.repeat(64), storageEncoding: 'binary', content }], undefined,
      { task: f.task, providerResolver: async () => ({ apiKey: '', baseUrl: 'http://127.0.0.1:9011/v1', model: 'local-vision', location: 'local' }) });
    assert.equal(result.finishReason, 'length');
    assert.equal(result.completionStatus, 'partial');
    assert.equal(measuredSpecialistTokens(result.usage), 80);
  } finally { globalThis.fetch = originalFetch; await f.close(); }
});

test('orchestrator pauses unknown media, preserves the exact invocation and exposes truthful usage after recovery', async () => {
  const f = await fixture();
  const originalFetch = globalThis.fetch;
  let posts = 0;
  globalThis.fetch = async () => { posts += 1; if (posts === 1) throw new Error('Accepted then disconnected'); return json({ data: [{ url: 'https://cdn.example/final.png' }], usage: { total_tokens: 43 } }); };
  const model: ModelClient = { model: 'text', async complete() { return { content: 'The generated result', attempts: 1, durationMs: 1 }; } };
  const task = await f.tasks.updateTask(f.task.id, { plan: {
    summary: 'Generate', routingReason: 'Explicit image capability', approvalStatus: 'approved',
    profile: { kind: 'creative', difficulty: 'moderate', route: 'full-workflow', score: 50, reasons: ['test'], maxSteps: 1, requiresReview: false },
    steps: [{ id: 'draw', title: 'Draw', role: 'drawing-agent', objective: 'Draw', dependsOn: [], acceptanceCriteria: ['An image'], failureStrategy: 'retry', agentContract: { source: 'builtin', agentId: 'drawing-agent', displayName: 'Draw', toolAllowlist: [] } }],
  } });
  const orchestrator = new WorkflowOrchestrator(f.tasks, new EventHub(), model, memory, pino({ level: 'silent' }), f.tools, undefined, undefined, undefined, undefined, undefined, undefined,
    async () => ({ apiKey: 'fake', baseUrl: 'https://media.example', model: 'image' }));
  try {
    const waiting = await orchestrator.run(task, new AbortController().signal);
    assert.equal(waiting.status, 'waiting_for_human', waiting.error ?? '');
    assert.equal(posts, 1);
    const record = (await f.store.listForTask(task.tenantId, task.id))[0]!;
    await f.tools.resolveExecutionUnknown({ tenantId: task.tenantId, id: record.id, expectedRevision: record.revision, operatorId: task.userId, decision: 'confirmed-not-executed', note: 'Confirmed no accepted generation.' });
    const resumed = await f.tasks.updateTask(task.id, { status: 'queued' });
    const result = await orchestrator.run(resumed, new AbortController().signal);
    assert.equal(result.status, 'completed', result.error ?? '');
    assert.equal(result.stepResults[0]?.tokens, 43);
    assert.equal(posts, 2);
    const events = await f.tasks.getEvents(task.id);
    const service = events.find((event) => event.type === 'model.completed' && event.payload.serviceAgent === 'drawing-agent');
    assert.equal(service?.payload.totalTokens, 43);
    assert.equal(service?.payload.promptTokens, undefined);
  } finally { globalThis.fetch = originalFetch; await f.close(); }
});

test('single-Agent legacy fast path marks truncated output partial and does not fabricate zero usage', async () => {
  const f = await fixture();
  const model: ModelClient = { model: 'text', async complete() { return { content: 'Only the first section', finishReason: 'length', attempts: 1, durationMs: 1 }; } };
  try {
    const task = await f.tasks.updateTask(f.task.id, { plan: {
      summary: 'Single', routingReason: 'Existing single route', approvalStatus: 'approved', steps: [],
      profile: { kind: 'question', difficulty: 'easy', route: 'single-agent', score: 20, reasons: ['test'], maxSteps: 1, requiresReview: false },
    } });
    const result = await new WorkflowOrchestrator(f.tasks, new EventHub(), model, memory, pino({ level: 'silent' }), f.tools).run(task, new AbortController().signal);
    assert.equal(result.stepResults[0]?.handoff?.status, 'partial');
    assert.equal(result.stepResults[0]?.tokens, undefined);
    const events = await f.tasks.getEvents(task.id);
    assert.equal(events.find((event) => event.type === 'task.completed')?.payload.partial, true);
    assert.equal(events.find((event) => event.type === 'model.completed')?.payload.totalTokens, undefined);
  } finally { await f.close(); }
});

test('failed media cannot be automatically replanned into a new generation invocation', async () => {
  const f = await fixture();
  const originalFetch = globalThis.fetch;
  let posts = 0;
  globalThis.fetch = async () => { posts += 1; return json({ error: 'Invalid model' }, 400); };
  const model: ModelClient = { model: 'text', async complete() { return { content: JSON.stringify({ output: 'The media service failed.', evidence: [], confidence: 0.2, toolCalls: [] }), attempts: 1, durationMs: 1 }; } };
  try {
    const task = await f.tasks.updateTask(f.task.id, { plan: {
      summary: 'Media and report', routingReason: 'Fixture', approvalStatus: 'approved',
      profile: { kind: 'creative', difficulty: 'moderate', route: 'full-workflow', score: 30, reasons: ['test'], maxSteps: 2, requiresReview: false },
      steps: [
        { id: 'draw', title: 'Draw', role: 'drawing-agent', objective: 'Draw', dependsOn: [], acceptanceCriteria: ['An image'], failureStrategy: 'retry', agentContract: { source: 'builtin', agentId: 'drawing-agent', displayName: 'Draw', toolAllowlist: [] } },
        { id: 'report', title: 'Report', role: 'analyst', objective: 'Summarize the outcome', dependsOn: ['draw'], acceptanceCriteria: ['Honest outcome'] },
      ],
    } });
    await new WorkflowOrchestrator(f.tasks, new EventHub(), model, memory, pino({ level: 'silent' }), f.tools, undefined, undefined, undefined, undefined, undefined, undefined,
      async () => ({ apiKey: 'fake', baseUrl: 'https://media.example', model: 'invalid' })).run(task, new AbortController().signal);
    assert.equal(posts, 1);
    const events = await f.tasks.getEvents(task.id);
    assert.equal(events.some((event) => event.type === 'plan.replanned' && event.payload.trigger === 'automatic-failure'), false);
    assert.equal((await f.store.listForTask(task.tenantId, task.id)).length, 1);
  } finally { globalThis.fetch = originalFetch; await f.close(); }
});

test('an entry-level empty tool allowlist blocks forged model calls even for a Builder', async () => {
  const f = await fixture();
  const previousExecutor = process.env.AXIOM_TOOL_EXECUTOR;
  process.env.AXIOM_TOOL_EXECUTOR = 'docker';
  let effects = 0;
  let decisions = 0;
  f.tools.register({ name: 'fixture.forbidden', description: 'Not granted to this Mini App', risk: 'low', sideEffect: 'write', executionBoundary: 'host-bounded', timeoutMs: 1_000,
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false }, schema: z.object({}),
    handler: async (_args, context) => { effects += 1; return { stdout: 'forbidden', stderr: '', exitCode: 0, durationMs: 1, auditId: context.auditId }; } });
  const model: ModelClient = { model: 'text', async complete(request) {
    if (request.system.includes('synthesizer')) return { content: 'No unauthorized operations were performed.', attempts: 1, durationMs: 1 };
    decisions += 1;
    assert.equal(request.tools?.length ?? 0, 0);
    return { content: JSON.stringify({ output: 'No access', evidence: [], confidence: .5, toolCalls: decisions === 1 ? [{ name: 'fixture.forbidden', args: {} }] : [] }), attempts: 1, durationMs: 1 };
  } };
  try {
    const task = await f.tasks.updateTask(f.task.id, { policy: { ...f.task.policy, toolAllowlist: [] }, plan: {
      summary: 'Mini App task', routingReason: 'Test', approvalStatus: 'approved',
      profile: { kind: 'implementation', difficulty: 'moderate', route: 'team', score: 30, reasons: ['test'], maxSteps: 1, requiresReview: false },
      steps: [{ id: 'work', title: 'Work', role: 'builder', objective: 'Try a forged call', dependsOn: [], acceptanceCriteria: ['Respect entry policy'] }],
    } });
    await new WorkflowOrchestrator(f.tasks, new EventHub(), model, memory, pino({ level: 'silent' }), f.tools).run(task, new AbortController().signal);
    assert.equal(effects, 0);
    assert.equal(decisions, 2);
  } finally { if (previousExecutor === undefined) delete process.env.AXIOM_TOOL_EXECUTOR; else process.env.AXIOM_TOOL_EXECUTOR = previousExecutor; await f.close(); }
});
