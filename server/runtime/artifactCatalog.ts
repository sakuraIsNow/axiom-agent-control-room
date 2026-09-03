import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Pool } from 'pg';

export type ArtifactSource = 'result' | 'tool' | 'event' | 'upload';
export type ArtifactStatus = 'active' | 'orphaned' | 'delete_pending' | 'deleted';

export type ArtifactRecord = {
  id: string;
  tenantId: string;
  taskId: string;
  source: ArtifactSource;
  storageKey?: string;
  bytes: number;
  mimeType?: string;
  createdAt: string;
  expiresAt?: string;
  deletedAt?: string;
  referenceCount: number;
  status: ArtifactStatus;
  cleanupAttempts: number;
  lastError?: string;
  lastAttemptAt?: string;
};

export type ArtifactRegisterInput = {
  id: string;
  tenantId: string;
  taskId: string;
  source: ArtifactSource;
  storageKey?: string;
  bytes?: number;
  mimeType?: string;
  createdAt?: string;
  expiresAt?: string;
  referenceKey?: string;
};

export type ArtifactCatalogStats = {
  total: number;
  active: number;
  orphaned: number;
  deletePending: number;
  deleted: number;
  cleanupFailures: number;
  totalBytes: number;
};

export interface ArtifactCatalog {
  initialize(): Promise<void>;
  close(): Promise<void>;
  reconcile(): Promise<number>;
  register(input: ArtifactRegisterInput): Promise<ArtifactRecord>;
  get(tenantId: string, artifactId: string): Promise<ArtifactRecord | null>;
  markDeletePending(tenantId: string, artifactId: string, reason?: string): Promise<boolean>;
  removeTaskReferences(tenantId: string, taskId: string, artifactIds?: string[]): Promise<number>;
  markDeleted(tenantId: string, artifactId: string): Promise<boolean>;
  recordCleanupFailure(tenantId: string, artifactId: string, error: string): Promise<boolean>;
  listActive(tenantId: string, limit?: number): Promise<ArtifactRecord[]>;
  listCleanupCandidates(tenantId: string, limit?: number): Promise<ArtifactRecord[]>;
  listOrphans(tenantId: string, limit?: number): Promise<ArtifactRecord[]>;
  stats(tenantId: string): Promise<ArtifactCatalogStats>;
}

const sourceValues = new Set<ArtifactSource>(['result', 'tool', 'event', 'upload']);
const statusValues = new Set<ArtifactStatus>(['active', 'orphaned', 'delete_pending', 'deleted']);

const source = (value: unknown): ArtifactSource => sourceValues.has(value as ArtifactSource) ? value as ArtifactSource : 'event';
const status = (value: unknown): ArtifactStatus => statusValues.has(value as ArtifactStatus) ? value as ArtifactStatus : 'active';
const iso = (value: unknown) => {
  if (value instanceof Date) return value.toISOString();
  const text = String(value ?? '');
  return Number.isFinite(Date.parse(text)) ? new Date(text).toISOString() : text;
};
const retentionExpiry = (createdAt: string) => {
  const configured = Number(process.env.AXIOM_ARTIFACT_RETENTION_DAYS ?? 30);
  const days = Number.isFinite(configured) ? Math.min(3650, Math.max(1, configured)) : 30;
  return new Date(Date.parse(createdAt) + days * 86_400_000).toISOString();
};
const cleanError = (value: string) => value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 2_000);
const boundedLimit = (limit = 100) => Math.min(500, Math.max(1, Math.floor(limit)));
const requiredId = (value: string, label: string) => {
  const normalized = value.trim();
  if (!normalized || normalized.length > 512 || /[\u0000-\u001f\u007f]/.test(normalized)) throw new Error(`${label} must contain 1-512 printable characters.`);
  return normalized;
};
const validOptionalIso = (value: string | undefined) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined;

