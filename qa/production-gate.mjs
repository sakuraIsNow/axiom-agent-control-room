import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const configuredQaUrl = (process.env.QA_URL?.trim() || 'http://127.0.0.1:8787').replace(/\/$/, '');
process.env.QA_URL = configuredQaUrl;
process.env.AXIOM_API_ORIGIN ??= configuredQaUrl;
process.env.AXIOM_WEB_ORIGIN ??= configuredQaUrl;
process.env.AXIOM_API_BASE ??= configuredQaUrl;
process.env.QA_API ??= configuredQaUrl;
process.env.QA_URL_A ??= configuredQaUrl;
const alternateUrl = new URL(configuredQaUrl);
alternateUrl.hostname = alternateUrl.hostname === '127.0.0.1' ? 'localhost' : alternateUrl.hostname;
process.env.QA_URL_B ??= alternateUrl.toString().replace(/\/$/, '');
const acceptanceEnv = { ...process.env };
const baseEnv = { ...process.env };
for (const key of [
  'DATABASE_URL',
  'AXIOM_TEST_DATABASE_URL',
  'AXIOM_OBJECT_STORAGE_ENDPOINT',
  'AXIOM_OBJECT_STORAGE_BUCKET',
  'AXIOM_OBJECT_STORAGE_REGION',
  'AXIOM_OBJECT_STORAGE_PREFIX',
  'AXIOM_OBJECT_STORAGE_ACCESS_KEY',
  'AXIOM_OBJECT_STORAGE_SECRET_KEY',
  'AXIOM_OBJECT_STORAGE_SESSION_TOKEN',
  'AXIOM_OBJECT_STORAGE_FORCE_PATH_STYLE',
  'AXIOM_OBJECT_STORAGE_SSE',
]) delete baseEnv[key];
const checks = [
  ['静态检查', 'check'],
  ['单元与集成测试', 'test'],
  ['生产构建', 'build'],
  ['多格式报告导出', 'qa:report-export'],
  ['运行时 SSE 与 Artifact', 'qa:runtime'],
  ['聊天与多模态', 'qa:chat'],
  ['直达聊天流式重试', 'qa:direct-stream'],
  ['原生搜索 Agent', 'qa:search-agent'],
  ['会话路由', 'qa:session-routing'],
  ['会话持久化', 'qa:session-persistence'],
  ['持久上下文摘要', 'qa:context-summary'],
  ['租户隔离', 'qa:data-isolation'],
  ['任务删除', 'qa:task-delete'],
  ['人工审核', 'qa:human-review'],
  ['审核后交付结果回填', 'qa:review-delivery'],
  ['执行中实时引导', 'qa:live-guidance'],
  ['检查点分支与合并', 'qa:checkpoint'],
  ['运营观测', 'qa:operations'],
  ['Agent Nexus 工作流', 'qa:workflow'],
  ['工作流历史', 'qa:workflow-history'],
  ['Nexus 会话隔离', 'qa:nexus-session'],
  ['路由评估', 'qa:routing'],
  ['业务案例评估', 'qa:business'],
  ['MCP 业务评测', 'qa:mcp-business'],
  ['内网企业治理（配额、熔断、持久指标）', 'qa:governance'],
  ['3D Agent Graph', 'qa:agentgraph3d'],
  ['界面中英文回归', 'qa:i18n'],
  ['浏览器视觉回归', 'qa:visual'],
  ['并发性能基线', 'perf:smoke'],
];

const runOnce = (name, script, env = baseEnv) => new Promise((resolveResult) => {
  const startedAt = Date.now();
  const child = spawn(npm, ['run', script], {
    cwd: root,
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    windowsHide: true,
  });
  child.on('close', (code, signal) => resolveResult({
    name,
    script,
    status: code === 0 ? 'passed' : 'failed',
    code: code ?? 1,
    signal: signal ?? null,
    durationMs: Date.now() - startedAt,
  }));
  child.on('error', (error) => resolveResult({
    name,
    script,
    status: 'failed',
    code: 1,
    signal: null,
    durationMs: Date.now() - startedAt,
    error: error.message,
  }));
});

const run = async (name, script, env = baseEnv) => {
  const attempts = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    // A completed model task can leave short-lived worker cleanup in flight.
    // Retry one time so the gate distinguishes that transient from a stable
    // contract failure while retaining both outcomes in the report.
    // eslint-disable-next-line no-await-in-loop
    const result = await runOnce(name, script, env);
    attempts.push({ attempt, ...result });
    if (result.status === 'passed') return { ...result, attempts };
    if (attempt < 2) await new Promise((resolveResult) => setTimeout(resolveResult, 1_000));
  }
  const last = attempts.at(-1);
  return { ...last, attempts };
};

