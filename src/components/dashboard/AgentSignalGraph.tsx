import { useEffect, useMemo, useRef } from 'react';
import { Focus, Network, Rotate3D } from 'lucide-react';
import { MorphIcon } from 'morphicons/react';
import type { AgentGraph, AgentPhase, TopologyAgent } from '../../types';
import { agentDisplayName } from '../../lib/agentPresentation';
import { visibleGraphNodes } from '../../lib/workflowGraphState';

type SignalNode = {
  id: string;
  label: string;
  status: NonNullable<AgentGraph['nodes'][number]['status']>;
};

type GraphPosition = { x: number; y: number; angle: number };

const TAU = Math.PI * 2;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const positionsFor = (count: number): GraphPosition[] => {
  if (count === 1) return [{ x: 50, y: 52, angle: -Math.PI / 2 }];
  if (count === 2) return [{ x: 30, y: 52, angle: Math.PI }, { x: 70, y: 52, angle: 0 }];
  if (count === 3) return [
    { x: 20, y: 61, angle: Math.PI * .78 },
    { x: 50, y: 30, angle: -Math.PI / 2 },
    { x: 80, y: 61, angle: Math.PI * .22 },
  ];
  if (count > 8) {
    const remaining = count - 1;
    const innerCount = Math.min(7, Math.ceil(remaining / 2));
    const outerCount = remaining - innerCount;
    const ring = (ringCount: number, radiusX: number, radiusY: number, offset: number) => Array.from({ length: ringCount }, (_, index) => {
      const angle = -Math.PI / 2 + offset + index / ringCount * TAU;
      return { x: 50 + Math.cos(angle) * radiusX, y: 52 + Math.sin(angle) * radiusY, angle };
    });
    return [
      { x: 50, y: 52, angle: -Math.PI / 2 },
      ...ring(innerCount, 25, 22, 0),
      ...ring(outerCount, 40, 38, Math.PI / Math.max(1, outerCount)),
    ];
  }
  return Array.from({ length: count }, (_, index) => {
    const angle = -Math.PI / 2 + index / count * TAU;
    return { x: 50 + Math.cos(angle) * 34, y: 52 + Math.sin(angle) * 31, angle };
  });
};

// The same-shaped paths let Morphicons animate state changes without a layout shift.
const statusIcons: Record<TopologyAgent['status'], string> = {
  queued: 'M12 4v16 M4 12h16',
  running: 'M7 5v14 M17 5v14',
  completed: 'M4 12l5 5L20 6 M9 17l0 0',
  failed: 'M6 6l12 12 M18 6L6 18',
};
const statusIcon = (status: SignalNode['status']) => statusIcons[status as TopologyAgent['status']] ?? statusIcons.queued;

const phaseIcons: Record<AgentPhase, string> = {
  idle: 'M5 5h14v14H5z',
  routing: 'M4 12h16 M12 4v16',
  context: 'M6 5h12v14H6z M9 9h6 M9 13h6',
  inference: 'M12 3v18 M3 12h18 M5.5 5.5l13 13 M18.5 5.5l-13 13',
  complete: 'M4 12l5 5L20 6 M9 17l0 0',
  error: 'M12 4v9 M12 17v1',
};

const curvePath = (from: GraphPosition, to: GraphPosition, index: number) => {
  const midX = (from.x + to.x) / 2;
  const midY = (from.y + to.y) / 2;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.max(1, Math.hypot(dx, dy));
  const bend = (index % 2 === 0 ? 1 : -1) * Math.min(9, length * .12);
  const controlX = midX - dy / length * bend;
  const controlY = midY + dx / length * bend;
  return `M ${from.x.toFixed(2)} ${from.y.toFixed(2)} Q ${controlX.toFixed(2)} ${controlY.toFixed(2)} ${to.x.toFixed(2)} ${to.y.toFixed(2)}`;
};

