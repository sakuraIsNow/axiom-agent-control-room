import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import {
  cadenceIntervalSeconds,
  legacyIntervalCadence,
  nextRunAtForCadence,
  normalizeScheduleCadence,
  scheduleCadenceSchema,
  type ScheduleCadence,
} from './scheduleCadence.js';

export type ScheduledTrigger = {
  id: string;
  tenantId: string;
  userId: string;
  sessionId: string;
  title: string;
  input: string;
  mode: 'analyze' | 'build' | 'decide';
  modelCredentialId?: string;
  cadence: ScheduleCadence;
  /** Compatibility and retry-backoff value for schedules created before cadence support. */
  intervalSeconds: number;
  enabled: boolean;
  nextRunAt: string;
  createdAt: string;
  lastRunAt?: string;
  failureCount: number;
  lastError?: string;
  lastRunStatus?: ScheduledRunStatus;
  deadLetteredAt?: string;
};

export type ScheduledRunStatus = 'success' | 'failed' | 'dead-letter';

export type ScheduledTriggerInput = Pick<ScheduledTrigger, 'tenantId' | 'userId' | 'sessionId' | 'title' | 'input' | 'mode' | 'modelCredentialId' | 'enabled'> & {
  id?: string;
  cadence?: ScheduleCadence;
  intervalSeconds?: number;
  nextRunAt?: string;
  createdAt?: string;
};

export interface Scheduler {
  ready(): Promise<void>;
  start(): void;
  stop(): Promise<void> | void;
  upsert(input: ScheduledTriggerInput): Promise<ScheduledTrigger>;
  list(tenantId: string): Promise<ScheduledTrigger[]>;
  get(id: string, tenantId: string): Promise<ScheduledTrigger | null>;
  remove(id: string, tenantId: string): Promise<boolean>;
  resume(id: string, tenantId: string): Promise<ScheduledTrigger | null>;
}

export const MAX_SCHEDULE_FAILURES = 5;
const MAX_ERROR_LENGTH = 2_000;
const MAX_BACKOFF_SECONDS = 7 * 24 * 60 * 60;
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, MAX_ERROR_LENGTH);
const backoffSeconds = (intervalSeconds: number, failureCount: number) => Math.min(MAX_BACKOFF_SECONDS, intervalSeconds * (2 ** Math.max(1, failureCount)));
const afterSeconds = (seconds: number, now = new Date()) => new Date(now.getTime() + seconds * 1_000).toISOString();
const createTrigger = (input: ScheduledTriggerInput): ScheduledTrigger => {
  const now = new Date();
  const cadence = normalizeScheduleCadence(input);
  const intervalSeconds = cadenceIntervalSeconds(cadence);
  const nextRunAt = input.nextRunAt ?? nextRunAtForCadence(cadence, now);
  if (!nextRunAt) throw new Error('A one-time schedule must be set in the future.');
  return {
    ...input,
    id: input.id ?? randomUUID(),
    cadence,
    intervalSeconds,
    nextRunAt,
    createdAt: input.createdAt ?? now.toISOString(),
    failureCount: 0,
    lastError: undefined,
    lastRunStatus: undefined,
    deadLetteredAt: undefined,
  };
};
const markSuccess = (item: ScheduledTrigger, completedAt = new Date()): ScheduledTrigger => {
  const nextRunAt = item.cadence.kind === 'once' ? null : nextRunAtForCadence(item.cadence, completedAt);
  return {
    ...item,
    enabled: nextRunAt ? item.enabled : false,
    failureCount: 0,
    lastError: undefined,
    lastRunStatus: 'success',
    lastRunAt: completedAt.toISOString(),
    deadLetteredAt: undefined,
    nextRunAt: nextRunAt ?? item.nextRunAt,
  };
};
const markFailure = (item: ScheduledTrigger, error: unknown): ScheduledTrigger => {
  const failureCount = item.failureCount + 1;
  const deadLettered = failureCount >= MAX_SCHEDULE_FAILURES;
  const now = new Date();
  return { ...item, failureCount, lastError: errorText(error), lastRunStatus: deadLettered ? 'dead-letter' : 'failed', lastRunAt: now.toISOString(), deadLetteredAt: deadLettered ? now.toISOString() : undefined, enabled: deadLettered ? false : item.enabled, nextRunAt: deadLettered ? now.toISOString() : afterSeconds(backoffSeconds(item.intervalSeconds, failureCount), now) };
};

