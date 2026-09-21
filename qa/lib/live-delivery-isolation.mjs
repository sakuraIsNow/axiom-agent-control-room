import { offlineEnvironment } from '../../scripts/ci-quality-gate.mjs';

export function liveProviderOrigin(apiBase) {
  try {
    const url = new URL(apiBase);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error();
    return url.origin;
  } catch { throw new Error('Live delivery model URL must be an HTTP(S) URL without embedded credentials.'); }
}

// Credentials are deliberately absent: the live runner passes the chosen
// provider directly to its bounded ModelClient, never through ambient defaults.
export function liveDeliveryEnvironment(input = process.env) {
  return {
    ...offlineEnvironment(input),
    AXIOM_MAX_AUTO_REPLANS: '0',
    AGENT_REVIEW_CORRECTION_ROUNDS: '0',
    AGENT_SYNTHESIS_MAX_CONTINUATIONS: '1',
    AGENT_STEP_MAX_ATTEMPTS: '1',
    AGENT_REQUIRE_REVIEW_APPROVAL: 'true',
    AXIOM_PRINCIPAL_SECRET: '',
    AXIOM_TRUST_PROXY_AUTH: 'false',
    AXIOM_TOOL_EXECUTOR: 'disabled',
    DEEPSEEK_NATIVE_SEARCH: 'false',
    DEEPSEEK_FILES_API: 'false',
  };
}
