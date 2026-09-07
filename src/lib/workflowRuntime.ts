import type { WorkflowEvent, WorkflowTask, UserDefinedAgent } from '../types';
import type { TaskProviderConfig } from './taskRuntime';

export type WorkflowAgentSource = 'builtin' | 'platform' | 'workflow';

export type WorkflowScopedAgent = {
  id: string;
  roleId: string;
  name: string;
  description: string;
  systemPromptTemplate: string;
  toolAllowlist: string[];
  model?: string;
  maxTokens?: number;
  maxDurationMs?: number;
  failureStrategy?: 'retry' | 'skip' | 'pause';
  icon?: string;
};

export type WorkflowCanvasNode = {
  id: string;
  type: 'input' | 'agent' | 'output';
  name: string;
  description?: string;
  position: { x: number; y: number };
  agentRef?: { source: WorkflowAgentSource; id: string };
  objective?: string;
  acceptanceCriteria?: string[];
  model?: string;
  toolNames?: string[];
  writeScopes?: string[];
  maxTokens?: number;
  maxDurationMs?: number;
  failureStrategy?: 'retry' | 'skip' | 'pause';
  icon?: string;
};

export type WorkflowCanvasEdge = {
  id: string;
  source: string;
  target: string;
  kind: 'flow' | 'loop' | 'condition';
  maxIterations?: number;
  loopId?: string;
  condition?: { expression: string; branch: 'true' | 'false' };
  transfer?: { mode: 'summary' | 'full' | 'fields' | 'reference'; fields?: string[] };
};

export type WorkflowCanvas = {
  schemaVersion: 1;
  nodes: WorkflowCanvasNode[];
  edges: WorkflowCanvasEdge[];
  scopedAgents: WorkflowScopedAgent[];
  viewport?: { x: number; y: number; zoom: number };
};

export type SavedAgentWorkflow = {
  id: string;
  name: string;
  description: string;
  status: 'draft' | 'published' | 'archived';
  visibility: 'private' | 'team';
  version: number;
  definition: {
    kind: 'agent-workflow';
    workflow: WorkflowCanvas;
  };
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

export type NexusBusinessRecord = {
  id: string;
  status: string;
  revision: number;
  data: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type ReusableArtifact = {
  id: string;
  taskId: string;
  source: 'result' | 'tool' | 'event' | 'upload';
  bytes: number;
  mimeType?: string;
  createdAt: string;
  referenceCount: number;
  status: 'active' | 'orphaned' | 'delete_pending' | 'deleted';
};

export type NexusReleaseDiff = {
  left: { id: string; version: number; digest: string };
  right: { id: string; version: number; digest: string };
  changed: boolean;
  stepCount: { left: number; right: number };
  nodeCount: { left: number; right: number };
  edgeCount: { left: number; right: number };
  changes: Record<'steps' | 'nodes' | 'edges', { added: string[]; removed: string[]; changed: string[] }>;
};

export type BuiltinWorkflowAgent = {
  id: string;
  role: string;
  label: string;
  kind: 'orchestrator' | 'worker' | 'quality' | 'output' | 'service';
  capabilities: string[];
  description: string;
  available?: boolean;
  unavailableReason?: string;
};

export type WorkflowValidationIssue = {
  code: string;
  message: string;
  nodeIds?: string[];
  edgeIds?: string[];
};

const readJson = async <T>(response: Response, fallback: string) => {
  const body = await response.json().catch(() => null) as (T & { error?: string; issues?: WorkflowValidationIssue[] }) | null;
  if (!response.ok) {
    const error = new Error(body?.error ?? `${fallback} (${response.status})`) as Error & { issues?: WorkflowValidationIssue[] };
    error.issues = body?.issues;
    throw error;
  }
  return body as T;
};

export async function listAgentWorkflows(signal?: AbortSignal) {
  const response = await fetch('/api/workflows', { signal });
  const body = await readJson<{ workflows?: SavedAgentWorkflow[] }>(response, '工作流列表读取失败');
  return Array.isArray(body.workflows) ? body.workflows : [];
}

export async function saveAgentWorkflow(input: {
  id?: string;
  name: string;
  description: string;
  visibility: 'private' | 'team';
  canvas: WorkflowCanvas;
}) {
  const response = await fetch(input.id ? `/api/workflows/${encodeURIComponent(input.id)}` : '/api/workflows', {
    method: input.id ? 'PATCH' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: input.name, description: input.description, visibility: input.visibility, canvas: input.canvas }),
  });
  return (await readJson<{ workflow: SavedAgentWorkflow }>(response, '工作流保存失败')).workflow;
}

