import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Pool } from 'pg';

export type ToolHealthStatus = 'healthy' | 'degraded' | 'open' | 'half-open';
export type HighRiskPolicy = 'approval' | 'deny';

export type TenantGovernancePolicy = {
  tenantId: string;
  revision: number;
  maxToolSources: number;
  toolCallsPerHour: number;
  concurrentToolCalls: number;
  schemaTokenBudget: number;
  monthlyTokenBudget: number;
  monthlyToolCallBudget: number;
  highRiskPolicy: HighRiskPolicy;
  updatedAt: string;
};

export type ToolUsageSnapshot = {
  tenantId: string;
  windowStart: string;
  hourCalls: number;
  activeCalls: number;
  monthStart: string;
  monthCalls: number;
  updatedAt: string;
};

export type ToolHealthSnapshot = {
  tenantId: string;
  sourceId: string;
  status: ToolHealthStatus;
  generation?: number;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  totalCalls: number;
  totalFailures: number;
  lastLatencyMs?: number;
  lastError?: string;
  lastCheckedAt?: string;
  openedAt?: string;
  nextProbeAt?: string;
  updatedAt: string;
};

export type GovernanceSnapshot = {
  policy: TenantGovernancePolicy;
  usage: ToolUsageSnapshot;
  tools: ToolHealthSnapshot[];
  generatedAt: string;
};

export type GovernanceMetric = {
  tenantId: string;
  day: string;
  name: string;
  dimensions: Record<string, string>;
  value: number;
  updatedAt: string;
};

export type GovernanceMetricInput = Omit<GovernanceMetric, 'updatedAt'>;

export type ReserveResult = {
  reservationId: string;
  expiresAt: string;
  policy: TenantGovernancePolicy;
  usage: ToolUsageSnapshot;
  health: ToolHealthSnapshot;
};

export class GovernanceQuotaError extends Error {
  readonly code = 'GOVERNANCE_QUOTA_EXCEEDED';
  constructor(readonly reason: 'hourly-tool-calls' | 'concurrent-tool-calls' | 'monthly-tool-calls' | 'deny-open-circuit') {
    super(reason);
    this.name = 'GovernanceQuotaError';
  }
}

export class GovernanceToolUnavailableError extends Error {
  readonly code = 'GOVERNANCE_TOOL_UNAVAILABLE';
  constructor(readonly reason: 'circuit-open' | 'not-half-open') {
    super(reason);
    this.name = 'GovernanceToolUnavailableError';
  }
}

const nowIso = () => new Date().toISOString();
const startOfHour = (date = new Date()) => {
  const copy = new Date(date);
  copy.setUTCMinutes(0, 0, 0);
  return copy.toISOString();
};
const startOfMonth = (date = new Date()) => {
  const copy = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  return copy.toISOString();
};
const envInt = (name: string, fallback: number, min: number, max: number) => {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.floor(value))) : fallback;
};
const callLeaseMs = () => envInt('AXIOM_TOOL_CALL_LEASE_MS', 120_000, 30_000, 600_000);
const healthAfterOutcome = (current: ToolHealthSnapshot, ok: boolean) => {
  const failures = ok ? 0 : current.consecutiveFailures + 1;
  let successes = ok ? current.consecutiveSuccesses + 1 : 0;
  const threshold = envInt('AXIOM_TOOL_CIRCUIT_FAILURE_THRESHOLD', 3, 1, 100);
  const recovery = envInt('AXIOM_TOOL_CIRCUIT_RECOVERY_THRESHOLD', 2, 1, 100);
  const cooldown = envInt('AXIOM_TOOL_CIRCUIT_COOLDOWN_MS', 30_000, 1_000, 3_600_000);
  let status = current.status;
  if (ok && (current.status === 'half-open' ? successes >= recovery : current.status !== 'open')) status = 'healthy';
  if (!ok) status = current.status === 'half-open' || current.status === 'open' || failures >= threshold ? 'open' : 'degraded';
  if (status === 'open') successes = 0;
  const generation = (current.generation ?? 0) + (status === 'open' && current.status !== 'open' ? 1 : 0);
  return { failures, successes, status, generation, openedAt: status === 'open' ? current.openedAt ?? nowIso() : null,
    nextProbeAt: status === 'open' ? new Date(Date.now() + cooldown).toISOString() : null };
};
const defaults = (tenantId: string): TenantGovernancePolicy => ({
  tenantId,
  revision: 1,
  maxToolSources: envInt('AXIOM_TENANT_MAX_TOOL_SOURCES', 40, 1, 10_000),
  toolCallsPerHour: envInt('AXIOM_TENANT_TOOL_CALLS_PER_HOUR', 600, 1, 100_000),
  concurrentToolCalls: envInt('AXIOM_TENANT_CONCURRENT_TOOL_CALLS', 12, 1, 1_000),
  schemaTokenBudget: envInt('AXIOM_TENANT_SCHEMA_TOKEN_BUDGET', 32_000, 256, 10_000_000),
  monthlyTokenBudget: envInt('AXIOM_TENANT_MONTHLY_TOKEN_BUDGET', 2_000_000, 0, 1_000_000_000),
  monthlyToolCallBudget: envInt('AXIOM_TENANT_MONTHLY_TOOL_CALL_BUDGET', 100_000, 0, 10_000_000),
  highRiskPolicy: process.env.AXIOM_TENANT_HIGH_RISK_POLICY === 'deny' ? 'deny' : 'approval',
  updatedAt: nowIso(),
});

