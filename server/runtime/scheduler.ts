import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';

export type ScheduledTrigger = {
  id: string;
  tenantId: string;
  userId: string;
  sessionId: string;
  title: string;
  input: string;
  mode: 'analyze' | 'build' | 'decide';
  intervalSeconds: number;
  enabled: boolean;
  nextRunAt: string;
  createdAt: string;
  failureCount: number;
  lastError?: string;
  lastRunStatus?: ScheduledRunStatus;
  deadLetteredAt?: string;
};

export type ScheduledRunStatus = 'success' | 'failed' | 'dead-letter';

export type ScheduledTriggerInput = Omit<ScheduledTrigger, 'id' | 'nextRunAt' | 'createdAt' | 'failureCount' | 'lastError' | 'lastRunStatus' | 'deadLetteredAt'> & {
  id?: string;
  nextRunAt?: string;
  createdAt?: string;
};

export interface Scheduler {
  ready(): Promise<void>;
  start(): void;
  stop(): Promise<void> | void;
  upsert(input: ScheduledTriggerInput): Promise<ScheduledTrigger>;
  list(tenantId: string): Promise<ScheduledTrigger[]>;
  remove(id: string, tenantId: string): Promise<boolean>;
  resume(id: string, tenantId: string): Promise<ScheduledTrigger | null>;
}

