import { createServer } from 'node:http';

const port = 8899;
let observedImage = false;
const mock = createServer((request, response) => {
  let body = '';
  request.on('data', (chunk) => { body += chunk; });
  request.on('end', () => {
    observedImage = body.includes('image_url');
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const payload = { choices: [{ delta: { content: '|列|值|\n|-|-|\n|A|B|' } }] };
    response.write(`data: ${JSON.stringify(payload)}\r\n\r\n`);
    response.write('data: [DONE]');
    response.end();
  });
});

await new Promise((resolve) => mock.listen(port, '127.0.0.1', resolve));
try {
  const response = await fetch('http://127.0.0.1:8787/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mode: 'analyze',
      provider: { apiKey: 'smoke-key', apiUrl: `http://127.0.0.1:${port}`, model: 'smoke-vision', location: 'local' },
      visionProvider: { apiKey: 'smoke-key', apiUrl: `http://127.0.0.1:${port}`, model: 'smoke-vision', location: 'local' },
      messages: [{
        role: 'user',
        content: '请分析这张图片，并返回表格。',
        attachments: [{ id: 'image-1', url: 'data:image/png;base64,aGVsbG8=', alt: 'smoke.png' }],
      }],
    }),
  });
  const output = await response.text();
  if (!response.ok || !observedImage || !output.includes('event: token') || !output.includes('|列|值|')) {
    throw new Error(`chat gateway smoke failed: status=${response.status}, image=${observedImage}`);
  }
  const capabilityResponse = await fetch('http://127.0.0.1:8787/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: '你有联网搜索的能力吗' }] }),
  });
  const capabilityOutput = await capabilityResponse.text();
  const capabilityText = capabilityOutput.split(/\r?\n\r?\n/).flatMap((block) => {
    const event = block.split(/\r?\n/).find((line) => line.startsWith('event:'))?.slice(6).trim();
    const raw = block.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('');
    if (event !== 'token' || !raw) return [];
    try { return [JSON.parse(raw).content || '']; } catch { return []; }
  }).join('');
  const capabilityChecks = {
    status: capabilityResponse.status,
    chineseCapability: /联网搜索|联网检索|网络搜索|搜索能力/.test(capabilityText),
    liveStatus: /实时能力状态/.test(capabilityText),
    registryRole: capabilityOutput.includes('"agentRole":"registry-agent"'),
    upstreamFailureLeaked: capabilityOutput.includes('fetch failed'),
  };
  if (!capabilityResponse.ok || !capabilityChecks.chineseCapability || !capabilityChecks.liveStatus || !capabilityChecks.registryRole || capabilityChecks.upstreamFailureLeaked) {
    throw new Error(`search capability smoke failed: ${JSON.stringify({ ...capabilityChecks, text: capabilityText.slice(-500) })}`);
  }
  console.log(JSON.stringify({ ok: true, multimodal: observedImage, markdownToken: true, searchCapability: true }));
} finally {
  await new Promise((resolve) => mock.close(resolve));
}
