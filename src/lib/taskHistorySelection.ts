import type { Session, WorkflowTask } from '../types';
import { compactStoredUserMessage, latestUserInput } from './conversationInput';

/** Finds the assistant turn owned by a task, preferring the newest matching turn. */
export const findTaskAssistantIndex = (session: Session | undefined, task: Pick<WorkflowTask, 'id' | 'input'>) => {
  if (!session) return -1;
  for (let index = session.messages.length - 1; index >= 0; index -= 1) {
    const message = session.messages[index];
    if (message?.role === 'assistant' && message.taskId === task.id) return index;
  }
  if (session.activeTaskId === task.id && session.activeAssistantId) {
    for (let index = session.messages.length - 1; index >= 0; index -= 1) {
      const message = session.messages[index];
      if (message?.role === 'assistant' && message.id === session.activeAssistantId) return index;
    }
  }
  const taskInput = compactStoredUserMessage(latestUserInput(task.input)).trim();
  for (let userIndex = session.messages.length - 1; userIndex >= 0; userIndex -= 1) {
    const user = session.messages[userIndex];
    if (user?.role !== 'user' || compactStoredUserMessage(user.content).trim() !== taskInput) continue;
    for (let index = session.messages.length - 1; index > userIndex; index -= 1) {
      const candidate = session.messages[index];
      if (candidate?.role === 'user') break;
      if (candidate?.role === 'assistant') return index;
    }
  }
  return -1;
};
