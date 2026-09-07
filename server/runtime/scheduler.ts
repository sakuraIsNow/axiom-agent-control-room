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
  providerBindingId?: string;
  inputArtifact?: ScheduleArtifactInput;
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
  revision?: number;
};

export type ScheduleArtifactInput = {
  artifactId: string;
  sourceTaskId: string;
  sourceScheduleId?: string;
  sourceTaskRevision: number;
  sourceTaskUpdatedAt: string;
  contentSha256: string;
  title: string;
};

export type ScheduledRunStatus = 'success' | 'failed' | 'dead-letter';

export type ScheduleHealthActionType = 'pause' | 'resume' | 'reschedule';

export type ScheduleHealthState = {
  enabled: boolean;
  cadence: ScheduleCadence;
  nextRunAt: string;
  failureCount: number;
  lastRunStatus?: ScheduledRunStatus;
  deadLetteredAt?: string;
};

export type ScheduleHealthActionAudit = {
  id: string;
  tenantId: string;
  userId: string;
  scheduleId: string;
  suggestionId: string;
  kind: 'failure_streak' | 'cost_spike' | 'quality_decline' | 'capacity_conflict';
  action: ScheduleHealthActionType;
  reason: string;
  evidence: string[];
  proposedCadence?: ScheduleCadence;
  before: ScheduleHealthState;
  after: ScheduleHealthState;
  confirmedBy: string;
  confirmedAt: string;
};

export type ScheduleHealthActionInput = Pick<ScheduleHealthActionAudit, 'tenantId' | 'userId' | 'scheduleId' | 'suggestionId' | 'kind' | 'action' | 'reason' | 'evidence' | 'proposedCadence' | 'confirmedBy'> & {
  expected: ScheduleHealthState;
};

export class ScheduleHealthActionConflictError extends Error {
  constructor(message = 'Schedule health suggestion is stale or already applied.') {
    super(message);
    this.name = 'ScheduleHealthActionConflictError';
  }
}

export type ScheduledTriggerInput = Pick<ScheduledTrigger, 'tenantId' | 'userId' | 'sessionId' | 'title' | 'input' | 'mode' | 'modelCredentialId' | 'providerBindingId' | 'inputArtifact' | 'enabled'> & {
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
  pause(id: string, tenantId: string): Promise<ScheduledTrigger | null>;
  reschedule(id: string, tenantId: string, cadence: ScheduleCadence): Promise<ScheduledTrigger | null>;
  resume(id: string, tenantId: string): Promise<ScheduledTrigger | null>;
  applyHealthAction(input: ScheduleHealthActionInput): Promise<{ schedule: ScheduledTrigger; audit: ScheduleHealthActionAudit } | null>;
  listHealthActions(tenantId: string, userId: string, limit?: number): Promise<ScheduleHealthActionAudit[]>;
}

export const MAX_SCHEDULE_FAILURES = 5;
const MAX_ERROR_LENGTH = 2_000;
const MAX_BACKOFF_SECONDS = 7 * 24 * 60 * 60;
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, MAX_ERROR_LENGTH);
const backoffSeconds = (intervalSeconds: number, failureCount: number) => Math.min(MAX_BACKOFF_SECONDS, intervalSeconds * (2 ** Math.max(1, failureCount)));
const afterSeconds = (seconds: number, now = new Date()) => new Date(now.getTime() + seconds * 1_000).toISOString();
const parseScheduleArtifactInput = (value: unknown): ScheduleArtifactInput | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  if (
    typeof source.artifactId !== 'string' || !source.artifactId.trim()
    || typeof source.sourceTaskId !== 'string' || !source.sourceTaskId.trim()
    || typeof source.sourceTaskRevision !== 'number' || !Number.isSafeInteger(source.sourceTaskRevision) || source.sourceTaskRevision < 0
    || typeof source.sourceTaskUpdatedAt !== 'string' || !Number.isFinite(Date.parse(source.sourceTaskUpdatedAt))
    || typeof source.contentSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(source.contentSha256)
    || typeof source.title !== 'string' || !source.title.trim()
  ) return undefined;
  return {
    artifactId: source.artifactId.slice(0, 512),
    sourceTaskId: source.sourceTaskId.slice(0, 160),
    ...(typeof source.sourceScheduleId === 'string' && source.sourceScheduleId.trim() ? { sourceScheduleId: source.sourceScheduleId.slice(0, 160) } : {}),
    sourceTaskRevision: source.sourceTaskRevision,
    sourceTaskUpdatedAt: new Date(source.sourceTaskUpdatedAt).toISOString(),
    contentSha256: source.contentSha256,
    title: source.title.slice(0, 160),
  };
};
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
    revision: 1,
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
    revision: (item.revision ?? 0) + 1,
  };
};
const markFailure = (item: ScheduledTrigger, error: unknown): ScheduledTrigger => {
  const failureCount = item.failureCount + 1;
  const deadLettered = failureCount >= MAX_SCHEDULE_FAILURES;
  const now = new Date();
  return { ...item, failureCount, lastError: errorText(error), lastRunStatus: deadLettered ? 'dead-letter' : 'failed', lastRunAt: now.toISOString(), deadLetteredAt: deadLettered ? now.toISOString() : undefined, enabled: deadLettered ? false : item.enabled, nextRunAt: deadLettered ? now.toISOString() : afterSeconds(backoffSeconds(item.intervalSeconds, failureCount), now), revision: (item.revision ?? 0) + 1 };
};