const payloadArtifact = (payload: unknown) => {
  if (!payload || typeof payload !== 'object') return null;
  const value = payload as Record<string, unknown>;
  const nested = value.artifact && typeof value.artifact === 'object' ? value.artifact as Record<string, unknown> : value;
  const id = typeof nested.id === 'string' ? nested.id : typeof value.artifactId === 'string' ? value.artifactId : undefined;
  if (!id) return null;
  const storage = nested.storage && typeof nested.storage === 'object' ? nested.storage as Record<string, unknown> : value.storage && typeof value.storage === 'object' ? value.storage as Record<string, unknown> : undefined;
  return {
    id,
    source: id.startsWith('result:') ? 'result' as const : id.startsWith('tool:') ? 'tool' as const : 'event' as const,
    storageKey: typeof nested.key === 'string' ? nested.key : typeof storage?.key === 'string' ? storage.key : undefined,
    bytes: Number(nested.bytes ?? nested.size ?? value.size ?? 0),
    mimeType: typeof nested.mimeType === 'string' ? nested.mimeType : typeof nested.kind === 'string' && nested.kind === 'markdown' ? 'text/markdown' : undefined,
  };
};

const fromRow = (row: Record<string, unknown>): ArtifactRecord => ({
  id: String(row.id),
  tenantId: String(row.tenant_id),
  taskId: String(row.task_id),
  source: source(row.source),
  ...(row.storage_key ? { storageKey: String(row.storage_key) } : {}),
  bytes: Math.max(0, Number(row.bytes ?? 0)),
  ...(row.mime_type ? { mimeType: String(row.mime_type) } : {}),
  createdAt: iso(row.created_at),
  ...(row.expires_at ? { expiresAt: iso(row.expires_at) } : {}),
  ...(row.deleted_at ? { deletedAt: iso(row.deleted_at) } : {}),
  referenceCount: Math.max(0, Number(row.reference_count ?? 0)),
  status: status(row.status),
  cleanupAttempts: Math.max(0, Number(row.cleanup_attempts ?? 0)),
  ...(row.last_error ? { lastError: String(row.last_error) } : {}),
  ...(row.last_attempt_at ? { lastAttemptAt: iso(row.last_attempt_at) } : {}),
});

const schema = `
  CREATE TABLE IF NOT EXISTS artifact_records (
    id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    source TEXT NOT NULL,
    storage_key TEXT,
    bytes BIGINT NOT NULL DEFAULT 0,
    mime_type TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ,
    deleted_at TIMESTAMPTZ,
    reference_count INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',
    cleanup_attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    last_attempt_at TIMESTAMPTZ,
    PRIMARY KEY (tenant_id, id)
  );
  CREATE TABLE IF NOT EXISTS artifact_references (
    tenant_id TEXT NOT NULL,
    artifact_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    reference_key TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (tenant_id, artifact_id, reference_key)
  );
  CREATE INDEX IF NOT EXISTS idx_artifact_records_cleanup ON artifact_records(tenant_id, status, expires_at, cleanup_attempts);
  CREATE INDEX IF NOT EXISTS idx_artifact_records_task ON artifact_records(tenant_id, task_id);
  CREATE INDEX IF NOT EXISTS idx_artifact_refs_task ON artifact_references(tenant_id, task_id);
`;

export class SqliteArtifactCatalog implements ArtifactCatalog {
  private readonly db: DatabaseSync;

