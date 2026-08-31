import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Pool } from 'pg';
import type {
  CreateWorkflowTemplateInput,
  TemplateStore,
  UpdateWorkflowTemplateInput,
  WorkflowTemplate,
  WorkflowTemplateDefinition,
  WorkflowTemplateStatus,
  WorkflowTemplateVisibility,
  TemplateAccess,
} from './contracts.js';

type TemplateHistoryEntry = WorkflowTemplate['history'][number];

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const now = () => new Date().toISOString();

const normalizeDefinition = (definition: WorkflowTemplateDefinition): WorkflowTemplateDefinition => ({
  ...(definition.kind ? { kind: definition.kind } : {}),
  mode: definition.mode,
  ...(definition.model?.trim() ? { model: definition.model.trim().slice(0, 160) } : {}),
  policy: { ...(definition.policy ?? {}), requirePlanApproval: definition.policy?.requirePlanApproval ?? false },
  agentIds: [...new Set((definition.agentIds ?? []).map((item) => item.trim()).filter(Boolean))].slice(0, 16),
  toolNames: [...new Set((definition.toolNames ?? []).map((item) => item.trim()).filter(Boolean))].slice(0, 32),
  ...(definition.promptPrefix?.trim() ? { promptPrefix: definition.promptPrefix.trim().slice(0, 4_000) } : {}),
  ...(definition.plan ? { plan: clone(definition.plan) } : {}),
  ...(definition.workflow ? { workflow: clone(definition.workflow) } : {}),
});

