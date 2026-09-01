import type { RuntimeEvent, RuntimeEventSource } from './contracts.js';

/**
 * Normalize entrypoint labels at the persistence boundary. Payloads are kept
 * backward compatible, while the durable context uses a small, controlled
 * vocabulary that operations and replay tooling can aggregate safely.
 */
export const runtimeSourceFromPayload = (source: unknown): RuntimeEventSource => {
  if (source === 'external-harness' || source === 'external-harness-recovery' || source === 'external-harness-resume') return 'harness';
  if (source === 'plugin') return 'plugin';
  if (source === 'agent-nexus' || source === 'agent-workflow') return 'agent-nexus';
  if (source === 'schedule') return 'schedule';
  if (source === 'webhook') return 'webhook';
  if (source === 'conversation') return 'conversation';
  if (source === 'builtin') return 'builtin';
  return 'api';
};

export const runtimeEventSource = (event: Pick<RuntimeEvent, 'payload'>) => (
  runtimeSourceFromPayload(event.payload.source)
);