const clampPolicy = (input: Partial<TenantGovernancePolicy>, current: TenantGovernancePolicy): TenantGovernancePolicy => ({
  ...current,
  maxToolSources: Math.min(10_000, Math.max(1, Math.floor(Number(input.maxToolSources ?? current.maxToolSources)))),
  toolCallsPerHour: Math.min(100_000, Math.max(1, Math.floor(Number(input.toolCallsPerHour ?? current.toolCallsPerHour)))),
  concurrentToolCalls: Math.min(1_000, Math.max(1, Math.floor(Number(input.concurrentToolCalls ?? current.concurrentToolCalls)))),
  schemaTokenBudget: Math.min(10_000_000, Math.max(256, Math.floor(Number(input.schemaTokenBudget ?? current.schemaTokenBudget)))),
  monthlyTokenBudget: Math.min(1_000_000_000, Math.max(0, Math.floor(Number(input.monthlyTokenBudget ?? current.monthlyTokenBudget)))),
  monthlyToolCallBudget: Math.min(10_000_000, Math.max(0, Math.floor(Number(input.monthlyToolCallBudget ?? current.monthlyToolCallBudget)))),
  highRiskPolicy: input.highRiskPolicy === 'deny' ? 'deny' : input.highRiskPolicy === 'approval' ? 'approval' : current.highRiskPolicy,
  revision: current.revision + 1,
  updatedAt: nowIso(),
});

const emptyUsage = (tenantId: string): ToolUsageSnapshot => ({
  tenantId, windowStart: startOfHour(), hourCalls: 0, activeCalls: 0,
  monthStart: startOfMonth(), monthCalls: 0, updatedAt: nowIso(),
});

const emptyHealth = (tenantId: string, sourceId: string): ToolHealthSnapshot => ({
  tenantId, sourceId, status: 'healthy', generation: 0, consecutiveFailures: 0, consecutiveSuccesses: 0,
  totalCalls: 0, totalFailures: 0, updatedAt: nowIso(),
});

const parseJson = <T>(value: unknown, fallback: T): T => {
  if (typeof value !== 'string') return value as T;
  try { return JSON.parse(value) as T; } catch { return fallback; }
};

export interface EnterpriseGovernanceStore {
  initialize(): Promise<void>;
  close(): Promise<void>;
  getPolicy(tenantId: string): Promise<TenantGovernancePolicy>;
  updatePolicy(tenantId: string, patch: Partial<Omit<TenantGovernancePolicy, 'tenantId' | 'revision' | 'updatedAt'>>, expectedRevision?: number): Promise<TenantGovernancePolicy>;
  reserveToolCall(tenantId: string, sourceId: string): Promise<ReserveResult>;
  releaseToolCall(tenantId: string, reservationId: string): Promise<void>;
  renewToolCall(tenantId: string, reservationId: string): Promise<boolean>;
  recordToolOutcome(tenantId: string, sourceId: string, ok: boolean, latencyMs: number, error?: string, reservationId?: string): Promise<ToolHealthSnapshot>;
  getToolHealth(tenantId: string, sourceId: string): Promise<ToolHealthSnapshot>;
  listToolHealth(tenantId: string): Promise<ToolHealthSnapshot[]>;
  recordMetric(input: GovernanceMetricInput): Promise<void>;
  metrics(tenantId: string, options?: { days?: number; limit?: number }): Promise<GovernanceMetric[]>;
  snapshot(tenantId: string): Promise<GovernanceSnapshot>;
}

export const keepToolCallLease = (store: EnterpriseGovernanceStore, tenantId: string, reservationId: string) => {
  let renewing = false;
  const timer = setInterval(() => {
    if (renewing) return;
    renewing = true;
    void store.renewToolCall(tenantId, reservationId).catch(() => false).finally(() => { renewing = false; });
  }, 10_000);
  timer.unref();
  return () => clearInterval(timer);
};

type SqliteHealthRow = Record<string, unknown>;
const sqlitePolicy = (row: Record<string, unknown> | undefined, tenantId: string): TenantGovernancePolicy => row ? {
  tenantId: String(row.tenant_id), revision: Number(row.revision), maxToolSources: Number(row.max_tool_sources),
  toolCallsPerHour: Number(row.tool_calls_per_hour), concurrentToolCalls: Number(row.concurrent_tool_calls),
  schemaTokenBudget: Number(row.schema_token_budget), monthlyTokenBudget: Number(row.monthly_token_budget),
  monthlyToolCallBudget: Number(row.monthly_tool_call_budget), highRiskPolicy: row.high_risk_policy === 'deny' ? 'deny' : 'approval',
  updatedAt: String(row.updated_at),
} : defaults(tenantId);
const sqliteUsage = (row: Record<string, unknown> | undefined, tenantId: string): ToolUsageSnapshot => row ? {
  tenantId: String(row.tenant_id), windowStart: String(row.window_start), hourCalls: Number(row.hour_calls), activeCalls: Number(row.active_calls),
  monthStart: String(row.month_start), monthCalls: Number(row.month_calls), updatedAt: String(row.updated_at),
} : emptyUsage(tenantId);
const sqliteHealth = (row: SqliteHealthRow | undefined, tenantId: string, sourceId: string): ToolHealthSnapshot => row ? ({
  tenantId: String(row.tenant_id), sourceId: String(row.source_id), status: (['healthy', 'degraded', 'open', 'half-open'] as const).includes(row.status as ToolHealthStatus) ? row.status as ToolHealthStatus : 'healthy',
  generation: Number(row.generation ?? 0),
  consecutiveFailures: Number(row.consecutive_failures), consecutiveSuccesses: Number(row.consecutive_successes), totalCalls: Number(row.total_calls), totalFailures: Number(row.total_failures),
  ...(row.last_latency_ms !== null && row.last_latency_ms !== undefined ? { lastLatencyMs: Number(row.last_latency_ms) } : {}),
  ...(row.last_error ? { lastError: String(row.last_error) } : {}), ...(row.last_checked_at ? { lastCheckedAt: String(row.last_checked_at) } : {}),
  ...(row.opened_at ? { openedAt: String(row.opened_at) } : {}), ...(row.next_probe_at ? { nextProbeAt: String(row.next_probe_at) } : {}), updatedAt: String(row.updated_at),
}) : emptyHealth(tenantId, sourceId);

