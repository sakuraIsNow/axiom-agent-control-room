import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileArtifactStore } from './artifactStore.js';
import { SqliteArtifactCatalog } from './artifactCatalog.js';
import { SqliteToolExecutionStore } from './toolExecutionStore.js';
import { ToolApprovalRequiredError, ToolExecutionUnknownError, ToolRegistry } from './toolRegistry.js';
import type { WorkflowTask } from './contracts.js';

const task = (id = 'generated-file', tenantId = 'tenant-a'): WorkflowTask => ({
  id, runId: `${id}-run`, revision: 0, tenantId, userId: 'user-a', sessionId: 'session-a',
  title: 'SVG animation', input: 'Create an SVG animation in an HTML file.', mode: 'build', status: 'running',
  stepResults: [], cancelRequested: false, policy: { requirePlanApproval: false },
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
});

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'axiom-generated-artifact-'));
  const previousExecutor = process.env.AXIOM_TOOL_EXECUTOR;
  const previousWorkspace = process.env.AXIOM_AGENT_WORKSPACE_ROOT;
  process.env.AXIOM_TOOL_EXECUTOR = 'docker';
  process.env.AXIOM_AGENT_WORKSPACE_ROOT = root;
  const store = new FileArtifactStore(join(root, 'artifacts'));
  const catalog = new SqliteArtifactCatalog(':memory:');
  const ledger = new SqliteToolExecutionStore(':memory:');
  await catalog.initialize();
  await ledger.initialize();
  let writes = 0;
  const put = store.put.bind(store);
  store.put = async (...args) => { writes += 1; return put(...args); };
  const executor = { execute: async () => { throw new Error('Generated artifacts must not execute shell commands.'); } } as never;
  const registry = () => new ToolRegistry(executor, store, null, catalog, ledger);
  t.after(async () => {
    await ledger.close();
    await catalog.close();
    if (previousExecutor === undefined) delete process.env.AXIOM_TOOL_EXECUTOR; else process.env.AXIOM_TOOL_EXECUTOR = previousExecutor;
    if (previousWorkspace === undefined) delete process.env.AXIOM_AGENT_WORKSPACE_ROOT; else process.env.AXIOM_AGENT_WORKSPACE_ROOT = previousWorkspace;
    await rm(root, { recursive: true, force: true });
  });
  return { root, store, catalog, ledger, registry, writes: () => writes };
}

test('standalone SVG and HTML are real tenant/task artifacts without approval or project writes', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.root, 'index.html'), 'existing project entry', 'utf8');
  const registry = f.registry();
  const info = registry.catalog().find((entry) => entry.name === 'artifact.create');
  assert.equal(info?.approvalRequired, false);
  assert.equal(info?.risk, 'low');
  assert.equal(registry.isReadOnly('artifact.create'), false, 'automatic generation retains write outcome accounting');
  const fixtures = [
    { filename: '鹈鹕动画.html', content: '<!doctype html><html><svg><circle r="3"/></svg></html>', mime: 'text/html', task: task() },
    { filename: '鹈鹕动画.svg', content: '<svg xmlns="http://www.w3.org/2000/svg"><circle r="5"/></svg>', mime: 'image/svg+xml', task: task('other-task') },
    { filename: 'index.html', content: '<h1>Another tenant</h1>', mime: 'text/html', task: task('generated-file', 'tenant-b') },
    { filename: '说明.md', content: '# 报告\n\n实际内容', mime: 'text/markdown', task: task('markdown-task') },
    { filename: 'notes.txt', content: 'Plain text output', mime: 'text/plain', task: task('text-task') },
  ];
  const artifactIds = new Set<string>();
  for (const item of fixtures) {
    const result = await registry.execute(item.task, 'builder', { name: 'artifact.create', args: { filename: item.filename, content: item.content } }, { invocationId: 'create-file' });
    assert.equal(result.exitCode, 0);
    assert.equal(result.artifactError, undefined);
    assert.ok(result.artifact);
    assert.equal(result.artifact.name, item.filename);
    assert.equal(result.artifact.mimeType, item.mime);
    assert.equal(await f.store.get(result.artifact.id, item.task.tenantId), item.content, 'the object contains source, not a tool transcript');
    assert.equal(await f.store.get(result.artifact.id, 'unrelated-tenant'), null);
    const catalogEntry = await f.catalog.get(item.task.tenantId, result.artifact.id);
    assert.equal(catalogEntry?.taskId, item.task.id);
    assert.equal(catalogEntry?.status, 'active');
    assert.equal(catalogEntry?.referenceCount, 1);
    const receipt = (await f.ledger.listForTask(item.task.tenantId, item.task.id))[0];
    assert.equal(receipt?.status, 'completed');
    assert.equal(receipt?.sideEffect, 'write');
    assert.deepEqual(receipt?.receipt?.artifact, result.artifact);
    const output = JSON.parse(result.output) as { downloadUrl: string; filename: string };
    assert.equal(output.filename, item.filename);
    assert.equal(output.downloadUrl, `/api/tasks/${item.task.id}/artifacts/files/${encodeURIComponent(result.artifact.id)}`);
    artifactIds.add(result.artifact.id);
  }
  assert.equal(artifactIds.size, fixtures.length);
  assert.equal(f.writes(), fixtures.length, 'no extra stdout transcript replaces or duplicates the deliverable');
  assert.equal(await readFile(join(f.root, 'index.html'), 'utf8'), 'existing project entry');
  assert.deepEqual((await readdir(f.root)).sort(), ['artifacts', 'index.html']);
});

