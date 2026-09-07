import { OpenAICompatibleModelClient } from './modelClient.js';
import type { ProviderBindingOwner, ProviderBindingStore } from './providerBindings.js';

export const createBoundTextModel = async (bindings: ProviderBindingStore, owner: ProviderBindingOwner, onUsage?: (usage?: Record<string, number>) => void) => {
  const provider = await bindings.resolve(owner, 'text');
  if (!provider) throw new Error('The text provider pinned to this task was not configured.');
  return new OpenAICompatibleModelClient({ apiKey: provider.apiKey, apiBase: provider.baseUrl, model: provider.model,
    apiKeyOptional: provider.location === 'local', onUsage });
};
