import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { SqliteTaskStore } from './sqliteTaskStore.js';
import { dateKeyInTimeZone } from './taskStatsDate.js';

const taskInput = (title: string) => ({
  tenantId: 'tenant-a',
  userId: 'user-a',
  sessionId: 'session-a',
  title,
  input: `Execute ${title}`,
  mode: 'build' as const,
});

describe('SqliteTaskStore', () => {
  test('deletes a tenant-owned task and cascades its event history', async () => {
    const store = new SqliteTaskStore(':memory:');
    await store.initialize();
    try {
      const task = await store.createTask({
        tenantId: 'tenant-a',
        userId: 'operator',
        sessionId: 'delete-session',
        title: 'Delete me',
        input: 'test deletion',
        mode: 'build',
      });
      await store.appendEvent(task, { type: 'task.created', payload: {} });
      assert.equal(await store.deleteTask(task.id, 'tenant-b'), false);
      assert.equal(await store.deleteTask(task.id, 'tenant-a'), true);
      assert.equal(await store.getTask(task.id), null);
      assert.deepEqual(await store.getEvents(task.id), []);
    } finally {
      await store.close();
    }
  });

  test('persists ordered events and enforces lease ownership', async () => {
    const store = new SqliteTaskStore(':memory:');
    await store.initialize();
    try {
      const task = await store.createTask(taskInput('ordered workflow'));
      const created = await store.appendEvent(task, { type: 'task.created', payload: {} });
      const queued = await store.appendEvent(task, { type: 'task.queued', payload: {} });

      assert.equal(created.sequence, 1);
      assert.equal(queued.sequence, 2);
      assert.deepEqual((await store.getEvents(task.id, 1)).map((event) => event.sequence), [2]);

      const claimed = await store.claimNextTask('worker-a', 60_000);
      assert.equal(claimed?.id, task.id);
      assert.equal(await store.claimNextTask('worker-b', 60_000), null);
      assert.equal(await store.renewLease(task.id, 'worker-b', 60_000), false);
      assert.equal(await store.renewLease(task.id, 'worker-a', 60_000), true);
      await store.releaseLease(task.id, 'worker-a');
      assert.equal((await store.claimNextTask('worker-b', 60_000))?.id, task.id);
    } finally {
      await store.close();
    }
  });

  test('persists a unified execution context for replay and cross-entrypoint tracing', async () => {
    const store = new SqliteTaskStore(':memory:');
    await store.initialize();
    try {
      const task = await store.createTask({ ...taskInput('trace context'), templateId: 'workflow-1', idempotencyKey: 'submission-1' });
      await store.appendEvent(task, { type: 'turn.started', payload: { source: 'agent-nexus', turnId: 'turn-7', attemptId: 'attempt-2' } });
      const event = (await store.getEvents(task.id))[0];
      assert.equal(event?.runtimeContext?.tenantId, task.tenantId);
      assert.equal(event?.runtimeContext?.userId, task.userId);
      assert.equal(event?.runtimeContext?.sessionId, task.sessionId);
      assert.equal(event?.runtimeContext?.workflowId, 'workflow-1');
      assert.equal(event?.runtimeContext?.turnId, 'turn-7');
      assert.equal(event?.runtimeContext?.attemptId, 'attempt-2');
      assert.equal(event?.runtimeContext?.source, 'agent-nexus');
      assert.equal(event?.runtimeContext?.submissionId, 'submission-1');
    } finally {
      await store.close();
    }
  });

  test('moves a queued cancellation directly to a terminal state', async () => {
    const store = new SqliteTaskStore(':memory:');
    await store.initialize();
    try {
      const task = await store.createTask(taskInput('cancel me'));
      assert.equal(await store.requestCancel(task.id, task.tenantId), true);
      const cancelled = await store.getTask(task.id, task.tenantId);
      assert.equal(cancelled?.status, 'cancelled');
      assert.equal(cancelled?.cancelRequested, true);
      assert.equal(await store.claimNextTask('worker-a', 60_000), null);
      assert.equal(await store.requestCancel(task.id, task.tenantId), false);
    } finally {
      await store.close();
    }
  });

  test('cancels paused and human-gated tasks without waiting for a worker', async () => {
    const store = new SqliteTaskStore(':memory:');
    await store.initialize();
    try {
      for (const status of ['awaiting_approval', 'waiting_for_human', 'paused'] as const) {
        const task = await store.createTask({ ...taskInput(`cancel ${status}`), sessionId: `session-${status}` });
        await store.updateTask(task.id, { status });
        assert.equal(await store.requestCancel(task.id, task.tenantId), true);
        const cancelled = await store.getTask(task.id, task.tenantId);
        assert.equal(cancelled?.status, 'cancelled');
        assert.equal(cancelled?.cancelRequested, true);
      }
    } finally {
      await store.close();
    }
  });

  test('persists execution policy and nullable plan revisions', async () => {
    const store = new SqliteTaskStore(':memory:');
    await store.initialize();
    try {
      const task = await store.createTask({
        ...taskInput('governed workflow'),
        policy: { requirePlanApproval: true, maxTokens: 12_000, maxConcurrentSteps: 2 },
      });
      assert.equal(task.policy.requirePlanApproval, true);
      assert.equal(task.policy.maxTokens, 12_000);
      const versioned = await store.updateTask(task.id, { planVersion: 2, plan: null, review: null, result: null });
      assert.equal(versioned.planVersion, 2);
      assert.equal(versioned.plan, undefined);
      assert.equal(versioned.policy.maxConcurrentSteps, 2);
    } finally {
      await store.close();
    }
  });

  test('persists a tenant-scoped model credential reference for resumable workers', async () => {
    const store = new SqliteTaskStore(':memory:');
    await store.initialize();
    try {
      const task = await store.createTask({ ...taskInput('credential-bound workflow'), model: 'local-model', modelCredentialId: 'cred-123' });
      const restored = await store.getTask(task.id, task.tenantId);
      assert.equal(restored?.model, 'local-model');
      assert.equal(restored?.modelCredentialId, 'cred-123');
    } finally {
      await store.close();
    }
  });

  test('finds tasks by tenant-scoped idempotency key', async () => {
    const store = new SqliteTaskStore(':memory:');
    await store.initialize();
    try {
      const task = await store.createTask({ ...taskInput('deduplicated request'), idempotencyKey: 'webhook-42' });
      assert.equal((await store.findTaskByIdempotency('tenant-a', 'webhook-42'))?.id, task.id);
      assert.equal(await store.findTaskByIdempotency('tenant-b', 'webhook-42'), null);
    } finally {
      await store.close();
    }
  });

  test('reconstructs model routing observations from durable events', async () => {
    const store = new SqliteTaskStore(':memory:');
    await store.initialize();
    try {
    const task = await store.createTask({ ...taskInput('routing history'), tenantId: 'tenant-routing' });
    await store.appendEvent(task, { type: 'model.completed', payload: { model: 'fast', durationMs: 120, totalTokens: 40 } });
    await store.appendEvent(task, { type: 'model.completed', payload: { model: 'fast', durationMs: 180, totalTokens: 60 } });
    await store.appendEvent(task, { type: 'agent.failed', payload: { model: 'slow' } });
    const stats = await store.getModelRoutingStats();
    const fast = stats.find((entry) => entry.model === 'fast');
    assert.equal(fast?.model, 'fast');
    assert.equal(fast?.attempts, 2);
    assert.equal(fast?.successes, 2);
    assert.equal(fast?.failures, 0);
    assert.equal(fast?.totalLatencyMs, 300);
    assert.equal(fast?.totalTokens, 100);
    assert.ok(fast?.lastUsedAt);
    assert.equal(stats.find((entry) => entry.model === 'slow')?.failures, 1);
    } finally {
      await store.close();
    }
  });

  test('returns a complete daily window ending on the current business day', async () => {
    const store = new SqliteTaskStore(':memory:');
    await store.initialize();
    try {
      const daily = await store.getTaskStatsDaily('tenant-a', 7);
      assert.equal(daily.length, 7);
      assert.equal(daily.at(-1)?.date, dateKeyInTimeZone(Date.now(), 'Asia/Shanghai'));
      assert.ok(daily.every((point) => point.totalTokens === 0 && point.estimatedCostUsd === 0));
    } finally {
      await store.close();
    }
  });

  test('aggregates task telemetry in one event query without crossing task boundaries', async () => {
    const store = new SqliteTaskStore(':memory:');
    await store.initialize();
    try {
      const first = await store.createTask(taskInput('first'));
      const second = await store.createTask({ ...taskInput('second'), tenantId: 'tenant-b' });
      await store.appendEvent(first, { type: 'task.created', payload: { source: 'conversation' } });
      await store.appendEvent(first, { type: 'task.queued', payload: {} });
      await store.appendEvent(first, { type: 'task.started', payload: {} });
      await store.appendEvent(first, { type: 'model.completed', payload: { promptTokens: 4, completionTokens: 6, totalTokens: 10, estimatedCostUsd: 0.0001234 } });
      await store.appendEvent(first, { type: 'agent.retrying', payload: {} });
      await store.appendEvent(first, { type: 'tool.started', payload: { name: 'workspace.read' } });
      await store.appendEvent(second, { type: 'model.completed', payload: { promptTokens: 99, completionTokens: 99, totalTokens: 198 } });
      const summary = await store.getTaskEventSummaries([first.id], 'tenant-a');
      assert.deepEqual(summary.get(first.id), {
        source: 'conversation',
        modelCalls: 1,
        promptTokens: 4,
        completionTokens: 6,
        totalTokens: 10,
        estimatedCostUsd: 0.000123,
        retries: 1,
        toolCalls: 1,
        queuedAt: (summary.get(first.id)?.queuedAt),
        startedAt: (summary.get(first.id)?.startedAt),
        latest: (summary.get(first.id)?.latest),
      });
      assert.equal(summary.has(second.id), false);
      assert.equal((await store.getTaskEventSummaries([second.id], 'tenant-a')).has(second.id), false);
    } finally {
      await store.close();
    }
  });
});
