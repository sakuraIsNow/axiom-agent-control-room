import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SqlitePluginStore } from './pluginStore.js';

const definition = {
  mode: 'analyze' as const,
  promptPrefix: 'Return a concise, evidence-based review.',
  inputSchema: { fields: [{ id: 'target', label: 'Target', type: 'text' as const, required: true }] },
};

test('SqlitePluginStore persists versions and applies tenant visibility', async () => {
  const store = new SqlitePluginStore(':memory:');
  await store.initialize();
  try {
    const plugin = await store.createPlugin({ tenantId: 'tenant-a', createdBy: 'user-a', name: 'Review', description: 'Review a target', definition });
    assert.equal(plugin.status, 'draft');
    const published = await store.updatePlugin(plugin.id, 'tenant-a', { status: 'published', updatedBy: 'user-a' });
    assert.equal(published.version, 1);
    const updated = await store.updatePlugin(plugin.id, 'tenant-a', { definition: { ...definition, mode: 'decide' }, updatedBy: 'user-a' });
    assert.equal(updated.version, 2);
    assert.equal(updated.history.length, 1);
    assert.equal(await store.getPlugin(plugin.id, 'tenant-b'), null);
  } finally {
    await store.close();
  }
});

test('team plugins are visible to members while private plugins remain owner-scoped', async () => {
  const store = new SqlitePluginStore(':memory:');
  await store.initialize();
  try {
    await store.createPlugin({ tenantId: 'tenant-a', createdBy: 'user-a', name: 'Private', description: '', definition });
    const team = await store.createPlugin({ tenantId: 'tenant-a', createdBy: 'user-a', name: 'Team', description: '', visibility: 'team', definition });
    const draftVisible = await store.listPlugins('tenant-a', 50, { userId: 'user-b', role: 'member' });
    assert.deepEqual(draftVisible, []);
    const published = await store.publishPlugin(team.id, 'tenant-a', {
      schemaVersion: 1, platformVersion: '1.1.0', pluginVersion: 1, integrity: 'sha256:test', signedAt: '2026-09-03T00:00:00.000Z', signedBy: 'user-a', permissions: [], warnings: [],
    });
    const visible = await store.listPlugins('tenant-a', 50, { userId: 'user-b', role: 'member' });
    assert.deepEqual(visible.map((item) => item.id), [published.id]);
  } finally {
    await store.close();
  }
});

test('mini-app plugins are bounded and preserve isolated HTML definitions', async () => {
  const store = new SqlitePluginStore(':memory:');
  await store.initialize();
  try {
    const plugin = await store.createPlugin({
      tenantId: 'tenant-a', createdBy: 'user-a', name: 'Snake', description: 'A self-contained game', kind: 'mini-app',
      definition: {
        mode: 'build', htmlContent: '<!doctype html><button id="go">go</button>', width: 640, height: 420,
        appearance: { effect: 'plasma', hue: 24, seed: 91 }, agentEnabled: true, agentInstructions: 'Answer weather questions.',
        designConversation: [{ role: 'user', content: 'Build a weather app.', createdAt: '2026-08-27T08:00:00.000Z' }],
      },
    });
    assert.equal(plugin.kind, 'mini-app');
    assert.equal('htmlContent' in plugin.definition ? plugin.definition.htmlContent.includes('button') : false, true);
    if (!('htmlContent' in plugin.definition)) assert.fail('Expected a mini-app definition.');
    assert.deepEqual(plugin.definition.appearance, { effect: 'plasma', hue: 24, seed: 91 });
    assert.equal(plugin.definition.agentEnabled, true);
    assert.equal(plugin.definition.designConversation?.length, 1);
    await assert.rejects(() => store.createPlugin({
      tenantId: 'tenant-a', createdBy: 'user-a', name: 'Too big', description: '', kind: 'mini-app',
      definition: { mode: 'build', htmlContent: 'x'.repeat(200_001) },
    }), /200KB/);
    assert.equal(await store.deletePlugin(plugin.id, 'tenant-b'), false);
    assert.equal(await store.deletePlugin(plugin.id, 'tenant-a'), true);
    assert.equal(await store.getPlugin(plugin.id, 'tenant-a'), null);
  } finally {
    await store.close();
  }
});

test('mini-app window keeps untrusted HTML in a scripts-only sandbox', async () => {
  const source = await readFile(new URL('../../src/components/plugins/MiniAppWindow.tsx', import.meta.url), 'utf8');
  assert.match(source, /sandbox="allow-scripts"/);
  assert.match(source, /event\.source !== frameRef\.current\?\.contentWindow/);
  assert.match(source, /activeRequestRef/);
  assert.match(source, /aria-modal="true"/);
  assert.doesNotMatch(source, /allow-same-origin/);
  assert.doesNotMatch(source, /dangerouslySetInnerHTML/);
});

test('plugin publish evidence is cleared by edits and historical versions roll forward as a new draft', async () => {
  const store = new SqlitePluginStore(':memory:');
  await store.initialize();
  try {
    const created = await store.createPlugin({ tenantId: 'tenant-a', createdBy: 'user-a', name: 'Review', description: 'v1', definition });
    const release = {
      schemaVersion: 1 as const,
      platformVersion: '1.1.0',
      pluginVersion: created.version,
      integrity: 'sha256:test',
      signedAt: '2026-09-03T00:00:00.000Z',
      signedBy: 'user-a',
      permissions: [],
      warnings: [],
    };
    const published = await store.publishPlugin(created.id, 'tenant-a', release);
    assert.equal(published.status, 'published');
    assert.equal(published.release?.integrity, 'sha256:test');

    const edited = await store.updatePlugin(created.id, 'tenant-a', { description: 'v2', definition: { ...definition, mode: 'build' }, updatedBy: 'user-a' });
    assert.equal(edited.version, 2);
    assert.equal(edited.status, 'draft');
    assert.equal(edited.release, undefined);
    assert.equal(edited.history[0]?.description, 'v1');

    const restored = await store.rollbackPlugin(created.id, 'tenant-a', 1, 'user-a');
    assert.equal(restored.version, 3);
    assert.equal(restored.status, 'draft');
    assert.equal(restored.description, 'v1');
    assert.equal(restored.definition.mode, 'analyze');
    assert.equal(restored.history.length, 2);
    await assert.rejects(() => store.rollbackPlugin(created.id, 'tenant-a', 99, 'user-a'), /version not found/i);
  } finally {
    await store.close();
  }
});