const results = [];
for (const [name, script] of checks) {
  // Keep the order deterministic: later checks depend on the same running API
  // and sequential execution prevents QA fixtures from racing each other.
  results.push(await run(name, script));
}

const businessPostgresUrl = (process.env.AXIOM_TEST_DATABASE_URL ?? '').trim();
if (businessPostgresUrl) {
  const postgresEnv = { ...acceptanceEnv, DATABASE_URL: businessPostgresUrl };
  results.push(await run('PostgreSQL 编译产物迁移', 'db:migrate', postgresEnv));
  results.push(await run('PostgreSQL 业务记录与凭据一致性', 'qa:business-postgres', acceptanceEnv));
  results.push(await run('PostgreSQL 多 Worker 故障接管', 'qa:postgres-failover', acceptanceEnv));
} else {
  results.push({
    name: 'PostgreSQL 编译产物迁移',
    script: 'db:migrate',
    status: 'skipped',
    reason: 'AXIOM_TEST_DATABASE_URL 未配置；发布包的编译后迁移入口未现场执行',
  });
  results.push({
    name: 'PostgreSQL 业务记录与凭据一致性',
    script: 'qa:business-postgres',
    status: 'skipped',
    reason: 'AXIOM_TEST_DATABASE_URL 未配置；SQLite 回归已执行，但 PostgreSQL 现场验收未执行',
  });
  results.push({
    name: 'PostgreSQL 多 Worker 故障接管',
    script: 'qa:postgres-failover',
    status: 'skipped',
    reason: 'AXIOM_TEST_DATABASE_URL 未配置；跨进程崩溃、租约接管和幂等终态未演练',
  });
}

const memoryEndpoint = (process.env.TDAI_MEMORY_ENDPOINT ?? '').trim();
if (memoryEndpoint) {
  results.push(await run('MemoryCore HTTP 真实验收', 'qa:memorycore', acceptanceEnv));
  results.push(await run('MemoryCore Axiom 适配器验收', 'qa:memorycore-adapter', acceptanceEnv));
} else {
  results.push({
    name: 'MemoryCore HTTP 真实验收',
    script: 'qa:memorycore',
    status: 'skipped',
    reason: 'TDAI_MEMORY_ENDPOINT 未配置',
  });
  results.push({
    name: 'MemoryCore Axiom 适配器验收',
    script: 'qa:memorycore-adapter',
    status: 'skipped',
    reason: 'TDAI_MEMORY_ENDPOINT 未配置',
  });
}

const objectStorageEndpoint = (process.env.AXIOM_OBJECT_STORAGE_ENDPOINT ?? '').trim();
if (objectStorageEndpoint) {
  results.push(await run('Artifact 外部存储真实验收', 'qa:object-storage', acceptanceEnv));
} else {
  results.push({
    name: 'Artifact 外部存储真实验收',
    script: 'qa:object-storage',
    status: 'skipped',
    reason: 'AXIOM_OBJECT_STORAGE_ENDPOINT 未配置',
  });
}

const harnessSidecarConfigured = Boolean(
  process.env.DEEPSEEK_HARNESS_COMMAND?.trim()
  || process.env.DEEPSEEK_HARNESS_COMMAND_JSON?.trim()
  || process.env.CODEX_APP_SERVER_COMMAND?.trim()
  || process.env.CODEX_APP_SERVER_COMMAND_JSON?.trim(),
);
if (harnessSidecarConfigured) {
  results.push(await run('Harness sidecar 真实能力握手', 'qa:harness-live', acceptanceEnv));
} else {
  results.push({
    name: 'Harness sidecar 真实能力握手',
    script: 'qa:harness-live',
    status: 'skipped',
    reason: '未配置 DeepSeek ACP 或 Codex app-server 可执行命令',
  });
}

const summary = {
  generatedAt: new Date().toISOString(),
  status: results.some((result) => result.status === 'failed') ? 'failed' : 'passed',
  passed: results.filter((result) => result.status === 'passed').length,
  failed: results.filter((result) => result.status === 'failed').length,
  skipped: results.filter((result) => result.status === 'skipped').length,
  results,
};
await writeFile(resolve(root, 'qa', 'production-gate-results.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(summary, null, 2));
if (summary.failed > 0) process.exitCode = 1;