export async function validateAgentWorkflow(canvas: WorkflowCanvas, signal?: AbortSignal) {
  const response = await fetch('/api/workflows/validate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(canvas),
    signal,
  });
  const body = await response.json().catch(() => null) as { valid?: boolean; issues?: WorkflowValidationIssue[] } | null;
  return { valid: response.ok && body?.valid === true, issues: body?.issues ?? [{ code: 'validation-failed', message: '工作流校验失败。' }] };
}

export async function deleteAgentWorkflow(workflowId: string) {
  const response = await fetch(`/api/workflows/${encodeURIComponent(workflowId)}`, { method: 'DELETE' });
  if (!response.ok) await readJson(response, '工作流删除失败');
}

export async function listNexusArtifacts(workflowId: string, signal?: AbortSignal) {
  const response = await fetch(`/api/capabilities/nexus/${encodeURIComponent(workflowId)}/artifacts`, { signal });
  return (await readJson<{ artifacts: NexusBusinessRecord[] }>(response, 'Nexus 附件读取失败')).artifacts;
}

export async function uploadNexusArtifact(workflowId: string, file: File) {
  const dataBase64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('附件读取失败。'));
    reader.onload = () => resolve(String(reader.result ?? '').split(',')[1] ?? '');
    reader.readAsDataURL(file);
  });
  const response = await fetch(`/api/capabilities/nexus/${encodeURIComponent(workflowId)}/artifacts`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: file.name, mimeType: file.type || 'application/octet-stream', dataBase64 }),
  });
  return (await readJson<{ artifact: NexusBusinessRecord }>(response, 'Nexus 附件上传失败')).artifact;
}

export async function listReusableArtifacts(signal?: AbortSignal) {
  const response = await fetch('/api/runtime/artifacts?limit=100', { signal });
  return (await readJson<{ artifacts: ReusableArtifact[] }>(response, '可复用 Artifact 读取失败')).artifacts ?? [];
}

export async function linkNexusArtifact(workflowId: string, artifactId: string, name?: string) {
  const response = await fetch(`/api/capabilities/nexus/${encodeURIComponent(workflowId)}/artifacts/link`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ artifactId, ...(name?.trim() ? { name: name.trim() } : {}) }),
  });
  return readJson<{ artifact: NexusBusinessRecord; idempotent?: boolean }>(response, 'Nexus Artifact 绑定失败');
}

export async function listNexusTests(workflowId: string, signal?: AbortSignal) {
  const response = await fetch(`/api/capabilities/nexus/${encodeURIComponent(workflowId)}/tests`, { signal });
  return (await readJson<{ testCases: NexusBusinessRecord[] }>(response, 'Nexus 测试读取失败')).testCases;
}

export async function createNexusTest(workflowId: string, input: { name: string; input: string; expectedIncludes: string[] }) {
  const response = await fetch(`/api/capabilities/nexus/${encodeURIComponent(workflowId)}/tests`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  });
  return (await readJson<{ testCase: NexusBusinessRecord }>(response, 'Nexus 测试保存失败')).testCase;
}

export async function runNexusTests(workflowId: string, providerConfig?: TaskProviderConfig) {
  const response = await fetch(`/api/capabilities/nexus/${encodeURIComponent(workflowId)}/test-run`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ providerConfig }),
  });
  return readJson<{ workflowId: string; workflowVersion: number; runs: Array<{ id: string; testCaseId: string; taskId: string; expectedIncludes: string[] }> }>(response, 'Nexus 测试启动失败');
}

export async function listNexusTestRuns(workflowId: string, signal?: AbortSignal) {
  const response = await fetch(`/api/capabilities/nexus/${encodeURIComponent(workflowId)}/test-runs`, { signal });
  return (await readJson<{ runs: NexusBusinessRecord[] }>(response, 'Nexus 测试结果读取失败')).runs;
}

export async function waitForNexusTestRuns(
  workflowId: string,
  runIds: string[],
  options: { signal?: AbortSignal; pollMs?: number; timeoutMs?: number; onUpdate?: (runs: NexusBusinessRecord[]) => void } = {},
) {
  const expected = new Set(runIds);
  if (expected.size === 0) return [];
  const startedAt = Date.now();
  const timeoutMs = Math.max(1_000, options.timeoutMs ?? 5 * 60_000);
  const pollMs = Math.max(0, options.pollMs ?? 750);
  while (true) {
    if (options.signal?.aborted) throw options.signal.reason ?? new DOMException('Aborted', 'AbortError');
    const all = await listNexusTestRuns(workflowId, options.signal);
    const runs = all.filter((run) => expected.has(run.id));
    options.onUpdate?.(runs);
    if (runs.length === expected.size && runs.every((run) => run.status !== 'running')) return runs;
    if (Date.now() - startedAt >= timeoutMs) throw new Error('Nexus 测试等待超时；测试任务仍可在任务管理中继续查看。');
    if (pollMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = globalThis.setTimeout(resolve, pollMs);
        options.signal?.addEventListener('abort', () => { globalThis.clearTimeout(timer); reject(options.signal?.reason); }, { once: true });
      });
    }
  }
}

