import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Pool } from 'pg';
import type {
  CreateUserPluginInput,
  PluginStore,
  TemplateAccess,
  UpdateUserPluginInput,
  UserPlugin,
  UserPluginDefinition,
} from './contracts.js';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const now = () => new Date().toISOString();

const normalizeDefinition = (definition: UserPluginDefinition): UserPluginDefinition => {
  const fields = definition.inputSchema
    ? { inputSchema: { fields: definition.inputSchema.fields.slice(0, 16).map((field) => ({
      id: field.id.trim().slice(0, 80), label: field.label.trim().slice(0, 160), type: field.type,
      ...(field.required ? { required: true } : {}), ...(field.options ? { options: field.options.map((option) => option.trim().slice(0, 120)).filter(Boolean).slice(0, 32) } : {}),
    })) } }
    : {};
  if ('htmlContent' in definition) {
    const htmlContent = definition.htmlContent.trim();
    if (!htmlContent || htmlContent.length > 200_000) throw new Error('Mini-app HTML must be between 1 and 200KB.');
    const appearance = definition.appearance
      ? {
          appearance: {
            effect: definition.appearance.effect,
            hue: Math.min(359, Math.max(0, Math.floor(definition.appearance.hue))),
            seed: Math.min(999_999, Math.max(1, Math.floor(definition.appearance.seed))),
          },
        }
      : {};
    const designConversation = (definition.designConversation ?? []).slice(-24).map((message) => ({
      role: message.role,
      content: message.content.trim().slice(0, 4_000),
      createdAt: message.createdAt,
    })).filter((message) => message.content);
    return {
      mode: definition.mode,
      htmlContent,
      width: Math.min(1_200, Math.max(320, Math.floor(definition.width ?? 720))),
      height: Math.min(900, Math.max(240, Math.floor(definition.height ?? 520))),
      ...(definition.promptPrefix?.trim() ? { promptPrefix: definition.promptPrefix.trim().slice(0, 4_000) } : {}),
      ...(definition.model?.trim() ? { model: definition.model.trim().slice(0, 160) } : {}),
      toolNames: [...new Set((definition.toolNames ?? []).map((name) => name.trim()).filter(Boolean))].slice(0, 32),
      ...appearance,
      ...(definition.agentEnabled ? { agentEnabled: true } : {}),
      ...(definition.agentInstructions?.trim() ? { agentInstructions: definition.agentInstructions.trim().slice(0, 8_000) } : {}),
      ...(designConversation.length ? { designConversation } : {}),
      ...fields,
    };
  }
  return { mode: definition.mode, ...(definition.model?.trim() ? { model: definition.model.trim().slice(0, 160) } : {}), ...(definition.promptPrefix?.trim() ? { promptPrefix: definition.promptPrefix.trim().slice(0, 4_000) } : {}), toolNames: [...new Set((definition.toolNames ?? []).map((name) => name.trim()).filter(Boolean))].slice(0, 32), ...fields };
};

