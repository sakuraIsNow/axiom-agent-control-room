import { useEffect, useMemo } from 'react';
import { Activity, Gauge, Settings2 } from 'lucide-react';
import { useShellStore } from '../../lib/useShellStore';
import type { AgentGraphNode, TopologyAgent } from '../../types';
import { ShellCommandBar } from './ShellCommandBar';
import { ShellHeader } from './ShellHeader';
import { ShellNavRail } from './ShellNavRail';
import { ShellObservatory } from './ShellObservatory';
import { CoreView } from './CoreView';
import { GraphView } from './GraphView';
import { StreamView } from './StreamView';
import { MetricsStrip } from './MetricsStrip';
import { Inspector } from './Inspector';
import type { ShellProps } from './shellTypes';
import { taskReasonLabel } from '../../lib/taskPresentation';
import '../../styles/shell.css';

const routeLabel: Record<string, string> = { direct: '直接响应', 'single-agent': '单 Agent', team: '团队协作', 'full-workflow': '完整工作流' };
const nodeId = (node: AgentGraphNode | TopologyAgent) => 'stepId' in node && node.stepId ? node.stepId : node.id;

export function AxiomShell(props: ShellProps) {
  const { phase, mode, draft, onDraftChange, onSend, onBack, onNewTask, onOpenSettings, onOpenPlugins, onStop, onPause, onResume, isRunning, theme, onThemeChange, agents, graph, selectedNodeId, onSelectAgent, taskProfile, runEvents, collaborationMessages, collaborationConflicts, budgetConstraints, usage, durationMs, catalogCount, readiness, provider } = props;
  const view = useShellStore((state) => state.view);
  const setView = useShellStore((state) => state.setView);
  const storeSelect = useShellStore((state) => state.selectNode);
  const syncRuntime = useShellStore((state) => state.syncRuntime);
  useEffect(() => {
    syncRuntime({ phase, agents, graph, selectedNodeId, runEvents, collaborationMessages, collaborationConflicts, budgetConstraints, usage, durationMs, taskProfile });
  }, [budgetConstraints, collaborationConflicts, collaborationMessages, durationMs, graph, agents, phase, runEvents, selectedNodeId, syncRuntime, taskProfile, usage]);
  const nodes = useMemo(() => graph?.nodes.filter((node) => node.id !== 'orchestrator') ?? agents, [agents, graph]);
  const selected = nodes.find((node) => nodeId(node) === selectedNodeId) ?? null;
  const selectNode = (id: string) => { storeSelect(id); onSelectAgent(id); };
  const route = taskProfile ? routeLabel[taskProfile.route] ?? taskProfile.route : '新的执行空间';

  return <main className="axiom-shell" data-theme={theme} data-readiness={readiness}>
    <div className="shell-backdrop" aria-hidden="true"><span className="shell-backdrop-line line-one" /><span className="shell-backdrop-line line-two" /><span className="shell-backdrop-ring" /></div>
    <ShellHeader phase={phase} provider={provider} theme={theme} onThemeChange={onThemeChange} onNewTask={onNewTask} onOpenSettings={onOpenSettings} onBack={onBack} />
    <div className="shell-layout"><ShellNavRail view={view} onView={setView} onNewTask={onNewTask} onOpenPlugins={onOpenPlugins} agentCount={nodes.length} eventCount={runEvents.length} /><section className="shell-main"><div className="shell-intro"><div><span className="shell-kicker">AXIOM / 自主运行时</span><h1>{route}</h1><p>{taskProfile?.reasons[0] ? taskReasonLabel(taskProfile.reasons[0]) : '把目标交给运行时，实时观察路由、推理与协作。'}</p></div><div className="shell-intro-meta"><span><i className={`shell-readiness ${readiness}`} />{readiness === 'ready' ? '运行就绪' : readiness === 'degraded' ? '本地模式' : '运行受阻'}</span><button type="button" onClick={onOpenSettings} title="运行设置"><Settings2 size={15} /></button></div></div><ShellCommandBar draft={draft} onDraftChange={onDraftChange} onSend={onSend} onStop={onStop} onPause={onPause} onResume={onResume} isRunning={isRunning} mode={mode} phase={phase} /><ShellObservatory view={view} phase={phase}>{view === 'core' && <CoreView phase={phase} agents={agents} graph={graph} theme={theme} onSelectAgent={selectNode} />}{view === 'graph' && <GraphView graph={graph} agents={agents} selectedNodeId={selectedNodeId} onSelectAgent={selectNode} />}{view === 'stream' && <StreamView events={runEvents} messages={collaborationMessages} conflicts={collaborationConflicts} budgets={budgetConstraints} />}</ShellObservatory><div className="shell-lower"><MetricsStrip agents={agents} eventCount={runEvents.length} usage={usage} durationMs={durationMs} catalogCount={catalogCount} phase={phase} /><Inspector node={selected} messages={collaborationMessages} conflicts={collaborationConflicts} budgets={budgetConstraints} onSelect={() => selected && selectNode(nodeId(selected))} /></div><div className="shell-footer"><span><Activity size={12} />真实任务 / 事件 / SSE</span><span>{nodes.length} 个推理节点 · {provider}</span><button type="button" onClick={onBack}>返回任务台</button></div></section></div>
  </main>;
}
