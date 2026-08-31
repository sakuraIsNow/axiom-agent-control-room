import type { AgentGraph, AgentPhase, TopologyAgent } from '../../types';
import type { UiTheme } from '../../lib/uiTheme';
import { CinematicCore } from './CinematicCore';

export function CoreView({ phase, agents, graph, theme, onSelectAgent }: { phase: AgentPhase; agents: TopologyAgent[]; graph: AgentGraph | null; theme: UiTheme; onSelectAgent: (id: string) => void }) {
  return <div className="shell-core-view"><CinematicCore phase={phase} agents={agents} graph={graph} theme={theme} onSelectAgent={onSelectAgent} /><div className="shell-core-legend"><span><i className="live" />执行中</span><span><i className="done" />已完成</span><span><i className="idle" />等待</span></div></div>;
}
