import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkflowTask } from './taskRuntime';

test('workflow task creation sends the stable idempotency key', async () => {
  const originalFetch = globalThis.fetch;
  let captured: RequestInit | undefined;
  globalThis.fetch = async (_input, init) => {
    captured = init;
    return new Response(JSON.stringify({ task: { id: 'task-1' } }), {
      status: 202,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    await createWorkflowTask({
      sessionId: 'session-1',
      title: '幂等任务',
      prompt: '测试',
      mode: 'analyze',
      idempotencyKey: ' conversation:session-1:assistant-1 ',
      signal: new AbortController().signal,
    });
    const headers = new Headers(captured?.headers);
    assert.equal(headers.get('Idempotency-Key'), 'conversation:session-1:assistant-1');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('workflow task creation omits an empty idempotency key', async () => {
  const originalFetch = globalThis.fetch;
  let captured: RequestInit | undefined;
  globalThis.fetch = async (_input, init) => {
    captured = init;
    return new Response(JSON.stringify({ task: { id: 'task-1' } }), {
      status: 202,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    await createWorkflowTask({
      sessionId: 'session-1',
      title: '普通任务',
      prompt: '测试',
      mode: 'analyze',
      idempotencyKey: '  ',
      signal: new AbortController().signal,
    });
    const headers = new Headers(captured?.headers);
    assert.equal(headers.has('Idempotency-Key'), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
