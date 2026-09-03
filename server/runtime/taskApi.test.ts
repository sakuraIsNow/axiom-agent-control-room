import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventHub } from './eventHub.js';
import { SqliteTaskStore } from './sqliteTaskStore.js';
import { createTaskApi } from './taskApi.js';
import { SqliteTemplateStore } from './templateStore.js';
import { SqlitePluginStore } from './pluginStore.js';
import type { WorkflowTask } from './contracts.js';
import type { ModelClient, ModelCompletionRequest } from './modelClient.js';
import { TencentMemoryClient } from './memoryClient.js';
import { SqliteMemoryCaptureReceiptStore } from './memoryCaptureStore.js';
import { SqliteArtifactCatalog } from './artifactCatalog.js';
import { FileArtifactStore } from './artifactStore.js';
import { SqliteBusinessCapabilityStore } from './businessCapabilityStore.js';
import { signPrincipal } from './principal.js';
import { signWebhookPayload } from './webhookSecurity.js';
import type { HarnessAdapter, HarnessCapabilities, HarnessCommandResult, HarnessEvent, HarnessThread, HarnessThreadInput, HarnessTurn, HarnessTurnInput } from './harness.js';

const review = {
  approved: false,
  score: 64,
  summary: '需要补充验证。',
  gaps: ['缺少回归证据'],
  requiredCorrections: ['增加边界测试'],
};

const createHarness = async () => {
  const store = new SqliteTaskStore(':memory:');
  await store.initialize();
  const hub = new EventHub();
  const api = createTaskApi({
    store,
    hub,
    coordinator: { nudge() {}, abort() {} } as never,
  });
  return { store, hub, api };
};

const request = (api: ReturnType<typeof createTaskApi>, path: string, init?: RequestInit) =>
  api.request(new Request(`http://runtime.test${path}`, init));

const seedTask = async (store: SqliteTaskStore, status: WorkflowTask['status'] = 'waiting_for_human') => {
  const task = await store.createTask({
    tenantId: 'local',
    userId: 'operator',
    sessionId: 'session-api-test',
    title: '审核接口测试',
    input: '验证审核控制闭环',
    mode: 'build',
  });
  const planned = await store.updateTask(task.id, {
    status,
    plan: {
      summary: '测试计划',
      routingReason: 'API test',
      steps: [{ id: 'step-1', title: '验证', role: 'analyst', objective: '验证', dependsOn: [], acceptanceCriteria: ['完成'] }],
      profile: { kind: 'implementation', difficulty: 'moderate', route: 'team', score: 3, reasons: ['test'], maxSteps: 3, requiresReview: true },
      approvalStatus: 'approved',
    },
    review,
  });
  await store.appendEvent(planned, { type: 'task.created', payload: { title: planned.title } });
  await store.appendEvent(planned, { type: 'model.completed', payload: { stage: 'planner', promptTokens: 10, completionTokens: 20, totalTokens: 30, estimatedCostUsd: 0.001 } });
  return planned;
};

class ApiHarnessAdapter implements HarnessAdapter {
  readonly kind: 'deepseek' | 'codex';
  readonly protocol: 'deepseek-harness/v1' | 'codex-app-server/v2';
  readonly threads = new Map<string, HarnessThread>();
  active = true;
  configured = true;
  compatible = true;
  steerAccepted = true;
  readonly steered: string[] = [];

  constructor(kind: 'deepseek' | 'codex' = 'deepseek') {
    this.kind = kind;
    this.protocol = kind === 'codex' ? 'codex-app-server/v2' : 'deepseek-harness/v1';
  }

  async handshake(): Promise<HarnessCapabilities> {
    return {
      kind: this.kind,
      protocol: this.protocol,
      version: 'test',
      configured: this.configured,
      compatible: this.compatible,
      active: this.active,
      capabilities: ['session-new', 'session-resume'],
      reason: this.active ? 'test adapter ready' : 'test adapter unavailable',
    };
  }

  async startThread(input: HarnessThreadInput): Promise<HarnessThread> {
    const thread = { threadId: `api-thread-${input.taskId}`, taskId: input.taskId, sessionId: input.sessionId, kind: this.kind, externallyOwned: true } as const;
    this.threads.set(thread.threadId, thread);
    return thread;
  }

  async startTurn(input: HarnessTurnInput): Promise<HarnessTurn> {
    return { turnId: input.runId, threadId: input.threadId, taskId: input.taskId, runId: input.runId };
  }

  async resume(threadId: string): Promise<HarnessCommandResult> {
    return { accepted: this.threads.has(threadId), delegated: true, command: 'resume', reason: this.threads.has(threadId) ? undefined : 'unknown thread' };
  }

  async interrupt(threadId: string): Promise<HarnessCommandResult> {
    return { accepted: this.threads.has(threadId), delegated: true, command: 'interrupt', reason: this.threads.has(threadId) ? undefined : 'unknown thread' };
  }

  async approve(): Promise<HarnessCommandResult> {
    return { accepted: true, delegated: true, command: 'approve' };
  }

  async steer(_threadId: string, note: string): Promise<HarnessCommandResult> {
    this.steered.push(note);
    return { accepted: this.steerAccepted, delegated: true, command: 'steer', ...(this.steerAccepted ? {} : { reason: 'steer unavailable' }) };
  }

  async *subscribe(_threadId: string, _afterSequence = 0, signal?: AbortSignal): AsyncIterable<HarnessEvent> {
    await new Promise<void>((resolve) => {
      if (signal?.aborted) return resolve();
      signal?.addEventListener('abort', () => resolve(), { once: true });
    });
  }
}

test('Harness delegation APIs enforce availability, ownership, pause state, and thread scope', async () => {
  const unavailable = await createHarness();
  const unavailableTask = await seedTask(unavailable.store, 'paused');
  const headers = { 'content-type': 'application/json', 'x-axiom-tenant-id': 'local', 'x-axiom-user-id': 'operator' };
  try {
    const response = await request(unavailable.api, `/tasks/${unavailableTask.id}/harness/start`, {
      method: 'POST', headers, body: JSON.stringify({ input: '委托给外部 Harness' }),
    });
    assert.equal(response.status, 503);
  } finally {
    await unavailable.store.close();
  }

  const store = new SqliteTaskStore(':memory:');
  await store.initialize();
  const adapter = new ApiHarnessAdapter();
  const api = createTaskApi({
    store,
    hub: new EventHub(),
    coordinator: { nudge() {}, abort() {} } as never,
    harnessAdapter: adapter,
  });
  const paused = await seedTask(store, 'paused');
  const running = await seedTask(store, 'running');
  const otherUserHeaders = { 'content-type': 'application/json', 'x-axiom-tenant-id': 'local', 'x-axiom-user-id': 'different-user' };
  try {
    const forbidden = await request(api, `/tasks/${paused.id}/harness/start`, {
      method: 'POST', headers: otherUserHeaders, body: JSON.stringify({ input: '无权委托' }),
    });
    assert.equal(forbidden.status, 403);

    const stateConflict = await request(api, `/tasks/${running.id}/harness/start`, {
      method: 'POST', headers, body: JSON.stringify({ input: '运行中的任务' }),
    });
    assert.equal(stateConflict.status, 409);

    adapter.active = false;
    const inactive = await request(api, `/tasks/${paused.id}/harness/start`, {
      method: 'POST', headers, body: JSON.stringify({ input: '未激活 sidecar' }),
    });
    assert.equal(inactive.status, 503);
    adapter.active = true;

    const started = await request(api, `/tasks/${paused.id}/harness/start`, {
      method: 'POST', headers, body: JSON.stringify({ input: '开始外部执行' }),
    });
    assert.equal(started.status, 202);
    const startedBody = await started.json() as { thread?: HarnessThread; delegated?: boolean };
    assert.equal(startedBody.delegated, true);
    assert.ok(startedBody.thread?.threadId);
    assert.equal((await store.getTask(paused.id, 'local'))?.status, 'running');
    assert.ok((await store.getEvents(paused.id)).some((event) => event.type === 'harness.connected'));

    const duplicate = await request(api, `/tasks/${paused.id}/harness/start`, {
      method: 'POST', headers, body: JSON.stringify({ input: '重复委托' }),
    });
    assert.equal(duplicate.status, 409);

    const interrupted = await request(api, `/tasks/${paused.id}/harness/interrupt`, { method: 'POST', headers });
    assert.equal(interrupted.status, 202);
    assert.equal((await store.getTask(paused.id, 'local'))?.status, 'paused');

    const threadId = startedBody.thread!.threadId;
    const resumed = await request(api, `/tasks/${paused.id}/harness/resume`, {
      method: 'POST', headers, body: JSON.stringify({ threadId }),
    });
    assert.equal(resumed.status, 202);
    assert.equal((await store.getTask(paused.id, 'local'))?.status, 'running');

    const foreign = await seedTask(store, 'paused');
    const crossTask = await request(api, `/tasks/${foreign.id}/harness/resume`, {
      method: 'POST', headers, body: JSON.stringify({ threadId }),
    });
    assert.equal(crossTask.status, 409);

    const finalInterrupt = await request(api, `/tasks/${paused.id}/harness/interrupt`, { method: 'POST', headers });
    assert.equal(finalInterrupt.status, 202);
    assert.equal((await store.getTask(paused.id, 'local'))?.status, 'paused');
  } finally {
    await store.close();
  }
});

test('Harness Thread Graph API returns tenant-scoped breadth-first descendants from durable events', async () => {
  const { store, api } = await createHarness();
  const headers = { 'x-axiom-tenant-id': 'local', 'x-axiom-user-id': 'operator' };
  try {
    const task = await seedTask(store, 'paused');
    await store.appendEvent(task, { type: 'harness.connected', payload: { threadId: 'root-thread' } });
    await store.appendEvent(task, { type: 'thread.forked', payload: { childThreadId: 'child-a', harness: { threadId: 'child-a', parentThreadId: 'root-thread' } } });
    await store.appendEvent(task, { type: 'thread.forked', payload: { childThreadId: 'child-b', harness: { threadId: 'child-b', parentThreadId: 'root-thread' } } });
    await store.appendEvent(task, { type: 'thread.forked', payload: { childThreadId: 'grandchild', harness: { threadId: 'grandchild', parentThreadId: 'child-a' } } });
    await store.appendEvent(task, { type: 'thread.closed', payload: { harness: { threadId: 'child-a' } } });

    const response = await request(api, `/tasks/${task.id}/thread-graph?root=root-thread`, { headers });
    assert.equal(response.status, 200);
    const body = await response.json() as {
      graph: { nodes: Array<{ threadId: string; state: string }>; edges: unknown[] };
      descendants: Array<{ threadId: string }>;
    };
    assert.deepEqual(body.descendants.map((node) => node.threadId), ['child-a', 'child-b', 'grandchild']);
    assert.equal(body.graph.nodes.find((node) => node.threadId === 'child-a')?.state, 'closed');
    assert.equal(body.graph.edges.length, 3);

    const missingRoot = await request(api, `/tasks/${task.id}/thread-graph?root=missing`, { headers });
    assert.equal(missingRoot.status, 404);
    const foreignTenant = await request(api, `/tasks/${task.id}/thread-graph`, {
      headers: { 'x-axiom-tenant-id': 'another-tenant', 'x-axiom-user-id': 'operator' },
    });
    assert.equal(foreignTenant.status, 404);
  } finally {
    await store.close();
  }
});

test('live guidance enforces identity boundaries and rejects terminal tasks', async () => {
  const store = new SqliteTaskStore(':memory:');
  await store.initialize();
  let nudges = 0;
  const api = createTaskApi({
    store,
    hub: new EventHub(),
    coordinator: { nudge() { nudges += 1; }, abort() {} } as never,
  });
  const ownerHeaders = { 'content-type': 'application/json', 'x-axiom-tenant-id': 'local', 'x-axiom-user-id': 'operator' };
  try {
    const running = await seedTask(store, 'running');
    const accepted = await request(api, `/tasks/${running.id}/guidance`, {
      method: 'POST', headers: ownerHeaders, body: JSON.stringify({ message: '先补充回归测试，再继续交付。' }),
    });
    assert.equal(accepted.status, 202);
    const body = await accepted.json() as { status: string; guidanceId: string; delivery: string };
    assert.equal(body.status, 'accepted');
    assert.equal(body.delivery, 'builtin-next-safe-point');
    assert.ok(body.guidanceId);
    assert.equal(nudges, 1);
    const events = await store.getEvents(running.id);
    assert.equal(events.filter((event) => event.type === 'human.guidance_accepted').length, 1);
    assert.equal(events.some((event) => event.type === 'human.guidance_applied'), false);

    const forbidden = await request(api, `/tasks/${running.id}/guidance`, {
      method: 'POST',
      headers: { ...ownerHeaders, 'x-axiom-user-id': 'another-user' },
      body: JSON.stringify({ message: '越权修改' }),
    });
    assert.equal(forbidden.status, 403);

    const hidden = await request(api, `/tasks/${running.id}/guidance`, {
      method: 'POST',
      headers: { ...ownerHeaders, 'x-axiom-tenant-id': 'another-tenant' },
      body: JSON.stringify({ message: '跨租户修改' }),
    });
    assert.equal(hidden.status, 404);

    const completed = await seedTask(store, 'completed');
    const terminal = await request(api, `/tasks/${completed.id}/guidance`, {
      method: 'POST', headers: ownerHeaders, body: JSON.stringify({ message: '结束后追加' }),
    });
    assert.equal(terminal.status, 409);
  } finally {
    await store.close();
  }
});

test('live guidance uses real Harness steering and reports unavailable steering honestly', async () => {
  const store = new SqliteTaskStore(':memory:');
  await store.initialize();
  const adapter = new ApiHarnessAdapter('codex');
  const api = createTaskApi({
    store,
    hub: new EventHub(),
    coordinator: { nudge() {}, abort() {} } as never,
    harnessAdapter: adapter,
  });
  const headers = { 'content-type': 'application/json', 'x-axiom-tenant-id': 'local', 'x-axiom-user-id': 'operator' };
  try {
    const delegated = await seedTask(store, 'paused');
    const started = await request(api, `/tasks/${delegated.id}/harness/start`, {
      method: 'POST', headers, body: JSON.stringify({ input: '由 Codex Harness 执行' }),
    });
    assert.equal(started.status, 202);

    const guided = await request(api, `/tasks/${delegated.id}/guidance`, {
      method: 'POST', headers, body: JSON.stringify({ message: '同时检查移动端布局。' }),
    });
    assert.equal(guided.status, 202);
    const guidedBody = await guided.json() as { status: string; delivery: string };
    assert.equal(guidedBody.status, 'applied');
    assert.equal(guidedBody.delivery, 'external-harness');
    assert.deepEqual(adapter.steered, ['同时检查移动端布局。']);
    const appliedEvents = await store.getEvents(delegated.id);
    assert.equal(appliedEvents.filter((event) => event.type === 'human.guidance_accepted').length, 1);
    assert.equal(appliedEvents.filter((event) => event.type === 'human.guidance_applied').length, 1);

    const unavailable = await seedTask(store, 'paused');
    const unavailableStart = await request(api, `/tasks/${unavailable.id}/harness/start`, {
      method: 'POST', headers, body: JSON.stringify({ input: '第二个外部任务' }),
    });
    assert.equal(unavailableStart.status, 202);
    adapter.steerAccepted = false;
    const rejected = await request(api, `/tasks/${unavailable.id}/guidance`, {
      method: 'POST', headers, body: JSON.stringify({ message: '这条不能伪装成已发送。' }),
    });
    assert.equal(rejected.status, 409);
    assert.equal((await store.getEvents(unavailable.id)).some((event) => event.type === 'human.guidance_accepted'), false);
  } finally {
    await store.close();
  }
});

