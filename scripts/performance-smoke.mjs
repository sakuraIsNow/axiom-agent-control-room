import { mkdir, writeFile } from 'node:fs/promises';

const baseUrl = (process.env.AXIOM_API_ORIGIN ?? process.env.QA_URL ?? 'http://127.0.0.1:8787').replace(/\/$/, '');
const count = Math.min(1_000, Math.max(1, Number(process.env.AXIOM_PERF_REQUESTS ?? 50)));
const concurrency = Math.min(100, Math.max(1, Number(process.env.AXIOM_PERF_CONCURRENCY ?? 10)));
const headers = {
  Accept: 'application/json',
  ...(process.env.QA_API_KEY ? { Authorization: `Bearer ${process.env.QA_API_KEY}` } : {}),
  'x-axiom-tenant-id': 'performance-smoke',
  'x-axiom-user-id': 'performance-smoke',
};

const percentile = (values, p) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Number(sorted[index].toFixed(2));
};

const runBatch = async (path, total, workers) => {
  const samples = [];
  let cursor = 0;
  const startedAt = performance.now();
  const worker = async () => {
    while (true) {
      const index = cursor++;
      if (index >= total) return;
      const started = performance.now();
      let status = 0;
      let error;
      try {
        const response = await fetch(`${baseUrl}${path}`, { headers, signal: AbortSignal.timeout(15_000) });
        status = response.status;
        await response.arrayBuffer();
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
      }
      samples.push({ durationMs: performance.now() - started, status, error });
    }
  };
  await Promise.all(Array.from({ length: Math.min(total, workers) }, worker));
  const durationMs = performance.now() - startedAt;
  const durations = samples.map((sample) => sample.durationMs);
  const errors = samples.filter((sample) => sample.error || sample.status < 200 || sample.status >= 300);
  return {
    requests: total,
    concurrency: workers,
    durationMs: Number(durationMs.toFixed(2)),
    throughputRps: Number((total / Math.max(0.001, durationMs / 1_000)).toFixed(2)),
    status: Object.fromEntries([...new Set(samples.map((sample) => sample.status))].sort().map((code) => [code || 'error', samples.filter((sample) => sample.status === code).length])),
    errors: errors.slice(0, 5).map(({ status, error }) => ({ status, error })),
    latencyMs: {
      p50: percentile(durations, 50),
      p95: percentile(durations, 95),
      p99: percentile(durations, 99),
      max: Number(Math.max(...durations, 0).toFixed(2)),
    },
  };
};

const endpoints = [
  { id: 'health', path: '/api/health' },
  { id: 'readiness', path: '/api/runtime/readiness' },
  { id: 'operations', path: '/api/runtime/operations?hours=24' },
  { id: 'tasks', path: '/api/tasks?limit=100' },
];

// Warm the server once so the report measures steady-state request behavior.
await fetch(`${baseUrl}/api/health`, { headers, signal: AbortSignal.timeout(15_000) }).catch(() => undefined);
const results = {};
for (const endpoint of endpoints) {
  results[endpoint.id] = {
    sequential: await runBatch(endpoint.path, count, 1),
    concurrent: await runBatch(endpoint.path, count, concurrency),
  };
}

const report = {
  generatedAt: new Date().toISOString(),
  baseUrl,
  requests: count,
  concurrency,
  results,
};
await mkdir('qa', { recursive: true });
await writeFile('qa/performance-results.json', `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(report, null, 2));
if (Object.values(results).some((result) => result.sequential.errors.length || result.concurrent.errors.length)) process.exitCode = 1;
