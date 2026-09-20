import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Explicit opt-in: ordinary local QA must not silently incur provider charges.
if (process.argv.length !== 3 || process.argv[2] !== '--live') {
  console.error('Usage: node --import tsx scripts/improvement-live-eval.mjs --live');
  console.error('Runs up to 10 paid, tool-free model requests on synthetic text only. No existing task or conversation is read.');
  process.exitCode = 2;
} else {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const { config } = await import('dotenv');
  // Match server priority: inherited environment > .env.local > .env.
  config({ path: resolve(root, '.env.local'), quiet: true });
  config({ path: resolve(root, '.env'), quiet: true });
  const { OpenAICompatibleModelClient } = await import('../server/runtime/modelClient.ts');
  const { defaultProviderLocation } = await import('../server/runtime/providerLocation.ts');
  const { improvementFixtures, improvementEvaluationSuite, runImprovementArm, summarizeImprovementEvaluation,
    EVALUATION_TIMEOUT_MS, EVALUATION_CALL_TIMEOUT_MS } = await import('../server/runtime/improvementEvaluation.ts');
  const redact = (value, maximum = 16_000) => value
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,})\b/g, '[redacted-key]')
    .replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer [redacted]')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|authorization)["']?\s*[:=]\s*["']?)[^\s,;"'}]+/gi, '$1[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted-token]')
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[redacted-url]').slice(0, maximum);
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim() ?? '';
  const apiBase = process.env.DEEPSEEK_API_BASE ?? 'https://api.deepseek.com';
  const model = process.env.DEEPSEEK_MODEL ?? 'deepseek-chat';
  const local = defaultProviderLocation(apiBase) === 'local';
  // Fixed neutral guidance, not a candidate trained on these cases or their answers.
  const guidance = 'Before finalizing, check every requested output field against the supplied evidence. Recalculate any derived values. Apply the latest user instruction and mark unsupported conclusions as unsupported. Preserve authorization boundaries and do not claim actions you did not perform.';
  const generatedAt = new Date().toISOString();
  const startedAt = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Comparison time limit expired.')), EVALUATION_TIMEOUT_MS);
  const abort = () => controller.abort(new Error('Comparison interrupted by operator.'));
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  const cases = improvementFixtures.map(({ id: fixtureId, title, scope }) => ({ fixtureId, title, scope }));
  const originalFetch = globalThis.fetch;
  let modelCalls = 0;
  let providerRequests = 0;
  let error;
  try {
    if (!apiKey && !local) throw new Error('The default internet text-model credential is not configured.');
    const provider = new OpenAICompatibleModelClient({ apiKey, apiBase, model, apiKeyOptional: local, maxAttempts: 1, timeoutMs: EVALUATION_CALL_TIMEOUT_MS });
    const client = { model: provider.model, async complete(request) {
      if (modelCalls >= improvementEvaluationSuite.modelCalls) throw new Error('Comparison request cap reached.');
      modelCalls += 1;
      return provider.complete({ ...request, maxAttempts: 1 });
    } };
    globalThis.fetch = async (input, init) => {
      if (providerRequests >= improvementEvaluationSuite.modelCalls) throw new Error('Provider request cap reached.');
      providerRequests += 1;
      // No redirect chain or implicit retry can exceed the explicit provider budget.
      return originalFetch(input, { ...init, redirect: 'error' });
    };
    for (const [index, fixture] of improvementFixtures.entries()) {
      for (const arm of index % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
        if (controller.signal.aborted) break;
        cases[index][arm] = await runImprovementArm({ client, fixture, ...(arm === 'candidate' ? { guidance } : {}), signal: controller.signal, redact });
        console.log(`${index + 1}/${cases.length} ${arm}: ${cases[index][arm].status}`);
      }
      if (controller.signal.aborted) break;
    }
  } catch {
    // Provider errors/configuration strings can contain endpoints and credentials.
    error = 'The live comparison could not complete. Check the configured default text model; no task, tool or policy was changed.';
  } finally {
    clearTimeout(timer);
    globalThis.fetch = originalFetch;
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
    controller.abort();
  }
  const complete = cases.every((entry) => entry.baseline?.status === 'completed' && entry.candidate?.status === 'completed');
  const scored = summarizeImprovementEvaluation(cases, true);
  const report = {
    generatedAt, completedAt: new Date().toISOString(), passed: complete, model: redact(model, 160),
    suiteId: improvementEvaluationSuite.id, suiteVersion: improvementEvaluationSuite.version, suiteDigest: improvementEvaluationSuite.digest,
    methodology: 'One baseline/candidate pair per fixed synthetic text contract. Same model, temperature and schema; fixed neutral candidate guidance, deterministic server-side checks, no self-score. This command never reads existing task/history/plugin/workspace data or invokes tools. Re-running produces a separate observation, not a replacement for previous failures.',
    guidance, limits: { modelCalls: improvementEvaluationSuite.modelCalls, providerAttemptsPerCall: 1, outputTokensPerCall: improvementEvaluationSuite.maxOutputTokensPerCall, timeoutMs: EVALUATION_TIMEOUT_MS },
    modelCalls, providerRequests, elapsedMs: Math.round(performance.now() - startedAt), ...scored,
    limitations: [...improvementEvaluationSuite.limitations, 'The guidance in this live smoke check is neutral test guidance, not a user proposal. Success means the comparison completed, not that quality improved. HTTP failures can incur unreported provider usage; missing usage remains null.'],
    ...(error ? { error } : {}), cases,
  };
  await mkdir(resolve(root, 'qa'), { recursive: true });
  const content = `${JSON.stringify(report, null, 2)}\n`;
  const archiveName = `improvement-live-eval-${generatedAt.replace(/[:.]/g, '-')}-results.json`;
  await writeFile(resolve(root, 'qa/improvement-live-eval-results.json'), content);
  await writeFile(resolve(root, 'qa', archiveName), content);
  // Keep console output concise and free of configured URLs and raw model output.
  console.log(JSON.stringify({ passed: report.passed, model: report.model, modelCalls, providerRequests,
    elapsedMs: report.elapsedMs, qualityStatus: report.qualityStatus, summary: report.summary,
    results: 'qa/improvement-live-eval-results.json', archivedResults: `qa/${archiveName}` }, null, 2));
  if (!complete) process.exitCode = 1;
}
