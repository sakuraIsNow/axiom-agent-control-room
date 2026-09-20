import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Run against a prepared, disposable source export or extracted runtime archive.
// No application secrets/configuration, real database, model or user's history is used.
const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const flags = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const flag = process.argv[index];
  if (flag === '--skip-tests') { flags.set(flag, true); continue; }
  if (!['--source', '--bundle', '--report', '--npm-cache', '--expected-version', '--install-timeout-ms'].includes(flag)
    || !process.argv[index + 1] || process.argv[index + 1].startsWith('--')) {
    throw new Error('Usage: node scripts/release-repro-smoke.mjs (--source ABS_DIR | --bundle ABS_DIR) [--skip-tests] [--report ABS_JSON] [--npm-cache ABS_DIR] [--expected-version VERSION] [--install-timeout-ms MS]');
  }
  if (flags.has(flag)) throw new Error(`Repeated option: ${flag}`);
  flags.set(flag, process.argv[++index]);
}
if (flags.has('--source') === flags.has('--bundle')) throw new Error('Specify exactly one of --source or --bundle.');
const mode = flags.has('--source') ? 'source' : 'bundle';
const suppliedRoot = flags.get(`--${mode}`);
if (!isAbsolute(suppliedRoot)) throw new Error('The exported source/bundle path must be absolute.');
const root = await realpath(suppliedRoot);
if (root.toLowerCase() === (await realpath(scriptRoot)).toLowerCase()) throw new Error('Refusing to install or smoke-test the working repository. Supply a disposable source export or extracted bundle.');
const expectedVersion = flags.get('--expected-version') ?? '2.3.0-rc.8';
const reportPath = flags.has('--report') ? resolve(flags.get('--report')) : null;
const installTimeoutMs = Number(flags.get('--install-timeout-ms') ?? 900_000);
if (!Number.isFinite(installTimeoutMs) || installTimeoutMs < 10_000 || installTimeoutMs > 3_600_000) throw new Error('Install timeout must be between 10000 and 3600000 ms.');
if (flags.has('--npm-cache') && !isAbsolute(flags.get('--npm-cache'))) throw new Error('The optional npm cache path must be absolute.');

const report = {
  schemaVersion: 1, mode, expectedVersion, nodeVersion: process.version, startedAt: new Date().toISOString(), passed: false,
  isolation: { inheritedAppEnvironment: false, userDatabase: false, realModelCalls: false, temporarySQLite: true },
  steps: [], checks: {}, skipped: mode === 'bundle' ? ['source-typecheck', 'source-tests', 'source-build'] : flags.has('--skip-tests') ? ['source-tests'] : [],
};
const children = new Set();
let workspace;
let failure;
let cleaning;
let server;
let serverError;
let serverTail = '';
const scrub = (value) => String(value)
  .replace(/\b(?:sk-[\w-]{8,}|gh[pousr]_[\w]{12,}|github_pat_[\w]{12,})\b/g, '[redacted]')
  .replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer [redacted]')
  .replace(/((?:api[_-]?key|access[_-]?token|secret|password|authorization)["']?\s*[:=]\s*["']?)[^\s,;"'}]+/gi, '$1[redacted]')
  .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@');
const log = (text) => process.stdout.write(`${scrub(text)}\n`);
const delay = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds));
const exists = async (path) => { try { await access(path); return true; } catch { return false; } };
const exited = (child) => child.exitCode !== null || child.signalCode !== null;
const track = (child) => { children.add(child); child.once('close', () => children.delete(child)); return child; };

async function stopChild(child) {
  if (!child?.pid || exited(child)) return;
  const closed = new Promise((done) => child.once('close', done));
  if (process.platform === 'win32') {
    await new Promise((done, reject) => {
      const killer = spawn(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 10_000 });
      killer.once('error', reject);
      killer.once('close', (code) => code === 0 || exited(child) ? done() : reject(new Error('Failed to stop the isolated release process tree.')));
    });
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  let timer;
  try {
    await Promise.race([closed, new Promise((_, reject) => {
      timer = setTimeout(() => {
        try {
          if (!exited(child)) {
            if (process.platform === 'win32') child.kill('SIGKILL');
            else process.kill(-child.pid, 'SIGKILL');
          }
        } catch { /* the child may exit just before the signal */ }
        reject(new Error('Isolated release process shutdown timed out.'));
      }, 8_000);
    })]);
  } finally { clearTimeout(timer); }
}

