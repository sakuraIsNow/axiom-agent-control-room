import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { FileArtifactStore } from '../../server/runtime/artifactStore.ts';
import { SqliteArtifactCatalog } from '../../server/runtime/artifactCatalog.ts';
import { SqliteToolExecutionStore } from '../../server/runtime/toolExecutionStore.ts';
import { ToolExecutionUnknownError, ToolRegistry } from '../../server/runtime/toolRegistry.ts';
import { SqlitePluginStore } from '../../server/runtime/pluginStore.ts';
import { digest, evidence, principal } from './helpers.mjs';

const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180"><title>Budget progress</title><rect width="320" height="180" fill="#202626"/><circle cx="160" cy="90" r="48" fill="#62dcad"/><text x="160" y="96" text-anchor="middle">75%</text></svg>';
const html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Budget counter</title></head><body><button id="increment">Add one</button><output id="value">0</output><script>document.getElementById("increment").onclick=()=>{const value=document.getElementById("value");value.textContent=String(Number(value.textContent)+1);};</script></body></html>';

async function artifactFixture(f) {
  const artifacts = new FileArtifactStore(join(f.directory, 'artifacts'));
  let catalog = new SqliteArtifactCatalog(join(f.directory, 'catalog.sqlite'));
  let ledger = new SqliteToolExecutionStore(join(f.directory, 'ledger.sqlite'));
  await catalog.initialize(); await ledger.initialize();
  let writes = 0;
  const put = artifacts.put.bind(artifacts);
  artifacts.put = async (...args) => { writes += 1; return put(...args); };
  const executor = { execute: async () => { throw new Error('Artifact delivery must not launch shell commands.'); } };
  f.closeWith(async () => { await catalog.close(); await ledger.close(); });
  return {
    artifacts, get catalog() { return catalog; }, get ledger() { return ledger; }, get writes() { return writes; },
    registry() { return new ToolRegistry(executor, artifacts, null, catalog, ledger); },
    async reopen() {
      await catalog.close(); await ledger.close();
      catalog = new SqliteArtifactCatalog(join(f.directory, 'catalog.sqlite')); ledger = new SqliteToolExecutionStore(join(f.directory, 'ledger.sqlite'));
      await catalog.initialize(); await ledger.initialize();
    },
  };
}

const fileCase = (extension, content, mime) => ({ id: `artifact-${extension}-exact-delivery`, domain: 'html-svg-artifact', expected: 'accepted-delivery', async run(f) {
  const state = await artifactFixture(f);
  const task = await f.create();
  const filename = `budget.${extension}`;
  await writeFile(join(f.directory, filename), 'Existing workspace file must remain unchanged.', 'utf8');
  const registry = state.registry();
  assert.equal(registry.catalog().find((item) => item.name === 'artifact.create').approvalRequired, false);
  const result = await registry.execute(task, 'builder', { name: 'artifact.create', args: { filename, content } }, { invocationId: 'deliver-1' });
  assert.equal(result.exitCode, 0); assert.equal(result.artifactError, undefined);
  assert.equal(result.artifact.mimeType, mime);
  const stored = await state.artifacts.get(result.artifact.id, principal.tenantId);
  assert.equal(stored, content);
  assert.equal(await readFile(join(f.directory, filename), 'utf8'), 'Existing workspace file must remain unchanged.');
  assert.equal((await state.catalog.get(principal.tenantId, result.artifact.id)).taskId, task.id);
  assert.equal((await state.ledger.listForTask(principal.tenantId, task.id))[0].receipt.artifact.id, result.artifact.id);
  assert.equal(state.writes, 1);
  return evidence(f, { filename, mime, sha256: digest(stored), byteLength: Buffer.byteLength(stored), artifactWrites: state.writes, browserRenderingEvaluated: false });
} });

const definition = (content = html) => ({ mode: 'build', htmlContent: content, width: 640, height: 480,
  appearance: { effect: 'plasma', hue: 160, seed: 123 }, agentEnabled: false,
  designConversation: [{ role: 'user', content: 'Build a budget counter.', createdAt: '2026-09-21T00:00:00.000Z' }] });
async function pluginFixture(f) {
  let store = new SqlitePluginStore(join(f.directory, 'plugins.sqlite'));
  await store.initialize();
  f.closeWith(() => store.close());
  return { get store() { return store; }, async reopen() { await store.close(); store = new SqlitePluginStore(join(f.directory, 'plugins.sqlite')); await store.initialize(); },
    async create() { return store.createPlugin({ ...principal, createdBy: principal.userId, name: 'Budget counter', description: 'Local acceptance mini-app', kind: 'mini-app', definition: definition() }); },
    async publish(plugin) { return store.publishPlugin(plugin.id, principal.tenantId, { schemaVersion: 1, platformVersion: '2.3.0-rc.8', pluginVersion: plugin.version,
      integrity: `sha256:${digest(plugin.definition)}`, signedAt: new Date().toISOString(), signedBy: principal.userId, permissions: [], warnings: [] }); },
  };
}

