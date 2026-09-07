import type { ProviderServiceSettings, ProviderSettings } from '../types';

export const sameProviderFields = (left: ProviderServiceSettings, right: ProviderServiceSettings) =>
  left.apiUrl === right.apiUrl && left.apiKey === right.apiKey && left.model === right.model && left.location === right.location;

export function invalidateEditedCredentials(previous: ProviderSettings, next: ProviderSettings): ProviderSettings {
  const result = { ...next };
  for (const kind of ['text', 'vision', 'image', 'video'] as const) {
    const before = previous[kind];
    const after = next[kind];
    if (before.credentialId && after.credentialId === before.credentialId && !sameProviderFields(before, after)) {
      // Never apply the old vault secret to an edited endpoint. Internet
      // providers require a new key; local unauthenticated providers can run.
      result[kind] = { ...after, credentialId: undefined,
        ...(before.apiUrl !== after.apiUrl && before.apiKey === after.apiKey ? { apiKey: '' } : {}) };
    }
  }
  return result;
}