test('checkpoint branches are idempotent, reject stale revisions, and merge explicit conflicts', async () => {
  const store = new SqliteTaskStore(':memory:');
  await store.initialize();
  let nudges = 0;
  const api = createTaskApi({
    store,
    hub: new EventHub(),
    coordinator: { nudge() { nudges += 1; }, abort() {} } as never,
  });
  const headers = { 'content-type': 'application/json', 'x-axiom-tenant-id': 'local', 'x-axiom-user-id': 'operator' };
  try {
    const seeded = await seedTask(store, 'completed');
    const baseResult = {
      stepId: 'step-1', agentId: 'analyst-step-1', role: 'analyst' as const, status: 'completed' as const,
      output: '基础结果', evidence: ['基础证据'], confidence: 0.8, attempts: 1, durationMs: 10,
    };
    const source = await store.updateTask(seeded.id, { stepResults: [baseResult] });
    const checkpointId = randomUUID();
    await store.appendEvent(source, {
      type: 'checkpoint.saved',
      payload: {
        checkpointId,
        stage: 'loop:1',
        revision: source.revision,
        planVersion: source.planVersion ?? 0,
        graphRevision: source.plan?.graph?.revision ?? 0,
        completedSteps: 1,
        failedSteps: 0,
        totalSteps: 1,
        snapshot: { plan: source.plan, stepResults: source.stepResults, review: source.review, result: source.result ?? null },
      },
    });

    const listed = await request(api, `/tasks/${source.id}/checkpoints`, { headers });
    assert.equal(listed.status, 200);
    const listedBody = await listed.json() as { currentRevision: number; checkpoints: Array<{ checkpointId: string; restorable: boolean }> };
    assert.equal(listedBody.currentRevision, source.revision);
    assert.equal(listedBody.checkpoints.length, 1);
    assert.equal(listedBody.checkpoints[0]?.checkpointId, checkpointId);
    assert.equal(listedBody.checkpoints[0]?.restorable, true);

    const operationId = randomUUID();
    const branchRequest = {
      expectedRevision: source.revision,
      operationId,
      instruction: '增加移动端验收。',
      behavior: 'continue',
    };
    const branched = await request(api, `/tasks/${source.id}/checkpoints/${checkpointId}/branch`, {
      method: 'POST', headers, body: JSON.stringify(branchRequest),
    });
    assert.equal(branched.status, 202);
    const branchedBody = await branched.json() as { task: WorkflowTask };
    assert.notEqual(branchedBody.task.id, source.id);
    assert.equal(branchedBody.task.stepResults[0]?.output, '基础结果');
    const branchEvents = await store.getEvents(branchedBody.task.id);
    assert.ok(branchEvents.some((event) => event.type === 'checkpoint.branch_created'));
    assert.ok(branchEvents.some((event) => event.type === 'human.guidance_accepted' && event.payload.message === '增加移动端验收。'));

    const idempotentRetry = await request(api, `/tasks/${source.id}/checkpoints/${checkpointId}/branch`, {
      method: 'POST', headers, body: JSON.stringify(branchRequest),
    });
    assert.equal(idempotentRetry.status, 200);
    assert.equal(((await idempotentRetry.json()) as { task: WorkflowTask }).task.id, branchedBody.task.id);

    const stale = await request(api, `/tasks/${source.id}/checkpoints/${checkpointId}/branch`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...branchRequest, operationId: randomUUID() }),
    });
    assert.equal(stale.status, 409);
    const staleBody = await stale.json() as { code: string; actualRevision: number };
    assert.equal(staleBody.code, 'TASK_REVISION_CONFLICT');
    assert.ok(staleBody.actualRevision > source.revision);

    const currentSource = await store.getTask(source.id, 'local');
    assert.ok(currentSource);
    const changedSource = await store.updateTask(source.id, {
      stepResults: [{ ...baseResult, output: '当前方案修改' }],
    }, currentSource.revision);
    const currentBranch = await store.getTask(branchedBody.task.id, 'local');
    assert.ok(currentBranch);
    await store.updateTask(currentBranch.id, {
      status: 'completed',
      stepResults: [{ ...baseResult, output: '分支方案修改' }],
    }, currentBranch.revision);

    const compared = await request(api, `/tasks/${source.id}/checkpoints/${checkpointId}/diff?targetTaskId=${branchedBody.task.id}`, { headers });
    assert.equal(compared.status, 200);
    const comparedBody = await compared.json() as { diff: { steps: { changed: string[] } } };
    assert.deepEqual(comparedBody.diff.steps.changed, ['step-1']);

    const mergeOperationId = randomUUID();
    const conflicted = await request(api, `/tasks/${source.id}/checkpoints/${checkpointId}/merge`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        expectedRevision: changedSource.revision,
        operationId: mergeOperationId,
        branchTaskId: branchedBody.task.id,
        strategy: 'manual',
      }),
    });
    assert.equal(conflicted.status, 409);
    const conflictBody = await conflicted.json() as { code: string; conflicts: string[] };
    assert.equal(conflictBody.code, 'CHECKPOINT_MERGE_CONFLICT');
    assert.deepEqual(conflictBody.conflicts, ['step-1']);

    const merged = await request(api, `/tasks/${source.id}/checkpoints/${checkpointId}/merge`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        expectedRevision: changedSource.revision,
        operationId: mergeOperationId,
        branchTaskId: branchedBody.task.id,
        strategy: 'prefer-branch',
      }),
    });
    assert.equal(merged.status, 202);
    const mergedBody = await merged.json() as { task: WorkflowTask; resolvedConflicts: string[] };
    assert.equal(mergedBody.task.stepResults[0]?.output, '分支方案修改');
    assert.deepEqual(mergedBody.resolvedConflicts, ['step-1']);
    assert.ok(nudges >= 2);
  } finally {
    await store.close();
  }
});

test('checkpoint APIs reject malformed task and checkpoint identifiers with 400 responses', async () => {
  const { store, api } = await createHarness();
  const headers = { 'content-type': 'application/json', 'x-axiom-tenant-id': 'local', 'x-axiom-user-id': 'operator' };
  try {
    const task = await seedTask(store, 'completed');
    const checkpointId = randomUUID();
    await store.appendEvent(task, {
      type: 'checkpoint.saved',
      payload: {
        checkpointId,
        stage: 'completed',
        revision: task.revision,
        planVersion: task.planVersion ?? 0,
        graphRevision: task.plan?.graph?.revision ?? 0,
        completedSteps: task.stepResults.length,
        failedSteps: 0,
        totalSteps: task.plan?.steps.length ?? 0,
        snapshot: { plan: task.plan, stepResults: task.stepResults, review: task.review, result: task.result ?? null },
      },
    });

    const malformedTask = await request(api, '/tasks/not-a-uuid/checkpoints', { headers });
    assert.equal(malformedTask.status, 400);

    const malformedDiffCheckpoint = await request(api, `/tasks/${task.id}/checkpoints/not-a-uuid/diff`, { headers });
    assert.equal(malformedDiffCheckpoint.status, 400);

    const malformedBranchCheckpoint = await request(api, `/tasks/${task.id}/checkpoints/not-a-uuid/branch`, {
      method: 'POST', headers, body: '{}',
    });
    assert.equal(malformedBranchCheckpoint.status, 400);

    const malformedMergeCheckpoint = await request(api, `/tasks/${task.id}/checkpoints/not-a-uuid/merge`, {
      method: 'POST', headers, body: '{}',
    });
    assert.equal(malformedMergeCheckpoint.status, 400);

    const malformedTarget = await request(api, `/tasks/${task.id}/checkpoints/${checkpointId}/diff?targetTaskId=not-a-uuid`, { headers });
    assert.equal(malformedTarget.status, 400);
  } finally {
    await store.close();
  }
});

test('runtime alerts combine durable operations with readiness without fabricating task state', async () => {
  const { store, api } = await createHarness();
  try {
    const response = await request(api, '/runtime/alerts?hours=72');
    assert.equal(response.status, 200);
    const body = await response.json() as {
      windowHours: number;
      summary: { critical: number; warning: number; info: number };
      alerts: Array<{ source: string; metric: string }>;
      readinessState?: string;
    };
    assert.equal(body.windowHours, 72);
    assert.ok(body.summary && Number.isInteger(body.summary.warning));
    assert.ok(Array.isArray(body.alerts));
    assert.equal(body.alerts.some((alert) => alert.source === 'queue' && alert.metric === 'queue.queued'), false);
    assert.ok(['ready', 'degraded', 'blocked'].includes(body.readinessState ?? 'degraded'));
  } finally {
    await store.close();
  }
});

test('runtime readiness reports the selected Codex transport instead of a stale DeepSeek probe', async () => {
  const store = new SqliteTaskStore(':memory:');
  await store.initialize();
  const adapter = new ApiHarnessAdapter('codex');
  const api = createTaskApi({
    store,
    hub: new EventHub(),
    coordinator: { nudge() {}, abort() {} } as never,
    harnessAdapter: adapter,
  });
  try {
    const response = await request(api, '/runtime/health');
    assert.equal(response.status, 200);
    const body = await response.json() as { harness?: { kind?: string; protocol?: string; active?: boolean } };
    assert.equal(body.harness?.kind, 'codex');
    assert.equal(body.harness?.protocol, 'codex-app-server/v2');
    assert.equal(body.harness?.active, true);

    const capabilities = await request(api, '/runtime/capabilities');
    assert.equal(capabilities.status, 200);
    const capabilityBody = await capabilities.json() as { harness?: { kind?: string; protocol?: string } };
    assert.equal(capabilityBody.harness?.kind, 'codex');
    assert.equal(capabilityBody.harness?.protocol, 'codex-app-server/v2');
  } finally {
    await store.close();
  }
});

test('external Harness approval keeps ownership with the sidecar and does not wake the built-in Worker', async () => {
  const store = new SqliteTaskStore(':memory:');
  await store.initialize();
  const adapter = new ApiHarnessAdapter();
  let nudges = 0;
  const api = createTaskApi({
    store,
    hub: new EventHub(),
    coordinator: { nudge() { nudges += 1; }, abort() {} } as never,
    harnessAdapter: adapter,
  });
  const headers = { 'content-type': 'application/json', 'x-axiom-tenant-id': 'local', 'x-axiom-user-id': 'operator' };
  try {
    const seeded = await seedTask(store, 'paused');
    const started = await request(api, `/tasks/${seeded.id}/harness/start`, {
      method: 'POST', headers, body: JSON.stringify({ input: 'external approval' }),
    });
    assert.equal(started.status, 202);

    const approval = {
      id: 'external-approval-1',
      signature: 'harness:external-approval-1',
      stepId: 'external-step',
      name: 'workspace.write',
      args: { path: 'release.md' },
      risk: 'high' as const,
      status: 'pending' as const,
      requestedAt: new Date().toISOString(),
    };
    await store.updateTask(seeded.id, { status: 'waiting_for_human', toolApprovals: [approval] });
    const response = await request(api, `/tasks/${seeded.id}/approve-tool`, {
      method: 'POST', headers, body: JSON.stringify({ approvalId: approval.id, note: 'operator confirmed' }),
    });
    assert.equal(response.status, 202);
    const body = await response.json() as { task: WorkflowTask };
    assert.equal(body.task.status, 'running');
    assert.equal(body.task.toolApprovals?.[0]?.status, 'approved');
    assert.equal(nudges, 0);
    const event = (await store.getEvents(seeded.id)).at(-1);
    assert.equal(event?.type, 'tool.approved');
    assert.equal(event?.payload.externalHarness, true);
  } finally {
    await store.close();
  }
});

test('webhook requires a fresh body signature and deduplicates retried deliveries', async () => {
  const previousSecret = process.env.AXIOM_WEBHOOK_SECRET;
  process.env.AXIOM_WEBHOOK_SECRET = 'webhook-integration-secret';
  const store = new SqliteTaskStore(':memory:');
  await store.initialize();
  let nudges = 0;
  const api = createTaskApi({
    store,
    hub: new EventHub(),
    coordinator: { nudge() { nudges += 1; }, abort() {} } as never,
  });
  const rawBody = JSON.stringify({ sessionId: 'webhook-session', input: '执行生产巡检', mode: 'analyze' });
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const idempotencyKey = 'delivery-integration-001';
  const tenantId = 'tenant-webhook';
  const userId = 'webhook-operator';
  const signature = signWebhookPayload({ timestamp, idempotencyKey, tenantId, userId, rawBody }, process.env.AXIOM_WEBHOOK_SECRET);
  const headers = {
    'content-type': 'application/json',
    'x-axiom-tenant-id': tenantId,
    'x-axiom-user-id': userId,
    'x-axiom-webhook-timestamp': timestamp,
    'x-axiom-webhook-signature': signature,
    'idempotency-key': idempotencyKey,
  };
  try {
    const accepted = await request(api, '/webhooks/tasks', { method: 'POST', headers, body: rawBody });
    assert.equal(accepted.status, 202);
    const first = await accepted.json() as { task: WorkflowTask; deduplicated: boolean };
    assert.equal(first.task.tenantId, tenantId);
    assert.equal(first.deduplicated, false);

    const retried = await request(api, '/webhooks/tasks', { method: 'POST', headers, body: rawBody });
    assert.equal(retried.status, 202);
    const second = await retried.json() as { task: WorkflowTask; deduplicated: boolean };
    assert.equal(second.task.id, first.task.id);
    assert.equal(second.deduplicated, true);
    assert.equal(nudges, 1);

    const tampered = await request(api, '/webhooks/tasks', { method: 'POST', headers, body: `${rawBody} ` });
    assert.equal(tampered.status, 401);

    const invalidJson = '{"sessionId":';
    const invalidSignature = signWebhookPayload({ timestamp, idempotencyKey: 'delivery-integration-002', tenantId, userId, rawBody: invalidJson }, process.env.AXIOM_WEBHOOK_SECRET);
    const invalid = await request(api, '/webhooks/tasks', {
      method: 'POST',
      headers: { ...headers, 'idempotency-key': 'delivery-integration-002', 'x-axiom-webhook-signature': invalidSignature },
      body: invalidJson,
    });
    assert.equal(invalid.status, 400);
  } finally {
    await store.close();
    if (previousSecret === undefined) delete process.env.AXIOM_WEBHOOK_SECRET;
    else process.env.AXIOM_WEBHOOK_SECRET = previousSecret;
  }
});

test('concurrent idempotent task creation resolves the database race to one task', async () => {
  const store = new SqliteTaskStore(':memory:');
  await store.initialize();
  const api = createTaskApi({
    store,
    hub: new EventHub(),
    coordinator: { nudge() {}, abort() {} } as never,
  });
  const headers = {
    'content-type': 'application/json',
    'x-axiom-tenant-id': 'tenant-idempotency-race',
    'x-axiom-user-id': 'user-idempotency-race',
    'idempotency-key': 'same-delivery-race',
  };
  const body = JSON.stringify({ sessionId: 'idempotency-race-session', input: '并发提交同一个任务', mode: 'analyze' });
  try {
    const responses = await Promise.all(Array.from({ length: 12 }, () => request(api, '/tasks', { method: 'POST', headers, body })));
    assert.ok(responses.every((response) => response.status === 202));
    const payloads = await Promise.all(responses.map((response) => response.json() as Promise<{ task: WorkflowTask; deduplicated?: boolean }>));
    const taskIds = new Set(payloads.map((payload) => payload.task.id));
    assert.equal(taskIds.size, 1);
    assert.equal(payloads.filter((payload) => payload.deduplicated === false).length, 1);
    assert.equal(payloads.filter((payload) => payload.deduplicated === true).length, 11);
    assert.equal((await store.listTasks('tenant-idempotency-race', 20)).length, 1);
  } finally {
    await store.close();
  }
});

test('task creation reports storage outages as service unavailable', async () => {
  const databaseDown = Object.assign(new Error('connect ECONNREFUSED database'), { code: 'ECONNREFUSED' });
  const store = {
    findTaskByIdempotency: async () => { throw databaseDown; },
  } as never;
  const api = createTaskApi({
    store,
    hub: new EventHub(),
    coordinator: { nudge() {}, abort() {} } as never,
  });
  const response = await request(api, '/tasks', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'storage-outage' },
    body: JSON.stringify({ sessionId: 'storage-outage-session', input: '测试存储故障', mode: 'analyze' }),
  });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: '任务存储暂时不可用，请稍后重试。' });
});

test('runtime skills endpoint exposes the routed skill catalog', async () => {
  const { store, api } = await createHarness();
  try {
    const response = await request(api, '/runtime/skills');
    assert.equal(response.status, 200);
    const payload = await response.json() as { skills?: Array<{ id: string; label: string; roles: string[] }> };
    assert.ok(Array.isArray(payload.skills));
    assert.ok(payload.skills?.some((skill) => skill.id === 'architecture-design'));
    assert.ok(payload.skills?.every((skill) => skill.label && Array.isArray(skill.roles)));
  } finally {
    await store.close();
  }
});

