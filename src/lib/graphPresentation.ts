import type { AgentGraphNode, TopologyAgent, WorkflowTaskStatus } from '../types';

export const taskStatusLabels: Record<WorkflowTaskStatus, string> = {
  queued: '排队中',
  planning: '规划中',
  awaiting_approval: '等计划审批',
  running: '执行中',
  reviewing: '审核中',
  waiting_for_human: '等人工审核',
  paused: '已暂停',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

export const taskStatusColor = (status: WorkflowTaskStatus): 'queued' | 'running' | 'completed' | 'failed' => {
  if (status === 'completed') return 'completed';
  if (status === 'failed' || status === 'cancelled') return 'failed';
  if (status === 'queued' || status === 'planning' || status === 'awaiting_approval') return 'queued';
  return 'running';
};

export type PresentableNode = AgentGraphNode | TopologyAgent;

export const nodeId = (node: PresentableNode): string => ('stepId' in node && node.stepId ? node.stepId : node.id);

export const nodeTitle = (node: PresentableNode): string => ('title' in node && node.title ? node.title : 'label' in node ? node.label : node.id);

export const nodeRole = (node: PresentableNode): string => node.role;

export const nodeStatus = (node: PresentableNode): NonNullable<AgentGraphNode['status']> => node.status ?? 'queued';

export const statusText: Record<string, string> = {
  queued: '等待',
  running: '执行中',
  completed: '完成',
  failed: '失败',
  skipped: '已跳过',
  waiting_for_human: '等人工处理',
  cancelled: '已取消',
};

export function statusColor(status: string, theme: { roleColors: Record<string, string>; scene: { signal: string; idle: string } }, role?: string): string {
  if (status === 'running') return theme.scene.signal;
  if (status === 'failed') return '#e05a4a';
  if (role && theme.roleColors[role]) return theme.roleColors[role];
  return theme.scene.idle;
}
