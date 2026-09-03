import { randomUUID } from 'node:crypto';
import { runtimeEventSource } from './runtimeContext.js';
import { Pool, type PoolClient } from 'pg';
import { TaskRevisionConflictError } from './contracts.js';
import type {
  AgentGraph,
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
import { runtimeTimeZone } from './taskStatsDate.js';
import { summarizeTaskEvents, type TaskEventSummaryRow } from './taskEventSummary.js';
import { buildOperationsSnapshot } from './operationsSnapshot.js';

const allTaskStatuses: TaskStatus[] = ['queued', 'planning', 'awaiting_approval', 'running', 'reviewing', 'waiting_for_human', 'paused', 'completed', 'failed', 'cancelled'];

type PostgresTaskRow = {
  id: string;
  run_id: string;
  revision: number;
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
  plan_json: WorkflowTask['plan'] | null;
  step_results_json: WorkflowTask['stepResults'];
  review_json: WorkflowTask['review'] | null;
  tool_approvals_json: WorkflowTask['toolApprovals'] | null;
  result: string | null;
  error: string | null;
  cancel_requested: boolean;
  plan_version: number;
  policy_json: WorkflowTask['policy'];
  idempotency_key: string | null;
  lease_owner?: string | null;
  lease_expires_at?: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

type PostgresSessionRow = {
  id: string;
  tenant_id: string;
  user_id: string;
  title: string;
  messages_json: PersistedSessionMessage[];
  graph_json: AgentGraph | null;
  context_summary_json: PersistedSession['contextSummary'] | null;
  active_task_id: string | null;
  active_assistant_id: string | null;
  updated_at: Date | string | number;
  deleted_at: Date | string | number | null;
};

const iso = (value: Date | string) => value instanceof Date ? value.toISOString() : value;

const taskFromRow = (row: PostgresTaskRow): WorkflowTask => ({
  id: row.id,
  runId: row.run_id,
  revision: Number(row.revision ?? 0),
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
  plan: row.plan_json ?? undefined,
  stepResults: row.step_results_json ?? [],
  review: row.review_json ?? undefined,
  toolApprovals: row.tool_approvals_json ?? undefined,
  result: row.result ?? undefined,
  error: row.error ?? undefined,
  cancelRequested: row.cancel_requested,
  planVersion: row.plan_version ?? 0,
  policy: row.policy_json ?? { requirePlanApproval: false },
  idempotencyKey: row.idempotency_key ?? undefined,
  createdAt: iso(row.created_at),
  updatedAt: iso(row.updated_at),
});

const sessionFromRow = (row: PostgresSessionRow): PersistedSession => ({
  id: row.id,
  tenantId: row.tenant_id,
  userId: row.user_id,
  title: row.title,
  messages: row.messages_json ?? [],
  agentGraph: row.graph_json ?? undefined,
  contextSummary: row.context_summary_json ?? undefined,
  updatedAt: Number(row.updated_at instanceof Date ? row.updated_at.getTime() : row.updated_at),
  activeTaskId: row.active_task_id ?? undefined,
  activeAssistantId: row.active_assistant_id ?? undefined,
});

export class PostgresTaskStore implements TaskStore {
  private readonly pool: Pool;
  private readonly runtimeGeneration = process.env.AXIOM_RUNTIME_GENERATION?.trim() || randomUUID();

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
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id UUID PRIMARY KEY,
        run_id UUID NOT NULL UNIQUE,
        revision INTEGER NOT NULL DEFAULT 0,
        tenant_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        template_id UUID,
        title TEXT NOT NULL,
        input TEXT NOT NULL,
        mode TEXT NOT NULL,
        model TEXT,
        model_credential_id UUID,
        status TEXT NOT NULL,
        plan_json JSONB,
        step_results_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        review_json JSONB,
        tool_approvals_json JSONB,
        result TEXT,
        error TEXT,
        cancel_requested BOOLEAN NOT NULL DEFAULT FALSE,
        plan_version INTEGER NOT NULL DEFAULT 0,
        policy_json JSONB NOT NULL DEFAULT '{"requirePlanApproval":false}'::jsonb,
        idempotency_key TEXT,
        lease_owner TEXT,
        lease_expires_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      );

      CREATE TABLE IF NOT EXISTS task_events (
        id UUID PRIMARY KEY,
        task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        run_id UUID NOT NULL,
        sequence INTEGER NOT NULL,
        type TEXT NOT NULL,
        agent_id TEXT,
        timestamp TIMESTAMPTZ NOT NULL,
        payload_json JSONB NOT NULL,
        runtime_context_json JSONB,
        UNIQUE(task_id, sequence)
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_tenant_updated ON tasks(tenant_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_tasks_claim ON tasks(status, lease_expires_at, created_at);
      CREATE INDEX IF NOT EXISTS idx_events_task_sequence ON task_events(task_id, sequence);
      CREATE INDEX IF NOT EXISTS idx_events_timestamp ON task_events(timestamp);
      CREATE INDEX IF NOT EXISTS idx_events_model_routing ON task_events(type) WHERE type IN ('model.completed', 'agent.failed');

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        title TEXT NOT NULL,
        messages_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        graph_json JSONB,
        context_summary_json JSONB,
        active_task_id TEXT,
        active_assistant_id TEXT,
        updated_at BIGINT NOT NULL,
        deleted_at BIGINT,
        PRIMARY KEY (tenant_id, id)
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_user_updated ON sessions(tenant_id, user_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS notification_receipts (
        tenant_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        notification_id TEXT NOT NULL,
        read_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (tenant_id, user_id, notification_id)
      );

      CREATE INDEX IF NOT EXISTS idx_notification_receipts_user_read
        ON notification_receipts(tenant_id, user_id, read_at DESC);

      INSERT INTO schema_migrations (version) VALUES (1) ON CONFLICT (version) DO NOTHING;

      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS plan_version INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS policy_json JSONB NOT NULL DEFAULT '{"requirePlanApproval":false}'::jsonb;
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS template_id UUID;
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS model TEXT;
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS model_credential_id UUID;
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS tool_approvals_json JSONB;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_idempotency ON tasks(tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS deleted_at BIGINT;
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS graph_json JSONB;
      ALTER TABLE sessions ADD COLUMN IF NOT EXISTS context_summary_json JSONB;
      ALTER TABLE task_events ADD COLUMN IF NOT EXISTS runtime_context_json JSONB;
    `);
  }

  async close() {
    await this.pool.end();
  }

  async createTask(input: CreateTaskInput) {
    const now = new Date().toISOString();
    const task: WorkflowTask = {
      ...input,
      id: randomUUID(),
      runId: randomUUID(),
      revision: 0,
      status: 'queued',
      stepResults: [],
      cancelRequested: false,
      planVersion: 0,
    policy: { requirePlanApproval: false, ...(input.policy ?? {}) },
    idempotencyKey: input.idempotencyKey?.trim() || undefined,
    plan: input.plan,
      createdAt: now,
      updatedAt: now,
    };
    await this.pool.query(`
      INSERT INTO tasks (
        id, run_id, tenant_id, user_id, session_id, template_id, title, input, mode, model, model_credential_id, status,
        plan_json, step_results_json, cancel_requested, plan_version, policy_json, idempotency_key, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, '[]'::jsonb, FALSE, 0, $14, $15, $16, $17)
    `, [
      task.id, task.runId, task.tenantId, task.userId, task.sessionId, task.templateId ?? null, task.title,
      task.input, task.mode, task.model ?? null, task.modelCredentialId ?? null, task.status, task.plan ?? null, JSON.stringify(task.policy), task.idempotencyKey ?? null, task.createdAt, task.updatedAt,
    ]);
    return task;
  }

  async getTask(taskId: string, tenantId?: string) {
    const result = tenantId
      ? await this.pool.query('SELECT * FROM tasks WHERE id = $1 AND tenant_id = $2', [taskId, tenantId])
      : await this.pool.query('SELECT * FROM tasks WHERE id = $1', [taskId]);
    return result.rows[0] ? taskFromRow(result.rows[0] as PostgresTaskRow) : null;
  }

  async deleteTask(taskId: string, tenantId: string) {
    const result = await this.pool.query('DELETE FROM tasks WHERE id = $1 AND tenant_id = $2', [taskId, tenantId]);
    return (result.rowCount ?? 0) > 0;
  }

  async findTaskByIdempotency(tenantId: string, idempotencyKey: string) {
    const result = await this.pool.query('SELECT * FROM tasks WHERE tenant_id = $1 AND idempotency_key = $2', [tenantId, idempotencyKey]);
    return result.rows[0] ? taskFromRow(result.rows[0] as PostgresTaskRow) : null;
  }

  async getModelRoutingStats() {
    const result = await this.pool.query(`
      SELECT model,
        SUM(attempts)::float8 AS attempts,
        SUM(successes)::float8 AS successes,
        SUM(failures)::float8 AS failures,
        SUM(duration_ms)::float8 AS total_latency_ms,
        SUM(total_tokens)::float8 AS total_tokens,
        MAX(timestamp) AS last_used_at
      FROM (
        SELECT payload_json->>'model' AS model,
          1::float8 AS attempts,
          1::float8 AS successes,
          0::float8 AS failures,
          COALESCE(NULLIF(payload_json->>'durationMs', '')::float8, 0) AS duration_ms,
          COALESCE(NULLIF(payload_json->>'totalTokens', '')::float8, 0) AS total_tokens,
          timestamp
        FROM task_events WHERE type = 'model.completed'
        UNION ALL
        SELECT payload_json->>'model' AS model,
          1::float8 AS attempts,
          0::float8 AS successes,
          1::float8 AS failures,
          0::float8 AS duration_ms,
          0::float8 AS total_tokens,
          timestamp
        FROM task_events WHERE type = 'agent.failed'
      ) observations
      WHERE model IS NOT NULL AND BTRIM(model) <> ''
      GROUP BY model
    `);
    return result.rows.map((row) => ({
      model: String(row.model),
      attempts: Number(row.attempts ?? 0),
      successes: Number(row.successes ?? 0),
      failures: Number(row.failures ?? 0),
      totalLatencyMs: Number(row.total_latency_ms ?? 0),
      totalTokens: Number(row.total_tokens ?? 0),
      ...(row.last_used_at ? { lastUsedAt: new Date(String(row.last_used_at)).toISOString() } : {}),
    }));
  }

  async listTasks(tenantId: string, limit = 50) {
    const result = await this.pool.query(
      'SELECT * FROM tasks WHERE tenant_id = $1 ORDER BY updated_at DESC LIMIT $2',
      [tenantId, Math.min(100, Math.max(1, limit))],
    );
    return result.rows.map((row) => taskFromRow(row as PostgresTaskRow));
  }

  async listRecoverableHarnessTasks(limit = 100) {
    const result = await this.pool.query(`
      SELECT t.* FROM tasks t
      WHERE t.status IN ('running', 'paused', 'waiting_for_human')
        AND EXISTS (
          SELECT 1 FROM task_events e
          WHERE e.task_id = t.id AND e.type = 'harness.connected'
        )
      ORDER BY t.updated_at ASC LIMIT $1
    `, [Math.min(500, Math.max(1, Math.floor(limit)))]);
    return result.rows.map((row) => taskFromRow(row as PostgresTaskRow));
  }

  async listTasksByTemplate(tenantId: string, templateId: string) {
    const result = await this.pool.query(
      'SELECT * FROM tasks WHERE tenant_id = $1 AND template_id = $2 ORDER BY created_at ASC',
      [tenantId, templateId],
    );
    return result.rows.map((row) => taskFromRow(row as PostgresTaskRow));
  }

  async listTasksByTrigger(tenantId: string, triggerId: string, limit = 50) {
    const result = await this.pool.query(`
      SELECT DISTINCT t.* FROM tasks t
      JOIN task_events e ON e.task_id = t.id
      WHERE t.tenant_id = $1 AND e.type = 'task.created'
        AND e.payload_json ->> 'triggerId' = $2
      ORDER BY t.created_at DESC LIMIT $3
    `, [tenantId, triggerId, Math.min(100, Math.max(1, Math.floor(limit)))]);
    return result.rows.map((row) => taskFromRow(row as PostgresTaskRow));
  }

  async getTaskEventSummaries(taskIds: string[], tenantId: string) {
    const ids = [...new Set(taskIds.filter(Boolean))];
    if (!ids.length) return new Map();
    const result = await this.pool.query(`
      SELECT e.task_id, e.sequence, e.type, e.timestamp, e.payload_json
      FROM task_events e JOIN tasks t ON t.id = e.task_id
      WHERE t.tenant_id = $1 AND e.task_id = ANY($2::uuid[])
      ORDER BY e.task_id ASC, e.sequence ASC
    `, [tenantId, ids]);
    const rows: TaskEventSummaryRow[] = result.rows.map((row) => ({
      taskId: String(row.task_id),
      sequence: Number(row.sequence),
      type: row.type,
      timestamp: iso(row.timestamp as Date | string),
      payload: (row.payload_json ?? {}) as Record<string, unknown>,
    }));
    return summarizeTaskEvents(rows);
  }

  async getTaskStats(tenantId: string): Promise<TaskStats> {
    const [statusResult, windowResult, reviewResult] = await Promise.all([
      this.pool.query('SELECT status, COUNT(*)::int AS count FROM tasks WHERE tenant_id = $1 GROUP BY status', [tenantId]),
      this.pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours')::int AS last_24h,
          COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '48 hours' AND created_at < NOW() - INTERVAL '24 hours')::int AS prev_24h
        FROM tasks WHERE tenant_id = $1
      `, [tenantId]),
      this.pool.query(`
        SELECT COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE (payload_json->>'approved')::boolean IS TRUE)::int AS approved
        FROM task_events e JOIN tasks t ON t.id = e.task_id
        WHERE t.tenant_id = $1 AND e.type = 'review.completed'
      `, [tenantId]),
    ]);
    const byStatus = Object.fromEntries(allTaskStatuses.map((status) => [status, 0])) as Record<TaskStatus, number>;
    for (const row of statusResult.rows as Array<{ status: TaskStatus; count: number }>) {
      byStatus[row.status] = row.count;
    }
    const window = windowResult.rows[0] as { last_24h: number; prev_24h: number };
    const review = reviewResult.rows[0] as { total: number; approved: number };
    const reviewApprovalRate = review.total ? Number((review.approved / review.total * 100).toFixed(1)) : null;
    return { byStatus, createdLast24h: window.last_24h, createdPrev24h: window.prev_24h, reviewApprovalRate };
  }

  async getTaskStatsDaily(tenantId: string, days: number): Promise<TaskStatsDaily[]> {
    const safeDays = Math.min(31, Math.max(1, Math.floor(days)));
    const timeZone = runtimeTimeZone();
    const result = await this.pool.query(`
      WITH bounds AS (
        SELECT (CURRENT_TIMESTAMP AT TIME ZONE $3)::date AS today
      ), requested_days AS (
        SELECT GENERATE_SERIES(
          (SELECT today FROM bounds) - ($2::int - 1),
          (SELECT today FROM bounds),
          INTERVAL '1 day'
        )::date AS day
      ), usage AS (
        SELECT (e.timestamp AT TIME ZONE $3)::date AS day,
          COALESCE(SUM(COALESCE(NULLIF(e.payload_json->>'totalTokens', '')::numeric, 0)), 0)::float8 AS total_tokens,
          COALESCE(SUM(COALESCE(NULLIF(e.payload_json->>'estimatedCostUsd', '')::numeric, 0)), 0)::float8 AS estimated_cost
        FROM task_events e JOIN tasks t ON t.id = e.task_id
        WHERE t.tenant_id = $1 AND e.type = 'model.completed'
          AND (e.timestamp AT TIME ZONE $3)::date >= (SELECT today FROM bounds) - ($2::int - 1)
          AND (e.timestamp AT TIME ZONE $3)::date <= (SELECT today FROM bounds)
        GROUP BY (e.timestamp AT TIME ZONE $3)::date
      )
      SELECT TO_CHAR(requested_days.day, 'YYYY-MM-DD') AS date,
        COALESCE(usage.total_tokens, 0)::float8 AS total_tokens,
        COALESCE(usage.estimated_cost, 0)::float8 AS estimated_cost
      FROM requested_days LEFT JOIN usage ON usage.day = requested_days.day
      ORDER BY requested_days.day ASC
    `, [tenantId, safeDays, timeZone]);
    return result.rows.map((row) => ({ date: row.date as string, totalTokens: Number(row.total_tokens ?? 0), estimatedCostUsd: Number(Number(row.estimated_cost ?? 0).toFixed(6)) }));
  }

  async getOperationsSnapshot(tenantId: string, windowHours = 24): Promise<OperationsSnapshot> {
    const safeHours = Math.min(168, Math.max(1, Math.floor(windowHours)));
    const [taskResult, eventResult] = await Promise.all([
      this.pool.query(`
        SELECT id, status, lease_owner, lease_expires_at, created_at, updated_at
        FROM tasks WHERE tenant_id = $1
      `, [tenantId]),
      this.pool.query(`
        SELECT e.task_id, e.type, e.agent_id, e.timestamp, e.payload_json
        FROM task_events e JOIN tasks t ON t.id = e.task_id
        WHERE t.tenant_id = $1 AND e.timestamp >= NOW() - ($2::int * INTERVAL '1 hour')
        ORDER BY e.timestamp ASC
      `, [tenantId, safeHours]),
    ]);
    return buildOperationsSnapshot(
      taskResult.rows.map((task) => ({
        id: String(task.id),
        status: String(task.status),
        leaseOwner: task.lease_owner ? String(task.lease_owner) : null,
        leaseExpiresAt: task.lease_expires_at ?? null,
        createdAt: task.created_at,
        updatedAt: task.updated_at,
      })),
      eventResult.rows.map((event) => ({
        taskId: String(event.task_id),
        type: String(event.type),
        agentId: event.agent_id ? String(event.agent_id) : null,
        timestamp: event.timestamp,
        payload: (event.payload_json ?? {}) as Record<string, unknown>,
      })),
      { windowHours: safeHours },
    );
  }

  async updateTask(taskId: string, patch: TaskPatch, expectedRevision?: number) {
    const assignments: string[] = [];
    const values: unknown[] = [];
    const assign = (column: string, value: unknown) => {
      values.push(value);
      assignments.push(`${column} = $${values.length}`);
    };

    if (patch.status !== undefined) assign('status', patch.status);
    if (patch.plan !== undefined) assign('plan_json', patch.plan);
    if (patch.stepResults !== undefined) assign('step_results_json', JSON.stringify(patch.stepResults));
    if (patch.review !== undefined) assign('review_json', patch.review);
    if (patch.toolApprovals !== undefined) assign('tool_approvals_json', patch.toolApprovals);
    if (patch.result !== undefined) assign('result', patch.result);
    if (patch.error !== undefined) assign('error', patch.error);
    if (patch.cancelRequested !== undefined) assign('cancel_requested', patch.cancelRequested);
    if (patch.planVersion !== undefined) assign('plan_version', patch.planVersion);
    if (patch.policy !== undefined) assign('policy_json', patch.policy);
    assignments.push('revision = revision + 1');
    assign('updated_at', new Date().toISOString());
    values.push(taskId);
    const taskParameter = values.length;
    if (expectedRevision !== undefined) values.push(expectedRevision);

    const result = await this.pool.query(
      `UPDATE tasks SET ${assignments.join(', ')} WHERE id = $${taskParameter}${expectedRevision !== undefined ? ` AND revision = $${values.length}` : ''} RETURNING *`,
      values,
    );
    if (!result.rows[0] && expectedRevision !== undefined) {
      const current = await this.getTask(taskId);
      if (current) throw new TaskRevisionConflictError(taskId, expectedRevision, current.revision);
    }
    if (!result.rows[0]) throw new Error(`Task ${taskId} was not found after update.`);
    return taskFromRow(result.rows[0] as PostgresTaskRow);
  }

  async requestCancel(taskId: string, tenantId: string) {
    const result = await this.pool.query(`
      UPDATE tasks
      SET cancel_requested = TRUE,
          status = CASE WHEN status IN ('queued', 'awaiting_approval', 'waiting_for_human', 'paused') THEN 'cancelled' ELSE status END,
          updated_at = NOW()
      WHERE id = $1 AND tenant_id = $2 AND status NOT IN ('completed', 'failed', 'cancelled')
    `, [taskId, tenantId]);
    return (result.rowCount ?? 0) > 0;
  }

  private async transaction<T>(operation: (client: PoolClient) => Promise<T>) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async claimNextTask(workerId: string, leaseMs: number) {
    return this.transaction(async (client) => {
      const selected = await client.query(`
        SELECT * FROM tasks
        WHERE status IN ('queued', 'planning', 'running', 'reviewing')
          AND cancel_requested = FALSE
          AND (lease_owner IS NULL OR lease_expires_at < NOW())
        ORDER BY created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      `);
      if (!selected.rows[0]) return null;
      const result = await client.query(`
        UPDATE tasks
        SET lease_owner = $1,
            lease_expires_at = NOW() + ($2 * INTERVAL '1 millisecond'),
            updated_at = NOW()
        WHERE id = $3
        RETURNING *
      `, [workerId, leaseMs, selected.rows[0].id]);
      return taskFromRow(result.rows[0] as PostgresTaskRow);
    });
  }

  async renewLease(taskId: string, workerId: string, leaseMs: number) {
    const result = await this.pool.query(`
      UPDATE tasks
      SET lease_expires_at = NOW() + ($1 * INTERVAL '1 millisecond'), updated_at = NOW()
      WHERE id = $2 AND lease_owner = $3
    `, [leaseMs, taskId, workerId]);
    return (result.rowCount ?? 0) > 0;
  }

  async releaseLease(taskId: string, workerId: string) {
    await this.pool.query(`
      UPDATE tasks SET lease_owner = NULL, lease_expires_at = NULL WHERE id = $1 AND lease_owner = $2
    `, [taskId, workerId]);
  }

  async appendEvent(
    task: Pick<WorkflowTask, 'id' | 'runId'>,
    event: Omit<RuntimeEvent, 'id' | 'taskId' | 'runId' | 'sequence' | 'timestamp' | 'version'>,
  ) {
    return this.transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [task.id]);
      const sequenceResult = await client.query(
        'SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM task_events WHERE task_id = $1',
        [task.id],
      );
      const runtimeEvent: RuntimeEvent = {
        ...event,
        id: randomUUID(),
        version: 1,
        taskId: task.id,
        runId: task.runId,
        sequence: Number(sequenceResult.rows[0].sequence),
        timestamp: new Date().toISOString(),
      };
      const contextResult = await client.query(`
        SELECT tenant_id, user_id, session_id, template_id, idempotency_key
        FROM tasks WHERE id = $1
      `, [task.id]);
      const contextRow = contextResult.rows[0] as { tenant_id?: string; user_id?: string; session_id?: string; template_id?: string | null; idempotency_key?: string | null } | undefined;
      runtimeEvent.runtimeContext = {
        ...(contextRow?.tenant_id ? { tenantId: String(contextRow.tenant_id) } : {}),
        ...(contextRow?.user_id ? { userId: String(contextRow.user_id) } : {}),
        ...(contextRow?.session_id ? { sessionId: String(contextRow.session_id) } : {}),
        ...(contextRow?.template_id ? { workflowId: String(contextRow.template_id) } : {}),
        turnId: typeof runtimeEvent.payload.turnId === 'string' ? runtimeEvent.payload.turnId : runtimeEvent.runId,
        ...(typeof runtimeEvent.payload.attemptId === 'string' ? { attemptId: runtimeEvent.payload.attemptId } : {}),
        runtimeGeneration: this.runtimeGeneration,
        ownerId: contextRow?.user_id ? String(contextRow.user_id) : undefined,
        source: runtimeEventSource(runtimeEvent),
        ...(contextRow?.idempotency_key ? { submissionId: String(contextRow.idempotency_key) } : {}),
      };
      await client.query(`
        INSERT INTO task_events (id, task_id, run_id, sequence, type, agent_id, timestamp, payload_json, runtime_context_json)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      `, [
        runtimeEvent.id, runtimeEvent.taskId, runtimeEvent.runId, runtimeEvent.sequence,
        runtimeEvent.type, runtimeEvent.agentId ?? null, runtimeEvent.timestamp,
        JSON.stringify(runtimeEvent.payload),
        JSON.stringify(runtimeEvent.runtimeContext),
      ]);
      return runtimeEvent;
    });
  }

  async getEvents(taskId: string, afterSequence = 0) {
    const result = await this.pool.query(`
      SELECT * FROM task_events WHERE task_id = $1 AND sequence > $2 ORDER BY sequence ASC
    `, [taskId, afterSequence]);
    return result.rows.map((row) => ({
      id: row.id,
      type: row.type,
      version: 1 as const,
      taskId: row.task_id,
      runId: row.run_id,
      sequence: Number(row.sequence),
      agentId: row.agent_id ?? undefined,
      timestamp: iso(row.timestamp as Date | string),
      payload: row.payload_json ?? {},
      runtimeContext: row.runtime_context_json ?? undefined,
    }));
  }

  async listSessions(tenantId: string, userId: string, limit = 50) {
    const result = await this.pool.query(`
      SELECT * FROM sessions
      WHERE tenant_id = $1 AND user_id = $2
        AND deleted_at IS NULL
      ORDER BY updated_at DESC LIMIT $3
    `, [tenantId, userId, Math.min(100, Math.max(1, Math.floor(limit)))]);
    return result.rows.map((row) => sessionFromRow(row as PostgresSessionRow));
  }

  async listDeletedSessionIds(tenantId: string, userId: string) {
    const result = await this.pool.query('SELECT id FROM sessions WHERE tenant_id = $1 AND user_id = $2 AND deleted_at IS NOT NULL', [tenantId, userId]);
    return result.rows.map((row) => String(row.id));
  }

  async upsertSession(tenantId: string, userId: string, input: UpsertSessionInput) {
    const result = await this.pool.query(`
      INSERT INTO sessions (id, tenant_id, user_id, title, messages_json, graph_json, context_summary_json, active_task_id, active_assistant_id, updated_at)
      VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9, $10)
      ON CONFLICT (tenant_id, id) DO UPDATE SET
        title = EXCLUDED.title,
        messages_json = EXCLUDED.messages_json,
        graph_json = EXCLUDED.graph_json,
        context_summary_json = EXCLUDED.context_summary_json,
        active_task_id = EXCLUDED.active_task_id,
        active_assistant_id = EXCLUDED.active_assistant_id,
        updated_at = EXCLUDED.updated_at,
        deleted_at = NULL
      WHERE sessions.user_id = EXCLUDED.user_id
        AND EXCLUDED.updated_at >= sessions.updated_at
      RETURNING *
    `, [
      input.id,
      tenantId,
      userId,
      input.title,
      JSON.stringify(input.messages),
      JSON.stringify(input.agentGraph ?? null),
      JSON.stringify(input.contextSummary ?? null),
      input.activeTaskId ?? null,
      input.activeAssistantId ?? null,
      input.updatedAt,
    ]);
    if (result.rows[0]) return sessionFromRow(result.rows[0] as PostgresSessionRow);
    const current = await this.pool.query(
      'SELECT * FROM sessions WHERE tenant_id = $1 AND user_id = $2 AND id = $3',
      [tenantId, userId, input.id],
    );
    if (!current.rows[0]) throw new Error('Session is owned by another user or could not be persisted.');
    return sessionFromRow(current.rows[0] as PostgresSessionRow);
  }

  async deleteSession(sessionId: string, tenantId: string, userId: string) {
    const now = Date.now();
    const result = await this.pool.query(`
      INSERT INTO sessions (id, tenant_id, user_id, title, messages_json, updated_at, deleted_at)
      VALUES ($1, $2, $3, '', '[]'::jsonb, $4, $4)
      ON CONFLICT (tenant_id, id) DO UPDATE SET deleted_at = EXCLUDED.deleted_at, updated_at = EXCLUDED.updated_at
      WHERE sessions.user_id = EXCLUDED.user_id
    `, [sessionId, tenantId, userId, now]);
    return (result.rowCount ?? 0) > 0;
  }

  async getReadNotificationIds(tenantId: string, userId: string, notificationIds: string[]) {
    const ids = [...new Set(notificationIds.map((id) => id.trim()).filter(Boolean))].slice(0, 500);
    if (ids.length === 0) return [];
    const result = await this.pool.query<{ notification_id: string }>(`
      SELECT notification_id FROM notification_receipts
      WHERE tenant_id = $1 AND user_id = $2 AND notification_id = ANY($3::text[])
    `, [tenantId, userId, ids]);
    return result.rows.map((row) => row.notification_id);
  }

  async markNotificationsRead(tenantId: string, userId: string, notificationIds: string[], readAt = new Date().toISOString()) {
    const ids = [...new Set(notificationIds.map((id) => id.trim()).filter((id) => id.length > 0 && id.length <= 512))].slice(0, 500);
    if (ids.length === 0) return 0;
    await this.pool.query(`
      INSERT INTO notification_receipts (tenant_id, user_id, notification_id, read_at)
      SELECT $1, $2, notification_id, $3::timestamptz
      FROM UNNEST($4::text[]) AS notification_id
      ON CONFLICT (tenant_id, user_id, notification_id) DO UPDATE SET read_at = EXCLUDED.read_at
    `, [tenantId, userId, readAt, ids]);
    return ids.length;
  }
}
