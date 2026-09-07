import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import { ProviderBindingStore } from './providerBindings.js';
import { PostgresTaskStore } from './postgresTaskStore.js';
import { PostgresScheduler } from './scheduler.js';

const databaseUrl = process.env.AXIOM_TEST_DATABASE_URL?.trim();
const run = promisify(execFile);
test('the migration command upgrades an existing v3 PostgreSQL database without losing tasks', {
  skip: databaseUrl ? false : 'AXIOM_TEST_DATABASE_URL is not configured.', timeout: 30_000,
}, async () => {
  const schema = `binding_upgrade_${randomUUID().replaceAll('-', '')}`;
  const scopedUrl = new URL(databaseUrl!);
  scopedUrl.searchParams.set('options', `-c search_path=${schema}`);
  const admin = new Pool({ connectionString: databaseUrl, max: 1 });
  const pool = new Pool({ connectionString: scopedUrl.toString(), max: 1 });
  const first = new PostgresTaskStore(scopedUrl.toString());
  const second = new PostgresTaskStore(scopedUrl.toString());
  let schemaCreated = false;
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    await first.initialize();
    const original = await first.createTask({ tenantId: 'upgrade-tenant', userId: 'upgrade-user', sessionId: 'legacy-session', title: 'Existing task', input: 'Keep this task', mode: 'analyze' });
    // Reconstruct the released v3 schema only inside this test's isolated schema.
    await pool.query('ALTER TABLE tasks DROP COLUMN provider_binding_id; DELETE FROM schema_migrations WHERE version >= 4;');
    assert.equal((await pool.query('SELECT MAX(version) AS version FROM schema_migrations')).rows[0].version, 3);
    assert.equal((await pool.query("SELECT 1 FROM information_schema.columns WHERE table_schema=$1 AND table_name='tasks' AND column_name='provider_binding_id'", [schema])).rowCount, 0);

    const migration = await run(process.execPath, ['--import', 'tsx', 'server/migrate.ts'], {
      cwd: fileURLToPath(new URL('../../', import.meta.url)),
      env: { ...process.env, DATABASE_URL: scopedUrl.toString() },
      windowsHide: true,
      timeout: 20_000,
    });
    assert.match(migration.stdout, /migrations are up to date/);
    assert.equal((await pool.query('SELECT 1 FROM schema_migrations WHERE version=4')).rowCount, 1);
    assert.equal((await first.getTask(original.id, original.tenantId))?.input, original.input);
    assert.equal((await first.getTask(original.id, original.tenantId))?.providerBindingId, undefined);

    await Promise.all([first.initialize(), second.initialize()]);
    const providerBindingId = randomUUID();
    const bound = await second.createTask({ tenantId: original.tenantId, userId: original.userId, sessionId: 'new-session', title: 'Upgraded task', input: 'Use the bound model', mode: 'analyze', providerBindingId });
    assert.equal((await first.getTask(bound.id, bound.tenantId))?.providerBindingId, providerBindingId);
    assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM tasks')).rows[0].count, 2);
  } finally {
    await Promise.all([first.close(), second.close(), pool.end()]);
    if (schemaCreated) await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
});

test('PostgreSQL preserves encrypted model bindings across workers, task reloads and schedule triggers', {
  skip: databaseUrl ? false : 'AXIOM_TEST_DATABASE_URL is not configured.', timeout: 20_000,
}, async () => {
  const previous = process.env.AXIOM_PROVIDER_SECRET;
  process.env.AXIOM_PROVIDER_SECRET = 'postgres-binding-test-secret';
  const owner = { tenantId: `provider-binding-pg-${randomUUID()}`, userId: 'binding-user' };
  const bindings = new ProviderBindingStore({ databaseUrl });
  const worker = new ProviderBindingStore({ databaseUrl });
  const tasks = new PostgresTaskStore(databaseUrl!);
  const scheduler = new PostgresScheduler(databaseUrl!, async () => {});
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    await bindings.initialize(); await worker.initialize(); await tasks.initialize(); await scheduler.ready();
    const binding = await bindings.create(owner, { text: { apiKey: 'private-pg-key', baseUrl: 'https://selected.example', model: 'pinned-text', location: 'internet' }, vision: null, image: null, video: null, search: null });
    const task = await tasks.createTask({ ...owner, sessionId: 'pg-session', title: 'Pinned', input: 'Read data', mode: 'analyze', providerBindingId: binding.providerBindingId });
    const restored = (await tasks.getTask(task.id, owner.tenantId))!;
    assert.equal(restored.providerBindingId, binding.providerBindingId);
    assert.equal((await worker.resolve(restored, 'text'))?.apiKey, 'private-pg-key');
    const trigger = await scheduler.upsert({ ...owner, sessionId: 'pg-session', title: 'Pinned schedule', input: 'Read data', mode: 'analyze', providerBindingId: binding.providerBindingId, enabled: false, intervalSeconds: 3600 });
    assert.equal((await scheduler.get(trigger.id, owner.tenantId))?.providerBindingId, binding.providerBindingId);
    await assert.rejects(worker.get({ ...restored, userId: 'different-user' }), /not owned/);
    const rows = await pool.query('SELECT encrypted_bundle FROM provider_bindings WHERE tenant_id=$1', [owner.tenantId]);
    assert.equal(JSON.stringify(rows.rows).includes('private-pg-key'), false);
  } finally {
    await pool.query('DELETE FROM schedules WHERE tenant_id=$1', [owner.tenantId]);
    await pool.query('DELETE FROM tasks WHERE tenant_id=$1', [owner.tenantId]);
    await pool.query('DELETE FROM provider_bindings WHERE tenant_id=$1', [owner.tenantId]);
    await Promise.all([bindings.close(), worker.close(), tasks.close(), scheduler.stop(), pool.end()]);
    if (previous === undefined) delete process.env.AXIOM_PROVIDER_SECRET; else process.env.AXIOM_PROVIDER_SECRET = previous;
  }
});
