import { readFileSync, statSync } from 'node:fs';
import type { RoutingExecutionOptions } from './chatRouter.js';
import { JevDecisionRouter } from './jevDecisionRouter.js';

type DecisionMode = 'legacy' | 'jev-shadow' | 'jev-hybrid';
export type DecisionRoutingConfig = {
  options: RoutingExecutionOptions;
  status: {
    mode: DecisionMode; configured: boolean; ready: boolean; model: string;
    reason?: 'disabled' | 'missing-key' | 'invalid-config' | 'unreadable-key-file';
  };
};

/** Loaded once by the server, never from a browser-supplied routing payload. */
export const createDecisionRoutingConfig = (env: NodeJS.ProcessEnv = process.env): DecisionRoutingConfig => {
  const requested = env.AXIOM_DECISION_ROUTER?.trim() || 'legacy';
  const mode: DecisionMode = requested === 'jev-shadow' || requested === 'jev-hybrid' ? requested : 'legacy';
  const model = env.TYPESAFE_MODEL?.trim() || 'jev-1.13.0';
  const status: DecisionRoutingConfig['status'] = { mode, configured: false, ready: false, model };
  const unavailable = (reason: NonNullable<typeof status.reason>): DecisionRoutingConfig => ({ options: {}, status: { ...status, reason } });
  if (!['legacy', 'jev-shadow', 'jev-hybrid'].includes(requested)) return unavailable('invalid-config');
  if (mode === 'legacy') return unavailable('disabled');
  let apiKey = env.TYPESAFE_API_KEY?.trim() || '';
  if (!apiKey && env.TYPESAFE_API_KEY_FILE?.trim()) {
    try {
      const path = env.TYPESAFE_API_KEY_FILE.trim();
      if (statSync(path).size > 4_096) return unavailable('invalid-config');
      apiKey = readFileSync(path, 'utf8').replace(/^\uFEFF/, '').trim()
        .replace(/^key\s*[:\uFF1A=]\s*/i, '').trim().replace(/^['"]|['"]$/g, '');
    } catch { return unavailable('unreadable-key-file'); }
  }
  if (!apiKey) return unavailable('missing-key');
  const timeoutMs = Number(env.AXIOM_JEV_TIMEOUT_MS || 4_000);
  const minConfidence = Number(env.AXIOM_JEV_MIN_CONFIDENCE || 0.85);
  const baseUrl = env.TYPESAFE_API_BASE?.trim() || 'https://api.typesafe.ai';
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
      || model.length > 160 || !/^[a-zA-Z0-9._-]+$/.test(model)
      || /\s/.test(apiKey) || !apiKey.startsWith('apikey_')
      || !Number.isFinite(timeoutMs) || timeoutMs < 500 || timeoutMs > 10_000
      || !Number.isFinite(minConfidence) || minConfidence < 0.8 || minConfidence > 0.99) return unavailable('invalid-config');
    return {
      options: { decisionRouterMode: mode === 'jev-shadow' ? 'shadow' : 'hybrid',
        decisionRouter: new JevDecisionRouter({ apiKey, baseUrl, model, timeoutMs, minConfidence }) },
      status: { ...status, configured: true, ready: true },
    };
  } catch { return unavailable('invalid-config'); }
};
