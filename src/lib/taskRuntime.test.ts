import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkflowTask, sendTaskGuidance } from './taskRuntime';

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

test('live guidance sends an explicit behavior and returns its durable receipt', async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = '';
  let captured: RequestInit | undefined;
  globalThis.fetch = async (input, init) => {
    capturedUrl = String(input);
    captured = init;
    return new Response(JSON.stringify({
      taskId: 'task-1',
      guidanceId: 'guidance-1',
      status: 'accepted',
      delivery: 'builtin-next-safe-point',
      accepted: { id: 'event-1', type: 'human.guidance_accepted', version: 1, taskId: 'task-1', runId: 'run-1', sequence: 2, timestamp: new Date().toISOString(), payload: {} },
    }), { status: 202, headers: { 'content-type': 'application/json' } });
  };
  try {
    const receipt = await sendTaskGuidance('task-1', '继续前先补充移动端验证。');
    assert.equal(capturedUrl, '/api/tasks/task-1/guidance');
    assert.equal(captured?.method, 'POST');
    assert.deepEqual(JSON.parse(String(captured?.body)), { message: '继续前先补充移动端验证。', behavior: 'continue' });
    assert.equal(receipt.guidanceId, 'guidance-1');
    assert.equal(receipt.status, 'accepted');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
