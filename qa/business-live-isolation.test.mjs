import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { offlineEnvironment } from '../scripts/ci-quality-gate.mjs';
import { liveDeliveryEnvironment, liveProviderOrigin } from './lib/live-delivery-isolation.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const moduleUrl = (file) => pathToFileURL(join(root, file)).href;

test('live provider URL is validated without exposing invalid URLs or embedded credentials', () => {
  assert.equal(liveProviderOrigin('https://model.example/v1'), 'https://model.example');
  assert.equal(liveProviderOrigin('http://127.0.0.1:8000/v1'), 'http://127.0.0.1:8000');
  for (const value of ['not-a-url', 'file:///fixture', 'https://fixture-user:fixture-password@model.example']) {
    assert.throws(() => liveProviderOrigin(value), (error) => error.message === 'Live delivery model URL must be an HTTP(S) URL without embedded credentials.');
  }
});

test('live evaluation environment keeps only system settings and explicit bounded runtime options', () => {
  const source = { PATH: 'system-bin', HOME: 'system-home', TEMP: 'system-temp',
    DATABASE_URL: 'postgres://fixture-only', AXIOM_SQLITE_PATH: 'real.sqlite',
    AXIOM_OBJECT_STORAGE_PATH: 'real-artifacts', AXIOM_OBJECT_STORAGE_ENDPOINT: 'http://fixture-only.invalid',
    AWS_PROFILE: 'shared-profile', AWS_ACCESS_KEY_ID: 'fixture', AWS_SECRET_ACCESS_KEY: 'fixture',
    DEEPSEEK_API_KEY: 'fixture', DEEPSEEK_API_BASE: 'http://fixture-only.invalid', DEEPSEEK_MODEL: 'unexpected',
    VIDEO_API_KEY: 'fixture', TDAI_MEMORY_ENDPOINT: 'http://fixture-only.invalid',
    DEEPSEEK_HARNESS_COMMAND: 'must-not-execute', CODEX_APP_SERVER_COMMAND: 'must-not-execute',
    NODE_OPTIONS: '--require must-not-load', HTTPS_PROXY: 'http://fixture-only.invalid',
    AGENT_STEP_MAX_ATTEMPTS: '4', AGENT_SYNTHESIS_MAX_CONTINUATIONS: '6', AXIOM_TOOL_EXECUTOR: 'docker',
    AXIOM_TRUST_PROXY_AUTH: 'true', PRIVATE_UNKNOWN_SETTING: 'must-not-inherit' };
  const clean = liveDeliveryEnvironment(source);
  assert.deepEqual(Object.keys(clean).filter((key) => key in source).sort(), [
    'AGENT_STEP_MAX_ATTEMPTS', 'AGENT_SYNTHESIS_MAX_CONTINUATIONS', 'AXIOM_TOOL_EXECUTOR',
    'AXIOM_TRUST_PROXY_AUTH', 'HOME', 'PATH', 'TEMP',
  ]);
  assert.equal(clean.PATH, 'system-bin');
  assert.equal(clean.AXIOM_TOOL_EXECUTOR, 'disabled');
  assert.equal(clean.AGENT_STEP_MAX_ATTEMPTS, '1');
  assert.equal(clean.AGENT_SYNTHESIS_MAX_CONTINUATIONS, '1');
  assert.equal(clean.AXIOM_MAX_AUTO_REPLANS, '0');
  assert.equal(clean.AGENT_REVIEW_CORRECTION_ROUNDS, '0');
  assert.equal(clean.DEEPSEEK_NATIVE_SEARCH, 'false');
  assert.equal(clean.DEEPSEEK_FILES_API, 'false');
  assert.equal(clean.AXIOM_TRUST_PROXY_AUTH, 'false');
  assert.equal(source.AGENT_STEP_MAX_ATTEMPTS, '4', 'Environment derivation must not mutate the source.');
});

