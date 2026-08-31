import type { AgentGraph, AgentGraphEdge, AgentGraphNode } from '../types';

export const MAX_DASHBOARD_GRAPH_NODES = 16;

const nodeStatuses = new Set<NonNullable<AgentGraphNode['status']>>(['queued', 'running', 'completed', 'failed']);
const edgeKinds = new Set<AgentGraphEdge['kind']>(['dependency', 'delegation', 'review']);
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const optionalString = (value: unknown) => typeof value === 'string' ? value : undefined;
const optionalNumber = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
const optionalStringArray = (value: unknown) => Array.isArray(value) && value.every((item) => typeof item === 'string' && item.length > 0)
  ? [...new Set(value as string[])]
  : undefined;

const parseNode = (value: unknown): AgentGraphNode | null => {
  if (!isRecord(value)
    || typeof value.id !== 'string' || !value.id.trim()
    || typeof value.role !== 'string' || !value.role.trim()
    || typeof value.title !== 'string'
    || !Array.isArray(value.dependsOn)
    || !value.dependsOn.every((dependency) => typeof dependency === 'string' && dependency.length > 0)
    || (value.status !== undefined && !nodeStatuses.has(value.status as NonNullable<AgentGraphNode['status']>))) return null;
  return {
    id: value.id,
    role: value.role,
    title: value.title,
    dependsOn: [...value.dependsOn] as string[],
    ...(optionalStringArray(value.skillIds) ? { skillIds: optionalStringArray(value.skillIds) } : {}),
    ...(optionalString(value.stepId) ? { stepId: optionalString(value.stepId) } : {}),
    ...(optionalString(value.agentId) ? { agentId: optionalString(value.agentId) } : {}),
    ...(value.status ? { status: value.status as AgentGraphNode['status'] } : {}),
    ...(optionalNumber(value.tokens) !== undefined ? { tokens: optionalNumber(value.tokens) } : {}),
    ...(optionalNumber(value.durationMs) !== undefined ? { durationMs: optionalNumber(value.durationMs) } : {}),
    ...(optionalNumber(value.attempts) !== undefined ? { attempts: optionalNumber(value.attempts) } : {}),
    ...(optionalNumber(value.toolCalls) !== undefined ? { toolCalls: optionalNumber(value.toolCalls) } : {}),
    ...(optionalString(value.failureReason) ? { failureReason: optionalString(value.failureReason) } : {}),
  };
};

const parseEdge = (value: unknown): AgentGraphEdge | null => {
  if (!isRecord(value)
    || typeof value.from !== 'string' || !value.from
    || typeof value.to !== 'string' || !value.to
    || !edgeKinds.has(value.kind as AgentGraphEdge['kind'])) return null;
  return { from: value.from, to: value.to, kind: value.kind as AgentGraphEdge['kind'] };
};

const isAcyclic = (nodeIds: Set<string>, edges: AgentGraphEdge[]) => {
  const indegree = new Map([...nodeIds].map((id) => [id, 0]));
  const outgoing = new Map([...nodeIds].map((id) => [id, [] as string[]]));
  edges.forEach((edge) => {
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
    outgoing.get(edge.from)?.push(edge.to);
  });
  const ready = [...indegree].filter(([, degree]) => degree === 0).map(([id]) => id);
  let visited = 0;
  while (ready.length > 0) {
    const id = ready.shift()!;
    visited += 1;
    outgoing.get(id)?.forEach((next) => {
      const degree = (indegree.get(next) ?? 1) - 1;
      indegree.set(next, degree);
      if (degree === 0) ready.push(next);
    });
  }
  return visited === nodeIds.size;
};

export const parseAgentGraph = (value: unknown): AgentGraph | null => {
  if (!isRecord(value) || !Array.isArray(value.nodes) || !Array.isArray(value.edges)) return null;
  const nodes = value.nodes.map(parseNode);
  const edges = value.edges.map(parseEdge);
  if (nodes.some((node) => node === null) || edges.some((edge) => edge === null)) return null;
  const validNodes = nodes as AgentGraphNode[];
  const validEdges = edges as AgentGraphEdge[];
  const nodeIds = new Set(validNodes.map((node) => node.id));
  if (nodeIds.size !== validNodes.length) return null;
  if (validNodes.some((node) => node.dependsOn.some((dependency) => !nodeIds.has(dependency)))) return null;
  if (validEdges.some((edge) => edge.from === edge.to || !nodeIds.has(edge.from) || !nodeIds.has(edge.to))) return null;
  const edgeIds = new Set(validEdges.map((edge) => `${edge.from}\u0000${edge.to}\u0000${edge.kind}`));
  if (edgeIds.size !== validEdges.length || !isAcyclic(nodeIds, validEdges)) return null;
  return { nodes: validNodes, edges: validEdges };
};

export const visibleGraphNodes = <T>(nodes: readonly T[], limit = MAX_DASHBOARD_GRAPH_NODES) => (
  nodes.slice(0, Math.max(0, limit))
);

export const acceptGraphEventSequence = (
  cursors: Map<string, number>,
  taskId: string,
  sequence: number,
) => {
  if (!taskId || !Number.isSafeInteger(sequence) || sequence < 1) return false;
  const previous = cursors.get(taskId) ?? 0;
  if (sequence <= previous) return false;
  cursors.set(taskId, sequence);
  return true;
};