test('replaying a generated file across registries keeps one object and one catalog reference', async (t) => {
  const f = await fixture(t);
  const invocation = { name: 'artifact.create', args: { filename: 'animation.svg', content: '<svg><circle r="5"/></svg>' } };
  const original = await f.registry().execute(task(), 'builder', invocation, { invocationId: 'file-one' });
  const replayed = await f.registry().execute(task(), 'builder', invocation, { invocationId: 'file-one' });
  assert.equal(replayed.replayed, true);
  assert.deepEqual(replayed.artifact, original.artifact);
  assert.equal(replayed.call.id, original.call.id);
  assert.equal(f.writes(), 1);
  assert.equal((await f.catalog.get(task().tenantId, original.artifact!.id))?.referenceCount, 1);
  const next = await f.registry().execute(task(), 'builder', invocation, { invocationId: 'file-two' });
  assert.notEqual(next.artifact?.id, original.artifact?.id, 'a new invocation creates a separate object even with the same display name');
  assert.equal(f.writes(), 2);
});

test('a lost completion acknowledgement and missing annotation still recover artifact metadata and catalog without rewriting', async (t) => {
  const f = await fixture(t);
  const complete = f.ledger.complete.bind(f.ledger);
  f.ledger.complete = async (owner, receipt) => {
    assert.ok(receipt.artifact, 'essential file identity is committed with the receipt before optional catalog work');
    await complete(owner, receipt);
    throw new Error('completion acknowledgement lost');
  };
  f.ledger.annotateReceipt = async () => false;
  const register = f.catalog.register.bind(f.catalog);
  f.catalog.register = async () => { throw new Error('catalog offline'); };
  const invocation = { name: 'artifact.create', args: { filename: 'scene.html', content: '<html><svg/></html>' } };
  const original = await f.registry().execute(task(), 'builder', invocation, { invocationId: 'file-one' });
  assert.equal(original.artifactError, 'catalog offline');
  assert.equal((await f.ledger.listForTask('tenant-a', task().id))[0]?.receipt?.artifact?.id, original.artifact?.id);
  f.catalog.register = register;
  const replayed = await f.registry().execute(task(), 'builder', invocation, { invocationId: 'file-one' });
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.artifactError, undefined);
  assert.deepEqual(replayed.artifact, original.artifact);
  assert.equal((await f.catalog.get('tenant-a', original.artifact!.id))?.referenceCount, 1);
  assert.equal(f.writes(), 1);
});

test('artifact filenames cannot contain paths or executable extensions, and schema rejects extra write controls', async (t) => {
  const f = await fixture(t);
  const registry = f.registry();
  for (const filename of ['../scene.html', 'folder/scene.svg', 'folder\\scene.svg', 'C:\\scene.html', '/scene.html', 'scene.html:stream', '.env', 'install.ps1', 'scene.html\n', 'a..html', 'scene.html\u0000']) {
    await assert.rejects(registry.execute(task(), 'builder', { name: 'artifact.create', args: { filename, content: 'contents' } }, { invocationId: filename }));
  }
  await assert.rejects(registry.execute(task(), 'builder', { name: 'artifact.create', args: { filename: 'scene.html', content: 'contents', path: 'index.html' } }));
  await assert.rejects(registry.execute(task(), 'builder', { name: 'artifact.create', args: { filename: 'scene.html', content: '' } }));
  assert.equal(f.writes(), 0);
  assert.equal((await f.ledger.listForTask('tenant-a', task().id)).length, 0);
});

test('standalone generation does not exempt workspace writes and patches from explicit approval', async (t) => {
  const f = await fixture(t);
  const registry = f.registry();
  for (const invocation of [
    { name: 'workspace.write', args: { path: 'index.html', content: '<html>new file</html>' } },
    { name: 'workspace.patch', args: { path: 'index.html', find: 'old', replace: 'new' } },
  ]) {
    await assert.rejects(registry.execute(task(), 'builder', invocation), (error: unknown) => error instanceof ToolApprovalRequiredError && error.approval.risk === 'high');
  }
  assert.equal(f.writes(), 0);
});

test('an unconfigured artifact store fails before claiming a write, and uncertain dispatched writes remain fenced', async (t) => {
  const f = await fixture(t);
  const invocation = { name: 'artifact.create', args: { filename: 'scene.html', content: '<html/>' } };
  const missing = new ToolRegistry(undefined, null, null, f.catalog, f.ledger);
  await assert.rejects(missing.execute(task(), 'builder', invocation, { invocationId: 'file-one' }), (error: unknown) => error instanceof Error && !(error instanceof ToolExecutionUnknownError) && /storage is unavailable/.test(error.message));
  assert.equal((await f.ledger.listForTask('tenant-a', task().id)).length, 0);
  let attempted = 0;
  f.store.put = async () => { attempted += 1; throw new Error('storage acknowledgement lost'); };
  await assert.rejects(f.registry().execute(task(), 'builder', invocation, { invocationId: 'file-one' }), ToolExecutionUnknownError);
  await assert.rejects(f.registry().execute(task(), 'builder', invocation, { invocationId: 'file-one' }), ToolExecutionUnknownError);
  assert.equal(attempted, 1);
});

test('receipt replay does not revive an intentionally deleted artifact', async (t) => {
  const f = await fixture(t);
  const invocation = { name: 'artifact.create', args: { filename: 'scene.html', content: '<html/>' } };
  const original = await f.registry().execute(task(), 'builder', invocation, { invocationId: 'file-one' });
  await f.catalog.markDeleted('tenant-a', original.artifact!.id);
  await f.store.delete(original.artifact!.id, 'tenant-a');
  const replayed = await f.registry().execute(task(), 'builder', invocation, { invocationId: 'file-one' });
  assert.equal(replayed.replayed, true);
  assert.match(replayed.artifactError ?? '', /no longer available/);
  assert.equal((await f.catalog.get('tenant-a', original.artifact!.id))?.status, 'deleted');
  assert.equal(f.writes(), 1);
});
