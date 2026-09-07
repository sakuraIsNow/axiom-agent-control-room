import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventHub } from './eventHub.js';
import { HarnessTaskBridge } from './harnessBridge.js';
import type {
  HarnessAdapter,
  HarnessCapabilities,
  HarnessCommandResult,
  HarnessEvent,
  HarnessThread,
  HarnessThreadInput,
  HarnessTurn,
  HarnessTurnInput,
} from './harness.js';
import { SqliteTaskStore } from './sqliteTaskStore.js';

class FakeHarness implements HarnessAdapter {
  readonly kind = 'deepseek' as const;
  readonly protocol = 'deepseek-harness/v1' as const;
  private readonly queues = new Map<string, { events: HarnessEvent[]; waiters: Array<(event?: HarnessEvent) => void> }>();
  private readonly lastEvents = new Map<string, HarnessEvent>();
  private readonly pendingApprovals = new Set<string>();
  private sequence = 0;
  autoComplete = true;

  async handshake(): Promise<HarnessCapabilities> {
    return {
      kind: this.kind,
      protocol: this.protocol,
      version: 'test',
      configured: true,
      compatible: true,
      active: true,
      capabilities: ['session-new', 'session-resume'],
      reason: 'test',
    };
  }

  async startThread(input: HarnessThreadInput): Promise<HarnessThread> {
    this.queues.set(input.taskId, { events: [], waiters: [] });
    return { threadId: `thread-${input.taskId}`, taskId: input.taskId, sessionId: input.sessionId, kind: this.kind, externallyOwned: true };
  }

  async startTurn(input: HarnessTurnInput): Promise<HarnessTurn> {
    this.push(input.threadId, 'turn.started', { turnId: input.runId });
    if (!this.autoComplete) return { turnId: input.runId, threadId: input.threadId, taskId: input.taskId, runId: input.runId };
    queueMicrotask(() => {
      this.push(input.threadId, 'message.delta', { content: 'external answer' });
      this.push(input.threadId, 'message.delta', { content: 'external answer' }, { duplicate: true });
      this.push(input.threadId, 'message.delta', { content: 'cross tenant' }, { taskId: 'other-task' });
      this.push(input.threadId, 'turn.completed', { turnId: input.runId });
    });
    return { turnId: input.runId, threadId: input.threadId, taskId: input.taskId, runId: input.runId };
  }

  async resume(threadId: string): Promise<HarnessCommandResult> {
    this.push(threadId, 'turn.started', { resumed: true });
    if (this.autoComplete) {
      queueMicrotask(() => this.push(threadId, 'message.delta', { content: ' resumed' }));
      queueMicrotask(() => this.push(threadId, 'turn.completed', {}));
    }
    return { accepted: true, delegated: true, command: 'resume' };
  }

  async interrupt(): Promise<HarnessCommandResult> {
    return { accepted: true, delegated: true, command: 'interrupt' };
  }

  async approve(requestId: string, decision: 'approved' | 'rejected'): Promise<HarnessCommandResult> {
    if (!this.pendingApprovals.delete(requestId)) return { accepted: false, delegated: true, command: 'approve', reason: 'approval already resolved' };
    const threadId = [...this.lastEvents.keys()][0];
    if (threadId) this.push(threadId, 'approval.resolved', { requestId, decision });
    return { accepted: true, delegated: true, command: 'approve' };
  }

  async steer(): Promise<HarnessCommandResult> {
    return { accepted: true, delegated: true, command: 'steer' };
  }

  async *subscribe(threadId: string, afterSequence = 0, signal?: AbortSignal): AsyncIterable<HarnessEvent> {
    const queue = [...this.queues.values()][0]!;
    while (!signal?.aborted) {
      const event = queue.events.find((candidate) => candidate.threadId === threadId && candidate.sequence > afterSequence);
      if (event) {
        queue.events.splice(queue.events.indexOf(event), 1);
        afterSequence = event.sequence;
        yield event;
        continue;
      }
      const next = await new Promise<HarnessEvent | undefined>((resolve) => {
        const onAbort = () => resolve(undefined);
        signal?.addEventListener('abort', onAbort, { once: true });
        queue.waiters.push((value) => {
          signal?.removeEventListener('abort', onAbort);
          resolve(value);
        });
      });
      if (!next) return;
      afterSequence = next.sequence;
      yield next;
    }
  }

