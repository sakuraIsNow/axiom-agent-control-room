import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';
import { evaluateJevRoutingCase, jevRoutingCases, jevRoutingMeasurement, summarizeJevRoutingResults } from '../qa/lib/jev-routing-cases.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_REQUESTS = 30;
const CASE_TIMEOUT_MS = 10_000;
const SUITE_TIMEOUT_MS = 180_000;
const failure = (code) => Object.assign(new Error(code), { code });
const safeCodes = new Set(['CONFIG_INVALID', 'CREDENTIAL_UNAVAILABLE', 'REQUEST_LIMIT', 'CASE_REQUEST_LIMIT', 'CASE_DEADLINE', 'SUITE_DEADLINE', 'ENDPOINT_MISMATCH', 'provider-error', 'invalid-response', 'timeout', 'budget-exceeded']);
const safeErrorNames = new Set(['TypeError', 'ReferenceError', 'RangeError', 'SyntaxError', 'JevDecisionError', 'AbortError', 'TimeoutError', 'Error']);
const errorCode = (error, signal) => signal?.aborted ? (signal.reason?.code === 'SUITE_DEADLINE' ? 'SUITE_DEADLINE' : 'CASE_DEADLINE')
  : safeCodes.has(error?.code) ? error.code
    : error?.name === 'AbortError' || error?.name === 'TimeoutError' ? 'CASE_DEADLINE' : 'EVALUATION_ERROR';

