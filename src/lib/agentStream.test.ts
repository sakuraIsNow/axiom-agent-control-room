import assert from 'node:assert/strict';
import test from 'node:test';
import { streamAgentResponse } from './agentStream';

const sse = (frames: string[]) => new ReadableStream<Uint8Array>({
  start(controller) {
    const encoder = new TextEncoder();
    frames.forEach((frame) => controller.enqueue(encoder.encode(frame)));
    controller.close();
  },
});

const response = (frames: string[], status = 200) => new Response(sse(frames), {
  status,
  headers: { 'content-type': 'text/event-stream' },
});

const request = [{ id: 'user-1', role: 'user' as const, content: '测试', createdAt: Date.now() }];

test('agent stream forwards deltas and requires a complete event', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => response([
    'event: status\ndata: {"phase":"inference","message":"开始"}\n\n',
    'event: token\ndata: {"content":"你好"}\n\n',
    'event: complete\ndata: {"durationMs":12,"route":"conversation","agentRole":"direct-responder"}\n\n',
  ]);
  try {
    let output = '';
    let completed = 0;
    await streamAgentResponse(request, 'analyze', 'session-1', new AbortController().signal, {
      onStatus: () => undefined,
      onToken: (token) => { output += token; },
      onReasoning: () => undefined,
      onComplete: () => { completed += 1; },
      onError: () => undefined,
    });
    assert.equal(output, '你好');
    assert.equal(completed, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('agent stream rejects a truncated response instead of treating EOF as success', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => response([
    'event: token\ndata: {"content":"半截"}\n\n',
  ]);
  try {
    await assert.rejects(
      streamAgentResponse(request, 'analyze', 'session-1', new AbortController().signal, {
        onStatus: () => undefined,
        onToken: () => undefined,
        onReasoning: () => undefined,
        onComplete: () => assert.fail('truncated stream must not complete'),
        onError: () => undefined,
      }),
      /响应流在完成前中断/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('agent stream reset clears the previous attempt before accepting new tokens', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => response([
    'event: token\ndata: {"content":"旧答案"}\n\n',
    'event: reset\ndata: {"reason":"direct-stream-retry"}\n\n',
    'event: token\ndata: {"content":"新答案"}\n\n',
    'event: complete\ndata: {"durationMs":12}\n\n',
  ]);
  try {
    let output = '';
    let resets = 0;
    await streamAgentResponse(request, 'analyze', 'session-1', new AbortController().signal, {
      onStatus: () => undefined,
      onToken: (token) => { output += token; },
      onReset: () => { output = ''; resets += 1; },
      onReasoning: () => undefined,
      onComplete: () => undefined,
      onError: () => undefined,
    });
    assert.equal(resets, 1);
    assert.equal(output, '新答案');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('agent stream preserves the server error payload when the stream closes', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => response([
    'event: error\ndata: {"message":"模型连接被拒绝（HTTP 401）。"}\n\n',
  ]);
  try {
    await assert.rejects(
      streamAgentResponse(request, 'analyze', 'session-1', new AbortController().signal, {
        onStatus: () => undefined,
        onToken: () => undefined,
        onReasoning: () => undefined,
        onComplete: () => assert.fail('error stream must not complete'),
        onError: () => undefined,
      }),
      /模型连接被拒绝（HTTP 401）/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
