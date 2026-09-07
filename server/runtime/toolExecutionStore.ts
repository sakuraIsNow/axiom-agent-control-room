import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Pool } from 'pg';
import type { ToolExecution } from './toolRegistry.js';

export type ToolSideEffect = 'read-only' | 'write';
export type ToolExecutionIdentity = {
  tenantId: string;
  taskId: string;
  runId: string;
  stepId: string;
  invocationId: string;
};
export type ToolExecutionResolution = {
  decision: 'confirmed-completed' | 'confirmed-not-executed';
  operatorId: string;
  note: string;
  resolvedAt: string;
};
export type ToolExecutionRecord = ToolExecutionIdentity & {
  id: string;
  signature: string;
  toolName: string;
  sideEffect: ToolSideEffect;
  callId: string;
  auditId: string;
  approvalId?: string;
  status: 'executing' | 'completed' | 'outcome_unknown' | 'retryable';
  attempts: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
  workerId?: string;
  leaseToken?: string;
  leaseUntil?: string;
  receipt?: ToolExecution;
  receiptSource?: 'tool' | 'human-confirmed';
  unknownReason?: string;
  resolutions: ToolExecutionResolution[];
};
export type ToolExecutionClaimInput = ToolExecutionIdentity & {
  signature: string;
  toolName: string;
  sideEffect: ToolSideEffect;
  callId: string;
  auditId: string;
  approvalId?: string;
  workerId: string;
  leaseMs?: number;
};
export type ToolExecutionClaim =
  | { kind: 'claimed'; record: ToolExecutionRecord; leaseToken: string }
  | { kind: 'replay'; record: ToolExecutionRecord }
  | { kind: 'pending' | 'outcome_unknown'; record: ToolExecutionRecord };
export type ToolExecutionOwner = { tenantId: string; id: string; leaseToken: string };
export type ToolExecutionResolveInput = {
  tenantId: string;
  id: string;
  expectedRevision: number;
  operatorId: string;
  decision: ToolExecutionResolution['decision'];
  note: string;
};

export interface ToolExecutionStore {
  initialize(): Promise<void>;
  close(): Promise<void>;
  claim(input: ToolExecutionClaimInput): Promise<ToolExecutionClaim>;
  renew(owner: ToolExecutionOwner, leaseMs?: number): Promise<boolean>;
  complete(owner: ToolExecutionOwner, receipt: ToolExecution): Promise<boolean>;
  markUnknown(owner: ToolExecutionOwner, reason: string): Promise<boolean>;
  releaseUnstarted(owner: ToolExecutionOwner): Promise<boolean>;
  annotateReceipt(tenantId: string, id: string, callId: string, annotation: Pick<ToolExecution, 'artifact' | 'artifactError'>): Promise<boolean>;
  get(tenantId: string, id: string): Promise<ToolExecutionRecord | null>;
  listForTask(tenantId: string, taskId: string, limit?: number): Promise<ToolExecutionRecord[]>;
  hasUnresolvedForTask(tenantId: string, taskId: string): Promise<boolean>;
  reconcileExpiredForTask(tenantId: string, taskId: string): Promise<number>;
  resolveUnknown(input: ToolExecutionResolveInput): Promise<ToolExecutionRecord | null>;
}

export class ToolExecutionIdentityConflictError extends Error {
  constructor(readonly executionId: string) {
    super('This tool invocation is already bound to different tool arguments or execution semantics.');
    this.name = 'ToolExecutionIdentityConflictError';
  }
}

const clone = <T>(value: T): T => structuredClone(value);
const required = (value: string, label: string) => {
  if (!value.trim() || value.length > 512 || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`${label} must contain 1-512 printable characters.`);
  return value;
};
const leaseDuration = (value = 30_000) => Number.isFinite(value) ? Math.min(300_000, Math.max(100, Math.floor(value))) : 30_000;
const boundedLimit = (value = 200) => Number.isFinite(value) ? Math.min(1000, Math.max(1, Math.floor(value))) : 200;
const errorText = (value: string) => value.replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, 2_000);
export const toolExecutionId = (identity: ToolExecutionIdentity) => {
  const parts = [identity.tenantId, identity.taskId, identity.runId, identity.stepId, identity.invocationId];
  parts.forEach((part) => required(part, 'Tool invocation identity'));
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
};
const clearOwner = (record: ToolExecutionRecord) => {
  delete record.workerId;
  delete record.leaseToken;
  delete record.leaseUntil;
};
const owned = (record: ToolExecutionRecord | null, owner: ToolExecutionOwner, now: number, allowExpired = false): record is ToolExecutionRecord =>
  !!record && record.status === 'executing' && record.leaseToken === owner.leaseToken && (allowExpired || Date.parse(record.leaseUntil ?? '') > now);
type Change<T> = { result: T; record?: ToolExecutionRecord };

