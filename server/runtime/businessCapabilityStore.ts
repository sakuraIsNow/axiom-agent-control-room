import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Pool } from 'pg';

export type BusinessRecordKind =
  | 'project'
  | 'project-comment'
  | 'project-notification'
  | 'review-assignment'
  | 'memory'
  | 'tool-source'
  | 'capability-pack-installation'
  | 'nexus-artifact'
  | 'nexus-test-case'
  | 'nexus-test-run'
  | 'nexus-release'
  | 'task-action'
  | 'feedback'
  | 'decision';

export type BusinessRecord = {
  id: string;
  tenantId: string;
  userId: string;
  kind: BusinessRecordKind;
  projectId?: string;
  ownerId: string;
  status: string;
  revision: number;
  data: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type CreateBusinessRecord = Pick<BusinessRecord, 'tenantId' | 'userId' | 'kind' | 'ownerId' | 'status' | 'data'> & {
  id?: string;
  projectId?: string;
};

export class BusinessRecordRevisionConflictError extends Error {
  constructor(readonly expected: number, readonly actual: number) {
    super(`业务记录已被其他用户修改（期望版本 ${expected}，当前版本 ${actual}）。`);
    this.name = 'BusinessRecordRevisionConflictError';
  }
}

export interface BusinessCapabilityStore {
  initialize(): Promise<void>;
  close(): Promise<void>;
  create(input: CreateBusinessRecord): Promise<BusinessRecord>;
  get(id: string, tenantId: string): Promise<BusinessRecord | null>;
  list(tenantId: string, kind: BusinessRecordKind, options?: { projectId?: string; userId?: string; limit?: number }): Promise<BusinessRecord[]>;
  listAll(kind: BusinessRecordKind, limit?: number): Promise<BusinessRecord[]>;
  update(id: string, tenantId: string, patch: { status?: string; data?: Record<string, unknown>; projectId?: string | null }, expectedRevision: number): Promise<BusinessRecord>;
  delete(id: string, tenantId: string): Promise<boolean>;
  unlinkProjectResource(tenantId: string, resourceType: string, resourceId: string): Promise<number>;
}

type Row = {
  id: unknown; tenant_id: unknown; user_id: unknown; kind: unknown; project_id: unknown;
  owner_id: unknown; status: unknown; revision: unknown; data_json: unknown; created_at: unknown; updated_at: unknown;
};

const json = <T>(value: unknown, fallback: T): T => {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'string') return value as T;
  try { return JSON.parse(value) as T; } catch { return fallback; }
};
const iso = (value: unknown) => value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const fromRow = (row: Row): BusinessRecord => ({
  id: String(row.id), tenantId: String(row.tenant_id), userId: String(row.user_id), kind: String(row.kind) as BusinessRecordKind,
  ...(row.project_id ? { projectId: String(row.project_id) } : {}), ownerId: String(row.owner_id), status: String(row.status),
  revision: Number(row.revision), data: json<Record<string, unknown>>(row.data_json, {}),
  createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
});

export class SqliteBusinessCapabilityStore implements BusinessCapabilityStore {
  private readonly db: DatabaseSync;

