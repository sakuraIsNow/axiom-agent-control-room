/** Optional actual-provider check: node --import tsx qa/artifact-generation-live-smoke.ts
 * Uses the configured default text model and incurs a small model charge.
 * All runtime state is isolated; intentionally excluded from the default gate.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import dotenv from 'dotenv';
import pino from 'pino';
import { FileArtifactStore } from '../server/runtime/artifactStore.js';
import { SqliteArtifactCatalog } from '../server/runtime/artifactCatalog.js';
import { SqliteTaskStore } from '../server/runtime/sqliteTaskStore.js';
import { SqliteToolExecutionStore } from '../server/runtime/toolExecutionStore.js';
import { ToolRegistry } from '../server/runtime/toolRegistry.js';
import { EventHub } from '../server/runtime/eventHub.js';
import { OpenAICompatibleModelClient } from '../server/runtime/modelClient.js';
import type { AgentMemory } from '../server/runtime/memoryClient.js';
import { WorkflowOrchestrator } from '../server/runtime/orchestrator.js';

const readEnvironment = async (path: string) => {
  try { return dotenv.parse(await readFile(path, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error; }
};
const config = { ...await readEnvironment(resolve('.env')), ...await readEnvironment(resolve('.env.local')), ...process.env };
if (!config.DEEPSEEK_API_KEY?.trim()) {
  console.log(JSON.stringify({ passed: false, reason: 'configured-text-model-credential-unavailable' }));
  process.exitCode = 1;
} else {
  const startedAt = Date.now();
  const directory = await mkdtemp(join(tmpdir(), 'axiom-artifact-live-'));
  const tasks = new SqliteTaskStore(join(directory, 'tasks.sqlite'));
  const catalog = new SqliteArtifactCatalog(join(directory, 'catalog.sqlite'));
  const ledger = new SqliteToolExecutionStore(join(directory, 'execution.sqlite'));
  const artifacts = new FileArtifactStore(join(directory, 'artifacts'));
  const previousEnv = Object.fromEntries(['AXIOM_TOOL_EXECUTOR', 'AXIOM_AGENT_WORKSPACE_ROOT', 'AGENT_STEP_MAX_ATTEMPTS', 'AXIOM_MAX_AUTO_REPLANS', 'AGENT_SYNTHESIS_MAX_TOKENS', 'AGENT_SYNTHESIS_MAX_CONTINUATIONS'].map((key) => [key, process.env[key]]));
  process.env.AXIOM_TOOL_EXECUTOR = 'docker';
  process.env.AXIOM_AGENT_WORKSPACE_ROOT = directory;
  process.env.AGENT_STEP_MAX_ATTEMPTS = '1';
  process.env.AXIOM_MAX_AUTO_REPLANS = '0';
  process.env.AGENT_SYNTHESIS_MAX_TOKENS = '1024';
  process.env.AGENT_SYNTHESIS_MAX_CONTINUATIONS = '0';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new DOMException('Live artifact smoke timed out.', 'TimeoutError')), 85_000);
  const modelName = config.DEEPSEEK_MODEL?.trim() || 'deepseek-chat';
  const toolChoices: string[] = [];
  let totalTokens = 0;
  let modelCalls = 0;
  let completedStatus: string | undefined;
  try {
    await tasks.initialize(); await catalog.initialize(); await ledger.initialize();
    const model = new OpenAICompatibleModelClient({
      apiKey: config.DEEPSEEK_API_KEY.trim(), apiBase: config.DEEPSEEK_API_BASE || 'https://api.deepseek.com',
      model: modelName, timeoutMs: 55_000, maxAttempts: 1,
      onUsage: (usage) => { totalTokens += usage?.total_tokens ?? 0; modelCalls += 1; },
    });
    const hub = new EventHub();
    hub.subscribeAll((event) => { if (event.type === 'tool.started' && typeof event.payload.name === 'string') toolChoices.push(event.payload.name); });
    const tools = new ToolRegistry({ execute: async () => { throw new Error('Shell execution is disabled in this isolated live smoke.'); } } as never, artifacts, null, catalog, ledger);
    const memory: AgentMemory = {
      recall: async () => ({ context: '', itemCount: 0, available: false, items: [], quality: { candidates: 0, expiredFiltered: 0, lowConfidenceFiltered: 0, byLayer: { L1: 0, L2: 0, L3: 0 } } }),
      capture: async (task) => ({ capturedCount: 0, skipped: true, reason: 'disabled', cursor: task.updatedAt, contentDigest: '' }),
    };
    const task = await tasks.createTask({ tenantId: 'isolated-live-smoke', userId: 'isolated-user', sessionId: 'isolated-session',
      title: 'Small standalone SVG bicycle animation', model: modelName, mode: 'build',
      input: '创建一个可以预览和下载的独立 HTML 小作品：SVG 绘制一辆极简自行车，两只轮子持续旋转。不要外部依赖。源码控制在 1500 字符以内，交付说明一句话即可。',
      policy: { requirePlanApproval: false },
      plan: { summary: '独立 SVG 自行车动画', routingReason: '单个构建 Agent 可完成小作品', approvalStatus: 'approved',
        profile: { kind: 'implementation', difficulty: 'easy', route: 'single-agent', score: 1, reasons: ['standalone deliverable'], maxSteps: 1, requiresReview: false },
        schedulingDecision: { route: 'single-agent', activeAgentIds: ['builder'], skippedAgentIds: [], appendAgentIds: ['builder'], selectedSkillIds: [], executionWaves: [['draw']],
          steps: [{ id: 'draw', title: '创建动画', agentId: 'builder', objective: '创建独立 HTML SVG 动画并交付', dependsOn: [], skillIds: [] }], requiresReview: false, synthesisAgentId: 'synthesizer', reason: 'One small deliverable' },
        steps: [{ id: 'draw', title: '创建动画', role: 'builder', objective: '创建两轮持续旋转的自行车 SVG 动画，完整自包含 HTML，源码在 1500 字符以内，交付一句话和文件链接。',
          dependsOn: [], skillIds: [], acceptanceCriteria: ['HTML 内有 SVG 自行车和旋转动画，可预览、下载。'], maxTokens: 4096, maxDurationMs: 75_000, failureStrategy: 'retry' }] },
    });
    const result = await new WorkflowOrchestrator(tasks, hub, model, memory, pino({ level: 'silent' }), tools, undefined, undefined, undefined, artifacts, catalog)
      .run(task, controller.signal);
    completedStatus = result.status;
    assert.equal(result.status, 'completed', 'The isolated task did not complete.');
    assert.equal(result.toolApprovals?.length ?? 0, 0, 'Standalone generation requested human tool approval.');
    assert.equal((await tasks.getEvents(task.id)).some((event) => event.type === 'tool.approval_requested' || event.type === 'review.approval_requested'), false);
    const artifact = result.stepResults.flatMap((step) => step.artifacts ?? []).find((entry) => entry.mimeType === 'text/html' || entry.mimeType === 'image/svg+xml');
    assert.ok(artifact, 'No actual HTML/SVG deliverable was saved.');
    const content = await artifacts.get(artifact.id, task.tenantId);
    assert.ok(content && /<svg\b/i.test(content), 'The generated file did not contain SVG.');
    assert.ok(content && /(?:animateTransform|@keyframes|rotate)/i.test(content), 'The generated file did not contain an animation.');
    assert.ok(result.result?.includes(`/api/tasks/${task.id}/artifacts/files/${encodeURIComponent(artifact.id)}`), 'The final answer omitted the actual file.');
    assert.equal((await catalog.get(task.tenantId, artifact.id))?.status, 'active');
    console.log(JSON.stringify({ passed: true, model: modelName, status: result.status, toolChoices, elapsedMs: Date.now() - startedAt, modelCalls, totalTokens, artifactCount: 1, artifactBytes: artifact.bytes }));
  } catch (error) {
    console.log(JSON.stringify({ passed: false, model: modelName, status: completedStatus, toolChoices, elapsedMs: Date.now() - startedAt, modelCalls, totalTokens,
      reason: controller.signal.aborted ? 'overall-timeout' : error instanceof Error ? error.name : 'runtime-failure' }));
    process.exitCode = 1;
  } finally {
    clearTimeout(timeout);
    controller.abort();
    await Promise.allSettled([tasks.close(), catalog.close(), ledger.close()]);
    for (const [key, value] of Object.entries(previousEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    const target = resolve(directory);
    assert.equal(dirname(target).toLowerCase(), resolve(tmpdir()).toLowerCase());
    assert.ok(basename(target).startsWith('axiom-artifact-live-'));
    await rm(target, { recursive: true, force: true });
  }
}
