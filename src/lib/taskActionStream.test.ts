import assert from 'node:assert/strict';
import test from 'node:test';
import { streamWorkflowEvents } from './taskRuntime';

const eventResponse = (type: string, sequence: number) => new Response(`event: runtime\ndata: ${JSON.stringify({ id: `event-${sequence}`, taskId: 'task', sequence, type, payload: {} })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });

test('a current pause ends the subscription without marking the task complete', async () => {
  const original = globalThis.fetch;
  const events: string[] = [];
  let reads = 0;
  globalThis.fetch = async (url) => {
    reads += 1;
    return String(url).includes('/events') ? eventResponse('task.paused', 9) : Response.json({ task: { id: 'task', status: 'paused' } });
  };
  try {
    await streamWorkflowEvents('task', new AbortController().signal, (event) => events.push(event.type), 8);
    assert.deepEqual(events, ['task.paused']); assert.equal(reads, 2);
  } finally { globalThis.fetch = original; }
});

test('replayed human boundaries cannot stop a task that has already resumed', async () => {
  const original = globalThis.fetch;
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { setTimeout, clearTimeout } });
  const requests: string[] = [];
  const events: string[] = [];
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    if (!String(url).includes('/events')) return Response.json({ task: { id: 'task', status: 'running' } });
    return String(url).endsWith('after=0') ? eventResponse('tool.approval_requested', 4) : eventResponse('task.completed', 6);
  };
  try {
    await streamWorkflowEvents('task', new AbortController().signal, (event) => events.push(event.type));
    assert.deepEqual(events, ['tool.approval_requested', 'task.completed']);
    assert.ok(requests.includes('/api/tasks/task/events?after=4'));
  } finally {
    globalThis.fetch = original;
    if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});