const resumedTrigger = (item: ScheduledTrigger) => {
  const now = new Date();
  // A failed one-time schedule is intentionally run once after manual recovery,
  // even when its original wall-clock deadline has passed.
  const nextRunAt = nextRunAtForCadence(item.cadence, now) ?? afterSeconds(1, now);
  return { ...item, enabled: true, failureCount: 0, lastError: undefined, lastRunStatus: undefined, deadLetteredAt: undefined, nextRunAt } satisfies ScheduledTrigger;
};

export class InMemoryScheduler implements Scheduler {
  private readonly items = new Map<string, ScheduledTrigger>();
  private timer?: NodeJS.Timeout;
  private ticking = false;

  constructor(private readonly handler: (trigger: ScheduledTrigger) => Promise<void>) {}

  async ready() {}

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), 1_000);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async upsert(input: ScheduledTriggerInput) {
    const item = createTrigger(input);
    this.items.set(item.id, item);
    return item;
  }

  async list(tenantId: string) {
    return [...this.items.values()].filter((item) => item.tenantId === tenantId);
  }

  async get(id: string, tenantId: string) {
    const item = this.items.get(id);
    return item?.tenantId === tenantId ? { ...item } : null;
  }

  async remove(id: string, tenantId: string) {
    const item = this.items.get(id);
    if (!item || item.tenantId !== tenantId) return false;
    return this.items.delete(id);
  }

  async resume(id: string, tenantId: string) {
    const item = this.items.get(id);
    if (!item || item.tenantId !== tenantId) return null;
    const resumed = resumedTrigger(item);
    this.items.set(id, resumed);
    return resumed;
  }

  private async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
    const now = Date.now();
    for (const item of [...this.items.values()]) {
      if (!item.enabled || Date.parse(item.nextRunAt) > now) continue;
      try {
        await this.handler({ ...item });
        const current = this.items.get(item.id);
        if (current) this.items.set(item.id, markSuccess(current));
      } catch (error) {
        const current = this.items.get(item.id);
        if (current) this.items.set(item.id, markFailure(current, error));
      }
    }
    } finally {
      this.ticking = false;
    }
  }
}

const triggerFromRow = (row: {
  id: string; tenant_id: string; user_id: string; session_id: string; title: string; input: string; model_credential_id?: string | null;
  mode: ScheduledTrigger['mode']; interval_seconds: number; enabled: boolean; next_run_at: Date | string; created_at: Date | string;
  cadence_json?: unknown; last_run_at?: Date | string | null; failure_count?: number | string; last_error?: string | null;
  last_run_status?: ScheduledRunStatus | null; dead_lettered_at?: Date | string | null;
}): ScheduledTrigger => {
  let rawCadence = row.cadence_json;
  if (typeof rawCadence === 'string') {
    try { rawCadence = JSON.parse(rawCadence); } catch { rawCadence = undefined; }
  }
  const parsedCadence = scheduleCadenceSchema.safeParse(rawCadence);
  const cadence = parsedCadence.success ? parsedCadence.data : legacyIntervalCadence(Number(row.interval_seconds));
  return ({
  id: row.id,
  tenantId: row.tenant_id,
  userId: row.user_id,
  sessionId: row.session_id,
  title: row.title,
  input: row.input,
  mode: row.mode,
  modelCredentialId: row.model_credential_id ?? undefined,
  cadence,
  intervalSeconds: cadenceIntervalSeconds(cadence),
  enabled: row.enabled,
  nextRunAt: row.next_run_at instanceof Date ? row.next_run_at.toISOString() : row.next_run_at,
  createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  lastRunAt: row.last_run_at instanceof Date ? row.last_run_at.toISOString() : row.last_run_at ?? undefined,
  failureCount: Number(row.failure_count ?? 0),
  lastError: row.last_error ?? undefined,
  lastRunStatus: row.last_run_status ?? undefined,
  deadLetteredAt: row.dead_lettered_at instanceof Date ? row.dead_lettered_at.toISOString() : row.dead_lettered_at ?? undefined,
  });
};

