import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prepareDeepSeekImageFiles, uploadDeepSeekImage } from './deepseekFiles.js';

const provider = { apiKey: 'test-key', baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-flash-vision-exp' };
const image = 'data:image/png;base64,aGVsbG8=';

test('uploads a DeepSeek image and reuses the cached file id', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (_input, init) => {
    calls += 1;
    assert.equal(init?.method, 'POST');
    assert.equal(init?.headers && new Headers(init.headers).get('authorization'), 'Bearer test-key');
    return new Response(JSON.stringify({ id: 'file-api-test-1' }), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    const first = await uploadDeepSeekImage(provider, image, new AbortController().signal);
    const second = await uploadDeepSeekImage(provider, image, new AbortController().signal);
    assert.equal(first, 'file-api-test-1');
    assert.equal(second, first);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('falls back to inline image when Files API fails', async () => {
  const originalFetch = globalThis.fetch;
  const fallbackImage = 'data:image/png;base64,aGVsbG8h';
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: { message: 'unsupported' } }), { status: 400 })) as typeof fetch;
  try {
    const result = await prepareDeepSeekImageFiles([{ role: 'user', content: [{ type: 'image_url', image_url: { url: fallbackImage } }] }], { ...provider, model: 'fallback-model' }, new AbortController().signal);
    assert.equal(result.uploaded, 0);
    assert.deepEqual(result.messages[0]?.content, [{ type: 'image_url', image_url: { url: fallbackImage } }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('does not call Files API for non-DeepSeek providers', async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  try {
    const result = await prepareDeepSeekImageFiles([{ role: 'user', content: [{ type: 'image_url', image_url: { url: image } }] }], { ...provider, baseUrl: 'https://provider.example.com/v1' }, new AbortController().signal);
    assert.equal(result.uploaded, 0);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
