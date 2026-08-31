import type { WorkflowTaskSummary } from '../types';

export type TaskRunGroup = {
  task: WorkflowTaskSummary;
  count: number;
  sessionCount: number;
  taskIds: string[];
};

/**
 * Agent Nexus runs are durable executions of one published workflow template.
 * Older records do not always carry the explicit source field, so retain the
 * historical identifiers as a backwards-compatible fallback.
 */
export function isAgentWorkflowTask(task: WorkflowTaskSummary): boolean {
  if (!task.templateId) return false;
  // A source written by the server is authoritative. This prevents a normal
  // task from being classified by an accidental session-name collision.
  if (task.source) return task.source === 'agent-workflow';
  if (task.sessionId.startsWith('agent-nexus-')) return true;
  return task.profile?.route === 'full-workflow' && /[·•]\s*执行\s*$/.test(task.title.trim());
}

/**
 * The task API stores one run for every turn in a conversation. The dashboard
 * is a session-level surface, so repeated runs from the same session should
 * occupy one card while the newest run remains the actionable representative.
 */
export function groupTaskRuns(tasks: WorkflowTaskSummary[]): TaskRunGroup[] {
  type MutableGroup = TaskRunGroup & { sessionIds: Set<string> };
  const groups = new Map<string, MutableGroup>();
  for (const task of tasks) {
    const normalizedTitle = task.title.replace(/\s+/g, ' ').trim().toLocaleLowerCase();
    // One Agent Nexus workflow can have multiple execution sessions. Its
    // template is the durable identity; ordinary tasks remain session-scoped.
    const key = isAgentWorkflowTask(task)
      ? `template:${task.templateId}`
      : `session:${task.sessionId || normalizedTitle || task.id}`;
    const current = groups.get(key);
    if (!current) {
      groups.set(key, {
        task,
        count: 1,
        sessionCount: task.sessionId ? 1 : 0,
        taskIds: [task.id],
        sessionIds: new Set(task.sessionId ? [task.sessionId] : []),
      });
      continue;
    }
    current.count += 1;
    current.taskIds.push(task.id);
    if (task.sessionId) current.sessionIds.add(task.sessionId);
    current.sessionCount = current.sessionIds.size;
    if (new Date(task.updatedAt).getTime() > new Date(current.task.updatedAt).getTime()) current.task = task;
  }
  return [...groups.values()]
    .map(({ sessionIds: _sessionIds, ...group }) => group)
    .sort((a, b) => new Date(b.task.updatedAt).getTime() - new Date(a.task.updatedAt).getTime());
}