abstract class BaseToolExecutionStore implements ToolExecutionStore {
  abstract initialize(): Promise<void>;
  abstract close(): Promise<void>;
  abstract get(tenantId: string, id: string): Promise<ToolExecutionRecord | null>;
  abstract listForTask(tenantId: string, taskId: string, limit?: number): Promise<ToolExecutionRecord[]>;
  abstract hasUnresolvedForTask(tenantId: string, taskId: string): Promise<boolean>;
  protected abstract executingIds(tenantId: string, taskId: string): Promise<string[]>;
  protected abstract atomic<T>(tenantId: string, id: string, change: (record: ToolExecutionRecord | null, now: number) => Change<T>): Promise<T>;

  async reconcileExpiredForTask(tenantId: string, taskId: string) {
    const ids = await this.executingIds(tenantId, taskId);
    let changed = 0;
    for (const id of ids) {
      const reconciled = await this.atomic(tenantId, id, (record, now) => {
        if (!record || record.taskId !== taskId || record.status !== 'executing' || Date.parse(record.leaseUntil ?? '') > now) return { result: false };
        const retryable = record.sideEffect === 'read-only' && record.attempts < 3;
        record.status = retryable ? 'retryable' : 'outcome_unknown';
        if (!retryable) record.unknownReason = record.sideEffect === 'read-only'
          ? 'Repeated worker interruptions require review before another attempt.'
          : 'The worker lease expired after a possible side effect. Verify the external outcome before retrying.';
        record.updatedAt = new Date(now).toISOString();
        record.revision += 1;
        clearOwner(record);
        return { record, result: true };
      });
      if (reconciled) changed += 1;
    }
    return changed;
  }

  async claim(input: ToolExecutionClaimInput): Promise<ToolExecutionClaim> {
    const id = toolExecutionId(input);
    required(input.signature, 'Tool signature');
    required(input.toolName, 'Tool name');
    required(input.workerId, 'Worker id');
    return this.atomic<ToolExecutionClaim>(input.tenantId, id, (existing, now) => {
      const timestamp = new Date(now).toISOString();
      if (existing) {
        if (existing.signature !== input.signature || existing.toolName !== input.toolName || existing.sideEffect !== input.sideEffect || existing.approvalId !== input.approvalId) throw new ToolExecutionIdentityConflictError(id);
        if (existing.status === 'completed') return { result: { kind: 'replay', record: existing } };
        if (existing.status === 'outcome_unknown') return { result: { kind: 'outcome_unknown', record: existing } };
        if (existing.status === 'executing' && Date.parse(existing.leaseUntil ?? '') > now) return { result: { kind: 'pending', record: existing } };
        if (existing.status === 'executing' && (existing.sideEffect !== 'read-only' || existing.attempts >= 3)) {
          existing.status = 'outcome_unknown';
          existing.unknownReason = existing.sideEffect === 'read-only' ? 'Repeated worker interruptions require review before another attempt.' : 'The worker lease expired after a possible side effect. Verify the external outcome before retrying.';
          existing.updatedAt = timestamp;
          existing.revision += 1;
          clearOwner(existing);
          return { record: existing, result: { kind: 'outcome_unknown', record: existing } };
        }
      }
      const record: ToolExecutionRecord = existing ?? {
        id, tenantId: input.tenantId, taskId: input.taskId, runId: input.runId, stepId: input.stepId, invocationId: input.invocationId,
        signature: input.signature, toolName: input.toolName, sideEffect: input.sideEffect, callId: input.callId, auditId: input.auditId,
        ...(input.approvalId ? { approvalId: input.approvalId } : {}),
        status: 'retryable', attempts: 0, revision: 0, createdAt: timestamp, updatedAt: timestamp, resolutions: [],
      };
      record.status = 'executing';
      record.workerId = input.workerId;
      record.leaseToken = randomUUID();
      record.leaseUntil = new Date(now + leaseDuration(input.leaseMs)).toISOString();
      record.attempts += 1;
      record.revision += 1;
      record.updatedAt = timestamp;
      delete record.unknownReason;
      return { record, result: { kind: 'claimed', record, leaseToken: record.leaseToken } };
    });
  }

  async renew(owner: ToolExecutionOwner, leaseMs?: number) {
    return this.atomic(owner.tenantId, owner.id, (record, now) => {
      if (!owned(record, owner, now)) return { result: false };
      record.leaseUntil = new Date(now + leaseDuration(leaseMs)).toISOString();
      record.updatedAt = new Date(now).toISOString();
      record.revision += 1;
      return { record, result: true };
    });
  }