export const MAX_SCHEDULE_FAILURES = 5;
const MAX_ERROR_LENGTH = 2_000;
const MAX_BACKOFF_SECONDS = 7 * 24 * 60 * 60;
const normalizedInterval = (value: number) => Math.max(15, Math.min(86_400, Math.floor(value)));
const nextRun = (seconds: number) => new Date(Date.now() + seconds * 1_000).toISOString();
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, MAX_ERROR_LENGTH);
const backoffSeconds = (intervalSeconds: number, failureCount: number) => Math.min(MAX_BACKOFF_SECONDS, intervalSeconds * (2 ** Math.max(1, failureCount)));
const markSuccess = (item: ScheduledTrigger): ScheduledTrigger => ({ ...item, failureCount: 0, lastError: undefined, lastRunStatus: 'success', deadLetteredAt: undefined, nextRunAt: nextRun(item.intervalSeconds) });
const markFailure = (item: ScheduledTrigger, error: unknown): ScheduledTrigger => {
  const failureCount = item.failureCount + 1;
  const deadLettered = failureCount >= MAX_SCHEDULE_FAILURES;
  return { ...item, failureCount, lastError: errorText(error), lastRunStatus: deadLettered ? 'dead-letter' : 'failed', deadLetteredAt: deadLettered ? new Date().toISOString() : undefined, enabled: deadLettered ? false : item.enabled, nextRunAt: deadLettered ? new Date().toISOString() : nextRun(backoffSeconds(item.intervalSeconds, failureCount)) };
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
    const now = new Date();
    const intervalSeconds = normalizedInterval(input.intervalSeconds);
    const item: ScheduledTrigger = {
      ...input,
      id: input.id ?? randomUUID(),
      intervalSeconds,
      nextRunAt: input.nextRunAt ?? new Date(now.getTime() + intervalSeconds * 1_000).toISOString(),
      createdAt: input.createdAt ?? now.toISOString(),
      failureCount: 0,
      lastError: undefined,
      lastRunStatus: undefined,
      deadLetteredAt: undefined,
    };
    this.items.set(item.id, item);
    return item;
  }

  async list(tenantId: string) {
    return [...this.items.values()].filter((item) => item.tenantId === tenantId);
  }

  async remove(id: string, tenantId: string) {
    const item = this.items.get(id);
    if (!item || item.tenantId !== tenantId) return false;
    return this.items.delete(id);
  }

  async resume(id: string, tenantId: string) {
    const item = this.items.get(id);
    if (!item || item.tenantId !== tenantId) return null;
    const resumed: ScheduledTrigger = { ...item, enabled: true, failureCount: 0, lastError: undefined, lastRunStatus: undefined, deadLetteredAt: undefined, nextRunAt: nextRun(item.intervalSeconds) };
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
  id: string; tenant_id: string; user_id: string; session_id: string; title: string; input: string;
  mode: ScheduledTrigger['mode']; interval_seconds: number; enabled: boolean; next_run_at: Date | string; created_at: Date | string;
  failure_count?: number | string; last_error?: string | null; last_run_status?: ScheduledRunStatus | null; dead_lettered_at?: Date | string | null;
}): ScheduledTrigger => ({
  id: row.id,
  tenantId: row.tenant_id,
  userId: row.user_id,
  sessionId: row.session_id,
  title: row.title,
  input: row.input,
  mode: row.mode,
  intervalSeconds: Number(row.interval_seconds),
  enabled: row.enabled,
  nextRunAt: row.next_run_at instanceof Date ? row.next_run_at.toISOString() : row.next_run_at,
  createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  failureCount: Number(row.failure_count ?? 0),
  lastError: row.last_error ?? undefined,
  lastRunStatus: row.last_run_status ?? undefined,
  deadLetteredAt: row.dead_lettered_at instanceof Date ? row.dead_lettered_at.toISOString() : row.dead_lettered_at ?? undefined,
});

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
          interval_seconds INTEGER NOT NULL,
          enabled BOOLEAN NOT NULL DEFAULT TRUE,
          next_run_at TIMESTAMPTZ NOT NULL,
          created_at TIMESTAMPTZ NOT NULL,
          claimed_until TIMESTAMPTZ,
          failure_count INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          last_run_status TEXT,
          dead_lettered_at TIMESTAMPTZ
        );
        ALTER TABLE schedules ADD COLUMN IF NOT EXISTS failure_count INTEGER NOT NULL DEFAULT 0;
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
    const now = new Date();
    const intervalSeconds = normalizedInterval(input.intervalSeconds);
    const item: ScheduledTrigger = {
      ...input,
      id: input.id ?? randomUUID(),
      intervalSeconds,
      nextRunAt: input.nextRunAt ?? new Date(now.getTime() + intervalSeconds * 1_000).toISOString(),
      createdAt: input.createdAt ?? now.toISOString(),
      failureCount: 0,
      lastError: undefined,
      lastRunStatus: undefined,
      deadLetteredAt: undefined,
    };
    const result = await this.pool.query(`
      INSERT INTO schedules (id, tenant_id, user_id, session_id, title, input, mode, interval_seconds, enabled, next_run_at, created_at, claimed_until, failure_count, last_error, last_run_status, dead_lettered_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NULL,0,NULL,NULL,NULL)
      ON CONFLICT (id) DO UPDATE SET tenant_id=EXCLUDED.tenant_id, user_id=EXCLUDED.user_id, session_id=EXCLUDED.session_id,
        title=EXCLUDED.title, input=EXCLUDED.input, mode=EXCLUDED.mode, interval_seconds=EXCLUDED.interval_seconds,
        enabled=EXCLUDED.enabled, next_run_at=EXCLUDED.next_run_at, failure_count=0, last_error=NULL, last_run_status=NULL, dead_lettered_at=NULL, claimed_until=NULL
      RETURNING *
    `, [item.id, item.tenantId, item.userId, item.sessionId, item.title, item.input, item.mode, item.intervalSeconds, item.enabled, item.nextRunAt, item.createdAt]);
    return triggerFromRow(result.rows[0]);
  }

  async list(tenantId: string) {
    await this.ready();
    const result = await this.pool.query('SELECT * FROM schedules WHERE tenant_id = $1 ORDER BY next_run_at ASC', [tenantId]);
    return result.rows.map(triggerFromRow);
  }

  async remove(id: string, tenantId: string) {
    await this.ready();
    const result = await this.pool.query('DELETE FROM schedules WHERE id = $1 AND tenant_id = $2', [id, tenantId]);
    return (result.rowCount ?? 0) > 0;
  }

  async resume(id: string, tenantId: string) {
    await this.ready();
    const result = await this.pool.query(`
      UPDATE schedules
      SET enabled = TRUE, failure_count = 0, last_error = NULL, last_run_status = NULL, dead_lettered_at = NULL,
          next_run_at = NOW() + (interval_seconds * INTERVAL '1 second'), claimed_until = NULL
      WHERE id = $1 AND tenant_id = $2
      RETURNING *
    `, [id, tenantId]);
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
      await this.pool.query(`
        UPDATE schedules
        SET next_run_at = NOW() + (interval_seconds * INTERVAL '1 second'), claimed_until = NULL,
            failure_count = 0, last_error = NULL, last_run_status = 'success', dead_lettered_at = NULL
        WHERE id = $1
      `, [item.id]);
    } catch (error) {
      const updated = markFailure(item, error);
      await this.pool.query(`
        UPDATE schedules
        SET enabled = $2, next_run_at = $3, claimed_until = NULL, failure_count = $4,
            last_error = $5, last_run_status = $6, dead_lettered_at = $7
        WHERE id = $1
      `, [item.id, updated.enabled, updated.nextRunAt, updated.failureCount, updated.lastError ?? null, updated.lastRunStatus ?? null, updated.deadLetteredAt ?? null]);
    }
  }
}
