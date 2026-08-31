import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isLocalProviderHostname, normalizeProviderBaseUrl } from './providerLocation.js';

test('classifies loopback, LAN, Docker, and public model hosts', () => {
  for (const hostname of ['localhost', '127.0.0.1', '10.0.0.8', '172.20.0.2', '192.168.1.5', 'host.docker.internal', 'model-server', 'ollama.local', '::1', 'fd12::1']) {
    assert.equal(isLocalProviderHostname(hostname), true, hostname);
  }
  assert.equal(isLocalProviderHostname('api.deepseek.com'), false);
  assert.equal(isLocalProviderHostname('models.example.com'), false);
});

test('enforces the selected provider location and normalizes the trailing slash', () => {
  assert.equal(normalizeProviderBaseUrl('http://127.0.0.1:11434/v1/', '', 'local'), 'http://127.0.0.1:11434/v1');
  assert.equal(normalizeProviderBaseUrl('https://api.deepseek.com/', '', 'internet'), 'https://api.deepseek.com');
  assert.throws(() => normalizeProviderBaseUrl('http://127.0.0.1:11434/v1', '', 'internet'), /本地服务/);
  assert.throws(() => normalizeProviderBaseUrl('https://api.deepseek.com', '', 'local'), /本地服务/);
  assert.throws(() => normalizeProviderBaseUrl('file:///models', '', 'local'), /http or https/);
});