  constructor(path = process.env.AXIOM_SQLITE_PATH?.trim() || resolve(process.cwd(), '.data', 'axiom-control-room.sqlite')) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
  }

  async initialize() {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS axiom_business_records (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        project_id TEXT,
        owner_id TEXT NOT NULL,
        status TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        data_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_axiom_business_records_scope
        ON axiom_business_records(tenant_id, kind, project_id, updated_at DESC);
    `);
  }

  async close() { this.db.close(); }

  async create(input: CreateBusinessRecord) {
    const timestamp = new Date().toISOString();
    const record: BusinessRecord = {
      id: input.id ?? randomUUID(), tenantId: input.tenantId, userId: input.userId, kind: input.kind,
      ...(input.projectId ? { projectId: input.projectId } : {}), ownerId: input.ownerId, status: input.status,
      revision: 1, data: clone(input.data), createdAt: timestamp, updatedAt: timestamp,
    };
    this.db.prepare(`INSERT INTO axiom_business_records
      (id, tenant_id, user_id, kind, project_id, owner_id, status, revision, data_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      record.id, record.tenantId, record.userId, record.kind, record.projectId ?? null, record.ownerId,
      record.status, record.revision, JSON.stringify(record.data), record.createdAt, record.updatedAt,
    );
    return record;
  }

  async get(id: string, tenantId: string) {
    const row = this.db.prepare('SELECT * FROM axiom_business_records WHERE id = ? AND tenant_id = ?').get(id, tenantId) as Row | undefined;
    return row ? fromRow(row) : null;
  }

  async list(tenantId: string, kind: BusinessRecordKind, options: { projectId?: string; userId?: string; limit?: number } = {}) {
    const filters = ['tenant_id = ?', 'kind = ?'];
    const values: Array<string | number> = [tenantId, kind];
    if (options.projectId) { filters.push('project_id = ?'); values.push(options.projectId); }
    if (options.userId) { filters.push('user_id = ?'); values.push(options.userId); }
    values.push(Math.min(500, Math.max(1, options.limit ?? 100)));
    const rows = this.db.prepare(`SELECT * FROM axiom_business_records WHERE ${filters.join(' AND ')} ORDER BY updated_at DESC LIMIT ?`).all(...values) as Row[];
    return rows.map(fromRow);
  }

  async listAll(kind: BusinessRecordKind, limit = 2_000) {
    const rows = this.db.prepare('SELECT * FROM axiom_business_records WHERE kind = ? ORDER BY updated_at DESC LIMIT ?')
      .all(kind, Math.min(10_000, Math.max(1, limit))) as Row[];
    return rows.map(fromRow);
  }

  async update(id: string, tenantId: string, patch: { status?: string; data?: Record<string, unknown>; projectId?: string | null }, expectedRevision: number) {
    const current = await this.get(id, tenantId);
    if (!current) throw new Error('业务记录不存在。');
    if (current.revision !== expectedRevision) throw new BusinessRecordRevisionConflictError(expectedRevision, current.revision);
    const next = {
      ...current,
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.data !== undefined ? { data: clone(patch.data) } : {}),
      ...(patch.projectId !== undefined ? patch.projectId ? { projectId: patch.projectId } : { projectId: undefined } : {}),
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
    };
    const result = this.db.prepare(`UPDATE axiom_business_records SET status = ?, data_json = ?, project_id = ?, revision = ?, updated_at = ?
      WHERE id = ? AND tenant_id = ? AND revision = ?`).run(
      next.status, JSON.stringify(next.data), next.projectId ?? null, next.revision, next.updatedAt, id, tenantId, expectedRevision,
    );
    if (Number(result.changes) !== 1) {
      const actual = await this.get(id, tenantId);
      throw new BusinessRecordRevisionConflictError(expectedRevision, actual?.revision ?? expectedRevision + 1);
    }
    return next;
  }

  async delete(id: string, tenantId: string) {
    const result = this.db.prepare('DELETE FROM axiom_business_records WHERE id = ? AND tenant_id = ?').run(id, tenantId);
    return Number(result.changes) === 1;
  }

  async unlinkProjectResource(tenantId: string, resourceType: string, resourceId: string) {
    const rows = this.db.prepare("SELECT * FROM axiom_business_records WHERE tenant_id = ? AND kind = 'project'").all(tenantId) as Row[];
    let changed = 0;
    for (const row of rows) {
      let project = fromRow(row);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const resources = project.data.resources && typeof project.data.resources === 'object' && !Array.isArray(project.data.resources)
          ? project.data.resources as Record<string, unknown>
          : {};
        const current = Array.isArray(resources[resourceType])
          ? (resources[resourceType] as unknown[]).filter((item): item is string => typeof item === 'string')
          : [];
        const next = current.filter((id) => id !== resourceId);
        if (next.length === current.length) break;
        try {
          await this.update(project.id, tenantId, { data: { ...project.data, resources: { ...resources, [resourceType]: next } } }, project.revision);
          changed += 1;
          break;
        } catch (error) {
          if (!(error instanceof BusinessRecordRevisionConflictError) || attempt === 2) throw error;
          const latest = await this.get(project.id, tenantId);
          if (!latest) break;
          project = latest;
        }
      }
    }
    return changed;
  }
}

export class PostgresBusinessCapabilityStore implements BusinessCapabilityStore {
  private readonly pool: Pool;
  constructor(connectionString: string) { this.pool = new Pool({ connectionString }); }