export async function listNexusReleases(workflowId: string, signal?: AbortSignal) {
  const response = await fetch(`/api/capabilities/nexus/${encodeURIComponent(workflowId)}/releases`, { signal });
  return (await readJson<{ releases: NexusBusinessRecord[] }>(response, 'Nexus 发布记录读取失败')).releases;
}

export async function compareNexusReleases(workflowId: string, leftId: string, rightId: string, signal?: AbortSignal) {
  const response = await fetch(`/api/capabilities/nexus/${encodeURIComponent(workflowId)}/releases/${encodeURIComponent(leftId)}/diff/${encodeURIComponent(rightId)}`, { signal });
  return readJson<NexusReleaseDiff>(response, 'Nexus 版本差异读取失败');
}

export async function publishNexus(workflowId: string, note = '') {
  const response = await fetch(`/api/capabilities/nexus/${encodeURIComponent(workflowId)}/releases`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ note }),
  });
  return readJson<{ release: NexusBusinessRecord; workflow: SavedAgentWorkflow; idempotent?: boolean }>(response, 'Nexus 发布失败');
}

export async function restoreNexusRelease(workflowId: string, releaseId: string) {
  const response = await fetch(`/api/capabilities/nexus/${encodeURIComponent(workflowId)}/restore`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ releaseId }),
  });
  return (await readJson<{ workflow: SavedAgentWorkflow }>(response, 'Nexus 版本恢复失败')).workflow;
}

export async function createNexusWorkflowPlugin(workflowId: string) {
  const response = await fetch(`/api/capabilities/nexus/${encodeURIComponent(workflowId)}/workflow-plugin`, { method: 'POST' });
  return readJson<{ plugin: { id: string; name: string }; nexusReleaseId: string }>(response, 'Workflow Plugin 生成失败');
}

export async function listWorkflowAgentSources(signal?: AbortSignal) {
  const readSource = async <T>(request: Promise<Response>, fallback: string) => {
    try {
      return await readJson<T>(await request, fallback);
    } catch {
      return null;
    }
  };
  const [builtin, custom, tools] = await Promise.all([
    readSource<{ agents: BuiltinWorkflowAgent[] }>(fetch('/api/agents', { signal }), '内置 Agent 读取失败'),
    readSource<{ agents: UserDefinedAgent[] }>(fetch('/api/agents/custom?limit=100', { signal }), '平台 Agent 读取失败'),
    readSource<{ tools: Array<{ name: string; description: string }> }>(fetch('/api/runtime/tools', { signal }), '工具目录读取失败'),
  ]);
  return {
    builtin: (builtin?.agents ?? []).filter((agent) => agent.kind !== 'orchestrator'),
    platform: (custom?.agents ?? []).filter((agent) => agent.status === 'published'),
    tools: tools?.tools ?? [],
  };
}

export async function runAgentWorkflow(input: {
  workflowId: string;
  sessionId: string;
  text: string;
  providerConfig?: TaskProviderConfig;
  conversationTurn?: { id: string; role: 'user'; content: string };
  signal: AbortSignal;
}) {
  const response = await fetch(`/api/workflows/${encodeURIComponent(input.workflowId)}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: input.sessionId, input: input.text, conversationTurn: input.conversationTurn, providerConfig: input.providerConfig }),
    signal: input.signal,
  });
  return (await readJson<{ task: WorkflowTask; eventsUrl: string }>(response, '工作流启动失败')).task;
}

export async function getAgentWorkflowHistory(workflowId: string, signal?: AbortSignal) {
  const response = await fetch(`/api/workflows/${encodeURIComponent(workflowId)}/history`, { signal });
  return readJson<{ messages: Array<{ id: string; role: 'user' | 'assistant'; content: string }>; activeTaskId?: string | null; tasks?: Array<{ id: string; status: WorkflowTask['status']; revision: number }> }>(response, 'Workflow history could not be read.');
}

export type WorkflowRunEvent = WorkflowEvent;