async function settings() {
  let local = {};
  try { local = parse(await readFile(resolve(root, '.env.local'), 'utf8')); }
  catch (error) { if (error?.code !== 'ENOENT') throw failure('CONFIG_INVALID'); }
  const value = (name) => process.env[name] ?? local[name];
  let apiKey = value('TYPESAFE_API_KEY')?.trim();
  if (!apiKey && value('TYPESAFE_API_KEY_FILE')?.trim()) {
    try {
      apiKey = (await readFile(resolve(root, value('TYPESAFE_API_KEY_FILE').trim()), 'utf8')).trim().replace(/^\uFEFF/, '')
        .replace(/^(?:key|api[_ -]?key|TYPESAFE_API_KEY)\s*[:：]\s*/iu, '').trim();
      if ((apiKey.startsWith('"') && apiKey.endsWith('"')) || (apiKey.startsWith("'") && apiKey.endsWith("'"))) apiKey = apiKey.slice(1, -1).trim();
    } catch { throw failure('CREDENTIAL_UNAVAILABLE'); }
  }
  if (!apiKey || /\s/u.test(apiKey)) throw failure('CREDENTIAL_UNAVAILABLE');
  const model = value('TYPESAFE_MODEL')?.trim() || 'jev-1.13.0';
  const baseUrl = value('TYPESAFE_API_BASE')?.trim();
  const minConfidence = value('AXIOM_JEV_MIN_CONFIDENCE') === undefined ? undefined : Number(value('AXIOM_JEV_MIN_CONFIDENCE'));
  if (minConfidence !== undefined && (!Number.isFinite(minConfidence) || minConfidence < 0.5 || minConfidence > 1)) throw failure('CONFIG_INVALID');
  if (baseUrl) {
    let parsed;
    try { parsed = new URL(baseUrl); } catch { throw failure('CONFIG_INVALID'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw failure('CONFIG_INVALID');
  }
  return { apiKey, model, baseUrl, minConfidence };
}

async function main() {
  if (!process.argv.includes('--live')) {
    process.stderr.write('Explicit --live is required. This evaluation sends synthetic routing cases to the configured Jev API.\n');
    process.exitCode = 2;
    return;
  }
  const config = await settings();
  const fixtureDigest = createHash('sha256').update(JSON.stringify(jevRoutingCases)).digest('hex');
  const oracleDigest = createHash('sha256').update(await readFile(resolve(root, 'qa/lib/jev-routing-cases.mjs'))).digest('hex');
  const adapterSourceDigest = createHash('sha256').update(await readFile(resolve(root, 'server/runtime/jevDecisionRouter.ts'))).digest('hex');
  const { JevDecisionRouter } = await import('../server/runtime/jevDecisionRouter.ts');
  const originalFetch = globalThis.fetch;
  const startedAt = Date.now();
  const controller = new AbortController();
  const suiteTimer = setTimeout(() => controller.abort(failure('SUITE_DEADLINE')), SUITE_TIMEOUT_MS);
  let activeCase;
  let requests = 0;
  let permittedOrigin = config.baseUrl ? new URL(config.baseUrl).origin : null;
  const safeIdentifier = (value) => typeof value === 'string' && value !== config.apiKey && !value.includes(config.apiKey)
    && /^[a-zA-Z0-9._:/-]{1,160}$/u.test(value) ? value : 'unreported';
  const fetchImpl = async (input, init) => {
    if (!activeCase) throw failure('CASE_REQUEST_LIMIT');
    if (requests >= MAX_REQUESTS) throw failure('REQUEST_LIMIT');
    if (activeCase.requests >= 1) throw failure('CASE_REQUEST_LIMIT');
    const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
    permittedOrigin ??= url.origin;
    if (url.origin !== permittedOrigin) throw failure('ENDPOINT_MISMATCH');
    activeCase.requests += 1;
    requests += 1;
    const signals = [activeCase.signal, controller.signal, init?.signal].filter(Boolean);
    return originalFetch(input, { ...init, redirect: 'error', signal: AbortSignal.any(signals) });
  };
  const router = new JevDecisionRouter({ ...config, timeoutMs: CASE_TIMEOUT_MS, fetchImpl });
  const results = [];
  try {
    for (const item of jevRoutingCases) {
      if (controller.signal.aborted) {
        results.push({ id: item.id, outcome: 'error', violations: [], errorCode: 'SUITE_DEADLINE', attempted: false, requests: 0, durationMs: 0, actualModel: null, totalTokens: null });
        continue;
      }
      const caseStart = Date.now();
      const timeout = new AbortController();
      const caseTimer = setTimeout(() => timeout.abort(failure('CASE_DEADLINE')), CASE_TIMEOUT_MS);
      const signal = AbortSignal.any([controller.signal, timeout.signal]);
      activeCase = { requests: 0, signal };
      let row;
      let phase = 'evaluate';
      try {
        const result = await router.evaluate(structuredClone(item.input), signal);
        if (signal.aborted) throw signal.reason;
        phase = 'oracle';
        const judged = evaluateJevRoutingCase(item, result.decision);
        phase = 'measurement';
        const measurement = jevRoutingMeasurement(result, activeCase.requests, safeIdentifier);
        const knownReasons = ['low-confidence', 'complex-task', 'ambiguous', 'unsupported'];
        phase = 'selection';
        const selection = result.decision ? { intent: safeIdentifier(result.decision.intent), agentIds: result.decision.candidateAgentIds.map(safeIdentifier), requiresExternalFacts: result.decision.requiresExternalFacts } : null;
        row = { id: item.id, ...judged, ...measurement, durationMs: Date.now() - caseStart,
          abstentionReason: result.decision === null && knownReasons.includes(result.reason) ? result.reason : null,
          selection };
      } catch (error) {
        row = { id: item.id, outcome: 'error', violations: [], errorCode: errorCode(error, signal), phase,
          errorName: safeErrorNames.has(error?.name) ? error.name : 'unknown', attempted: activeCase.requests > 0,
          requests: activeCase.requests, durationMs: Date.now() - caseStart, actualModel: null, totalTokens: null };
      } finally { clearTimeout(caseTimer); activeCase = undefined; }
      results.push(row);
      process.stdout.write(`${row.id}: ${row.outcome} (${row.durationMs} ms)\n`);
    }
  } finally { clearTimeout(suiteTimer); }
  const summary = summarizeJevRoutingResults(results);
  const measured = results.filter((item) => item.totalTokens !== null);
  const durations = results.filter((item) => item.attempted).map((item) => item.durationMs).sort((left, right) => left - right);
  const percentile = (fraction) => durations.length ? durations[Math.ceil(durations.length * fraction) - 1] : null;
  const generatedAt = new Date().toISOString();
  const report = {
    schemaVersion: 1, generatedAt, suiteVersion: 'jev-routing-zh/v1', fixtureDigest, oracleDigest, adapterSourceDigest, requestedModel: safeIdentifier(config.model),
    methodology: 'One attempt per synthetic Chinese case; routing only, no user data, tools, task execution or fallback model calls. Abstentions remain abstentions and never count as correct selections. Selected precision and coverage are separate measurements; this small fixed suite does not establish general task accuracy or production readiness.',
    releaseConclusion: 'not-established-by-this-small-synthetic-suite',
    bounds: { maxRequests: MAX_REQUESTS, maxRequestsPerCase: 1, caseTimeoutMs: CASE_TIMEOUT_MS, suiteTimeoutMs: SUITE_TIMEOUT_MS },
    summary: { ...summary, requests, durationMs: Date.now() - startedAt, latencyMs: { p50: percentile(0.5), p95: percentile(0.95) },
      totalTokens: measured.length === results.length ? measured.reduce((sum, item) => sum + item.totalTokens, 0) : null,
      measuredTokens: measured.reduce((sum, item) => sum + item.totalTokens, 0), missingUsageCases: results.length - measured.length },
    results,
  };
  const output = resolve(root, 'qa', `jev-routing-${generatedAt.replace(/[:.]/gu, '-')}-${randomUUID().slice(0, 8)}-results.json`);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  process.stdout.write(`${JSON.stringify({ report: output, ...summary })}\n`);
  if (summary.acceptedWrong || summary.errors || !summary.acceptedCorrect) process.exitCode = 1;
}

await main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ errorCode: errorCode(error) })}\n`);
  process.exitCode = 2;
});
