import { useParallax } from './useParallax';
import type { CSSProperties, ReactNode } from 'react';
import type { ShellView } from '../../lib/useShellStore';
import type { AgentPhase } from '../../types';

export function ShellObservatory({ view, phase, children }: { view: ShellView; phase: AgentPhase; children: ReactNode }) {
  const parallax = useParallax();
  const title = view === 'core' ? '自主核心' : view === 'graph' ? '推理图谱' : '事件流';
  return <section className={`shell-observatory shell-observatory-${view}`} style={{ '--shell-parallax-x': `${parallax.x}px`, '--shell-parallax-y': `${parallax.y}px` } as CSSProperties}><div className="shell-observatory-head"><span>OBSERVATORY / {phase.toUpperCase()}</span><strong>{title}</strong><i /></div><div className="shell-observatory-stage">{children}</div><div className="shell-observatory-corner corner-a" /><div className="shell-observatory-corner corner-b" /></section>;
}
