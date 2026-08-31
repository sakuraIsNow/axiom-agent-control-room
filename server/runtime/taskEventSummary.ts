import type { RuntimeEventType, TaskEventSummary } from './contracts.js';

export type TaskEventSummaryRow = {
  taskId: string;
  sequence: number;
  type: RuntimeEventType;
  timestamp: string;
  payload: Record<string, unknown>;
};

const numeric = (value: unknown) => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

const emptySummary = (): TaskEventSummary => ({
  modelCalls: 0,
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  estimatedCostUsd: 0,
  retries: 0,
  toolCalls: 0,
});

export const summarizeTaskEvents = (rows: TaskEventSummaryRow[]) => {
  const summaries = new Map<string, TaskEventSummary>();
  for (const row of rows) {
    const summary = summaries.get(row.taskId) ?? emptySummary();
    if (row.type === 'task.created' && typeof row.payload.source === 'string') summary.source = row.payload.source;
    if (row.type === 'model.completed') {
      summary.modelCalls += 1;
      summary.promptTokens += numeric(row.payload.promptTokens);
      summary.completionTokens += numeric(row.payload.completionTokens);
      summary.totalTokens += numeric(row.payload.totalTokens);
      summary.estimatedCostUsd += numeric(row.payload.estimatedCostUsd);
    }
    if (row.type === 'agent.retrying') summary.retries += 1;
    if (row.type === 'tool.started') summary.toolCalls += 1;
    if (row.type === 'task.queued' && !summary.queuedAt) summary.queuedAt = row.timestamp;
    if (row.type === 'task.started' && !summary.startedAt) summary.startedAt = row.timestamp;
    summary.latest = { type: row.type, timestamp: row.timestamp, payload: row.payload };
    summaries.set(row.taskId, summary);
  }
  for (const summary of summaries.values()) summary.estimatedCostUsd = Number(summary.estimatedCostUsd.toFixed(6));
  return summaries;
};
