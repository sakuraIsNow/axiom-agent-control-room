import { useEffect, useMemo, useRef } from 'react';
import { Focus, History } from 'lucide-react';
import type { WorkflowTaskSummary } from '../../types';
import { getUiTheme, type UiTheme } from '../../lib/uiTheme';
import { taskStatusColor, taskStatusLabels } from '../../lib/graphPresentation';
import { groupTaskRuns } from '../../lib/taskGrouping';
import { taskRouteLabel } from '../../lib/taskPresentation';

type Props = {
  tasks: WorkflowTaskSummary[];
  theme: UiTheme;
  selectedTaskId: string | null;
  onOpenTask: (id: string) => void;
};

const TAU = Math.PI * 2;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const ease = (value: number) => {
  const t = clamp(value, 0, 1);
  return t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
};
const statusAccent: Record<ReturnType<typeof taskStatusColor>, string> = {
  queued: '#a5aea9', running: '#2bea78', completed: '#c6cfca', failed: '#e08389',
};

export function TaskOrbitCarousel({ tasks, theme, selectedTaskId, onOpenTask }: Props) {
  const groups = useMemo(() => groupTaskRuns(tasks).slice(0, 14), [tasks]);
  const visible = useMemo(() => groups.map((group) => group.task), [groups]);
  const highlightedId = selectedTaskId && visible.some((task) => task.id === selectedTaskId)
    ? selectedTaskId
    : groups.find((group) => group.taskIds.includes(selectedTaskId ?? ''))?.task.id ?? visible[0]?.id ?? null;
  const visibleRef = useRef(visible);
  const highlightedIdRef = useRef(highlightedId);
  visibleRef.current = visible;
  highlightedIdRef.current = highlightedId;
  const stageRef = useRef<HTMLDivElement>(null);
  const deckRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const stateRef = useRef({
    frontIndex: 0,
    rotation: 0,
    velocity: 0,
    dragging: false,
    lastX: 0,
    lastT: 0,
    dragMoved: 0,
    holdUntil: 0,
    animation: null as null | { from: number; to: number; start: number; duration: number },
    lastFrame: performance.now(),
  });
  const palette = getUiTheme(theme);
  const stepAngle = () => TAU / Math.max(1, visibleRef.current.length);
  const wrapIndex = (value: number) => ((value % Math.max(1, visibleRef.current.length)) + Math.max(1, visibleRef.current.length)) % Math.max(1, visibleRef.current.length);
  const nearestFrontIndex = () => wrapIndex(Math.round(-stateRef.current.rotation / stepAngle()));
  const nearestRotationFor = (index: number) => {
    const base = -index * stepAngle();
    const current = stateRef.current.rotation;
    return base + Math.round((current - base) / TAU) * TAU;
  };

  const layout = () => {
    const state = stateRef.current;
    const stageWidth = stageRef.current?.clientWidth ?? 720;
    const stageHeight = stageRef.current?.clientHeight ?? 470;
    const radiusX = clamp(stageWidth * .34, 230, 470);
    const radiusZ = clamp(stageWidth * .2, 155, 255);
    const currentVisible = visibleRef.current;
    const selectedIndex = currentVisible.findIndex((task) => task.id === highlightedIdRef.current);
    if (!deckRef.current) return;
    deckRef.current.style.transform = `scale(${clamp(stageWidth / 980, .82, 1).toFixed(3)})`;
    currentVisible.forEach((task, index) => {
      const card = cardRefs.current[index];
      if (!card) return;
      const angle = state.rotation + index * stepAngle();
      const sin = Math.sin(angle);
      const cos = Math.cos(angle);
      const depth = (cos + 1) / 2;
      const x = sin * radiusX;
      const z = cos * radiusZ;
      const y = Math.sin(angle * 2) * Math.min(20, stageHeight * .04) + (1 - depth) * 22 - 10;
      const front = index === state.frontIndex;
      const scale = .7 + depth * .3;
      card.style.transform = `translate3d(-50%, -50%, 0) translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, ${z.toFixed(1)}px) rotateY(${(-sin * 21).toFixed(1)}deg) rotateZ(${(-sin * 2.1).toFixed(2)}deg) scale(${scale.toFixed(3)})`;
      card.style.filter = `brightness(${(.56 + depth * .53).toFixed(3)}) blur(${(front && depth > .84 ? 0 : (1 - depth) * 1.25).toFixed(2)}px)`;
      card.style.zIndex = String(100 + Math.round(depth * 300) + (front ? 3 : 0));
      card.style.setProperty('--orbit-label-opacity', (index === selectedIndex ? .96 : .03 + Math.pow(depth, 10) * .97).toFixed(3));
      card.classList.toggle('front', front);
      card.classList.toggle('selected', index === selectedIndex);
    });
  };

  const focusHighlighted = () => {
    const index = visibleRef.current.findIndex((task) => task.id === highlightedIdRef.current);
    if (index < 0) return;
    const state = stateRef.current;
    state.animation = { from: state.rotation, to: nearestRotationFor(index), start: performance.now(), duration: 620 };
    state.velocity = 0;
    state.holdUntil = performance.now() + 1_800;
  };

  useEffect(() => {
    const observer = new ResizeObserver(layout);
    if (stageRef.current) observer.observe(stageRef.current);
    layout();
    return () => observer.disconnect();
  }, [highlightedId, visible]);

  useEffect(() => {
    let frame = 0;
    const tick = (timestamp: number) => {
      const state = stateRef.current;
      const delta = Math.min(.05, Math.max(.001, (timestamp - state.lastFrame) / 1000));
      state.lastFrame = timestamp;
      if (!state.dragging) {
        if (state.animation) {
          const raw = clamp((timestamp - state.animation.start) / state.animation.duration, 0, 1);
          state.rotation = state.animation.from + (state.animation.to - state.animation.from) * ease(raw);
          if (raw >= 1) { state.rotation = state.animation.to; state.animation = null; state.velocity = 0; }
        } else if (Math.abs(state.velocity) > .004) {
          state.rotation += state.velocity * delta;
          state.velocity *= Math.pow(.93, delta * 60);
        } else if (timestamp >= state.holdUntil && visible.length > 1) {
          state.rotation += .2 * delta;
        }
        state.frontIndex = nearestFrontIndex();
        layout();
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [visible.length]);

  if (!visible.length) return <div className="dash-carousel-empty"><History size={22} /><span>暂无任务</span></div>;

  const beginDrag = (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    const pointerTarget = event.target as HTMLElement;
    if (pointerTarget.closest('.dash-orbit-focus')) return;
    const state = stateRef.current;
    state.dragging = true;
    state.dragMoved = 0;
    state.lastX = event.clientX;
    state.lastT = performance.now();
    state.animation = null;
    state.velocity = 0;
    pointerTarget.setPointerCapture?.(event.pointerId);
  };
  const moveDrag = (event: React.PointerEvent) => {
    const state = stateRef.current;
    if (!state.dragging) return;
    const now = performance.now();
    const dx = event.clientX - state.lastX;
    const deltaSeconds = Math.max(.008, (now - state.lastT) / 1000);
    const rotationDelta = dx * .0055;
    state.rotation += rotationDelta;
    state.velocity = state.velocity * .5 + rotationDelta / deltaSeconds * .5;
    state.dragMoved += Math.abs(dx);
    state.lastX = event.clientX;
    state.lastT = now;
    state.holdUntil = now + 320;
    state.frontIndex = nearestFrontIndex();
    layout();
  };
  const endDrag = () => { stateRef.current.dragging = false; };

  return <div ref={stageRef} className="dash-orbit-stage" onPointerDown={beginDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}>
    <div className="dash-orbit-ambient" style={{ background: `linear-gradient(110deg, transparent, ${palette.scene.signal}22 52%, transparent)` }} aria-hidden="true" />
    <button type="button" className="dash-orbit-focus" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); focusHighlighted(); }} disabled={!highlightedId} title="将选中任务转到正前方"><Focus size={15} /><span>聚焦选中</span></button>
    <div ref={deckRef} className="dash-orbit-deck">
      {visible.map((task, index) => {
        const runCount = groups[index]?.count ?? 1;
        const tone = taskStatusColor(task.status);
        return <button
          key={task.id}
          ref={(node) => { cardRefs.current[index] = node; }}
          type="button"
          className="dash-orbit-card"
          data-task-id={task.id}
          style={{ '--orbit-accent': statusAccent[tone] } as React.CSSProperties}
          onClick={(event) => { event.stopPropagation(); if (stateRef.current.dragMoved < 5) onOpenTask(task.id); }}
        >
          <span className="dash-orbit-card-shell" /><span className="dash-orbit-card-rim" />
          <span className="dash-orbit-card-text"><em>{taskRouteLabel(task.profile?.route ?? task.mode)}</em><strong data-i18n-ignore="true">{task.title}</strong><small>{taskStatusLabels[task.status]} · {runCount} 次 · {new Date(task.updatedAt).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })}</small></span>
        </button>;
      })}
    </div>
    <div className="dash-orbit-caption"><span className="dash-orbit-dot" />实时任务轨道</div>
  </div>;
}