test('durable task creation validates and stores an encrypted model credential reference', async () => {
  const store = new SqliteTaskStore(':memory:');
  await store.initialize();
  let nudges = 0;
  const api = createTaskApi({
    store,
    hub: new EventHub(),
    coordinator: { nudge() { nudges += 1; }, abort() {} } as never,
    resolveModelCredential: async (credentialId, tenantId, userId) => credentialId === '11111111-1111-4111-8111-111111111111' && tenantId === 'tenant-credential' && userId === 'user-credential'
      ? { id: credentialId, model: 'local-fast-model' }
      : null,
  });
  const headers = { 'content-type': 'application/json', 'x-axiom-tenant-id': 'tenant-credential', 'x-axiom-user-id': 'user-credential' };
  try {
    const response = await request(api, '/tasks', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        sessionId: 'credential-session',
        title: '凭据任务',
        input: '执行一个可恢复的任务',
        mode: 'build',
        modelCredentialId: '11111111-1111-4111-8111-111111111111',
      }),
    });
    assert.equal(response.status, 202);
    const body = await response.json() as { task: WorkflowTask };
    assert.equal(body.task.model, 'local-fast-model');
    assert.equal(body.task.modelCredentialId, '11111111-1111-4111-8111-111111111111');
    assert.equal(nudges, 1);

    const denied = await request(api, '/tasks', {
      method: 'POST',
      headers,
      body: JSON.stringify({ sessionId: 'credential-session-2', input: '任务', mode: 'build', modelCredentialId: '22222222-2222-4222-8222-222222222222' }),
    });
    assert.equal(denied.status, 404);
  } finally {
    await store.close();
  }
});

test('conversation task creation persists the validated Router and Scheduler Agent plan', async () => {
  const { store, api } = await createHarness();
  try {
    const routing = {
      intent: 'task', execution: 'workflow', agentRole: 'orchestrator', workflowRoute: 'team', requiresSearch: false,
      reason: '分析与实现需要两个 Agent。', source: 'router-agent', skillIds: ['architecture-design', 'implementation'], routingVersion: 'router-scheduler/v1', routerModel: 'route-model',
      router: {
        intent: 'task', taskKind: 'implementation', difficulty: 'hard', requiresExternalFacts: false, requiredCapabilities: ['architecture', 'implementation'],
        candidateAgentIds: ['analyst', 'builder'], candidateSkillIds: ['architecture-design', 'implementation'], confidence: 0.92, rationale: '需要架构与实现能力。',
      },
      scheduler: {
        route: 'team', activeAgentIds: ['analyst', 'builder'], skippedAgentIds: ['search-agent'], appendAgentIds: ['analyst', 'builder'], selectedSkillIds: ['architecture-design', 'implementation'],
        executionWaves: [['architecture'], ['delivery']],
        steps: [
          { id: 'architecture', title: '架构分析', agentId: 'analyst', objective: '分析架构边界。', dependsOn: [], skillIds: ['architecture-design'] },
          { id: 'delivery', title: '实现计划', agentId: 'builder', objective: '形成实现和测试计划。', dependsOn: ['architecture'], skillIds: ['implementation'] },
        ],
        requiresReview: false, synthesisAgentId: 'synthesizer', reason: '按依赖分两波执行。',
      },
    };
    const response = await request(api, '/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'router-session', title: '路由计划持久化', input: '一个很短的输入', mode: 'build', routing }),
    });
    assert.equal(response.status, 202);
    const body = await response.json() as { task: WorkflowTask };
    assert.equal(body.task.plan?.profile?.route, 'team');
    assert.deepEqual(body.task.plan?.steps.map((step) => step.role), ['analyst', 'builder']);
    assert.equal(body.task.plan?.routingDecision?.confidence, 0.92);
    assert.deepEqual(body.task.plan?.schedulingDecision?.activeAgentIds, ['analyst', 'builder']);
    assert.equal(body.task.plan?.routingVersion, 'router-scheduler/v1');
    const created = (await store.getEvents(body.task.id)).find((event) => event.type === 'task.created');
    assert.equal(created?.payload.source, 'conversation');
    assert.deepEqual(created?.payload.activeAgentIds, ['analyst', 'builder']);
  } finally {
    await store.close();
  }
});

test('memory maintenance APIs derive isolation from the principal and protect L2/L3 writes', async () => {
  const store = new SqliteTaskStore(':memory:');
  const receiptStore = new SqliteMemoryCaptureReceiptStore(':memory:');
  await store.initialize();
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const memory = new TencentMemoryClient({
    endpoint: 'http://memory.test',
    receiptStore,
    fetcher: async (input, init) => {
      const path = new URL(String(input)).pathname;
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      requests.push({ path, body });
      return new Response(JSON.stringify({ code: 0, message: 'ok', data: path.includes('/atomic/')
        ? { id: body.id, version: 'v2', updated_at: '2026-08-29T00:00:00.000Z' }
        : { version: 'v2', updated_at: '2026-08-29T00:00:00.000Z' } }), { status: 200 });
    },
  });
  await memory.initialize();
  const api = createTaskApi({ store, hub: new EventHub(), coordinator: { nudge() {}, abort() {} } as never, memory });
  try {
    const memberHeaders = {
      'content-type': 'application/json',
      'x-axiom-tenant-id': 'tenant-memory-a',
      'x-axiom-user-id': 'user-memory-a',
    };
    const atomic = await request(api, '/memory/atomic/memory-1', {
      method: 'PATCH', headers: memberHeaders,
      body: JSON.stringify({ agentId: 'planner', content: '更新后的偏好' }),
    });
    assert.equal(atomic.status, 200);
    assert.equal(requests[0]?.body.team_id, 'tenant-memory-a');
    assert.equal(requests[0]?.body.user_id, 'user-memory-a');
    assert.equal(requests[0]?.body.agent_id, 'planner');

    const forbiddenCore = await request(api, '/memory/core', {
      method: 'PUT', headers: memberHeaders,
      body: JSON.stringify({ agentId: 'planner', content: '核心画像' }),
    });
    assert.equal(forbiddenCore.status, 403);
    assert.equal(requests.length, 1);

    const previousSecret = process.env.AXIOM_PRINCIPAL_SECRET;
    process.env.AXIOM_PRINCIPAL_SECRET = 'memory-api-test-secret';
    try {
      const signed = signPrincipal({ tenantId: 'tenant-admin', userId: 'owner-a', role: 'owner' });
      const separator = signed.lastIndexOf('.');
      const adminCore = await request(api, '/memory/core', {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          'x-axiom-principal': signed.slice(0, separator),
          'x-axiom-principal-signature': signed.slice(separator + 1),
        },
        body: JSON.stringify({ agentId: 'planner', content: '管理员确认的核心画像' }),
      });
      assert.equal(adminCore.status, 200);
      assert.equal(requests[1]?.body.team_id, 'tenant-admin');
      assert.equal(requests[1]?.body.user_id, 'owner-a');
    } finally {
      if (previousSecret === undefined) delete process.env.AXIOM_PRINCIPAL_SECRET;
      else process.env.AXIOM_PRINCIPAL_SECRET = previousSecret;
    }
  } finally {
    await memory.close();
    await store.close();
  }
});

test('plugin design Agent creates a validated persisted draft with the selected model provider', async () => {
  const store = new SqliteTaskStore(':memory:');
  const plugins = new SqlitePluginStore(':memory:');
  await store.initialize();
  await plugins.initialize();
  let selectedProvider: Record<string, unknown> | undefined;
  const designModel: ModelClient = {
    model: 'local-designer',
    async complete(_request: ModelCompletionRequest) {
      return {
        content: JSON.stringify({
          name: '周报整理',
          description: '把零散进展整理成结构化周报',
          mode: 'analyze',
          promptPrefix: '整理输入内容，提取进展、风险和下一步，并输出 Markdown 周报。',
          toolNames: ['不存在的工具'],
          fields: [{ label: '本周进展', type: 'textarea', required: true }],
        }),
        attempts: 1,
        durationMs: 12,
      };
    },
  };
  const api = createTaskApi({
    store,
    plugins,
    hub: new EventHub(),
    coordinator: { nudge() {}, abort() {} } as never,
    pluginModelFactory: (provider) => {
      selectedProvider = provider;
      return designModel;
    },
  });
  try {
    const response = await request(api, '/plugins/agent-create', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-axiom-tenant-id': 'tenant-plugin', 'x-axiom-user-id': 'author-plugin' },
      body: JSON.stringify({
        goal: '创建一个把每周工作进展整理成结构化周报的插件',
        visibility: 'private',
        provider: { apiUrl: 'http://127.0.0.1:11434/v1', apiKey: '', model: 'local-designer', location: 'local' },
      }),
    });
    assert.equal(response.status, 201);
    const body = await response.json() as { plugin: { id: string; status: string; kind: string; definition: { toolNames?: string[]; inputSchema?: { fields: Array<{ id: string; label: string }> } } }; generatedBy: { agent: string; model: string } };
    assert.equal(body.plugin.status, 'draft');
    assert.equal(body.plugin.kind, 'prompt');
    assert.deepEqual(body.plugin.definition.toolNames, []);
    assert.deepEqual(body.plugin.definition.inputSchema?.fields, [{ id: 'field-1', label: '本周进展', type: 'textarea', required: true }]);
    assert.equal(body.generatedBy.agent, 'plugin-designer');
    assert.equal(body.generatedBy.model, 'local-designer');
    assert.equal(selectedProvider?.location, 'local');
    assert.equal((await plugins.listPlugins('tenant-plugin')).length, 1);
  } finally {
    await plugins.close();
    await store.close();
  }
});

test('mini-app builder Agent persists full revisions and owners can permanently delete the plugin', async () => {
  const store = new SqliteTaskStore(':memory:');
  const plugins = new SqlitePluginStore(':memory:');
  await store.initialize();
  await plugins.initialize();
  const designModel: ModelClient = {
    model: 'mini-app-designer',
    async complete() {
      return {
        content: JSON.stringify({
          name: '实时天气',
          description: '通过平台搜索 Agent 查询天气',
          htmlContent: '<!doctype html><html><body><button id="weather">查询天气</button></body></html>',
          agentEnabled: true,
          agentInstructions: '查询实时天气并标明数据时间。',
          summary: '已完成天气查询界面并接入平台 Agent。',
        }),
        attempts: 1,
        durationMs: 18,
      };
    },
  };
  const api = createTaskApi({
    store,
    plugins,
    hub: new EventHub(),
    coordinator: { nudge() {}, abort() {} } as never,
    pluginModelFactory: () => designModel,
  });
  const headers = { 'content-type': 'application/json', 'x-axiom-tenant-id': 'tenant-mini', 'x-axiom-user-id': 'owner-mini' };
  try {
    const createdResponse = await request(api, '/plugins', {
      method: 'POST', headers,
      body: JSON.stringify({
        name: '空白天气', description: '', kind: 'mini-app', visibility: 'private',
        definition: {
          mode: 'build', htmlContent: '<!doctype html><html><body>空白</body></html>', width: 720, height: 520,
          appearance: { effect: 'aurora', hue: 142, seed: 18 }, agentEnabled: false,
        },
      }),
    });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json() as { plugin: { id: string } };
    const editResponse = await request(api, `/plugins/${created.plugin.id}/agent-edit`, {
      method: 'POST', headers,
      body: JSON.stringify({ instruction: '做成实时天气插件并使用平台搜索 Agent' }),
    });
    assert.equal(editResponse.status, 200);
    const edited = await editResponse.json() as { plugin: { id: string; name: string; version: number; definition: { htmlContent: string; agentEnabled?: boolean; appearance?: { effect: string }; designConversation?: unknown[] } }; message: string };
    assert.equal(edited.plugin.name, '实时天气');
    assert.equal(edited.plugin.version, 2);
    assert.equal(edited.plugin.definition.agentEnabled, true);
    assert.equal(edited.plugin.definition.appearance?.effect, 'aurora');
    assert.equal(edited.plugin.definition.designConversation?.length, 2);
    assert.match(edited.plugin.definition.htmlContent, /查询天气/);
    assert.match(edited.message, /平台 Agent/);

    const deniedDelete = await request(api, `/plugins/${created.plugin.id}`, {
      method: 'DELETE',
      headers: { 'x-axiom-tenant-id': 'tenant-mini', 'x-axiom-user-id': 'other-user' },
    });
    assert.equal(deniedDelete.status, 403);
    const deleteResponse = await request(api, `/plugins/${created.plugin.id}`, { method: 'DELETE', headers });
    assert.equal(deleteResponse.status, 204);
    assert.equal(await plugins.getPlugin(created.plugin.id, 'tenant-mini'), null);
  } finally {
    await plugins.close();
    await store.close();
  }
});