export function AgentSignalGraph({ agents, graph, phase, selectedNodeId, onSelectAgent }: {
  agents: TopologyAgent[];
  graph: AgentGraph | null;
  phase: AgentPhase;
  selectedNodeId: string | null;
  onSelectAgent: (id: string) => void;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef({
    yaw: -4,
    pitch: 2,
    auto: true,
    dragging: false,
    moved: false,
    pointerId: -1,
    startX: 0,
    startY: 0,
    startYaw: -4,
    startPitch: 2,
    targetId: null as string | null,
    lastFrame: performance.now(),
  });
  const agentByStep = useMemo(() => new Map(agents.map((agent) => [agent.stepId ?? agent.id, agent])), [agents]);
  const agentById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);
  const allNodes = useMemo<SignalNode[]>(() => (graph?.nodes.length ? graph.nodes.map((node) => {
    const runtime = agentByStep.get(node.stepId ?? node.id) ?? (node.agentId ? agentById.get(node.agentId) : undefined);
    return {
      id: node.id,
      label: agentDisplayName(node.role, node.title),
      status: runtime?.status ?? node.status ?? 'queued',
    };
  }) : agents.map((agent) => ({
    id: agent.stepId ?? agent.id,
    label: agentDisplayName(agent.role, agent.label),
    status: agent.status,
  }))), [agentById, agentByStep, agents, graph]);
  const nodes = useMemo(() => visibleGraphNodes(allNodes), [allNodes]);
  const truncated = nodes.length < allNodes.length;
  const positions = useMemo(() => positionsFor(nodes.length), [nodes.length]);
  const positionById = useMemo(() => new Map(nodes.map((node, index) => [node.id, positions[index]!])), [nodes, positions]);
  const edges = useMemo(() => (graph?.edges ?? []).filter((edge) => positionById.has(edge.from) && positionById.has(edge.to)), [graph, positionById]);
  const live = phase === 'routing' || phase === 'context' || phase === 'inference';

  useEffect(() => {
    const state = stateRef.current;
    state.lastFrame = performance.now();
    let frame = 0;
    const tick = (timestamp: number) => {
      const delta = Math.min(.05, Math.max(.001, (timestamp - state.lastFrame) / 1000));
      state.lastFrame = timestamp;
      if (state.auto && !state.dragging) state.yaw += delta * 3.3;
      if (worldRef.current) {
        worldRef.current.style.transform = `rotateX(${state.pitch.toFixed(2)}deg) rotateY(${state.yaw.toFixed(2)}deg)`;
        worldRef.current.style.setProperty('--dash-graph-yaw-inverse', `${(-state.yaw).toFixed(2)}deg`);
        worldRef.current.style.setProperty('--dash-graph-pitch-inverse', `${(-state.pitch).toFixed(2)}deg`);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [nodes.length]);

  const beginDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    if ((event.target as HTMLElement).closest('.dash-agent-graph-focus, .dash-agent-graph-auto')) return;
    const state = stateRef.current;
    const target = (event.target as HTMLElement).closest('.dash-agent-signal-node');
    state.dragging = true;
    state.moved = false;
    state.pointerId = event.pointerId;
    state.startX = event.clientX;
    state.startY = event.clientY;
    state.startYaw = state.yaw;
    state.startPitch = state.pitch;
    state.targetId = target?.getAttribute('data-agent-id') ?? null;
    stageRef.current?.setPointerCapture(event.pointerId);
    stageRef.current?.classList.add('is-dragging');
  };

  const moveDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const state = stateRef.current;
    if (!state.dragging || event.pointerId !== state.pointerId) return;
    const dx = event.clientX - state.startX;
    const dy = event.clientY - state.startY;
    if (Math.hypot(dx, dy) > 5) state.moved = true;
    state.yaw = state.startYaw + dx * .22;
    state.pitch = clamp(state.startPitch - dy * .14, -22, 22);
  };

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const state = stateRef.current;
    if (!state.dragging || event.pointerId !== state.pointerId) return;
    const targetId = state.targetId;
    const shouldSelect = !state.moved && targetId;
    state.dragging = false;
    state.pointerId = -1;
    state.targetId = null;
    stageRef.current?.classList.remove('is-dragging');
    if (stageRef.current?.hasPointerCapture(event.pointerId)) stageRef.current.releasePointerCapture(event.pointerId);
    if (shouldSelect) onSelectAgent(targetId);
  };

  const toggleAuto = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    stateRef.current.auto = !stateRef.current.auto;
    event.currentTarget.setAttribute('aria-pressed', String(stateRef.current.auto));
  };

  const focusScene = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    const state = stateRef.current;
    state.auto = false;
    state.yaw = 0;
    state.pitch = 0;
  };

  return <section className="dash-agent-signal-graph" aria-label="当前对话 Agent Graph">
    <header>
      <span><MorphIcon icon={phaseIcons[phase]} size={15} strokeWidth={1.8} spring="snappy" reducedMotion="user" /><Network size={14} />Agent Graph</span>
      <div className="dash-agent-graph-actions">
        <button type="button" className="dash-agent-graph-auto" aria-pressed="true" onClick={toggleAuto} title="切换自动旋转"><Rotate3D size={13} /></button>
        <button type="button" className="dash-agent-graph-focus" onClick={focusScene} title="恢复正面视角"><Focus size={13} /></button>
        <strong title={truncated ? `显示 ${nodes.length} 个，共 ${allNodes.length} 个 Agent` : `${nodes.length} 个 Agent`}>{truncated ? `${nodes.length}/${allNodes.length}` : nodes.length}</strong>
      </div>
    </header>
    {nodes.length === 0 ? <div className="dash-agent-graph-empty"><Network size={18} /><span>尚未调用 Agent</span></div> : <div
      ref={stageRef}
      className={`dash-agent-graph-stage ${live ? 'live' : ''} ${nodes.length > 8 ? 'dense' : ''}`}
      onPointerDown={beginDrag}
      onPointerMove={moveDrag}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      <div className="dash-agent-graph-world" ref={worldRef}>
        <div className="dash-agent-graph-core" />
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          {edges.map((edge, index) => {
            const from = positionById.get(edge.from)!;
            const to = positionById.get(edge.to)!;
            return <path key={`${edge.from}-${edge.to}-${index}`} d={curvePath(from, to, index)} className={`edge-${edge.kind}`} />;
          })}
        </svg>
        {nodes.map((node, index) => {
          const position = positions[index]!;
          const selected = selectedNodeId === node.id;
          const active = node.status === 'running';
          return <button
            key={node.id}
            type="button"
            data-agent-id={node.id}
            className={`dash-agent-signal-node status-${node.status} variant-${index % 5} ${active ? 'active' : ''} ${selected ? 'selected' : ''}`}
            style={{
              left: `${position.x}%`,
              top: `${position.y}%`,
              '--dash-node-depth': `${(Math.cos(position.angle) * 24).toFixed(2)}px`,
            } as React.CSSProperties}
            title={node.label}
            onClick={() => onSelectAgent(node.id)}
          >
            <span className="dash-agent-ribbon ribbon-a" /><span className="dash-agent-ribbon ribbon-b" />
            <span className="dash-agent-spark spark-a" /><span className="dash-agent-spark spark-b" />
            <span className="dash-agent-sphere" aria-hidden="true">
              <i className="dash-agent-eye eye-left" />
              <i className="dash-agent-eye eye-right" />
              <span className="dash-agent-mouth" />
              <b className="dash-agent-status-dot" />
            </span>
              <span className="dash-agent-node-meta"><MorphIcon icon={statusIcon(node.status)} size={13} strokeWidth={2} spring="snappy" reducedMotion="user" /><em>{node.label}</em></span>
          </button>;
        })}
      </div>
    </div>}
  </section>;
}
