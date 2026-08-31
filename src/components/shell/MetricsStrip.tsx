import { CountUp } from './CountUp';
import type { AgentPhase, Usage } from '../../types';

export function MetricsStrip({ agents, eventCount, usage, durationMs, catalogCount, phase }: { agents: Array<{ status: string }>; eventCount: number; usage: Usage; durationMs: number; catalogCount: number; phase: AgentPhase }) {
  const running = agents.filter((agent) => agent.status === 'running').length;
  const completed = agents.filter((agent) => agent.status === 'completed').length;
  return <div className="shell-metrics"><div><small>可用 Agent</small><strong><CountUp value={catalogCount} /></strong><span>{running} 执行中</span></div><div><small>图谱节点</small><strong><CountUp value={agents.length || (phase === 'idle' ? 0 : 1)} /></strong><span>{completed} 已完成</span></div><div><small>累计 Token</small><strong><CountUp value={usage.total_tokens ?? 0} /></strong><span>{durationMs ? `${(durationMs / 1000).toFixed(1)} 秒` : '等待运行'}</span></div><div><small>事件总数</small><strong><CountUp value={eventCount} /></strong><span>任务 / 事件 / SSE</span></div></div>;
}
