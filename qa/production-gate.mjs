import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const checks = [
  ['静态检查', 'check'],
  ['单元与集成测试', 'test'],
  ['生产构建', 'build'],
  ['运行时 SSE 与 Artifact', 'qa:runtime'],
  ['聊天与多模态', 'qa:chat'],
  ['直达聊天流式重试', 'qa:direct-stream'],
  ['原生搜索 Agent', 'qa:search-agent'],
  ['会话路由', 'qa:session-routing'],
  ['会话持久化', 'qa:session-persistence'],
  ['租户隔离', 'qa:data-isolation'],
  ['任务删除', 'qa:task-delete'],
  ['人工审核', 'qa:human-review'],
  ['执行中实时引导', 'qa:live-guidance'],
  ['运营观测', 'qa:operations'],
  ['Agent Nexus 工作流', 'qa:workflow'],
  ['工作流历史', 'qa:workflow-history'],
  ['Nexus 会话隔离', 'qa:nexus-session'],
  ['路由评估', 'qa:routing'],
  ['业务案例评估', 'qa:business'],
  ['3D Agent Graph', 'qa:agentgraph3d'],
  ['浏览器视觉回归', 'qa:visual'],
  ['并发性能基线', 'perf:smoke'],
];

const runOnce = (name, script) => new Promise((resolveResult) => {
  const startedAt = Date.now();
  const child = spawn(npm, ['run', script], {
    cwd: root,
    env: process.env,
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

const run = async (name, script) => {
  const attempts = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    // A completed model task can leave short-lived worker cleanup in flight.
    // Retry one time so the gate distinguishes that transient from a stable
    // contract failure while retaining both outcomes in the report.
    // eslint-disable-next-line no-await-in-loop
    const result = await runOnce(name, script);
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

const memoryEndpoint = (process.env.TDAI_MEMORY_ENDPOINT ?? '').trim();
if (memoryEndpoint) {
  results.push(await run('MemoryCore HTTP 真实验收', 'qa:memorycore'));
  results.push(await run('MemoryCore Axiom 适配器验收', 'qa:memorycore-adapter'));
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
  results.push(await run('Artifact 外部存储真实验收', 'qa:object-storage'));
} else {
  results.push({
    name: 'Artifact 外部存储真实验收',
    script: 'qa:object-storage',
    status: 'skipped',
    reason: 'AXIOM_OBJECT_STORAGE_ENDPOINT 未配置',
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
