import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Pool } from 'pg';
import type {
  CreateUserPluginInput,
  PluginInstallation,
  PluginMarketEntry,
  PluginMarketRelease,
  PluginStore,
  PluginRelease,
  PluginVersionSnapshot,
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

const versionSnapshot = (plugin: UserPlugin, updatedBy: string): PluginVersionSnapshot => ({
  version: plugin.version,
  definition: clone(plugin.definition),
  name: plugin.name,
  description: plugin.description,
  ...(plugin.icon ? { icon: plugin.icon } : {}),
  visibility: plugin.visibility,
  ...(plugin.release ? { release: clone(plugin.release) } : {}),
  updatedAt: plugin.updatedAt,
  updatedBy,
});

const updateValue = (current: UserPlugin, input: UpdateUserPluginInput): UserPlugin => {
  const changed = input.definition !== undefined || input.name !== undefined || input.description !== undefined || input.icon !== undefined || input.visibility !== undefined;
  const timestamp = now();
  const history = changed
    ? [...current.history, versionSnapshot(current, input.updatedBy)]
    : current.history;
  return {
    ...current,
    ...(input.name !== undefined ? { name: input.name.trim() } : {}),
    ...(input.description !== undefined ? { description: input.description.trim() } : {}),
    ...(input.icon !== undefined ? { icon: input.icon.trim().slice(0, 32) } : {}),
    ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
    ...(changed ? { status: 'draft' as const } : input.status !== undefined ? { status: input.status } : {}),
    ...(input.definition !== undefined ? { definition: normalizeDefinition(input.definition) } : {}),
    version: changed ? current.version + 1 : current.version,
    history: history.slice(-30),
    ...(changed ? { release: undefined } : {}),
    updatedAt: timestamp,
  };
};

const publishValue = (current: UserPlugin, release: PluginRelease): UserPlugin => {
  if (release.pluginVersion !== current.version) throw new Error('Plugin version changed before publishing.');
  return { ...current, status: 'published', release: clone(release), updatedAt: now() };
};

const rollbackValue = (current: UserPlugin, version: number, updatedBy: string): UserPlugin => {
  const target = current.history.find((snapshot) => snapshot.version === version);
  if (!target) throw new Error('Plugin version not found.');
  return {
    ...current,
    name: target.name ?? current.name,
    description: target.description ?? current.description,
    icon: target.icon,
    visibility: target.visibility ?? current.visibility,
    status: 'draft',
    version: current.version + 1,
    definition: clone(target.definition),
    history: [...current.history, versionSnapshot(current, updatedBy)].slice(-30),
    release: undefined,
    updatedAt: now(),
  };
};

const marketSnapshot = (plugin: UserPlugin): UserPlugin => {
  const definition = clone(plugin.definition);
  if ('htmlContent' in definition) delete definition.designConversation;
  return { ...clone(plugin), definition, history: [] };
};

const marketReleaseValue = (plugin: UserPlugin, submittedBy: string): PluginMarketRelease => ({
  tenantId: plugin.tenantId,
  pluginId: plugin.id,
  pluginVersion: plugin.version,
  plugin: marketSnapshot(plugin),
  status: 'pending',
  submittedBy,
  submittedAt: now(),
});

type SqliteRow = {
  id: string; tenant_id: string; name: string; description: string; icon?: string;
  kind: UserPlugin['kind']; status: UserPlugin['status']; visibility: UserPlugin['visibility']; version: number;
  definition_json: string; history_json: string; release_json?: string | null; created_by: string; created_at: string; updated_at: string;
};

type SqliteMarketRow = {
  tenant_id: string; plugin_id: string; plugin_version: number; snapshot_json: string;
  status: PluginMarketRelease['status']; submitted_by: string; submitted_at: string;
  reviewed_by?: string | null; reviewed_at?: string | null; review_note?: string | null;
  revoked_by?: string | null; revoked_at?: string | null;
};

type SqliteInstallationRow = {
  tenant_id: string; user_id: string; plugin_id: string; plugin_version: number;
  installed_at: string; updated_at: string;
};

const fromSqlite = (row: SqliteRow): UserPlugin => ({
  id: row.id, tenantId: row.tenant_id, name: row.name, description: row.description, ...(row.icon ? { icon: row.icon } : {}),
  kind: row.kind, status: row.status, visibility: row.visibility ?? 'private', version: row.version,
  definition: JSON.parse(row.definition_json) as UserPluginDefinition,
  history: JSON.parse(row.history_json) as UserPlugin['history'], createdBy: row.created_by,
  ...(row.release_json ? { release: JSON.parse(row.release_json) as PluginRelease } : {}),
  createdAt: row.created_at, updatedAt: row.updated_at,
});

const marketFromSqlite = (row: SqliteMarketRow): PluginMarketRelease => ({
  tenantId: row.tenant_id,
  pluginId: row.plugin_id,
  pluginVersion: Number(row.plugin_version),
  plugin: JSON.parse(row.snapshot_json) as UserPlugin,
  status: row.status,
  submittedBy: row.submitted_by,
  submittedAt: row.submitted_at,
  ...(row.reviewed_by ? { reviewedBy: row.reviewed_by } : {}),
  ...(row.reviewed_at ? { reviewedAt: row.reviewed_at } : {}),
  ...(row.review_note ? { reviewNote: row.review_note } : {}),
  ...(row.revoked_by ? { revokedBy: row.revoked_by } : {}),
  ...(row.revoked_at ? { revokedAt: row.revoked_at } : {}),
});

const installationFromSqlite = (row: SqliteInstallationRow): PluginInstallation => ({
  tenantId: row.tenant_id,
  userId: row.user_id,
  pluginId: row.plugin_id,
  pluginVersion: Number(row.plugin_version),
  installedAt: row.installed_at,
  updatedAt: row.updated_at,
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
        version INTEGER NOT NULL DEFAULT 1, definition_json TEXT NOT NULL, history_json TEXT NOT NULL DEFAULT '[]', release_json TEXT,
        created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_user_plugins_tenant_updated ON user_plugins(tenant_id, updated_at DESC);
      CREATE TABLE IF NOT EXISTS plugin_market_releases (
        tenant_id TEXT NOT NULL, plugin_id TEXT NOT NULL, plugin_version INTEGER NOT NULL, snapshot_json TEXT NOT NULL,
        status TEXT NOT NULL, submitted_by TEXT NOT NULL, submitted_at TEXT NOT NULL,
        reviewed_by TEXT, reviewed_at TEXT, review_note TEXT, revoked_by TEXT, revoked_at TEXT,
        PRIMARY KEY (tenant_id, plugin_id, plugin_version)
      );
      CREATE INDEX IF NOT EXISTS idx_plugin_market_review ON plugin_market_releases(tenant_id, status, submitted_at DESC);
      CREATE TABLE IF NOT EXISTS plugin_installations (
        tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, plugin_id TEXT NOT NULL, plugin_version INTEGER NOT NULL,
        installed_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, user_id, plugin_id)
      );
      CREATE INDEX IF NOT EXISTS idx_plugin_installations_user ON plugin_installations(tenant_id, user_id, updated_at DESC);
    `);
    const columns = this.db.prepare('PRAGMA table_info(user_plugins)').all() as unknown as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'release_json')) this.db.exec('ALTER TABLE user_plugins ADD COLUMN release_json TEXT');
  }
  async close() { this.db.close(); }
  async listPlugins(tenantId: string, limit = 50, access?: TemplateAccess) {
    const rows = this.db.prepare(`SELECT * FROM user_plugins WHERE tenant_id = ?${canSeePrivate(access) ? '' : ' AND ((visibility = \'team\' AND status = \'published\') OR created_by = ?)'} ORDER BY updated_at DESC LIMIT ?`)
      .all(...(canSeePrivate(access) ? [tenantId, Math.min(100, Math.max(1, limit))] : [tenantId, access!.userId, Math.min(100, Math.max(1, limit))])) as unknown as SqliteRow[];
    return rows.map(fromSqlite);
  }
  async getPlugin(pluginId: string, tenantId?: string, access?: TemplateAccess) {
    const where = tenantId ? `id = ? AND tenant_id = ?${canSeePrivate(access) ? '' : ' AND ((visibility = \'team\' AND status = \'published\') OR created_by = ?)'}` : 'id = ?';
    const args = tenantId ? (canSeePrivate(access) ? [pluginId, tenantId] : [pluginId, tenantId, access!.userId]) : [pluginId];
    const row = this.db.prepare(`SELECT * FROM user_plugins WHERE ${where}`).get(...args) as unknown as SqliteRow | undefined;
    return row ? fromSqlite(row) : null;
  }
  async createPlugin(input: CreateUserPluginInput) {
    const plugin = createPlugin(input);
    this.db.prepare(`INSERT INTO user_plugins (id, tenant_id, name, description, icon, kind, status, visibility, version, definition_json, history_json, release_json, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(plugin.id, plugin.tenantId, plugin.name, plugin.description, plugin.icon ?? null, plugin.kind, plugin.status, plugin.visibility, plugin.version, JSON.stringify(plugin.definition), JSON.stringify(plugin.history), null, plugin.createdBy, plugin.createdAt, plugin.updatedAt);
    return plugin;
  }
  async updatePlugin(pluginId: string, tenantId: string, input: UpdateUserPluginInput) {
    const current = await this.getPlugin(pluginId, tenantId);
    if (!current) throw new Error('Plugin not found.');
    if (current.status === 'archived' && input.status !== 'published') throw new Error('Archived plugins cannot be edited.');
    const updated = updateValue(current, input);
    this.db.prepare(`UPDATE user_plugins SET name = ?, description = ?, icon = ?, status = ?, visibility = ?, version = ?, definition_json = ?, history_json = ?, release_json = ?, updated_at = ? WHERE id = ? AND tenant_id = ?`)
      .run(updated.name, updated.description, updated.icon ?? null, updated.status, updated.visibility, updated.version, JSON.stringify(updated.definition), JSON.stringify(updated.history), updated.release ? JSON.stringify(updated.release) : null, updated.updatedAt, pluginId, tenantId);
    return updated;
  }
  async publishPlugin(pluginId: string, tenantId: string, release: PluginRelease) {
    const current = await this.getPlugin(pluginId, tenantId);
    if (!current) throw new Error('Plugin not found.');
    if (current.status === 'archived') throw new Error('Archived plugins cannot be published.');
    const updated = publishValue(current, release);
    const result = this.db.prepare('UPDATE user_plugins SET status = ?, release_json = ?, updated_at = ? WHERE id = ? AND tenant_id = ? AND version = ?')
      .run(updated.status, JSON.stringify(updated.release), updated.updatedAt, pluginId, tenantId, current.version);
    if (result.changes !== 1) throw new Error('Plugin version changed before publishing.');
    return updated;
  }
  async rollbackPlugin(pluginId: string, tenantId: string, version: number, updatedBy: string) {
    const current = await this.getPlugin(pluginId, tenantId);
    if (!current) throw new Error('Plugin not found.');
    if (current.status === 'archived') throw new Error('Archived plugins cannot be rolled back.');
    const updated = rollbackValue(current, version, updatedBy);
    const result = this.db.prepare(`UPDATE user_plugins SET name = ?, description = ?, icon = ?, status = ?, visibility = ?, version = ?, definition_json = ?, history_json = ?, release_json = NULL, updated_at = ? WHERE id = ? AND tenant_id = ? AND version = ?`)
      .run(updated.name, updated.description, updated.icon ?? null, updated.status, updated.visibility, updated.version, JSON.stringify(updated.definition), JSON.stringify(updated.history), updated.updatedAt, pluginId, tenantId, current.version);
    if (result.changes !== 1) throw new Error('Plugin version changed before rollback.');
    return updated;
  }
  async submitPluginToMarket(plugin: UserPlugin, submittedBy: string) {
    const existing = await this.getMarketRelease(plugin.id, plugin.tenantId, plugin.version);
    if (existing?.status === 'pending' || existing?.status === 'approved') return existing;
    const release = marketReleaseValue(plugin, submittedBy);
    this.db.prepare(`INSERT INTO plugin_market_releases (
      tenant_id, plugin_id, plugin_version, snapshot_json, status, submitted_by, submitted_at,
      reviewed_by, reviewed_at, review_note, revoked_by, revoked_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL)
    ON CONFLICT(tenant_id, plugin_id, plugin_version) DO UPDATE SET
      snapshot_json=excluded.snapshot_json, status='pending', submitted_by=excluded.submitted_by,
      submitted_at=excluded.submitted_at, reviewed_by=NULL, reviewed_at=NULL, review_note=NULL,
      revoked_by=NULL, revoked_at=NULL`)
      .run(release.tenantId, release.pluginId, release.pluginVersion, JSON.stringify(release.plugin), release.status, release.submittedBy, release.submittedAt);
    return release;
  }
  async listMarketplace(tenantId: string, userId: string, limit = 50, query = '') {
    const rows = this.db.prepare(`SELECT * FROM plugin_market_releases WHERE tenant_id = ? AND status = 'approved' ORDER BY plugin_version DESC, reviewed_at DESC`)
      .all(tenantId) as unknown as SqliteMarketRow[];
    const normalizedQuery = query.trim().toLocaleLowerCase('zh-CN').slice(0, 120);
    const latest = new Map<string, PluginMarketRelease>();
    for (const row of rows) {
      const release = marketFromSqlite(row);
      if (latest.has(release.pluginId)) continue;
      const searchable = `${release.plugin.name} ${release.plugin.description} ${release.submittedBy}`.toLocaleLowerCase('zh-CN');
      if (normalizedQuery && !searchable.includes(normalizedQuery)) continue;
      latest.set(release.pluginId, release);
      if (latest.size >= Math.min(100, Math.max(1, limit))) break;
    }
    const installations = this.db.prepare('SELECT * FROM plugin_installations WHERE tenant_id = ? AND user_id = ?')
      .all(tenantId, userId) as unknown as SqliteInstallationRow[];
    const installedByPlugin = new Map(installations.map((row) => [row.plugin_id, installationFromSqlite(row)]));
    return [...latest.values()].map((release): PluginMarketEntry => {
      const installation = installedByPlugin.get(release.pluginId);
      return {
        release,
        ...(installation ? { installation } : {}),
        updateAvailable: Boolean(installation && installation.pluginVersion !== release.pluginVersion),
      };
    });
  }
  async listMarketReviews(tenantId: string, limit = 50) {
    const rows = this.db.prepare(`SELECT * FROM plugin_market_releases WHERE tenant_id = ? AND status = 'pending' ORDER BY submitted_at ASC LIMIT ?`)
      .all(tenantId, Math.min(100, Math.max(1, limit))) as unknown as SqliteMarketRow[];
    return rows.map(marketFromSqlite);
  }
  async getMarketRelease(pluginId: string, tenantId: string, version?: number) {
    const row = version === undefined
      ? this.db.prepare(`SELECT * FROM plugin_market_releases WHERE plugin_id = ? AND tenant_id = ? AND status = 'approved' ORDER BY plugin_version DESC LIMIT 1`).get(pluginId, tenantId)
      : this.db.prepare('SELECT * FROM plugin_market_releases WHERE plugin_id = ? AND tenant_id = ? AND plugin_version = ?').get(pluginId, tenantId, version);
    return row ? marketFromSqlite(row as unknown as SqliteMarketRow) : null;
  }
  async reviewMarketRelease(pluginId: string, tenantId: string, version: number, decision: 'approved' | 'rejected', reviewedBy: string, note = '') {
    const reviewedAt = now();
    const result = this.db.prepare(`UPDATE plugin_market_releases SET status = ?, reviewed_by = ?, reviewed_at = ?, review_note = ?, revoked_by = NULL, revoked_at = NULL
      WHERE plugin_id = ? AND tenant_id = ? AND plugin_version = ? AND status = 'pending'`)
      .run(decision, reviewedBy, reviewedAt, note.trim().slice(0, 1_000) || null, pluginId, tenantId, version);
    if (result.changes !== 1) throw new Error('Plugin market review is no longer pending.');
    const release = await this.getMarketRelease(pluginId, tenantId, version);
    if (!release) throw new Error('Plugin market release not found.');
    return release;
  }
  async revokeMarketRelease(pluginId: string, tenantId: string, version: number, revokedBy: string, note = '') {
    const revokedAt = now();
    const result = this.db.prepare(`UPDATE plugin_market_releases SET status = 'revoked', revoked_by = ?, revoked_at = ?, review_note = ?
      WHERE plugin_id = ? AND tenant_id = ? AND plugin_version = ? AND status = 'approved'`)
      .run(revokedBy, revokedAt, note.trim().slice(0, 1_000) || null, pluginId, tenantId, version);
    if (result.changes !== 1) throw new Error('Only an approved plugin market release can be revoked.');
    const release = await this.getMarketRelease(pluginId, tenantId, version);
    if (!release) throw new Error('Plugin market release not found.');
    return release;
  }
  async getPluginInstallation(pluginId: string, tenantId: string, userId: string) {
    const row = this.db.prepare('SELECT * FROM plugin_installations WHERE plugin_id = ? AND tenant_id = ? AND user_id = ?')
      .get(pluginId, tenantId, userId) as unknown as SqliteInstallationRow | undefined;
    return row ? installationFromSqlite(row) : null;
  }
  async installMarketRelease(pluginId: string, tenantId: string, userId: string) {
    const release = await this.getMarketRelease(pluginId, tenantId);
    if (!release) throw new Error('No approved plugin market release is available.');
    const timestamp = now();
    this.db.prepare(`INSERT INTO plugin_installations (tenant_id, user_id, plugin_id, plugin_version, installed_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(tenant_id, user_id, plugin_id) DO NOTHING`)
      .run(tenantId, userId, pluginId, release.pluginVersion, timestamp, timestamp);
    const installation = await this.getPluginInstallation(pluginId, tenantId, userId);
    if (!installation) throw new Error('Plugin installation failed.');
    return installation;
  }
  async upgradeMarketRelease(pluginId: string, tenantId: string, userId: string) {
    const installation = await this.getPluginInstallation(pluginId, tenantId, userId);
    if (!installation) throw new Error('Plugin is not installed.');
    const release = await this.getMarketRelease(pluginId, tenantId);
    if (!release) throw new Error('No approved plugin market release is available.');
    if (release.pluginVersion === installation.pluginVersion) return installation;
    this.db.prepare('UPDATE plugin_installations SET plugin_version = ?, updated_at = ? WHERE plugin_id = ? AND tenant_id = ? AND user_id = ?')
      .run(release.pluginVersion, now(), pluginId, tenantId, userId);
    return (await this.getPluginInstallation(pluginId, tenantId, userId))!;
  }
  async uninstallPlugin(pluginId: string, tenantId: string, userId: string) {
    return this.db.prepare('DELETE FROM plugin_installations WHERE plugin_id = ? AND tenant_id = ? AND user_id = ?').run(pluginId, tenantId, userId).changes > 0;
  }
  async deletePlugin(pluginId: string, tenantId: string) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM plugin_installations WHERE plugin_id = ? AND tenant_id = ?').run(pluginId, tenantId);
      this.db.prepare('DELETE FROM plugin_market_releases WHERE plugin_id = ? AND tenant_id = ?').run(pluginId, tenantId);
      const deleted = this.db.prepare('DELETE FROM user_plugins WHERE id = ? AND tenant_id = ?').run(pluginId, tenantId).changes > 0;
      this.db.exec('COMMIT');
      return deleted;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}

type PostgresRow = Omit<SqliteRow, 'version' | 'definition_json' | 'history_json' | 'release_json' | 'created_at' | 'updated_at'> & { version: number | string; definition_json: UserPluginDefinition; history_json: UserPlugin['history']; release_json?: PluginRelease | null; created_at: Date | string; updated_at: Date | string };
type PostgresMarketRow = Omit<SqliteMarketRow, 'plugin_version' | 'snapshot_json' | 'submitted_at' | 'reviewed_at' | 'revoked_at'> & {
  plugin_version: number | string; snapshot_json: UserPlugin | string; submitted_at: Date | string;
  reviewed_at?: Date | string | null; revoked_at?: Date | string | null;
};
type PostgresInstallationRow = Omit<SqliteInstallationRow, 'plugin_version' | 'installed_at' | 'updated_at'> & {
  plugin_version: number | string; installed_at: Date | string; updated_at: Date | string;
};
const fromPostgres = (row: PostgresRow): UserPlugin => ({
  id: row.id, tenantId: row.tenant_id, name: row.name, description: row.description, ...(row.icon ? { icon: row.icon } : {}), kind: row.kind,
  status: row.status, visibility: row.visibility ?? 'private', version: Number(row.version), definition: row.definition_json,
  history: Array.isArray(row.history_json) ? row.history_json : [], createdBy: row.created_by,
  ...(row.release_json ? { release: row.release_json } : {}),
  createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at, updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
});

const marketFromPostgres = (row: PostgresMarketRow): PluginMarketRelease => ({
  tenantId: row.tenant_id,
  pluginId: row.plugin_id,
  pluginVersion: Number(row.plugin_version),
  plugin: typeof row.snapshot_json === 'string' ? JSON.parse(row.snapshot_json) as UserPlugin : row.snapshot_json,
  status: row.status,
  submittedBy: row.submitted_by,
  submittedAt: row.submitted_at instanceof Date ? row.submitted_at.toISOString() : row.submitted_at,
  ...(row.reviewed_by ? { reviewedBy: row.reviewed_by } : {}),
  ...(row.reviewed_at ? { reviewedAt: row.reviewed_at instanceof Date ? row.reviewed_at.toISOString() : row.reviewed_at } : {}),
  ...(row.review_note ? { reviewNote: row.review_note } : {}),
  ...(row.revoked_by ? { revokedBy: row.revoked_by } : {}),
  ...(row.revoked_at ? { revokedAt: row.revoked_at instanceof Date ? row.revoked_at.toISOString() : row.revoked_at } : {}),
});

const installationFromPostgres = (row: PostgresInstallationRow): PluginInstallation => ({
  tenantId: row.tenant_id,
  userId: row.user_id,
  pluginId: row.plugin_id,
  pluginVersion: Number(row.plugin_version),
  installedAt: row.installed_at instanceof Date ? row.installed_at.toISOString() : row.installed_at,
  updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
});

export class PostgresPluginStore implements PluginStore {
  private readonly pool: Pool;
  constructor(connectionString: string) { this.pool = new Pool({ connectionString, max: Number(process.env.DATABASE_POOL_SIZE ?? 10), idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000, ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: true } : undefined }); }
  async initialize() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS user_plugins (id UUID PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', icon TEXT, kind TEXT NOT NULL DEFAULT 'prompt', status TEXT NOT NULL DEFAULT 'draft', visibility TEXT NOT NULL DEFAULT 'private', version INTEGER NOT NULL DEFAULT 1, definition_json JSONB NOT NULL, history_json JSONB NOT NULL DEFAULT '[]'::jsonb, release_json JSONB, created_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL);
      ALTER TABLE user_plugins ADD COLUMN IF NOT EXISTS release_json JSONB;
      CREATE INDEX IF NOT EXISTS idx_user_plugins_tenant_updated ON user_plugins(tenant_id, updated_at DESC);
      CREATE TABLE IF NOT EXISTS plugin_market_releases (
        tenant_id TEXT NOT NULL, plugin_id UUID NOT NULL, plugin_version INTEGER NOT NULL, snapshot_json JSONB NOT NULL,
        status TEXT NOT NULL, submitted_by TEXT NOT NULL, submitted_at TIMESTAMPTZ NOT NULL,
        reviewed_by TEXT, reviewed_at TIMESTAMPTZ, review_note TEXT, revoked_by TEXT, revoked_at TIMESTAMPTZ,
        PRIMARY KEY (tenant_id, plugin_id, plugin_version)
      );
      CREATE INDEX IF NOT EXISTS idx_plugin_market_review ON plugin_market_releases(tenant_id, status, submitted_at DESC);
      CREATE TABLE IF NOT EXISTS plugin_installations (
        tenant_id TEXT NOT NULL, user_id TEXT NOT NULL, plugin_id UUID NOT NULL, plugin_version INTEGER NOT NULL,
        installed_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (tenant_id, user_id, plugin_id)
      );
      CREATE INDEX IF NOT EXISTS idx_plugin_installations_user ON plugin_installations(tenant_id, user_id, updated_at DESC);
    `);
  }
  async close() { await this.pool.end(); }
  async listPlugins(tenantId: string, limit = 50, access?: TemplateAccess) {
    const max = Math.min(100, Math.max(1, limit));
    const result = canSeePrivate(access)
      ? await this.pool.query('SELECT * FROM user_plugins WHERE tenant_id = $1 ORDER BY updated_at DESC LIMIT $2', [tenantId, max])
      : await this.pool.query('SELECT * FROM user_plugins WHERE tenant_id = $1 AND ((visibility = \'team\' AND status = \'published\') OR created_by = $2) ORDER BY updated_at DESC LIMIT $3', [tenantId, access!.userId, max]);
    return result.rows.map((row) => fromPostgres(row as PostgresRow));
  }
  async getPlugin(pluginId: string, tenantId?: string, access?: TemplateAccess) {
    const result = tenantId
      ? (canSeePrivate(access) ? await this.pool.query('SELECT * FROM user_plugins WHERE id = $1 AND tenant_id = $2', [pluginId, tenantId]) : await this.pool.query('SELECT * FROM user_plugins WHERE id = $1 AND tenant_id = $2 AND ((visibility = \'team\' AND status = \'published\') OR created_by = $3)', [pluginId, tenantId, access!.userId]))
      : await this.pool.query('SELECT * FROM user_plugins WHERE id = $1', [pluginId]);
    return result.rows[0] ? fromPostgres(result.rows[0] as PostgresRow) : null;
  }
  async createPlugin(input: CreateUserPluginInput) {
    const plugin = createPlugin(input);
    await this.pool.query('INSERT INTO user_plugins (id, tenant_id, name, description, icon, kind, status, visibility, version, definition_json, history_json, release_json, created_by, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)', [plugin.id, plugin.tenantId, plugin.name, plugin.description, plugin.icon ?? null, plugin.kind, plugin.status, plugin.visibility, plugin.version, JSON.stringify(plugin.definition), JSON.stringify(plugin.history), null, plugin.createdBy, plugin.createdAt, plugin.updatedAt]);
    return plugin;
  }
  async updatePlugin(pluginId: string, tenantId: string, input: UpdateUserPluginInput) {
    const current = await this.getPlugin(pluginId, tenantId);
    if (!current) throw new Error('Plugin not found.');
    if (current.status === 'archived' && input.status !== 'published') throw new Error('Archived plugins cannot be edited.');
    const updated = updateValue(current, input);
    await this.pool.query('UPDATE user_plugins SET name=$1, description=$2, icon=$3, status=$4, visibility=$5, version=$6, definition_json=$7, history_json=$8, release_json=$9, updated_at=$10 WHERE id=$11 AND tenant_id=$12', [updated.name, updated.description, updated.icon ?? null, updated.status, updated.visibility, updated.version, JSON.stringify(updated.definition), JSON.stringify(updated.history), updated.release ? JSON.stringify(updated.release) : null, updated.updatedAt, pluginId, tenantId]);
    return updated;
  }
  async publishPlugin(pluginId: string, tenantId: string, release: PluginRelease) {
    const current = await this.getPlugin(pluginId, tenantId);
    if (!current) throw new Error('Plugin not found.');
    if (current.status === 'archived') throw new Error('Archived plugins cannot be published.');
    const updated = publishValue(current, release);
    const result = await this.pool.query('UPDATE user_plugins SET status=$1, release_json=$2, updated_at=$3 WHERE id=$4 AND tenant_id=$5 AND version=$6', [updated.status, JSON.stringify(updated.release), updated.updatedAt, pluginId, tenantId, current.version]);
    if (result.rowCount !== 1) throw new Error('Plugin version changed before publishing.');
    return updated;
  }
  async rollbackPlugin(pluginId: string, tenantId: string, version: number, updatedBy: string) {
    const current = await this.getPlugin(pluginId, tenantId);
    if (!current) throw new Error('Plugin not found.');
    if (current.status === 'archived') throw new Error('Archived plugins cannot be rolled back.');
    const updated = rollbackValue(current, version, updatedBy);
    const result = await this.pool.query('UPDATE user_plugins SET name=$1, description=$2, icon=$3, status=$4, visibility=$5, version=$6, definition_json=$7, history_json=$8, release_json=NULL, updated_at=$9 WHERE id=$10 AND tenant_id=$11 AND version=$12', [updated.name, updated.description, updated.icon ?? null, updated.status, updated.visibility, updated.version, JSON.stringify(updated.definition), JSON.stringify(updated.history), updated.updatedAt, pluginId, tenantId, current.version]);
    if (result.rowCount !== 1) throw new Error('Plugin version changed before rollback.');
    return updated;
  }
  async submitPluginToMarket(plugin: UserPlugin, submittedBy: string) {
    const existing = await this.getMarketRelease(plugin.id, plugin.tenantId, plugin.version);
    if (existing?.status === 'pending' || existing?.status === 'approved') return existing;
    const release = marketReleaseValue(plugin, submittedBy);
    await this.pool.query(`INSERT INTO plugin_market_releases (
      tenant_id, plugin_id, plugin_version, snapshot_json, status, submitted_by, submitted_at,
      reviewed_by, reviewed_at, review_note, revoked_by, revoked_at
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,NULL,NULL,NULL,NULL,NULL)
    ON CONFLICT(tenant_id, plugin_id, plugin_version) DO UPDATE SET
      snapshot_json=EXCLUDED.snapshot_json, status='pending', submitted_by=EXCLUDED.submitted_by,
      submitted_at=EXCLUDED.submitted_at, reviewed_by=NULL, reviewed_at=NULL, review_note=NULL,
      revoked_by=NULL, revoked_at=NULL`, [release.tenantId, release.pluginId, release.pluginVersion, JSON.stringify(release.plugin), release.status, release.submittedBy, release.submittedAt]);
    return release;
  }
  async listMarketplace(tenantId: string, userId: string, limit = 50, query = '') {
    const result = await this.pool.query(`SELECT * FROM plugin_market_releases WHERE tenant_id = $1 AND status = 'approved' ORDER BY plugin_version DESC, reviewed_at DESC`, [tenantId]);
    const normalizedQuery = query.trim().toLocaleLowerCase('zh-CN').slice(0, 120);
    const latest = new Map<string, PluginMarketRelease>();
    for (const row of result.rows) {
      const release = marketFromPostgres(row as PostgresMarketRow);
      if (latest.has(release.pluginId)) continue;
      const searchable = `${release.plugin.name} ${release.plugin.description} ${release.submittedBy}`.toLocaleLowerCase('zh-CN');
      if (normalizedQuery && !searchable.includes(normalizedQuery)) continue;
      latest.set(release.pluginId, release);
      if (latest.size >= Math.min(100, Math.max(1, limit))) break;
    }
    const installationsResult = await this.pool.query('SELECT * FROM plugin_installations WHERE tenant_id = $1 AND user_id = $2', [tenantId, userId]);
    const installedByPlugin = new Map(installationsResult.rows.map((row) => {
      const installation = installationFromPostgres(row as PostgresInstallationRow);
      return [installation.pluginId, installation] as const;
    }));
    return [...latest.values()].map((release): PluginMarketEntry => {
      const installation = installedByPlugin.get(release.pluginId);
      return {
        release,
        ...(installation ? { installation } : {}),
        updateAvailable: Boolean(installation && installation.pluginVersion !== release.pluginVersion),
      };
    });
  }
  async listMarketReviews(tenantId: string, limit = 50) {
    const result = await this.pool.query(`SELECT * FROM plugin_market_releases WHERE tenant_id = $1 AND status = 'pending' ORDER BY submitted_at ASC LIMIT $2`, [tenantId, Math.min(100, Math.max(1, limit))]);
    return result.rows.map((row) => marketFromPostgres(row as PostgresMarketRow));
  }
  async getMarketRelease(pluginId: string, tenantId: string, version?: number) {
    const result = version === undefined
      ? await this.pool.query(`SELECT * FROM plugin_market_releases WHERE plugin_id = $1 AND tenant_id = $2 AND status = 'approved' ORDER BY plugin_version DESC LIMIT 1`, [pluginId, tenantId])
      : await this.pool.query('SELECT * FROM plugin_market_releases WHERE plugin_id = $1 AND tenant_id = $2 AND plugin_version = $3', [pluginId, tenantId, version]);
    return result.rows[0] ? marketFromPostgres(result.rows[0] as PostgresMarketRow) : null;
  }
  async reviewMarketRelease(pluginId: string, tenantId: string, version: number, decision: 'approved' | 'rejected', reviewedBy: string, note = '') {
    const result = await this.pool.query(`UPDATE plugin_market_releases SET status=$1, reviewed_by=$2, reviewed_at=$3, review_note=$4, revoked_by=NULL, revoked_at=NULL
      WHERE plugin_id=$5 AND tenant_id=$6 AND plugin_version=$7 AND status='pending' RETURNING *`, [decision, reviewedBy, now(), note.trim().slice(0, 1_000) || null, pluginId, tenantId, version]);
    if (result.rowCount !== 1) throw new Error('Plugin market review is no longer pending.');
    return marketFromPostgres(result.rows[0] as PostgresMarketRow);
  }
  async revokeMarketRelease(pluginId: string, tenantId: string, version: number, revokedBy: string, note = '') {
    const result = await this.pool.query(`UPDATE plugin_market_releases SET status='revoked', revoked_by=$1, revoked_at=$2, review_note=$3
      WHERE plugin_id=$4 AND tenant_id=$5 AND plugin_version=$6 AND status='approved' RETURNING *`, [revokedBy, now(), note.trim().slice(0, 1_000) || null, pluginId, tenantId, version]);
    if (result.rowCount !== 1) throw new Error('Only an approved plugin market release can be revoked.');
    return marketFromPostgres(result.rows[0] as PostgresMarketRow);
  }
  async getPluginInstallation(pluginId: string, tenantId: string, userId: string) {
    const result = await this.pool.query('SELECT * FROM plugin_installations WHERE plugin_id=$1 AND tenant_id=$2 AND user_id=$3', [pluginId, tenantId, userId]);
    return result.rows[0] ? installationFromPostgres(result.rows[0] as PostgresInstallationRow) : null;
  }
  async installMarketRelease(pluginId: string, tenantId: string, userId: string) {
    const release = await this.getMarketRelease(pluginId, tenantId);
    if (!release) throw new Error('No approved plugin market release is available.');
    const timestamp = now();
    await this.pool.query(`INSERT INTO plugin_installations (tenant_id, user_id, plugin_id, plugin_version, installed_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$5) ON CONFLICT(tenant_id, user_id, plugin_id) DO NOTHING`, [tenantId, userId, pluginId, release.pluginVersion, timestamp]);
    const installation = await this.getPluginInstallation(pluginId, tenantId, userId);
    if (!installation) throw new Error('Plugin installation failed.');
    return installation;
  }
  async upgradeMarketRelease(pluginId: string, tenantId: string, userId: string) {
    const installation = await this.getPluginInstallation(pluginId, tenantId, userId);
    if (!installation) throw new Error('Plugin is not installed.');
    const release = await this.getMarketRelease(pluginId, tenantId);
    if (!release) throw new Error('No approved plugin market release is available.');
    if (release.pluginVersion === installation.pluginVersion) return installation;
    const result = await this.pool.query('UPDATE plugin_installations SET plugin_version=$1, updated_at=$2 WHERE plugin_id=$3 AND tenant_id=$4 AND user_id=$5 RETURNING *', [release.pluginVersion, now(), pluginId, tenantId, userId]);
    return installationFromPostgres(result.rows[0] as PostgresInstallationRow);
  }
  async uninstallPlugin(pluginId: string, tenantId: string, userId: string) {
    const result = await this.pool.query('DELETE FROM plugin_installations WHERE plugin_id=$1 AND tenant_id=$2 AND user_id=$3', [pluginId, tenantId, userId]);
    return (result.rowCount ?? 0) > 0;
  }
  async deletePlugin(pluginId: string, tenantId: string) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM plugin_installations WHERE plugin_id = $1 AND tenant_id = $2', [pluginId, tenantId]);
      await client.query('DELETE FROM plugin_market_releases WHERE plugin_id = $1 AND tenant_id = $2', [pluginId, tenantId]);
      const result = await client.query('DELETE FROM user_plugins WHERE id = $1 AND tenant_id = $2', [pluginId, tenantId]);
      await client.query('COMMIT');
      return (result.rowCount ?? 0) > 0;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

export const createPluginStore = (): PluginStore => {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (databaseUrl) return new PostgresPluginStore(databaseUrl);
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_SQLITE_PRODUCTION !== 'true') throw new Error('DATABASE_URL is required in production. Set ALLOW_SQLITE_PRODUCTION=true only for single-node deployments.');
  return new SqlitePluginStore(process.env.AXIOM_SQLITE_PATH?.trim() || resolve(process.cwd(), '.data', 'axiom-control-room.sqlite'));
};
