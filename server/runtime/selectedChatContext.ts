import { buildPersistedContextSummary, type DurableContextSourceMessage, type PersistedContextSummary } from './contextSummary.js';
import { enrichConversationSummary } from './conversationContextService.js';
import { OpenAICompatibleModelClient } from './modelClient.js';

export const prepareSelectedChatSummary = async (
  sessionId: string,
  messages: DurableContextSourceMessage[],
  previous: PersistedContextSummary | undefined,
  provider: { apiKey: string; baseUrl: string; model: string; location: 'internet' | 'local' },
  signal: AbortSignal,
) => {
  const summary = buildPersistedContextSummary(sessionId, messages, previous);
  if (!summary) return null;
  // This client is derived only from the owner-validated conversation provider.
  // An unavailable selected model must never send history to a default service.
  const model = new OpenAICompatibleModelClient({
    apiKey: provider.apiKey, apiBase: provider.baseUrl, model: provider.model,
    apiKeyOptional: provider.location === 'local', maxAttempts: 1, timeoutMs: 20_000,
  });
  return enrichConversationSummary(summary, messages, previous, model, signal);
};