  async initialize() {
    const client = await this.pool.connect();
    try {
      // CREATE TABLE IF NOT EXISTS can still race in PostgreSQL system catalogs
      // when multiple workers start against a fresh database at the same time.
      await client.query("SELECT pg_advisory_lock(hashtext('axiom_business_capability_schema_v1'))");
      await client.query(`CREATE TABLE IF NOT EXISTS axiom_business_records (
        id UUID PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        project_id UUID,
        owner_id TEXT NOT NULL,
        status TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        data_json JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      )`);
      await client.query('CREATE INDEX IF NOT EXISTS idx_axiom_business_records_scope ON axiom_business_records(tenant_id, kind, project_id, updated_at DESC)');
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext('axiom_business_capability_schema_v1'))").catch(() => undefined);
      client.release();
    }
  }

  async close() { await this.pool.end(); }

  async create(input: CreateBusinessRecord) {
    const timestamp = new Date().toISOString();
    const record: BusinessRecord = {
      id: input.id ?? randomUUID(), tenantId: input.tenantId, userId: input.userId, kind: input.kind,
      ...(input.projectId ? { projectId: input.projectId } : {}), ownerId: input.ownerId, status: input.status,
      revision: 1, data: clone(input.data), createdAt: timestamp, updatedAt: timestamp,
    };
    const result = await this.pool.query<Row>(`INSERT INTO axiom_business_records
      (id, tenant_id, user_id, kind, project_id, owner_id, status, revision, data_json, created_at, updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11) RETURNING *`,
    [record.id, record.tenantId, record.userId, record.kind, record.projectId ?? null, record.ownerId, record.status, 1, JSON.stringify(record.data), timestamp, timestamp]);
    return fromRow(result.rows[0]!);
  }

  async get(id: string, tenantId: string) {
    const result = await this.pool.query<Row>('SELECT * FROM axiom_business_records WHERE id = $1 AND tenant_id = $2', [id, tenantId]);
    return result.rows[0] ? fromRow(result.rows[0]) : null;
  }

  async list(tenantId: string, kind: BusinessRecordKind, options: { projectId?: string; userId?: string; limit?: number } = {}) {
    const values: unknown[] = [tenantId, kind];
    const filters = ['tenant_id = $1', 'kind = $2'];
    if (options.projectId) { values.push(options.projectId); filters.push(`project_id = $${values.length}`); }
    if (options.userId) { values.push(options.userId); filters.push(`user_id = $${values.length}`); }
    values.push(Math.min(500, Math.max(1, options.limit ?? 100)));
    const result = await this.pool.query<Row>(`SELECT * FROM axiom_business_records WHERE ${filters.join(' AND ')} ORDER BY updated_at DESC LIMIT $${values.length}`, values);
    return result.rows.map(fromRow);
  }

  async listAll(kind: BusinessRecordKind, limit = 2_000) {
    const result = await this.pool.query<Row>(
      'SELECT * FROM axiom_business_records WHERE kind = $1 ORDER BY updated_at DESC LIMIT $2',
      [kind, Math.min(10_000, Math.max(1, limit))],
    );
    return result.rows.map(fromRow);
  }

  async update(id: string, tenantId: string, patch: { status?: string; data?: Record<string, unknown>; projectId?: string | null }, expectedRevision: number) {
    const current = await this.get(id, tenantId);
    if (!current) throw new Error('业务记录不存在。');
    if (current.revision !== expectedRevision) throw new BusinessRecordRevisionConflictError(expectedRevision, current.revision);
    const result = await this.pool.query<Row>(`UPDATE axiom_business_records SET status = $1, data_json = $2::jsonb, project_id = $3,
      revision = revision + 1, updated_at = NOW() WHERE id = $4 AND tenant_id = $5 AND revision = $6 RETURNING *`, [
      patch.status ?? current.status, JSON.stringify(patch.data ?? current.data), patch.projectId === undefined ? current.projectId ?? null : patch.projectId,
      id, tenantId, expectedRevision,
    ]);
    if (!result.rows[0]) {
      const actual = await this.get(id, tenantId);
      throw new BusinessRecordRevisionConflictError(expectedRevision, actual?.revision ?? expectedRevision + 1);
    }
    return fromRow(result.rows[0]);
  }

  async delete(id: string, tenantId: string) {
    const result = await this.pool.query('DELETE FROM axiom_business_records WHERE id = $1 AND tenant_id = $2', [id, tenantId]);
    return (result.rowCount ?? 0) === 1;
  }

  async unlinkProjectResource(tenantId: string, resourceType: string, resourceId: string) {
    const result = await this.pool.query<Row>("SELECT * FROM axiom_business_records WHERE tenant_id = $1 AND kind = 'project'", [tenantId]);
    let changed = 0;
    for (const row of result.rows) {
      let project = fromRow(row);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const resources = project.data.resources && typeof project.data.resources === 'object' && !Array.isArray(project.data.resources)
          ? project.data.resources as Record<string, unknown>
          : {};
        const current = Array.isArray(resources[resourceType])
          ? (resources[resourceType] as unknown[]).filter((item): item is string => typeof item === 'string')
          : [];
        const next = current.filter((id) => id !== resourceId);
        if (next.length === current.length) break;
        try {
          await this.update(project.id, tenantId, { data: { ...project.data, resources: { ...resources, [resourceType]: next } } }, project.revision);
          changed += 1;
          break;
        } catch (error) {
          if (!(error instanceof BusinessRecordRevisionConflictError) || attempt === 2) throw error;
          const latest = await this.get(project.id, tenantId);
          if (!latest) break;
          project = latest;
        }
      }
    }
    return changed;
  }
}

export const createBusinessCapabilityStore = (): BusinessCapabilityStore => process.env.DATABASE_URL?.trim()
  ? new PostgresBusinessCapabilityStore(process.env.DATABASE_URL.trim())
  : new SqliteBusinessCapabilityStore();
