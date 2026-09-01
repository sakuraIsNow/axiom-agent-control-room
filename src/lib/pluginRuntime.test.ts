import assert from 'node:assert/strict';
import test from 'node:test';
import { runPlugin } from './pluginRuntime';

test('plugin workflow runs carry a stable idempotency key', async () => {
  const originalFetch = globalThis.fetch;
  let captured: RequestInit | undefined;
  globalThis.fetch = async (_input, init) => {
    captured = init;
    return new Response(JSON.stringify({ task: { id: 'task-1' }, eventsUrl: '/events', pluginId: 'plugin-1', pluginVersion: 1 }), {
      status: 202,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    await runPlugin({
      pluginId: 'plugin-1',
      sessionId: 'session-1',
      input: '运行',
      idempotencyKey: 'plugin:plugin-1:session-1:assistant-1',
    });
    assert.equal(new Headers(captured?.headers).get('Idempotency-Key'), 'plugin:plugin-1:session-1:assistant-1');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
