import { createPortal } from 'react-dom';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Activity, ChevronLeft, ChevronRight, Focus, Maximize2, Minimize2, Network, Rotate3D, X } from 'lucide-react';
import { MorphIcon } from 'morphicons/react';
import type { CSSProperties } from 'react';
import type { AgentGraph, AgentPhase, RunEvent, TopologyAgent } from '../../types';
import { agentDisplayName } from '../../lib/agentPresentation';
import { graphVirtualWindow, shouldReduceGraphMotion, type GraphRuntimeSignals } from '../../lib/graphRuntime';
import { visibleGraphNodes } from '../../lib/workflowGraphState';
import { useUiLanguage } from '../../lib/uiLanguage';
import { translateRunEventLabel } from '../../lib/runEventPresentation';

type SignalNode = {
  id: string;
  label: string;
  role: string;
  title: string;
  status: NonNullable<AgentGraph['nodes'][number]['status']>;
  dependsOn: string[];
  skillIds: string[];
  executionWave?: number;
  tokens?: number;
  durationMs?: number;
  attempts?: number;
  toolCalls?: number;
  failureReason?: string;
};

type GraphPosition = { x: number; y: number; angle: number };
type GraphPanel = 'node' | 'events' | null;
type NavigatorRuntime = Navigator & {
  deviceMemory?: number;
  connection?: EventTarget & { saveData?: boolean };
};

const TAU = Math.PI * 2;
const EVENT_ROW_HEIGHT = 40;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const hasCustomLabel = (node: Pick<SignalNode, 'label' | 'role'>) => /[\u3400-\u9fff]/u.test(node.role) || node.label !== agentDisplayName(node.role);

const readRuntimeSignals = (): GraphRuntimeSignals => {
  if (typeof window === 'undefined') return { prefersReducedMotion: false };
  const runtimeNavigator = navigator as NavigatorRuntime;
  return {
    prefersReducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    hardwareConcurrency: runtimeNavigator.hardwareConcurrency,
    deviceMemory: runtimeNavigator.deviceMemory,
    saveData: runtimeNavigator.connection?.saveData,
  };
};

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
const statusLabels: Record<SignalNode['status'], string> = {
  queued: '等待',
  running: '执行中',
  completed: '已完成',
  failed: '失败',
  skipped: '本轮跳过',
  waiting_for_human: '等待确认',
  cancelled: '已取消',
};

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

const formatDuration = (durationMs?: number) => {
  if (!durationMs) return '—';
  if (durationMs < 1_000) return `${Math.round(durationMs)} ms`;
  return `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0)} 秒`;
};