export class PostgresScheduler implements Scheduler {
  private readonly pool: Pool;
  private initialized?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private ticking = false;

  constructor(
    connectionString: string,
    private readonly handler: (trigger: ScheduledTrigger) => Promise<void>,
  ) {
    this.pool = new Pool({ connectionString, max: Number(process.env.DATABASE_POOL_SIZE ?? 10) });
  }

  ready() {
    if (!this.initialized) {
      this.initialized = this.pool.query(`
        CREATE TABLE IF NOT EXISTS schedules (
          id UUID PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          title TEXT NOT NULL,
          input TEXT NOT NULL,
          mode TEXT NOT NULL,
          model_credential_id UUID,
          interval_seconds INTEGER NOT NULL,
          cadence_json JSONB,
          enabled BOOLEAN NOT NULL DEFAULT TRUE,
          next_run_at TIMESTAMPTZ NOT NULL,
          created_at TIMESTAMPTZ NOT NULL,
          claimed_until TIMESTAMPTZ,
          failure_count INTEGER NOT NULL DEFAULT 0,
          last_run_at TIMESTAMPTZ,
          last_error TEXT,
          last_run_status TEXT,
          dead_lettered_at TIMESTAMPTZ
        );
        ALTER TABLE schedules ADD COLUMN IF NOT EXISTS failure_count INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE schedules ADD COLUMN IF NOT EXISTS model_credential_id UUID;
        ALTER TABLE schedules ADD COLUMN IF NOT EXISTS cadence_json JSONB;
        ALTER TABLE schedules ADD COLUMN IF NOT EXISTS last_run_at TIMESTAMPTZ;
        ALTER TABLE schedules ADD COLUMN IF NOT EXISTS last_error TEXT;
        ALTER TABLE schedules ADD COLUMN IF NOT EXISTS last_run_status TEXT;
        ALTER TABLE schedules ADD COLUMN IF NOT EXISTS dead_lettered_at TIMESTAMPTZ;
        CREATE INDEX IF NOT EXISTS idx_schedules_due ON schedules(enabled, next_run_at);
      `).then(() => undefined);
    }
    return this.initialized;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), 1_000);
    this.timer.unref();
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.pool.end();
  }

  async upsert(input: ScheduledTriggerInput) {
    await this.ready();
    const item = createTrigger(input);
    const result = await this.pool.query(`
      INSERT INTO schedules (id, tenant_id, user_id, session_id, title, input, mode, model_credential_id, interval_seconds, cadence_json, enabled, next_run_at, created_at, claimed_until, failure_count, last_run_at, last_error, last_run_status, dead_lettered_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,NULL,0,NULL,NULL,NULL,NULL)
      ON CONFLICT (id) DO UPDATE SET tenant_id=EXCLUDED.tenant_id, user_id=EXCLUDED.user_id, session_id=EXCLUDED.session_id,
        title=EXCLUDED.title, input=EXCLUDED.input, mode=EXCLUDED.mode, model_credential_id=EXCLUDED.model_credential_id, interval_seconds=EXCLUDED.interval_seconds,
        cadence_json=EXCLUDED.cadence_json, enabled=EXCLUDED.enabled, next_run_at=EXCLUDED.next_run_at,
        failure_count=0, last_run_at=NULL, last_error=NULL, last_run_status=NULL, dead_lettered_at=NULL, claimed_until=NULL
      RETURNING *
    `, [item.id, item.tenantId, item.userId, item.sessionId, item.title, item.input, item.mode, item.modelCredentialId ?? null, item.intervalSeconds, JSON.stringify(item.cadence), item.enabled, item.nextRunAt, item.createdAt]);
    return triggerFromRow(result.rows[0]);
  }

  async list(tenantId: string) {
    await this.ready();
    const result = await this.pool.query('SELECT * FROM schedules WHERE tenant_id = $1 ORDER BY next_run_at ASC', [tenantId]);
    return result.rows.map(triggerFromRow);
  }

  async get(id: string, tenantId: string) {
    await this.ready();
    const result = await this.pool.query('SELECT * FROM schedules WHERE id = $1 AND tenant_id = $2', [id, tenantId]);
    return result.rows[0] ? triggerFromRow(result.rows[0]) : null;
  }

  async remove(id: string, tenantId: string) {
    await this.ready();
    const result = await this.pool.query('DELETE FROM schedules WHERE id = $1 AND tenant_id = $2', [id, tenantId]);
    return (result.rowCount ?? 0) > 0;
  }

  async resume(id: string, tenantId: string) {
    await this.ready();
    const existing = await this.get(id, tenantId);
    if (!existing) return null;
    const resumed = resumedTrigger(existing);
    const result = await this.pool.query(`
      UPDATE schedules
      SET enabled = TRUE, failure_count = 0, last_error = NULL, last_run_status = NULL, dead_lettered_at = NULL,
          next_run_at = $3, claimed_until = NULL
      WHERE id = $1 AND tenant_id = $2
      RETURNING *
    `, [id, tenantId, resumed.nextRunAt]);
    return result.rows[0] ? triggerFromRow(result.rows[0]) : null;
  }

  private async transaction<T>(callback: (client: PoolClient) => Promise<T>) {
    const client = await this.pool.connect();
    try { await client.query('BEGIN'); const value = await callback(client); await client.query('COMMIT'); return value; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  private async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.ready();
      const due = await this.transaction(async (client) => {
        const selected = await client.query(`
          SELECT * FROM schedules
          WHERE enabled = TRUE AND next_run_at <= NOW() AND (claimed_until IS NULL OR claimed_until < NOW())
          ORDER BY next_run_at ASC FOR UPDATE SKIP LOCKED LIMIT 8
        `);
        const items = selected.rows.map(triggerFromRow);
        for (const item of items) {
          await client.query('UPDATE schedules SET claimed_until = NOW() + INTERVAL \'5 minutes\' WHERE id = $1', [item.id]);
        }
        return items;
      });
      await Promise.all(due.map((item) => this.execute(item)));
    } catch {
      // The next tick retries after a database/network interruption.
    } finally {
      this.ticking = false;
    }
  }

  private async execute(item: ScheduledTrigger) {
    try {
      await this.handler({ ...item });
      const updated = markSuccess(item);
      await this.pool.query(`
        UPDATE schedules
        SET enabled = $2, next_run_at = $3, claimed_until = NULL, failure_count = 0,
            last_run_at = $4, last_error = NULL, last_run_status = 'success', dead_lettered_at = NULL
        WHERE id = $1
      `, [item.id, updated.enabled, updated.nextRunAt, updated.lastRunAt]);
    } catch (error) {
      const updated = markFailure(item, error);
      await this.pool.query(`
        UPDATE schedules
        SET enabled = $2, next_run_at = $3, claimed_until = NULL, failure_count = $4,
            last_error = $5, last_run_status = $6, dead_lettered_at = $7, last_run_at = $8
        WHERE id = $1
      `, [item.id, updated.enabled, updated.nextRunAt, updated.failureCount, updated.lastError ?? null, updated.lastRunStatus ?? null, updated.deadLetteredAt ?? null, updated.lastRunAt ?? null]);
    }
  }
}