test('plugin release API validates compatibility, records publish evidence, and restores a historical version', async () => {
  const store = new SqliteTaskStore(':memory:');
  const plugins = new SqlitePluginStore(':memory:');
  await store.initialize();
  await plugins.initialize();
  const api = createTaskApi({
    store,
    plugins,
    hub: new EventHub(),
    coordinator: { nudge() {}, abort() {} } as never,
  });
  const headers = { 'content-type': 'application/json', 'x-axiom-tenant-id': 'tenant-plugin-release', 'x-axiom-user-id': 'owner-plugin-release' };
  try {
    const createdResponse = await request(api, '/plugins', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: '版本插件', description: '第一版', kind: 'prompt', visibility: 'private',
        definition: { mode: 'analyze', promptPrefix: '分析输入并给出结论。', toolNames: [] },
      }),
    });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json() as { plugin: { id: string } };

    const compatibility = await request(api, `/plugins/${created.plugin.id}/compatibility`, { headers });
    assert.equal(compatibility.status, 200);
    assert.equal(((await compatibility.json()) as { report: { compatible: boolean } }).report.compatible, true);

    const unsafePublish = await request(api, `/plugins/${created.plugin.id}`, {
      method: 'PATCH', headers, body: JSON.stringify({ status: 'published' }),
    });
    assert.equal(unsafePublish.status, 409);

    const publish = await request(api, `/plugins/${created.plugin.id}/publish`, { method: 'POST', headers });
    assert.equal(publish.status, 200);
    const published = await publish.json() as { plugin: { status: string; version: number; release?: { integrity: string } }; report: { releaseState: string } };
    assert.equal(published.plugin.status, 'published');
    assert.match(published.plugin.release?.integrity ?? '', /^sha256:/);
    assert.equal(published.report.releaseState, 'unsigned');

    const promptLaunch = await request(api, `/plugins/${created.plugin.id}/launch`, { method: 'POST', headers });
    assert.equal(promptLaunch.status, 409);

    const edit = await request(api, `/plugins/${created.plugin.id}`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ description: '第二版', definition: { mode: 'build', promptPrefix: '生成可执行结果。', toolNames: [] } }),
    });
    assert.equal(edit.status, 200);
    const edited = await edit.json() as { plugin: { status: string; version: number; release?: unknown } };
    assert.equal(edited.plugin.version, 2);
    assert.equal(edited.plugin.status, 'draft');
    assert.equal(edited.plugin.release, undefined);

    const deniedRollback = await request(api, `/plugins/${created.plugin.id}/rollback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-axiom-tenant-id': 'tenant-plugin-release', 'x-axiom-user-id': 'other-user' },
      body: JSON.stringify({ version: 1 }),
    });
    assert.equal(deniedRollback.status, 403);

    const rollback = await request(api, `/plugins/${created.plugin.id}/rollback`, {
      method: 'POST', headers, body: JSON.stringify({ version: 1 }),
    });
    assert.equal(rollback.status, 200);
    const restored = await rollback.json() as { plugin: { status: string; version: number; description: string; definition: { mode: string } } };
    assert.equal(restored.plugin.version, 3);
    assert.equal(restored.plugin.status, 'draft');
    assert.equal(restored.plugin.description, '第一版');
    assert.equal(restored.plugin.definition.mode, 'analyze');
  } finally {
    await plugins.close();
    await store.close();
  }
});

test('mini-app launch reloads the current version and fails closed when release evidence is invalid', async () => {
  const store = new SqliteTaskStore(':memory:');
  const plugins = new SqlitePluginStore(':memory:');
  await store.initialize();
  await plugins.initialize();
  const api = createTaskApi({
    store,
    plugins,
    hub: new EventHub(),
    coordinator: { nudge() {}, abort() {} } as never,
  });
  const headers = { 'content-type': 'application/json', 'x-axiom-tenant-id': 'tenant-mini-launch', 'x-axiom-user-id': 'owner-mini-launch' };
  try {
    const createdResponse = await request(api, '/plugins', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: '启动校验', description: 'Mini App', kind: 'mini-app', visibility: 'private',
        definition: { mode: 'build', htmlContent: '<!doctype html><html><body>ready</body></html>', toolNames: [] },
      }),
    });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json() as { plugin: { id: string } };

    const preview = await request(api, `/plugins/${created.plugin.id}/launch`, { method: 'POST', headers });
    assert.equal(preview.status, 200);
    assert.equal(((await preview.json()) as { mode: string }).mode, 'preview');

    const publish = await request(api, `/plugins/${created.plugin.id}/publish`, { method: 'POST', headers });
    assert.equal(publish.status, 200);
    const launched = await request(api, `/plugins/${created.plugin.id}/launch`, { method: 'POST', headers });
    assert.equal(launched.status, 200);
    const launchPayload = await launched.json() as { mode: string; report: { compatible: boolean } };
    assert.equal(launchPayload.mode, 'run');
    assert.equal(launchPayload.report.compatible, true);

    const current = await plugins.getPlugin(created.plugin.id, 'tenant-mini-launch');
    assert.ok(current);
    await plugins.publishPlugin(current.id, current.tenantId, {
      schemaVersion: 1,
      platformVersion: '1.1.0',
      pluginVersion: current.version,
      integrity: 'sha256:invalid',
      signedAt: '2026-09-03T00:00:00.000Z',
      signedBy: 'owner-mini-launch',
      permissions: [],
      warnings: [],
    });
    const rejected = await request(api, `/plugins/${created.plugin.id}/launch`, { method: 'POST', headers });
    assert.equal(rejected.status, 409);
    assert.equal(((await rejected.json()) as { report: { releaseState: string } }).report.releaseState, 'invalid');
  } finally {
    await plugins.close();
    await store.close();
  }
});

test('plugin market requires admin review, pins installations, and blocks revoked releases', async () => {
  const store = new SqliteTaskStore(':memory:');
  const plugins = new SqlitePluginStore(':memory:');
  await store.initialize();
  await plugins.initialize();
  const api = createTaskApi({
    store,
    plugins,
    hub: new EventHub(),
    coordinator: { nudge() {}, abort() {} } as never,
  });
  const previousSecret = process.env.AXIOM_PRINCIPAL_SECRET;
  process.env.AXIOM_PRINCIPAL_SECRET = 'plugin-market-test-secret';
  const authorHeaders = { 'content-type': 'application/json', 'x-axiom-tenant-id': 'tenant-market-api', 'x-axiom-user-id': 'publisher' };
  const memberHeaders = { 'content-type': 'application/json', 'x-axiom-tenant-id': 'tenant-market-api', 'x-axiom-user-id': 'member' };
  const signedAdmin = signPrincipal({ tenantId: 'tenant-market-api', userId: 'admin', role: 'admin' });
  const separator = signedAdmin.lastIndexOf('.');
  const adminHeaders = {
    'content-type': 'application/json',
    'x-axiom-principal': signedAdmin.slice(0, separator),
    'x-axiom-principal-signature': signedAdmin.slice(separator + 1),
  };
  try {
    const createdResponse = await request(api, '/plugins', {
      method: 'POST', headers: authorHeaders,
      body: JSON.stringify({
        name: '市场天气', description: '已审核天气小程序', kind: 'mini-app', visibility: 'team',
        definition: { mode: 'analyze', htmlContent: '<!doctype html><html><body>weather v1</body></html>', toolNames: [] },
      }),
    });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json() as { plugin: { id: string } };
    assert.equal((await request(api, `/plugins/${created.plugin.id}/publish`, { method: 'POST', headers: authorHeaders })).status, 200);
    const submitted = await request(api, `/plugins/${created.plugin.id}/market-submit`, { method: 'POST', headers: authorHeaders });
    assert.equal(submitted.status, 202);
    assert.equal(((await submitted.json()) as { release: { status: string } }).release.status, 'pending');

    const deniedReview = await request(api, `/plugins/${created.plugin.id}/market-review`, {
      method: 'POST', headers: memberHeaders, body: JSON.stringify({ version: 1, decision: 'approved' }),
    });
    assert.equal(deniedReview.status, 403);
    const reviewQueue = await request(api, '/plugins/market/reviews', { headers: adminHeaders });
    assert.equal(reviewQueue.status, 200);
    assert.equal(((await reviewQueue.json()) as { releases: unknown[] }).releases.length, 1);
    const approved = await request(api, `/plugins/${created.plugin.id}/market-review`, {
      method: 'POST', headers: adminHeaders, body: JSON.stringify({ version: 1, decision: 'approved', note: '结构与权限已复核' }),
    });
    assert.equal(approved.status, 200);

    const catalog = await request(api, '/plugins/market/catalog?q=天气', { headers: memberHeaders });
    assert.equal(catalog.status, 200);
    assert.equal(((await catalog.json()) as { entries: unknown[] }).entries.length, 1);
    const install = await request(api, `/plugins/${created.plugin.id}/install`, { method: 'POST', headers: memberHeaders });
    assert.equal(install.status, 201);
    assert.equal(((await install.json()) as { installation: { pluginVersion: number } }).installation.pluginVersion, 1);

    const authorEdit = await request(api, `/plugins/${created.plugin.id}`, {
      method: 'PATCH', headers: authorHeaders,
      body: JSON.stringify({ description: '尚未审核的 v2', definition: { mode: 'analyze', htmlContent: '<!doctype html><html><body>weather v2</body></html>', toolNames: [] } }),
    });
    assert.equal(authorEdit.status, 200);
    const installedLaunch = await request(api, `/plugins/${created.plugin.id}/launch`, { method: 'POST', headers: memberHeaders });
    assert.equal(installedLaunch.status, 200);
    const launchBody = await installedLaunch.json() as { plugin: { version: number; description: string }; installed: boolean };
    assert.equal(launchBody.plugin.version, 1);
    assert.equal(launchBody.installed, true);

    const revoked = await request(api, `/plugins/${created.plugin.id}/market-revoke`, {
      method: 'POST', headers: authorHeaders, body: JSON.stringify({ version: 1, note: '发现质量问题' }),
    });
    assert.equal(revoked.status, 200);
    const blockedLaunch = await request(api, `/plugins/${created.plugin.id}/launch`, { method: 'POST', headers: memberHeaders });
    assert.equal(blockedLaunch.status, 409);
    assert.match(((await blockedLaunch.json()) as { error: string }).error, /已被撤回/);
    assert.equal((await request(api, `/plugins/${created.plugin.id}/install`, { method: 'DELETE', headers: memberHeaders })).status, 204);
  } finally {
    if (previousSecret === undefined) delete process.env.AXIOM_PRINCIPAL_SECRET;
    else process.env.AXIOM_PRINCIPAL_SECRET = previousSecret;
    await plugins.close();
    await store.close();
  }
});

test('mini-app builder SSE streams immediate status and progress before persisting a complete revision', async () => {
  const store = new SqliteTaskStore(':memory:');
  const plugins = new SqlitePluginStore(':memory:');
  await store.initialize();
  await plugins.initialize();
  let deltaCalls = 0;
  const designModel: ModelClient = {
    model: 'mini-app-stream-designer',
    async complete(request: ModelCompletionRequest) {
      await request.onDelta?.({ content: 'x'.repeat(600) });
      await request.onDelta?.({ content: 'y'.repeat(600) });
      deltaCalls += 2;
      return {
        content: JSON.stringify({
          htmlContent: '<!doctype html><html><body><main>Streaming app</main></body></html>',
          agentEnabled: false,
          summary: '已完成流式插件更新。',
        }),
        attempts: 1,
        durationMs: 20,
      };
    },
  };
  const api = createTaskApi({
    store,
    plugins,
    hub: new EventHub(),
    coordinator: { nudge() {}, abort() {} } as never,
    pluginModelFactory: () => designModel,
  });
  const unconfiguredApi = createTaskApi({
    store,
    plugins,
    hub: new EventHub(),
    coordinator: { nudge() {}, abort() {} } as never,
  });
  const headers = { 'content-type': 'application/json', 'x-axiom-tenant-id': 'tenant-stream', 'x-axiom-user-id': 'owner-stream' };
  try {
    const createdResponse = await request(api, '/plugins', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: '流式插件', description: '', kind: 'mini-app', visibility: 'private',
        definition: {
          mode: 'build', htmlContent: '<!doctype html><html><body>空白</body></html>', width: 720, height: 520,
          appearance: { effect: 'aurora', hue: 142, seed: 21 }, agentEnabled: false,
        },
      }),
    });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json() as { plugin: { id: string } };

    const denied = await request(api, `/plugins/${created.plugin.id}/agent-edit/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-axiom-tenant-id': 'tenant-stream', 'x-axiom-user-id': 'other-stream' },
      body: JSON.stringify({ instruction: '修改界面' }),
    });
    assert.equal(denied.status, 403);

    const unconfigured = await request(unconfiguredApi, `/plugins/${created.plugin.id}/agent-edit/stream`, {
      method: 'POST', headers, body: JSON.stringify({ instruction: '修改界面' }),
    });
    assert.equal(unconfigured.status, 503);

    const response = await request(api, `/plugins/${created.plugin.id}/agent-edit/stream`, {
      method: 'POST', headers, body: JSON.stringify({ instruction: '增加一个流式状态面板' }),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
    const body = await response.text();
    const blocks = body.split('\n\n').filter(Boolean);
    const events = blocks.map((block) => block.match(/^event:\s*([^\r\n]+)/m)?.[1]).filter(Boolean);
    assert.equal(events[0], 'status');
    assert.ok(events.includes('progress'));
    assert.equal(events.at(-1), 'complete');
    assert.equal(deltaCalls, 2);
    const completeBlock = blocks.find((block) => /^event:\s*complete/m.test(block));
    assert.ok(completeBlock);
    const completeData = completeBlock!.match(/^data:\s*(.+)$/m)?.[1];
    assert.ok(completeData);
    const complete = JSON.parse(completeData!) as { plugin: { version: number; definition: { htmlContent: string } } };
    assert.equal(complete.plugin.version, 2);
    assert.match(complete.plugin.definition.htmlContent, /Streaming app/);
    assert.equal((await plugins.getPlugin(created.plugin.id, 'tenant-stream'))?.version, 2);
  } finally {
    await plugins.close();
    await store.close();
  }
});