const clean = () => cleaning ??= (async () => {
  const outcomes = await Promise.allSettled([...children].map(stopChild));
  const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
  if (rejected) throw rejected.reason;
  if (workspace) {
    const tempRoot = await realpath(tmpdir());
    const actual = await realpath(workspace);
    const leaf = relative(tempRoot, actual);
    if (!leaf.startsWith('axiom-release-repro-') || leaf.includes('..') || leaf.includes('/') || leaf.includes('\\') || isAbsolute(leaf)) throw new Error('Refusing unsafe temporary-workspace cleanup.');
    await rm(actual, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 });
  }
})();
for (const [signal, exitCode] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  process.once(signal, () => { void clean().finally(() => process.exit(exitCode)); });
}

function safeEnvironment() {
  const allowed = new Set(['PATH', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'LANG', 'LC_ALL']);
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key.toUpperCase())));
}

async function npmCli() {
  const candidates = [process.env.npm_execpath, join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js')];
  for (const entry of (process.env.PATH ?? process.env.Path ?? '').split(process.platform === 'win32' ? ';' : ':')) {
    if (entry) candidates.push(join(entry, 'node_modules', 'npm', 'bin', 'npm-cli.js'), join(entry, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  }
  for (const candidate of candidates) if (candidate && basename(candidate) === 'npm-cli.js' && await exists(candidate)) return realpath(candidate);
  throw new Error('Cannot locate npm-cli.js. Run this script with a Node installation that includes npm.');
}

async function runStep(name, args, env, timeoutMs) {
  const started = Date.now();
  log(`[release-repro] ${name}`);
  const step = { name, passed: false, durationMs: 0 };
  report.steps.push(step);
  const child = track(spawn(process.execPath, args, { cwd: root, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] }));
  const feed = (chunk) => process.stdout.write(scrub(chunk.toString()));
  child.stdout.on('data', feed);
  child.stderr.on('data', feed);
  let timer;
  let heartbeat;
  try {
    await new Promise((done, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => code === 0 ? done() : reject(new Error(`${name} exited with ${code ?? signal ?? 'unknown'}.`)));
      timer = setTimeout(() => { void stopChild(child).then(() => reject(new Error(`${name} timed out after ${timeoutMs} ms.`)), reject); }, timeoutMs);
      heartbeat = setInterval(() => log(`[release-repro] ${name}: still running (${Math.round((Date.now() - started) / 1_000)} s)`), 30_000);
    });
    step.passed = true;
  } finally { clearTimeout(timer); clearInterval(heartbeat); step.durationMs = Date.now() - started; }
}

async function freePort() {
  return new Promise((done, reject) => {
    const socket = createServer();
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => {
      const address = socket.address();
      socket.close((error) => error ? reject(error) : done(address.port));
    });
  });
}

