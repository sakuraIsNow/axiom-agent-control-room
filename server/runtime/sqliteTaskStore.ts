import { randomUUID } from 'node:crypto';
import { runtimeEventSource } from './runtimeContext.js';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  CreateTaskInput,
  RuntimeEvent,
  TaskPatch,
  TaskStats,
  TaskStatsDaily,
  OperationsSnapshot,
  TaskStatus,
  TaskStore,
  PersistedSession,
  PersistedSessionMessage,
  UpsertSessionInput,
  WorkflowTask,
} from './contracts.js';
import { dateKeyInTimeZone, fillTaskStatsDaily, runtimeTimeZone } from './taskStatsDate.js';
import { summarizeTaskEvents, type TaskEventSummaryRow } from './taskEventSummary.js';
import { buildOperationsSnapshot } from './operationsSnapshot.js';

const allTaskStatuses: TaskStatus[] = ['queued', 'planning', 'awaiting_approval', 'running', 'reviewing', 'waiting_for_human', 'paused', 'completed', 'failed', 'cancelled'];

type TaskRow = {
  id: string;
  run_id: string;
  tenant_id: string;
  user_id: string;
  session_id: string;
  template_id: string | null;
  title: string;
  input: string;
  mode: WorkflowTask['mode'];
  model: string | null;
  model_credential_id: string | null;
  status: WorkflowTask['status'];
  plan_json: string | null;
  step_results_json: string;
  review_json: string | null;
  tool_approvals_json: string | null;
  result: string | null;
  error: string | null;
  cancel_requested: number;
  plan_version: number;
  policy_json: string;
  idempotency_key: string | null;
  lease_owner?: string | null;
  lease_expires_at?: number | null;
  created_at: string;
  updated_at: string;
};

type EventRow = {
  id: string;
  type: RuntimeEvent['type'];
  task_id: string;
  run_id: string;
  sequence: number;
  agent_id: string | null;
  timestamp: string;
  payload_json: string;
  runtime_context_json: string | null;
};

type SessionRow = {
  id: string;
  tenant_id: string;
  user_id: string;
  title: string;
  messages_json: string;
  graph_json: string | null;
  active_task_id: string | null;
  active_assistant_id: string | null;
  updated_at: number;
  deleted_at: number | null;
};

