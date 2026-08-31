import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Pool } from 'pg';

export type MemoryCaptureReceiptStatus = 'pending' | 'completed' | 'failed';

export type MemoryCaptureIdentity = {
  tenantId: string;
  userId: string;
  sessionId: string;
  taskId: string;
  contentDigest: string;
};

export type MemoryCaptureReceipt = MemoryCaptureIdentity & {
  id: string;
  status: MemoryCaptureReceiptStatus;
  claimToken: string | null;
  cursorTimestamp: string | null;
  attempts: number;
  duplicateSkips: number;
  capturedCount: number;
  serverTotalCount: number | null;
  lastError: string | null;
  leaseExpiresAt: string | null;
  nextRetryAt: string | null;
  lastAttemptAt: string | null;
  requestInput: string | null;
  requestOutput: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type MemoryCaptureClaim = {
  claimed: boolean;
  claimToken?: string;
  receipt: MemoryCaptureReceipt;
  reason?: 'already_completed' | 'in_progress';
};

export type MemoryCapturePayload = {
  input: string;
  output: string;
  cursorTimestamp: string;
};

export type MemoryCaptureStats = {
  pending: number;
  completed: number;
  failed: number;
  attempts: number;
  duplicateSkips: number;
  capturedMessages: number;
};

export interface MemoryCaptureReceiptStore {
  initialize(): Promise<void>;
  close?(): Promise<void>;
  claim(identity: MemoryCaptureIdentity, leaseMs?: number, payload?: MemoryCapturePayload): Promise<MemoryCaptureClaim>;
  complete(id: string, claimToken: string, result: { cursorTimestamp: string; capturedCount: number; serverTotalCount?: number }): Promise<MemoryCaptureReceipt | null>;
  /** Terminally acknowledge a durable receipt that is obsolete locally. */
  markSkipped(id: string, reason: string): Promise<MemoryCaptureReceipt | null>;
  fail(id: string, claimToken: string, error: string): Promise<MemoryCaptureReceipt | null>;
  reclaimExpired(now?: Date): Promise<number>;
  listRetryable(limit?: number, now?: Date): Promise<MemoryCaptureReceipt[]>;
  get(identity: MemoryCaptureIdentity): Promise<MemoryCaptureReceipt | null>;
  latestCursor(tenantId: string, userId: string, sessionId: string): Promise<string | null>;
  stats(tenantId: string, userId: string): Promise<MemoryCaptureStats>;
}

const fromRow = (row: Record<string, unknown>): MemoryCaptureReceipt => ({
  id: String(row.id),
  tenantId: String(row.tenant_id),
  userId: String(row.user_id),
  sessionId: String(row.session_id),
  taskId: String(row.task_id),
  contentDigest: String(row.content_digest),
  status: row.status as MemoryCaptureReceiptStatus,
  claimToken: row.claim_token ? String(row.claim_token) : null,
  cursorTimestamp: row.cursor_timestamp ? new Date(String(row.cursor_timestamp)).toISOString() : null,
  attempts: Number(row.attempts ?? 0),
  duplicateSkips: Number(row.duplicate_skips ?? 0),
  capturedCount: Number(row.captured_count ?? 0),
  serverTotalCount: row.server_total_count === null || row.server_total_count === undefined ? null : Number(row.server_total_count),
  lastError: row.last_error ? String(row.last_error) : null,
  leaseExpiresAt: row.lease_expires_at ? new Date(String(row.lease_expires_at)).toISOString() : null,
  nextRetryAt: row.next_retry_at ? new Date(String(row.next_retry_at)).toISOString() : null,
  lastAttemptAt: row.last_attempt_at ? new Date(String(row.last_attempt_at)).toISOString() : null,
  requestInput: typeof row.request_input === 'string' ? row.request_input : null,
  requestOutput: typeof row.request_output === 'string' ? row.request_output : null,
  createdAt: new Date(String(row.created_at)).toISOString(),
  updatedAt: new Date(String(row.updated_at)).toISOString(),
  completedAt: row.completed_at ? new Date(String(row.completed_at)).toISOString() : null,
});

const emptyStats = (): MemoryCaptureStats => ({
  pending: 0,
  completed: 0,
  failed: 0,
  attempts: 0,
  duplicateSkips: 0,
  capturedMessages: 0,
});

export class PostgresMemoryCaptureReceiptStore implements MemoryCaptureReceiptStore {
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
      CREATE TABLE IF NOT EXISTS memory_capture_receipts (
        id UUID PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        content_digest TEXT NOT NULL,
        status TEXT NOT NULL,
        claim_token UUID,
        cursor_timestamp TIMESTAMPTZ,
        attempts INTEGER NOT NULL DEFAULT 1,
        duplicate_skips INTEGER NOT NULL DEFAULT 0,
        captured_count INTEGER NOT NULL DEFAULT 0,
        server_total_count INTEGER,
        last_error TEXT,
        lease_expires_at TIMESTAMPTZ,
        next_retry_at TIMESTAMPTZ,
        last_attempt_at TIMESTAMPTZ,
        request_input TEXT,
        request_output TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        completed_at TIMESTAMPTZ,
        UNIQUE (tenant_id, user_id, session_id, task_id, content_digest)
      );
      CREATE INDEX IF NOT EXISTS idx_memory_capture_receipts_owner
        ON memory_capture_receipts(tenant_id, user_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_capture_receipts_recovery
        ON memory_capture_receipts(status, lease_expires_at);
      ALTER TABLE memory_capture_receipts ADD COLUMN IF NOT EXISTS next_retry_at TIMESTAMPTZ;
      ALTER TABLE memory_capture_receipts ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ;
      ALTER TABLE memory_capture_receipts ADD COLUMN IF NOT EXISTS request_input TEXT;
      ALTER TABLE memory_capture_receipts ADD COLUMN IF NOT EXISTS request_output TEXT;
    `);
  }

  async close() {
    await this.pool.end();
  }

  async claim(identity: MemoryCaptureIdentity, leaseMs = 30_000, payload?: MemoryCapturePayload): Promise<MemoryCaptureClaim> {
    const id = randomUUID();
    const claimToken = randomUUID();
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + leaseMs);
    const values = [
      id,
      identity.tenantId,
      identity.userId,
      identity.sessionId,
      identity.taskId,
      identity.contentDigest,
      claimToken,
      now.toISOString(),
      leaseExpiresAt.toISOString(),
      payload?.input?.slice(0, 120_000) ?? null,
      payload?.output?.slice(0, 120_000) ?? null,
      payload?.cursorTimestamp ?? null,
    ];
    const result = await this.pool.query(`
      INSERT INTO memory_capture_receipts (
        id, tenant_id, user_id, session_id, task_id, content_digest, status,
        claim_token, attempts, lease_expires_at, last_attempt_at, request_input, request_output, cursor_timestamp, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, 1, $9, $8, $10, $11, $12, $8, $8)
      ON CONFLICT (tenant_id, user_id, session_id, task_id, content_digest) DO UPDATE SET
        status = 'pending',
        claim_token = EXCLUDED.claim_token,
        attempts = memory_capture_receipts.attempts + 1,
        last_error = NULL,
        lease_expires_at = EXCLUDED.lease_expires_at,
        last_attempt_at = EXCLUDED.last_attempt_at,
        request_input = COALESCE(EXCLUDED.request_input, memory_capture_receipts.request_input),
        request_output = COALESCE(EXCLUDED.request_output, memory_capture_receipts.request_output),
        cursor_timestamp = COALESCE(EXCLUDED.cursor_timestamp, memory_capture_receipts.cursor_timestamp),
        next_retry_at = NULL,
        updated_at = EXCLUDED.updated_at
      WHERE memory_capture_receipts.status = 'failed'
         OR (memory_capture_receipts.status = 'pending' AND memory_capture_receipts.lease_expires_at <= EXCLUDED.updated_at)
      RETURNING *
    `, values);
    const claimedRow = result.rows[0] as Record<string, unknown> | undefined;
    if (claimedRow) return { claimed: true, claimToken, receipt: fromRow(claimedRow) };

    const skipped = await this.pool.query(`
      UPDATE memory_capture_receipts
      SET duplicate_skips = duplicate_skips + CASE WHEN status = 'completed' THEN 1 ELSE 0 END
      WHERE tenant_id = $1 AND user_id = $2 AND session_id = $3 AND task_id = $4 AND content_digest = $5
      RETURNING *
    `, [identity.tenantId, identity.userId, identity.sessionId, identity.taskId, identity.contentDigest]);
    const receipt = fromRow(skipped.rows[0] as Record<string, unknown>);
    return { claimed: false, receipt, reason: receipt.status === 'completed' ? 'already_completed' : 'in_progress' };
  }

  async complete(id: string, claimToken: string, result: { cursorTimestamp: string; capturedCount: number; serverTotalCount?: number }) {
    const now = new Date().toISOString();
    const updated = await this.pool.query(`
      UPDATE memory_capture_receipts SET
        status = 'completed', claim_token = NULL, cursor_timestamp = $3,
        captured_count = $4, server_total_count = $5, last_error = NULL,
        lease_expires_at = NULL, next_retry_at = NULL, updated_at = $6, completed_at = $6
      WHERE id = $1 AND claim_token = $2 AND status = 'pending'
      RETURNING *
    `, [id, claimToken, result.cursorTimestamp, result.capturedCount, result.serverTotalCount ?? null, now]);
    return updated.rows[0] ? fromRow(updated.rows[0] as Record<string, unknown>) : null;
  }

  async markSkipped(id: string, reason: string) {
    const now = new Date().toISOString();
    const updated = await this.pool.query(`
      UPDATE memory_capture_receipts SET
        status = 'completed', claim_token = NULL, captured_count = 0,
        last_error = $2, lease_expires_at = NULL, next_retry_at = NULL,
        updated_at = $3, completed_at = $3
      WHERE id = $1 AND status = 'failed'
      RETURNING *
    `, [id, reason.slice(0, 2_000), now]);
    return updated.rows[0] ? fromRow(updated.rows[0] as Record<string, unknown>) : null;
  }

  async fail(id: string, claimToken: string, error: string) {
    const now = new Date().toISOString();
    const updated = await this.pool.query(`
      UPDATE memory_capture_receipts SET
        status = 'failed', claim_token = NULL, last_error = $3,
        lease_expires_at = NULL, next_retry_at = $4, updated_at = $5
      WHERE id = $1 AND claim_token = $2 AND status = 'pending'
      RETURNING *
    `, [id, claimToken, error.slice(0, 2_000), new Date(Date.now() + 1_000).toISOString(), now]);
    return updated.rows[0] ? fromRow(updated.rows[0] as Record<string, unknown>) : null;
  }

  async reclaimExpired(now = new Date()) {
    const result = await this.pool.query(`
      UPDATE memory_capture_receipts
      SET status = 'failed', claim_token = NULL, lease_expires_at = NULL,
          last_error = COALESCE(last_error, 'Capture lease expired before completion.'),
          next_retry_at = $1, updated_at = $1
      WHERE status = 'pending' AND lease_expires_at IS NOT NULL AND lease_expires_at <= $1
    `, [now.toISOString()]);
    return result.rowCount ?? 0;
  }

  async listRetryable(limit = 50, now = new Date()) {
    const result = await this.pool.query(`
      SELECT * FROM memory_capture_receipts
      WHERE status = 'failed'
        AND request_input IS NOT NULL AND request_output IS NOT NULL
        AND (next_retry_at IS NULL OR next_retry_at <= $1)
      ORDER BY updated_at ASC
      LIMIT $2
    `, [now.toISOString(), Math.max(1, Math.min(500, Math.floor(limit)))]);
    return result.rows.map((row) => fromRow(row as Record<string, unknown>));
  }

  async get(identity: MemoryCaptureIdentity) {
    const result = await this.pool.query(`
      SELECT * FROM memory_capture_receipts
      WHERE tenant_id = $1 AND user_id = $2 AND session_id = $3 AND task_id = $4 AND content_digest = $5
    `, [identity.tenantId, identity.userId, identity.sessionId, identity.taskId, identity.contentDigest]);
    return result.rows[0] ? fromRow(result.rows[0] as Record<string, unknown>) : null;
  }

  async latestCursor(tenantId: string, userId: string, sessionId: string) {
    const result = await this.pool.query(`
      SELECT MAX(cursor_timestamp) AS cursor_timestamp FROM memory_capture_receipts
      WHERE tenant_id = $1 AND user_id = $2 AND session_id = $3 AND status = 'completed'
    `, [tenantId, userId, sessionId]);
    const cursor = (result.rows[0] as Record<string, unknown> | undefined)?.cursor_timestamp;
    return cursor ? new Date(String(cursor)).toISOString() : null;
  }

  async stats(tenantId: string, userId: string) {
    const result = await this.pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
        COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
        COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
        COALESCE(SUM(attempts), 0)::int AS attempts,
        COALESCE(SUM(duplicate_skips), 0)::int AS duplicate_skips,
        COALESCE(SUM(captured_count), 0)::int AS captured_messages
      FROM memory_capture_receipts WHERE tenant_id = $1 AND user_id = $2
    `, [tenantId, userId]);
    const row = result.rows[0] as Record<string, unknown> | undefined;
    return row ? {
      pending: Number(row.pending), completed: Number(row.completed), failed: Number(row.failed),
      attempts: Number(row.attempts), duplicateSkips: Number(row.duplicate_skips), capturedMessages: Number(row.captured_messages),
    } : emptyStats();
  }
}