export class SqliteEnterpriseGovernanceStore implements EnterpriseGovernanceStore {
  private readonly db: DatabaseSync;
  constructor(path: string) { if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true }); this.db = new DatabaseSync(path); }
  async initialize() {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS axiom_tenant_governance_policies (
        tenant_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, max_tool_sources INTEGER NOT NULL,
        tool_calls_per_hour INTEGER NOT NULL, concurrent_tool_calls INTEGER NOT NULL, schema_token_budget INTEGER NOT NULL,
        monthly_token_budget INTEGER NOT NULL, monthly_tool_call_budget INTEGER NOT NULL, high_risk_policy TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS axiom_tenant_tool_usage (
        tenant_id TEXT PRIMARY KEY, window_start TEXT NOT NULL, hour_calls INTEGER NOT NULL DEFAULT 0,
        active_calls INTEGER NOT NULL DEFAULT 0, month_start TEXT NOT NULL, month_calls INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS axiom_tool_health (
        tenant_id TEXT NOT NULL, source_id TEXT NOT NULL, status TEXT NOT NULL, consecutive_failures INTEGER NOT NULL DEFAULT 0,
        consecutive_successes INTEGER NOT NULL DEFAULT 0, total_calls INTEGER NOT NULL DEFAULT 0, total_failures INTEGER NOT NULL DEFAULT 0,
        last_latency_ms INTEGER, last_error TEXT, last_checked_at TEXT, opened_at TEXT, next_probe_at TEXT, updated_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, source_id)
      );
      CREATE TABLE IF NOT EXISTS axiom_runtime_metrics (
        tenant_id TEXT NOT NULL, day TEXT NOT NULL, name TEXT NOT NULL, dimensions_json TEXT NOT NULL,
        value REAL NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, PRIMARY KEY (tenant_id, day, name, dimensions_json)
      );
      CREATE TABLE IF NOT EXISTS axiom_tool_call_leases (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, source_id TEXT NOT NULL, expires_at TEXT NOT NULL,
        probe INTEGER NOT NULL DEFAULT 0, outcome_recorded INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_axiom_tool_call_leases_tenant ON axiom_tool_call_leases(tenant_id, expires_at);
      CREATE INDEX IF NOT EXISTS idx_axiom_runtime_metrics_scope ON axiom_runtime_metrics(tenant_id, day DESC, name);
    `);
    const healthColumns = this.db.prepare('PRAGMA table_info(axiom_tool_health)').all() as Array<{ name: string }>;
    if (!healthColumns.some((column) => column.name === 'generation')) this.db.exec('ALTER TABLE axiom_tool_health ADD COLUMN generation INTEGER NOT NULL DEFAULT 0');
    const leaseColumns = this.db.prepare('PRAGMA table_info(axiom_tool_call_leases)').all() as Array<{ name: string }>;
    if (!leaseColumns.some((column) => column.name === 'circuit_generation')) this.db.exec('ALTER TABLE axiom_tool_call_leases ADD COLUMN circuit_generation INTEGER NOT NULL DEFAULT 0');
  }
  async close() { this.db.close(); }
  private ensurePolicy(tenantId: string) {
    const row = this.db.prepare('SELECT * FROM axiom_tenant_governance_policies WHERE tenant_id = ?').get(tenantId) as Record<string, unknown> | undefined;
    if (row) return sqlitePolicy(row, tenantId);
    const policy = defaults(tenantId);
    this.db.prepare(`INSERT INTO axiom_tenant_governance_policies (tenant_id, revision, max_tool_sources, tool_calls_per_hour, concurrent_tool_calls, schema_token_budget, monthly_token_budget, monthly_tool_call_budget, high_risk_policy, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(tenantId, policy.revision, policy.maxToolSources, policy.toolCallsPerHour, policy.concurrentToolCalls, policy.schemaTokenBudget, policy.monthlyTokenBudget, policy.monthlyToolCallBudget, policy.highRiskPolicy, policy.updatedAt);
    return policy;
  }
  async getPolicy(tenantId: string) { return this.ensurePolicy(tenantId); }
  async updatePolicy(tenantId: string, patch: Partial<Omit<TenantGovernancePolicy, 'tenantId' | 'revision' | 'updatedAt'>>, expectedRevision?: number) {
    const current = this.ensurePolicy(tenantId);
    if (expectedRevision !== undefined && expectedRevision !== current.revision) throw new Error(`Governance policy revision conflict: expected ${expectedRevision}, actual ${current.revision}.`);
    const next = clampPolicy(patch, current);
    this.db.prepare(`UPDATE axiom_tenant_governance_policies SET revision = ?, max_tool_sources = ?, tool_calls_per_hour = ?, concurrent_tool_calls = ?, schema_token_budget = ?, monthly_token_budget = ?, monthly_tool_call_budget = ?, high_risk_policy = ?, updated_at = ? WHERE tenant_id = ? AND revision = ?`).run(next.revision, next.maxToolSources, next.toolCallsPerHour, next.concurrentToolCalls, next.schemaTokenBudget, next.monthlyTokenBudget, next.monthlyToolCallBudget, next.highRiskPolicy, next.updatedAt, tenantId, current.revision);
    return next;
  }
  private ensureUsage(tenantId: string) {
    const hour = startOfHour(); const month = startOfMonth();
    const row = this.db.prepare('SELECT * FROM axiom_tenant_tool_usage WHERE tenant_id = ?').get(tenantId) as Record<string, unknown> | undefined;
    const current = sqliteUsage(row, tenantId);
    if (!row || current.windowStart !== hour || current.monthStart !== month) {
      const reset = { ...emptyUsage(tenantId), windowStart: hour, monthStart: month };
      this.db.prepare(`INSERT INTO axiom_tenant_tool_usage (tenant_id, window_start, hour_calls, active_calls, month_start, month_calls, updated_at) VALUES (?, ?, 0, 0, ?, 0, ?) ON CONFLICT(tenant_id) DO UPDATE SET window_start = excluded.window_start, hour_calls = CASE WHEN axiom_tenant_tool_usage.window_start = excluded.window_start THEN axiom_tenant_tool_usage.hour_calls ELSE 0 END, active_calls = axiom_tenant_tool_usage.active_calls, month_start = excluded.month_start, month_calls = CASE WHEN axiom_tenant_tool_usage.month_start = excluded.month_start THEN axiom_tenant_tool_usage.month_calls ELSE 0 END, updated_at = excluded.updated_at`).run(tenantId, hour, month, reset.updatedAt);
      return sqliteUsage(this.db.prepare('SELECT * FROM axiom_tenant_tool_usage WHERE tenant_id = ?').get(tenantId) as Record<string, unknown>, tenantId);
    }
    return current;
  }
  private reconcileLeases(tenantId: string) {
    this.db.prepare('DELETE FROM axiom_tool_call_leases WHERE tenant_id = ? AND expires_at <= ?').run(tenantId, nowIso());
    this.db.prepare('UPDATE axiom_tenant_tool_usage SET active_calls = (SELECT COUNT(*) FROM axiom_tool_call_leases WHERE tenant_id = ?) WHERE tenant_id = ?').run(tenantId, tenantId);
  }
  async reserveToolCall(tenantId: string, sourceId: string): Promise<ReserveResult> {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const policy = this.ensurePolicy(tenantId);
      this.ensureUsage(tenantId);
      this.reconcileLeases(tenantId);
      const usage = this.ensureUsage(tenantId); const health = this.ensureHealth(tenantId, sourceId);
      const now = Date.now();
      if (health.status === 'open') {
        if (!health.nextProbeAt || Date.parse(health.nextProbeAt) > now) throw new GovernanceToolUnavailableError('circuit-open');
        this.db.prepare('UPDATE axiom_tool_health SET status = ?, updated_at = ? WHERE tenant_id = ? AND source_id = ?').run('half-open', nowIso(), tenantId, sourceId);
      } else if (health.status === 'half-open' && this.db.prepare('SELECT 1 FROM axiom_tool_call_leases WHERE tenant_id = ? AND source_id = ? AND probe = 1 AND outcome_recorded = 0').get(tenantId, sourceId)) {
        throw new GovernanceToolUnavailableError('not-half-open');
      }
      if (usage.hourCalls >= policy.toolCallsPerHour) throw new GovernanceQuotaError('hourly-tool-calls');
      if (policy.monthlyToolCallBudget > 0 && usage.monthCalls >= policy.monthlyToolCallBudget) throw new GovernanceQuotaError('monthly-tool-calls');
      if (usage.activeCalls >= policy.concurrentToolCalls) throw new GovernanceQuotaError('concurrent-tool-calls');
      const reservationId = randomUUID(); const expiresAt = new Date(now + callLeaseMs()).toISOString();
      this.db.prepare('INSERT INTO axiom_tool_call_leases (id, tenant_id, source_id, expires_at, probe, circuit_generation) VALUES (?, ?, ?, ?, ?, ?)').run(reservationId, tenantId, sourceId, expiresAt, health.status === 'open' || health.status === 'half-open' ? 1 : 0, health.generation ?? 0);
      this.db.prepare('UPDATE axiom_tenant_tool_usage SET hour_calls = hour_calls + 1, active_calls = active_calls + 1, month_calls = month_calls + 1, updated_at = ? WHERE tenant_id = ?').run(nowIso(), tenantId);
      const nextUsage = this.ensureUsage(tenantId);
      this.db.exec('COMMIT');
      return { reservationId, expiresAt, policy, usage: nextUsage, health: health.status === 'open' ? { ...health, status: 'half-open' as const } : health };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  async releaseToolCall(tenantId: string, reservationId: string) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM axiom_tool_call_leases WHERE tenant_id = ? AND id = ?').run(tenantId, reservationId);
      this.reconcileLeases(tenantId);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  async renewToolCall(tenantId: string, reservationId: string) {
    const now = nowIso();
    return Number(this.db.prepare('UPDATE axiom_tool_call_leases SET expires_at = ? WHERE tenant_id = ? AND id = ? AND expires_at > ?').run(new Date(Date.now() + callLeaseMs()).toISOString(), tenantId, reservationId, now).changes) === 1;
  }
  private ensureHealth(tenantId: string, sourceId: string) {
    const row = this.db.prepare('SELECT * FROM axiom_tool_health WHERE tenant_id = ? AND source_id = ?').get(tenantId, sourceId) as SqliteHealthRow | undefined;
    if (row) return sqliteHealth(row, tenantId, sourceId);
    const health = emptyHealth(tenantId, sourceId);
    this.db.prepare('INSERT INTO axiom_tool_health (tenant_id, source_id, status, consecutive_failures, consecutive_successes, total_calls, total_failures, updated_at) VALUES (?, ?, ?, 0, 0, 0, 0, ?)').run(tenantId, sourceId, health.status, health.updatedAt);
    return health;
  }
  async getToolHealth(tenantId: string, sourceId: string) { return this.ensureHealth(tenantId, sourceId); }
  async listToolHealth(tenantId: string) { return (this.db.prepare('SELECT * FROM axiom_tool_health WHERE tenant_id = ? ORDER BY updated_at DESC').all(tenantId) as SqliteHealthRow[]).map((row) => sqliteHealth(row, tenantId, String(row.source_id))); }
  async recordToolOutcome(tenantId: string, sourceId: string, ok: boolean, latencyMs: number, error?: string, reservationId?: string) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.ensureHealth(tenantId, sourceId); const now = nowIso();
      const lease = reservationId ? this.db.prepare('UPDATE axiom_tool_call_leases SET outcome_recorded = 1 WHERE id = ? AND tenant_id = ? AND source_id = ? AND expires_at > ? AND outcome_recorded = 0 RETURNING probe, circuit_generation').get(reservationId, tenantId, sourceId, now) as { probe: number; circuit_generation: number } | undefined : undefined;
      if ((reservationId && (!lease || lease.circuit_generation !== (current.generation ?? 0))) || current.status === 'open' || (current.status === 'half-open' && !lease?.probe)) {
        this.db.exec('COMMIT'); return current;
      }
      const { status, failures, successes, generation, openedAt, nextProbeAt } = healthAfterOutcome(current, ok);
      this.db.prepare(`UPDATE axiom_tool_health SET status = ?, consecutive_failures = ?, consecutive_successes = ?, total_calls = total_calls + 1, total_failures = total_failures + ?, last_latency_ms = ?, last_error = ?, last_checked_at = ?, opened_at = ?, next_probe_at = ?, updated_at = ?, generation = ? WHERE tenant_id = ? AND source_id = ?`).run(status, failures, successes, ok ? 0 : 1, Math.max(0, Math.floor(latencyMs)), ok ? null : String(error ?? '调用失败').slice(0, 500), now, openedAt, nextProbeAt, now, generation, tenantId, sourceId);
      const result = this.ensureHealth(tenantId, sourceId);
      this.db.exec('COMMIT'); return result;
    } catch (failure) { this.db.exec('ROLLBACK'); throw failure; }
  }
  async recordMetric(input: GovernanceMetricInput) {
    const dimensionsJson = JSON.stringify(Object.fromEntries(Object.entries(input.dimensions).sort(([a], [b]) => a.localeCompare(b))));
    this.db.prepare(`INSERT INTO axiom_runtime_metrics (tenant_id, day, name, dimensions_json, value, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(tenant_id, day, name, dimensions_json) DO UPDATE SET value = axiom_runtime_metrics.value + excluded.value, updated_at = excluded.updated_at`).run(input.tenantId, input.day, input.name, dimensionsJson, input.value, nowIso());
  }
  async metrics(tenantId: string, options: { days?: number; limit?: number } = {}) {
    const days = Math.min(90, Math.max(1, options.days ?? 30)); const limit = Math.min(10_000, Math.max(1, options.limit ?? 2_000));
    const rows = this.db.prepare(`SELECT * FROM axiom_runtime_metrics WHERE tenant_id = ? AND day >= date('now', ?) ORDER BY day DESC, updated_at DESC LIMIT ?`).all(tenantId, `-${days - 1} day`, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({ tenantId: String(row.tenant_id), day: String(row.day), name: String(row.name), dimensions: parseJson<Record<string, string>>(row.dimensions_json, {}), value: Number(row.value), updatedAt: String(row.updated_at) }));
  }
  async snapshot(tenantId: string) { const policy = this.ensurePolicy(tenantId); this.ensureUsage(tenantId); this.reconcileLeases(tenantId); return { policy, usage: this.ensureUsage(tenantId), tools: await this.listToolHealth(tenantId), generatedAt: nowIso() }; }
}

export class PostgresEnterpriseGovernanceStore implements EnterpriseGovernanceStore {
  private readonly pool: Pool;
  constructor(connectionString: string) { this.pool = new Pool({ connectionString, max: Number(process.env.DATABASE_POOL_SIZE ?? 10) }); }
  async initialize() {
    const client = await this.pool.connect();
    try {
      await client.query("SELECT pg_advisory_lock(hashtext('axiom_enterprise_governance_schema_v1'))");
      await client.query(`CREATE TABLE IF NOT EXISTS axiom_tenant_governance_policies (tenant_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, max_tool_sources INTEGER NOT NULL, tool_calls_per_hour INTEGER NOT NULL, concurrent_tool_calls INTEGER NOT NULL, schema_token_budget INTEGER NOT NULL, monthly_token_budget BIGINT NOT NULL, monthly_tool_call_budget INTEGER NOT NULL, high_risk_policy TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL)`);
      await client.query(`CREATE TABLE IF NOT EXISTS axiom_tenant_tool_usage (tenant_id TEXT PRIMARY KEY, window_start TIMESTAMPTZ NOT NULL, hour_calls INTEGER NOT NULL DEFAULT 0, active_calls INTEGER NOT NULL DEFAULT 0, month_start TIMESTAMPTZ NOT NULL, month_calls INTEGER NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ NOT NULL)`);
      await client.query(`CREATE TABLE IF NOT EXISTS axiom_tool_health (tenant_id TEXT NOT NULL, source_id TEXT NOT NULL, status TEXT NOT NULL, consecutive_failures INTEGER NOT NULL DEFAULT 0, consecutive_successes INTEGER NOT NULL DEFAULT 0, total_calls INTEGER NOT NULL DEFAULT 0, total_failures INTEGER NOT NULL DEFAULT 0, last_latency_ms INTEGER, last_error TEXT, last_checked_at TIMESTAMPTZ, opened_at TIMESTAMPTZ, next_probe_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL, PRIMARY KEY (tenant_id, source_id))`);
      await client.query(`CREATE TABLE IF NOT EXISTS axiom_runtime_metrics (tenant_id TEXT NOT NULL, day DATE NOT NULL, name TEXT NOT NULL, dimensions_json JSONB NOT NULL, value DOUBLE PRECISION NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ NOT NULL, PRIMARY KEY (tenant_id, day, name, dimensions_json))`);
      await client.query('CREATE INDEX IF NOT EXISTS idx_axiom_runtime_metrics_scope ON axiom_runtime_metrics(tenant_id, day DESC, name)');
      await client.query(`CREATE TABLE IF NOT EXISTS axiom_tool_call_leases (id UUID PRIMARY KEY, tenant_id TEXT NOT NULL, source_id TEXT NOT NULL, expires_at TIMESTAMPTZ NOT NULL, probe BOOLEAN NOT NULL DEFAULT FALSE, outcome_recorded BOOLEAN NOT NULL DEFAULT FALSE)`);
      await client.query('CREATE INDEX IF NOT EXISTS idx_axiom_tool_call_leases_tenant ON axiom_tool_call_leases(tenant_id, expires_at)');
      await client.query('ALTER TABLE axiom_tool_health ADD COLUMN IF NOT EXISTS generation INTEGER NOT NULL DEFAULT 0');
      await client.query('ALTER TABLE axiom_tool_call_leases ADD COLUMN IF NOT EXISTS circuit_generation INTEGER NOT NULL DEFAULT 0');
    } finally { await client.query("SELECT pg_advisory_unlock(hashtext('axiom_enterprise_governance_schema_v1'))").catch(() => undefined); client.release(); }
  }
  async close() { await this.pool.end(); }
  private async ensurePolicy(client: import('pg').PoolClient, tenantId: string) {
    const found = await client.query('SELECT * FROM axiom_tenant_governance_policies WHERE tenant_id = $1', [tenantId]);
    if (found.rows[0]) return this.policyFrom(found.rows[0]);
    const policy = defaults(tenantId);
    await client.query('INSERT INTO axiom_tenant_governance_policies (tenant_id, revision, max_tool_sources, tool_calls_per_hour, concurrent_tool_calls, schema_token_budget, monthly_token_budget, monthly_tool_call_budget, high_risk_policy, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (tenant_id) DO NOTHING', [tenantId, policy.revision, policy.maxToolSources, policy.toolCallsPerHour, policy.concurrentToolCalls, policy.schemaTokenBudget, policy.monthlyTokenBudget, policy.monthlyToolCallBudget, policy.highRiskPolicy, policy.updatedAt]);
    return this.policyFrom((await client.query('SELECT * FROM axiom_tenant_governance_policies WHERE tenant_id = $1', [tenantId])).rows[0]);
  }
  private policyFrom(row: Record<string, unknown>): TenantGovernancePolicy { return { tenantId: String(row.tenant_id), revision: Number(row.revision), maxToolSources: Number(row.max_tool_sources), toolCallsPerHour: Number(row.tool_calls_per_hour), concurrentToolCalls: Number(row.concurrent_tool_calls), schemaTokenBudget: Number(row.schema_token_budget), monthlyTokenBudget: Number(row.monthly_token_budget), monthlyToolCallBudget: Number(row.monthly_tool_call_budget), highRiskPolicy: row.high_risk_policy === 'deny' ? 'deny' : 'approval', updatedAt: new Date(String(row.updated_at)).toISOString() }; }
  private usageFrom(row: Record<string, unknown>, tenantId: string): ToolUsageSnapshot { return { tenantId, windowStart: new Date(String(row.window_start)).toISOString(), hourCalls: Number(row.hour_calls), activeCalls: Number(row.active_calls), monthStart: new Date(String(row.month_start)).toISOString(), monthCalls: Number(row.month_calls), updatedAt: new Date(String(row.updated_at)).toISOString() }; }
  private healthFrom(row: Record<string, unknown>, tenantId: string, sourceId: string): ToolHealthSnapshot { return { tenantId, sourceId, generation: Number(row.generation ?? 0), status: (['healthy', 'degraded', 'open', 'half-open'] as const).includes(row.status as ToolHealthStatus) ? row.status as ToolHealthStatus : 'healthy', consecutiveFailures: Number(row.consecutive_failures), consecutiveSuccesses: Number(row.consecutive_successes), totalCalls: Number(row.total_calls), totalFailures: Number(row.total_failures), ...(row.last_latency_ms !== null && row.last_latency_ms !== undefined ? { lastLatencyMs: Number(row.last_latency_ms) } : {}), ...(row.last_error ? { lastError: String(row.last_error) } : {}), ...(row.last_checked_at ? { lastCheckedAt: new Date(String(row.last_checked_at)).toISOString() } : {}), ...(row.opened_at ? { openedAt: new Date(String(row.opened_at)).toISOString() } : {}), ...(row.next_probe_at ? { nextProbeAt: new Date(String(row.next_probe_at)).toISOString() } : {}), updatedAt: new Date(String(row.updated_at)).toISOString() }; }
  async getPolicy(tenantId: string) { const client = await this.pool.connect(); try { return await this.ensurePolicy(client, tenantId); } finally { client.release(); } }
  async updatePolicy(tenantId: string, patch: Partial<Omit<TenantGovernancePolicy, 'tenantId' | 'revision' | 'updatedAt'>>, expectedRevision?: number) { const client = await this.pool.connect(); try { await client.query('BEGIN'); const current = await this.ensurePolicy(client, tenantId); if (expectedRevision !== undefined && expectedRevision !== current.revision) throw new Error(`Governance policy revision conflict: expected ${expectedRevision}, actual ${current.revision}.`); const next = clampPolicy(patch, current); const result = await client.query('UPDATE axiom_tenant_governance_policies SET revision=$1,max_tool_sources=$2,tool_calls_per_hour=$3,concurrent_tool_calls=$4,schema_token_budget=$5,monthly_token_budget=$6,monthly_tool_call_budget=$7,high_risk_policy=$8,updated_at=$9 WHERE tenant_id=$10 AND revision=$11 RETURNING *', [next.revision, next.maxToolSources, next.toolCallsPerHour, next.concurrentToolCalls, next.schemaTokenBudget, next.monthlyTokenBudget, next.monthlyToolCallBudget, next.highRiskPolicy, next.updatedAt, tenantId, current.revision]); if (!result.rows[0]) throw new Error('Governance policy revision conflict.'); await client.query('COMMIT'); return this.policyFrom(result.rows[0]); } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; } finally { client.release(); } }
  private async ensureUsage(client: import('pg').PoolClient, tenantId: string) { const hour = startOfHour(); const month = startOfMonth(); await client.query(`INSERT INTO axiom_tenant_tool_usage (tenant_id,window_start,hour_calls,active_calls,month_start,month_calls,updated_at) VALUES ($1,$2,0,0,$3,0,$4) ON CONFLICT (tenant_id) DO UPDATE SET window_start=CASE WHEN axiom_tenant_tool_usage.window_start < $2 THEN $2 ELSE axiom_tenant_tool_usage.window_start END, hour_calls=CASE WHEN axiom_tenant_tool_usage.window_start < $2 THEN 0 ELSE axiom_tenant_tool_usage.hour_calls END, month_start=CASE WHEN axiom_tenant_tool_usage.month_start < $3 THEN $3 ELSE axiom_tenant_tool_usage.month_start END, month_calls=CASE WHEN axiom_tenant_tool_usage.month_start < $3 THEN 0 ELSE axiom_tenant_tool_usage.month_calls END, updated_at=$4`, [tenantId, hour, month, nowIso()]); const result = await client.query('SELECT * FROM axiom_tenant_tool_usage WHERE tenant_id=$1 FOR UPDATE', [tenantId]); return this.usageFrom(result.rows[0], tenantId); }
  private async ensureHealth(client: import('pg').PoolClient, tenantId: string, sourceId: string) { await client.query('INSERT INTO axiom_tool_health (tenant_id,source_id,status,updated_at) VALUES ($1,$2,$3,$4) ON CONFLICT (tenant_id,source_id) DO NOTHING', [tenantId, sourceId, 'healthy', nowIso()]); const result = await client.query('SELECT * FROM axiom_tool_health WHERE tenant_id=$1 AND source_id=$2 FOR UPDATE', [tenantId, sourceId]); return this.healthFrom(result.rows[0], tenantId, sourceId); }
  private async reconcileLeases(client: import('pg').PoolClient, tenantId: string) {
    await client.query('DELETE FROM axiom_tool_call_leases WHERE tenant_id = $1 AND expires_at <= clock_timestamp()', [tenantId]);
    await client.query('UPDATE axiom_tenant_tool_usage SET active_calls = (SELECT COUNT(*) FROM axiom_tool_call_leases WHERE tenant_id = $1) WHERE tenant_id = $1', [tenantId]);
  }
  async reserveToolCall(tenantId: string, sourceId: string): Promise<ReserveResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const policy = await this.ensurePolicy(client, tenantId);
      await this.ensureUsage(client, tenantId);
      await this.reconcileLeases(client, tenantId);
      const usage = await this.ensureUsage(client, tenantId);
      const health = await this.ensureHealth(client, tenantId, sourceId);
      if (health.status === 'open') {
        if (!health.nextProbeAt || Date.parse(health.nextProbeAt) > Date.now()) throw new GovernanceToolUnavailableError('circuit-open');
        await client.query('UPDATE axiom_tool_health SET status=$1,updated_at=NOW() WHERE tenant_id=$2 AND source_id=$3', ['half-open', tenantId, sourceId]);
      } else if (health.status === 'half-open') {
        const active = await client.query('SELECT 1 FROM axiom_tool_call_leases WHERE tenant_id=$1 AND source_id=$2 AND probe=TRUE AND outcome_recorded=FALSE', [tenantId, sourceId]);
        if (active.rowCount) throw new GovernanceToolUnavailableError('not-half-open');
      }
      if (usage.hourCalls >= policy.toolCallsPerHour) throw new GovernanceQuotaError('hourly-tool-calls');
      if (policy.monthlyToolCallBudget > 0 && usage.monthCalls >= policy.monthlyToolCallBudget) throw new GovernanceQuotaError('monthly-tool-calls');
      if (usage.activeCalls >= policy.concurrentToolCalls) throw new GovernanceQuotaError('concurrent-tool-calls');
      const reservationId = randomUUID();
      const inserted = await client.query('INSERT INTO axiom_tool_call_leases (id,tenant_id,source_id,expires_at,probe,circuit_generation) VALUES ($1,$2,$3,clock_timestamp()+($4 * INTERVAL \'1 millisecond\'),$5,$6) RETURNING expires_at', [reservationId, tenantId, sourceId, callLeaseMs(), health.status === 'open' || health.status === 'half-open', health.generation ?? 0]);
      await client.query('UPDATE axiom_tenant_tool_usage SET hour_calls=hour_calls+1,active_calls=active_calls+1,month_calls=month_calls+1,updated_at=NOW() WHERE tenant_id=$1', [tenantId]);
      const nextUsage = await this.ensureUsage(client, tenantId);
      await client.query('COMMIT');
      return { reservationId, expiresAt: new Date(inserted.rows[0].expires_at).toISOString(), policy, usage: nextUsage, health: health.status === 'open' ? { ...health, status: 'half-open' } : health };
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
    finally { client.release(); }
  }
  async releaseToolCall(tenantId: string, reservationId: string) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await this.ensureUsage(client, tenantId);
      await client.query('DELETE FROM axiom_tool_call_leases WHERE tenant_id=$1 AND id=$2', [tenantId, reservationId]);
      await this.reconcileLeases(client, tenantId);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
    finally { client.release(); }
  }
  async renewToolCall(tenantId: string, reservationId: string) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM axiom_tool_call_leases WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [tenantId, reservationId]);
      const result = await client.query('UPDATE axiom_tool_call_leases SET expires_at=clock_timestamp()+($3 * INTERVAL \'1 millisecond\') WHERE tenant_id=$1 AND id=$2 AND expires_at>clock_timestamp()', [tenantId, reservationId, callLeaseMs()]);
      await client.query('COMMIT'); return result.rowCount === 1;
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
    finally { client.release(); }
  }
  async getToolHealth(tenantId: string, sourceId: string) { const client = await this.pool.connect(); try { const result = await client.query('SELECT * FROM axiom_tool_health WHERE tenant_id=$1 AND source_id=$2', [tenantId, sourceId]); if (!result.rows[0]) { await client.query('INSERT INTO axiom_tool_health (tenant_id,source_id,status,updated_at) VALUES ($1,$2,$3,$4)', [tenantId, sourceId, 'healthy', nowIso()]); return emptyHealth(tenantId, sourceId); } return this.healthFrom(result.rows[0], tenantId, sourceId); } finally { client.release(); } }
  async listToolHealth(tenantId: string) { const result = await this.pool.query('SELECT * FROM axiom_tool_health WHERE tenant_id=$1 ORDER BY updated_at DESC', [tenantId]); return result.rows.map((row) => this.healthFrom(row, tenantId, String(row.source_id))); }
  async recordToolOutcome(tenantId: string, sourceId: string, ok: boolean, latencyMs: number, error?: string, reservationId?: string) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Use the same tenant -> health -> lease lock order as reservations.
      await this.ensureUsage(client, tenantId);
      const current = await this.ensureHealth(client, tenantId, sourceId);
      if (reservationId) await client.query('SELECT id FROM axiom_tool_call_leases WHERE id=$1 AND tenant_id=$2 FOR UPDATE', [reservationId, tenantId]);
      const lease = reservationId ? (await client.query('UPDATE axiom_tool_call_leases SET outcome_recorded=TRUE WHERE id=$1 AND tenant_id=$2 AND source_id=$3 AND expires_at>clock_timestamp() AND outcome_recorded=FALSE RETURNING probe,circuit_generation', [reservationId, tenantId, sourceId])).rows[0] as { probe: boolean; circuit_generation: number } | undefined : undefined;
      if ((reservationId && (!lease || lease.circuit_generation !== (current.generation ?? 0))) || current.status === 'open' || (current.status === 'half-open' && !lease?.probe)) {
        await client.query('COMMIT'); return current;
      }
      const { status, failures, successes, generation, openedAt, nextProbeAt } = healthAfterOutcome(current, ok);
      const result = await client.query('UPDATE axiom_tool_health SET status=$1,consecutive_failures=$2,consecutive_successes=$3,total_calls=total_calls+1,total_failures=total_failures+$4,last_latency_ms=$5,last_error=$6,last_checked_at=$7,opened_at=$8,next_probe_at=$9,updated_at=$7,generation=$12 WHERE tenant_id=$10 AND source_id=$11 RETURNING *', [status, failures, successes, ok ? 0 : 1, Math.max(0, Math.floor(latencyMs)), ok ? null : String(error ?? '调用失败').slice(0, 500), nowIso(), openedAt, nextProbeAt, tenantId, sourceId, generation]);
      await client.query('COMMIT'); return this.healthFrom(result.rows[0], tenantId, sourceId);
    } catch (failure) { await client.query('ROLLBACK').catch(() => undefined); throw failure; }
    finally { client.release(); }
  }
  async recordMetric(input: GovernanceMetricInput) { const dimensionsJson = Object.fromEntries(Object.entries(input.dimensions).sort(([a], [b]) => a.localeCompare(b))); await this.pool.query('INSERT INTO axiom_runtime_metrics (tenant_id,day,name,dimensions_json,value,updated_at) VALUES ($1,$2,$3,$4::jsonb,$5,$6) ON CONFLICT (tenant_id,day,name,dimensions_json) DO UPDATE SET value=axiom_runtime_metrics.value+EXCLUDED.value,updated_at=EXCLUDED.updated_at', [input.tenantId, input.day, input.name, JSON.stringify(dimensionsJson), input.value, nowIso()]); }
  async metrics(tenantId: string, options: { days?: number; limit?: number } = {}) { const days = Math.min(90, Math.max(1, options.days ?? 30)); const limit = Math.min(10_000, Math.max(1, options.limit ?? 2_000)); const result = await this.pool.query('SELECT * FROM axiom_runtime_metrics WHERE tenant_id=$1 AND day >= CURRENT_DATE - ($2::int - 1) ORDER BY day DESC,updated_at DESC LIMIT $3', [tenantId, days, limit]); return result.rows.map((row) => ({ tenantId, day: String(row.day).slice(0, 10), name: String(row.name), dimensions: typeof row.dimensions_json === 'string' ? parseJson(row.dimensions_json, {}) : row.dimensions_json as Record<string, string>, value: Number(row.value), updatedAt: new Date(String(row.updated_at)).toISOString() })); }
  async snapshot(tenantId: string) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const policy = await this.ensurePolicy(client, tenantId);
      await this.ensureUsage(client, tenantId); await this.reconcileLeases(client, tenantId);
      const usage = await this.ensureUsage(client, tenantId);
      const rows = await client.query('SELECT * FROM axiom_tool_health WHERE tenant_id=$1 ORDER BY updated_at DESC', [tenantId]);
      await client.query('COMMIT');
      return { policy, usage, tools: rows.rows.map((row) => this.healthFrom(row, tenantId, String(row.source_id))), generatedAt: nowIso() };
    } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
    finally { client.release(); }
  }
}

export const createEnterpriseGovernanceStore = (): EnterpriseGovernanceStore => process.env.DATABASE_URL?.trim()
  ? new PostgresEnterpriseGovernanceStore(process.env.DATABASE_URL.trim())
  : new SqliteEnterpriseGovernanceStore(process.env.AXIOM_SQLITE_PATH?.trim() || resolve(process.cwd(), '.data', 'axiom-control-room.sqlite'));

export const createMemoryEnterpriseGovernanceStore = () => new SqliteEnterpriseGovernanceStore(':memory:');

export const governanceMetricDay = (date = new Date()) => date.toISOString().slice(0, 10);
