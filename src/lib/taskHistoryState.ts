import type { WorkflowTask, WorkflowTaskStatus } from '../types';
import { agentDisplayName } from './agentPresentation';

const executingStatuses = new Set<WorkflowTaskStatus>(['queued', 'planning', 'running', 'reviewing']);

export const isTaskExecuting = (status: WorkflowTaskStatus) => executingStatuses.has(status);

export const taskHistoryState = (task: WorkflowTask) => {
  if (task.status === 'awaiting_approval') {
    return {
      pending: false,
      content: '规划 Agent 已生成执行计划，等待你批准后继续。',
      activity: '',
    };
  }

  if (task.status === 'waiting_for_human') {
    const pendingTool = task.toolApprovals?.find((approval) => approval.status === 'pending');
    if (pendingTool) {
      return {
        pending: false,
        content: `工具 ${pendingTool.name} 需要你确认后才能继续。`,
        activity: '',
      };
    }
    if (task.review) {
      return {
        pending: false,
        content: `审查 Agent 已完成质量检查（${task.review.score}/100），当前结果需要你确认。`,
        activity: '',
      };
    }
    return {
      pending: false,
      content: task.error ? `任务已暂停，等待你处理：${task.error}` : '任务已暂停，等待你处理后继续。',
      activity: '',
    };
  }

  if (task.status === 'paused') {
    return {
      pending: false,
      content: task.error ? `任务已暂停：${task.error}` : '任务已暂停，可从协作面板继续。',
      activity: '',
    };
  }

  if (task.status === 'completed') {
    return { pending: false, content: task.result || '', activity: '' };
  }
  if (task.status === 'failed') {
    return { pending: false, content: `工作流失败：${task.error || '未返回失败原因。'}`, activity: '' };
  }
  if (task.status === 'cancelled') {
    return { pending: false, content: '任务已取消。', activity: '' };
  }

  const runningResult = task.stepResults.find((result) => result.status !== 'completed');
  const role = runningResult?.role ?? (task.plan?.profile?.route === 'direct' ? 'direct-responder' : 'orchestrator');
  return {
    pending: true,
    content: task.result || (task.error ? `工作流失败：${task.error}` : ''),
    activity: `${agentDisplayName(role)}正在恢复执行状态`,
  };
};