  async complete(owner: ToolExecutionOwner, receipt: ToolExecution) {
    return this.atomic(owner.tenantId, owner.id, (record, now) => {
      if (!owned(record, owner, now)) return { result: false };
      if (receipt.call.id !== record.callId || receipt.call.name !== record.toolName || receipt.signature !== record.signature) throw new ToolExecutionIdentityConflictError(owner.id);
      record.receipt = clone(receipt);
      record.receiptSource = 'tool';
      record.status = 'completed';
      record.updatedAt = new Date(now).toISOString();
      record.revision += 1;
      clearOwner(record);
      return { record, result: true };
    });
  }

  async markUnknown(owner: ToolExecutionOwner, reason: string) {
    return this.atomic(owner.tenantId, owner.id, (record, now) => {
      if (!owned(record, owner, now, true)) return { result: false };
      record.status = 'outcome_unknown';
      record.unknownReason = errorText(reason);
      record.updatedAt = new Date(now).toISOString();
      record.revision += 1;
      clearOwner(record);
      return { record, result: true };
    });
  }

  async releaseUnstarted(owner: ToolExecutionOwner) {
    return this.atomic(owner.tenantId, owner.id, (record, now) => {
      if (!owned(record, owner, now, true)) return { result: false };
      record.status = 'retryable';
      record.updatedAt = new Date(now).toISOString();
      record.revision += 1;
      clearOwner(record);
      return { record, result: true };
    });
  }

  async annotateReceipt(tenantId: string, id: string, callId: string, annotation: Pick<ToolExecution, 'artifact' | 'artifactError'>) {
    return this.atomic(tenantId, id, (record, now) => {
      if (!record || record.status !== 'completed' || record.receiptSource !== 'tool' || !record.receipt || record.callId !== callId) return { result: false };
      record.receipt = { ...record.receipt, ...clone(annotation) };
      record.updatedAt = new Date(now).toISOString();
      record.revision += 1;
      return { record, result: true };
    });
  }

  async resolveUnknown(input: ToolExecutionResolveInput) {
    required(input.operatorId, 'Operator id');
    if (!input.note.trim()) throw new Error('Record how the external outcome was verified.');
    if (!['confirmed-completed', 'confirmed-not-executed'].includes(input.decision)) throw new Error('Unsupported tool outcome resolution.');
    return this.atomic<ToolExecutionRecord | null>(input.tenantId, input.id, (record, now) => {
      if (!record || record.status !== 'outcome_unknown' || record.revision !== input.expectedRevision) return { result: null };
      record.resolutions.push({ decision: input.decision, operatorId: input.operatorId, note: errorText(input.note), resolvedAt: new Date(now).toISOString() });
      record.status = input.decision === 'confirmed-completed' ? 'completed' : 'retryable';
      // A human confirmation is evidence of review, never a fabricated tool receipt.
      if (input.decision === 'confirmed-completed') record.receiptSource = 'human-confirmed';
      record.updatedAt = new Date(now).toISOString();
      record.revision += 1;
      clearOwner(record);
      return { record, result: record };
    });
  }
}

const schema = `
  CREATE TABLE IF NOT EXISTS tool_execution_ledger (
    id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    status TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    payload_json TEXT NOT NULL,
    PRIMARY KEY (tenant_id, id)
  );
  CREATE INDEX IF NOT EXISTS idx_tool_execution_ledger_task ON tool_execution_ledger(tenant_id, task_id, updated_at);
  CREATE INDEX IF NOT EXISTS idx_tool_execution_ledger_unresolved ON tool_execution_ledger(tenant_id, task_id, status);
`;

