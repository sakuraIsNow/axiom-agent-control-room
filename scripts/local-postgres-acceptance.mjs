import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
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
const testUrl = new URL(adminUrl);
testUrl.pathname = `/${database}`;
const admin = new Pool({ connectionString: adminUrl.toString(), max: 1, connectionTimeoutMillis: 10_000 });
const node = process.execPath;
const productionGate = process.argv.includes('--production-gate');
const stabilityGate = process.argv.includes('--stability');
let databaseCreated = false;
let cleanupStarted = false;

const run = (args) => new Promise((resolveRun, rejectRun) => {
  const child = spawn(node, args, {
    cwd: root,
    env: { ...process.env, AXIOM_TEST_DATABASE_URL: testUrl.toString() },
    stdio: 'inherit',
    windowsHide: true,
  });
  child.once('error', rejectRun);
  child.once('close', (code, signal) => {
    if (code === 0) resolveRun();
    else rejectRun(new Error(`${node} ${args.join(' ')} exited with ${code ?? signal ?? 'unknown'}.`));
  });
});

const cleanup = async () => {
  if (cleanupStarted) return;
  cleanupStarted = true;
  if (databaseCreated) {
    await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [database]).catch(() => undefined);
    await admin.query(`DROP DATABASE IF EXISTS "${database}"`).catch(() => undefined);
  }
  await admin.end().catch(() => undefined);
};

process.once('SIGINT', () => void cleanup().finally(() => process.exit(130)));
process.once('SIGTERM', () => void cleanup().finally(() => process.exit(143)));

try {
  if (productionGate) await run(['scripts/local-object-storage-acceptance.mjs', '--prepare-only']);
  await admin.query(`CREATE DATABASE "${database}"`);
  databaseCreated = true;
  if (productionGate) {
    process.env.AXIOM_OBJECT_STORAGE_ENDPOINT = `http://127.0.0.1:${(process.env.AXIOM_MINIO_PORT ?? '9000').trim()}`;
    process.env.AXIOM_OBJECT_STORAGE_BUCKET = (process.env.AXIOM_MINIO_QA_BUCKET ?? 'axiom-qa').trim();
    process.env.AXIOM_OBJECT_STORAGE_REGION = 'us-east-1';
    process.env.AXIOM_OBJECT_STORAGE_PREFIX = 'axiom-qa-artifacts';
    process.env.AXIOM_OBJECT_STORAGE_ACCESS_KEY = (process.env.AXIOM_MINIO_ROOT_USER ?? 'axiom-minio').trim();
    process.env.AXIOM_OBJECT_STORAGE_SECRET_KEY = (process.env.AXIOM_MINIO_ROOT_PASSWORD ?? 'change-me-minio').trim();
    process.env.AXIOM_OBJECT_STORAGE_FORCE_PATH_STYLE = 'true';
    await run(['qa/production-gate.mjs']);
  } else if (stabilityGate) {
    await run(['--import', 'tsx', '--test', '--test-concurrency=1',
      'server/runtime/historyScale.test.ts',
      'server/runtime/enterpriseGovernance.postgres.test.ts',
      'server/runtime/outboundNotifications.postgres.test.ts',
      'server/runtime/scheduler.postgres.test.ts',
      'server/runtime/businessCapabilityStore.postgres.test.ts',
    ]);
  } else {
    await run(['--import', 'tsx', '--test', 'server/runtime/businessCapabilityStore.postgres.test.ts']);
    await run(['--import', 'tsx', 'qa/postgres-multi-worker-failover.mjs']);
  }
  console.log(JSON.stringify({
    ok: true,
    isolatedDatabase: true,
    ...(productionGate ? { productionGate: true, localMinio: true } : stabilityGate ? { stabilityContracts: true } : { businessContracts: true, workerFailover: true }),
  }));
} finally {
  await cleanup();
}
