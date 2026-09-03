import type { RuntimeEvent } from './contracts.js';

export type HarnessThreadState = 'open' | 'closed';

export type HarnessThreadGraphNode = {
  threadId: string;
  parentThreadId?: string;
  state: HarnessThreadState;
  depth: number;
  firstSequence: number;
  lastSequence: number;
  startedAt: string;
  updatedAt: string;
};

export type HarnessThreadGraph = {
  nodes: HarnessThreadGraphNode[];
  edges: Array<{ parentThreadId: string; childThreadId: string }>;
};

const terminalTaskEvents = new Set<RuntimeEvent['type']>(['task.completed', 'task.failed', 'task.cancelled']);

const recordValue = (value: unknown): Record<string, unknown> => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
);

const nonEmptyString = (...values: unknown[]) => values.find((value): value is string => (
  typeof value === 'string' && value.trim().length > 0
))?.trim();

const threadFact = (event: RuntimeEvent) => {
  const harness = recordValue(event.payload.harness);
  const threadId = nonEmptyString(
    event.type === 'harness.connected' ? event.payload.threadId : undefined,
    event.type === 'thread.forked' ? event.payload.childThreadId : undefined,
    harness.threadId,
    event.payload.threadId,
  );
  if (!threadId) return null;
  const parentThreadId = nonEmptyString(harness.parentThreadId, event.payload.parentThreadId);
  return {
    threadId,
    ...(parentThreadId && parentThreadId !== threadId ? { parentThreadId } : {}),
  };
};

const wouldCreateCycle = (childId: string, parentId: string, parents: Map<string, string>) => {
  let cursor: string | undefined = parentId;
  const visited = new Set<string>();
  while (cursor) {
    if (cursor === childId || visited.has(cursor)) return true;
    visited.add(cursor);
    cursor = parents.get(cursor);
  }
  return false;
};

/**
 * Project the durable task event stream into a provider-neutral Thread graph.
 * The projection is deterministic, rejects cyclic external parent claims, and
 * closes every open Thread when the owning task reaches a terminal state.
 */
export const buildHarnessThreadGraph = (events: readonly RuntimeEvent[]): HarnessThreadGraph => {
  const ordered = [...events].sort((left, right) => left.sequence - right.sequence);
  const facts = new Map<string, Omit<HarnessThreadGraphNode, 'depth'>>();
  const parents = new Map<string, string>();
  let terminalAt: string | null = null;

  const touch = (threadId: string, event: RuntimeEvent) => {
    const current = facts.get(threadId);
    if (current) {
      current.lastSequence = Math.max(current.lastSequence, event.sequence);
      current.updatedAt = event.timestamp;
      return current;
    }
    const created: Omit<HarnessThreadGraphNode, 'depth'> = {
      threadId,
      state: 'open',
      firstSequence: event.sequence,
      lastSequence: event.sequence,
      startedAt: event.timestamp,
      updatedAt: event.timestamp,
    };
    facts.set(threadId, created);
    return created;
  };

  ordered.forEach((event) => {
    if (terminalTaskEvents.has(event.type)) terminalAt = event.timestamp;
    const fact = threadFact(event);
    if (!fact) return;
    const node = touch(fact.threadId, event);
    if (fact.parentThreadId) {
      touch(fact.parentThreadId, event);
      if (!parents.has(fact.threadId) && !wouldCreateCycle(fact.threadId, fact.parentThreadId, parents)) {
        parents.set(fact.threadId, fact.parentThreadId);
        node.parentThreadId = fact.parentThreadId;
      }
    }
    if (event.type === 'thread.closed') node.state = 'closed';
    if (event.type === 'thread.started' || event.type === 'thread.resumed' || event.type === 'thread.forked') node.state = 'open';
  });

  if (terminalAt) {
    facts.forEach((node) => {
      node.state = 'closed';
      node.updatedAt = terminalAt!;
    });
  }

  const children = new Map<string, string[]>();
  parents.forEach((parentId, childId) => {
    const siblings = children.get(parentId) ?? [];
    siblings.push(childId);
    children.set(parentId, siblings);
  });
  children.forEach((ids) => ids.sort((left, right) => (
    (facts.get(left)?.firstSequence ?? 0) - (facts.get(right)?.firstSequence ?? 0)
    || left.localeCompare(right)
  )));

  const roots = [...facts.keys()].filter((id) => !parents.has(id)).sort((left, right) => (
    (facts.get(left)?.firstSequence ?? 0) - (facts.get(right)?.firstSequence ?? 0)
    || left.localeCompare(right)
  ));
  const orderedIds: Array<{ id: string; depth: number }> = [];
  const visited = new Set<string>();
  const queue = roots.map((id) => ({ id, depth: 0 }));
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.has(current.id)) continue;
    visited.add(current.id);
    orderedIds.push(current);
    (children.get(current.id) ?? []).forEach((id) => queue.push({ id, depth: current.depth + 1 }));
  }
  [...facts.keys()].filter((id) => !visited.has(id)).forEach((id) => orderedIds.push({ id, depth: 0 }));

  return {
    nodes: orderedIds.map(({ id, depth }) => ({ ...facts.get(id)!, depth })),
    edges: [...parents.entries()]
      .map(([childThreadId, parentThreadId]) => ({ parentThreadId, childThreadId }))
      .sort((left, right) => (facts.get(left.childThreadId)?.firstSequence ?? 0) - (facts.get(right.childThreadId)?.firstSequence ?? 0)),
  };
};

export const breadthFirstThreadDescendants = (graph: HarnessThreadGraph, rootThreadId: string) => {
  if (!graph.nodes.some((node) => node.threadId === rootThreadId)) return null;
  const children = new Map<string, string[]>();
  graph.edges.forEach((edge) => {
    const values = children.get(edge.parentThreadId) ?? [];
    values.push(edge.childThreadId);
    children.set(edge.parentThreadId, values);
  });
  const orderById = new Map(graph.nodes.map((node, index) => [node.threadId, index]));
  children.forEach((ids) => ids.sort((left, right) => (orderById.get(left) ?? 0) - (orderById.get(right) ?? 0)));
  const descendants: HarnessThreadGraphNode[] = [];
  const visited = new Set<string>([rootThreadId]);
  const queue = [...(children.get(rootThreadId) ?? [])];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const node = graph.nodes.find((candidate) => candidate.threadId === id);
    if (node) descendants.push(node);
    (children.get(id) ?? []).forEach((childId) => queue.push(childId));
  }
  return descendants;
};