export class SqliteToolExecutionStore extends BaseToolExecutionStore {
  private readonly db: DatabaseSync;
  constructor(path = process.env.AXIOM_SQLITE_PATH?.trim() || resolve(process.cwd(), '.data', 'axiom-control-room.sqlite'), private readonly now: () => number = Date.now) {
    super();
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
  }
  async initialize() {
    this.db.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; ${schema.replaceAll('TIMESTAMPTZ', 'TEXT')}`);
  }
  async close() { this.db.close(); }
  protected async atomic<T>(tenantId: string, id: string, change: (record: ToolExecutionRecord | null, now: number) => Change<T>): Promise<T> {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT payload_json FROM tool_execution_ledger WHERE tenant_id = ? AND id = ?').get(tenantId, id) as { payload_json: string } | undefined;
      const changed = change(row ? JSON.parse(row.payload_json) as ToolExecutionRecord : null, this.now());
      if (changed.record) {
        const record = changed.record;
        this.db.prepare(`INSERT INTO tool_execution_ledger (id,tenant_id,task_id,status,updated_at,payload_json) VALUES (?,?,?,?,?,?)
          ON CONFLICT (tenant_id,id) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at,payload_json=excluded.payload_json`).run(id, tenantId, record.taskId, record.status, record.updatedAt, JSON.stringify(record));
      }
      this.db.exec('COMMIT');
      return clone(changed.result);
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  async get(tenantId: string, id: string) {
    const row = this.db.prepare('SELECT payload_json FROM tool_execution_ledger WHERE tenant_id = ? AND id = ?').get(tenantId, id) as { payload_json: string } | undefined;
    return row ? JSON.parse(row.payload_json) as ToolExecutionRecord : null;
  }
  async listForTask(tenantId: string, taskId: string, limit?: number) {
    const rows = this.db.prepare("SELECT payload_json FROM tool_execution_ledger WHERE tenant_id = ? AND task_id = ? ORDER BY CASE status WHEN 'outcome_unknown' THEN 0 WHEN 'executing' THEN 1 ELSE 2 END, updated_at DESC, id LIMIT ?").all(tenantId, taskId, boundedLimit(limit)) as Array<{ payload_json: string }>;
    return rows.map((row) => JSON.parse(row.payload_json) as ToolExecutionRecord);
  }
  async hasUnresolvedForTask(tenantId: string, taskId: string) {
    return !!this.db.prepare("SELECT 1 FROM tool_execution_ledger WHERE tenant_id=? AND task_id=? AND status IN ('executing','outcome_unknown') LIMIT 1").get(tenantId, taskId);
  }
  protected async executingIds(tenantId: string, taskId: string) {
    const rows = this.db.prepare("SELECT id FROM tool_execution_ledger WHERE tenant_id=? AND task_id=? AND status='executing'").all(tenantId, taskId) as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }
}

export class PostgresToolExecutionStore extends BaseToolExecutionStore {
  private readonly pool: Pool;
  constructor(connectionString: string) {
    super();
    this.pool = new Pool({ connectionString, max: Number(process.env.DATABASE_POOL_SIZE ?? 10), idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000, ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: true } : undefined });
  }
  async initialize() {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT pg_advisory_xact_lock(hashtext('axiom-tool-execution-ledger-schema'))");
      await client.query(schema);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async close() { await this.pool.end(); }
  protected async atomic<T>(tenantId: string, id: string, change: (record: ToolExecutionRecord | null, now: number) => Change<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`tool-execution:${tenantId}:${id}`]);
      const selected = await client.query<{ payload_json: string }>('SELECT payload_json FROM tool_execution_ledger WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [tenantId, id]);
      // Transaction timestamps precede lock waits; leases use time after acquiring both locks.
      const clock = await client.query<{ now_ms: number }>('SELECT EXTRACT(EPOCH FROM clock_timestamp()) * 1000 AS now_ms');
      const changed = change(selected.rows[0] ? JSON.parse(selected.rows[0].payload_json) as ToolExecutionRecord : null, Number(clock.rows[0]!.now_ms));
      if (changed.record) {
        const record = changed.record;
        await client.query(`INSERT INTO tool_execution_ledger (id,tenant_id,task_id,status,updated_at,payload_json) VALUES ($1,$2,$3,$4,$5,$6)
          ON CONFLICT (tenant_id,id) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at,payload_json=excluded.payload_json`, [id, tenantId, record.taskId, record.status, record.updatedAt, JSON.stringify(record)]);
      }
      await client.query('COMMIT');
      return clone(changed.result);
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async get(tenantId: string, id: string) {
    const result = await this.pool.query<{ payload_json: string }>('SELECT payload_json FROM tool_execution_ledger WHERE tenant_id=$1 AND id=$2', [tenantId, id]);
    return result.rows[0] ? JSON.parse(result.rows[0].payload_json) as ToolExecutionRecord : null;
  }
  async listForTask(tenantId: string, taskId: string, limit?: number) {
    const result = await this.pool.query<{ payload_json: string }>("SELECT payload_json FROM tool_execution_ledger WHERE tenant_id=$1 AND task_id=$2 ORDER BY CASE status WHEN 'outcome_unknown' THEN 0 WHEN 'executing' THEN 1 ELSE 2 END, updated_at DESC,id LIMIT $3", [tenantId, taskId, boundedLimit(limit)]);
    return result.rows.map((row) => JSON.parse(row.payload_json) as ToolExecutionRecord);
  }
  async hasUnresolvedForTask(tenantId: string, taskId: string) {
    const result = await this.pool.query("SELECT 1 FROM tool_execution_ledger WHERE tenant_id=$1 AND task_id=$2 AND status IN ('executing','outcome_unknown') LIMIT 1", [tenantId, taskId]);
    return result.rows.length > 0;
  }
  protected async executingIds(tenantId: string, taskId: string) {
    const result = await this.pool.query<{ id: string }>("SELECT id FROM tool_execution_ledger WHERE tenant_id=$1 AND task_id=$2 AND status='executing'", [tenantId, taskId]);
    return result.rows.map((row) => row.id);
  }
}

export const createToolExecutionStore = (): ToolExecutionStore => {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  return databaseUrl ? new PostgresToolExecutionStore(databaseUrl) : new SqliteToolExecutionStore();
};