export class SqliteMemoryCaptureReceiptStore implements MemoryCaptureReceiptStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
  }

  async initialize() {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS memory_capture_receipts (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        content_digest TEXT NOT NULL,
        status TEXT NOT NULL,
        claim_token TEXT,
        cursor_timestamp TEXT,
        attempts INTEGER NOT NULL DEFAULT 1,
        duplicate_skips INTEGER NOT NULL DEFAULT 0,
        captured_count INTEGER NOT NULL DEFAULT 0,
        server_total_count INTEGER,
        last_error TEXT,
        lease_expires_at TEXT,
        next_retry_at TEXT,
        last_attempt_at TEXT,
        request_input TEXT,
        request_output TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        UNIQUE (tenant_id, user_id, session_id, task_id, content_digest)
      );
      CREATE INDEX IF NOT EXISTS idx_memory_capture_receipts_owner
        ON memory_capture_receipts(tenant_id, user_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_capture_receipts_recovery
        ON memory_capture_receipts(status, lease_expires_at);
    `);
    // SQLite has no ADD COLUMN IF NOT EXISTS; upgrade legacy receipt stores
    // idempotently while keeping all existing receipt rows intact.
    for (const column of ['next_retry_at TEXT', 'last_attempt_at TEXT', 'request_input TEXT', 'request_output TEXT']) {
      try { this.db.exec(`ALTER TABLE memory_capture_receipts ADD COLUMN ${column}`); } catch { /* column already exists */ }
    }
  }

  async close() {
    this.db.close();
  }

  async claim(identity: MemoryCaptureIdentity, leaseMs = 30_000, payload?: MemoryCapturePayload): Promise<MemoryCaptureClaim> {
    const id = randomUUID();
    const claimToken = randomUUID();
    const now = new Date().toISOString();
    const leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString();
    const claimed = this.db.prepare(`
      INSERT INTO memory_capture_receipts (
        id, tenant_id, user_id, session_id, task_id, content_digest, status,
        claim_token, attempts, lease_expires_at, last_attempt_at, request_input, request_output, cursor_timestamp, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, 1, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (tenant_id, user_id, session_id, task_id, content_digest) DO UPDATE SET
        status = 'pending', claim_token = excluded.claim_token,
         attempts = memory_capture_receipts.attempts + 1, last_error = NULL,
         lease_expires_at = excluded.lease_expires_at,
         last_attempt_at = excluded.last_attempt_at,
         request_input = COALESCE(excluded.request_input, memory_capture_receipts.request_input),
         request_output = COALESCE(excluded.request_output, memory_capture_receipts.request_output),
         cursor_timestamp = COALESCE(excluded.cursor_timestamp, memory_capture_receipts.cursor_timestamp),
         next_retry_at = NULL, updated_at = excluded.updated_at
      WHERE memory_capture_receipts.status = 'failed'
         OR (memory_capture_receipts.status = 'pending' AND memory_capture_receipts.lease_expires_at <= excluded.updated_at)
      RETURNING *
    `).get(id, identity.tenantId, identity.userId, identity.sessionId, identity.taskId, identity.contentDigest, claimToken, leaseExpiresAt, now, payload?.input?.slice(0, 120_000) ?? null, payload?.output?.slice(0, 120_000) ?? null, payload?.cursorTimestamp ?? null, now, now) as Record<string, unknown> | undefined;
    if (claimed) return { claimed: true, claimToken, receipt: fromRow(claimed) };

    const skipped = this.db.prepare(`
      UPDATE memory_capture_receipts
      SET duplicate_skips = duplicate_skips + CASE WHEN status = 'completed' THEN 1 ELSE 0 END
      WHERE tenant_id = ? AND user_id = ? AND session_id = ? AND task_id = ? AND content_digest = ?
      RETURNING *
    `).get(identity.tenantId, identity.userId, identity.sessionId, identity.taskId, identity.contentDigest) as Record<string, unknown>;
    const receipt = fromRow(skipped);
    return { claimed: false, receipt, reason: receipt.status === 'completed' ? 'already_completed' : 'in_progress' };
  }

  async complete(id: string, claimToken: string, result: { cursorTimestamp: string; capturedCount: number; serverTotalCount?: number }) {
    const now = new Date().toISOString();
    const row = this.db.prepare(`
      UPDATE memory_capture_receipts SET
        status = 'completed', claim_token = NULL, cursor_timestamp = ?, captured_count = ?,
        server_total_count = ?, last_error = NULL, lease_expires_at = NULL, next_retry_at = NULL,
        updated_at = ?, completed_at = ?
      WHERE id = ? AND claim_token = ? AND status = 'pending'
      RETURNING *
    `).get(result.cursorTimestamp, result.capturedCount, result.serverTotalCount ?? null, now, now, id, claimToken) as Record<string, unknown> | undefined;
    return row ? fromRow(row) : null;
  }

  async markSkipped(id: string, reason: string) {
    const now = new Date().toISOString();
    const row = this.db.prepare(`
      UPDATE memory_capture_receipts SET
        status = 'completed', claim_token = NULL, captured_count = 0,
        last_error = ?, lease_expires_at = NULL, next_retry_at = NULL,
        updated_at = ?, completed_at = ?
      WHERE id = ? AND status = 'failed'
      RETURNING *
    `).get(reason.slice(0, 2_000), now, now, id) as Record<string, unknown> | undefined;
    return row ? fromRow(row) : null;
  }

  async fail(id: string, claimToken: string, error: string) {
    const now = new Date().toISOString();
    const row = this.db.prepare(`
      UPDATE memory_capture_receipts SET
        status = 'failed', claim_token = NULL, last_error = ?, lease_expires_at = NULL, next_retry_at = ?, updated_at = ?
      WHERE id = ? AND claim_token = ? AND status = 'pending'
      RETURNING *
    `).get(error.slice(0, 2_000), new Date(Date.now() + 1_000).toISOString(), now, id, claimToken) as Record<string, unknown> | undefined;
    return row ? fromRow(row) : null;
  }

  async reclaimExpired(now = new Date()) {
    const result = this.db.prepare(`
      UPDATE memory_capture_receipts
      SET status = 'failed', claim_token = NULL, lease_expires_at = NULL,
          last_error = COALESCE(last_error, 'Capture lease expired before completion.'),
          next_retry_at = ?, updated_at = ?
      WHERE status = 'pending' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
    `).run(now.toISOString(), now.toISOString(), now.toISOString());
    return Number(result.changes ?? 0);
  }

  async listRetryable(limit = 50, now = new Date()) {
    const rows = this.db.prepare(`
      SELECT * FROM memory_capture_receipts
      WHERE status = 'failed'
        AND request_input IS NOT NULL AND request_output IS NOT NULL
        AND (next_retry_at IS NULL OR next_retry_at <= ?)
      ORDER BY updated_at ASC LIMIT ?
    `).all(now.toISOString(), Math.max(1, Math.min(500, Math.floor(limit)))) as Record<string, unknown>[];
    return rows.map(fromRow);
  }

  async get(identity: MemoryCaptureIdentity) {
    const row = this.db.prepare(`
      SELECT * FROM memory_capture_receipts
      WHERE tenant_id = ? AND user_id = ? AND session_id = ? AND task_id = ? AND content_digest = ?
    `).get(identity.tenantId, identity.userId, identity.sessionId, identity.taskId, identity.contentDigest) as Record<string, unknown> | undefined;
    return row ? fromRow(row) : null;
  }

  async latestCursor(tenantId: string, userId: string, sessionId: string) {
    const row = this.db.prepare(`
      SELECT MAX(cursor_timestamp) AS cursor_timestamp FROM memory_capture_receipts
      WHERE tenant_id = ? AND user_id = ? AND session_id = ? AND status = 'completed'
    `).get(tenantId, userId, sessionId) as Record<string, unknown> | undefined;
    return row?.cursor_timestamp ? new Date(String(row.cursor_timestamp)).toISOString() : null;
  }

  async stats(tenantId: string, userId: string) {
    const row = this.db.prepare(`
      SELECT
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
        COALESCE(SUM(attempts), 0) AS attempts,
        COALESCE(SUM(duplicate_skips), 0) AS duplicate_skips,
        COALESCE(SUM(captured_count), 0) AS captured_messages
      FROM memory_capture_receipts WHERE tenant_id = ? AND user_id = ?
    `).get(tenantId, userId) as Record<string, unknown> | undefined;
    return row ? {
      pending: Number(row.pending ?? 0), completed: Number(row.completed ?? 0), failed: Number(row.failed ?? 0),
      attempts: Number(row.attempts ?? 0), duplicateSkips: Number(row.duplicate_skips ?? 0), capturedMessages: Number(row.captured_messages ?? 0),
    } : emptyStats();
  }
}

export const createMemoryCaptureReceiptStore = (): MemoryCaptureReceiptStore => process.env.DATABASE_URL
  ? new PostgresMemoryCaptureReceiptStore(process.env.DATABASE_URL)
  : new SqliteMemoryCaptureReceiptStore(
    process.env.AXIOM_SQLITE_PATH?.trim() || resolve(process.cwd(), '.data', 'axiom-control-room.sqlite'),
  );
