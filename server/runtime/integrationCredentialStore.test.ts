import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createMemoryIntegrationCredentialStore } from './integrationCredentialStore.js';

let previousSecret: string | undefined;
before(() => { previousSecret = process.env.AXIOM_INTEGRATION_SECRET; process.env.AXIOM_INTEGRATION_SECRET = 'integration-test-secret-at-least-32-bytes'; });
after(() => { if (previousSecret === undefined) delete process.env.AXIOM_INTEGRATION_SECRET; else process.env.AXIOM_INTEGRATION_SECRET = previousSecret; });

test('integration credentials encrypt secrets and enforce tenant boundaries', async () => {
  const store = createMemoryIntegrationCredentialStore();
  await store.initialize();
  try {
    const saved = await store.upsert({
      tenantId: 'tenant-a', userId: 'owner-a', provider: 'feishu', name: '团队飞书', authType: 'service-account',
      secrets: { appId: 'cli_test', appSecret: 'never-return-this-secret' }, metadata: { mode: 'tenant_access_token' },
    });
    assert.deepEqual(saved.secretFields, ['appId', 'appSecret']);
    assert.equal(JSON.stringify(saved).includes('never-return-this-secret'), false);
    assert.equal((await store.list('tenant-a')).length, 1);
    assert.equal((await store.list('tenant-b')).length, 0);
    assert.equal(await store.get(saved.id, 'tenant-b'), null);
    const resolved = await store.get(saved.id, 'tenant-a');
    assert.equal(resolved?.secrets.appSecret, 'never-return-this-secret');
    assert.equal(JSON.stringify(await store.list('tenant-a')).includes('never-return-this-secret'), false);
    await assert.rejects(store.upsert({
      tenantId: 'tenant-b', userId: 'owner-b', provider: 'feishu', name: '越权覆盖', authType: 'service-account',
      secrets: { appId: 'cli_other', appSecret: 'cross-tenant-secret' },
    }, saved.id), /tenant/i);
    assert.equal((await store.get(saved.id, 'tenant-a'))?.secrets.appSecret, 'never-return-this-secret');
    assert.equal(await store.get(saved.id, 'tenant-b'), null);
  } finally {
    await store.close();
  }
});

test('integration credentials reject a weak encryption secret', async () => {
  const strongSecret = process.env.AXIOM_INTEGRATION_SECRET;
  process.env.AXIOM_INTEGRATION_SECRET = 'too-short';
  const store = createMemoryIntegrationCredentialStore();
  await store.initialize();
  try {
    await assert.rejects(store.upsert({
      tenantId: 'tenant-a', userId: 'owner-a', provider: 'feishu', name: '弱密钥', authType: 'service-account',
      secrets: { appId: 'cli_test', appSecret: 'secret' },
    }), /at least 32 characters/i);
  } finally {
    await store.close();
    if (strongSecret === undefined) delete process.env.AXIOM_INTEGRATION_SECRET;
    else process.env.AXIOM_INTEGRATION_SECRET = strongSecret;
  }
});
