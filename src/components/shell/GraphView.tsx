import { ArrowUpRight, Network } from 'lucide-react';
import type { CSSProperties } from 'react';
import type { AgentGraph, TopologyAgent } from '../../types';
import { computeGraphLayers } from '../../lib/graphLayers';
import { nodeId, nodeRole, nodeStatus, nodeTitle, statusText } from '../../lib/graphPresentation';
import { agentDisplayName } from '../../lib/agentPresentation';

export function GraphView({ graph, agents, selectedNodeId, onSelectAgent }: { graph: AgentGraph | null; agents: TopologyAgent[]; selectedNodeId: string | null; onSelectAgent: (id: string) => void }) {
  const layers = computeGraphLayers(graph);
  const fallback = !layers.length ? agents.slice(0, 16) : [];
  const visible = layers.length ? layers.flatMap((layer) => layer.nodes).slice(0, 16) : fallback;
  const columns = layers.length || Math.min(4, Math.max(1, Math.ceil(Math.sqrt(visible.length || 1))));
  const positionOf = (index: number) => {
    if (layers.length) {
      let cursor = 0;
      for (const layer of layers) {
        const withinLayer = index - cursor;
        if (withinLayer < layer.nodes.length) {
          const perRow = Math.max(1, layer.nodes.length);
          return { col: withinLayer, row: layer.level, perRow };
        }
        cursor += layer.nodes.length;
      }
    }
    return { col: index % columns, row: Math.floor(index / columns), perRow: columns };
  };
  const rowCount = layers.length ? layers.length : Math.ceil(visible.length / columns);
  return <div className="shell-graph-view">{visible.length === 0 ? <div className="shell-empty"><Network size={23} /><span>提交目标后生成真实推理图</span></div> : <><svg className="shell-graph-links" viewBox="0 0 1000 600" preserveAspectRatio="none" aria-hidden="true">{graph?.edges?.length ? graph.edges.flatMap((edge) => {
    const fromIndex = visible.findIndex((node) => nodeId(node) === edge.from);
    const toIndex = visible.findIndex((node) => nodeId(node) === edge.to);
    if (fromIndex < 0 || toIndex < 0) return [];
    const from = positionOf(fromIndex);
    const to = positionOf(toIndex);
    const x1 = 125 + (from.col + 0.5) / from.perRow * 750;
    const y1 = 90 + from.row / Math.max(1, rowCount - 1 || 1) * 420;
    const x2 = 125 + (to.col + 0.5) / to.perRow * 750;
    const y2 = 90 + to.row / Math.max(1, rowCount - 1 || 1) * 420;
    return <path key={`${edge.from}-${edge.to}`} d={`M${x1} ${y1} C${(x1 + x2) / 2} ${y1 - 65}, ${(x1 + x2) / 2} ${y2 + 65}, ${x2} ${y2}`} />;
  }) : null}</svg><div className="shell-graph-nodes">{visible.map((node, index) => { const id = nodeId(node); const status = nodeStatus(node); const { col, row, perRow } = positionOf(index); const x = (col + 0.5) / perRow * 86 + 7; const y = rowCount > 1 ? row / (rowCount - 1) * 66 + 17 : 45; return <button type="button" key={id} className={`shell-graph-node ${status} ${selectedNodeId === id ? 'selected' : ''}`} style={{ '--node-x': `${x}%`, '--node-y': `${y}%` } as CSSProperties} onClick={() => onSelectAgent(id)}><span className="shell-node-index">{String(index + 1).padStart(2, '0')}</span><span><strong>{nodeTitle(node)}</strong><small>{agentDisplayName(nodeRole(node))}</small></span><em>{statusText[status] ?? status}<ArrowUpRight size={12} /></em></button>; })}</div></>}</div>;
}
