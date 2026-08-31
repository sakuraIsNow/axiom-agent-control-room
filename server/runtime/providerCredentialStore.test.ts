import test from 'node:test';
import assert from 'node:assert/strict';
import { createProviderCredentialStore } from './providerCredentialStore.js';

const originalSecret = process.env.AXIOM_PROVIDER_SECRET;
const originalPath = process.env.AXIOM_SQLITE_PATH;

test('provider credentials are encrypted and scoped to the owning tenant and user', async () => {
  process.env.AXIOM_PROVIDER_SECRET = 'test-provider-secret';
  process.env.AXIOM_SQLITE_PATH = ':memory:';
  const store = createProviderCredentialStore();
  await store.initialize();

  const created = await store.upsert({
    tenantId: 'tenant-a',
    userId: 'user-a',
    kind: 'text',
    name: '团队模型',
    apiUrl: 'https://api.example.com/v1',
    apiKey: 'sk-test-provider-key',
    model: 'example-chat',
    location: 'internet',
  });

  assert.equal(created.hasApiKey, true);
  assert.equal('apiKey' in created, false);
  assert.equal((await store.list('tenant-a', 'user-a')).length, 1);
  assert.equal((await store.list('tenant-a', 'user-b')).length, 0);
  assert.equal(await store.get(created.id, 'tenant-a', 'user-b'), null);

  const resolved = await store.get(created.id, 'tenant-a', 'user-a');
  assert.equal(resolved?.apiKey, 'sk-test-provider-key');
  assert.equal(resolved?.model, 'example-chat');

  await store.touch(created.id, 'tenant-a', 'user-a');
  assert.equal(await store.delete(created.id, 'tenant-a', 'user-b'), false);
  assert.equal(await store.delete(created.id, 'tenant-a', 'user-a'), true);
  assert.equal(await store.get(created.id, 'tenant-a', 'user-a'), null);
});

test('encrypted provider credentials require a server secret', async () => {
  process.env.AXIOM_PROVIDER_SECRET = '';
  process.env.AXIOM_SQLITE_PATH = ':memory:';
  const store = createProviderCredentialStore();
  await store.initialize();
  await assert.rejects(() => store.upsert({
    tenantId: 'tenant-a',
    userId: 'user-a',
    kind: 'vision',
    name: '视觉模型',
    apiUrl: 'https://api.example.com/v1',
    apiKey: 'key',
    model: 'vision',
    location: 'internet',
  }), /AXIOM_PROVIDER_SECRET/);
});

test.after(() => {
  if (originalSecret === undefined) delete process.env.AXIOM_PROVIDER_SECRET;
  else process.env.AXIOM_PROVIDER_SECRET = originalSecret;
  if (originalPath === undefined) delete process.env.AXIOM_SQLITE_PATH;
  else process.env.AXIOM_SQLITE_PATH = originalPath;
});