  constructor(path = process.env.AXIOM_SQLITE_PATH?.trim() || resolve(process.cwd(), '.data', 'axiom-control-room.sqlite')) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
  }

  async initialize() {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      ${schema.replaceAll('TIMESTAMPTZ', 'TEXT')}
    `);
  }

  async close() { this.db.close(); }

  async reconcile() {
    let count = 0;
    const tasks = this.db.prepare(`SELECT id, tenant_id, updated_at, result FROM tasks WHERE result IS NOT NULL`).all() as Array<{ id: string; tenant_id: string; updated_at: string; result: string }>;
    for (const task of tasks) {
      await this.register({ id: `result:${task.id}`, tenantId: task.tenant_id, taskId: task.id, source: 'result', bytes: Buffer.byteLength(task.result, 'utf8'), mimeType: 'text/markdown', createdAt: task.updated_at, referenceKey: 'result' });
      count += 1;
    }
    const events = this.db.prepare(`SELECT e.task_id, t.tenant_id, e.type, e.timestamp, e.payload_json FROM task_events e JOIN tasks t ON t.id = e.task_id WHERE e.type IN ('artifact.created', 'tool.completed')`).all() as Array<{ task_id: string; tenant_id: string; type: string; timestamp: string; payload_json: string }>;
    for (const event of events) {
      let payload: unknown;
      try { payload = JSON.parse(event.payload_json); } catch { continue; }
      const artifact = payloadArtifact(payload);
      if (!artifact) continue;
      await this.register({ ...artifact, tenantId: event.tenant_id, taskId: event.task_id, createdAt: event.timestamp, referenceKey: `event:${event.type}:${event.task_id}:${artifact.id}` });
      count += 1;
    }
    return count;
  }

  async register(input: ArtifactRegisterInput) {
    const id = requiredId(input.id, 'Artifact id');
    const tenantId = requiredId(input.tenantId, 'Tenant id');
    const taskId = requiredId(input.taskId, 'Task id');
    const createdAt = validOptionalIso(input.createdAt) ?? new Date().toISOString();
    const referenceKey = input.referenceKey?.trim() || `${input.source}:${input.taskId}`;
    const expiresAt = validOptionalIso(input.expiresAt) ?? retentionExpiry(createdAt);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`
        INSERT INTO artifact_records (id, tenant_id, task_id, source, storage_key, bytes, mime_type, created_at, expires_at, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
        ON CONFLICT (tenant_id, id) DO UPDATE SET
          storage_key = COALESCE(excluded.storage_key, artifact_records.storage_key),
          bytes = MAX(artifact_records.bytes, excluded.bytes),
          mime_type = COALESCE(excluded.mime_type, artifact_records.mime_type),
          expires_at = COALESCE(artifact_records.expires_at, excluded.expires_at),
          task_id = CASE WHEN artifact_records.status = 'deleted' THEN excluded.task_id ELSE artifact_records.task_id END,
          status = CASE WHEN artifact_records.status = 'deleted' THEN 'active' ELSE artifact_records.status END,
          deleted_at = CASE WHEN artifact_records.status = 'deleted' THEN NULL ELSE artifact_records.deleted_at END
      `).run(id, tenantId, taskId, input.source, input.storageKey ?? null, Math.max(0, input.bytes ?? 0), input.mimeType ?? null, createdAt, expiresAt);
      const inserted = this.db.prepare(`
        INSERT INTO artifact_references (tenant_id, artifact_id, task_id, reference_key, created_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (tenant_id, artifact_id, reference_key) DO NOTHING
      `).run(tenantId, id, taskId, referenceKey, createdAt);
      if (inserted.changes > 0) this.db.prepare(`UPDATE artifact_records SET reference_count = (SELECT COUNT(*) FROM artifact_references WHERE tenant_id = ? AND artifact_id = ?), status = CASE WHEN status = 'orphaned' THEN 'active' ELSE status END WHERE tenant_id = ? AND id = ?`).run(tenantId, id, tenantId, id);
      const row = this.db.prepare('SELECT * FROM artifact_records WHERE tenant_id = ? AND id = ?').get(tenantId, id) as Record<string, unknown>;
      this.db.exec('COMMIT');
      return fromRow(row);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async get(tenantId: string, artifactId: string) {
    const row = this.db.prepare('SELECT * FROM artifact_records WHERE tenant_id = ? AND id = ?').get(tenantId, artifactId) as Record<string, unknown> | undefined;
    return row ? fromRow(row) : null;
  }

  async markDeletePending(tenantId: string, artifactId: string, reason = '') {
    const result = this.db.prepare(`UPDATE artifact_records SET status = CASE WHEN status = 'deleted' THEN status ELSE 'delete_pending' END, last_error = CASE WHEN ? <> '' THEN ? ELSE last_error END WHERE tenant_id = ? AND id = ? AND status <> 'deleted'`).run(cleanError(reason), cleanError(reason), tenantId, artifactId);
    return result.changes > 0;
  }

  async removeTaskReferences(tenantId: string, taskId: string, artifactIds?: string[]) {
    const ids = [...new Set((artifactIds ?? []).filter(Boolean))];
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const where = ids.length ? ` AND artifact_id IN (${ids.map(() => '?').join(',')})` : '';
      const params = ids.length ? [tenantId, taskId, ...ids] : [tenantId, taskId];
      const affected = this.db.prepare(`SELECT DISTINCT artifact_id FROM artifact_references WHERE tenant_id = ? AND task_id = ?${where}`).all(...params) as Array<{ artifact_id: string }>;
      const removed = this.db.prepare(`DELETE FROM artifact_references WHERE tenant_id = ? AND task_id = ?${where}`).run(...params);
      for (const { artifact_id: artifactId } of affected) {
        this.db.prepare(`UPDATE artifact_records SET reference_count = (SELECT COUNT(*) FROM artifact_references WHERE tenant_id = ? AND artifact_id = ?), status = CASE WHEN status = 'active' AND (SELECT COUNT(*) FROM artifact_references WHERE tenant_id = ? AND artifact_id = ?) = 0 THEN 'orphaned' ELSE status END WHERE tenant_id = ? AND id = ?`).run(tenantId, artifactId, tenantId, artifactId, tenantId, artifactId);
      }
      this.db.exec('COMMIT');
      return Number(removed.changes ?? 0);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async markDeleted(tenantId: string, artifactId: string) {
    const result = this.db.prepare(`UPDATE artifact_records SET status = 'deleted', deleted_at = ?, last_error = NULL, last_attempt_at = ? WHERE tenant_id = ? AND id = ? AND status <> 'deleted'`).run(new Date().toISOString(), new Date().toISOString(), tenantId, artifactId);
    return result.changes > 0;
  }

  async recordCleanupFailure(tenantId: string, artifactId: string, error: string) {
    const now = new Date().toISOString();
    const result = this.db.prepare(`UPDATE artifact_records SET status = 'delete_pending', cleanup_attempts = cleanup_attempts + 1, last_error = ?, last_attempt_at = ? WHERE tenant_id = ? AND id = ? AND status <> 'deleted'`).run(cleanError(error), now, tenantId, artifactId);
    return result.changes > 0;
  }

  async listActive(tenantId: string, limit = 100) {
    const rows = this.db.prepare(`SELECT * FROM artifact_records WHERE tenant_id = ? AND status = 'active' AND reference_count > 0 ORDER BY created_at DESC LIMIT ?`).all(tenantId, boundedLimit(limit)) as Array<Record<string, unknown>>;
    return rows.map(fromRow);
  }

  async listCleanupCandidates(tenantId: string, limit = 100) {
    const rows = this.db.prepare(`SELECT * FROM artifact_records WHERE tenant_id = ? AND (status IN ('orphaned', 'delete_pending') OR (status = 'active' AND expires_at IS NOT NULL AND expires_at <= ?)) ORDER BY cleanup_attempts ASC, created_at ASC LIMIT ?`).all(tenantId, new Date().toISOString(), boundedLimit(limit)) as Array<Record<string, unknown>>;
    return rows.map(fromRow);
  }

  async listOrphans(tenantId: string, limit = 100) {
    const rows = this.db.prepare(`SELECT * FROM artifact_records WHERE tenant_id = ? AND status IN ('active', 'orphaned') AND reference_count <= 0 ORDER BY created_at ASC LIMIT ?`).all(tenantId, boundedLimit(limit)) as Array<Record<string, unknown>>;
    this.db.prepare(`UPDATE artifact_records SET status = 'orphaned' WHERE tenant_id = ? AND status = 'active' AND reference_count <= 0`).run(tenantId);
    return rows.map(fromRow).map((record) => ({ ...record, status: 'orphaned' as const }));
  }

  async stats(tenantId: string) {
    this.db.prepare(`UPDATE artifact_records SET status = 'orphaned' WHERE tenant_id = ? AND status = 'active' AND reference_count <= 0`).run(tenantId);
    const rows = this.db.prepare(`SELECT status, COUNT(*) AS count, COALESCE(SUM(bytes), 0) AS bytes, SUM(CASE WHEN cleanup_attempts > 0 THEN 1 ELSE 0 END) AS failures FROM artifact_records WHERE tenant_id = ? GROUP BY status`).all(tenantId) as Array<{ status: string; count: number; bytes: number; failures: number }>;
    const result: ArtifactCatalogStats = { total: 0, active: 0, orphaned: 0, deletePending: 0, deleted: 0, cleanupFailures: 0, totalBytes: 0 };
    for (const row of rows) {
      const count = Number(row.count ?? 0);
      result.total += count;
      result.totalBytes += Number(row.bytes ?? 0);
      result.cleanupFailures += Number(row.failures ?? 0);
      if (row.status === 'active') result.active += count;
      if (row.status === 'orphaned') result.orphaned += count;
      if (row.status === 'delete_pending') result.deletePending += count;
      if (row.status === 'deleted') result.deleted += count;
    }
    return result;
  }
}

export class PostgresArtifactCatalog implements ArtifactCatalog {
  private readonly pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: Number(process.env.DATABASE_POOL_SIZE ?? 10), idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000, ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: true } : undefined });
  }

  async initialize() {
    await this.pool.query(schema);
  }

  async close() { await this.pool.end(); }

  async reconcile() {
    let count = 0;
    const tasks = await this.pool.query(`SELECT id, tenant_id, updated_at, result FROM tasks WHERE result IS NOT NULL`);
    for (const task of tasks.rows as Array<{ id: string; tenant_id: string; updated_at: Date | string; result: string }>) {
      await this.register({ id: `result:${task.id}`, tenantId: task.tenant_id, taskId: task.id, source: 'result', bytes: Buffer.byteLength(task.result, 'utf8'), mimeType: 'text/markdown', createdAt: iso(task.updated_at), referenceKey: 'result' });
      count += 1;
    }
    const events = await this.pool.query(`SELECT e.task_id, t.tenant_id, e.type, e.timestamp, e.payload_json FROM task_events e JOIN tasks t ON t.id = e.task_id WHERE e.type IN ('artifact.created', 'tool.completed')`);
    for (const event of events.rows as Array<{ task_id: string; tenant_id: string; type: string; timestamp: Date | string; payload_json: Record<string, unknown> }>) {
      const artifact = payloadArtifact(event.payload_json);
      if (!artifact) continue;
      await this.register({ ...artifact, tenantId: event.tenant_id, taskId: event.task_id, createdAt: iso(event.timestamp), referenceKey: `event:${event.type}:${event.task_id}:${artifact.id}` });
      count += 1;
    }
    return count;
  }

  async register(input: ArtifactRegisterInput) {
    const id = requiredId(input.id, 'Artifact id');
    const tenantId = requiredId(input.tenantId, 'Tenant id');
    const taskId = requiredId(input.taskId, 'Task id');
    const createdAt = validOptionalIso(input.createdAt) ?? new Date().toISOString();
    const referenceKey = input.referenceKey?.trim() || `${input.source}:${input.taskId}`;
    const expiresAt = validOptionalIso(input.expiresAt) ?? retentionExpiry(createdAt);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`
        INSERT INTO artifact_records (id, tenant_id, task_id, source, storage_key, bytes, mime_type, created_at, expires_at, status)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active')
        ON CONFLICT (tenant_id, id) DO UPDATE SET
          storage_key = COALESCE(EXCLUDED.storage_key, artifact_records.storage_key), bytes = GREATEST(artifact_records.bytes, EXCLUDED.bytes), mime_type = COALESCE(EXCLUDED.mime_type, artifact_records.mime_type), expires_at = COALESCE(artifact_records.expires_at, EXCLUDED.expires_at), task_id = CASE WHEN artifact_records.status = 'deleted' THEN EXCLUDED.task_id ELSE artifact_records.task_id END, status = CASE WHEN artifact_records.status = 'deleted' THEN 'active' ELSE artifact_records.status END, deleted_at = CASE WHEN artifact_records.status = 'deleted' THEN NULL ELSE artifact_records.deleted_at END
      `, [id, tenantId, taskId, input.source, input.storageKey ?? null, Math.max(0, input.bytes ?? 0), input.mimeType ?? null, createdAt, expiresAt]);
      await client.query(`INSERT INTO artifact_references (tenant_id, artifact_id, task_id, reference_key, created_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`, [tenantId, id, taskId, referenceKey, createdAt]);
      await client.query(`UPDATE artifact_records SET reference_count = (SELECT COUNT(*) FROM artifact_references WHERE tenant_id = $1 AND artifact_id = $2), status = CASE WHEN status = 'orphaned' THEN 'active' ELSE status END WHERE tenant_id = $1 AND id = $2`, [tenantId, id]);
      const result = await client.query('SELECT * FROM artifact_records WHERE tenant_id = $1 AND id = $2', [tenantId, id]);
      await client.query('COMMIT');
      return fromRow(result.rows[0] as Record<string, unknown>);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async get(tenantId: string, artifactId: string) {
    const result = await this.pool.query('SELECT * FROM artifact_records WHERE tenant_id = $1 AND id = $2', [tenantId, artifactId]);
    return result.rows[0] ? fromRow(result.rows[0] as Record<string, unknown>) : null;
  }

  async markDeletePending(tenantId: string, artifactId: string, reason = '') {
    const result = await this.pool.query(`UPDATE artifact_records SET status = CASE WHEN status = 'deleted' THEN status ELSE 'delete_pending' END, last_error = CASE WHEN $1 <> '' THEN $1 ELSE last_error END WHERE tenant_id = $2 AND id = $3 AND status <> 'deleted'`, [cleanError(reason), tenantId, artifactId]);
    return (result.rowCount ?? 0) > 0;
  }

  async removeTaskReferences(tenantId: string, taskId: string, artifactIds?: string[]) {
    const ids = [...new Set((artifactIds ?? []).filter(Boolean))];
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const affected = ids.length
        ? await client.query<{ artifact_id: string }>(`SELECT DISTINCT artifact_id FROM artifact_references WHERE tenant_id = $1 AND task_id = $2 AND artifact_id = ANY($3::text[])`, [tenantId, taskId, ids])
        : await client.query<{ artifact_id: string }>(`SELECT DISTINCT artifact_id FROM artifact_references WHERE tenant_id = $1 AND task_id = $2`, [tenantId, taskId]);
      const deleted = ids.length
        ? await client.query(`DELETE FROM artifact_references WHERE tenant_id = $1 AND task_id = $2 AND artifact_id = ANY($3::text[])`, [tenantId, taskId, ids])
        : await client.query(`DELETE FROM artifact_references WHERE tenant_id = $1 AND task_id = $2`, [tenantId, taskId]);
      const affectedIds = affected.rows.map((row) => row.artifact_id);
      if (affectedIds.length > 0) {
        await client.query(`UPDATE artifact_records SET reference_count = (SELECT COUNT(*) FROM artifact_references WHERE tenant_id = artifact_records.tenant_id AND artifact_id = artifact_records.id), status = CASE WHEN status = 'active' AND (SELECT COUNT(*) FROM artifact_references WHERE tenant_id = artifact_records.tenant_id AND artifact_id = artifact_records.id) = 0 THEN 'orphaned' ELSE status END WHERE tenant_id = $1 AND id = ANY($2::text[])`, [tenantId, affectedIds]);
      }
      await client.query('COMMIT');
      return deleted.rowCount ?? 0;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async markDeleted(tenantId: string, artifactId: string) {
    const result = await this.pool.query(`UPDATE artifact_records SET status = 'deleted', deleted_at = NOW(), last_error = NULL, last_attempt_at = NOW() WHERE tenant_id = $1 AND id = $2 AND status <> 'deleted'`, [tenantId, artifactId]);
    return (result.rowCount ?? 0) > 0;
  }

  async recordCleanupFailure(tenantId: string, artifactId: string, error: string) {
    const result = await this.pool.query(`UPDATE artifact_records SET status = 'delete_pending', cleanup_attempts = cleanup_attempts + 1, last_error = $1, last_attempt_at = NOW() WHERE tenant_id = $2 AND id = $3 AND status <> 'deleted'`, [cleanError(error), tenantId, artifactId]);
    return (result.rowCount ?? 0) > 0;
  }

  async listActive(tenantId: string, limit = 100) {
    const result = await this.pool.query(`SELECT * FROM artifact_records WHERE tenant_id = $1 AND status = 'active' AND reference_count > 0 ORDER BY created_at DESC LIMIT $2`, [tenantId, boundedLimit(limit)]);
    return result.rows.map((row) => fromRow(row as Record<string, unknown>));
  }

  async listCleanupCandidates(tenantId: string, limit = 100) {
    const result = await this.pool.query(`SELECT * FROM artifact_records WHERE tenant_id = $1 AND (status IN ('orphaned', 'delete_pending') OR (status = 'active' AND expires_at IS NOT NULL AND expires_at <= NOW())) ORDER BY cleanup_attempts ASC, created_at ASC LIMIT $2`, [tenantId, boundedLimit(limit)]);
    return result.rows.map((row) => fromRow(row as Record<string, unknown>));
  }

  async listOrphans(tenantId: string, limit = 100) {
    const result = await this.pool.query(`UPDATE artifact_records SET status = 'orphaned' WHERE tenant_id = $1 AND status = 'active' AND reference_count <= 0`, [tenantId]);
    void result;
    const rows = await this.pool.query(`SELECT * FROM artifact_records WHERE tenant_id = $1 AND status = 'orphaned' AND reference_count <= 0 ORDER BY created_at ASC LIMIT $2`, [tenantId, boundedLimit(limit)]);
    return rows.rows.map((row) => fromRow(row as Record<string, unknown>));
  }

  async stats(tenantId: string) {
    await this.pool.query(`UPDATE artifact_records SET status = 'orphaned' WHERE tenant_id = $1 AND status = 'active' AND reference_count <= 0`, [tenantId]);
    const result = await this.pool.query(`SELECT status, COUNT(*)::int AS count, COALESCE(SUM(bytes), 0)::float8 AS bytes, SUM(CASE WHEN cleanup_attempts > 0 THEN 1 ELSE 0 END)::int AS failures FROM artifact_records WHERE tenant_id = $1 GROUP BY status`, [tenantId]);
    const stats: ArtifactCatalogStats = { total: 0, active: 0, orphaned: 0, deletePending: 0, deleted: 0, cleanupFailures: 0, totalBytes: 0 };
    for (const row of result.rows as Array<{ status: string; count: number; bytes: number; failures: number }>) {
      const count = Number(row.count ?? 0);
      stats.total += count;
      stats.totalBytes += Number(row.bytes ?? 0);
      stats.cleanupFailures += Number(row.failures ?? 0);
      if (row.status === 'active') stats.active += count;
      if (row.status === 'orphaned') stats.orphaned += count;
      if (row.status === 'delete_pending') stats.deletePending += count;
      if (row.status === 'deleted') stats.deleted += count;
    }
    return stats;
  }
}

export const createArtifactCatalog = (): ArtifactCatalog => {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (databaseUrl) return new PostgresArtifactCatalog(databaseUrl);
  return new SqliteArtifactCatalog();
};