test('visual Agent workflows stay separate from templates and enqueue their compiled plan', async () => {
  const store = new SqliteTaskStore(':memory:');
  const templates = new SqliteTemplateStore(':memory:');
  const businessCapabilities = new SqliteBusinessCapabilityStore(':memory:');
  const artifactCatalog = new SqliteArtifactCatalog(':memory:');
  await store.initialize();
  await templates.initialize();
  await businessCapabilities.initialize();
  await artifactCatalog.initialize();
  let nudges = 0;
  const deletedArtifacts: string[] = [];
  const storedArtifacts = new Map<string, string>();
  const storedBinaryArtifacts = new Map<string, Uint8Array>();
  const artifactStore = {
    kind: 'filesystem' as const,
    async put(id: string, content: string, tenantId?: string) { storedArtifacts.set(`${tenantId ?? ''}:${id}`, content); return { key: id, bytes: Buffer.byteLength(content, 'utf8') }; },
    async get(id: string, tenantId?: string) { return storedArtifacts.get(`${tenantId ?? ''}:${id}`) ?? null; },
    async putBinary(id: string, content: Uint8Array, tenantId?: string) { storedBinaryArtifacts.set(`${tenantId ?? ''}:${id}`, Uint8Array.from(content)); return { key: `${id}.bin`, bytes: content.byteLength }; },
    async getBinary(id: string, tenantId?: string) { return storedBinaryArtifacts.get(`${tenantId ?? ''}:${id}`) ?? null; },
    async delete(id: string, tenantId?: string) { storedArtifacts.delete(`${tenantId ?? ''}:${id}`); deletedArtifacts.push(id); },
    async health() { return { configured: true, reachable: true, detail: 'test' }; },
  };
  const api = createTaskApi({
    store,
    templates,
    businessCapabilities,
    artifactStore,
    artifactCatalog,
    hub: new EventHub(),
    coordinator: { nudge() { nudges += 1; }, abort() {} } as never,
  });
  const headers = { 'content-type': 'application/json', 'x-axiom-tenant-id': 'tenant-workflow', 'x-axiom-user-id': 'workflow-owner' };
  const canvas = {
    schemaVersion: 1,
    nodes: [
      { id: 'input', type: 'input', name: '输入', position: { x: 0, y: 100 } },
      {
        id: 'describe', type: 'agent', name: '绘图描述', position: { x: 240, y: 100 },
        agentRef: { source: 'workflow', id: 'prompt-agent' }, objective: '生成绘图描述', acceptanceCriteria: ['描述完整'], toolNames: [],
      },
      {
        id: 'draw', type: 'agent', name: '绘图', position: { x: 480, y: 100 },
        agentRef: { source: 'builtin', id: 'builder' }, objective: '生成图像结果', acceptanceCriteria: ['结果可交付'], toolNames: [],
      },
      { id: 'output', type: 'output', name: '输出', position: { x: 720, y: 100 } },
    ],
    edges: [
      { id: 'e1', source: 'input', target: 'describe', kind: 'flow' },
      { id: 'e2', source: 'describe', target: 'draw', kind: 'flow' },
      { id: 'e3', source: 'draw', target: 'output', kind: 'flow' },
    ],
    scopedAgents: [{
      id: 'prompt-agent', roleId: 'image-prompt-agent', name: '绘图描述 Agent', description: '',
      systemPromptTemplate: '把用户输入转换成专业绘图提示。', toolAllowlist: [], failureStrategy: 'retry',
    }],
  };
  try {
    const validate = await request(api, '/workflows/validate', { method: 'POST', headers, body: JSON.stringify(canvas) });
    assert.equal(validate.status, 200);
    assert.equal((await validate.json() as { valid: boolean }).valid, true);

    const createdResponse = await request(api, '/workflows', {
      method: 'POST', headers,
      body: JSON.stringify({ name: '绘图流水线', description: '描述后绘图', visibility: 'private', canvas }),
    });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json() as { workflow: { id: string; status: string; definition: { kind: string; plan: { steps: Array<{ agentContract?: { source: string; systemPromptTemplate?: string } }> } } } };
    assert.equal(created.workflow.status, 'draft');
    assert.equal(created.workflow.definition.kind, 'agent-workflow');
    assert.equal(created.workflow.definition.plan.steps[0]?.agentContract?.source, 'workflow');
    assert.match(created.workflow.definition.plan.steps[0]?.agentContract?.systemPromptTemplate ?? '', /专业绘图提示/);

    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    const uploadedResponse = await request(api, `/capabilities/nexus/${created.workflow.id}/artifacts`, {
      method: 'POST', headers,
      body: JSON.stringify({ name: '参考图.png', mimeType: 'image/png', dataBase64: png.toString('base64') }),
    });
    assert.equal(uploadedResponse.status, 201);
    const uploaded = (await uploadedResponse.json() as { artifact: { id: string; data: { artifactId: string; storageEncoding: string; digest: string } } }).artifact;
    assert.equal(uploaded.data.storageEncoding, 'binary');
    assert.equal(uploaded.data.digest, createHash('sha256').update(png).digest('hex'));
    assert.ok(storedBinaryArtifacts.has(`tenant-workflow:${uploaded.data.artifactId}`));
    const downloadedResponse = await request(api, `/capabilities/nexus/${created.workflow.id}/artifacts/${uploaded.id}`, { headers });
    assert.equal(downloadedResponse.status, 200);
    assert.equal((await downloadedResponse.json() as { dataUrl: string }).dataUrl, `data:image/png;base64,${png.toString('base64')}`);

    await artifactStore.put('result:existing', '# 已有交付', 'tenant-workflow');
    await artifactCatalog.register({ id: 'result:existing', tenantId: 'tenant-workflow', taskId: 'existing-task', source: 'result', bytes: 16, mimeType: 'text/markdown', referenceKey: 'result' });
    const reusableResponse = await request(api, '/runtime/artifacts?limit=10', { headers });
    assert.equal(reusableResponse.status, 200);
    const reusableArtifactIds = (await reusableResponse.json() as { artifacts: Array<{ id: string }> }).artifacts.map((artifact) => artifact.id);
    assert.ok(reusableArtifactIds.includes('result:existing'));
    assert.ok(reusableArtifactIds.includes(uploaded.data.artifactId));
    const linkedResponse = await request(api, `/capabilities/nexus/${created.workflow.id}/artifacts/link`, {
      method: 'POST', headers, body: JSON.stringify({ artifactId: 'result:existing', name: '已有交付' }),
    });
    assert.equal(linkedResponse.status, 201);
    const duplicateLink = await request(api, `/capabilities/nexus/${created.workflow.id}/artifacts/link`, {
      method: 'POST', headers, body: JSON.stringify({ artifactId: 'result:existing', name: '重复绑定' }),
    });
    assert.equal(duplicateLink.status, 200);
    assert.equal((await duplicateLink.json() as { idempotent: boolean }).idempotent, true);
    const linkedArtifacts = await request(api, `/capabilities/nexus/${created.workflow.id}/artifacts`, { headers });
    assert.equal((await linkedArtifacts.json() as { artifacts: unknown[] }).artifacts.length, 2);
    const crossTenantLink = await request(api, `/capabilities/nexus/${created.workflow.id}/artifacts/link`, {
      method: 'POST', headers: { ...headers, 'x-axiom-tenant-id': 'other-tenant' }, body: JSON.stringify({ artifactId: 'result:existing' }),
    });
    assert.equal(crossTenantLink.status, 404);

    const templateList = await request(api, '/templates', { headers });
    assert.equal((await templateList.json() as { templates: unknown[] }).templates.length, 0);
    const workflowList = await request(api, '/workflows', { headers });
    assert.equal((await workflowList.json() as { workflows: unknown[] }).workflows.length, 1);

    const draftRunResponse = await request(api, `/workflows/${created.workflow.id}/run`, {
      method: 'POST', headers,
      body: JSON.stringify({ sessionId: 'workflow-session', input: '画一座雨夜中的未来城市' }),
    });
    assert.equal(draftRunResponse.status, 409);

    const testCaseResponse = await request(api, `/capabilities/nexus/${created.workflow.id}/tests`, {
      method: 'POST', headers,
      body: JSON.stringify({ name: '绘图验收', input: '生成一张测试图', expectedIncludes: ['绘图测试通过'] }),
    });
    assert.equal(testCaseResponse.status, 201);
    const testRunResponse = await request(api, `/capabilities/nexus/${created.workflow.id}/test-run`, { method: 'POST', headers });
    assert.equal(testRunResponse.status, 202);
    const testRunBody = await testRunResponse.json() as { runs: Array<{ taskId: string; artifactSetDigest: string }> };
    assert.equal(testRunBody.runs.length, 1);
    assert.match(testRunBody.runs[0]!.artifactSetDigest, /^[a-f0-9]{64}$/u);
    await store.updateTask(testRunBody.runs[0]!.taskId, { status: 'completed', result: '绘图测试通过' });
    const testRunsResponse = await request(api, `/capabilities/nexus/${created.workflow.id}/test-runs`, { headers });
    assert.equal(testRunsResponse.status, 200);
    assert.equal((await testRunsResponse.json() as { runs: Array<{ status: string }> }).runs[0]?.status, 'passed');
    const releaseResponse = await request(api, `/capabilities/nexus/${created.workflow.id}/releases`, {
      method: 'POST', headers, body: JSON.stringify({ note: '首个稳定版本' }),
    });
    assert.equal(releaseResponse.status, 201);
    const firstRelease = (await releaseResponse.json() as { release: { id: string; data: { artifacts: Array<{ artifactId: string }>; artifactSetDigest: string } } }).release;
    assert.equal(firstRelease.data.artifacts.length, 2);
    assert.equal(firstRelease.data.artifactSetDigest, testRunBody.runs[0]!.artifactSetDigest);

    const changedAttachment = await request(api, `/capabilities/nexus/${created.workflow.id}/artifacts`, {
      method: 'POST', headers,
      body: JSON.stringify({ name: '新增约束.txt', mimeType: 'text/plain', dataBase64: Buffer.from('新的附件内容').toString('base64') }),
    });
    assert.equal(changedAttachment.status, 201);
    const staleRelease = await request(api, `/capabilities/nexus/${created.workflow.id}/releases`, {
      method: 'POST', headers, body: JSON.stringify({ note: '不应复用旧测试' }),
    });
    assert.equal(staleRelease.status, 409);
    assert.match((await staleRelease.json() as { error: string }).error, /未通过.*测试/u);
    const retestResponse = await request(api, `/capabilities/nexus/${created.workflow.id}/test-run`, { method: 'POST', headers });
    const retestRuns = (await retestResponse.json() as { runs: Array<{ taskId: string }> }).runs;
    for (const retest of retestRuns) await store.updateTask(retest.taskId, { status: 'completed', result: '绘图测试通过' });
    await request(api, `/capabilities/nexus/${created.workflow.id}/test-runs`, { headers });
    const attachmentRelease = await request(api, `/capabilities/nexus/${created.workflow.id}/releases`, {
      method: 'POST', headers, body: JSON.stringify({ note: '附件已重新验证' }),
    });
    assert.equal(attachmentRelease.status, 201);

    const runResponse = await request(api, `/workflows/${created.workflow.id}/run`, {
      method: 'POST', headers,
      body: JSON.stringify({ sessionId: 'workflow-session', input: '画一座雨夜中的未来城市' }),
    });
    assert.equal(runResponse.status, 202);
    const run = await runResponse.json() as { task: WorkflowTask };
    assert.equal(run.task.templateId, created.workflow.id);
    assert.equal(run.task.plan?.profile?.route, 'full-workflow');
    assert.equal(run.task.plan?.steps.length, 2);
    assert.equal(nudges, 3);
    assert.ok((await store.getEvents(run.task.id)).some((event) => event.type === 'task.queued' && event.payload.source === 'agent-workflow'));
    const taskList = await request(api, '/tasks', { headers });
    const summary = (await taskList.json() as { tasks: Array<{ id: string; source?: string }> }).tasks.find((task) => task.id === run.task.id);
    assert.equal(summary?.source, 'agent-workflow');

    // A completed Nexus run belongs to its workflow. Removing the workflow
    // must remove that run from the task board as well.
    await store.updateTask(run.task.id, { status: 'completed', result: '绘图流程已完成。' });
    const updatedCanvas = {
      ...canvas,
      nodes: canvas.nodes.map((node) => node.id === 'describe' ? { ...node, objective: '生成包含光影与构图要求的绘图描述' } : node),
    };
    const renamed = await request(api, `/workflows/${created.workflow.id}`, {
      method: 'PATCH', headers,
      body: JSON.stringify({ name: '绘图流水线（新版）', description: '更新后的绘图流程', visibility: 'private', canvas: updatedCanvas }),
    });
    assert.equal(renamed.status, 200);
    const renamedTaskList = await request(api, '/tasks', { headers });
    const renamedSummary = (await renamedTaskList.json() as { tasks: Array<{ id: string; title: string }> }).tasks.find((item) => item.id === run.task.id);
    assert.equal(renamedSummary?.title, '绘图流水线（新版） · 执行');

    const secondCaseResponse = await request(api, `/capabilities/nexus/${created.workflow.id}/tests`, {
      method: 'POST', headers, body: JSON.stringify({ name: '新版验收', input: '生成新版测试图', expectedIncludes: ['新版绘图测试通过'] }),
    });
    assert.equal(secondCaseResponse.status, 201);
    const secondRunResponse = await request(api, `/capabilities/nexus/${created.workflow.id}/test-run`, { method: 'POST', headers });
    const secondRuns = (await secondRunResponse.json() as { runs: Array<{ taskId: string }> }).runs;
    for (const testRun of secondRuns) await store.updateTask(testRun.taskId, { status: 'completed', result: '绘图测试通过；新版绘图测试通过' });
    await request(api, `/capabilities/nexus/${created.workflow.id}/test-runs`, { headers });
    const secondReleaseResponse = await request(api, `/capabilities/nexus/${created.workflow.id}/releases`, {
      method: 'POST', headers, body: JSON.stringify({ note: '第二个稳定版本' }),
    });
    assert.equal(secondReleaseResponse.status, 201);
    const secondRelease = (await secondReleaseResponse.json() as { release: { id: string } }).release;
    const diffResponse = await request(api, `/capabilities/nexus/${created.workflow.id}/releases/${firstRelease.id}/diff/${secondRelease.id}`, { headers });
    assert.equal(diffResponse.status, 200);
    const diff = await diffResponse.json() as { changed: boolean; stepCount: { left: number; right: number }; nodeCount: { left: number; right: number }; artifactCount: { left: number; right: number }; changes: { steps: { changed: string[] }; artifacts: { added: string[] } } };
    assert.equal(diff.changed, true);
    assert.deepEqual(diff.stepCount, { left: 2, right: 2 });
    assert.deepEqual(diff.nodeCount, { left: 4, right: 4 });
    assert.deepEqual(diff.artifactCount, { left: 2, right: 3 });
    assert.ok(diff.changes.steps.changed.length > 0);
    assert.equal(diff.changes.artifacts.added.length, 1);

    // The task board is intentionally capped at 100 rows. Workflow deletion
    // must still clean every terminal run and its Artifact lineage beyond
    // that UI page size.
    for (let index = 0; index < 105; index += 1) {
      const historical = await store.createTask({
        tenantId: 'tenant-workflow',
        userId: 'workflow-owner',
        sessionId: `workflow-history-${index}`,
        templateId: created.workflow.id,
        title: `绘图历史 ${index}`,
        input: '历史运行',
        mode: 'analyze',
      });
      const completed = await store.updateTask(historical.id, { status: 'completed', result: `结果 ${index}` });
      await store.appendEvent(completed, { type: 'artifact.created', payload: { artifactId: `tool:${historical.id}` } });
    }

    const crossTenant = await request(api, `/workflows/${created.workflow.id}`, {
      headers: { 'x-axiom-tenant-id': 'other-tenant', 'x-axiom-user-id': 'other-user' },
    });
    assert.equal(crossTenant.status, 404);
    const removed = await request(api, `/workflows/${created.workflow.id}`, { method: 'DELETE', headers });
    assert.equal(removed.status, 204);
    const emptyListResponse = await request(api, '/workflows', { headers });
    assert.equal((await emptyListResponse.json() as { workflows: unknown[] }).workflows.length, 0);
    const tasksAfterWorkflowDelete = await request(api, '/tasks', { headers });
    assert.equal((await tasksAfterWorkflowDelete.json() as { tasks: Array<{ id: string }> }).tasks.some((task) => task.id === run.task.id), false);
    assert.equal((await store.listTasksByTemplate?.('tenant-workflow', created.workflow.id) ?? []).length, 0);
    assert.ok(deletedArtifacts.includes(`tool:${run.task.id}`) === false);
    assert.ok(deletedArtifacts.length >= 106, `expected every Nexus result and lineage Artifact to be deleted, got ${deletedArtifacts.length}`);
  } finally {
    await artifactCatalog.close();
    await businessCapabilities.close();
    await templates.close();
    await store.close();
  }
});

test('mini-app builder SSE reports validation failures without saving an incomplete revision', async () => {
  const store = new SqliteTaskStore(':memory:');
  const plugins = new SqlitePluginStore(':memory:');
  await store.initialize();
  await plugins.initialize();
  const failingModel: ModelClient = {
    model: 'mini-app-invalid-designer',
    async complete() {
      return { content: 'not valid json', attempts: 1, durationMs: 4 };
    },
  };
  const api = createTaskApi({
    store,
    plugins,
    hub: new EventHub(),
    coordinator: { nudge() {}, abort() {} } as never,
    pluginModelFactory: () => failingModel,
  });
  const headers = { 'content-type': 'application/json', 'x-axiom-tenant-id': 'tenant-stream-error', 'x-axiom-user-id': 'owner-stream-error' };
  try {
    const createdResponse = await request(api, '/plugins', {
      method: 'POST', headers,
      body: JSON.stringify({
        name: '失败流式插件', description: '', kind: 'mini-app', visibility: 'private',
        definition: { mode: 'build', htmlContent: '<!doctype html><html><body>原始版本</body></html>', width: 720, height: 520, agentEnabled: false },
      }),
    });
    const created = await createdResponse.json() as { plugin: { id: string } };
    const response = await request(api, `/plugins/${created.plugin.id}/agent-edit/stream`, {
      method: 'POST', headers, body: JSON.stringify({ instruction: '生成新界面' }),
    });
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /event: status/);
    assert.match(body, /event: error/);
    assert.doesNotMatch(body, /event: complete/);
    const current = await plugins.getPlugin(created.plugin.id, 'tenant-stream-error');
    assert.equal(current?.version, 1);
    assert.match(JSON.stringify(current?.definition ?? {}), /原始版本/);
  } finally {
    await plugins.close();
    await store.close();
  }
});

test('approve-review only resumes a waiting task and persists the operator decision', async () => {
  const { store, api } = await createHarness();
  try {
    const task = await seedTask(store);
    const response = await request(api, `/tasks/${task.id}/approve-review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ note: '已核对当前证据，接受交付。' }),
    });
    assert.equal(response.status, 202);
    const payload = await response.json() as { task: WorkflowTask };
    assert.equal(payload.task.status, 'queued');
    assert.equal(payload.task.review?.approved, true);
    assert.equal((await store.getEvents(task.id)).at(-1)?.type, 'review.approved');

    const invalid = await request(api, `/tasks/${task.id}/approve-review`, { method: 'POST', body: '{}' });
    assert.equal(invalid.status, 409);
  } finally {
    await store.close();
  }
});

test('reject-review pauses the task and records a durable rejection', async () => {
  const { store, api } = await createHarness();
  try {
    const task = await seedTask(store);
    const response = await request(api, `/tasks/${task.id}/reject-review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ note: '请补充边界条件后重新规划。' }),
    });
    assert.equal(response.status, 202);
    const payload = await response.json() as { task: WorkflowTask };
    assert.equal(payload.task.status, 'paused');
    assert.equal(payload.task.error, '请补充边界条件后重新规划。');
    assert.equal((await store.getEvents(task.id)).at(-1)?.type, 'review.rejected');
  } finally {
    await store.close();
  }
});

test('deletes only terminal tasks and removes their persisted event history', async () => {
  const { store, api } = await createHarness();
  const headers = { 'x-axiom-user-id': 'operator' };
  try {
    const task = await seedTask(store, 'running');
    const blocked = await request(api, `/tasks/${task.id}`, { method: 'DELETE', headers });
    assert.equal(blocked.status, 409);
    assert.ok(await store.getTask(task.id));

    await store.updateTask(task.id, { status: 'completed' });
    const crossUserDelete = await request(api, `/tasks/${task.id}`, { method: 'DELETE', headers: { 'x-axiom-user-id': 'other-user' } });
    assert.equal(crossUserDelete.status, 404);
    assert.ok(await store.getTask(task.id));
    const deleted = await request(api, `/tasks/${task.id}`, { method: 'DELETE', headers });
    assert.equal(deleted.status, 204);
    assert.equal(await store.getTask(task.id), null);
    assert.deepEqual(await store.getEvents(task.id), []);
  } finally {
    await store.close();
  }
});

