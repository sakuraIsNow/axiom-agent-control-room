import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OpenAICompatibleModelClient } from './modelClient.js';

test('retries a transient network failure without an HTTP status', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  let requestedModel = '';
  globalThis.fetch = (async (_input, init) => {
    calls += 1;
    requestedModel = JSON.parse(String(init?.body)).model;
    if (calls === 1) throw new TypeError('fetch failed');
    return new Response(JSON.stringify({
      choices: [{ message: { content: 'recovered response' } }],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const client = new OpenAICompatibleModelClient({
      apiKey: 'test-key',
      apiBase: 'https://provider.invalid',
      model: 'test-model',
      maxAttempts: 2,
    });
    const result = await client.complete({
      system: 'test',
      user: 'hello',
      model: 'tenant-model',
      signal: new AbortController().signal,
    });
    assert.equal(result.content, 'recovered response');
    assert.equal(result.attempts, 2);
    assert.equal(calls, 2);
    assert.equal(requestedModel, 'tenant-model');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('allows a keyless local-compatible model without sending an empty authorization header', async () => {
  const originalFetch = globalThis.fetch;
  let authorization: string | null = 'not-called';
  globalThis.fetch = (async (_input, init) => {
    authorization = new Headers(init?.headers).get('authorization');
    return new Response(JSON.stringify({ choices: [{ message: { content: 'local response' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const client = new OpenAICompatibleModelClient({
      apiKey: '',
      apiKeyOptional: true,
      apiBase: 'http://127.0.0.1:11434/v1',
      model: 'local-model',
    });
    const result = await client.complete({ system: 'test', user: 'hello', signal: new AbortController().signal });
    assert.equal(result.content, 'local response');
    assert.equal(authorization, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('forwards provider SSE deltas while preserving the final completion', async () => {
  const originalFetch = globalThis.fetch;
  const deltas: string[] = [];
  globalThis.fetch = (async () => new Response([
    'data: {"choices":[{"delta":{"content":"stream "}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"works"}}],"usage":{"prompt_tokens":2,"completion_tokens":2,"total_tokens":4}}\n\n',
    'data: [DONE]\n\n',
  ].join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } })) as typeof fetch;

  try {
    const client = new OpenAICompatibleModelClient({ apiKey: 'test-key', apiBase: 'https://provider.invalid', model: 'test-model' });
    const result = await client.complete({
      system: 'test',
      user: 'hello',
      signal: new AbortController().signal,
      onDelta: (delta) => { if (delta.content) deltas.push(delta.content); },
    });
    assert.deepEqual(deltas, ['stream ', 'works']);
    assert.equal(result.content, 'stream works');
    assert.equal(result.usage?.total_tokens, 4);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('accepts CRLF SSE frames and a final frame without a trailing separator', async () => {
  const originalFetch = globalThis.fetch;
  const deltas: string[] = [];
  globalThis.fetch = (async () => new Response([
    'data: {"choices":[{"delta":{"content":"crlf "}}]}\r\n\r\n',
    'data: {"choices":[{"delta":{"content":"works"}}],"usage":{"total_tokens":3}}\r\n\r\n',
    'data: [DONE]',
  ].join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } })) as typeof fetch;
  try {
    const client = new OpenAICompatibleModelClient({ apiKey: 'test-key', apiBase: 'https://provider.invalid', model: 'test-model' });
    const result = await client.complete({
      system: 'test',
      user: 'hello',
      signal: new AbortController().signal,
      onDelta: (delta) => { if (delta.content) deltas.push(delta.content); },
    });
    assert.deepEqual(deltas, ['crlf ', 'works']);
    assert.equal(result.content, 'crlf works');
    assert.equal(result.usage?.total_tokens, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('parses native function calls from provider SSE without requiring text content', async () => {
  const originalFetch = globalThis.fetch;
  let payload: Record<string, unknown> | undefined;
  globalThis.fetch = (async (_input, init) => {
    payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","function":{"name":"workspace.read","arguments":"{\\"path\\":\\"README.md\\""}}]}}]}' + '\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"}"}}]}}]}' + '\n\n',
      'data: [DONE]\n\n',
    ].join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;

  try {
    const client = new OpenAICompatibleModelClient({ apiKey: 'test-key', apiBase: 'https://provider.invalid', model: 'test-model' });
    const result = await client.complete({
      system: 'use a tool',
      user: 'read the file',
      tools: [{
        type: 'function',
        function: { name: 'workspace.read', description: 'Read a file.', parameters: { type: 'object' } },
      }],
      signal: new AbortController().signal,
    });
    assert.equal(result.toolCalls?.[0]?.name, 'workspace.read');
    assert.deepEqual(result.toolCalls?.[0]?.args, { path: 'README.md' });
    assert.ok(Array.isArray(payload?.tools));
    assert.equal(payload?.tool_choice, 'auto');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('forwards per-step model and token budget overrides to compatible providers', async () => {
  const originalFetch = globalThis.fetch;
  let payload: Record<string, unknown> | undefined;
  globalThis.fetch = (async (_input, init) => {
    payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ choices: [{ message: { content: 'bounded response' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    const client = new OpenAICompatibleModelClient({ apiKey: 'test-key', apiBase: 'https://provider.invalid', model: 'default-model' });
    await client.complete({ system: 'test', user: 'hello', model: 'step-model', maxTokens: 2048, signal: new AbortController().signal });
    assert.equal(payload?.model, 'step-model');
    assert.equal(payload?.max_tokens, 2048);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('retries provider 429 responses and surfaces timeout failures', async () => {
  const originalFetch = globalThis.fetch;
  let rateLimitCalls = 0;
  globalThis.fetch = (async () => {
    rateLimitCalls += 1;
    return new Response(JSON.stringify({ error: { message: 'rate limited' } }), {
      status: 429,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    const client = new OpenAICompatibleModelClient({ apiKey: 'test-key', apiBase: 'https://provider.invalid', model: 'test-model', maxAttempts: 2 });
    await assert.rejects(() => client.complete({ system: 'test', user: 'hello', signal: new AbortController().signal }), /rate limited/);
    assert.equal(rateLimitCalls, 2);

    let timeoutCalls = 0;
    globalThis.fetch = (async () => {
      timeoutCalls += 1;
      const error = new Error('upstream timeout');
      error.name = 'TimeoutError';
      throw error;
    }) as typeof fetch;
    await assert.rejects(() => client.complete({ system: 'test', user: 'hello', signal: new AbortController().signal }), /upstream timeout/);
    assert.equal(timeoutCalls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('reconnects after an SSE transport failure without losing the final answer', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    if (calls === 1) {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));
          controller.error(new TypeError('SSE disconnected'));
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response([
      'data: {"choices":[{"delta":{"content":"recovered"}}],"usage":{"total_tokens":2}}\n\n',
      'data: [DONE]\n\n',
    ].join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;
  try {
    const deltas: string[] = [];
    const client = new OpenAICompatibleModelClient({ apiKey: 'test-key', apiBase: 'https://provider.invalid', model: 'test-model', maxAttempts: 2 });
    const result = await client.complete({
      system: 'test',
      user: 'hello',
      signal: new AbortController().signal,
      onDelta: (delta) => { if (delta.content) deltas.push(delta.content); },
    });
    assert.deepEqual(deltas, ['recovered']);
    assert.equal(result.content, 'recovered');
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
