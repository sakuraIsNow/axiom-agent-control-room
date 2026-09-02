import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const baseUrl = process.env.QA_URL ?? 'http://127.0.0.1:8787';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const reportPath = resolve(root, 'qa', 'business-eval-results.json');
const cases = JSON.parse(await readFile(new URL('./business-cases.json', import.meta.url), 'utf8'));
const startedAt = new Date().toISOString();

const report = {
  suite: 'axiom-runtime-business-eval-v2',
  methodology: 'HarnessEval-W inspired segmented validation',
  startedAt,
  completedAt: null,
  status: 'running',
  metadata: {
    baseUrl,
    node: process.version,
    dimensions: [
      'transition-correctness',
      'drift-resistance',
      'selective-routing',
      'artifact-boundary',
      'return-revisit-consistency',
      'concurrency-conflict-safety',
    ],
  },
  partialProgress: [],
  segments: [],
  summary: { passed: 0, failed: 0, total: 0, accuracy: 0 },
};

const persist = async () => {
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
};

const compactOutput = (value) => value
  .split(/\r?\n/)
  .filter((line) => line.trim())
  .slice(-30)
  .join('\n')
  .slice(-8_000);

const runNodeTest = ({ file, pattern }) => new Promise((resolveResult) => {
  const probeStartedAt = Date.now();
  const args = ['--import', 'tsx', '--test', '--test-reporter=tap', `--test-name-pattern=${pattern}`, file];
  const child = spawn(process.execPath, args, {
    cwd: root,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  const timeout = setTimeout(() => child.kill(), 120_000);
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  child.once('close', (code, signal) => {
    clearTimeout(timeout);
    const pass = Number(stdout.match(/# pass (\d+)/)?.[1] ?? 0);
    const fail = Number(stdout.match(/# fail (\d+)/)?.[1] ?? 0);
    resolveResult({
      file,
      pattern,
      passed: code === 0 && pass > 0 && fail === 0,
      assertions: pass,
      failures: fail,
      code: code ?? 1,
      signal: signal ?? null,
      durationMs: Date.now() - probeStartedAt,
      output: compactOutput(`${stdout}\n${stderr}`),
    });
  });
  child.once('error', (error) => {
    clearTimeout(timeout);
    resolveResult({
      file,
      pattern,
      passed: false,
      assertions: 0,
      failures: 1,
      code: 1,
      signal: null,
      durationMs: Date.now() - probeStartedAt,
      output: error.message,
    });
  });
});

const recordSegment = async (segment) => {
  report.segments.push(segment);
  report.partialProgress.push({
    segmentId: segment.id,
    status: segment.passed ? 'passed' : 'failed',
    completedAt: new Date().toISOString(),
    artifactValidation: segment.artifactValidation,
  });
  report.summary.total = report.segments.length;
  report.summary.passed = report.segments.filter((item) => item.passed).length;
  report.summary.failed = report.summary.total - report.summary.passed;
  report.summary.accuracy = report.summary.total ? report.summary.passed / report.summary.total : 0;
  await persist();
};

await persist();

const routingResults = [];

for (const item of cases) {
  try {
    const response = await fetch(`${baseUrl}/api/runtime/triage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: item.input, mode: item.mode }),
      signal: AbortSignal.timeout(10_000),
    });
    const payload = await response.json();
    routingResults.push({
      id: item.id,
      expectedRoute: item.expectedRoute,
      actualRoute: payload.profile?.route ?? 'error',
      expectedDifficulty: item.expectedDifficulty,
      actualDifficulty: payload.profile?.difficulty ?? 'unknown',
      passed: response.ok && payload.profile?.route === item.expectedRoute && payload.profile?.difficulty === item.expectedDifficulty,
    });
  } catch (error) {
    routingResults.push({
      id: item.id,
      expectedRoute: item.expectedRoute,
      actualRoute: 'unreachable',
      expectedDifficulty: item.expectedDifficulty,
      actualDifficulty: 'unknown',
      passed: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

await recordSegment({
  id: 'proportional-task-routing',
  dimension: 'selective-routing',
  description: '简单请求不强制进入复杂工作流，复杂交付才升级为完整工作流。',
  passed: routingResults.every((item) => item.passed),
  cases: routingResults,
  artifactValidation: {
    kind: 'live-api-response',
    valid: routingResults.every((item) => item.passed),
    endpoint: '/api/runtime/triage',
  },
});

const runtimeSegments = [
  {
    id: 'cross-turn-agent-skill-drift',
    dimension: 'drift-resistance',
    description: '跨轮输入只选择本轮必要的 Agent/Skill，并允许跳过旧 Graph。',
    probes: [
      { file: 'server/runtime/chatRouter.test.ts', pattern: 'a follow-up turn may skip the old graph|routes system design without an explicit Agent name|maps specialist intents to their skill bundles' },
      { file: 'server/runtime/orchestrator.test.ts', pattern: 'routes skills from the latest user turn without leaking earlier search context' },
    ],
  },
  {
    id: 'live-guidance-transition',
    dimension: 'transition-correctness',
    description: '执行中追加要求只在下一个安全点应用一次，外部 Harness 不支持 steer 时不虚报成功。',
    probes: [
      { file: 'server/runtime/orchestrator.test.ts', pattern: 'applies each live guidance event once at the next safe execution point' },
      { file: 'server/runtime/taskApi.test.ts', pattern: 'live guidance uses real Harness steering and reports unavailable steering honestly' },
    ],
  },
  {
    id: 'large-result-reference-boundary',
    dimension: 'artifact-boundary',
    description: '长结果生成 result_ref，普通下游只见预览，审查消费者有界解引用；对象存储故障时数据库保留全文。',
    probes: [
      { file: 'server/runtime/orchestrator.test.ts', pattern: 'stores large step results by reference|keeps the full large step result in the task database' },
    ],
  },
  {
    id: 'durable-context-return-revisit',
    dimension: 'return-revisit-consistency',
    description: '摘要记录来源与关键控制事实，跨重启恢复；来源消息漂移后拒绝旧摘要并重建。',
    probes: [
      { file: 'server/runtime/contextSummary.test.ts', pattern: 'persistent summaries update incrementally|persistent summary metadata retains' },
      { file: 'server/runtime/taskApi.test.ts', pattern: 'persists versioned context summaries with task artifacts and human-control facts across restart' },
    ],
  },
  {
    id: 'checkpoint-concurrency-conflict',
    dimension: 'concurrency-conflict-safety',
    description: '过期 revision 返回冲突，分支 operationId 幂等，三方合并冲突必须显式选择。',
    probes: [
      { file: 'server/runtime/taskApi.test.ts', pattern: 'checkpoint branches are idempotent, reject stale revisions, and merge explicit conflicts' },
    ],
  },
];

for (const definition of runtimeSegments) {
  const probes = [];
  for (const probe of definition.probes) {
    // Sequential probes produce deterministic, readable segment artifacts.
    // eslint-disable-next-line no-await-in-loop
    probes.push(await runNodeTest(probe));
  }
  const passed = probes.every((probe) => probe.passed);
  await recordSegment({
    ...definition,
    probes,
    passed,
    artifactValidation: {
      kind: 'isolated-runtime-contract',
      valid: passed,
      assertionCount: probes.reduce((total, probe) => total + probe.assertions, 0),
      failureCount: probes.reduce((total, probe) => total + probe.failures, 0),
    },
  });
}

report.completedAt = new Date().toISOString();
report.status = report.summary.failed === 0 ? 'passed' : 'failed';
await persist();
console.log(JSON.stringify(report, null, 2));
if (report.summary.failed > 0) process.exitCode = 1;