test('deleting a terminal task cleans its result and event-linked Artifacts', async () => {
  const store = new SqliteTaskStore(':memory:');
  await store.initialize();
  const hub = new EventHub();
  const deleted: string[] = [];
  const artifactStore = {
    kind: 'filesystem' as const,
    put: async () => ({ key: 'unused', bytes: 0 }),
    get: async () => null,
    delete: async (id: string) => { deleted.push(id); },
    health: async () => ({ configured: true, reachable: true, detail: 'ok' }),
  };
  const api = createTaskApi({ store, hub, artifactStore, coordinator: { nudge() {}, abort() {} } as never });
  try {
    const task = await seedTask(store, 'completed');
    await store.appendEvent(task, { type: 'artifact.created', payload: { artifactId: 'tool:task:step:call' } });
    await store.appendEvent(task, { type: 'tool.completed', payload: { artifact: { id: 'step-output:task:step' } } });
    const response = await request(api, `/tasks/${task.id}`, { method: 'DELETE', headers: { 'x-axiom-user-id': 'operator' } });
    assert.equal(response.status, 204);
    assert.deepEqual(new Set(deleted), new Set([
      `result:${task.id}`,
      'tool:task:step:call',
      'step-output:task:step',
    ]));
  } finally {
    await store.close();
  }
});

test('reruns only an executed Agent and preserves unrelated upstream checkpoints', async () => {
  const { store, api } = await createHarness();
  const headers = { 'content-type': 'application/json', 'x-axiom-tenant-id': 'rerun-tenant', 'x-axiom-user-id': 'rerun-user' };
  try {
    const task = await store.createTask({
      tenantId: 'rerun-tenant', userId: 'rerun-user', sessionId: 'rerun-session',
      title: '局部重跑测试', input: '检查节点恢复', mode: 'build',
    });
    const planned = await store.updateTask(task.id, {
      status: 'completed',
      plan: {
        summary: '局部重跑计划', routingReason: 'test', approvalStatus: 'approved',
        steps: [
          { id: 'upstream', title: '上游', role: 'analyst', objective: '上游', dependsOn: [], acceptanceCriteria: ['完成'] },
          { id: 'target', title: '目标', role: 'builder', objective: '目标', dependsOn: ['upstream'], acceptanceCriteria: ['完成'] },
          { id: 'downstream', title: '下游', role: 'reviewer', objective: '下游', dependsOn: ['target'], acceptanceCriteria: ['完成'] },
        ],
      },
      stepResults: [
        { stepId: 'upstream', agentId: 'analyst-upstream', role: 'analyst', status: 'completed', output: '上游结果', evidence: [], confidence: 1, attempts: 1, durationMs: 2 },
        { stepId: 'target', agentId: 'builder-target', role: 'builder', status: 'failed', output: '目标失败', evidence: [], confidence: 0, attempts: 2, durationMs: 3 },
        { stepId: 'downstream', agentId: 'reviewer-downstream', role: 'reviewer', status: 'completed', output: '旧下游结果', evidence: [], confidence: 1, attempts: 1, durationMs: 4 },
      ],
    });
    const response = await request(api, `/tasks/${planned.id}/nodes/target/rerun`, { method: 'POST', headers, body: JSON.stringify({ reason: '修复目标 Agent' }) });
    assert.equal(response.status, 202);
    const payload = await response.json() as { task: WorkflowTask; event: { payload: Record<string, unknown> } };
    assert.equal(payload.task.status, 'queued');
    assert.deepEqual(payload.task.stepResults.map((result) => result.stepId), ['upstream']);
    assert.equal(payload.event.payload.rerunAttempt, 3);
    assert.deepEqual(payload.event.payload.preservedUpstreamSteps, ['upstream']);
    assert.deepEqual(payload.event.payload.invalidatedSteps, ['target', 'downstream']);
    assert.deepEqual((payload.event.payload.parentCheckpoint as { stepId: string }).stepId, 'target');
  } finally {
    await store.close();
  }
});

test('rejects local rerun for an unexecuted Agent or incomplete upstream dependency', async () => {
  const { store, api } = await createHarness();
  try {
    const task = await store.createTask({ tenantId: 'rerun-guard', userId: 'operator', sessionId: 'rerun-guard-session', title: '重跑前置检查', input: 'test', mode: 'analyze' });
    const plan = {
      summary: '检查', routingReason: 'test', approvalStatus: 'approved' as const,
      steps: [
        { id: 'source', title: '源', role: 'analyst', objective: '源', dependsOn: [], acceptanceCriteria: ['完成'] },
        { id: 'target', title: '目标', role: 'builder', objective: '目标', dependsOn: ['source'], acceptanceCriteria: ['完成'] },
      ],
    };
    await store.updateTask(task.id, { status: 'completed', plan, stepResults: [] });
    const unexecuted = await request(api, `/tasks/${task.id}/nodes/target/rerun`, { method: 'POST', headers: { 'x-axiom-tenant-id': 'rerun-guard', 'x-axiom-user-id': 'operator' }, body: '{}' });
    assert.equal(unexecuted.status, 409);

    await store.updateTask(task.id, {
      status: 'completed',
      stepResults: [{ stepId: 'target', agentId: 'builder-target', role: 'builder', status: 'completed', output: 'target', evidence: [], confidence: 1, attempts: 1, durationMs: 1 }],
    });
    const missingUpstream = await request(api, `/tasks/${task.id}/nodes/target/rerun`, { method: 'POST', headers: { 'x-axiom-tenant-id': 'rerun-guard', 'x-axiom-user-id': 'operator' }, body: '{}' });
    assert.equal(missingUpstream.status, 409);
  } finally {
    await store.close();
  }
});

test('review decisions reject terminal tasks and task listing exposes runtime telemetry', async () => {
  const { store, api } = await createHarness();
  try {
    const task = await seedTask(store, 'completed');
    const response = await request(api, `/tasks/${task.id}/reject-review`, { method: 'POST', body: '{}' });
    assert.equal(response.status, 409);

    const listResponse = await request(api, '/tasks?limit=10');
    assert.equal(listResponse.status, 200);
    const payload = await listResponse.json() as { tasks: Array<Record<string, unknown>> };
    const summary = payload.tasks.find((item) => item.id === task.id)!;
    assert.equal(summary.status, 'completed');
    assert.equal(summary.currentStage, 'completed');
    assert.deepEqual(summary.tokens, { prompt: 10, completion: 20, total: 30 });
    assert.equal(summary.completedSteps, 0);
    assert.equal(summary.totalSteps, 1);
  } finally {
    await store.close();
  }
});

test('task listing fetches event telemetry as one tenant-scoped batch', async () => {
  const { store, api } = await createHarness();
  try {
    await seedTask(store, 'completed');
    const original = store.getTaskEventSummaries.bind(store);
    let calls = 0;
    store.getTaskEventSummaries = async (taskIds, tenantId) => {
      calls += 1;
      return original(taskIds, tenantId);
    };
    const response = await request(api, '/tasks?limit=10');
    assert.equal(response.status, 200);
    assert.equal(calls, 1);
  } finally {
    await store.close();
  }
});

test('canceling a human-gated task immediately reaches a terminal state', async () => {
  const { store, api } = await createHarness();
  const headers = { 'x-axiom-tenant-id': 'cancel-gate-tenant', 'x-axiom-user-id': 'cancel-gate-user' };
  try {
    const task = await store.createTask({
      tenantId: 'cancel-gate-tenant',
      userId: 'cancel-gate-user',
      sessionId: 'cancel-gate-session',
      title: 'human gate',
      input: 'needs review',
      mode: 'analyze',
    });
    await store.updateTask(task.id, { status: 'waiting_for_human', review });
    const response = await request(api, `/tasks/${task.id}/cancel`, { method: 'POST', headers });
    assert.equal(response.status, 202);
    const current = await store.getTask(task.id, task.tenantId);
    assert.equal(current?.status, 'cancelled');
    assert.equal((await store.getEvents(task.id)).at(-1)?.type, 'task.cancelled');
  } finally {
    await store.close();
  }
});

test('returns a durable artifact miss instead of fabricating an empty result', async () => {
  const { store, api } = await createHarness();
  try {
    const task = await seedTask(store, 'completed');
    const response = await request(api, `/tasks/${task.id}/artifacts/result`);
    assert.equal(response.status, 404);
    assert.match((await response.json() as { error: string }).error, /Result artifact/);
  } finally {
    await store.close();
  }
});

test('saves a task as a versioned template and runs only published templates', async () => {
  const store = new SqliteTaskStore(':memory:');
  const templates = new SqliteTemplateStore(':memory:');
  await store.initialize();
  await templates.initialize();
  const hub = new EventHub();
  const api = createTaskApi({
    store,
    hub,
    templates,
    coordinator: { nudge() {}, abort() {} } as never,
  });
  try {
    const source = await seedTask(store, 'completed');
    const savedResponse = await request(api, `/tasks/${source.id}/template`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Release workflow', description: 'Reusable release gate' }),
    });
    assert.equal(savedResponse.status, 201);
    const saved = await savedResponse.json() as { template: { id: string; status: string; definition: { plan?: unknown } } };
    assert.equal(saved.template.status, 'draft');
    assert.ok(saved.template.definition.plan);

    const draftRun = await request(api, '/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'template-draft', title: 'Draft run', input: 'run', mode: 'build', templateId: saved.template.id }),
    });
    assert.equal(draftRun.status, 409);

    const publishResponse = await request(api, `/templates/${saved.template.id}/publish`, { method: 'POST' });
    assert.equal(publishResponse.status, 200);
    const publishedRun = await request(api, '/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'template-published', title: 'Published run', input: 'run', mode: 'build', templateId: saved.template.id }),
    });
    assert.equal(publishedRun.status, 202);
    const body = await publishedRun.json() as { task: WorkflowTask };
    assert.equal(body.task.templateId, saved.template.id);
    assert.ok(body.task.plan?.steps.length);
  } finally {
    await templates.close();
    await store.close();
  }
});

test('imports, exports, shares, and instantiates built-in workflow templates with tenant access checks', async () => {
  const store = new SqliteTaskStore(':memory:');
  const templates = new SqliteTemplateStore(':memory:');
  await store.initialize();
  await templates.initialize();
  const api = createTaskApi({
    store,
    templates,
    hub: new EventHub(),
    coordinator: { nudge() {}, abort() {} } as never,
  });
  const ownerHeaders = { 'content-type': 'application/json', 'x-axiom-tenant-id': 'tenant-a', 'x-axiom-user-id': 'owner-a' };
  const memberHeaders = { 'content-type': 'application/json', 'x-axiom-tenant-id': 'tenant-a', 'x-axiom-user-id': 'member-b' };
  try {
    const catalogResponse = await request(api, '/template-catalog');
    assert.equal(catalogResponse.status, 200);
    assert.ok((await catalogResponse.json() as { templates: unknown[] }).templates.length >= 4);

    const createdResponse = await request(api, '/templates/from-catalog', {
      method: 'POST',
      headers: ownerHeaders,
      body: JSON.stringify({ catalogId: 'architecture-evaluation', visibility: 'private' }),
    });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json() as { template: { id: string; status: string; visibility: string } };
    assert.equal(created.template.status, 'draft');
    assert.equal(created.template.visibility, 'private');

    const hidden = await request(api, `/templates/${created.template.id}`, { headers: memberHeaders });
    assert.equal(hidden.status, 404);

    const shared = await request(api, `/templates/${created.template.id}/share`, { method: 'POST', headers: ownerHeaders });
    assert.equal(shared.status, 200);
    assert.equal((await shared.json() as { template: { visibility: string } }).template.visibility, 'team');

    const visible = await request(api, `/templates/${created.template.id}`, { headers: memberHeaders });
    assert.equal(visible.status, 200);
    const bundleResponse = await request(api, `/templates/${created.template.id}/export`, { headers: memberHeaders });
    assert.equal(bundleResponse.status, 200);
    assert.match(bundleResponse.headers.get('content-disposition') ?? '', /attachment/);
    const bundle = JSON.parse(await bundleResponse.text()) as { schemaVersion: number; template: { name: string } };
    assert.equal(bundle.schemaVersion, 1);

    const imported = await request(api, '/templates/import', {
      method: 'POST',
      headers: memberHeaders,
      body: JSON.stringify(bundle),
    });
    assert.equal(imported.status, 201);
    const importedBody = await imported.json() as { template: { status: string; visibility: string; createdBy: string } };
    assert.equal(importedBody.template.status, 'draft');
    assert.equal(importedBody.template.visibility, 'private');
    assert.equal(importedBody.template.createdBy, 'member-b');
  } finally {
    await templates.close();
    await store.close();
  }
});

test('tool approval endpoints persist operator decisions and enforce task ownership', async () => {
  const { store, api } = await createHarness();
  try {
    const task = await store.createTask({
      tenantId: 'tenant-tools',
      userId: 'owner-tools',
      sessionId: 'session-tools',
      title: 'Tool approval',
      input: 'write a file',
      mode: 'build',
    });
    const approval = {
      id: 'approval-1',
      signature: 'signature-1',
      stepId: 'step-1',
      name: 'workspace.write',
      args: { path: 'notes/release.md', content: 'approved' },
      risk: 'high' as const,
      status: 'pending' as const,
      requestedAt: new Date().toISOString(),
    };
    const waiting = await store.updateTask(task.id, { status: 'waiting_for_human', toolApprovals: [approval] });
    await store.appendEvent(waiting, { type: 'tool.approval_requested', payload: { approval, name: approval.name, risk: approval.risk } });

    const forbidden = await request(api, `/tasks/${task.id}/approve-tool`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-axiom-tenant-id': 'tenant-tools', 'x-axiom-user-id': 'other-user' },
      body: JSON.stringify({ approvalId: approval.id }),
    });
    assert.equal(forbidden.status, 403);

    const approvedResponse = await request(api, `/tasks/${task.id}/approve-tool`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-axiom-tenant-id': 'tenant-tools', 'x-axiom-user-id': 'owner-tools' },
      body: JSON.stringify({ approvalId: approval.id, note: 'Reviewed target path.' }),
    });
    assert.equal(approvedResponse.status, 202);
    const approved = await approvedResponse.json() as { task: WorkflowTask };
    assert.equal(approved.task.status, 'queued');
    assert.equal(approved.task.toolApprovals?.[0]?.status, 'approved');
    assert.equal((await store.getEvents(task.id)).at(-1)?.type, 'tool.approved');

    const auditResponse = await request(api, `/tasks/${task.id}/tools/audit`, {
      headers: { 'x-axiom-tenant-id': 'tenant-tools', 'x-axiom-user-id': 'owner-tools' },
    });
    assert.equal(auditResponse.status, 200);
    const audit = await auditResponse.json() as { approvals: Array<{ status: string }>; events: unknown[] };
    assert.equal(audit.approvals[0]?.status, 'approved');
    assert.equal(audit.events.length, 2);
  } finally {
    await store.close();
  }
});