function VirtualEventList({ events }: { events: RunEvent[] }) {
  const { language } = useUiLanguage();
  const viewportRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(240);
  const orderedEvents = useMemo(() => [...events].reverse(), [events]);
  const windowRange = graphVirtualWindow(orderedEvents.length, scrollTop, viewportHeight, EVENT_ROW_HEIGHT);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return undefined;
    const measure = () => setViewportHeight(viewport.clientHeight || 240);
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (viewportRef.current && viewportRef.current.scrollTop <= EVENT_ROW_HEIGHT) viewportRef.current.scrollTop = 0;
  }, [events.length]);

  if (orderedEvents.length === 0) return <div className="dash-agent-panel-empty">当前会话还没有运行事件</div>;
  return <div
    ref={viewportRef}
    className="dash-agent-event-list"
    onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
    data-total-events={orderedEvents.length}
  >
    <div style={{ height: windowRange.paddingTop }} aria-hidden="true" />
    {orderedEvents.slice(windowRange.start, windowRange.end).map((event) => <div className="dash-agent-event-row" key={event.id}>
      <i className={`phase-${event.phase}`} />
      <time>{new Date(event.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time>
      <strong title={translateRunEventLabel(event, language)} data-i18n-ignore="true">{translateRunEventLabel(event, language)}</strong>
    </div>)}
    <div style={{ height: windowRange.paddingBottom }} aria-hidden="true" />
  </div>;
}

export function AgentSignalGraph({ agents, graph, phase, events, selectedNodeId, onSelectAgent }: {
  agents: TopologyAgent[];
  graph: AgentGraph | null;
  phase: AgentPhase;
  events: RunEvent[];
  selectedNodeId: string | null;
  onSelectAgent: (id: string) => void;
}) {
  const { t } = useUiLanguage();
  const stageRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const [runtimeSignals, setRuntimeSignals] = useState(readRuntimeSignals);
  const reducedMotion = shouldReduceGraphMotion(runtimeSignals);
  const [autoRotate, setAutoRotate] = useState(() => !shouldReduceGraphMotion(readRuntimeSignals()));
  const [stageVisible, setStageVisible] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [panel, setPanel] = useState<GraphPanel>(null);
  const focusedSelectionRef = useRef<string | null>(null);
  const stateRef = useRef({
    yaw: -4,
    pitch: 2,
    focusX: 0,
    focusY: 0,
    auto: autoRotate,
    hovering: false,
    dragging: false,
    moved: false,
    pointerId: -1,
    startX: 0,
    startY: 0,
    startYaw: -4,
    startPitch: 2,
    targetId: null as string | null,
    lastFrame: 0,
  });
  const agentByStep = useMemo(() => new Map(agents.map((agent) => [agent.stepId ?? agent.id, agent])), [agents]);
  const agentById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);
  const allNodes = useMemo<SignalNode[]>(() => (graph?.nodes.length ? graph.nodes.map((node) => {
    const runtime = agentByStep.get(node.stepId ?? node.id) ?? (node.agentId ? agentById.get(node.agentId) : undefined);
    return {
      id: node.id,
      label: agentDisplayName(node.role, node.title),
      role: node.role,
      title: node.title,
      status: runtime?.status ?? node.status ?? 'queued',
      dependsOn: node.dependsOn,
      skillIds: runtime?.skillIds ?? node.skillIds ?? [],
      executionWave: node.executionWave,
      tokens: runtime?.tokens ?? node.tokens,
      durationMs: runtime?.durationMs ?? node.durationMs,
      attempts: runtime?.attempts ?? node.attempts,
      toolCalls: runtime?.toolCalls?.length ?? node.toolCalls,
      failureReason: runtime?.failureReason ?? node.failureReason,
    };
  }) : agents.map((agent) => ({
    id: agent.stepId ?? agent.id,
    label: agentDisplayName(agent.role, agent.label),
    role: agent.role,
    title: agent.title ?? agent.label,
    status: agent.status,
    dependsOn: agent.dependsOn ?? [],
    skillIds: agent.skillIds ?? [],
    tokens: agent.tokens,
    durationMs: agent.durationMs,
    attempts: agent.attempts,
    toolCalls: agent.toolCalls?.length,
    failureReason: agent.failureReason,
  }))), [agentById, agentByStep, agents, graph]);
  const nodes = useMemo(() => visibleGraphNodes(allNodes), [allNodes]);
  const truncated = nodes.length < allNodes.length;
  const positions = useMemo(() => positionsFor(nodes.length), [nodes.length]);
  const positionById = useMemo(() => new Map(nodes.map((node, index) => [node.id, positions[index]!])), [nodes, positions]);
  const edges = useMemo(() => (graph?.edges ?? []).filter((edge) => positionById.has(edge.from) && positionById.has(edge.to)), [graph, positionById]);
  const selectedNode = nodes.find((node) => node.id === selectedNodeId) ?? null;
  const displayNodeLabel = (node: SignalNode) => hasCustomLabel(node) ? node.label : t(node.label);
  const live = phase === 'routing' || phase === 'context' || phase === 'inference';

  const applyWorldTransform = useCallback(() => {
    const state = stateRef.current;
    if (!worldRef.current) return;
    worldRef.current.style.transform = `translate3d(${state.focusX.toFixed(1)}px, ${state.focusY.toFixed(1)}px, 0) rotateX(${state.pitch.toFixed(2)}deg) rotateY(${state.yaw.toFixed(2)}deg)`;
    worldRef.current.style.setProperty('--dash-graph-yaw-inverse', `${(-state.yaw).toFixed(2)}deg`);
    worldRef.current.style.setProperty('--dash-graph-pitch-inverse', `${(-state.pitch).toFixed(2)}deg`);
  }, []);

  const focusNode = useCallback((id?: string | null) => {
    const state = stateRef.current;
    const position = id ? positionById.get(id) : undefined;
    const bounds = stageRef.current?.getBoundingClientRect();
    state.auto = false;
    state.yaw = 0;
    state.pitch = 0;
    state.focusX = position && bounds ? (50 - position.x) / 100 * bounds.width : 0;
    state.focusY = position && bounds ? (52 - position.y) / 100 * bounds.height : 0;
    setAutoRotate(false);
    applyWorldTransform();
  }, [applyWorldTransform, positionById]);

  const selectNode = useCallback((id: string) => {
    onSelectAgent(id);
    setPanel('node');
    if (window.matchMedia('(max-width: 700px)').matches) setExpanded(true);
    focusNode(id);
  }, [focusNode, onSelectAgent]);

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const runtimeNavigator = navigator as NavigatorRuntime;
    const update = () => setRuntimeSignals(readRuntimeSignals());
    query.addEventListener('change', update);
    runtimeNavigator.connection?.addEventListener?.('change', update);
    return () => {
      query.removeEventListener('change', update);
      runtimeNavigator.connection?.removeEventListener?.('change', update);
    };
  }, []);

  useEffect(() => {
    if (!reducedMotion) return;
    stateRef.current.auto = false;
    setAutoRotate(false);
  }, [reducedMotion]);

  useEffect(() => {
    stateRef.current.auto = autoRotate;
  }, [autoRotate]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage || typeof IntersectionObserver === 'undefined') return undefined;
    const observer = new IntersectionObserver(([entry]) => setStageVisible(entry?.isIntersecting ?? true), { threshold: 0.01 });
    observer.observe(stage);
    return () => observer.disconnect();
  }, [expanded, nodes.length]);

  useEffect(() => {
    const state = stateRef.current;
    state.lastFrame = performance.now();
    applyWorldTransform();
    if (reducedMotion || !stageVisible || !autoRotate) return undefined;
    let frame = 0;
    const tick = (timestamp: number) => {
      const delta = Math.min(.05, Math.max(.001, (timestamp - state.lastFrame) / 1000));
      state.lastFrame = timestamp;
      if (!document.hidden && state.auto && !state.dragging && !state.hovering) {
        state.yaw += delta * 3.3;
        applyWorldTransform();
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [applyWorldTransform, autoRotate, expanded, nodes.length, reducedMotion, stageVisible]);

  useEffect(() => {
    if (!selectedNodeId) {
      const wasFocused = focusedSelectionRef.current !== null;
      focusedSelectionRef.current = null;
      if (wasFocused) focusNode(null);
      return;
    }
    if (focusedSelectionRef.current === selectedNodeId || !positionById.has(selectedNodeId)) return;
    focusedSelectionRef.current = selectedNodeId;
    setPanel('node');
    focusNode(selectedNodeId);
  }, [focusNode, positionById, selectedNodeId]);

  useEffect(() => {
    if (!expanded) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setExpanded(false);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [expanded]);

  const beginDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
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
    state.focusX = 0;
    state.focusY = 0;
    state.yaw = state.startYaw + dx * .22;
    state.pitch = clamp(state.startPitch - dy * .14, -22, 22);
    applyWorldTransform();
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
    if (shouldSelect) selectNode(targetId);
  };

  const toggleAuto = () => {
    if (reducedMotion) return;
    const next = !autoRotate;
    const state = stateRef.current;
    state.auto = next;
    if (next) {
      state.focusX = 0;
      state.focusY = 0;
    }
    setAutoRotate(next);
  };

  const selectRelativeNode = (offset: number) => {
    if (!nodes.length) return;
    const currentIndex = Math.max(0, nodes.findIndex((node) => node.id === selectedNodeId));
    selectNode(nodes[(currentIndex + offset + nodes.length) % nodes.length]!.id);
  };

  const content = <section
    className={`dash-agent-signal-graph ${expanded ? 'is-expanded' : ''} ${reducedMotion ? 'motion-reduced' : ''}`}
    aria-label="当前对话 Agent Graph"
    role={expanded ? 'dialog' : undefined}
    aria-modal={expanded ? 'true' : undefined}
    data-renderer="css-3d"
    data-motion={reducedMotion ? 'reduced' : 'full'}
  >
    <header>
      <span><MorphIcon icon={phaseIcons[phase]} size={15} strokeWidth={1.8} spring="snappy" reducedMotion="user" /><Network size={14} />Agent Graph</span>
      <div className="dash-agent-graph-actions">
        <button type="button" className="dash-agent-graph-events" aria-pressed={panel === 'events'} onClick={() => setPanel((current) => current === 'events' ? null : 'events')} title="查看运行事件"><Activity size={13} /></button>
        <button type="button" className="dash-agent-graph-auto" aria-pressed={autoRotate} onClick={toggleAuto} disabled={reducedMotion} title={reducedMotion ? '设备已启用低动态模式' : '切换自动旋转'}><Rotate3D size={13} /></button>
        <button type="button" className="dash-agent-graph-focus" onClick={() => focusNode(selectedNodeId)} title={selectedNode ? '聚焦选中 Agent' : '恢复正面视角'}><Focus size={13} /></button>
        <button type="button" className="dash-agent-graph-expand" onClick={() => setExpanded((current) => !current)} title={expanded ? '退出全屏' : '全屏查看'}>{expanded ? <Minimize2 size={13} /> : <Maximize2 size={13} />}</button>
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
            data-i18n-ignore="true"
            className={`dash-agent-signal-node status-${node.status} variant-${index % 5} ${active ? 'active' : ''} ${selected ? 'selected' : ''}`}
            style={{
              left: `${position.x}%`,
              top: `${position.y}%`,
              '--dash-node-depth': `${(Math.cos(position.angle) * 24).toFixed(2)}px`,
            } as CSSProperties}
            title={`${displayNodeLabel(node)} · ${t(statusLabels[node.status])}`}
            aria-label={`${displayNodeLabel(node)}，${t(statusLabels[node.status])}`}
            aria-pressed={selected}
            onPointerEnter={() => { stateRef.current.hovering = true; }}
            onPointerLeave={() => { stateRef.current.hovering = false; }}
            onFocus={() => { stateRef.current.hovering = true; }}
            onBlur={() => { stateRef.current.hovering = false; }}
            onClick={(event) => {
              if (stateRef.current.moved && event.detail !== 0) return;
              selectNode(node.id);
            }}
          >
            <span className="dash-agent-ribbon ribbon-a" /><span className="dash-agent-ribbon ribbon-b" />
            <span className="dash-agent-spark spark-a" /><span className="dash-agent-spark spark-b" />
            <span className="dash-agent-sphere" aria-hidden="true">
              <i className="dash-agent-eye eye-left" />
              <i className="dash-agent-eye eye-right" />
              <span className="dash-agent-mouth" />
              <b className="dash-agent-status-dot" />
            </span>
            <span className="dash-agent-node-meta"><MorphIcon icon={statusIcon(node.status)} size={13} strokeWidth={2} spring="snappy" reducedMotion="user" /><em>{displayNodeLabel(node)}</em></span>
          </button>;
        })}
      </div>
    </div>}
    {panel && <aside className={`dash-agent-graph-panel panel-${panel}`} aria-label={panel === 'events' ? '运行事件' : 'Agent 详情'}>
      <header>
        <div>{panel === 'events' ? <><Activity size={14} /><strong>运行事件</strong><small>{events.length}</small></> : <><Network size={14} /><strong data-i18n-ignore="true">{selectedNode ? displayNodeLabel(selectedNode) : t('Agent 详情')}</strong></>}</div>
        <div>
          {panel === 'node' && nodes.length > 1 && <><button type="button" title="上一个 Agent" onClick={() => selectRelativeNode(-1)}><ChevronLeft size={14} /></button><button type="button" title="下一个 Agent" onClick={() => selectRelativeNode(1)}><ChevronRight size={14} /></button></>}
          <button type="button" title="关闭" onClick={() => setPanel(null)}><X size={14} /></button>
        </div>
      </header>
      {panel === 'events' ? <VirtualEventList events={events} /> : selectedNode ? <div className="dash-agent-node-detail">
        <div className="dash-agent-node-state"><i className={`status-${selectedNode.status}`} /><strong>{statusLabels[selectedNode.status]}</strong><span data-i18n-ignore="true">{/[\u3400-\u9fff]/u.test(selectedNode.role) ? selectedNode.role : t(agentDisplayName(selectedNode.role))}</span></div>
        <dl>
          <div><dt>Token</dt><dd>{selectedNode.tokens?.toLocaleString() ?? '—'}</dd></div>
          <div><dt>耗时</dt><dd>{formatDuration(selectedNode.durationMs)}</dd></div>
          <div><dt>尝试</dt><dd>{selectedNode.attempts ?? 0}</dd></div>
          <div><dt>工具</dt><dd>{selectedNode.toolCalls ?? 0}</dd></div>
        </dl>
        {selectedNode.dependsOn.length > 0 && <div className="dash-agent-node-links"><span>上游</span>{selectedNode.dependsOn.map((id) => {
          const upstream = nodes.find((node) => node.id === id);
          return <button type="button" key={id} data-i18n-ignore="true" disabled={!positionById.has(id)} onClick={() => selectNode(id)}>{upstream ? displayNodeLabel(upstream) : id}</button>;
        })}</div>}
        {selectedNode.skillIds.length > 0 && <p><span>Skill</span>{selectedNode.skillIds.join(' · ')}</p>}
        {selectedNode.failureReason && <p className="failure"><span>原因</span>{selectedNode.failureReason}</p>}
      </div> : <div className="dash-agent-panel-empty">选择一个 Agent 查看执行详情</div>}
    </aside>}
  </section>;

  const dashboardRoot = expanded && typeof document !== 'undefined'
    ? document.querySelector('.axiom-dashboard')
    : null;
  return dashboardRoot ? createPortal(content, dashboardRoot) : content;
}
