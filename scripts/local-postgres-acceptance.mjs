import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { access, mkdtemp, mkdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { Pool } from 'pg';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const localFileEnv = {};
loadEnv({ path: resolve(root, '.env.local'), quiet: true, processEnv: localFileEnv });
const sourceUrl = process.env.AXIOM_POSTGRES_ADMIN_URL?.trim()
  || process.env.DATABASE_URL?.trim()
  || localFileEnv.DATABASE_URL?.trim()
  || 'postgresql://postgres:postgres@127.0.0.1:5432/postgres';
const adminUrl = new URL(sourceUrl);
adminUrl.pathname = '/postgres';
const database = `axiom_qa_${Date.now()}_${randomUUID().replaceAll('-', '').slice(0, 8)}`;
const gateDatabase = `axiom_qa_api_${Date.now()}_${randomUUID().replaceAll('-', '').slice(0, 8)}`;
const testUrl = new URL(adminUrl);
testUrl.pathname = `/${database}`;
const gateUrl = new URL(adminUrl);
gateUrl.pathname = `/${gateDatabase}`;
const admin = new Pool({ connectionString: adminUrl.toString(), max: 1, connectionTimeoutMillis: 10_000 });
const node = process.execPath;
const productionGate = process.argv.includes('--production-gate');
const stabilityGate = process.argv.includes('--stability');
const isolationSmoke = process.argv.includes('--isolation-smoke');
const createdDatabases = new Set();
const children = new Set();
let cleanupPromise;
let gateServer;
let gateServerLog;
let gateWorkspace;

const trackChild = (child) => {
  children.add(child);
  child.once('close', () => children.delete(child));
  return child;
};
const exited = (child) => child.exitCode !== null || child.signalCode !== null;
const stopChild = async (child) => {
  if (!child.pid || exited(child)) return;
  const closed = new Promise((resolveExit) => child.once('close', resolveExit));
  if (process.platform === 'win32') {
    // Stop only this runner's recorded PID and its descendants, including npm and browser helpers.
    await new Promise((resolveKill, rejectKill) => {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.once('error', rejectKill);
      killer.once('close', (code) => code === 0 || exited(child) ? resolveKill() : rejectKill(new Error('Failed to stop an isolated gate process tree.')));
    });
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  const waitForClose = async (milliseconds) => {
    let timer;
    try { return await Promise.race([closed.then(() => true), new Promise((resolveWait) => { timer = setTimeout(() => resolveWait(false), milliseconds); })]); }
    finally { clearTimeout(timer); }
  };
  if (!await waitForClose(5_000)) {
    if (process.platform === 'win32') child.kill('SIGKILL');
    else {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    if (!await waitForClose(5_000)) throw new Error('Isolated gate process shutdown did not complete.');
  }
};

const startIsolatedGateServer = async () => {
  await admin.query(`CREATE DATABASE "${gateDatabase}"`);
  createdDatabases.add(gateDatabase);
  const port = await new Promise((resolvePort, rejectPort) => {
    const socket = createServer();
    socket.once('error', rejectPort);
    socket.listen(0, '127.0.0.1', () => {
      const port = socket.address().port;
      socket.close((error) => error ? rejectPort(error) : resolvePort(port));
    });
  });
  gateWorkspace = await mkdtemp(join(tmpdir(), 'axiom-gate-'));
  await mkdir(resolve(root, 'qa'), { recursive: true });
  let startupError;
  gateServerLog = createWriteStream(resolve(root, 'qa/local-gate-server.log'));
  gateServerLog.once('error', (error) => { startupError = error; });
  const env = { ...localFileEnv, ...process.env, DATABASE_URL: gateUrl.toString(),
    AXIOM_TEST_DATABASE_URL: gateUrl.toString(), AXIOM_READONLY_DATABASE_URL: gateUrl.toString(),
    AXIOM_SQLITE_PATH: join(gateWorkspace, 'fallback.sqlite'),
    API_PORT: String(port), API_HOST: '127.0.0.1', AXIOM_SERVE_FRONTEND: 'true',
    AXIOM_OBJECT_STORAGE_ENDPOINT: '', AXIOM_OBJECT_STORAGE_PATH: join(gateWorkspace, 'artifacts'),
    AXIOM_AGENT_WORKSPACE_ROOT: gateWorkspace, AXIOM_PROVIDER_SECRET: randomUUID() + randomUUID(),
    AXIOM_API_KEY: '', AXIOM_PRINCIPAL_SECRET: '', AXIOM_TRUST_PROXY_AUTH: 'false', NODE_ENV: 'test',
    TDAI_MEMORY_ENDPOINT: '', TDAI_MEMORY_API_KEY: '',
    AXIOM_ALLOWED_ORIGINS: `http://127.0.0.1:${port},http://localhost:${port}`,
  };
  gateServer = trackChild(spawn(node, ['--import', 'tsx', 'server/index.ts'], { cwd: root, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] }));
  gateServer.stdout.pipe(gateServerLog, { end: false });
  gateServer.stderr.pipe(gateServerLog, { end: false });
  gateServer.once('error', (error) => { startupError = error; });
  const url = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (startupError || exited(gateServer)) throw new Error('Isolated gate API failed to start; inspect qa/local-gate-server.log.');
    const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1_000) }).catch(() => null);
    if (response?.ok) {
      for (const key of ['QA_URL', 'AXIOM_API_ORIGIN', 'AXIOM_WEB_ORIGIN', 'AXIOM_API_BASE', 'QA_API', 'QA_URL_A']) process.env[key] = url;
      process.env.QA_URL_B = `http://localhost:${port}`;
      console.log(JSON.stringify({ isolatedGateApi: true, url, isolatedWorkspace: true, usesUserDatabase: false, separateAcceptanceDatabase: true, externalMemoryDisabled: true }));
      return;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error('Isolated gate API startup timed out.');
};

