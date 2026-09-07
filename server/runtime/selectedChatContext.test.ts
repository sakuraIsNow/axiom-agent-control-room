import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { prepareSelectedChatSummary } from './selectedChatContext.js';
import type { DurableContextSourceMessage } from './contextSummary.js';

const messages: DurableContextSourceMessage[] = Array.from({ length: 20 }, (_, index) => ({
  id: `message-${index}`,
  role: index % 2 === 0 ? 'user' : 'assistant',
  content: index === 0 ? 'Keep deployment offline.' : `Conversation message ${index}.`,
}));
const selectedLocal = { apiKey: '', baseUrl: 'http://127.0.0.1:19876/v1', model: 'selected-local-text', location: 'local' as const };
const signal = () => new AbortController().signal;
const fakeResponse = () => Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ operations: [
  { action: 'add', kind: 'constraint', text: 'Keep deployment offline.', source: { messageId: 'message-0', quote: 'Keep deployment offline.' } },
] }) } }] });

const fakeDefaultEnvironment = (t: TestContext) => {
  const values = { DEEPSEEK_API_BASE: 'https://default-cloud.invalid/v1', DEEPSEEK_API_KEY: 'default-test-key', DEEPSEEK_MODEL: 'default-cloud-model' };
  for (const [key, value] of Object.entries(values)) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
};

test('direct-chat context uses the selected keyless local provider instead of configured cloud defaults', async (t) => {
  fakeDefaultEnvironment(t);
  const calls: Array<{ url: string; body: Record<string, unknown>; headers: Headers }> = [];
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
    return fakeResponse();
  });
  const result = await prepareSelectedChatSummary('local-chat', messages, undefined, selectedLocal, signal());
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, `${selectedLocal.baseUrl}/chat/completions`);
  assert.equal(calls[0]?.body.model, selectedLocal.model);
  assert.equal(calls[0]?.headers.has('authorization'), false, 'A cloud key must never be sent to a keyless local provider.');
  assert.equal(result?.structuredContext?.model, selectedLocal.model);
  assert.equal(result?.structuredContext?.status, 'complete');
  assert.equal(result?.structuredContext?.entries[0]?.text, 'Keep deployment offline.');
  const extractionInput = JSON.parse((calls[0]?.body.messages as Array<{ content: string }>)[1]!.content) as { messages: Array<{ id: string }> };
  assert.deepEqual(extractionInput.messages.map((message) => message.id), result?.coveredMessageIds, 'Only the compacted prefix may be extracted.');
});

test('direct-chat context degradation never retries against the default cloud provider', async (t) => {
  fakeDefaultEnvironment(t);
  const urls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
    urls.push(String(url));
    return Response.json({ error: { message: 'Selected local provider unavailable.' } }, { status: 503 });
  });
  const result = await prepareSelectedChatSummary('offline-chat', messages, undefined, selectedLocal, signal());
  assert.deepEqual(urls, [`${selectedLocal.baseUrl}/chat/completions`]);
  assert.ok(result?.content, 'The deterministic context must remain available.');
  assert.equal(result?.structuredContext?.status, 'unavailable');
  assert.ok((result?.structuredContext?.pendingMessageCount ?? 0) > 0);
});

test('direct-chat context follows the final selected vision provider without reselecting text defaults', async (t) => {
  fakeDefaultEnvironment(t);
  const selectedVision = { ...selectedLocal, baseUrl: 'http://127.0.0.1:19877/v1', model: 'selected-local-vision' };
  const calls: Array<{ url: string; model: string }> = [];
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), model: JSON.parse(String(init?.body)).model });
    return fakeResponse();
  });
  const result = await prepareSelectedChatSummary('vision-chat', messages, undefined, selectedVision, signal());
  assert.deepEqual(calls, [{ url: `${selectedVision.baseUrl}/chat/completions`, model: selectedVision.model }]);
  assert.equal(result?.structuredContext?.model, selectedVision.model);
});

test('short direct conversations do not trigger an extra context model call', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected model request.'); });
  assert.equal(await prepareSelectedChatSummary('short-chat', messages.slice(0, 2), undefined, selectedLocal, signal()), null);
  assert.equal(fetchMock.mock.callCount(), 0);
});