  requestApproval(threadId: string, requestId = 'approval-1') {
    this.pendingApprovals.add(requestId);
    this.push(threadId, 'approval.requested', { requestId, stepId: 'external-step', toolCall: { name: 'workspace.write', args: { path: 'out.txt' }, risk: 'high' } });
  }

  private push(threadId: string, kind: HarnessEvent['kind'], payload: Record<string, unknown>, options: { duplicate?: boolean; taskId?: string } = {}) {
    const queue = [...this.queues.values()][0];
    if (!queue) return;
    const previous = this.lastEvents.get(threadId);
    const sequence = options.duplicate ? previous?.sequence ?? this.sequence : ++this.sequence;
    const event: HarnessEvent = options.duplicate && previous
      ? { ...previous }
      : { id: `event-${sequence}`, sequence, kind, threadId, ...(options.taskId ? { taskId: options.taskId } : {}), payload };
    this.lastEvents.set(threadId, event);
    const waiter = queue.waiters.shift();
    if (waiter) waiter(event);
    else queue.events.push(event);
  }
}

const waitFor = async (predicate: () => Promise<boolean> | boolean) => {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for Harness bridge state');
};

test('HarnessTaskBridge persists external events and closes the task on a completed turn', async () => {
  const store = new SqliteTaskStore(':memory:');
  await store.initialize();
  const hub = new EventHub();
  const published: string[] = [];
  hub.subscribeAll((event) => published.push(event.type));
  const adapter = new FakeHarness();
  const bridge = new HarnessTaskBridge(store, hub, adapter);
  try {
    const task = await store.createTask({ tenantId: 'tenant-a', userId: 'user-a', sessionId: 'session-a', title: 'external', input: 'run', mode: 'build' });
    await store.updateTask(task.id, { status: 'paused' });
    const pausedTask = (await store.getTask(task.id))!;
    const result = await bridge.start(pausedTask, 'run');
    assert.equal(result.accepted, true);
    await waitFor(async () => (await store.getTask(task.id, task.tenantId))?.status === 'completed');
    const events = await store.getEvents(task.id);
    assert.ok(events.some((event) => event.type === 'harness.connected'));
    assert.ok(events.some((event) => event.type === 'turn.started'));
    assert.ok(events.some((event) => event.type === 'model.delta'));
    assert.ok(events.some((event) => event.type === 'task.completed'));
    assert.equal((await store.getTask(task.id, task.tenantId))?.result, 'external answer');
    assert.equal(events.filter((event) => event.type === 'model.delta').length, 1);
    assert.ok(published.includes('task.completed'));
  } finally {
    await bridge.close();
    await store.close();
  }
});

test('a new Harness delegation clears approval of the previous deliverable', async () => {
  const store = new SqliteTaskStore(':memory:');
  await store.initialize();
  const bridge = new HarnessTaskBridge(store, new EventHub(), new FakeHarness());
  try {
    const task = await store.createTask({ tenantId: 'tenant-a', userId: 'user-a', sessionId: 'session-a', title: 'new external work', input: 'original', mode: 'build' });
    const paused = await store.updateTask(task.id, { status: 'paused', review: { approved: true, score: 90, summary: 'Old approval', gaps: [], requiredCorrections: [] } });
    await store.appendEvent(paused, { type: 'review.approved', payload: { note: 'Only the original result was accepted.' } });
    const response = await bridge.start(paused, 'Perform a different task.');
    assert.equal(response.accepted, true);
    await waitFor(async () => (await store.getTask(task.id, task.tenantId))?.status === 'completed');
    const completed = (await store.getTask(task.id, task.tenantId))!;
    assert.ok(completed.review == null);
    assert.equal(completed.result, 'external answer');
  } finally { await bridge.close(); await store.close(); }
});