test('poisoned defaults cannot reach PostgreSQL or spill artifacts and the real Task API exits normally', { timeout: 25_000 }, async () => {
  const temporaryRoot = await realpath(tmpdir());
  const scratch = await mkdtemp(join(temporaryRoot, 'axiom-live-isolation-'));
  const workspace = join(scratch, 'workspace');
  const forbiddenArtifacts = join(scratch, 'forbidden-artifacts');
  let connections = 0;
  let child;
  let killTimer;
  const trap = createServer((socket) => { connections += 1; socket.destroy(); });
  try {
    await mkdir(workspace); await mkdir(forbiddenArtifacts);
    await writeFile(join(forbiddenArtifacts, 'sentinel.txt'), 'unchanged', 'utf8');
    trap.listen(0, '127.0.0.1'); await once(trap, 'listening');
    const port = trap.address().port;
    const poison = {
      DATABASE_URL: `postgres://fixture:fixture@127.0.0.1:${port}/must_not_connect`,
      AXIOM_OBJECT_STORAGE_PATH: forbiddenArtifacts,
      AXIOM_OBJECT_STORAGE_ENDPOINT: `http://127.0.0.1:${port}`,
      AXIOM_OBJECT_STORAGE_BUCKET: 'must-not-write', AXIOM_OBJECT_STORAGE_ACCESS_KEY: 'fixture', AXIOM_OBJECT_STORAGE_SECRET_KEY: 'fixture',
      AXIOM_SQLITE_PATH: join(scratch, 'must-not-create.sqlite'),
      TDAI_MEMORY_ENDPOINT: `http://127.0.0.1:${port}`, DEEPSEEK_HARNESS_URL: `http://127.0.0.1:${port}`,
      DEEPSEEK_API_BASE: `http://127.0.0.1:${port}`, DEEPSEEK_API_KEY: 'fixture',
      DEEPSEEK_HARNESS_COMMAND: 'must-not-execute', CODEX_APP_SERVER_COMMAND: 'must-not-execute',
      NODE_OPTIONS: '--require must-not-load', HTTP_PROXY: `http://127.0.0.1:${port}`,
    };
    const source = `
      import assert from 'node:assert/strict';
      import { join } from 'node:path';
      import { liveDeliveryEnvironment } from ${JSON.stringify(moduleUrl('qa/lib/live-delivery-isolation.mjs'))};
      Object.assign(process.env, ${JSON.stringify(poison)});
      const safe = liveDeliveryEnvironment(process.env);
      for (const key of Object.keys(process.env)) delete process.env[key];
      Object.assign(process.env, safe);
      assert.equal(process.env.DATABASE_URL, undefined);
      assert.equal(process.env.AXIOM_OBJECT_STORAGE_PATH, undefined);
      assert.equal(process.env.NODE_OPTIONS, undefined);
      let fetchCalls = 0;
      globalThis.fetch = async () => { fetchCalls += 1; throw new Error('No network permitted in this isolation test.'); };
      const { SqliteTaskStore } = await import(${JSON.stringify(moduleUrl('server/runtime/sqliteTaskStore.ts'))});
      const { createTaskApi } = await import(${JSON.stringify(moduleUrl('server/runtime/taskApi.ts'))});
      const { FileArtifactStore } = await import(${JSON.stringify(moduleUrl('server/runtime/artifactStore.ts'))});
      const { EventHub } = await import(${JSON.stringify(moduleUrl('server/runtime/eventHub.ts'))});
      const store = new SqliteTaskStore(join(process.cwd(), 'isolated.sqlite'));
      const artifactStore = new FileArtifactStore(join(process.cwd(), 'artifacts'));
      const memory = { async recall() { throw new Error('Unexpected memory recall'); }, async capture() { throw new Error('Unexpected memory capture'); } };
      await store.initialize();
      try {
        let task = await store.createTask({ tenantId: 'isolation-fixture', userId: 'isolation-fixture', sessionId: 'isolation-fixture', title: 'Synthetic result', input: 'Only a synthetic result.', mode: 'analyze' });
        task = await store.updateTask(task.id, { status: 'completed', result: 'Isolated synthetic result.' });
        const api = createTaskApi({ store, hub: new EventHub(), coordinator: { nudge() { throw new Error('Unexpected execution'); }, abort() {} }, artifactStore, memory });
        const headers = { 'x-axiom-tenant-id': task.tenantId, 'x-axiom-user-id': task.userId };
        const response = await api.request('/tasks/' + task.id + '/artifacts/result', { headers });
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.artifact.content, task.result);
        assert.equal(body.artifact.storage.kind, 'filesystem');
        assert.equal(await artifactStore.get('result:' + task.id, task.tenantId), task.result);
        const schedules = await api.request('/schedules', { headers });
        assert.equal(schedules.status, 200);
        const listing = await schedules.json();
        assert.deepEqual(listing.schedules, []);
        assert.equal(listing.persistence, 'memory-single-node');
        await new Promise((done) => setTimeout(done, 80));
        assert.equal(fetchCalls, 0);
        console.log(JSON.stringify({ passed: true, artifact: body.artifact.storage.kind, schedules: listing.schedules.length, fetchCalls }));
      } finally { await store.close(); }
    `;
    child = spawn(process.execPath, ['--import', moduleUrl('node_modules/tsx/dist/loader.mjs'), '--input-type=module', '-e', source], {
      cwd: workspace, env: offlineEnvironment(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '', errors = '', timedOut = false;
    child.stdout.on('data', (chunk) => { output = `${output}${chunk}`.slice(-16_000); });
    child.stderr.on('data', (chunk) => { errors = `${errors}${chunk}`.slice(-16_000); });
    killTimer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 15_000);
    const [code, signal] = await once(child, 'close');
    assert.equal(timedOut, false, 'Task API left live handles, such as a default PostgreSQL scheduler pool.');
    assert.equal(code, 0, `${signal ?? ''} ${errors}`);
    assert.deepEqual(JSON.parse(output.trim()), { passed: true, artifact: 'filesystem', schedules: 0, fetchCalls: 0 });
    assert.equal(connections, 0, 'Ambient PostgreSQL, storage, model or service configuration reached a network socket.');
    assert.deepEqual(await readdir(forbiddenArtifacts), ['sentinel.txt']);
    assert.equal(await readFile(join(forbiddenArtifacts, 'sentinel.txt'), 'utf8'), 'unchanged');
    assert.deepEqual((await readdir(scratch)).sort(), ['forbidden-artifacts', 'workspace']);
  } finally {
    clearTimeout(killTimer);
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close'); child.kill('SIGKILL'); await closed;
    }
    if (trap.listening) await new Promise((done) => trap.close(done));
    const actual = await realpath(scratch);
    assert.equal(dirname(actual), temporaryRoot);
    assert.ok(basename(actual).startsWith('axiom-live-isolation-'));
    await rm(actual, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