try {
  assert.ok((await lstat(root)).isDirectory(), 'Source/bundle root is not a directory.');
  const names = await readdir(root);
  assert.ok(!names.some((name) => name === '.env' || name.startsWith('.env.') && name !== '.env.example'), 'Refusing a directory with real .env configuration. Export clean source or extract a clean release archive.');
  assert.ok(!names.includes('.git'), 'Use a clean source export, not a working Git checkout.');
  assert.ok(!names.includes('.data'), 'Refusing an export containing application data.');
  assert.ok(!names.includes('.npmrc'), 'Refusing project npm configuration in a clean public release fixture.');
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
  assert.equal(manifest.version, expectedVersion, 'Release package version mismatch.');
  assert.equal(lock.version, expectedVersion, 'Release lockfile version mismatch.');
  assert.equal(lock.packages?.['']?.version, expectedVersion, 'Root dependency lock version mismatch.');
  report.version = manifest.version;
  report.checks.packageVersion = true;
  workspace = await mkdtemp(join(await realpath(tmpdir()), 'axiom-release-repro-'));
  await Promise.all(['artifacts', 'agent-workspace', 'npm-cache', 'config'].map((name) => mkdir(join(workspace, name))));
  const userConfig = join(workspace, 'config', 'npm-user');
  const globalConfig = join(workspace, 'config', 'npm-global');
  await Promise.all([writeFile(userConfig, ''), writeFile(globalConfig, '')]);
  const env = {
    ...safeEnvironment(),
    CI: 'true', NO_COLOR: '1', NODE_ENV: 'test',
    npm_config_userconfig: userConfig, npm_config_globalconfig: globalConfig,
    npm_config_cache: flags.get('--npm-cache') ?? join(workspace, 'npm-cache'),
    npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false',
    npm_config_fetch_retries: '1', npm_config_fetch_timeout: '120000',
    DATABASE_URL: '', AXIOM_TEST_DATABASE_URL: '', AXIOM_READONLY_DATABASE_URL: '',
    AXIOM_SQLITE_PATH: join(workspace, 'runtime.sqlite'),
    AXIOM_OBJECT_STORAGE_PATH: join(workspace, 'artifacts'),
    AXIOM_OBJECT_STORAGE_ENDPOINT: '', AXIOM_AGENT_WORKSPACE_ROOT: join(workspace, 'agent-workspace'),
    AXIOM_PROVIDER_SECRET: randomBytes(48).toString('hex'),
    AXIOM_API_KEY: '', AXIOM_PRINCIPAL_SECRET: '', AXIOM_TRUST_PROXY_AUTH: 'false',
    TDAI_MEMORY_ENDPOINT: '', TDAI_MEMORY_API_KEY: '', DMX_CONFIG_PATH: '',
    DEEPSEEK_API_KEY: '', DEEPSEEK_VISION_API_KEY: '', DMX_API_KEY: '', VIDEO_API_KEY: '',
    DEEPSEEK_API_BASE: 'http://127.0.0.1:1', DEEPSEEK_VISION_API_BASE: 'http://127.0.0.1:1', DMX_BASE_URL: 'http://127.0.0.1:1', VIDEO_API_BASE: '',
    DEEPSEEK_NATIVE_SEARCH: 'false', DEEPSEEK_FILES_API: 'false',
    DEEPSEEK_HARNESS_URL: '', DEEPSEEK_HARNESS_COMMAND: '', DEEPSEEK_HARNESS_COMMAND_JSON: '',
    AXIOM_TOOL_EXECUTOR: 'disabled', AXIOM_SERVE_FRONTEND: 'true', API_HOST: '127.0.0.1',
  };
  const npm = await npmCli();
  await runStep('npm ci', [npm, 'ci', ...(mode === 'bundle' ? ['--omit=dev'] : []), '--no-audit', '--no-fund'], env, installTimeoutMs);
  if (mode === 'source') {
    await runStep('npm run check', [npm, 'run', 'check'], env, 300_000);
    if (!flags.has('--skip-tests')) await runStep('npm test', [npm, 'test'], env, 600_000);
    // Vite respects an explicitly inherited NODE_ENV. Building with the test
    // runner's NODE_ENV=test emits jsxDEV fileName metadata, including absolute
    // source paths, into public assets. Test with test, ship with production.
    await runStep('npm run build', [npm, 'run', 'build'], { ...env, NODE_ENV: 'production' }, 600_000);
  }
  assert.ok(await exists(join(root, 'server-dist', 'index.js')), 'Compiled server entry is missing.');
  assert.ok(await exists(join(root, 'dist', 'index.html')), 'Built web frontend is missing.');
  // Tests may create data under their provided path. Serve a separate never-used database.
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const serverEnv = { ...env, API_PORT: String(port), AXIOM_SQLITE_PATH: join(workspace, 'smoke.sqlite'), AXIOM_ALLOWED_ORIGINS: origin };
  server = track(spawn(process.execPath, [join(root, 'server-dist', 'index.js')], { cwd: root, env: serverEnv, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] }));
  const capture = (chunk) => { const text = scrub(chunk.toString()); serverTail = (serverTail + text).slice(-16_000); process.stdout.write(text); };
  server.stdout.on('data', capture);
  server.stderr.on('data', capture);
  server.once('error', (error) => { serverError = error; });
  const startedAt = Date.now();
  let health;
  while (Date.now() - startedAt < 45_000) {
    if (serverError || exited(server)) throw new Error('Isolated API could not start; inspect the captured release output.');
    const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1_000) }).catch(() => null);
    if (response?.ok) { health = await response.json(); break; }
    await delay(250);
  }
  assert.ok(health, 'Isolated API startup exceeded 45 seconds.');
  assert.equal(health.service, 'axiom-agent-gateway');
  assert.equal(health.configured, false, 'An unexpected real text-model key was loaded.');
  assert.equal(health.image?.configured, false, 'An unexpected real image-model key was loaded.');
  report.checks.health = { http: 200, service: health.service, status: health.status, configured: false };
  const responses = [{ path: '/api/health', text: JSON.stringify(health) }];
  const get = async (path) => {
    const response = await fetch(`${origin}${path}`, { signal: AbortSignal.timeout(15_000) });
    assert.equal(response.status, 200, `${path} returned ${response.status}.`);
    const text = await response.text();
    responses.push({ path, text });
    return { response, text };
  };
  const html = await get('/');
  assert.match(html.response.headers.get('content-type') ?? '', /text\/html/i);
  assert.match(html.text, /id=["']root["']/);
  const assets = [...new Set([...html.text.matchAll(/(?:src|href)=["'](\/assets\/[^"']+)["']/g)].map((match) => match[1]))];
  assert.ok(assets.length > 0, 'Built index does not reference bundled web assets.');
  for (const asset of assets) {
    const result = await get(asset);
    assert.ok(result.text.length > 0, 'Bundled web asset is empty.');
    assert.ok(!/text\/html/i.test(result.response.headers.get('content-type') ?? ''), 'Missing asset incorrectly fell through to the SPA index.');
  }
  report.checks.frontend = { html: true, assets: assets.length };
  for (const [path, field] of [['/api/improvements/sources', 'tasks'], ['/api/improvements', 'proposals'], ['/api/tasks', 'tasks']]) {
    const result = JSON.parse((await get(path)).text);
    assert.deepEqual(result[field], [], `${path} unexpectedly contained real task/history data.`);
    report.checks[path] = { http: 200, empty: true };
  }
  const readiness = JSON.parse((await get('/api/runtime/readiness')).text);
  assert.ok(Array.isArray(readiness.checks), 'Readiness response is invalid.');
  assert.equal(readiness.deployment, 'local-single-node');
  const modelCheck = readiness.checks.find((check) => check.id === 'model-provider');
  assert.equal(modelCheck?.state, 'blocked', 'The no-key fixture must honestly report the unconfigured model.');
  assert.ok(!readiness.checks.some((check) => check.id === 'provider-bindings' && check.state === 'blocked'), 'Ephemeral provider protection was not configured.');
  report.checks.readiness = { state: readiness.state, deployment: readiness.deployment, unconfiguredModelExpected: true };
  const forbiddenValues = [scriptRoot, root, workspace].flatMap((path) => [path, path.replaceAll('\\', '/'), path.replaceAll('\\', '\\\\')]);
  const fieldContaining = (value, needle, field = '$') => {
    if (typeof value === 'string' && value.toLowerCase().includes(needle)) return field;
    if (!value || typeof value !== 'object') return null;
    for (const [key, nested] of Object.entries(value)) {
      const found = fieldContaining(nested, needle, `${field}.${key}`);
      if (found) return found;
    }
    return null;
  };
  for (const { path, text } of responses) {
    const exposed = text.toLowerCase();
    const forbidden = forbiddenValues.find((value) => exposed.includes(value.toLowerCase()));
    if (forbidden) {
      let field = '$body';
      try { field = fieldContaining(JSON.parse(text), forbidden.toLowerCase()) ?? field; } catch { /* HTML/JS/CSS body, not JSON */ }
      report.checks.pathExposure = { route: path, field };
      // Identify the endpoint/field, never print the leaked value or body.
      throw new Error(`An HTTP response exposed a local absolute filesystem path: ${path} (${field}).`);
    }
    if (exposed.includes(env.AXIOM_PROVIDER_SECRET)) {
      report.checks.secretExposure = { route: path };
      throw new Error(`An HTTP response exposed the temporary provider secret: ${path}.`);
    }
  }
  report.checks.noLocalPathOrSecretInResponses = true;
  report.passed = true;
  log(`[release-repro] ${mode} clean-install and read-only smoke passed.`);
} catch (error) {
  failure = error;
  report.error = scrub(error instanceof Error ? error.message : error);
  if (serverTail && !report.passed) log(`[release-repro] API diagnostics:\n${serverTail}`);
  log(`[release-repro] FAILED: ${report.error}`);
} finally {
  try { await clean(); } catch (error) {
    failure ??= error;
    report.passed = false;
    report.cleanupError = scrub(error instanceof Error ? error.message : error);
  }
  report.finishedAt = new Date().toISOString();
  if (reportPath) {
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  }
  log(JSON.stringify(report));
  if (failure) process.exitCode = 1;
}
