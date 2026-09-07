import { z } from 'zod';
import type { TaskStore } from './contracts.js';
import type { RegisteredTool } from './toolRegistry.js';
import type { DurableContextSourceMessage, PersistedContextSummary } from './contextSummary.js';
import { loadOwnedWorkflowConversation } from './conversationContextService.js';
import { retrieveContextSources } from './structuredContext.js';

const selectionSchema = z.object({
  messageIds: z.array(z.string().min(1).max(200)).max(20).optional(),
  directiveIds: z.array(z.string().min(1).max(100)).max(20).optional(),
  query: z.string().min(1).max(500).optional(),
  offset: z.number().int().nonnegative().max(1_000_000).optional(),
  limit: z.number().int().min(1).max(20).optional(),
  maxCharacters: z.number().int().min(1).max(24_000).optional(),
}).strict().refine((value) => Boolean(value.messageIds?.length || value.directiveIds?.length || value.query), { message: 'Select source message IDs, directive IDs, or a literal text query.' });

export const createContextReadTool = (store: TaskStore): RegisteredTool => ({
  name: 'context.read',
  description: 'Read original conversation messages by source message IDs, constraint/decision IDs, or literal text query. Scope is fixed to this task owner and conversation or Nexus history. Use this before resolving ambiguous or truncated historical constraints.',
  risk: 'low', sideEffect: 'read-only', executionBoundary: 'host-bounded', timeoutMs: 10_000,
  parameters: { type: 'object', properties: {
    messageIds: { type: 'array', items: { type: 'string' }, description: 'Original source message IDs from the context index.' },
    directiveIds: { type: 'array', items: { type: 'string' }, description: 'Constraint or decision IDs from the context index.' },
    query: { type: 'string', description: 'Literal text occurring in the original source.' },
    offset: { type: 'number', description: 'Character offset for another page of an original message.' },
    limit: { type: 'number', description: 'Maximum source messages, from 1 to 20.' },
    maxCharacters: { type: 'number', description: 'Total raw text budget, from 1 to 24000 characters.' },
  }, required: [], additionalProperties: false },
  schema: selectionSchema,
  async handler(input, context) {
    const task = await store.getTask(context.task.id, context.task.tenantId);
    if (!task || task.userId !== context.task.userId || task.sessionId !== context.task.sessionId) throw new Error('Context source task ownership is invalid.');
    const selection = selectionSchema.parse(input);
    const originalEvent = (await store.getEvents(task.id)).find((event) => event.type === 'task.created');
    const originalTurn = originalEvent?.payload.originalTurn as DurableContextSourceMessage | undefined;
    let messages: DurableContextSourceMessage[];
    let summary: PersistedContextSummary | undefined;
    if (task.templateId && (task.sessionId.startsWith('agent-nexus-') || originalEvent?.payload.source === 'agent-workflow')) {
      const history = await loadOwnedWorkflowConversation(store, task.templateId, task.tenantId, task.userId, task.createdAt);
      messages = history.messages;
      summary = history.summary;
    } else {
      const session = await store.getSession(task.sessionId, task.tenantId, task.userId);
      messages = session?.messages ?? [];
      summary = originalEvent?.payload.contextSummary as PersistedContextSummary | undefined ?? session?.contextSummary;
      if (originalTurn?.id && originalTurn.role === 'user' && typeof originalTurn.content === 'string') {
        const sourceIndex = messages.findIndex((message) => message.id === originalTurn.id);
        messages = sourceIndex >= 0 ? messages.slice(0, sourceIndex + 1) : [...messages, originalTurn];
      }
    }
    const result = retrieveContextSources(messages, summary?.structuredContext, selection);
    return { stdout: JSON.stringify({ ...result, scope: 'task-owner-conversation', taskId: task.id }), stderr: '', exitCode: 0, durationMs: 0, auditId: context.auditId };
  },
});
