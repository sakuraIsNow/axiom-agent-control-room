import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Pool } from 'pg';
import {
  builtinAgentRoleIds,
  type AgentStore,
  type CreateUserDefinedAgentInput,
  type TemplateAccess,
  type UpdateUserDefinedAgentInput,
  type UserDefinedAgent,
  type UserDefinedAgentDefinition,
} from './contracts.js';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const now = () => new Date().toISOString();

export const isBuiltinRoleId = (roleId: string) => (builtinAgentRoleIds as readonly string[]).includes(roleId);

const normalizeRoleId = (roleId: string) => roleId.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 64);

const normalizeDefinition = (definition: UserDefinedAgentDefinition): UserDefinedAgentDefinition => ({
  systemPromptTemplate: definition.systemPromptTemplate.trim().slice(0, 8_000),
  whenToUseHint: definition.whenToUseHint.trim().slice(0, 500),
  ...(definition.defaultModel?.trim() ? { defaultModel: definition.defaultModel.trim().slice(0, 160) } : {}),
  ...(definition.allowedModels?.length ? { allowedModels: [...new Set(definition.allowedModels.map((m) => m.trim()).filter(Boolean))].slice(0, 16) } : {}),
  toolAllowlist: [...new Set((definition.toolAllowlist ?? []).map((name) => name.trim()).filter(Boolean))].slice(0, 32),
  ...(definition.maxToolCallsPerStep !== undefined ? { maxToolCallsPerStep: Math.max(0, Math.min(64, Math.floor(definition.maxToolCallsPerStep))) } : {}),
  ...(definition.maxTokensDefault !== undefined ? { maxTokensDefault: Math.max(1, Math.floor(definition.maxTokensDefault)) } : {}),
  ...(definition.maxDurationMsDefault !== undefined ? { maxDurationMsDefault: Math.max(1_000, Math.floor(definition.maxDurationMsDefault)) } : {}),
  ...(definition.failureStrategyDefault ? { failureStrategyDefault: definition.failureStrategyDefault } : {}),
  memoryRecall: Boolean(definition.memoryRecall),
  ...(definition.requiresPlanApprovalOverride !== undefined ? { requiresPlanApprovalOverride: definition.requiresPlanApprovalOverride } : {}),
});

