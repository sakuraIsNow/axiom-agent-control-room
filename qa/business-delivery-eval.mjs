import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { offlineEnvironment } from '../scripts/ci-quality-gate.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const safeEnvironment = offlineEnvironment();
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, safeEnvironment, { AXIOM_MAX_AUTO_REPLANS: '0', AGENT_REQUIRE_REVIEW_APPROVAL: 'true', AGENT_SYNTHESIS_MAX_CONTINUATIONS: '1', AXIOM_TOOL_EXECUTOR: 'docker' });
const previousDirectory = process.cwd();
const scratch = await mkdtemp(join(tmpdir(), 'axiom-business-delivery-suite-'));
process.chdir(scratch);
const { digest, fixture, evidence } = await import('./business-delivery/helpers.mjs');
const { reportDocumentCases } = await import('./business-delivery/reports-documents.mjs');
const { artifactPluginCases } = await import('./business-delivery/artifacts-plugins.mjs');
const { nexusRecoveryCases } = await import('./business-delivery/nexus-recovery.mjs');
const cases = [...reportDocumentCases, ...artifactPluginCases, ...nexusRecoveryCases];
assert.equal(cases.length, 24);
assert.equal(new Set(cases.map((item) => item.id)).size, cases.length);
const originalFetch = globalThis.fetch;
let blockedRequests = 0;
globalThis.fetch = async () => { blockedRequests += 1; throw new Error('External requests are disabled in deterministic delivery acceptance.'); };
const startedAt = new Date().toISOString();
const results = [];
try {
  for (const scenario of cases) {
    const start = performance.now();
    const context = await fixture(scenario.id);
    let entry;
    try {
      const details = await scenario.run(context);
      entry = { id: scenario.id, domain: scenario.domain, expected: scenario.expected, attempt: 1, passed: true, ...details };
    } catch (error) {
      entry = { id: scenario.id, domain: scenario.domain, expected: scenario.expected, attempt: 1, passed: false, error: error instanceof Error ? error.stack : String(error), ...evidence(context) };
    } finally {
      try { await context.close(); } catch (error) { entry = { ...entry, passed: false, cleanupError: String(error) }; }
    }
    entry.durationMs = Math.round((performance.now() - start) * 100) / 100;
    results.push(entry);
    console.log(`${entry.passed ? 'PASS' : 'FAIL'} ${entry.id} (${entry.durationMs}ms)${entry.error ? `\n${entry.error}` : ''}`);
  }
} finally {
  globalThis.fetch = originalFetch;
  process.chdir(previousDirectory);
  const child = relative(resolve(tmpdir()), resolve(scratch));
  assert.ok(child.startsWith('axiom-business-delivery-suite-') && !child.includes('..') && !child.includes('/') && !child.includes('\\'));
  await rm(scratch, { recursive: true, force: true });
}
assert.equal(blockedRequests, 0, 'No case may attempt an external model or tool request.');
const report = {
  schemaVersion: 1, suite: 'business-delivery-v1', startedAt, finishedAt: new Date().toISOString(),
  caseManifestDigest: digest(cases.map(({ id, domain, expected }) => ({ id, domain, expected }))),
  environment: 'isolated-local-sqlite-runtime-and-api-with-authored-model-fixtures',
  methodology: 'Executes actual report APIs, document parsers, orchestrator, tool ledger/artifact catalog, mini-app persistence and compiled Nexus graphs. Exact authored business assertions; no wrapped test-suite subprocesses, whole-suite retry or external requests.',
  limitations: ['Not a real-model success rate or live search/source verification.', 'Plugin cases cover durable release/edit contracts, not model coding ability or interactive browser gameplay.',
    'HTML/SVG cases cover exact downloadable artifact delivery; browser rendering is covered by separate visual QA.', 'Oracle rejection of a seeded wrong citation is not automatic runtime factual validation.',
    'Restart cases reopen actual SQLite stores and create new runtime objects; OS crashes and multi-worker failover require separate gates.'],
  summary: { cases: results.length, passed: results.filter((item) => item.passed).length, failed: results.filter((item) => !item.passed).length,
    attempts: results.length, fixtureModelCalls: results.reduce((sum, item) => sum + item.modelCalls, 0), externalRequests: 0, realModelTokens: null, realModelCost: null,
    domains: Object.fromEntries([...new Set(cases.map((item) => item.domain))].map((domain) => [domain, { cases: results.filter((item) => item.domain === domain).length, passed: results.filter((item) => item.domain === domain && item.passed).length }])) },
  results,
};
await mkdir(resolve(root, 'qa'), { recursive: true });
const timestamp = startedAt.replaceAll(':', '-').replaceAll('.', '-');
const archivedPath = resolve(root, `qa/business-delivery-${timestamp}-results.json`);
await writeFile(archivedPath, `${JSON.stringify(report, null, 2)}\n`);
await writeFile(resolve(root, 'qa/business-delivery-results.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({ suite: report.suite, summary: report.summary, archivedPath }, null, 2));
if (report.summary.failed) process.exitCode = 1;
