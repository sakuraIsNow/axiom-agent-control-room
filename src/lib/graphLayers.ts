import type { AgentGraph, AgentGraphNode } from '../types';

export type GraphLayer = { level: number; nodes: AgentGraphNode[] };

export function computeGraphLayers(graph: AgentGraph | null): GraphLayer[] {
  if (!graph?.nodes?.length) return [];
  const nodes = graph.nodes.filter((node) => node.id !== 'orchestrator');
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const levels = new Map<string, number>();
  const levelFor = (id: string, path = new Set<string>()): number => {
    const existing = levels.get(id);
    if (existing !== undefined) return existing;
    if (path.has(id)) return 0;
    const node = byId.get(id);
    if (!node || node.dependsOn.length === 0) {
      levels.set(id, 0);
      return 0;
    }
    const nextPath = new Set(path).add(id);
    const level = Math.max(...node.dependsOn.map((dependency) => levelFor(dependency, nextPath) + 1));
    levels.set(id, level);
    return level;
  };
  const groups = new Map<number, AgentGraphNode[]>();
  nodes.forEach((node) => {
    // Prefer the scheduler's durable wave when present. Recomputing from
    // dependencies remains the fallback for legacy snapshots.
    const level = Number.isInteger(node.executionWave) && (node.executionWave ?? 0) > 0
      ? (node.executionWave as number) - 1
      : levelFor(node.id);
    const group = groups.get(level) ?? [];
    group.push(node);
    groups.set(level, group);
  });
  return [...groups.entries()]
    .sort(([left], [right]) => left - right)
    .map(([level, groupedNodes]) => ({ level, nodes: groupedNodes.sort((left, right) => left.id.localeCompare(right.id)) }));
}