export const artifactPluginCases = [
  fileCase('svg', svg, 'image/svg+xml'), fileCase('html', html, 'text/html'),
  { id: 'artifact-restart-replay-no-duplicate', domain: 'html-svg-artifact', expected: 'accepted-delivery', async run(f) {
    const state = await artifactFixture(f); const task = await f.create();
    const invocation = { name: 'artifact.create', args: { filename: 'chart.svg', content: svg } };
    const original = await state.registry().execute(task, 'builder', invocation, { invocationId: 'durable-write' });
    await state.reopen(); await f.reopen();
    const recovered = await state.registry().execute(await f.store.getTask(task.id), 'builder', invocation, { invocationId: 'durable-write' });
    assert.equal(recovered.replayed, true); assert.deepEqual(recovered.artifact, original.artifact); assert.equal(state.writes, 1);
    assert.equal((await state.catalog.get(principal.tenantId, original.artifact.id)).referenceCount, 1);
    assert.equal((await state.ledger.listForTask(principal.tenantId, task.id)).length, 1);
    assert.equal(await state.artifacts.get(original.artifact.id, principal.tenantId), svg);
    return evidence(f, { artifactWrites: state.writes, sameArtifact: true, persistedReceiptCount: 1 });
  } },
  { id: 'artifact-lost-ack-fences-retry', domain: 'html-svg-artifact', expected: 'uncertain-write-fenced', async run(f) {
    const state = await artifactFixture(f); const task = await f.create();
    const put = state.artifacts.put.bind(state.artifacts);
    state.artifacts.put = async (...args) => { await put(...args); throw new Error('Injected acknowledgement loss after object write.'); };
    const invocation = { name: 'artifact.create', args: { filename: 'uncertain.html', content: html } };
    await assert.rejects(state.registry().execute(task, 'builder', invocation, { invocationId: 'uncertain-write' }), ToolExecutionUnknownError);
    await state.reopen();
    await assert.rejects(state.registry().execute(task, 'builder', invocation, { invocationId: 'uncertain-write' }), ToolExecutionUnknownError);
    assert.equal(state.writes, 1, 'uncertain result must not dispatch a duplicate write');
    assert.equal((await state.ledger.listForTask(principal.tenantId, task.id))[0].status, 'outcome_unknown');
    return evidence(f, { artifactWrites: state.writes, receiptStatus: 'outcome_unknown', autoRetryDispatched: false });
  } },
  { id: 'plugin-publish-survives-restart', domain: 'plugin-contract', expected: 'accepted-delivery', async run(f) {
    const state = await pluginFixture(f); const created = await state.create(); const published = await state.publish(created);
    await state.reopen(); const persisted = await state.store.getPlugin(created.id, principal.tenantId);
    assert.equal(persisted.status, 'published'); assert.equal(persisted.definition.htmlContent, html);
    assert.equal(persisted.release.integrity, published.release.integrity);
    assert.deepEqual([persisted.definition.width, persisted.definition.height], [640, 480]);
    assert.equal(persisted.definition.designConversation.length, 1);
    return evidence(f, { version: persisted.version, status: persisted.status, definitionSha256: digest(persisted.definition), scope: 'Durable mini-app release contract, not model coding quality or browser gameplay.' });
  } },
  { id: 'plugin-edit-invalidates-old-release', domain: 'plugin-contract', expected: 'accepted-delivery', async run(f) {
    const state = await pluginFixture(f); const published = await state.publish(await state.create());
    const modifiedHtml = html.replace('Add one', 'Increment budget');
    const changed = await state.store.updatePlugin(published.id, principal.tenantId, { definition: { ...definition(modifiedHtml), width: 800, height: 560 }, updatedBy: principal.userId });
    assert.equal(changed.status, 'draft'); assert.equal(changed.release, undefined); assert.equal(changed.version, 2);
    assert.equal(changed.history[0].definition.htmlContent, html);
    await state.reopen(); const persisted = await state.store.getPlugin(published.id, principal.tenantId);
    assert.equal(persisted.definition.htmlContent, modifiedHtml); assert.deepEqual([persisted.definition.width, persisted.definition.height], [800, 560]);
    return evidence(f, { version: persisted.version, oldReleaseInvalidated: true, originalVersionPreserved: true, dimensions: [800, 560] });
  } },
  { id: 'plugin-rollback-keeps-audit-history', domain: 'plugin-contract', expected: 'accepted-delivery', async run(f) {
    const state = await pluginFixture(f); const original = await state.create();
    await state.store.updatePlugin(original.id, principal.tenantId, { definition: definition('<html>Broken candidate</html>'), updatedBy: principal.userId });
    const rolledBack = await state.store.rollbackPlugin(original.id, principal.tenantId, 1, principal.userId);
    assert.equal(rolledBack.version, 3); assert.equal(rolledBack.status, 'draft'); assert.equal(rolledBack.definition.htmlContent, html);
    assert.equal(rolledBack.history.length, 2); assert.equal(rolledBack.history[1].definition.htmlContent, '<html>Broken candidate</html>');
    return evidence(f, { currentVersion: 3, preservedHistoricalVersions: rolledBack.history.map((item) => item.version), restoredSha256: digest(rolledBack.definition.htmlContent) });
  } },
  { id: 'plugin-delete-remains-deleted', domain: 'plugin-contract', expected: 'accepted-deletion', async run(f) {
    const state = await pluginFixture(f); const published = await state.publish(await state.create());
    assert.equal(await state.store.deletePlugin(published.id, principal.tenantId), true);
    await state.reopen(); assert.equal(await state.store.getPlugin(published.id, principal.tenantId), null);
    assert.equal(await state.store.deletePlugin(published.id, principal.tenantId), false);
    assert.deepEqual(await state.store.listPlugins(principal.tenantId), []);
    return evidence(f, { deletedAfterRestart: true, duplicateDeleteSucceeded: false });
  } },
];
