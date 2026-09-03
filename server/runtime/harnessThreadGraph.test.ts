import assert from 'node:assert/strict';
import test from 'node:test';
import type { RuntimeEvent } from './contracts.js';
import { breadthFirstThreadDescendants, buildHarnessThreadGraph } from './harnessThreadGraph.js';

const event = (sequence: number, type: RuntimeEvent['type'], payload: Record<string, unknown>): RuntimeEvent => ({
  id: `event-${sequence}`,
  sequence,
  type,
  version: 1,
  taskId: 'task-thread-graph',
  runId: 'run-thread-graph',
  timestamp: new Date(Date.UTC(2026, 8, 3, 8, 0, sequence)).toISOString(),
  payload,
});

test('durable Harness events project open and closed parent-child Threads in breadth-first order', () => {
  const graph = buildHarnessThreadGraph([
    event(1, 'harness.connected', { threadId: 'root' }),
    event(2, 'thread.forked', { childThreadId: 'child-a', harness: { threadId: 'child-a', parentThreadId: 'root' } }),
    event(3, 'thread.forked', { childThreadId: 'child-b', harness: { threadId: 'child-b', parentThreadId: 'root' } }),
    event(4, 'thread.forked', { childThreadId: 'grandchild', harness: { threadId: 'grandchild', parentThreadId: 'child-a' } }),
    event(5, 'thread.closed', { harness: { threadId: 'child-a' } }),
  ]);

  assert.deepEqual(graph.nodes.map((node) => [node.threadId, node.depth, node.state]), [
    ['root', 0, 'open'],
    ['child-a', 1, 'closed'],
    ['child-b', 1, 'open'],
    ['grandchild', 2, 'open'],
  ]);
  assert.deepEqual(breadthFirstThreadDescendants(graph, 'root')?.map((node) => node.threadId), ['child-a', 'child-b', 'grandchild']);
  assert.equal(breadthFirstThreadDescendants(graph, 'missing'), null);
});

test('terminal tasks close every Thread and malformed parent cycles are ignored', () => {
  const graph = buildHarnessThreadGraph([
    event(1, 'thread.started', { harness: { threadId: 'root' } }),
    event(2, 'thread.forked', { harness: { threadId: 'child', parentThreadId: 'root' } }),
    event(3, 'thread.forked', { harness: { threadId: 'root', parentThreadId: 'child' } }),
    event(4, 'task.completed', {}),
  ]);
  assert.deepEqual(graph.edges, [{ parentThreadId: 'root', childThreadId: 'child' }]);
  assert.ok(graph.nodes.every((node) => node.state === 'closed'));
  assert.ok(graph.nodes.every((node) => node.updatedAt === event(4, 'task.completed', {}).timestamp));
});