const createAgent = (input: CreateUserDefinedAgentInput): UserDefinedAgent => {
  const timestamp = now();
  return {
    id: randomUUID(),
    tenantId: input.tenantId,
    roleId: normalizeRoleId(input.roleId),
    name: input.name.trim(),
    description: input.description.trim(),
    ...(input.icon?.trim() ? { icon: input.icon.trim().slice(0, 32) } : {}),
    kind: input.kind ?? 'worker',
    status: 'draft',
    visibility: input.visibility ?? 'private',
    version: 1,
    definition: normalizeDefinition(input.definition),
    history: [],
    createdBy: input.createdBy,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
};

const updateValue = (current: UserDefinedAgent, input: UpdateUserDefinedAgentInput): UserDefinedAgent => {
  const changed = input.definition !== undefined || input.name !== undefined || input.description !== undefined || input.icon !== undefined;
  const timestamp = now();
  const history = changed
    ? [...current.history, { version: current.version, definition: clone(current.definition), updatedAt: current.updatedAt, updatedBy: input.updatedBy }]
    : current.history;
  return {
    ...current,
    ...(input.name !== undefined ? { name: input.name.trim() } : {}),
    ...(input.description !== undefined ? { description: input.description.trim() } : {}),
    ...(input.icon !== undefined ? { icon: input.icon.trim().slice(0, 32) } : {}),
    ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
    ...(input.status !== undefined ? { status: input.status } : {}),
    ...(input.definition !== undefined ? { definition: normalizeDefinition(input.definition) } : {}),
    version: changed ? current.version + 1 : current.version,
    history: history.slice(-30),
    updatedAt: timestamp,
  };
};

type SqliteRow = {
  id: string; tenant_id: string; role_id: string; name: string; description: string; icon?: string;
  kind: UserDefinedAgent['kind']; status: UserDefinedAgent['status']; visibility: UserDefinedAgent['visibility']; version: number;
  definition_json: string; history_json: string; created_by: string; created_at: string; updated_at: string;
};

const fromSqlite = (row: SqliteRow): UserDefinedAgent => ({
  id: row.id, tenantId: row.tenant_id, roleId: row.role_id, name: row.name, description: row.description, ...(row.icon ? { icon: row.icon } : {}),
  kind: row.kind, status: row.status, visibility: row.visibility ?? 'private', version: row.version,
  definition: JSON.parse(row.definition_json) as UserDefinedAgentDefinition,
  history: JSON.parse(row.history_json) as UserDefinedAgent['history'], createdBy: row.created_by,
  createdAt: row.created_at, updatedAt: row.updated_at,
});

const canSeePrivate = (access?: TemplateAccess) => !access || access.role === 'owner' || access.role === 'admin';

export class SqliteAgentStore implements AgentStore {
  private readonly db: DatabaseSync;
  constructor(path: string) { if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true }); this.db = new DatabaseSync(path); }
  async initialize() {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS user_agents (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, role_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', icon TEXT,
        kind TEXT NOT NULL DEFAULT 'worker', status TEXT NOT NULL DEFAULT 'draft', visibility TEXT NOT NULL DEFAULT 'private',
        version INTEGER NOT NULL DEFAULT 1, definition_json TEXT NOT NULL, history_json TEXT NOT NULL DEFAULT '[]',
        created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_user_agents_tenant_updated ON user_agents(tenant_id, updated_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_user_agents_tenant_role ON user_agents(tenant_id, role_id) WHERE status != 'archived';
    `);
  }
  async close() { this.db.close(); }
  async listAgents(tenantId: string, limit = 50, access?: TemplateAccess) {
    const rows = this.db.prepare(`SELECT * FROM user_agents WHERE tenant_id = ?${canSeePrivate(access) ? '' : ' AND (visibility = \'team\' OR created_by = ?)'} ORDER BY updated_at DESC LIMIT ?`)
      .all(...(canSeePrivate(access) ? [tenantId, Math.min(100, Math.max(1, limit))] : [tenantId, access!.userId, Math.min(100, Math.max(1, limit))])) as unknown as SqliteRow[];
    return rows.map(fromSqlite);
  }
  async getAgent(agentId: string, tenantId?: string, access?: TemplateAccess) {
    const where = tenantId ? `id = ? AND tenant_id = ?${canSeePrivate(access) ? '' : ' AND (visibility = \'team\' OR created_by = ?)'}` : 'id = ?';
    const args = tenantId ? (canSeePrivate(access) ? [agentId, tenantId] : [agentId, tenantId, access!.userId]) : [agentId];
    const row = this.db.prepare(`SELECT * FROM user_agents WHERE ${where}`).get(...args) as unknown as SqliteRow | undefined;
    return row ? fromSqlite(row) : null;
  }
  async createAgent(input: CreateUserDefinedAgentInput) {
    if (isBuiltinRoleId(normalizeRoleId(input.roleId))) throw new Error(`Role id "${input.roleId}" conflicts with a built-in Axiom role.`);
    const existing = this.db.prepare(`SELECT id FROM user_agents WHERE tenant_id = ? AND role_id = ? AND status != 'archived'`).get(input.tenantId, normalizeRoleId(input.roleId));
    if (existing) throw new Error(`Role id "${input.roleId}" is already in use by another agent in this tenant.`);
    const agent = createAgent(input);
    this.db.prepare(`INSERT INTO user_agents (id, tenant_id, role_id, name, description, icon, kind, status, visibility, version, definition_json, history_json, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(agent.id, agent.tenantId, agent.roleId, agent.name, agent.description, agent.icon ?? null, agent.kind, agent.status, agent.visibility, agent.version, JSON.stringify(agent.definition), JSON.stringify(agent.history), agent.createdBy, agent.createdAt, agent.updatedAt);
    return agent;
  }
  async updateAgent(agentId: string, tenantId: string, input: UpdateUserDefinedAgentInput) {
    const current = await this.getAgent(agentId, tenantId);
    if (!current) throw new Error('Agent not found.');
    if (current.status === 'archived' && input.status !== 'published') throw new Error('Archived agents cannot be edited.');
    const updated = updateValue(current, input);
    this.db.prepare(`UPDATE user_agents SET name = ?, description = ?, icon = ?, status = ?, visibility = ?, version = ?, definition_json = ?, history_json = ?, updated_at = ? WHERE id = ? AND tenant_id = ?`)
      .run(updated.name, updated.description, updated.icon ?? null, updated.status, updated.visibility, updated.version, JSON.stringify(updated.definition), JSON.stringify(updated.history), updated.updatedAt, agentId, tenantId);
    return updated;
  }
}

type PostgresRow = Omit<SqliteRow, 'version' | 'definition_json' | 'history_json' | 'created_at' | 'updated_at'> & { version: number | string; definition_json: UserDefinedAgentDefinition; history_json: UserDefinedAgent['history']; created_at: Date | string; updated_at: Date | string };
const fromPostgres = (row: PostgresRow): UserDefinedAgent => ({
  id: row.id, tenantId: row.tenant_id, roleId: row.role_id, name: row.name, description: row.description, ...(row.icon ? { icon: row.icon } : {}), kind: row.kind,
  status: row.status, visibility: row.visibility ?? 'private', version: Number(row.version), definition: row.definition_json,
  history: Array.isArray(row.history_json) ? row.history_json : [], createdBy: row.created_by,
  createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at, updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
});

export class PostgresAgentStore implements AgentStore {
  private readonly pool: Pool;
  constructor(connectionString: string) { this.pool = new Pool({ connectionString, max: Number(process.env.DATABASE_POOL_SIZE ?? 10), idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000, ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: true } : undefined }); }
  async initialize() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS user_agents (
        id UUID PRIMARY KEY, tenant_id TEXT NOT NULL, role_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', icon TEXT,
        kind TEXT NOT NULL DEFAULT 'worker', status TEXT NOT NULL DEFAULT 'draft', visibility TEXT NOT NULL DEFAULT 'private',
        version INTEGER NOT NULL DEFAULT 1, definition_json JSONB NOT NULL, history_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_user_agents_tenant_updated ON user_agents(tenant_id, updated_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_user_agents_tenant_role ON user_agents(tenant_id, role_id) WHERE status != 'archived';
    `);
  }
  async close() { await this.pool.end(); }
  async listAgents(tenantId: string, limit = 50, access?: TemplateAccess) {
    const max = Math.min(100, Math.max(1, limit));
    const result = canSeePrivate(access)
      ? await this.pool.query('SELECT * FROM user_agents WHERE tenant_id = $1 ORDER BY updated_at DESC LIMIT $2', [tenantId, max])
      : await this.pool.query('SELECT * FROM user_agents WHERE tenant_id = $1 AND (visibility = \'team\' OR created_by = $2) ORDER BY updated_at DESC LIMIT $3', [tenantId, access!.userId, max]);
    return result.rows.map((row) => fromPostgres(row as PostgresRow));
  }
  async getAgent(agentId: string, tenantId?: string, access?: TemplateAccess) {
    const result = tenantId
      ? (canSeePrivate(access) ? await this.pool.query('SELECT * FROM user_agents WHERE id = $1 AND tenant_id = $2', [agentId, tenantId]) : await this.pool.query('SELECT * FROM user_agents WHERE id = $1 AND tenant_id = $2 AND (visibility = \'team\' OR created_by = $3)', [agentId, tenantId, access!.userId]))
      : await this.pool.query('SELECT * FROM user_agents WHERE id = $1', [agentId]);
    return result.rows[0] ? fromPostgres(result.rows[0] as PostgresRow) : null;
  }
  async createAgent(input: CreateUserDefinedAgentInput) {
    if (isBuiltinRoleId(normalizeRoleId(input.roleId))) throw new Error(`Role id "${input.roleId}" conflicts with a built-in Axiom role.`);
    const existing = await this.pool.query(`SELECT id FROM user_agents WHERE tenant_id = $1 AND role_id = $2 AND status != 'archived'`, [input.tenantId, normalizeRoleId(input.roleId)]);
    if (existing.rows[0]) throw new Error(`Role id "${input.roleId}" is already in use by another agent in this tenant.`);
    const agent = createAgent(input);
    await this.pool.query('INSERT INTO user_agents (id, tenant_id, role_id, name, description, icon, kind, status, visibility, version, definition_json, history_json, created_by, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)', [agent.id, agent.tenantId, agent.roleId, agent.name, agent.description, agent.icon ?? null, agent.kind, agent.status, agent.visibility, agent.version, JSON.stringify(agent.definition), JSON.stringify(agent.history), agent.createdBy, agent.createdAt, agent.updatedAt]);
    return agent;
  }
  async updateAgent(agentId: string, tenantId: string, input: UpdateUserDefinedAgentInput) {
    const current = await this.getAgent(agentId, tenantId);
    if (!current) throw new Error('Agent not found.');
    if (current.status === 'archived' && input.status !== 'published') throw new Error('Archived agents cannot be edited.');
    const updated = updateValue(current, input);
    await this.pool.query('UPDATE user_agents SET name=$1, description=$2, icon=$3, status=$4, visibility=$5, version=$6, definition_json=$7, history_json=$8, updated_at=$9 WHERE id=$10 AND tenant_id=$11', [updated.name, updated.description, updated.icon ?? null, updated.status, updated.visibility, updated.version, JSON.stringify(updated.definition), JSON.stringify(updated.history), updated.updatedAt, agentId, tenantId]);
    return updated;
  }
}

export const createAgentStore = (): AgentStore => {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (databaseUrl) return new PostgresAgentStore(databaseUrl);
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_SQLITE_PRODUCTION !== 'true') throw new Error('DATABASE_URL is required in production. Set ALLOW_SQLITE_PRODUCTION=true only for single-node deployments.');
  return new SqliteAgentStore(process.env.AXIOM_SQLITE_PATH?.trim() || resolve(process.cwd(), '.data', 'axiom-control-room.sqlite'));
};
