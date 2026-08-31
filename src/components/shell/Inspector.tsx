import { Crosshair, ExternalLink } from 'lucide-react';
import type { AgentGraphNode, CollaborationConflict, CollaborationMessage, BudgetConstraint, TopologyAgent } from '../../types';
import { agentDisplayName } from '../../lib/agentPresentation';
import { taskStageLabel } from '../../lib/taskPresentation';

const title = (node: AgentGraphNode | TopologyAgent) => 'title' in node ? node.title : node.label;
const role = (node: AgentGraphNode | TopologyAgent) => agentDisplayName(node.role);
const status = (node: AgentGraphNode | TopologyAgent) => node.status ?? 'queued';

export function Inspector({ node, messages, conflicts, budgets, onSelect }: { node: AgentGraphNode | TopologyAgent | null; messages: CollaborationMessage[]; conflicts: CollaborationConflict[]; budgets: BudgetConstraint[]; onSelect: () => void }) {
  const skills = node && 'skillIds' in node ? node.skillIds ?? [] : [];
  return <aside className="shell-inspector"><div className="shell-inspector-heading"><span>节点检查器</span><Crosshair size={14} /></div>{node ? <><div className="shell-inspector-name"><strong>{title(node)}</strong><small>{role(node)}</small></div><dl><div><dt>状态</dt><dd className={status(node)}>{taskStageLabel(status(node))}</dd></div><div><dt>依赖</dt><dd>{node.dependsOn?.length ?? 0}</dd></div><div><dt>Token</dt><dd>{'tokens' in node ? node.tokens ?? 0 : 0}</dd></div></dl>{skills.length > 0 && <div className="shell-inspector-skills"><span>本轮技能</span><small>{skills.join(' · ')}</small></div>}<button type="button" onClick={onSelect}>聚焦节点 <ExternalLink size={12} /></button></> : <p className="shell-inspector-empty">在核心或推理图中选择一个节点查看真实上下文。</p>}<div className="shell-inspector-telemetry"><span>协作状态</span><strong>{messages.length + conflicts.length + budgets.length} 条事件</strong><small>{messages.length} 交接 · {conflicts.length} 冲突 · {budgets.length} 预算</small></div></aside>;
}
