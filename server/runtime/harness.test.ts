import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BuiltinHarnessAdapter,
  HarnessEventDeduper,
  harnessEventToRuntimeEvent,
  type HarnessEvent,
} from './harness.js';

const baseEvent = (overrides: Partial<HarnessEvent> = {}): HarnessEvent => ({
  id: 'evt-1',
  sequence: 7,
  kind: 'message.delta',
  threadId: 'thread-1',
  turnId: 'turn-1',
  itemId: 'item-1',
  payload: { content: 'hello' },
  ...overrides,
});

test('builtin harness exposes an honest authoritative capability contract', async () => {
  const adapter = new BuiltinHarnessAdapter();
  const capabilities = await adapter.handshake();
  assert.equal(capabilities.kind, 'builtin');
  assert.equal(capabilities.protocol, 'builtin/v1');
  assert.equal(capabilities.active, true);
  assert.match(capabilities.reason, /WorkflowOrchestrator/);
  assert.ok(capabilities.capabilities.includes('runtime-event-replay'));

  const thread = await adapter.startThread({ taskId: 'task-1', sessionId: 'session-1' });
  assert.deepEqual(thread, {
    threadId: 'builtin-thread:task-1',
    taskId: 'task-1',
    sessionId: 'session-1',
    kind: 'builtin',
    externallyOwned: false,
  });
  const turn = await adapter.startTurn({ taskId: 'task-1', threadId: thread.threadId, runId: 'run-1', input: 'test' });
  assert.equal(turn.turnId, 'run-1');
  assert.equal((await adapter.resume(thread.threadId)).accepted, false);
});

test('harness events map thread, turn, item, reasoning and approval identity into RuntimeEvent', () => {
  const context = { taskId: 'task-1', runId: 'run-1', fallbackAgentId: 'agent-fallback' };
  const thread = harnessEventToRuntimeEvent(baseEvent({
    kind: 'thread.forked',
    id: 'thread-event',
    parentThreadId: 'thread-root',
    agentId: 'agent-child',
    payload: { childThreadId: 'thread-child' },
  }), context);
  assert.equal(thread?.type, 'thread.forked');
  assert.equal(thread?.agentId, 'agent-child');
  assert.deepEqual(thread?.payload.harness, {
    kind: 'thread.forked',
    eventId: 'thread-event',
    externalSequence: 7,
    threadId: 'thread-1',
    turnId: 'turn-1',
    itemId: 'item-1',
    parentThreadId: 'thread-root',
  });

  const reasoning = harnessEventToRuntimeEvent(baseEvent({
    kind: 'reasoning.delta',
    payload: { content: 'thinking' },
  }), context);
  assert.equal(reasoning?.type, 'model.delta');
  assert.equal(reasoning?.payload.channel, 'reasoning');

  const approval = harnessEventToRuntimeEvent(baseEvent({
    kind: 'approval.requested',
    payload: { requestId: 'approval-1', itemType: 'command' },
  }), context);
  assert.equal(approval?.type, 'approval.requested');
  assert.equal((approval?.payload.harness as { itemId?: string }).itemId, 'item-1');

  const unknown = harnessEventToRuntimeEvent(baseEvent({ kind: 'checkpoint.saved' }), context);
  assert.equal(unknown?.type, 'checkpoint.saved');
});

test('harness event deduper accepts a replay once and bounds retained identities', () => {
  const deduper = new HarnessEventDeduper(2);
  const first = baseEvent({ id: 'a', sequence: 1 });
  assert.equal(deduper.accept(first), true);
  assert.equal(deduper.accept(first), false);
  assert.equal(deduper.accept(baseEvent({ id: 'b', sequence: 2 })), true);
  assert.equal(deduper.accept(baseEvent({ id: 'c', sequence: 3 })), true);
  // The oldest key was evicted, so a reconnect can be accepted after the bound.
  assert.equal(deduper.accept(first), true);
});