test('persists sessions across store reinitialization and isolates tenant users', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'axiom-session-api-'));
  const databasePath = join(directory, 'runtime.sqlite');
  const session = {
    id: 'session-persisted',
    title: '跨端口会话',
    messages: [{
      id: 'message-user',
      role: 'user' as const,
      content: '保留这段历史',
      createdAt: 1_000,
      attachments: [
        { id: 'file-1', kind: 'file' as const, name: 'note.md', mimeType: 'text/markdown', size: 12, text: '# note' },
        { id: 'video-1', kind: 'video' as const, url: 'http://127.0.0.1:9000/output/demo.mp4', alt: '演示视频', mimeType: 'video/mp4' },
      ],
    }, {
      id: 'message-assistant',
      role: 'assistant' as const,
      content: '历史已持久化',
      createdAt: 2_000,
      taskId: 'task-1',
      route: 'team',
      agentRole: 'synthesizer',
    }],
    updatedAt: 2_000,
    agentGraph: {
      nodes: [{
        id: 'direct-search',
        stepId: 'direct-response',
        agentId: 'search-agent',
        role: 'search-agent',
        title: '搜索 Agent',
        dependsOn: [],
        skillIds: ['web-search'],
        status: 'completed' as const,
        tokens: 128,
        durationMs: 420,
      }],
      edges: [],
    },
  };
  const ownerHeaders = { 'content-type': 'application/json', 'x-axiom-tenant-id': 'tenant-session', 'x-axiom-user-id': 'user-a' };
  const otherUserHeaders = { 'x-axiom-tenant-id': 'tenant-session', 'x-axiom-user-id': 'user-b' };
  let firstStore: SqliteTaskStore | undefined;
  let secondStore: SqliteTaskStore | undefined;
  try {
    firstStore = new SqliteTaskStore(databasePath);
    await firstStore.initialize();
    const firstApi = createTaskApi({ store: firstStore, hub: new EventHub(), coordinator: { nudge() {}, abort() {} } as never });
    const saved = await request(firstApi, `/sessions/${session.id}`, {
      method: 'PUT',
      headers: ownerHeaders,
      body: JSON.stringify(session),
    });
    assert.equal(saved.status, 200);
    const stale = await request(firstApi, `/sessions/${session.id}`, {
      method: 'PUT',
      headers: ownerHeaders,
      body: JSON.stringify({ ...session, title: '旧标签页覆盖', messages: [], updatedAt: 1_500 }),
    });
    assert.equal(stale.status, 200);
    assert.equal((await stale.json() as { session: { title: string } }).session.title, session.title);
    assert.equal((await request(firstApi, '/sessions', { headers: ownerHeaders })).status, 200);
    const hiddenFromOtherUser = await request(firstApi, '/sessions', { headers: otherUserHeaders });
    assert.deepEqual((await hiddenFromOtherUser.json() as { sessions: unknown[] }).sessions, []);
    await firstStore.close();
    firstStore = undefined;

    secondStore = new SqliteTaskStore(databasePath);
    await secondStore.initialize();
    const secondApi = createTaskApi({ store: secondStore, hub: new EventHub(), coordinator: { nudge() {}, abort() {} } as never });
    const restoredResponse = await request(secondApi, '/sessions?limit=10', { headers: ownerHeaders });
    assert.equal(restoredResponse.status, 200);
    const restored = (await restoredResponse.json() as { sessions: typeof session[] }).sessions;
    assert.equal(restored.length, 1);
    assert.deepEqual(restored[0], { ...session, tenantId: 'tenant-session', userId: 'user-a' });
  } finally {
    await firstStore?.close();
    await secondStore?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('persists versioned context summaries with task artifacts and human-control facts across restart', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'axiom-context-summary-api-'));
  const databasePath = join(directory, 'runtime.sqlite');
  const headers = { 'content-type': 'application/json', 'x-axiom-tenant-id': 'tenant-context', 'x-axiom-user-id': 'user-context' };
  let firstStore: SqliteTaskStore | undefined;
  let secondStore: SqliteTaskStore | undefined;
  try {
    firstStore = new SqliteTaskStore(databasePath);
    await firstStore.initialize();
    const task = await firstStore.createTask({
      tenantId: 'tenant-context', userId: 'user-context', sessionId: 'session-context', title: '上下文任务',
      input: '形成可恢复摘要。', mode: 'build',
    });
    await firstStore.appendEvent(task, { type: 'artifact.created', payload: { id: 'step-result:context:analysis:abc' } });
    await firstStore.appendEvent(task, { type: 'human.guidance_accepted', payload: { message: '保留迁移兼容性。' } });
    await firstStore.appendEvent(task, { type: 'review.approval_requested', payload: { score: 70 } });
    const messages = Array.from({ length: 20 }, (_, index) => ({
      id: `context-message-${index}`,
      role: (index % 2 ? 'assistant' : 'user') as 'assistant' | 'user',
      content: `第 ${index + 1} 条会话内容：${'需要可靠恢复。'.repeat(12)}`,
      createdAt: 1_000 + index,
      ...(index === 1 ? { taskId: task.id } : {}),
    }));
    const firstApi = createTaskApi({ store: firstStore, hub: new EventHub(), coordinator: { nudge() {}, abort() {} } as never });
    const saved = await request(firstApi, '/sessions/session-context', {
      method: 'PUT', headers, body: JSON.stringify({ id: 'session-context', title: '持久上下文', messages, updatedAt: 2_000 }),
    });
    assert.equal(saved.status, 200);
    const firstSummary = (await saved.json() as { session: { contextSummary?: import('./contextSummary.js').PersistedContextSummary } }).session.contextSummary;
    assert.ok(firstSummary);
    assert.equal(firstSummary.version, 1);
    assert.equal(firstSummary.quality?.lastAction, 'created');
    assert.equal(firstSummary.quality?.tokenizer.mode, 'estimated');
    assert.notEqual(firstSummary.quality?.compressionPercent, null);
    assert.ok(firstSummary.artifactIds.includes('step-result:context:analysis:abc'));
    assert.equal(firstSummary.approvalEventIds.length, 1);
    assert.match(firstSummary.content, /人工要求：保留迁移兼容性/);
    assert.match(firstSummary.content, /未完成事项/);
    const operationsResponse = await request(firstApi, '/runtime/operations?hours=24', { headers });
    assert.equal(operationsResponse.status, 200);
    const contextOperations = (await operationsResponse.json() as { contextSummaries: { summaries: number; estimatedSummaries: number; compressionPercent: number | null } }).contextSummaries;
    assert.equal(contextOperations.summaries, 1);
    assert.equal(contextOperations.estimatedSummaries, 1);
    assert.notEqual(contextOperations.compressionPercent, null);
    await firstStore.close();
    firstStore = undefined;

    secondStore = new SqliteTaskStore(databasePath);
    await secondStore.initialize();
    const restored = (await secondStore.listSessions('tenant-context', 'user-context', 10))[0];
    assert.deepEqual(restored?.contextSummary, firstSummary);
    const secondApi = createTaskApi({ store: secondStore, hub: new EventHub(), coordinator: { nudge() {}, abort() {} } as never });
    const appended = [...messages, ...Array.from({ length: 4 }, (_, index) => ({
      id: `context-message-${20 + index}`,
      role: (index % 2 ? 'assistant' : 'user') as 'assistant' | 'user',
      content: `追加上下文 ${index + 1}`,
      createdAt: 3_000 + index,
    }))];
    const updated = await request(secondApi, '/sessions/session-context', {
      method: 'PUT', headers, body: JSON.stringify({ id: 'session-context', title: '持久上下文', messages: appended, updatedAt: 4_000 }),
    });
    const secondSummary = (await updated.json() as { session: { contextSummary?: import('./contextSummary.js').PersistedContextSummary } }).session.contextSummary;
    assert.equal(secondSummary?.version, 2);
    assert.equal(secondSummary?.quality?.lastAction, 'incremental');
    assert.ok((secondSummary?.coveredMessageIds.length ?? 0) > firstSummary.coveredMessageIds.length);
  } finally {
    await firstStore?.close();
    await secondStore?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('persists session Agent Graph snapshots with validation, tenant isolation, and deletion tombstones', async () => {
  const { store, api } = await createHarness();
  const ownerHeaders = { 'content-type': 'application/json', 'x-axiom-tenant-id': 'tenant-graph', 'x-axiom-user-id': 'user-graph' };
  const otherTenantHeaders = { 'x-axiom-tenant-id': 'other-tenant', 'x-axiom-user-id': 'user-graph' };
  const graph = {
    nodes: [{
      id: 'direct-search', stepId: 'direct-response', agentId: 'search-agent', role: 'search-agent',
      title: '搜索 Agent', dependsOn: [], skillIds: ['web-search'], status: 'completed' as const,
      parentId: 'router-agent', executionWave: 2, writeScopes: ['artifact:research'],
      tokens: 128, durationMs: 420, attempts: 1, toolCalls: 1,
    }],
    edges: [],
    revision: 4,
  };
  const session = { id: 'graph-session', title: 'Graph 会话', messages: [{ id: 'user-1', role: 'user' as const, content: '搜索资料', createdAt: 1_000 }], updatedAt: 2_000, agentGraph: graph };
  try {
    const saved = await request(api, `/sessions/${session.id}`, { method: 'PUT', headers: ownerHeaders, body: JSON.stringify(session) });
    assert.equal(saved.status, 200);
    const savedBody = await saved.json() as { session: { agentGraph?: typeof graph } };
    assert.deepEqual(savedBody.session.agentGraph, graph);

    const listed = await request(api, '/sessions', { headers: ownerHeaders });
    assert.equal(listed.status, 200);
    const listedBody = await listed.json() as { sessions: Array<{ agentGraph?: typeof graph }> };
    assert.deepEqual(listedBody.sessions[0]?.agentGraph, graph);

    const hidden = await request(api, '/sessions', { headers: otherTenantHeaders });
    assert.deepEqual((await hidden.json() as { sessions: unknown[] }).sessions, []);

    const invalid = await request(api, '/sessions/invalid-graph', {
      method: 'PUT', headers: ownerHeaders,
      body: JSON.stringify({ id: 'invalid-graph', title: 'invalid', messages: [], updatedAt: 3_000, agentGraph: {
        nodes: [{ id: 'bad', role: 'agent', title: 'bad', dependsOn: [], status: 'running', unexpected: true }], edges: [],
      } }),
    });
    assert.equal(invalid.status, 400);

    const invalidTopology = await request(api, '/sessions/invalid-topology', {
      method: 'PUT', headers: ownerHeaders,
      body: JSON.stringify({ id: 'invalid-topology', title: 'invalid', messages: [], updatedAt: 3_001, agentGraph: {
        nodes: [
          { id: 'a', role: 'agent', title: 'a', dependsOn: ['missing'], status: 'running' },
          { id: 'b', role: 'agent', title: 'b', dependsOn: [], status: 'queued' },
        ],
        edges: [
          { from: 'a', to: 'b', kind: 'dependency' },
          { from: 'b', to: 'a', kind: 'dependency' },
        ],
      } }),
    });
    assert.equal(invalidTopology.status, 400);

    const deleted = await request(api, `/sessions/${session.id}`, { method: 'DELETE', headers: ownerHeaders });
    assert.equal(deleted.status, 204);
    const afterDelete = await request(api, '/sessions', { headers: ownerHeaders });
    assert.deepEqual((await afterDelete.json() as { sessions: unknown[] }).sessions, []);
    const graphRow = await store.listSessions('tenant-graph', 'user-graph');
    assert.deepEqual(graphRow, []);
    assert.deepEqual(await store.listDeletedSessionIds('tenant-graph', 'user-graph'), [session.id]);
  } finally {
    await store.close();
  }
});

test('clears stale pending session state when no live task owns the response', async () => {
  const { store, api } = await createHarness();
  const headers = { 'content-type': 'application/json', 'x-axiom-tenant-id': 'tenant-stale-session', 'x-axiom-user-id': 'user-stale-session' };
  const session = {
    id: 'stale-pending-session',
    title: 'hello',
    messages: [
      { id: 'stale-user', role: 'user' as const, content: 'hello', createdAt: 1_000 },
      { id: 'stale-assistant', role: 'assistant' as const, content: 'Hello!', createdAt: 2_000, pending: true, route: 'conversation' },
    ],
    updatedAt: 2_000,
  };
  try {
    const saved = await request(api, `/sessions/${session.id}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify(session),
    });
    assert.equal(saved.status, 200);

    const listed = await request(api, '/sessions', { headers });
    assert.equal(listed.status, 200);
    const restored = (await listed.json() as { sessions: Array<typeof session> }).sessions[0];
    assert.equal(restored?.messages[1]?.pending, false);

    const persisted = (await store.listSessions('tenant-stale-session', 'user-stale-session'))[0];
    assert.equal(persisted?.messages[1]?.pending, false);
    assert.equal(persisted?.activeTaskId, undefined);
    assert.equal(persisted?.activeAssistantId, undefined);
  } finally {
    await store.close();
  }
});

test('does not present a human review task as actively generating', async () => {
  const { store, api } = await createHarness();
  const headers = { 'content-type': 'application/json', 'x-axiom-tenant-id': 'tenant-waiting-session', 'x-axiom-user-id': 'user-waiting-session' };
  try {
    const created = await store.createTask({
      tenantId: 'tenant-waiting-session',
      userId: 'user-waiting-session',
      sessionId: 'waiting-session',
      title: '等待质量审核',
      input: 'USER:\n等待质量审核',
      mode: 'analyze',
    });
    const waiting = await store.updateTask(created.id, {
      status: 'waiting_for_human',
      review: { ...review, score: 75 },
    });
    const session = {
      id: 'waiting-session',
      title: '等待质量审核',
      messages: [
        { id: 'waiting-user', role: 'user' as const, content: '等待质量审核', createdAt: 1_000 },
        { id: 'waiting-assistant', role: 'assistant' as const, content: '', createdAt: 2_000, pending: true, taskId: waiting.id },
      ],
      updatedAt: 2_000,
      activeTaskId: waiting.id,
      activeAssistantId: 'waiting-assistant',
    };
    const saved = await request(api, `/sessions/${session.id}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify(session),
    });
    assert.equal(saved.status, 200);

    const listed = await request(api, '/sessions', { headers });
    assert.equal(listed.status, 200);
    const restored = (await listed.json() as { sessions: Array<typeof session> }).sessions[0];
    assert.equal(restored?.messages[1]?.pending, false);
    assert.equal(restored?.activeTaskId, undefined);
    assert.equal(restored?.activeAssistantId, undefined);
  } finally {
    await store.close();
  }
});

test('migrates task-only history and keeps deleted sessions deleted', async () => {
  const { store, api } = await createHarness();
  const headers = { 'x-axiom-tenant-id': 'tenant-migrate', 'x-axiom-user-id': 'user-migrate' };
  try {
    const task = await store.createTask({
      tenantId: 'tenant-migrate',
      userId: 'user-migrate',
      sessionId: 'legacy-session',
      title: '旧任务历史',
      input: 'USER:\n\n你还在吗？\n\nASSISTANT:\n\n我在，历史来自任务。',
      mode: 'analyze',
    });
    await store.updateTask(task.id, { status: 'completed', result: '我在，历史来自任务。' });
    const migratedResponse = await request(api, '/sessions', { headers });
    assert.equal(migratedResponse.status, 200);
    const migrated = (await migratedResponse.json() as { sessions: Array<{ id: string; messages: Array<{ role: string; content: string }> }> }).sessions;
    assert.equal(migrated.length, 1);
    assert.equal(migrated[0]?.id, 'legacy-session');
    assert.ok(migrated[0]?.messages.some((message) => message.content.includes('我在')));

    const deleted = await request(api, '/sessions/legacy-session', { method: 'DELETE', headers });
    assert.equal(deleted.status, 204);
    const afterDelete = await request(api, '/sessions', { headers });
    assert.deepEqual((await afterDelete.json() as { sessions: unknown[] }).sessions, []);
    const tasksAfterSessionDelete = await request(api, '/tasks', { headers });
    assert.equal((await tasksAfterSessionDelete.json() as { tasks: Array<{ id: string }> }).tasks.some((item) => item.id === task.id), false);

    const restored = await request(api, '/sessions/legacy-session', {
      method: 'PUT',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'legacy-session', title: '重新打开', messages: [], updatedAt: Date.now() }),
    });
    assert.equal(restored.status, 200);
    assert.equal((await request(api, '/sessions', { headers })).status, 200);
    const finalResponse = await request(api, '/sessions', { headers });
    assert.equal((await finalResponse.json() as { sessions: Array<{ id: string }> }).sessions[0]?.id, 'legacy-session');
  } finally {
    await store.close();
  }
});

test('keeps Agent Nexus task history out of regular conversations', async () => {
  const { store, api } = await createHarness();
  const headers = { 'x-axiom-tenant-id': 'tenant-nexus-separation', 'x-axiom-user-id': 'user-nexus-separation' };
  try {
    const task = await store.createTask({
      tenantId: 'tenant-nexus-separation',
      userId: 'user-nexus-separation',
      sessionId: 'agent-nexus-workflow-123',
      title: 'Agent Nexus · 执行',
      input: 'USER:\n\n运行 Nexus。',
      mode: 'analyze',
    });
    await store.updateTask(task.id, { status: 'completed', result: 'Nexus 已完成。' });
    const legacyTask = await store.createTask({
      tenantId: 'tenant-nexus-separation',
      userId: 'user-nexus-separation',
      sessionId: 'workflow-session-legacy',
      templateId: 'legacy-workflow-template',
      title: '旧版 Agent Nexus · 执行',
      input: 'USER:\n\n旧版运行。',
      mode: 'analyze',
    });
    await store.updateTask(legacyTask.id, { status: 'completed', result: '旧版 Nexus 已完成。' });
    await store.upsertSession('tenant-nexus-separation', 'user-nexus-separation', {
      id: 'workflow-session-legacy',
      title: '旧版 Agent Nexus · 执行',
      messages: [{ id: 'legacy-user', role: 'user', content: '旧版运行。', createdAt: Date.now() }],
      updatedAt: Date.now(),
    });
    const listed = await request(api, '/sessions', { headers });
    assert.equal(listed.status, 200);
    assert.deepEqual((await listed.json() as { sessions: unknown[] }).sessions, []);
  } finally {
    await store.close();
  }
});

