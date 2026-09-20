import assert from 'node:assert/strict';
import test from 'node:test';
import { fallbackChatRoute } from './chatRoutingFallback';
import { routeChatMessage } from './chatRouting';
import { routingClientBudgetMs, routingServerBudgetMs } from '../../server/shared/routingBudget';

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

test('uncertain network failure does not duplicate the server routing request', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) throw new TypeError('network unavailable');
    return new Response(JSON.stringify({ decision: fallbackChatRoute({ message: 'hello', mode: 'analyze' }) }), { status: 200 });
  };
  try {
    const routed = await routeChatMessage('hello', 'analyze', [], provider, new AbortController().signal);
    assert.equal(calls, 1);
    assert.equal(routed.intent, 'conversation');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('authorization or capability rejection cannot become a browser fallback', async (context) => {
  let calls = 0;
  context.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    return Response.json({ error: 'Capability unavailable.', code: 'ROUTING_CAPABILITY_UNAVAILABLE' }, { status: 503 });
  });
  await assert.rejects(routeChatMessage('generate an image', 'build', [], provider, new AbortController().signal), /Capability unavailable/);
  assert.equal(calls, 1);
});

test('server budget exhaustion does not restart the entire Router/Scheduler sequence', async (context) => {
  let calls = 0;
  context.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    return Response.json({ code: 'ROUTING_INTERRUPTED' }, { status: 408 });
  });
  const decision = await routeChatMessage('hello', 'analyze', [], provider, new AbortController().signal);
  assert.equal(calls, 1);
  assert.equal(decision.source, 'deterministic-fallback');
});

test('browser timeout allows the server budget and never launches an overlapping request', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  let requestSignal: AbortSignal | undefined;
  context.mock.method(globalThis, 'fetch', async (_url: string, options?: RequestInit) => {
    calls += 1; requestSignal = options?.signal ?? undefined;
    return new Promise<Response>(() => undefined);
  });
  const result = routeChatMessage('hello', 'analyze', [], provider, new AbortController().signal);
  assert.ok(routingClientBudgetMs > routingServerBudgetMs);
  context.mock.timers.tick(12_000);
  assert.equal(requestSignal?.aborted, false);
  context.mock.timers.tick(routingClientBudgetMs - 12_000);
  assert.equal((await result).source, 'deterministic-fallback');
  assert.equal(requestSignal?.aborted, true);
  assert.equal(calls, 1);
});

test('user cancellation during an active route propagates rather than becoming fallback', async (context) => {
  const controller = new AbortController();
  let requestSignal: AbortSignal | undefined;
  context.mock.method(globalThis, 'fetch', async (_url: string, options?: RequestInit) => {
    requestSignal = options?.signal ?? undefined;
    return new Promise<Response>(() => undefined);
  });
  const result = routeChatMessage('hello', 'analyze', [], provider, controller.signal);
  controller.abort(new DOMException('cancelled', 'AbortError'));
  await assert.rejects(result, /cancelled/);
  assert.equal(requestSignal?.aborted, true);
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

test('browser failures never reactivate previous search when this turn prohibits searching again', async (context) => {
  context.mock.method(globalThis, 'fetch', async () => new Response('{"decision":{"intent":"web-search"}}', { status: 200 }));
  const message = '不要重新搜索，仅把上一轮结论整理成三个要点，不要新增事实。';
  const graph = { nodes: [{ id: 'old-search', agentId: 'search-agent', role: 'search-agent', title: '搜索', status: 'completed' as const, dependsOn: [] }], edges: [] };
  const result = await routeChatMessage(message, 'analyze', [], provider, new AbortController().signal, { graph, messages: [{ id: 'previous', role: 'assistant', content: 'Previous search is complete.', createdAt: 1 }] });
  assert.deepEqual(result, fallbackChatRoute({ message, mode: 'analyze', currentGraph: graph }));
  assert.equal(result.requiresSearch, false);
  assert.equal(result.router.requiresExternalFacts, false);
  assert.deepEqual(result.scheduler.activeAgentIds, ['direct-responder']);
  assert.deepEqual(result.scheduler.skippedAgentIds, ['search-agent']);
  assert.deepEqual(result.skillIds, []);
});

test('browser fallback does not treat a negated retrieval object as a global search prohibition', async (context) => {
  context.mock.method(globalThis, 'fetch', async () => new Response('{"decision":{}}', { status: 200 }));
  for (const message of ['不用搜索天气，只查询今天的美元人民币汇率。', '不要搜索“天气”，只查询今天的美元人民币汇率。', "Don't search for weather; only look up today's USD/CNY exchange rate.", 'Do not browse; instead search the latest exchange rates.']) {
    const result = await routeChatMessage(message, 'analyze', [], provider, new AbortController().signal);
    assert.equal(result.requiresSearch, true, message);
    assert.deepEqual(result.scheduler.activeAgentIds, ['search-agent'], message);
  }
});
