import test from 'node:test';
import assert from 'node:assert/strict';
import { readTaskMedia, taskMediaPath } from './taskMedia';

test('only same-origin owned task media routes receive the authenticated fetch path', () => {
  const path = '/api/tasks/task-1/artifacts/media/file-1';
  assert.equal(taskMediaPath(path, 'https://axiom.example'), path);
  assert.equal(taskMediaPath(`https://axiom.example${path}`, 'https://axiom.example'), path);
  for (const url of [`https://other.example${path}`, `//other.example${path}`, `${path}?token=leak`, 'javascript:alert(1)', '/api/tasks/task-1']) {
    assert.equal(taskMediaPath(url, 'https://axiom.example'), null);
  }
});

test('media fetch uses session credentials and rejects HTML and oversized content', async () => {
  const original = globalThis.fetch;
  try {
    let credentials: RequestCredentials | undefined;
    globalThis.fetch = async (_url, init) => { credentials = init?.credentials; return new Response('png-data', { headers: { 'Content-Type': 'image/png' } }); };
    const blob = await readTaskMedia('/api/tasks/task-1/artifacts/media/file-1', new AbortController().signal);
    assert.equal(credentials, 'same-origin');
    assert.equal(blob.type, 'image/png');
    assert.equal(await blob.text(), 'png-data');
    globalThis.fetch = async () => new Response('<html>login</html>', { headers: { 'Content-Type': 'text/html' } });
    await assert.rejects(readTaskMedia('/media', new AbortController().signal), /Unsupported media/);
    globalThis.fetch = async () => new Response('fake', { headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(129 * 1024 * 1024) } });
    await assert.rejects(readTaskMedia('/media', new AbortController().signal), /too large/);
  } finally { globalThis.fetch = original; }
});