const run = (args) => new Promise((resolveRun, rejectRun) => {
  const child = trackChild(spawn(node, args, {
    cwd: root,
    env: { ...process.env, AXIOM_TEST_DATABASE_URL: testUrl.toString() },
    stdio: 'inherit',
    windowsHide: true,
    detached: process.platform !== 'win32',
  }));
  child.once('error', rejectRun);
  child.once('close', (code, signal) => {
    if (code === 0) resolveRun();
    else rejectRun(new Error(`${node} ${args.join(' ')} exited with ${code ?? signal ?? 'unknown'}.`));
  });
});

const cleanup = () => cleanupPromise ??= (async () => {
  const stops = await Promise.allSettled([...children].map(stopChild));
  const stopFailure = stops.find((result) => result.status === 'rejected');
  gateServerLog?.end();
  try {
    if (stopFailure) throw stopFailure.reason;
    for (const name of [...createdDatabases].reverse()) {
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [name]);
      await admin.query(`DROP DATABASE IF EXISTS "${name}"`);
      createdDatabases.delete(name);
    }
    if (gateWorkspace) {
      const path = relative(tmpdir(), gateWorkspace);
      if (!path.startsWith('axiom-gate-') || path.includes('..') || path.includes('/') || path.includes('\\')) throw new Error('Gate workspace cleanup target failed containment validation.');
      await rm(gateWorkspace, { recursive: true, force: true });
    }
  } finally { await admin.end(); }
})();

process.once('SIGINT', () => void cleanup().finally(() => process.exit(130)));
process.once('SIGTERM', () => void cleanup().finally(() => process.exit(143)));

