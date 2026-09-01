import { createServer } from 'node:http';

const apiUrl = process.env.QA_URL ?? 'http://127.0.0.1:8787';
const port = 8898;
let calls = 0;
const mock = createServer((_request, response) => {
  calls += 1;
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  if (calls === 1) {
    response.write('data: {"choices":[{"delta":{"content":"半截答案"}}]}\n\n');
    response.end();
    return;
  }
  response.write('data: {"choices":[{"delta":{"content":"完整答案"}}]}\n\n');
  response.write('data: {"choices":[{"finish_reason":"stop","delta":{}}]}\n\n');
  response.write('data: [DONE]\n\n');
  response.end();
});

await new Promise((resolve) => mock.listen(port, '127.0.0.1', resolve));
try {
  const response = await fetch(`${apiUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mode: 'analyze',
      provider: { apiKey: 'smoke-key', apiUrl: `http://127.0.0.1:${port}`, model: 'smoke-direct', location: 'local' },
      messages: [{ role: 'user', content: '你好' }],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const output = await response.text();
  const resetCount = (output.match(/event: reset\n/g) ?? []).length;
  const completeCount = (output.match(/event: complete\n/g) ?? []).length;
  if (!response.ok || calls !== 2 || resetCount !== 1 || completeCount !== 1 || !output.includes('完整答案')) {
    throw new Error(`direct stream retry failed: status=${response.status}, calls=${calls}, resets=${resetCount}, completes=${completeCount}`);
  }
  console.log(JSON.stringify({ ok: true, calls, resetCount, completeCount, retried: true }));
} finally {
  await new Promise((resolve) => mock.close(resolve));
}
