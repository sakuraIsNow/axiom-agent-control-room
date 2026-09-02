import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const baseUrl = process.env.QA_URL ?? 'http://127.0.0.1:8787';
const codexConfigured = Boolean(process.env.CODEX_APP_SERVER_COMMAND?.trim() || process.env.CODEX_APP_SERVER_COMMAND_JSON?.trim());
const deepSeekConfigured = Boolean(process.env.DEEPSEEK_HARNESS_COMMAND?.trim() || process.env.DEEPSEEK_HARNESS_COMMAND_JSON?.trim());
const selected = codexConfigured ? 'codex' : deepSeekConfigured ? 'deepseek' : null;
const report = {
  suite: 'axiom-harness-sidecar-live-probe-v1',
  generatedAt: new Date().toISOString(),
  selected,
  status: selected ? 'running' : 'skipped',
  reason: selected ? undefined : '未配置 DeepSeek ACP 或 Codex app-server 可执行命令。',
  checks: {},
};

if (selected) {
  try {
    const response = await fetch(`${baseUrl}/api/runtime/capabilities`, { signal: AbortSignal.timeout(45_000) });
    const payload = await response.json().catch(() => null);
    const harness = payload?.harness;
    report.checks = {
      apiReachable: response.ok,
      selectedTransportMatches: harness?.kind === selected,
      commandConfigured: harness?.configured === true,
      protocolCompatible: harness?.compatible === true,
      executionExplicitlyActive: harness?.active === true,
      capabilitiesAdvertised: Array.isArray(harness?.capabilities) && harness.capabilities.length > 0,
    };
    report.harness = harness ?? null;
    report.status = Object.values(report.checks).every(Boolean) ? 'passed' : 'failed';
    if (report.status === 'failed') report.reason = harness?.reason ?? 'sidecar 能力握手未通过。';
  } catch (error) {
    report.status = 'failed';
    report.reason = error instanceof Error ? error.message : String(error);
  }
}

await writeFile(resolve(root, 'qa', 'harness-sidecar-probe-results.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(report, null, 2));
if (report.status === 'failed') process.exitCode = 1;