const resumedTrigger = (item: ScheduledTrigger) => {
  const now = new Date();
  // A failed one-time schedule is intentionally run once after manual recovery,
  // even when its original wall-clock deadline has passed.
  const nextRunAt = nextRunAtForCadence(item.cadence, now) ?? afterSeconds(1, now);
  return { ...item, enabled: true, failureCount: 0, lastError: undefined, lastRunStatus: undefined, deadLetteredAt: undefined, nextRunAt, revision: (item.revision ?? 0) + 1 } satisfies ScheduledTrigger;
};

const rescheduledTrigger = (item: ScheduledTrigger, cadence: ScheduleCadence) => {
  const normalized = scheduleCadenceSchema.parse(cadence);
  const nextRunAt = nextRunAtForCadence(normalized, new Date());
  if (!nextRunAt) throw new Error('A one-time schedule must be set in the future.');
  return {
    ...item,
    cadence: normalized,
    intervalSeconds: cadenceIntervalSeconds(normalized),
    nextRunAt,
    revision: (item.revision ?? 0) + 1,
  } satisfies ScheduledTrigger;
};

export const scheduleHealthState = (item: ScheduledTrigger): ScheduleHealthState => ({
  enabled: item.enabled,
  cadence: item.cadence,
  nextRunAt: item.nextRunAt,
  failureCount: item.failureCount,
  ...(item.lastRunStatus ? { lastRunStatus: item.lastRunStatus } : {}),
  ...(item.deadLetteredAt ? { deadLetteredAt: item.deadLetteredAt } : {}),
});

const sameHealthState = (left: ScheduleHealthState, right: ScheduleHealthState) => JSON.stringify(left) === JSON.stringify(right);

const triggerAfterHealthAction = (item: ScheduledTrigger, input: ScheduleHealthActionInput) => {
  if (input.action === 'pause') return { ...item, enabled: false, revision: (item.revision ?? 0) + 1 } satisfies ScheduledTrigger;
  if (input.action === 'resume') return resumedTrigger(item);
  if (!input.proposedCadence) throw new Error('A reschedule action requires a proposed cadence.');
  return rescheduledTrigger(item, input.proposedCadence);
};

const healthActionAudit = (input: ScheduleHealthActionInput, before: ScheduleHealthState, after: ScheduleHealthState): ScheduleHealthActionAudit => ({
  id: randomUUID(),
  tenantId: input.tenantId,
  userId: input.userId,
  scheduleId: input.scheduleId,
  suggestionId: input.suggestionId,
  kind: input.kind,
  action: input.action,
  reason: input.reason.slice(0, 2_000),
  evidence: input.evidence.slice(0, 20).map((item) => item.slice(0, 1_000)),
  ...(input.proposedCadence ? { proposedCadence: scheduleCadenceSchema.parse(input.proposedCadence) } : {}),
  before,
  after,
  confirmedBy: input.confirmedBy,
  confirmedAt: new Date().toISOString(),
});

export class InMemoryScheduler implements Scheduler {
  private readonly items = new Map<string, ScheduledTrigger>();
  private readonly healthActions: ScheduleHealthActionAudit[] = [];
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
    item.revision = (this.items.get(item.id)?.revision ?? 0) + 1;
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