test('schedule Agent creates a confirmable draft without creating a schedule', async () => {
  const store = new SqliteTaskStore(':memory:');
  await store.initialize();
  const designModel: ModelClient = {
    model: 'schedule-design-model',
    async complete(_request: ModelCompletionRequest) {
      return {
        content: JSON.stringify({
          title: 'Agent 行业每日简报',
          input: '搜索最新 Agent 行业动态，筛选重要信息并整理为 5 条摘要，保留来源。',
          mode: 'analyze',
          schedule: { kind: 'daily', timeOfDay: '09:00', timezone: 'Asia/Shanghai' },
          agentPolicy: 'auto',
          reason: '每次执行都需要重新检索并自动选择搜索、分析和汇总 Agent。',
        }),
        attempts: 1,
        durationMs: 1,
      };
    },
  };
  const api = createTaskApi({
    store,
    hub: new EventHub(),
    coordinator: { nudge() {}, abort() {} } as never,
    scheduleModelFactory: () => designModel,
  });
  const headers = { 'content-type': 'application/json', 'x-axiom-tenant-id': 'tenant-schedule-draft', 'x-axiom-user-id': 'user-schedule-draft' };
  try {
    const response = await request(api, '/schedules/draft', {
      method: 'POST',
      headers,
      body: JSON.stringify({ request: '每天早上 9 点搜索 Agent 行业动态，整理成 5 条摘要', sessionId: 'schedule-session', timezone: 'Asia/Shanghai' }),
    });
    assert.equal(response.status, 200);
    const body = await response.json() as { source: string; createsSchedule: boolean; draft: { agentPolicy: string; schedule: { kind: string; timeOfDay: string } } };
    assert.equal(body.source, 'schedule-agent');
    assert.equal(body.createsSchedule, false);
    assert.equal(body.draft.agentPolicy, 'auto');
    assert.deepEqual(body.draft.schedule, { kind: 'daily', timeOfDay: '09:00', timezone: 'Asia/Shanghai' });
    const listed = await request(api, '/schedules', { headers });
    assert.deepEqual((await listed.json() as { schedules: unknown[] }).schedules, []);
  } finally {
    await store.close();
  }
});

test('schedule runs are tenant-isolated, routed per execution, and do not move the automatic deadline', async () => {
  const store = new SqliteTaskStore(':memory:');
  await store.initialize();
  const credentialId = 'd9428888-122b-4f85-b84c-3e8e0c16bf19';
  const api = createTaskApi({
    store,
    hub: new EventHub(),
    coordinator: { nudge() {}, abort() {} } as never,
    resolveModelCredential: async (id, tenantId, userId) => id === credentialId && tenantId === 'tenant-schedule-run' && userId === 'user-schedule-run'
      ? { id, model: 'user-schedule-model' }
      : null,
  });
  const headers = { 'content-type': 'application/json', 'x-axiom-tenant-id': 'tenant-schedule-run', 'x-axiom-user-id': 'user-schedule-run' };
  const otherHeaders = { ...headers, 'x-axiom-tenant-id': 'tenant-schedule-other' };
  const otherUserHeaders = { ...headers, 'x-axiom-user-id': 'user-schedule-other' };
  try {
    const createdResponse = await request(api, '/schedules', {
      method: 'POST', headers, body: JSON.stringify({
        sessionId: 'schedule-session', title: '每日开源项目观察', input: '每天搜索新的开源 Agent 项目并比较差异', mode: 'analyze', enabled: true, modelCredentialId: credentialId,
        cadence: { kind: 'daily', timeOfDay: '23:59', timezone: 'Asia/Shanghai' },
      }),
    });
    assert.equal(createdResponse.status, 201);
    const created = (await createdResponse.json() as { schedule: { id: string; nextRunAt: string; modelCredentialId?: string } }).schedule;
    assert.equal(created.modelCredentialId, credentialId);

    const attemptedIdOverride = await request(api, '/schedules', {
      method: 'POST', headers: otherHeaders, body: JSON.stringify({
        id: created.id, sessionId: 'other-session', title: '越权覆盖', input: '不应被创建', mode: 'analyze', enabled: true,
        cadence: { kind: 'daily', timeOfDay: '23:59', timezone: 'Asia/Shanghai' },
      }),
    });
    assert.equal(attemptedIdOverride.status, 400);
    assert.equal((await request(api, `/schedules/${created.id}/runs`, { headers: otherHeaders })).status, 404);

    const runResponse = await request(api, `/schedules/${created.id}/run`, {
      method: 'POST', headers, body: JSON.stringify({ idempotencyKey: 'manual-run-stable-001' }),
    });
    assert.equal(runResponse.status, 202);
    const runBody = await runResponse.json() as { task: { id: string }; deduplicated: boolean };
    assert.equal(runBody.deduplicated, false);

    const duplicate = await request(api, `/schedules/${created.id}/run`, {
      method: 'POST', headers, body: JSON.stringify({ idempotencyKey: 'manual-run-stable-001' }),
    });
    assert.equal((await duplicate.json() as { deduplicated: boolean }).deduplicated, true);

    const listed = await request(api, '/schedules', { headers });
    const listedBody = await listed.json() as { schedules: Array<{ id: string; nextRunAt: string }>; latestRuns: Record<string, { id: string; triggerId: string; manual: boolean; activeAgentIds: string[] }> };
    assert.equal(listedBody.schedules[0]?.nextRunAt, created.nextRunAt);
    assert.equal(listedBody.latestRuns[created.id]?.id, runBody.task.id);
    assert.equal(listedBody.latestRuns[created.id]?.triggerId, created.id);
    assert.equal(listedBody.latestRuns[created.id]?.manual, true);
    assert.ok((listedBody.latestRuns[created.id]?.activeAgentIds.length ?? 0) >= 1);

    const runs = await request(api, `/schedules/${created.id}/runs`, { headers });
    assert.equal(runs.status, 200);
    const runItems = (await runs.json() as { runs: Array<{ id: string; triggerId: string; source: string }> }).runs;
    assert.equal(runItems.length, 1);
    assert.equal(runItems[0]?.source, 'schedule');
    assert.equal(runItems[0]?.triggerId, created.id);

    assert.equal((await request(api, `/schedules/${created.id}/runs`, { headers: otherHeaders })).status, 404);
    assert.equal((await request(api, `/schedules/${created.id}/run`, { method: 'POST', headers: otherHeaders, body: '{}' })).status, 404);
    const otherUserListResponse = await request(api, '/schedules', { headers: otherUserHeaders });
    assert.deepEqual((await otherUserListResponse.json() as { schedules: unknown[] }).schedules, []);
    assert.equal((await request(api, `/schedules/${created.id}/runs`, { headers: otherUserHeaders })).status, 404);
    assert.equal((await request(api, `/schedules/${created.id}/run`, { method: 'POST', headers: otherUserHeaders, body: '{}' })).status, 404);
    assert.equal((await request(api, `/schedules/${created.id}`, { method: 'DELETE', headers: otherUserHeaders })).status, 404);
  } finally {
    await store.close();
  }
});

test('schedule insights detect capacity conflicts and only apply a current confirmed suggestion', async () => {
  const store = new SqliteTaskStore(':memory:');
  await store.initialize();
  const api = createTaskApi({ store, hub: new EventHub(), coordinator: { nudge() {}, abort() {} } as never });
  const headers = { 'content-type': 'application/json', 'x-axiom-tenant-id': 'tenant-schedule-health', 'x-axiom-user-id': 'user-schedule-health' };
  const otherUserHeaders = { ...headers, 'x-axiom-user-id': 'other-schedule-health-user' };
  try {
    const createdIds: string[] = [];
    for (const title of ['研究简报', '代码巡检', '资料归档']) {
      const response = await request(api, '/schedules', {
        method: 'POST', headers, body: JSON.stringify({
          sessionId: `session-${title}`, title, input: `${title}任务`, mode: 'build', enabled: true,
          cadence: { kind: 'daily', timeOfDay: '23:59', timezone: 'Asia/Shanghai' },
        }),
      });
      assert.equal(response.status, 201);
      createdIds.push((await response.json() as { schedule: { id: string } }).schedule.id);
    }

    const insightResponse = await request(api, '/schedules/insights?days=7', { headers });
    assert.equal(insightResponse.status, 200);
    const insights = await insightResponse.json() as {
      capacity: { overloadedWindows: number };
      conflicts: Array<{ scheduleIds: string[] }>;
      suggestions: Array<{ id: string; scheduleId: string; recommendedAction: string; proposedCadence?: { kind: string; timeOfDay?: string } }>;
    };
    assert.ok(insights.capacity.overloadedWindows >= 1);
    assert.equal(insights.conflicts[0]?.scheduleIds.length, 3);
    const recommendation = insights.suggestions.find((item) => item.scheduleId === createdIds[0] && item.recommendedAction === 'reschedule');
    assert.ok(recommendation?.id);

    const beforeConfirmationResponse = await request(api, '/schedules', { headers });
    const beforeConfirmation = await beforeConfirmationResponse.json() as { schedules: Array<{ id: string; cadence: { timeOfDay?: string } }> };
    assert.equal(beforeConfirmation.schedules.find((item) => item.id === createdIds[0])?.cadence.timeOfDay, '23:59');

    const applied = await request(api, `/schedules/${createdIds[0]}/health-action`, {
      method: 'POST', headers, body: JSON.stringify({ suggestionId: recommendation?.id }),
    });
    assert.equal(applied.status, 200);
    const appliedBody = await applied.json() as { schedule: { cadence: { timeOfDay: string } }; applied: { confirmedBy: string; action: string; before: { cadence: { timeOfDay: string } }; after: { cadence: { timeOfDay: string } } } };
    assert.equal(appliedBody.schedule.cadence.timeOfDay, '23:29');
    assert.equal(appliedBody.applied.confirmedBy, 'user-schedule-health');
    assert.equal(appliedBody.applied.action, 'reschedule');
    assert.equal(appliedBody.applied.before.cadence.timeOfDay, '23:59');
    assert.equal(appliedBody.applied.after.cadence.timeOfDay, '23:29');

    const auditResponse = await request(api, '/schedules/health-actions', { headers });
    assert.equal(auditResponse.status, 200);
    const audits = await auditResponse.json() as { actions: Array<{ scheduleId: string; suggestionId: string; confirmedBy: string }> };
    assert.equal(audits.actions.length, 1);
    assert.equal(audits.actions[0]?.scheduleId, createdIds[0]);
    assert.equal(audits.actions[0]?.suggestionId, recommendation?.id);
    assert.equal(audits.actions[0]?.confirmedBy, 'user-schedule-health');
    const otherUserAudits = await request(api, '/schedules/health-actions', { headers: otherUserHeaders });
    assert.deepEqual((await otherUserAudits.json() as { actions: unknown[] }).actions, []);

    const schedulesAfterAction = await request(api, '/schedules', { headers });
    const schedulesAfterActionBody = await schedulesAfterAction.json() as { healthActions: Array<{ suggestionId: string }> };
    assert.equal(schedulesAfterActionBody.healthActions[0]?.suggestionId, recommendation?.id);

    const stale = await request(api, `/schedules/${createdIds[0]}/health-action`, {
      method: 'POST', headers, body: JSON.stringify({ suggestionId: recommendation?.id }),
    });
    assert.equal(stale.status, 409);
  } finally {
    await store.close();
  }
});

test('schedule Artifact inputs require verified ownership and remain version-pinned after source deletion', async () => {
  const root = mkdtempSync(join(tmpdir(), 'axiom-schedule-artifact-'));
  const store = new SqliteTaskStore(':memory:');
  const artifactCatalog = new SqliteArtifactCatalog(':memory:');
  const artifactStore = new FileArtifactStore(join(root, 'artifacts'));
  await store.initialize();
  await artifactCatalog.initialize();
  const api = createTaskApi({ store, artifactCatalog, artifactStore, hub: new EventHub(), coordinator: { nudge() {}, abort() {} } as never });
  const headers = { 'content-type': 'application/json', 'x-axiom-tenant-id': 'tenant-schedule-link', 'x-axiom-user-id': 'user-schedule-link' };
  const otherUserHeaders = { ...headers, 'x-axiom-user-id': 'other-user' };
  try {
    const source = await store.createTask({
      tenantId: 'tenant-schedule-link', userId: 'user-schedule-link', sessionId: 'source-session',
      title: '已验证周报', input: '生成周报', mode: 'analyze',
    });
    const completed = await store.updateTask(source.id, { status: 'completed', result: '# 已验证结果\n\n保留这份内容作为下游输入。' });
    await store.appendEvent(completed, {
      type: 'task.completed',
      payload: {
        evidenceSummary: {
          status: 'verified', totalSteps: 1, completedSteps: 1, failedSteps: 0, skippedSteps: 0,
          acceptanceCriteria: 1, evidenceItems: 1, artifactRefs: 1, toolReceipts: 0,
          review: 'approved', gaps: [],
        },
      },
    });

    const candidateResponse = await request(api, '/schedules/artifact-inputs', { headers });
    const candidates = await candidateResponse.json() as { artifacts: Array<{ taskId: string; artifactId: string; revision: number }> };
    assert.equal(candidates.artifacts[0]?.taskId, source.id);
    assert.equal(candidates.artifacts[0]?.artifactId, `result:${source.id}`);
    const otherCandidateResponse = await request(api, '/schedules/artifact-inputs', { headers: otherUserHeaders });
    assert.deepEqual((await otherCandidateResponse.json() as { artifacts: unknown[] }).artifacts, []);

    const forbidden = await request(api, '/schedules', {
      method: 'POST', headers: otherUserHeaders, body: JSON.stringify({
        sessionId: 'forbidden', title: '越权接续', input: '处理结果', mode: 'analyze', enabled: true,
        inputArtifactTaskId: source.id, cadence: { kind: 'daily', timeOfDay: '23:59', timezone: 'Asia/Shanghai' },
      }),
    });
    assert.equal(forbidden.status, 400);

    const created = await request(api, '/schedules', {
      method: 'POST', headers, body: JSON.stringify({
        sessionId: 'linked-schedule', title: '接续分析', input: '基于上一份结果补充变化', mode: 'analyze', enabled: true,
        inputArtifactTaskId: source.id, cadence: { kind: 'daily', timeOfDay: '23:59', timezone: 'Asia/Shanghai' },
      }),
    });
    assert.equal(created.status, 201);
    const schedule = (await created.json() as { schedule: { id: string; inputArtifact: { sourceTaskId: string; contentSha256: string } } }).schedule;
    assert.equal(schedule.inputArtifact.sourceTaskId, source.id);
    assert.equal(schedule.inputArtifact.contentSha256.length, 64);
    assert.equal((await artifactCatalog.get('tenant-schedule-link', `result:${source.id}`))?.referenceCount, 2);

    const removedSource = await request(api, `/tasks/${source.id}`, { method: 'DELETE', headers });
    assert.equal(removedSource.status, 204);
    assert.equal((await artifactCatalog.get('tenant-schedule-link', `result:${source.id}`))?.referenceCount, 1);
    assert.match(await artifactStore.get(`result:${source.id}`, 'tenant-schedule-link') ?? '', /保留这份内容/u);

    const runResponse = await request(api, `/schedules/${schedule.id}/run`, {
      method: 'POST', headers, body: JSON.stringify({ idempotencyKey: 'linked-artifact-run-001' }),
    });
    assert.equal(runResponse.status, 202);
    const run = await runResponse.json() as { task: { id: string; input: string } };
    assert.match(run.task.input, /\[已验证日程输入\]/u);
    assert.match(run.task.input, /保留这份内容作为下游输入/u);
    const createdEvent = (await store.getEvents(run.task.id)).find((event) => event.type === 'task.created');
    assert.equal((createdEvent?.payload.inputArtifact as { sourceTaskId?: string } | undefined)?.sourceTaskId, source.id);

    assert.equal((await request(api, `/schedules/${schedule.id}`, { method: 'DELETE', headers })).status, 204);
    assert.equal((await artifactCatalog.get('tenant-schedule-link', `result:${source.id}`))?.referenceCount, 0);
  } finally {
    await artifactCatalog.close();
    await store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