test('HarnessTaskBridge refuses unsafe concurrent delegation and preserves tenant boundaries', async () => {
  const store = new SqliteTaskStore(':memory:');
  await store.initialize();
  const bridge = new HarnessTaskBridge(store, new EventHub(), new FakeHarness());
  try {
    const task = await store.createTask({ tenantId: 'tenant-a', userId: 'user-a', sessionId: 'session-a', title: 'external', input: 'run', mode: 'build' });
    const notPaused = await bridge.start(task, 'run');
    assert.equal(notPaused.accepted, false);
    assert.match(notPaused.reason ?? '', /paused|暂停/);
    await store.updateTask(task.id, { status: 'paused' });
    const accepted = await bridge.start((await store.getTask(task.id))!, 'run');
    assert.equal(accepted.accepted, true);
    const duplicate = await bridge.start((await store.getTask(task.id))!, 'run');
    assert.equal(duplicate.accepted, false);
    assert.match(duplicate.reason ?? '', /委托|delegation/);
  } finally {
    await bridge.close();
    await store.close();
  }
});

test('HarnessTaskBridge rebuilds a paused delegation from durable events after restart', async () => {
  const store = new SqliteTaskStore(':memory:');
  await store.initialize();
  const adapter = new FakeHarness();
  adapter.autoComplete = false;
  const firstBridge = new HarnessTaskBridge(store, new EventHub(), adapter);
  const secondBridge = new HarnessTaskBridge(store, new EventHub(), adapter);
  try {
    const task = await store.createTask({ tenantId: 'tenant-recovery', userId: 'user-a', sessionId: 'session-a', title: 'recover', input: 'resume', mode: 'build' });
    await store.updateTask(task.id, { status: 'paused' });
    await firstBridge.start((await store.getTask(task.id))!, 'resume');
    await new Promise((resolve) => setTimeout(resolve, 10));
    await firstBridge.close();
    assert.equal((await store.getTask(task.id))?.status, 'running');
    adapter.autoComplete = true;
    const recovered = await secondBridge.recover();
    assert.equal(recovered.inspected, 1);
    assert.equal(recovered.resumed, 1);
    await waitFor(async () => (await store.getTask(task.id))?.status === 'completed');
    const events = await store.getEvents(task.id);
    assert.ok(events.some((event) => event.type === 'thread.resumed'));
    assert.ok(events.some((event) => event.type === 'task.completed'));
  } finally {
    await firstBridge.close();
    await secondBridge.close();
    await store.close();
  }
});

test('HarnessTaskBridge durably replays external approvals and accepts each request once', async () => {
  const store = new SqliteTaskStore(':memory:');
  await store.initialize();
  const adapter = new FakeHarness();
  adapter.autoComplete = false;
  const bridge = new HarnessTaskBridge(store, new EventHub(), adapter);
  let recoveredBridge: HarnessTaskBridge | undefined;
  try {
    const task = await store.createTask({ tenantId: 'tenant-approval', userId: 'user-a', sessionId: 'session-a', title: 'approval', input: 'run', mode: 'build' });
    await store.updateTask(task.id, { status: 'paused' });
    await bridge.start((await store.getTask(task.id))!, 'run');
    adapter.requestApproval(`thread-${task.id}`);
    await waitFor(async () => (await store.getTask(task.id))?.status === 'waiting_for_human');
    const waiting = (await store.getTask(task.id))!;
    assert.equal(waiting.toolApprovals?.[0]?.id, 'approval-1');
    assert.equal(waiting.toolApprovals?.[0]?.status, 'pending');
    await bridge.close();
    recoveredBridge = new HarnessTaskBridge(store, new EventHub(), adapter);
    const recovery = await recoveredBridge.recover();
    assert.equal(recovery.resumed, 1);
    assert.equal((await store.getTask(task.id))?.toolApprovals?.[0]?.status, 'pending');
    const approved = await recoveredBridge.approve(task.id, 'approval-1', 'approved', '已确认');
    assert.equal(approved?.accepted, true);
    await waitFor(async () => (await store.getTask(task.id))?.toolApprovals?.[0]?.status === 'approved');
    const duplicate = await recoveredBridge.approve(task.id, 'approval-1', 'approved');
    assert.equal(duplicate?.accepted, false);
    const events = await store.getEvents(task.id);
    assert.ok(events.some((event) => event.type === 'approval.requested'));
    assert.ok(events.some((event) => event.type === 'approval.resolved'));
  } finally {
    await bridge.close();
    await recoveredBridge?.close();
    await store.close();
  }
});