  async pause(id: string, tenantId: string) {
    const item = this.items.get(id);
    if (!item || item.tenantId !== tenantId) return null;
    const paused = { ...item, enabled: false, revision: (item.revision ?? 0) + 1 };
    this.items.set(id, paused);
    return paused;
  }

  async reschedule(id: string, tenantId: string, cadence: ScheduleCadence) {
    const item = this.items.get(id);
    if (!item || item.tenantId !== tenantId) return null;
    const rescheduled = rescheduledTrigger(item, cadence);
    this.items.set(id, rescheduled);
    return rescheduled;
  }

  async resume(id: string, tenantId: string) {
    const item = this.items.get(id);
    if (!item || item.tenantId !== tenantId) return null;
    const resumed = resumedTrigger(item);
    this.items.set(id, resumed);
    return resumed;
  }

  async applyHealthAction(input: ScheduleHealthActionInput) {
    const item = this.items.get(input.scheduleId);
    if (!item || item.tenantId !== input.tenantId || item.userId !== input.userId) return null;
    if (this.healthActions.some((audit) => audit.tenantId === input.tenantId && audit.scheduleId === input.scheduleId && audit.suggestionId === input.suggestionId)) {
      throw new ScheduleHealthActionConflictError();
    }
    const before = scheduleHealthState(item);
    if (!sameHealthState(before, input.expected)) throw new ScheduleHealthActionConflictError();
    const schedule = triggerAfterHealthAction(item, input);
    const audit = healthActionAudit(input, before, scheduleHealthState(schedule));
    this.items.set(schedule.id, schedule);
    this.healthActions.push(audit);
    return { schedule: { ...schedule }, audit: structuredClone(audit) };
  }

  async listHealthActions(tenantId: string, userId: string, limit = 20) {
    const safeLimit = Math.min(100, Math.max(1, Math.floor(limit)));
    return this.healthActions
      .filter((audit) => audit.tenantId === tenantId && audit.userId === userId)
      .sort((left, right) => Date.parse(right.confirmedAt) - Date.parse(left.confirmedAt))
      .slice(0, safeLimit)
      .map((audit) => structuredClone(audit));
  }

  private async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
    const now = Date.now();
    for (const item of [...this.items.values()]) {
      if (!item.enabled || Date.parse(item.nextRunAt) > now || this.items.get(item.id) !== item) continue;
      try {
        await this.handler({ ...item });
        const current = this.items.get(item.id);
        if (current === item) this.items.set(item.id, markSuccess(current));
      } catch (error) {
        const current = this.items.get(item.id);
        if (current === item) this.items.set(item.id, markFailure(current, error));
      }
    }
    } finally {
      this.ticking = false;
    }
  }
}

const triggerFromRow = (row: {
  id: string; tenant_id: string; user_id: string; session_id: string; title: string; input: string; model_credential_id?: string | null; provider_binding_id?: string | null;
  mode: ScheduledTrigger['mode']; interval_seconds: number; enabled: boolean; next_run_at: Date | string; created_at: Date | string;
  cadence_json?: unknown; last_run_at?: Date | string | null; failure_count?: number | string; last_error?: string | null;
  last_run_status?: ScheduledRunStatus | null; dead_lettered_at?: Date | string | null; input_artifact_json?: unknown;
  revision?: number | string;
}): ScheduledTrigger => {
  let rawCadence = row.cadence_json;
  if (typeof rawCadence === 'string') {
    try { rawCadence = JSON.parse(rawCadence); } catch { rawCadence = undefined; }
  }
  const parsedCadence = scheduleCadenceSchema.safeParse(rawCadence);
  const cadence = parsedCadence.success ? parsedCadence.data : legacyIntervalCadence(Number(row.interval_seconds));
  let rawInputArtifact = row.input_artifact_json;
  if (typeof rawInputArtifact === 'string') {
    try { rawInputArtifact = JSON.parse(rawInputArtifact); } catch { rawInputArtifact = undefined; }
  }
  const inputArtifact = parseScheduleArtifactInput(rawInputArtifact);
  return ({
  id: row.id,
  tenantId: row.tenant_id,
  userId: row.user_id,
  sessionId: row.session_id,
  title: row.title,
  input: row.input,
  mode: row.mode,
  modelCredentialId: row.model_credential_id ?? undefined,
  providerBindingId: row.provider_binding_id ?? undefined,
  ...(inputArtifact ? { inputArtifact } : {}),
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
  revision: Number(row.revision ?? 1),
  });
};

