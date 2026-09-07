import type { WorkflowTaskStatus } from '../types';

export const isNexusTaskExecuting = (status: WorkflowTaskStatus) => ['queued', 'planning', 'running', 'reviewing'].includes(status);
export const isNexusTaskTerminal = (status: WorkflowTaskStatus) => ['completed', 'failed', 'cancelled'].includes(status);
export const nexusTaskActivity = (status: WorkflowTaskStatus, partial = false) => status === 'completed' && partial ? 'Agent Nexus 已保存部分结果' : ({
  queued: 'Agent Nexus 已排队', planning: '调度器正在规划 Agent Nexus', running: 'Agent Nexus 正在执行', reviewing: '质量检查正在进行',
  paused: 'Agent Nexus 已暂停', awaiting_approval: '执行计划等待你的确认', waiting_for_human: 'Agent Nexus 等待你处理',
  completed: 'Agent Nexus 执行完成', failed: 'Agent Nexus 执行未完成', cancelled: 'Agent Nexus 已停止',
}[status]);