const createPlugin = (input: CreateUserPluginInput): UserPlugin => {
  const timestamp = now();
  return {
    id: randomUUID(),
    tenantId: input.tenantId,
    name: input.name.trim(),
    description: input.description.trim(),
    ...(input.icon?.trim() ? { icon: input.icon.trim().slice(0, 32) } : {}),
    kind: input.kind ?? 'prompt',
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

const updateValue = (current: UserPlugin, input: UpdateUserPluginInput): UserPlugin => {
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
  id: string; tenant_id: string; name: string; description: string; icon?: string;
  kind: UserPlugin['kind']; status: UserPlugin['status']; visibility: UserPlugin['visibility']; version: number;
  definition_json: string; history_json: string; created_by: string; created_at: string; updated_at: string;
};

const fromSqlite = (row: SqliteRow): UserPlugin => ({
  id: row.id, tenantId: row.tenant_id, name: row.name, description: row.description, ...(row.icon ? { icon: row.icon } : {}),
  kind: row.kind, status: row.status, visibility: row.visibility ?? 'private', version: row.version,
  definition: JSON.parse(row.definition_json) as UserPluginDefinition,
  history: JSON.parse(row.history_json) as UserPlugin['history'], createdBy: row.created_by,
  createdAt: row.created_at, updatedAt: row.updated_at,
});

const canSeePrivate = (access?: TemplateAccess) => !access || access.role === 'owner' || access.role === 'admin';

export class SqlitePluginStore implements PluginStore {
  private readonly db: DatabaseSync;
  constructor(path: string) { if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true }); this.db = new DatabaseSync(path); }
  async initialize() {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS user_plugins (
        id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', icon TEXT,
        kind TEXT NOT NULL DEFAULT 'prompt', status TEXT NOT NULL DEFAULT 'draft', visibility TEXT NOT NULL DEFAULT 'private',
        version INTEGER NOT NULL DEFAULT 1, definition_json TEXT NOT NULL, history_json TEXT NOT NULL DEFAULT '[]',
        created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_user_plugins_tenant_updated ON user_plugins(tenant_id, updated_at DESC);
    `);
  }
  async close() { this.db.close(); }
  async listPlugins(tenantId: string, limit = 50, access?: TemplateAccess) {
    const rows = this.db.prepare(`SELECT * FROM user_plugins WHERE tenant_id = ?${canSeePrivate(access) ? '' : ' AND (visibility = \'team\' OR created_by = ?)'} ORDER BY updated_at DESC LIMIT ?`)
      .all(...(canSeePrivate(access) ? [tenantId, Math.min(100, Math.max(1, limit))] : [tenantId, access!.userId, Math.min(100, Math.max(1, limit))])) as unknown as SqliteRow[];
    return rows.map(fromSqlite);
  }
  async getPlugin(pluginId: string, tenantId?: string, access?: TemplateAccess) {
    const where = tenantId ? `id = ? AND tenant_id = ?${canSeePrivate(access) ? '' : ' AND (visibility = \'team\' OR created_by = ?)'}` : 'id = ?';
    const args = tenantId ? (canSeePrivate(access) ? [pluginId, tenantId] : [pluginId, tenantId, access!.userId]) : [pluginId];
    const row = this.db.prepare(`SELECT * FROM user_plugins WHERE ${where}`).get(...args) as unknown as SqliteRow | undefined;
    return row ? fromSqlite(row) : null;
  }
  async createPlugin(input: CreateUserPluginInput) {
    const plugin = createPlugin(input);
    this.db.prepare(`INSERT INTO user_plugins (id, tenant_id, name, description, icon, kind, status, visibility, version, definition_json, history_json, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(plugin.id, plugin.tenantId, plugin.name, plugin.description, plugin.icon ?? null, plugin.kind, plugin.status, plugin.visibility, plugin.version, JSON.stringify(plugin.definition), JSON.stringify(plugin.history), plugin.createdBy, plugin.createdAt, plugin.updatedAt);
    return plugin;
  }
  async updatePlugin(pluginId: string, tenantId: string, input: UpdateUserPluginInput) {
    const current = await this.getPlugin(pluginId, tenantId);
    if (!current) throw new Error('Plugin not found.');
    if (current.status === 'archived' && input.status !== 'published') throw new Error('Archived plugins cannot be edited.');
    const updated = updateValue(current, input);
    this.db.prepare(`UPDATE user_plugins SET name = ?, description = ?, icon = ?, status = ?, visibility = ?, version = ?, definition_json = ?, history_json = ?, updated_at = ? WHERE id = ? AND tenant_id = ?`)
      .run(updated.name, updated.description, updated.icon ?? null, updated.status, updated.visibility, updated.version, JSON.stringify(updated.definition), JSON.stringify(updated.history), updated.updatedAt, pluginId, tenantId);
    return updated;
  }
  async deletePlugin(pluginId: string, tenantId: string) {
    return this.db.prepare('DELETE FROM user_plugins WHERE id = ? AND tenant_id = ?').run(pluginId, tenantId).changes > 0;
  }
}

type PostgresRow = Omit<SqliteRow, 'version' | 'definition_json' | 'history_json' | 'created_at' | 'updated_at'> & { version: number | string; definition_json: UserPluginDefinition; history_json: UserPlugin['history']; created_at: Date | string; updated_at: Date | string };
const fromPostgres = (row: PostgresRow): UserPlugin => ({
  id: row.id, tenantId: row.tenant_id, name: row.name, description: row.description, ...(row.icon ? { icon: row.icon } : {}), kind: row.kind,
  status: row.status, visibility: row.visibility ?? 'private', version: Number(row.version), definition: row.definition_json,
  history: Array.isArray(row.history_json) ? row.history_json : [], createdBy: row.created_by,
  createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at, updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
});

export class PostgresPluginStore implements PluginStore {
  private readonly pool: Pool;
  constructor(connectionString: string) { this.pool = new Pool({ connectionString, max: Number(process.env.DATABASE_POOL_SIZE ?? 10), idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000, ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: true } : undefined }); }
  async initialize() {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS user_plugins (id UUID PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', icon TEXT, kind TEXT NOT NULL DEFAULT 'prompt', status TEXT NOT NULL DEFAULT 'draft', visibility TEXT NOT NULL DEFAULT 'private', version INTEGER NOT NULL DEFAULT 1, definition_json JSONB NOT NULL, history_json JSONB NOT NULL DEFAULT '[]'::jsonb, created_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL); CREATE INDEX IF NOT EXISTS idx_user_plugins_tenant_updated ON user_plugins(tenant_id, updated_at DESC);`);
  }
  async close() { await this.pool.end(); }
  async listPlugins(tenantId: string, limit = 50, access?: TemplateAccess) {
    const max = Math.min(100, Math.max(1, limit));
    const result = canSeePrivate(access)
      ? await this.pool.query('SELECT * FROM user_plugins WHERE tenant_id = $1 ORDER BY updated_at DESC LIMIT $2', [tenantId, max])
      : await this.pool.query('SELECT * FROM user_plugins WHERE tenant_id = $1 AND (visibility = \'team\' OR created_by = $2) ORDER BY updated_at DESC LIMIT $3', [tenantId, access!.userId, max]);
    return result.rows.map((row) => fromPostgres(row as PostgresRow));
  }
  async getPlugin(pluginId: string, tenantId?: string, access?: TemplateAccess) {
    const result = tenantId
      ? (canSeePrivate(access) ? await this.pool.query('SELECT * FROM user_plugins WHERE id = $1 AND tenant_id = $2', [pluginId, tenantId]) : await this.pool.query('SELECT * FROM user_plugins WHERE id = $1 AND tenant_id = $2 AND (visibility = \'team\' OR created_by = $3)', [pluginId, tenantId, access!.userId]))
      : await this.pool.query('SELECT * FROM user_plugins WHERE id = $1', [pluginId]);
    return result.rows[0] ? fromPostgres(result.rows[0] as PostgresRow) : null;
  }
  async createPlugin(input: CreateUserPluginInput) {
    const plugin = createPlugin(input);
    await this.pool.query('INSERT INTO user_plugins (id, tenant_id, name, description, icon, kind, status, visibility, version, definition_json, history_json, created_by, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)', [plugin.id, plugin.tenantId, plugin.name, plugin.description, plugin.icon ?? null, plugin.kind, plugin.status, plugin.visibility, plugin.version, JSON.stringify(plugin.definition), JSON.stringify(plugin.history), plugin.createdBy, plugin.createdAt, plugin.updatedAt]);
    return plugin;
  }
  async updatePlugin(pluginId: string, tenantId: string, input: UpdateUserPluginInput) {
    const current = await this.getPlugin(pluginId, tenantId);
    if (!current) throw new Error('Plugin not found.');
    if (current.status === 'archived' && input.status !== 'published') throw new Error('Archived plugins cannot be edited.');
    const updated = updateValue(current, input);
    await this.pool.query('UPDATE user_plugins SET name=$1, description=$2, icon=$3, status=$4, visibility=$5, version=$6, definition_json=$7, history_json=$8, updated_at=$9 WHERE id=$10 AND tenant_id=$11', [updated.name, updated.description, updated.icon ?? null, updated.status, updated.visibility, updated.version, JSON.stringify(updated.definition), JSON.stringify(updated.history), updated.updatedAt, pluginId, tenantId]);
    return updated;
  }
  async deletePlugin(pluginId: string, tenantId: string) {
    const result = await this.pool.query('DELETE FROM user_plugins WHERE id = $1 AND tenant_id = $2', [pluginId, tenantId]);
    return (result.rowCount ?? 0) > 0;
  }
}

export const createPluginStore = (): PluginStore => {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (databaseUrl) return new PostgresPluginStore(databaseUrl);
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_SQLITE_PRODUCTION !== 'true') throw new Error('DATABASE_URL is required in production. Set ALLOW_SQLITE_PRODUCTION=true only for single-node deployments.');
  return new SqlitePluginStore(process.env.AXIOM_SQLITE_PATH?.trim() || resolve(process.cwd(), '.data', 'axiom-control-room.sqlite'));
};
