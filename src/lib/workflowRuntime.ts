import type { WorkflowEvent, WorkflowTask, UserDefinedAgent } from '../types';

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
  kind: 'flow' | 'loop';
  maxIterations?: number;
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
  signal: AbortSignal;
}) {
  const response = await fetch(`/api/workflows/${encodeURIComponent(input.workflowId)}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: input.sessionId, input: input.text }),
    signal: input.signal,
  });
  return (await readJson<{ task: WorkflowTask; eventsUrl: string }>(response, '工作流启动失败')).task;
}

export type WorkflowRunEvent = WorkflowEvent;