const createTemplate = (input: CreateWorkflowTemplateInput): WorkflowTemplate => {
  const timestamp = now();
  return {
    id: randomUUID(),
    tenantId: input.tenantId,
    name: input.name.trim(),
    description: input.description.trim(),
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

const isDefinitionChanged = (current: WorkflowTemplate, input: UpdateWorkflowTemplateInput) =>
  input.definition !== undefined
  || input.name !== undefined
  || input.description !== undefined;

const updateValue = (current: WorkflowTemplate, input: UpdateWorkflowTemplateInput): WorkflowTemplate => {
  const changed = isDefinitionChanged(current, input);
  const timestamp = now();
  const nextVersion = changed ? current.version + 1 : current.version;
  const history = changed
    ? [...current.history, {
      version: current.version,
      definition: clone(current.definition),
      status: current.status,
      updatedAt: current.updatedAt,
      updatedBy: input.updatedBy,
    } satisfies TemplateHistoryEntry]
    : current.history;
  return {
    ...current,
    ...(input.name !== undefined ? { name: input.name.trim() } : {}),
    ...(input.description !== undefined ? { description: input.description.trim() } : {}),
    ...(input.definition !== undefined ? { definition: normalizeDefinition(input.definition) } : {}),
    ...(input.status !== undefined ? { status: input.status } : {}),
    ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
    version: nextVersion,
    history: history.slice(-30),
    updatedAt: timestamp,
  };
};

const rollbackValue = (current: WorkflowTemplate, version: number, updatedBy: string): WorkflowTemplate => {
  const target = current.history.find((entry) => entry.version === version);
  if (!target) throw new Error(`Template version ${version} was not found.`);
  const timestamp = now();
  return {
    ...current,
    version: current.version + 1,
    status: 'draft',
    definition: clone(target.definition),
    history: [...current.history, {
      version: current.version,
      definition: clone(current.definition),
      status: current.status,
      updatedAt: current.updatedAt,
      updatedBy,
    } satisfies TemplateHistoryEntry].slice(-30),
    updatedAt: timestamp,
  };
};

type SqliteRow = {
  id: string;
  tenant_id: string;
  name: string;
  description: string;
  status: WorkflowTemplateStatus;
  visibility?: WorkflowTemplateVisibility;
  version: number;
  definition_json: string;
  history_json: string;
  created_by: string;
  created_at: string;
  updated_at: string;
};

const fromSqlite = (row: SqliteRow): WorkflowTemplate => ({
  id: row.id,
  tenantId: row.tenant_id,
  name: row.name,
  description: row.description,
  status: row.status,
  visibility: row.visibility ?? 'private',
  version: row.version,
  definition: JSON.parse(row.definition_json) as WorkflowTemplateDefinition,
  history: JSON.parse(row.history_json) as WorkflowTemplate['history'],
  createdBy: row.created_by,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export class SqliteTemplateStore implements TemplateStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
  }

  async initialize() {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS workflow_templates (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'draft',
        visibility TEXT NOT NULL DEFAULT 'private',
        version INTEGER NOT NULL DEFAULT 1,
        definition_json TEXT NOT NULL,
        history_json TEXT NOT NULL DEFAULT '[]',
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_templates_tenant_updated ON workflow_templates(tenant_id, updated_at DESC);
    `);
    try {
      this.db.exec("ALTER TABLE workflow_templates ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private'");
    } catch {
      // Existing SQLite databases already have the column.
    }
  }

  async close() { this.db.close(); }

  async listTemplates(tenantId: string, limit = 50, access?: TemplateAccess, kind?: 'template' | 'agent-workflow') {
    const canSeePrivate = access?.role === 'owner' || access?.role === 'admin';
    const kindClause = kind === 'agent-workflow'
      ? " AND json_extract(definition_json, '$.kind') = 'agent-workflow'"
      : kind === 'template'
        ? " AND COALESCE(json_extract(definition_json, '$.kind'), 'template') <> 'agent-workflow'"
        : '';
    const boundedLimit = Math.min(500, Math.max(1, limit));
    const rows = canSeePrivate || !access
      ? this.db.prepare(
        `SELECT * FROM workflow_templates WHERE tenant_id = ?${kindClause} ORDER BY updated_at DESC LIMIT ?`,
      ).all(tenantId, boundedLimit) as SqliteRow[]
      : this.db.prepare(
        `SELECT * FROM workflow_templates WHERE tenant_id = ? AND (visibility = 'team' OR created_by = ?)${kindClause} ORDER BY updated_at DESC LIMIT ?`,
      ).all(tenantId, access.userId, boundedLimit) as SqliteRow[];
    return rows.map(fromSqlite);
  }

  async getTemplate(templateId: string, tenantId?: string, access?: TemplateAccess) {
    const row = tenantId
      ? (access && access.role !== 'owner' && access.role !== 'admin'
        ? this.db.prepare('SELECT * FROM workflow_templates WHERE id = ? AND tenant_id = ? AND (visibility = \'team\' OR created_by = ?)').get(templateId, tenantId, access.userId)
        : this.db.prepare('SELECT * FROM workflow_templates WHERE id = ? AND tenant_id = ?').get(templateId, tenantId))
      : this.db.prepare('SELECT * FROM workflow_templates WHERE id = ?').get(templateId);
    return row ? fromSqlite(row as SqliteRow) : null;
  }

  async createTemplate(input: CreateWorkflowTemplateInput) {
    const template = createTemplate(input);
    this.db.prepare(`
      INSERT INTO workflow_templates
        (id, tenant_id, name, description, status, visibility, version, definition_json, history_json, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      template.id, template.tenantId, template.name, template.description, template.status, template.visibility, template.version,
      JSON.stringify(template.definition), JSON.stringify(template.history), template.createdBy, template.createdAt, template.updatedAt,
    );
    return template;
  }

  async updateTemplate(templateId: string, tenantId: string, input: UpdateWorkflowTemplateInput) {
    const current = await this.getTemplate(templateId, tenantId);
    if (!current) throw new Error('Template not found.');
    if (current.status === 'archived') throw new Error('Archived templates cannot be edited.');
    const updated = updateValue(current, input);
    this.db.prepare(`
      UPDATE workflow_templates
      SET name = ?, description = ?, status = ?, visibility = ?, version = ?, definition_json = ?, history_json = ?, updated_at = ?
      WHERE id = ? AND tenant_id = ?
    `).run(
      updated.name, updated.description, updated.status, updated.visibility, updated.version, JSON.stringify(updated.definition),
      JSON.stringify(updated.history), updated.updatedAt, templateId, tenantId,
    );
    return updated;
  }

  async rollbackTemplate(templateId: string, tenantId: string, version: number, updatedBy: string) {
    const current = await this.getTemplate(templateId, tenantId);
    if (!current) throw new Error('Template not found.');
    if (current.status === 'archived') throw new Error('Archived templates cannot be rolled back.');
    const updated = rollbackValue(current, version, updatedBy);
    this.db.prepare(`
      UPDATE workflow_templates
      SET status = ?, version = ?, definition_json = ?, history_json = ?, updated_at = ?
      WHERE id = ? AND tenant_id = ?
    `).run(
      updated.status, updated.version, JSON.stringify(updated.definition), JSON.stringify(updated.history),
      updated.updatedAt, templateId, tenantId,
    );
    return updated;
  }
}

type PostgresRow = Omit<SqliteRow, 'definition_json' | 'history_json' | 'created_at' | 'updated_at'> & {
  definition_json: WorkflowTemplateDefinition;
  history_json: WorkflowTemplate['history'];
  created_at: Date | string;
  updated_at: Date | string;
};

const iso = (value: Date | string) => value instanceof Date ? value.toISOString() : value;
const fromPostgres = (row: PostgresRow): WorkflowTemplate => ({
  id: row.id,
  tenantId: row.tenant_id,
  name: row.name,
  description: row.description,
  status: row.status,
  visibility: row.visibility ?? 'private',
  version: Number(row.version),
  definition: row.definition_json,
  history: Array.isArray(row.history_json) ? row.history_json : [],
  createdBy: row.created_by,
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
});

export class PostgresTemplateStore implements TemplateStore {
  private readonly pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      max: Number(process.env.DATABASE_POOL_SIZE ?? 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: true } : undefined,
    });
  }

  async initialize() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS workflow_templates (
        id UUID PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'draft',
        visibility TEXT NOT NULL DEFAULT 'private',
        version INTEGER NOT NULL DEFAULT 1,
        definition_json JSONB NOT NULL,
        history_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        created_by TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_templates_tenant_updated ON workflow_templates(tenant_id, updated_at DESC);
      ALTER TABLE workflow_templates ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'private';
    `);
  }

  async close() { await this.pool.end(); }

  async listTemplates(tenantId: string, limit = 50, access?: TemplateAccess, kind?: 'template' | 'agent-workflow') {
    const canSeePrivate = !access || access.role === 'owner' || access.role === 'admin';
    const kindClause = kind === 'agent-workflow'
      ? " AND definition_json ->> 'kind' = 'agent-workflow'"
      : kind === 'template'
        ? " AND COALESCE(definition_json ->> 'kind', 'template') <> 'agent-workflow'"
        : '';
    const boundedLimit = Math.min(500, Math.max(1, limit));
    const result = canSeePrivate
      ? await this.pool.query(
        `SELECT * FROM workflow_templates WHERE tenant_id = $1${kindClause} ORDER BY updated_at DESC LIMIT $2`,
        [tenantId, boundedLimit],
      )
      : await this.pool.query(
        `SELECT * FROM workflow_templates WHERE tenant_id = $1 AND (visibility = 'team' OR created_by = $2)${kindClause} ORDER BY updated_at DESC LIMIT $3`,
        [tenantId, access.userId, boundedLimit],
      );
    return result.rows.map((row) => fromPostgres(row as PostgresRow));
  }

  async getTemplate(templateId: string, tenantId?: string, access?: TemplateAccess) {
    const canSeePrivate = !access || access.role === 'owner' || access.role === 'admin';
    const result = tenantId
      ? (canSeePrivate
        ? await this.pool.query('SELECT * FROM workflow_templates WHERE id = $1 AND tenant_id = $2', [templateId, tenantId])
        : await this.pool.query('SELECT * FROM workflow_templates WHERE id = $1 AND tenant_id = $2 AND (visibility = \'team\' OR created_by = $3)', [templateId, tenantId, access.userId]))
      : await this.pool.query('SELECT * FROM workflow_templates WHERE id = $1', [templateId]);
    return result.rows[0] ? fromPostgres(result.rows[0] as PostgresRow) : null;
  }

  async createTemplate(input: CreateWorkflowTemplateInput) {
    const template = createTemplate(input);
    await this.pool.query(`
      INSERT INTO workflow_templates
        (id, tenant_id, name, description, status, visibility, version, definition_json, history_json, created_by, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    `, [
      template.id, template.tenantId, template.name, template.description, template.status, template.visibility, template.version,
      JSON.stringify(template.definition), JSON.stringify(template.history), template.createdBy, template.createdAt, template.updatedAt,
    ]);
    return template;
  }

  async updateTemplate(templateId: string, tenantId: string, input: UpdateWorkflowTemplateInput) {
    const current = await this.getTemplate(templateId, tenantId);
    if (!current) throw new Error('Template not found.');
    if (current.status === 'archived') throw new Error('Archived templates cannot be edited.');
    const updated = updateValue(current, input);
    await this.pool.query(`
      UPDATE workflow_templates
      SET name = $1, description = $2, status = $3, visibility = $4, version = $5, definition_json = $6, history_json = $7, updated_at = $8
      WHERE id = $9 AND tenant_id = $10
    `, [
      updated.name, updated.description, updated.status, updated.visibility, updated.version, JSON.stringify(updated.definition), JSON.stringify(updated.history),
      updated.updatedAt, templateId, tenantId,
    ]);
    return updated;
  }

  async rollbackTemplate(templateId: string, tenantId: string, version: number, updatedBy: string) {
    const current = await this.getTemplate(templateId, tenantId);
    if (!current) throw new Error('Template not found.');
    if (current.status === 'archived') throw new Error('Archived templates cannot be rolled back.');
    const updated = rollbackValue(current, version, updatedBy);
    await this.pool.query(`
      UPDATE workflow_templates
      SET status = $1, version = $2, definition_json = $3, history_json = $4, updated_at = $5
      WHERE id = $6 AND tenant_id = $7
    `, [updated.status, updated.version, JSON.stringify(updated.definition), JSON.stringify(updated.history), updated.updatedAt, templateId, tenantId]);
    return updated;
  }
}

export const createTemplateStore = (): TemplateStore => {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (databaseUrl) return new PostgresTemplateStore(databaseUrl);
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_SQLITE_PRODUCTION !== 'true') {
    throw new Error('DATABASE_URL is required in production. Set ALLOW_SQLITE_PRODUCTION=true only for single-node deployments.');
  }
  return new SqliteTemplateStore(process.env.AXIOM_SQLITE_PATH?.trim() || resolve(process.cwd(), '.data', 'axiom-control-room.sqlite'));
};