const healthActionFromRow = (row: {
  id: string; tenant_id: string; user_id: string; schedule_id: string; suggestion_id: string;
  kind: ScheduleHealthActionAudit['kind']; action: ScheduleHealthActionType; reason: string; evidence_json: unknown;
  proposed_cadence_json?: unknown; before_json: ScheduleHealthState | string; after_json: ScheduleHealthState | string;
  confirmed_by: string; confirmed_at: Date | string;
}): ScheduleHealthActionAudit => {
  const parseJson = <T>(value: T | string): T => typeof value === 'string' ? JSON.parse(value) as T : value;
  const proposedCadence = row.proposed_cadence_json
    ? scheduleCadenceSchema.parse(parseJson(row.proposed_cadence_json))
    : undefined;
  const evidence = parseJson<unknown>(row.evidence_json as string);
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    scheduleId: row.schedule_id,
    suggestionId: row.suggestion_id,
    kind: row.kind,
    action: row.action,
    reason: row.reason,
    evidence: Array.isArray(evidence) ? evidence.filter((item): item is string => typeof item === 'string') : [],
    ...(proposedCadence ? { proposedCadence } : {}),
    before: parseJson(row.before_json),
    after: parseJson(row.after_json),
    confirmedBy: row.confirmed_by,
    confirmedAt: row.confirmed_at instanceof Date ? row.confirmed_at.toISOString() : row.confirmed_at,
  };
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
      this.initialized = this.transaction(async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext('axiom:scheduler:schema'))");
        await client.query(`
        CREATE TABLE IF NOT EXISTS schedules (
          id UUID PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          session_id TEXT NOT NULL,
          title TEXT NOT NULL,
          input TEXT NOT NULL,
          mode TEXT NOT NULL,
          model_credential_id UUID,
          input_artifact_json JSONB,
          interval_seconds INTEGER NOT NULL,
          cadence_json JSONB,
          enabled BOOLEAN NOT NULL DEFAULT TRUE,
          next_run_at TIMESTAMPTZ NOT NULL,
          created_at TIMESTAMPTZ NOT NULL,
          claimed_until TIMESTAMPTZ,
          claim_token TEXT,
          revision BIGINT NOT NULL DEFAULT 1,
          failure_count INTEGER NOT NULL DEFAULT 0,
          last_run_at TIMESTAMPTZ,
          last_error TEXT,
          last_run_status TEXT,
          dead_lettered_at TIMESTAMPTZ
        );
        ALTER TABLE schedules ADD COLUMN IF NOT EXISTS failure_count INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE schedules ADD COLUMN IF NOT EXISTS model_credential_id UUID;
        ALTER TABLE schedules ADD COLUMN IF NOT EXISTS provider_binding_id UUID;
        ALTER TABLE schedules ADD COLUMN IF NOT EXISTS input_artifact_json JSONB;
        ALTER TABLE schedules ADD COLUMN IF NOT EXISTS cadence_json JSONB;
        ALTER TABLE schedules ADD COLUMN IF NOT EXISTS last_run_at TIMESTAMPTZ;
        ALTER TABLE schedules ADD COLUMN IF NOT EXISTS last_error TEXT;
        ALTER TABLE schedules ADD COLUMN IF NOT EXISTS last_run_status TEXT;
        ALTER TABLE schedules ADD COLUMN IF NOT EXISTS dead_lettered_at TIMESTAMPTZ;
        ALTER TABLE schedules ADD COLUMN IF NOT EXISTS claim_token TEXT;
        ALTER TABLE schedules ADD COLUMN IF NOT EXISTS revision BIGINT NOT NULL DEFAULT 1;
        CREATE INDEX IF NOT EXISTS idx_schedules_due ON schedules(enabled, next_run_at);
        CREATE TABLE IF NOT EXISTS schedule_health_actions (
          id UUID PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          schedule_id UUID NOT NULL,
          suggestion_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          action TEXT NOT NULL,
          reason TEXT NOT NULL,
          evidence_json JSONB NOT NULL,
          proposed_cadence_json JSONB,
          before_json JSONB NOT NULL,
          after_json JSONB NOT NULL,
          confirmed_by TEXT NOT NULL,
          confirmed_at TIMESTAMPTZ NOT NULL,
          UNIQUE (tenant_id, schedule_id, suggestion_id)
        );
        CREATE INDEX IF NOT EXISTS idx_schedule_health_actions_owner
          ON schedule_health_actions(tenant_id, user_id, confirmed_at DESC);
        `);
      }).catch((error) => { this.initialized = undefined; throw error; });
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
      INSERT INTO schedules (id, tenant_id, user_id, session_id, title, input, mode, model_credential_id, input_artifact_json, interval_seconds, cadence_json, enabled, next_run_at, created_at, provider_binding_id, claimed_until, failure_count, last_run_at, last_error, last_run_status, dead_lettered_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11::jsonb,$12,$13,$14,$15,NULL,0,NULL,NULL,NULL,NULL)
      ON CONFLICT (id) DO UPDATE SET tenant_id=EXCLUDED.tenant_id, user_id=EXCLUDED.user_id, session_id=EXCLUDED.session_id,
        title=EXCLUDED.title, input=EXCLUDED.input, mode=EXCLUDED.mode, model_credential_id=EXCLUDED.model_credential_id, provider_binding_id=EXCLUDED.provider_binding_id, input_artifact_json=EXCLUDED.input_artifact_json, interval_seconds=EXCLUDED.interval_seconds,
        cadence_json=EXCLUDED.cadence_json, enabled=EXCLUDED.enabled, next_run_at=EXCLUDED.next_run_at,
        failure_count=0, last_run_at=NULL, last_error=NULL, last_run_status=NULL, dead_lettered_at=NULL,
        claimed_until=NULL, claim_token=NULL, revision=schedules.revision+1
      RETURNING *
    `, [item.id, item.tenantId, item.userId, item.sessionId, item.title, item.input, item.mode, item.modelCredentialId ?? null, item.inputArtifact ? JSON.stringify(item.inputArtifact) : null, item.intervalSeconds, JSON.stringify(item.cadence), item.enabled, item.nextRunAt, item.createdAt, item.providerBindingId ?? null]);
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

  async pause(id: string, tenantId: string) {
    await this.ready();
    const result = await this.pool.query(`
      UPDATE schedules SET enabled = FALSE, claimed_until = NULL, claim_token = NULL, revision = revision + 1
      WHERE id = $1 AND tenant_id = $2
      RETURNING *
    `, [id, tenantId]);
    return result.rows[0] ? triggerFromRow(result.rows[0]) : null;
  }

  async reschedule(id: string, tenantId: string, cadence: ScheduleCadence) {
    await this.ready();
    const existing = await this.get(id, tenantId);
    if (!existing) return null;
    const updated = rescheduledTrigger(existing, cadence);
    const result = await this.pool.query(`
      UPDATE schedules
      SET cadence_json = $3::jsonb, interval_seconds = $4, next_run_at = $5, claimed_until = NULL, claim_token = NULL, revision = revision + 1
      WHERE id = $1 AND tenant_id = $2
      RETURNING *
    `, [id, tenantId, JSON.stringify(updated.cadence), updated.intervalSeconds, updated.nextRunAt]);
    return result.rows[0] ? triggerFromRow(result.rows[0]) : null;
  }

  async resume(id: string, tenantId: string) {
    await this.ready();
    const existing = await this.get(id, tenantId);
    if (!existing) return null;
    const resumed = resumedTrigger(existing);
    const result = await this.pool.query(`
      UPDATE schedules
      SET enabled = TRUE, failure_count = 0, last_error = NULL, last_run_status = NULL, dead_lettered_at = NULL,
          next_run_at = $3, claimed_until = NULL, claim_token = NULL, revision = revision + 1
      WHERE id = $1 AND tenant_id = $2
      RETURNING *
    `, [id, tenantId, resumed.nextRunAt]);
    return result.rows[0] ? triggerFromRow(result.rows[0]) : null;
  }

  async applyHealthAction(input: ScheduleHealthActionInput) {
    await this.ready();
    return this.transaction(async (client) => {
      const selected = await client.query(
        'SELECT * FROM schedules WHERE id = $1 AND tenant_id = $2 AND user_id = $3 FOR UPDATE',
        [input.scheduleId, input.tenantId, input.userId],
      );
      if (!selected.rows[0]) return null;
      const duplicate = await client.query(
        'SELECT 1 FROM schedule_health_actions WHERE tenant_id = $1 AND schedule_id = $2 AND suggestion_id = $3',
        [input.tenantId, input.scheduleId, input.suggestionId],
      );
      if (duplicate.rows[0]) throw new ScheduleHealthActionConflictError();
      const current = triggerFromRow(selected.rows[0]);
      const before = scheduleHealthState(current);
      if (!sameHealthState(before, input.expected)) throw new ScheduleHealthActionConflictError();
      const schedule = triggerAfterHealthAction(current, input);
      await client.query(`
        UPDATE schedules
        SET enabled = $4, cadence_json = $5::jsonb, interval_seconds = $6, next_run_at = $7,
            failure_count = $8, last_error = $9, last_run_status = $10, dead_lettered_at = $11,
            claimed_until = NULL, claim_token = NULL, revision = revision + 1
        WHERE id = $1 AND tenant_id = $2 AND user_id = $3
      `, [schedule.id, schedule.tenantId, schedule.userId, schedule.enabled, JSON.stringify(schedule.cadence), schedule.intervalSeconds, schedule.nextRunAt, schedule.failureCount, schedule.lastError ?? null, schedule.lastRunStatus ?? null, schedule.deadLetteredAt ?? null]);
      const audit = healthActionAudit(input, before, scheduleHealthState(schedule));
      try {
        await client.query(`
          INSERT INTO schedule_health_actions
            (id, tenant_id, user_id, schedule_id, suggestion_id, kind, action, reason, evidence_json,
             proposed_cadence_json, before_json, after_json, confirmed_by, confirmed_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12::jsonb,$13,$14)
        `, [audit.id, audit.tenantId, audit.userId, audit.scheduleId, audit.suggestionId, audit.kind, audit.action, audit.reason, JSON.stringify(audit.evidence), audit.proposedCadence ? JSON.stringify(audit.proposedCadence) : null, JSON.stringify(audit.before), JSON.stringify(audit.after), audit.confirmedBy, audit.confirmedAt]);
      } catch (error) {
        if ((error as { code?: string }).code === '23505') throw new ScheduleHealthActionConflictError();
        throw error;
      }
      return { schedule, audit };
    });
  }

  async listHealthActions(tenantId: string, userId: string, limit = 20) {
    await this.ready();
    const safeLimit = Math.min(100, Math.max(1, Math.floor(limit)));
    const result = await this.pool.query(`
      SELECT * FROM schedule_health_actions
      WHERE tenant_id = $1 AND user_id = $2
      ORDER BY confirmed_at DESC
      LIMIT $3
    `, [tenantId, userId, safeLimit]);
    return result.rows.map(healthActionFromRow);
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
        const items = selected.rows.map((row) => ({ trigger: triggerFromRow(row), token: randomUUID() }));
        for (const { trigger, token } of items) {
          await client.query(`UPDATE schedules SET claimed_until = NOW() + INTERVAL '5 minutes', claim_token = $2 WHERE id = $1`, [trigger.id, token]);
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

  private async execute({ trigger: item, token }: { trigger: ScheduledTrigger; token: string }) {
    const active = await this.pool.query(`SELECT 1 FROM schedules WHERE id = $1 AND revision = $2 AND claim_token = $3
      AND enabled = TRUE AND claimed_until > clock_timestamp()`, [item.id, item.revision, token]);
    if (!active.rowCount) return;
    try {
      await this.handler({ ...item });
      const updated = markSuccess(item);
      await this.pool.query(`
        UPDATE schedules
        SET enabled = $2, next_run_at = $3, claimed_until = NULL, claim_token = NULL, revision = revision + 1, failure_count = 0,
            last_run_at = $4, last_error = NULL, last_run_status = 'success', dead_lettered_at = NULL
        WHERE id = $1 AND revision = $5 AND claim_token = $6 AND claimed_until > clock_timestamp()
      `, [item.id, updated.enabled, updated.nextRunAt, updated.lastRunAt, item.revision, token]);
    } catch (error) {
      const updated = markFailure(item, error);
      await this.pool.query(`
        UPDATE schedules
        SET enabled = $2, next_run_at = $3, claimed_until = NULL, claim_token = NULL, revision = revision + 1, failure_count = $4,
            last_error = $5, last_run_status = $6, dead_lettered_at = $7, last_run_at = $8
        WHERE id = $1 AND revision = $9 AND claim_token = $10 AND claimed_until > clock_timestamp()
      `, [item.id, updated.enabled, updated.nextRunAt, updated.failureCount, updated.lastError ?? null, updated.lastRunStatus ?? null, updated.deadLetteredAt ?? null, updated.lastRunAt ?? null, item.revision, token]);
    }
  }
}