const parseJson = <T>(value: string | null, fallback: T): T => {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

const defaultPolicy = () => ({ requirePlanApproval: false });

const taskFromRow = (row: TaskRow): WorkflowTask => ({
  id: row.id,
  runId: row.run_id,
  tenantId: row.tenant_id,
  userId: row.user_id,
  sessionId: row.session_id,
  templateId: row.template_id ?? undefined,
  title: row.title,
  input: row.input,
  mode: row.mode,
  model: row.model ?? undefined,
  modelCredentialId: row.model_credential_id ?? undefined,
  status: row.status,
  plan: parseJson(row.plan_json, undefined),
  stepResults: parseJson(row.step_results_json, []),
  review: parseJson(row.review_json, undefined),
  toolApprovals: parseJson(row.tool_approvals_json, undefined),
  result: row.result ?? undefined,
  error: row.error ?? undefined,
  cancelRequested: Boolean(row.cancel_requested),
  planVersion: row.plan_version ?? 0,
  policy: parseJson(row.policy_json, defaultPolicy()),
  idempotencyKey: row.idempotency_key ?? undefined,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const eventFromRow = (row: EventRow): RuntimeEvent => ({
  id: row.id,
  type: row.type,
  version: 1,
  taskId: row.task_id,
  runId: row.run_id,
  sequence: row.sequence,
  agentId: row.agent_id ?? undefined,
  timestamp: row.timestamp,
  payload: parseJson(row.payload_json, {}),
  runtimeContext: parseJson(row.runtime_context_json, undefined),
});

const sessionFromRow = (row: SessionRow): PersistedSession => ({
  id: row.id,
  tenantId: row.tenant_id,
  userId: row.user_id,
  title: row.title,
  messages: parseJson<PersistedSessionMessage[]>(row.messages_json, []),
  agentGraph: parseJson<PersistedSession['agentGraph']>(row.graph_json, undefined),
  updatedAt: Number(row.updated_at),
  activeTaskId: row.active_task_id ?? undefined,
  activeAssistantId: row.active_assistant_id ?? undefined,
});

export class SqliteTaskStore implements TaskStore {
  private readonly db: DatabaseSync;
  private readonly runtimeGeneration = process.env.AXIOM_RUNTIME_GENERATION?.trim() || randomUUID();

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
  }

  async initialize() {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL UNIQUE,
        tenant_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        template_id TEXT,
        title TEXT NOT NULL,
        input TEXT NOT NULL,
        mode TEXT NOT NULL,
        model TEXT,
        model_credential_id TEXT,
        status TEXT NOT NULL,
        plan_json TEXT,
        step_results_json TEXT NOT NULL DEFAULT '[]',
        review_json TEXT,
        tool_approvals_json TEXT,
        result TEXT,
        error TEXT,
        cancel_requested INTEGER NOT NULL DEFAULT 0,
        plan_version INTEGER NOT NULL DEFAULT 0,
        policy_json TEXT NOT NULL DEFAULT '{"requirePlanApproval":false}',
        idempotency_key TEXT,
        lease_owner TEXT,
        lease_expires_at INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS task_events (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        type TEXT NOT NULL,
        agent_id TEXT,
        timestamp TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        runtime_context_json TEXT,
        UNIQUE(task_id, sequence)
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_tenant_updated ON tasks(tenant_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_tasks_claim ON tasks(status, lease_expires_at, created_at);
      CREATE INDEX IF NOT EXISTS idx_events_task_sequence ON task_events(task_id, sequence);
      CREATE INDEX IF NOT EXISTS idx_events_timestamp ON task_events(timestamp);
      CREATE INDEX IF NOT EXISTS idx_events_model_routing ON task_events(type);

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        title TEXT NOT NULL,
        messages_json TEXT NOT NULL,
        graph_json TEXT,
        active_task_id TEXT,
        active_assistant_id TEXT,
        updated_at INTEGER NOT NULL,
        deleted_at INTEGER,
        PRIMARY KEY (tenant_id, id)
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_user_updated ON sessions(tenant_id, user_id, updated_at DESC);
    `);
    const eventColumns = this.db.prepare('PRAGMA table_info(task_events)').all() as Array<{ name: string }>;
    if (!eventColumns.some((column) => column.name === 'runtime_context_json')) {
      this.db.exec('ALTER TABLE task_events ADD COLUMN runtime_context_json TEXT');
    }
    const columns = this.db.prepare('PRAGMA table_info(tasks)').all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'plan_version')) {
      this.db.exec('ALTER TABLE tasks ADD COLUMN plan_version INTEGER NOT NULL DEFAULT 0');
    }
    if (!columns.some((column) => column.name === 'policy_json')) {
      this.db.exec(`ALTER TABLE tasks ADD COLUMN policy_json TEXT NOT NULL DEFAULT '{"requirePlanApproval":false}'`);
    }
    if (!columns.some((column) => column.name === 'idempotency_key')) {
      this.db.exec('ALTER TABLE tasks ADD COLUMN idempotency_key TEXT');
    }
    if (!columns.some((column) => column.name === 'template_id')) {
      this.db.exec('ALTER TABLE tasks ADD COLUMN template_id TEXT');
    }
    if (!columns.some((column) => column.name === 'tool_approvals_json')) {
      this.db.exec('ALTER TABLE tasks ADD COLUMN tool_approvals_json TEXT');
    }
    if (!columns.some((column) => column.name === 'model')) {
      this.db.exec('ALTER TABLE tasks ADD COLUMN model TEXT');
    }
    if (!columns.some((column) => column.name === 'model_credential_id')) {
      this.db.exec('ALTER TABLE tasks ADD COLUMN model_credential_id TEXT');
    }
    const sessionColumns = this.db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>;
    if (!sessionColumns.some((column) => column.name === 'deleted_at')) {
      this.db.exec('ALTER TABLE sessions ADD COLUMN deleted_at INTEGER');
    }
    if (!sessionColumns.some((column) => column.name === 'graph_json')) {
      this.db.exec('ALTER TABLE sessions ADD COLUMN graph_json TEXT');
    }
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_idempotency ON tasks(tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL');
  }

  async close() {
    this.db.close();
  }

  async createTask(input: CreateTaskInput) {
    const now = new Date().toISOString();
  const task: WorkflowTask = {
      ...input,
      id: randomUUID(),
      runId: randomUUID(),
      status: 'queued',
      stepResults: [],
      cancelRequested: false,
      planVersion: 0,
      policy: { ...defaultPolicy(), ...(input.policy ?? {}) },
    idempotencyKey: input.idempotencyKey?.trim() || undefined,
    plan: input.plan,
      createdAt: now,
      updatedAt: now,
    };
    this.db.prepare(`
      INSERT INTO tasks (
        id, run_id, tenant_id, user_id, session_id, template_id, title, input, mode, model, model_credential_id, status,
        plan_json, step_results_json, cancel_requested, plan_version, policy_json, idempotency_key, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', 0, 0, ?, ?, ?, ?)
    `).run(
      task.id,
      task.runId,
      task.tenantId,
      task.userId,
      task.sessionId,
      task.templateId ?? null,
      task.title,
      task.input,
      task.mode,
      task.model ?? null,
      task.modelCredentialId ?? null,
      task.status,
      task.plan ? JSON.stringify(task.plan) : null,
      JSON.stringify(task.policy),
      task.idempotencyKey ?? null,
      task.createdAt,
      task.updatedAt,
    );
    return task;
  }

  async getTask(taskId: string, tenantId?: string) {
    const row = tenantId
      ? this.db.prepare('SELECT * FROM tasks WHERE id = ? AND tenant_id = ?').get(taskId, tenantId)
      : this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
    return row ? taskFromRow(row as TaskRow) : null;
  }

  async deleteTask(taskId: string, tenantId: string) {
    const result = this.db.prepare('DELETE FROM tasks WHERE id = ? AND tenant_id = ?').run(taskId, tenantId);
    return result.changes > 0;
  }

  async findTaskByIdempotency(tenantId: string, idempotencyKey: string) {
    const row = this.db.prepare('SELECT * FROM tasks WHERE tenant_id = ? AND idempotency_key = ?').get(tenantId, idempotencyKey);
    return row ? taskFromRow(row as TaskRow) : null;
  }

  async getModelRoutingStats() {
    const rows = this.db.prepare(`
      SELECT model,
        SUM(attempts) AS attempts,
        SUM(successes) AS successes,
        SUM(failures) AS failures,
        SUM(duration_ms) AS total_latency_ms,
        SUM(total_tokens) AS total_tokens,
        MAX(timestamp) AS last_used_at
      FROM (
        SELECT json_extract(payload_json, '$.model') AS model,
          1 AS attempts,
          1 AS successes,
          0 AS failures,
          COALESCE(json_extract(payload_json, '$.durationMs'), 0) AS duration_ms,
          COALESCE(json_extract(payload_json, '$.totalTokens'), 0) AS total_tokens,
          timestamp
        FROM task_events WHERE type = 'model.completed'
        UNION ALL
        SELECT json_extract(payload_json, '$.model') AS model,
          1 AS attempts,
          0 AS successes,
          1 AS failures,
          0 AS duration_ms,
          0 AS total_tokens,
          timestamp
        FROM task_events WHERE type = 'agent.failed'
      ) observations
      WHERE model IS NOT NULL AND TRIM(model) <> ''
      GROUP BY model
    `).all() as Array<{ model: string; attempts: number; successes: number; failures: number; total_latency_ms: number; total_tokens: number; last_used_at?: string }>;
    return rows.map((row) => ({
      model: row.model,
      attempts: Number(row.attempts ?? 0),
      successes: Number(row.successes ?? 0),
      failures: Number(row.failures ?? 0),
      totalLatencyMs: Number(row.total_latency_ms ?? 0),
      totalTokens: Number(row.total_tokens ?? 0),
      ...(row.last_used_at ? { lastUsedAt: row.last_used_at } : {}),
    }));
  }

  async listTasks(tenantId: string, limit = 50) {
    const rows = this.db.prepare(
      'SELECT * FROM tasks WHERE tenant_id = ? ORDER BY updated_at DESC LIMIT ?',
    ).all(tenantId, Math.min(100, Math.max(1, limit))) as TaskRow[];
    return rows.map(taskFromRow);
  }

  async listRecoverableHarnessTasks(limit = 100) {
    const rows = this.db.prepare(`
      SELECT t.* FROM tasks t
      WHERE t.status IN ('running', 'paused', 'waiting_for_human')
        AND EXISTS (
          SELECT 1 FROM task_events e
          WHERE e.task_id = t.id AND e.type = 'harness.connected'
        )
      ORDER BY t.updated_at ASC LIMIT ?
    `).all(Math.min(500, Math.max(1, Math.floor(limit)))) as TaskRow[];
    return rows.map(taskFromRow);
  }

  async listTasksByTemplate(tenantId: string, templateId: string) {
    const rows = this.db.prepare(
      'SELECT * FROM tasks WHERE tenant_id = ? AND template_id = ? ORDER BY created_at ASC',
    ).all(tenantId, templateId) as TaskRow[];
    return rows.map(taskFromRow);
  }

  async listTasksByTrigger(tenantId: string, triggerId: string, limit = 50) {
    const rows = this.db.prepare(`
      SELECT DISTINCT t.* FROM tasks t
      JOIN task_events e ON e.task_id = t.id
      WHERE t.tenant_id = ? AND e.type = 'task.created'
        AND json_extract(e.payload_json, '$.triggerId') = ?
      ORDER BY t.created_at DESC LIMIT ?
    `).all(tenantId, triggerId, Math.min(100, Math.max(1, Math.floor(limit)))) as TaskRow[];
    return rows.map(taskFromRow);
  }

  async getTaskEventSummaries(taskIds: string[], tenantId: string) {
    const ids = [...new Set(taskIds.filter(Boolean))];
    if (!ids.length) return new Map();
    const placeholders = ids.map(() => '?').join(', ');
    const rows = this.db.prepare(`
      SELECT e.task_id, e.sequence, e.type, e.timestamp, e.payload_json
      FROM task_events e JOIN tasks t ON t.id = e.task_id
      WHERE t.tenant_id = ? AND e.task_id IN (${placeholders})
      ORDER BY e.task_id ASC, e.sequence ASC
    `).all(tenantId, ...ids) as Array<{ task_id: string; sequence: number; type: RuntimeEvent['type']; timestamp: string; payload_json: string }>;
    const summaryRows: TaskEventSummaryRow[] = rows.map((row) => ({
      taskId: row.task_id,
      sequence: Number(row.sequence),
      type: row.type,
      timestamp: row.timestamp,
      payload: parseJson<Record<string, unknown>>(row.payload_json, {}),
    }));
    return summarizeTaskEvents(summaryRows);
  }

  async getTaskStats(tenantId: string): Promise<TaskStats> {
    const statusRows = this.db.prepare(
      'SELECT status, COUNT(*) AS count FROM tasks WHERE tenant_id = ? GROUP BY status',
    ).all(tenantId) as Array<{ status: TaskStatus; count: number }>;
    const byStatus = Object.fromEntries(allTaskStatuses.map((status) => [status, 0])) as Record<TaskStatus, number>;
    for (const row of statusRows) byStatus[row.status] = row.count;
    const now = Date.now();
    const last24hIso = new Date(now - 24 * 60 * 60 * 1000).toISOString();
    const prev48hIso = new Date(now - 48 * 60 * 60 * 1000).toISOString();
    const window = this.db.prepare(`
      SELECT
        SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS last_24h,
        SUM(CASE WHEN created_at >= ? AND created_at < ? THEN 1 ELSE 0 END) AS prev_24h
      FROM tasks WHERE tenant_id = ?
    `).get(last24hIso, prev48hIso, last24hIso, tenantId) as { last_24h: number | null; prev_24h: number | null };
    const review = this.db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN json_extract(e.payload_json, '$.approved') = 1 THEN 1 ELSE 0 END) AS approved
      FROM task_events e JOIN tasks t ON t.id = e.task_id
      WHERE t.tenant_id = ? AND e.type = 'review.completed'
    `).get(tenantId) as { total: number | null; approved: number | null };
    const reviewApprovalRate = review.total ? Number((Number(review.approved ?? 0) / Number(review.total) * 100).toFixed(1)) : null;
    return { byStatus, createdLast24h: window.last_24h ?? 0, createdPrev24h: window.prev_24h ?? 0, reviewApprovalRate };
  }

  async getTaskStatsDaily(tenantId: string, days: number): Promise<TaskStatsDaily[]> {
    const safeDays = Math.min(31, Math.max(1, Math.floor(days)));
    const now = Date.now();
    const timeZone = runtimeTimeZone();
    const since = new Date(now - (safeDays + 1) * 24 * 60 * 60 * 1000).toISOString();
    const rows = this.db.prepare(`
      SELECT e.timestamp,
        COALESCE(json_extract(e.payload_json, '$.totalTokens'), 0) AS total_tokens,
        COALESCE(json_extract(e.payload_json, '$.estimatedCostUsd'), 0) AS estimated_cost
      FROM task_events e JOIN tasks t ON t.id = e.task_id
      WHERE t.tenant_id = ? AND e.type = 'model.completed' AND e.timestamp >= ?
      ORDER BY e.timestamp ASC
    `).all(tenantId, since) as Array<{ timestamp: string; total_tokens: number | null; estimated_cost: number | null }>;
    const totals = new Map<string, TaskStatsDaily>();
    for (const row of rows) {
      const date = dateKeyInTimeZone(row.timestamp, timeZone);
      const current = totals.get(date);
      totals.set(date, {
        date,
        totalTokens: (current?.totalTokens ?? 0) + Number(row.total_tokens ?? 0),
        estimatedCostUsd: Number(((current?.estimatedCostUsd ?? 0) + Number(row.estimated_cost ?? 0)).toFixed(6)),
      });
    }
    return fillTaskStatsDaily(totals.values(), safeDays, now, timeZone);
  }

  async getOperationsSnapshot(tenantId: string, windowHours = 24): Promise<OperationsSnapshot> {
    const safeHours = Math.min(168, Math.max(1, Math.floor(windowHours)));
    const since = new Date(Date.now() - safeHours * 60 * 60 * 1_000).toISOString();
    const tasks = this.db.prepare(`
      SELECT id, status, lease_owner, lease_expires_at, created_at, updated_at
      FROM tasks WHERE tenant_id = ?
    `).all(tenantId) as Array<Pick<TaskRow, 'id' | 'status' | 'lease_owner' | 'lease_expires_at' | 'created_at' | 'updated_at'>>;
    const events = this.db.prepare(`
      SELECT e.task_id, e.type, e.agent_id, e.timestamp, e.payload_json
      FROM task_events e JOIN tasks t ON t.id = e.task_id
      WHERE t.tenant_id = ? AND e.timestamp >= ?
      ORDER BY e.timestamp ASC
    `).all(tenantId, since) as Array<{ task_id: string; type: string; agent_id: string | null; timestamp: string; payload_json: string }>;
    return buildOperationsSnapshot(
      tasks.map((task) => ({ id: task.id, status: task.status, leaseOwner: task.lease_owner, leaseExpiresAt: task.lease_expires_at, createdAt: task.created_at, updatedAt: task.updated_at })),
      events.map((event) => ({ taskId: event.task_id, type: event.type, agentId: event.agent_id, timestamp: event.timestamp, payload: parseJson(event.payload_json, {}) })),
      { windowHours: safeHours },
    );
  }

  async updateTask(taskId: string, patch: TaskPatch) {
    const columns: string[] = [];
    const values: Array<string | number | bigint | Uint8Array | null> = [];
    const assign = (column: string, value: string | number | bigint | Uint8Array | null) => {
      columns.push(`${column} = ?`);
      values.push(value);
    };

    if (patch.status !== undefined) assign('status', patch.status);
    if (patch.plan !== undefined) assign('plan_json', patch.plan === null ? null : JSON.stringify(patch.plan));
    if (patch.stepResults !== undefined) assign('step_results_json', JSON.stringify(patch.stepResults));
    if (patch.review !== undefined) assign('review_json', patch.review === null ? null : JSON.stringify(patch.review));
    if (patch.toolApprovals !== undefined) assign('tool_approvals_json', patch.toolApprovals === null ? null : JSON.stringify(patch.toolApprovals));
    if (patch.result !== undefined) assign('result', patch.result);
    if (patch.error !== undefined) assign('error', patch.error);
    if (patch.cancelRequested !== undefined) assign('cancel_requested', patch.cancelRequested ? 1 : 0);
    if (patch.planVersion !== undefined) assign('plan_version', patch.planVersion);
    if (patch.policy !== undefined) assign('policy_json', JSON.stringify(patch.policy));
    assign('updated_at', new Date().toISOString());
    values.push(taskId);

    this.db.prepare(`UPDATE tasks SET ${columns.join(', ')} WHERE id = ?`).run(...values);
    const updated = await this.getTask(taskId);
    if (!updated) throw new Error(`Task ${taskId} was not found after update.`);
    return updated;
  }

  async requestCancel(taskId: string, tenantId: string) {
    const result = this.db.prepare(`
      UPDATE tasks
      SET cancel_requested = 1,
          status = CASE WHEN status IN ('queued', 'awaiting_approval', 'waiting_for_human', 'paused') THEN 'cancelled' ELSE status END,
          updated_at = ?
      WHERE id = ? AND tenant_id = ? AND status NOT IN ('completed', 'failed', 'cancelled')
    `).run(new Date().toISOString(), taskId, tenantId);
    return result.changes > 0;
  }

  async claimNextTask(workerId: string, leaseMs: number) {
    const now = Date.now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare(`
        SELECT * FROM tasks
        WHERE status IN ('queued', 'planning', 'running', 'reviewing')
          AND cancel_requested = 0
          AND (lease_owner IS NULL OR lease_expires_at < ?)
        ORDER BY created_at ASC
        LIMIT 1
      `).get(now) as TaskRow | undefined;
      if (!row) {
        this.db.exec('COMMIT');
        return null;
      }
      this.db.prepare(`
        UPDATE tasks SET lease_owner = ?, lease_expires_at = ?, updated_at = ? WHERE id = ?
      `).run(workerId, now + leaseMs, new Date().toISOString(), row.id);
      this.db.exec('COMMIT');
      return await this.getTask(row.id);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async renewLease(taskId: string, workerId: string, leaseMs: number) {
    const result = this.db.prepare(`
      UPDATE tasks SET lease_expires_at = ?, updated_at = ? WHERE id = ? AND lease_owner = ?
    `).run(Date.now() + leaseMs, new Date().toISOString(), taskId, workerId);
    return result.changes > 0;
  }

  async releaseLease(taskId: string, workerId: string) {
    this.db.prepare(`
      UPDATE tasks SET lease_owner = NULL, lease_expires_at = NULL WHERE id = ? AND lease_owner = ?
    `).run(taskId, workerId);
  }

  async appendEvent(
    task: Pick<WorkflowTask, 'id' | 'runId'>,
    event: Omit<RuntimeEvent, 'id' | 'taskId' | 'runId' | 'sequence' | 'timestamp' | 'version'>,
  ) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const sequenceRow = this.db.prepare(
        'SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM task_events WHERE task_id = ?',
      ).get(task.id) as { sequence: number };
      const runtimeEvent: RuntimeEvent = {
        ...event,
        id: randomUUID(),
        version: 1,
        taskId: task.id,
        runId: task.runId,
        sequence: sequenceRow.sequence,
        timestamp: new Date().toISOString(),
      };
      const contextRow = this.db.prepare(`
        SELECT tenant_id, user_id, session_id, template_id, idempotency_key
        FROM tasks WHERE id = ?
      `).get(task.id) as { tenant_id?: string; user_id?: string; session_id?: string; template_id?: string | null; idempotency_key?: string | null } | undefined;
      runtimeEvent.runtimeContext = {
        ...(contextRow?.tenant_id ? { tenantId: contextRow.tenant_id } : {}),
        ...(contextRow?.user_id ? { userId: contextRow.user_id } : {}),
        ...(contextRow?.session_id ? { sessionId: contextRow.session_id } : {}),
        ...(contextRow?.template_id ? { workflowId: contextRow.template_id } : {}),
        turnId: typeof runtimeEvent.payload.turnId === 'string' ? runtimeEvent.payload.turnId : runtimeEvent.runId,
        ...(typeof runtimeEvent.payload.attemptId === 'string' ? { attemptId: runtimeEvent.payload.attemptId } : {}),
        runtimeGeneration: this.runtimeGeneration,
        ownerId: contextRow?.user_id ? String(contextRow.user_id) : undefined,
        source: runtimeEventSource(runtimeEvent),
        ...(contextRow?.idempotency_key ? { submissionId: contextRow.idempotency_key } : {}),
      };
      this.db.prepare(`
        INSERT INTO task_events (id, task_id, run_id, sequence, type, agent_id, timestamp, payload_json, runtime_context_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        runtimeEvent.id,
        runtimeEvent.taskId,
        runtimeEvent.runId,
        runtimeEvent.sequence,
        runtimeEvent.type,
        runtimeEvent.agentId ?? null,
        runtimeEvent.timestamp,
        JSON.stringify(runtimeEvent.payload),
        JSON.stringify(runtimeEvent.runtimeContext),
      );
      this.db.exec('COMMIT');
      return runtimeEvent;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  async getEvents(taskId: string, afterSequence = 0) {
    const rows = this.db.prepare(`
      SELECT * FROM task_events WHERE task_id = ? AND sequence > ? ORDER BY sequence ASC
    `).all(taskId, afterSequence) as EventRow[];
    return rows.map(eventFromRow);
  }

  async listSessions(tenantId: string, userId: string, limit = 50) {
    const rows = this.db.prepare(`
      SELECT * FROM sessions
      WHERE tenant_id = ? AND user_id = ? AND deleted_at IS NULL
      ORDER BY updated_at DESC LIMIT ?
    `).all(tenantId, userId, Math.min(100, Math.max(1, Math.floor(limit)))) as SessionRow[];
    return rows.map(sessionFromRow);
  }

  async listDeletedSessionIds(tenantId: string, userId: string) {
    const rows = this.db.prepare('SELECT id FROM sessions WHERE tenant_id = ? AND user_id = ? AND deleted_at IS NOT NULL').all(tenantId, userId) as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  async upsertSession(tenantId: string, userId: string, input: UpsertSessionInput) {
    this.db.prepare(`
      INSERT INTO sessions (id, tenant_id, user_id, title, messages_json, graph_json, active_task_id, active_assistant_id, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (tenant_id, id) DO UPDATE SET
        title = excluded.title,
        messages_json = excluded.messages_json,
        graph_json = excluded.graph_json,
        active_task_id = excluded.active_task_id,
        active_assistant_id = excluded.active_assistant_id,
        updated_at = excluded.updated_at,
        deleted_at = NULL
      WHERE sessions.user_id = excluded.user_id
        AND excluded.updated_at >= sessions.updated_at
    `).run(
      input.id,
      tenantId,
      userId,
      input.title,
      JSON.stringify(input.messages),
      input.agentGraph ? JSON.stringify(input.agentGraph) : null,
      input.activeTaskId ?? null,
      input.activeAssistantId ?? null,
      input.updatedAt,
    );
    const row = this.db.prepare('SELECT * FROM sessions WHERE tenant_id = ? AND user_id = ? AND id = ?').get(tenantId, userId, input.id) as SessionRow | undefined;
    if (!row) throw new Error('Session is owned by another user or could not be persisted.');
    return sessionFromRow(row);
  }

  async deleteSession(sessionId: string, tenantId: string, userId: string) {
    const now = Date.now();
    const result = this.db.prepare(`
      INSERT INTO sessions (id, tenant_id, user_id, title, messages_json, updated_at, deleted_at)
      VALUES (?, ?, ?, '', '[]', ?, ?)
      ON CONFLICT (tenant_id, id) DO UPDATE SET deleted_at = excluded.deleted_at, updated_at = excluded.updated_at
      WHERE sessions.user_id = excluded.user_id
    `).run(sessionId, tenantId, userId, now, now);
    return result.changes > 0;
  }
}
