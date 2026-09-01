import type { AgentGraph, WorkflowTask } from '../types';
import { parseAgentGraph } from './workflowGraphState';

type RestorableTask = Pick<WorkflowTask, 'status' | 'plan' | 'stepResults'>;

const terminalFallbackStatus = (
  taskStatus: WorkflowTask['status'],
  nodeStatus: NonNullable<AgentGraph['nodes'][number]['status']>,
) => {
  if (taskStatus === 'completed') return nodeStatus === 'failed' ? 'failed' : 'completed';
  if ((taskStatus === 'failed' || taskStatus === 'cancelled') && nodeStatus === 'running') return 'failed';
  if ((taskStatus === 'awaiting_approval' || taskStatus === 'waiting_for_human' || taskStatus === 'paused') && nodeStatus === 'running') return 'queued';
  return nodeStatus;
};

/** Reconciles the planning-time graph snapshot with persisted execution results. */
export const restoreTaskGraph = (task: RestorableTask): AgentGraph | null => {
  const graph = task.plan?.graph;
  if (!graph) return null;

  const resultByStep = new Map(task.stepResults.map((result) => [result.stepId, result]));
  const resultByAgent = new Map(task.stepResults.map((result) => [result.agentId, result]));

  return parseAgentGraph({
    ...graph,
    nodes: graph.nodes.map((node) => {
      const result = resultByStep.get(node.stepId ?? node.id)
        ?? (node.agentId ? resultByAgent.get(node.agentId) : undefined);
      const persistedStatus = result?.skipped ? 'skipped' : result?.status ?? node.status ?? 'queued';
      return {
        ...node,
        status: result?.skipped ? 'skipped' : result?.status ?? terminalFallbackStatus(task.status, persistedStatus),
        ...(result?.tokens !== undefined ? { tokens: result.tokens } : {}),
        ...(result?.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
        ...(result?.attempts !== undefined ? { attempts: result.attempts } : {}),
        ...(result?.toolCalls !== undefined ? { toolCalls: result.toolCalls.length } : {}),
        ...(result?.status === 'failed' ? { failureReason: result.output } : {}),
      };
    }),
  });
};
