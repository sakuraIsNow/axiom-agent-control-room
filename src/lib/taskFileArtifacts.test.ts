import test from 'node:test';
import assert from 'node:assert/strict';
import { readTaskFileArtifact, taskFileArtifactPath } from './taskFileArtifacts.js';

test('only exact same-origin file artifact links trigger an authenticated preview fetch', () => {
  const path = '/api/tasks/task-1/artifacts/files/tool%3Atask-1%3Aartifact';
  assert.equal(taskFileArtifactPath(path, 'https://axiom.example'), path);
  assert.equal(taskFileArtifactPath(`https://axiom.example${path}`, 'https://axiom.example'), path);
  for (const url of [`https://external.example${path}`, `//external.example${path}`, `${path}?token=secret`, `${path}#preview`, 'javascript:alert(1)', '/index.html']) {
    assert.equal(taskFileArtifactPath(url, 'https://axiom.example'), null);
  }
});

test('file preview reads only bounded attachment data and preserves a safe UTF-8 filename', async () => {
  const original = globalThis.fetch;
  const headers = { 'content-type': 'application/octet-stream', 'x-axiom-artifact-mime-type': 'image/svg+xml', 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent('动画.svg')}` };
  try {
    let credentials: RequestCredentials | undefined; let redirect: RequestRedirect | undefined;
    globalThis.fetch = async (_url, init) => { credentials = init?.credentials; redirect = init?.redirect; return new Response('<svg />', { headers }); };
    const artifact = await readTaskFileArtifact('/api/tasks/t/artifacts/files/a', new AbortController().signal);
    assert.deepEqual(artifact, { content: '<svg />', filename: '动画.svg', mimeType: 'image/svg+xml' });
    assert.equal(credentials, 'same-origin'); assert.equal(redirect, 'error');
    globalThis.fetch = async () => new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } });
    await assert.rejects(readTaskFileArtifact('/api/tasks/t/artifacts/files/a', new AbortController().signal), /Unsupported/);
    globalThis.fetch = async () => new Response('file', { headers: { ...headers, 'content-length': '512001' } });
    await assert.rejects(readTaskFileArtifact('/api/tasks/t/artifacts/files/a', new AbortController().signal), /too large/);
    globalThis.fetch = async () => new Response('a'.repeat(512_001), { headers });
    await assert.rejects(readTaskFileArtifact('/api/tasks/t/artifacts/files/a', new AbortController().signal), /too large/);
    globalThis.fetch = async () => new Response('<svg />', { headers: { ...headers, 'content-disposition': "attachment; filename*=UTF-8''..%2Fsecret.svg" } });
    assert.equal((await readTaskFileArtifact('/api/tasks/t/artifacts/files/a', new AbortController().signal)).filename, 'axiom-artifact.svg');
  } finally { globalThis.fetch = original; }
});
