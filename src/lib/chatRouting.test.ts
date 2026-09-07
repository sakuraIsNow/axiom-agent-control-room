import assert from 'node:assert/strict';
import test from 'node:test';
import { fallbackChatRoute } from './chatRoutingFallback';
import { routeChatMessage } from './chatRouting';

const provider = {
  useCustom: false,
  location: 'internet' as const,
  apiUrl: '',
  apiKey: '',
  model: 'deepseek-chat',
};

test('route requests retry a transient gateway error before accepting a valid decision', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  const decision = fallbackChatRoute({ message: 'compare two database options', mode: 'decide' });
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) return new Response(JSON.stringify({ error: 'temporary unavailable' }), { status: 503 });
    return new Response(JSON.stringify({ decision }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const routed = await routeChatMessage('compare two database options', 'decide', [], provider, new AbortController().signal);
    assert.equal(calls, 2);
    assert.equal(routed.source, 'deterministic-fallback');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('route requests retry a transient network failure', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) throw new TypeError('network unavailable');
    return new Response(JSON.stringify({ decision: fallbackChatRoute({ message: 'hello', mode: 'analyze' }) }), { status: 200 });
  };
  try {
    const routed = await routeChatMessage('hello', 'analyze', [], provider, new AbortController().signal);
    assert.equal(calls, 2);
    assert.equal(routed.intent, 'conversation');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('route requests return a local semantic fallback after a non-retryable failure', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ error: 'bad request' }), { status: 400 });
  };
  try {
    const routed = await routeChatMessage('generate a product image', 'build', [], provider, new AbortController().signal);
    assert.equal(calls, 1);
    assert.equal(routed.intent, 'image-generation');
    assert.equal(routed.agentRole, 'drawing-agent');
    assert.equal(routed.source, 'deterministic-fallback');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('an already cancelled route does not issue a request or silently fall back', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response('{}', { status: 200 });
  };
  const controller = new AbortController();
  controller.abort(new DOMException('cancelled', 'AbortError'));
  try {
    await assert.rejects(() => routeChatMessage('hello', 'analyze', [], provider, controller.signal));
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('malformed routing responses use the shared compound fallback', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ decision: { intent: 'web-search' } }), { status: 200 });
  const message = '请基于最新官方资料，比较 PostgreSQL 与 SQLite 在多 worker 部署中的并发、迁移和故障恢复风险，给出选型方案并验证结论';
  try {
    const decision = await routeChatMessage(message, 'decide', [], provider, new AbortController().signal);
    assert.deepEqual(decision, fallbackChatRoute({ message, mode: 'decide' }));
    assert.deepEqual(decision.scheduler.executionWaves, [['research'], ['analysis'], ['quality-review']]);
    assert.equal(decision.scheduler.requiresReview, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
