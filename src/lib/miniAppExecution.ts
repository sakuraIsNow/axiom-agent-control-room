import type { ChatRouteDecision, WorkflowEvent, WorkflowTask } from '../types';
import { getWorkflowTask, streamWorkflowEvents } from './taskRuntime';
import { taskHasPartialDelivery } from './taskDelivery';
import { deliveryEventActivity } from './taskPresentation';

export type MiniAppTaskProgress = { content?: string; reset?: boolean; status?: string; taskId?: string; sequence?: number; completionStatus?: 'complete' | 'partial' };

export const miniAppNeedsTask = (route: ChatRouteDecision) => route.execution === 'workflow'
  || route.intent === 'image-generation' || route.intent === 'video-generation';

export function miniAppTaskOutput(task: WorkflowTask): string {
  if (task.status !== 'completed') {
    if (['paused', 'awaiting_approval', 'waiting_for_human'].includes(task.status)) {
      throw new Error('任务已保留，等待你处理后继续。');
    }
    throw new Error(task.error || (task.status === 'cancelled' ? '任务已取消。' : '任务尚未完成，请在任务管理中查看进度。'));
  }
  if (!task.result?.trim()) throw new Error('任务结束但未返回交付内容，请在任务管理中核查。');
  return taskHasPartialDelivery(task) ? `[Partial result / 部分结果]\n\n${task.result}` : task.result;
}

export async function observeMiniAppTask(taskId: string, signal: AbortSignal, onProgress: (progress: MiniAppTaskProgress) => void, afterSequence = 0) {
  onProgress({ taskId, status: '正在读取任务状态' });
  const initial = await getWorkflowTask(taskId, signal);
  onProgress({ status: ['paused', 'awaiting_approval', 'waiting_for_human'].includes(initial.status)
    ? '等待你处理后继续' : initial.status === 'completed' ? taskHasPartialDelivery(initial) ? 'Agent 已保存部分结果' : 'Agent 已完成' : initial.status === 'failed' || initial.status === 'cancelled' ? '任务已停止' : 'Agent 正在执行' });
  if (!['completed', 'failed', 'cancelled', 'paused', 'awaiting_approval', 'waiting_for_human'].includes(initial.status)) {
    await streamWorkflowEvents(taskId, signal, (event: WorkflowEvent) => {
      onProgress({ sequence: event.sequence });
      const deliveryActivity = deliveryEventActivity(event);
      if (deliveryActivity) onProgress({ status: deliveryActivity });
      if (event.type === 'model.delta' && event.payload.stage === 'synthesizer') {
        if (event.payload.reset === true) onProgress({ reset: true });
        if (typeof event.payload.content === 'string') onProgress({ content: event.payload.content });
      }
      if (event.type === 'agent.started') onProgress({ status: `${String(event.payload.agentName ?? event.payload.title ?? 'Agent')}正在执行` });
      if (event.type === 'review.started') onProgress({ status: 'Agent 正在检查结果' });
    }, afterSequence);
  }
  const task = await getWorkflowTask(taskId, signal);
  const output = miniAppTaskOutput(task);
  onProgress({ reset: true });
  const partial = taskHasPartialDelivery(task);
  onProgress({ content: output, status: partial ? 'Agent 已保存部分结果' : 'Agent 已完成', completionStatus: partial ? 'partial' : 'complete' });
  return output;
}
