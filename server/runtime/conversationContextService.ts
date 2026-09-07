import { buildContextWindow, buildPersistedContextSummary, estimateTokens, validatePersistedContextSummary, type ContextMessage, type ContextWindowOptions, type DurableContextSourceMessage, type PersistedContextSummary } from './contextSummary.js';
import { boundPinnedContext, enrichStructuredContext, renderStructuredContext, retrieveContextSources, validateStructuredContext } from './structuredContext.js';
import type { ModelClient } from './modelClient.js';
import type { TaskStore } from './contracts.js';

export const loadOwnedWorkflowConversation = async (store: TaskStore, workflowId: string, tenantId: string, userId: string, through?: string) => {
  if (!store.listTasksByTemplate) throw new Error('Complete workflow history lookup is unavailable.');
  const tasks = (await store.listTasksByTemplate(tenantId, workflowId))
    .filter((task) => task.userId === userId && !task.sessionId.startsWith('agent-nexus-test-') && (!through || task.createdAt <= through));
  const turns = [];
  for (const task of tasks) {
    const created = (await store.getEvents(task.id)).find((event) => event.type === 'task.created');
    const sourceTime = created?.payload.sourceTaskCreatedAt;
    turns.push({ task, created, sourceTime: typeof sourceTime === 'string' && Number.isFinite(Date.parse(sourceTime)) ? sourceTime : task.createdAt });
  }
  turns.sort((left, right) => left.sourceTime.localeCompare(right.sourceTime) || left.task.createdAt.localeCompare(right.task.createdAt) || left.task.id.localeCompare(right.task.id));
  const messages: DurableContextSourceMessage[] = [];
  const sourceIds = new Set<string>();
  let summary: PersistedContextSummary | undefined;
  for (const { task, created } of turns) {
    const original = created?.payload.originalTurn as { id?: unknown; role?: unknown; content?: unknown } | undefined;
    if (original?.role === 'user' && typeof original.id === 'string' && typeof original.content === 'string') {
      if (!sourceIds.has(original.id)) messages.push({ id: original.id, role: 'user', content: original.content });
      sourceIds.add(original.id);
    }
    else {
      const matches = [...task.input.matchAll(/(?:^|\n\n)USER:\n([\s\S]*?)(?=\n\n(?:USER|ASSISTANT):\n|$)/gi)];
      messages.push({ id: `${task.id}-user`, role: 'user', content: (matches.at(-1)?.[1] ?? task.input).trim() });
    }
    const output = task.result || (task.error ? `Agent Nexus execution failed: ${task.error}` : '');
    if (output) messages.push({ id: `${task.id}-assistant`, role: 'assistant', content: output, taskId: task.id });
    if (created?.payload.contextSummary && typeof created.payload.contextSummary === 'object') summary = created.payload.contextSummary as PersistedContextSummary;
  }
  return { messages, summary };
};

export const enrichConversationSummary = async (
  summary: PersistedContextSummary | null,
  messages: DurableContextSourceMessage[],
  previous: PersistedContextSummary | undefined,
  model: ModelClient | undefined,
  signal: AbortSignal,
) => {
  if (!summary) return null;
  const covered = messages.filter((message) => summary.coveredMessageIds.includes(message.id));
  const prior = summary.structuredContext ?? previous?.structuredContext;
  const validPrior = validateStructuredContext(prior, covered) ? prior : undefined;
  if (!model) {
    const { structuredContext: _discarded, ...deterministic } = summary;
    return { ...deterministic, ...(validPrior ? { structuredContext: {
      ...validPrior,
      status: validPrior.coveredMessageIds.length === covered.length ? validPrior.status : 'partial' as const,
      pendingMessageIds: covered.slice(validPrior.coveredMessageIds.length, validPrior.coveredMessageIds.length + 32).map((message) => message.id),
      pendingMessageCount: covered.length - validPrior.coveredMessageIds.length,
    } } : {}) };
  }
  if (validPrior?.status === 'complete' && validPrior.coveredMessageIds.length === covered.length) return { ...summary, structuredContext: validPrior };
  return { ...summary, structuredContext: await enrichStructuredContext(covered, validPrior, model, signal) };
};

export const buildSourceContextWindow = (
  messages: DurableContextSourceMessage[],
  summary: PersistedContextSummary | undefined | null,
  options: ContextWindowOptions = {},
) => {
  const valid = validatePersistedContextSummary(summary ?? undefined, messages);
  if (!valid || !summary) return buildContextWindow<ContextMessage>(messages, options);
  const structured = validateStructuredContext(summary.structuredContext, messages) ? summary.structuredContext : undefined;
  const ledger = renderStructuredContext(structured, Math.min(6_000, Math.floor((options.maxCharacters ?? 48_000) / 3)));
  const latest = messages.at(-1);
  const latestText = typeof latest?.content === 'string' ? latest.content : '';
  const explicitSources = latestText ? retrieveContextSources(messages.slice(0, summary.coveredMessageIds.length), structured, {
    directiveIds: structured?.entries.filter((entry) => latestText.includes(`[${entry.id}]`)).map((entry) => entry.id),
    messageIds: summary.coveredMessageIds.filter((id) => latestText.includes(`[source:${id}]`)),
    maxCharacters: 4_000,
  }) : { sources: [] };
  const rawSources = explicitSources.sources.map((source) => `[Original message ${source.messageId}, sha256 ${source.digest}]\n${source.content}`).join('\n\n');
  const recent = messages.slice(summary.coveredMessageIds.length);
  const tokenCounter = options.tokenizer ?? estimateTokens;
  const pinned = boundPinnedContext([ledger, rawSources].filter(Boolean).join('\n\n'), Math.floor((options.maxCharacters ?? 48_000) / 3), Math.floor((options.maxTokens ?? 12_000) / 3), tokenCounter);
  const bounded = buildContextWindow<ContextMessage>([{ role: 'assistant', content: summary.content }, ...recent], {
    ...options,
    maxCharacters: Math.max(1, (options.maxCharacters ?? 48_000) - pinned.length),
    maxTokens: Math.max(1, (options.maxTokens ?? 12_000) - tokenCounter(pinned)),
    maxMessages: Math.max(2, (options.maxMessages ?? 24) - (pinned ? 1 : 0)),
  });
  return {
    ...bounded,
    messages: pinned ? [{ role: 'assistant' as const, content: pinned }, ...bounded.messages] : bounded.messages,
    summaryApplied: true,
    summarizedMessages: summary.coveredMessageIds.length + bounded.summarizedMessages,
    summaryCharacters: summary.content.length + pinned.length,
    estimatedTokens: bounded.estimatedTokens + tokenCounter(pinned),
    summaryVersion: `${summary.algorithm}@${summary.version}`,
    summaryCoverage: { start: 0, end: summary.coveredMessageIds.length - 1, total: messages.length },
  };
};

export const prepareConversationContext = async (
  sessionId: string,
  messages: DurableContextSourceMessage[],
  previous: PersistedContextSummary | undefined,
  model: ModelClient | undefined,
  signal: AbortSignal,
  options: ContextWindowOptions = {},
) => {
  const summary = await enrichConversationSummary(buildPersistedContextSummary(sessionId, messages, previous, options), messages, previous, model, signal);
  return { summary, window: buildSourceContextWindow(messages, summary, options) };
};
