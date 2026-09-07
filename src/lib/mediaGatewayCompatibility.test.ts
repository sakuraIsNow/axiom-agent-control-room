import test from 'node:test';
import assert from 'node:assert/strict';
import { streamAgentResponse } from './agentStream';
import { generateImage } from './imageGeneration';

test('legacy media chat client follows an accepted task rather than silently parsing JSON as SSE', async () => {
  const original = globalThis.fetch;
  let posted = 0;
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
  globalThis.fetch = async (url) => {
    if (url === '/api/chat') { posted++; return json({ task: { id: 'media-task', model: 'image-fake' } }, 202); }
    return json({ task: { id: 'media-task', status: 'completed', result: '![actual image](/api/tasks/media-task/artifacts/media/image)', stepResults: [] } });
  };
  try {
    let output = ''; let completions = 0;
    await streamAgentResponse([{ id: 'u', role: 'user', content: 'draw', createdAt: 1 }], 'build', 's', new AbortController().signal, {
      onStatus() {}, onToken(token) { output += token; }, onReset() { output = ''; }, onReasoning() {}, onComplete() { completions++; }, onError() {},
    });
    assert.equal(posted, 1);
    assert.equal(completions, 1);
    assert.match(output, /actual image/);
  } finally { globalThis.fetch = original; }
});

test('legacy image client consumes durable media task output and submits generation once', async () => {
  const original = globalThis.fetch;
  let posted = 0;
  globalThis.fetch = async (url) => {
    if (url === '/api/images') { posted++; return new Response(JSON.stringify({ task: { id: 't' } }), { status: 202 }); }
    if (String(url).includes('/events?')) return new Response('event: runtime\ndata: {"taskId":"t","sequence":1,"type":"task.completed","payload":{}}\n\n', { headers: { 'content-type': 'text/event-stream' } });
    return new Response(JSON.stringify({ task: { id: 't', status: 'completed', result: '![Image](/api/tasks/t/artifacts/media/a)', stepResults: [] } }));
  };
  try {
    const result = await generateImage({ prompt: 'draw', mode: 'generate', size: '1024x1024', quality: 'auto', n: 1 },
      { useCustom: true, location: 'local', apiUrl: 'http://localhost:9009', apiKey: '', model: 'fake' }, new AbortController().signal);
    assert.equal(posted, 1);
    assert.equal(result.images[0].url, '/api/tasks/t/artifacts/media/a');
  } finally { globalThis.fetch = original; }
});
