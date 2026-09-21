import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { allowedSourcePath, copySourceFiles, discoverTests, offlineEnvironment, removeScratch, runStage } from './ci-quality-gate.mjs';

test('offline environment excludes provider, database, proxy and preload configuration', () => {
  const env = offlineEnvironment({ Path: 'safe-path', SystemRoot: 'C:\\Windows', HOME: '/test-home', DEEPSEEK_API_KEY: 'secret', OPENAI_API_KEY: 'secret', DATABASE_URL: 'postgres://real', AXIOM_TEST_DATABASE_URL: 'postgres://real', NODE_OPTIONS: '--import credential-loader', HTTPS_PROXY: 'http://proxy', QA_URL: 'http://production', npm_config_registry: 'https://private-registry' });
  assert.deepEqual(Object.keys(env).sort(), ['CI', 'HOME', 'NO_COLOR', 'Path', 'SystemRoot', 'npm_config_audit', 'npm_config_fund'].sort());
  assert.equal(env.CI, 'true');
});

test('source inventory includes new code but excludes local secrets, reports and personal files', () => {
  for (const file of ['src/App.tsx', 'server/runtime/new.test.ts', 'qa/business-delivery/cases.mjs', 'qa/gate-report.test.mjs', 'scripts/ci-quality-gate.test.mjs', 'server/assets/noto-sans-sc-400.woff', 'package-lock.json']) assert.equal(allowedSourcePath(file), true, file);
  for (const file of ['.env.local', 'server/.env', '.data/providers.json', 'qa/rsi-live-model-result.json', 'qa/ci-quality/result.json', 'pelican-bike.html', 'logs/server.log', 'node_modules/pkg/index.js', 'src/../../.env.local', 'src\\..\\..\\.env.local', 'C:\\secret.ts', '/secret.ts']) assert.equal(allowedSourcePath(file), false, file);
});

test('actual copy excludes secrets and discovers tests without shell expansion', async () => {
  const source = await mkdtemp(join(tmpdir(), 'axiom-ci-source-test-'));
  const destination = await mkdtemp(join(tmpdir(), 'axiom-ci-gate-'));
  try {
    for (const directory of ['server/runtime', 'src/lib', 'qa']) await mkdir(join(source, directory), { recursive: true });
    const files = ['server/runtime/one.test.ts', 'src/lib/two.test.ts', 'src/lib/production.ts', '.env.local', 'qa/secret-results.json', 'personal.html'];
    for (const file of files) await writeFile(join(source, file), file, 'utf8');
    assert.equal(await copySourceFiles(source, destination, files), 3);
    assert.deepEqual(await discoverTests(destination), ['server/runtime/one.test.ts', 'src/lib/two.test.ts']);
    assert.deepEqual((await readdir(destination)).sort(), ['server', 'src']);
  } finally { await rm(source, { recursive: true, force: true }); await removeScratch(destination); }
});

test('cleanup removes only the disposable dependency link and preserves its target', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'axiom-ci-gate-'));
  const dependencies = await mkdtemp(join(tmpdir(), 'axiom-ci-dependency-test-'));
  try {
    await writeFile(join(dependencies, 'sentinel.txt'), 'preserved');
    await symlink(dependencies, join(scratch, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    await removeScratch(scratch);
    assert.equal(await readFile(join(dependencies, 'sentinel.txt'), 'utf8'), 'preserved');
    await assert.rejects(removeScratch(tmpdir()), /unexpected CI workspace/);
  } finally { await rm(dependencies, { recursive: true, force: true }); }
});

test('a failing command retains its log and is not retried', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'axiom-ci-gate-'));
  try {
    const result = await runStage({ id: 'injected-failure', name: 'injected', args: ['-e', 'console.log("retained failure evidence");process.exitCode=7;'] }, scratch, offlineEnvironment(), scratch);
    assert.equal(result.status, 'failed');
    assert.equal(result.code, 7);
    assert.equal(result.attempts.length, 1);
    assert.equal(result.firstPassPassed, false);
    assert.match(await readFile(join(scratch, 'injected-failure.log'), 'utf8'), /retained failure evidence/);
  } finally { await removeScratch(scratch); }
});

test('a hung command is terminated and cannot produce a clean pass', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'axiom-ci-gate-'));
  try {
    const result = await runStage({ id: 'injected-timeout', name: 'timeout', args: ['-e', 'setInterval(()=>{},1000);'], timeoutMs: 200 }, scratch, offlineEnvironment(), scratch);
    assert.equal(result.status, 'failed');
    assert.equal(result.timedOut, true);
    assert.equal(result.attempts.length, 1);
  } finally { await removeScratch(scratch); }
});