try {
  if (productionGate && !isolationSmoke) await run(['scripts/local-object-storage-acceptance.mjs', '--prepare-only']);
  await admin.query(`CREATE DATABASE "${database}"`);
  createdDatabases.add(database);
  if (isolationSmoke) {
    await startIsolatedGateServer();
    const testPool = new Pool({ connectionString: testUrl.toString(), max: 1 });
    const apiPool = new Pool({ connectionString: gateUrl.toString(), max: 1 });
    try {
      await testPool.query('CREATE TABLE isolation_marker (id INTEGER PRIMARY KEY)');
      const testState = (await testPool.query("SELECT current_database() AS database, to_regclass('isolation_marker') AS marker")).rows[0];
      const apiState = (await apiPool.query("SELECT current_database() AS database, to_regclass('isolation_marker') AS marker, to_regclass('tasks') AS tasks")).rows[0];
      if (testState.database === apiState.database || !testState.marker || apiState.marker || !apiState.tasks) throw new Error('Gate API and acceptance data are not isolated.');
      console.log(JSON.stringify({ isolationSmoke: true, separateDatabases: true, apiSchemaInitialized: true, fixtureInvisibleToApi: true }));
    } finally { await Promise.all([testPool.end(), apiPool.end()]); }
  } else if (productionGate) {
    process.env.AXIOM_OBJECT_STORAGE_ENDPOINT = `http://127.0.0.1:${(process.env.AXIOM_MINIO_PORT ?? '9000').trim()}`;
    process.env.AXIOM_OBJECT_STORAGE_BUCKET = (process.env.AXIOM_MINIO_QA_BUCKET ?? 'axiom-qa').trim();
    process.env.AXIOM_OBJECT_STORAGE_REGION = 'us-east-1';
    process.env.AXIOM_OBJECT_STORAGE_PREFIX = 'axiom-qa-artifacts';
    process.env.AXIOM_OBJECT_STORAGE_ACCESS_KEY = (process.env.AXIOM_MINIO_ROOT_USER ?? 'axiom-minio').trim();
    process.env.AXIOM_OBJECT_STORAGE_SECRET_KEY = (process.env.AXIOM_MINIO_ROOT_PASSWORD ?? 'change-me-minio').trim();
    process.env.AXIOM_OBJECT_STORAGE_FORCE_PATH_STYLE = 'true';
    if (process.env.AXIOM_QA_USE_EXISTING_SERVER !== 'true') await startIsolatedGateServer();
    await run(['qa/production-gate.mjs']);
  } else if (stabilityGate) {
    await run(['--import', 'tsx', '--test', '--test-concurrency=1',
      'server/runtime/historyScale.test.ts',
      'server/runtime/enterpriseGovernance.postgres.test.ts',
      'server/runtime/outboundNotifications.postgres.test.ts',
      'server/runtime/scheduler.postgres.test.ts',
      'server/runtime/businessCapabilityStore.postgres.test.ts',
      'server/runtime/toolExecutionStore.postgres.test.ts',
      'server/runtime/providerBindings.postgres.test.ts',
    ]);
  } else {
    await run(['--import', 'tsx', '--test', 'server/runtime/businessCapabilityStore.postgres.test.ts']);
    await run(['--import', 'tsx', 'qa/postgres-multi-worker-failover.mjs']);
  }
  console.log(JSON.stringify({
    ok: true,
    isolatedDatabase: true,
    ...(isolationSmoke ? { isolationSmoke: true } : productionGate ? { productionGate: true, localMinio: true } : stabilityGate ? { stabilityContracts: true } : { businessContracts: true, workerFailover: true }),
  }));
} finally {
  await cleanup();
}

if (isolationSmoke) {
  const workspaceExists = await access(gateWorkspace).then(() => true, (error) => { if (error.code !== 'ENOENT') throw error; return false; });
  if (createdDatabases.size || !exited(gateServer) || workspaceExists) throw new Error('Isolation smoke cleanup left tracked resources.');
  console.log(JSON.stringify({ isolationSmokeCleanup: true, apiStopped: true, databasesDropped: 2, workspaceRemoved: true }));
}
