import type { AgentMode, WorkflowTask } from '../types';

export type BusinessRecord = {
  id: string;
  tenantId: string;
  userId: string;
  kind: string;
  projectId?: string;
  ownerId: string;
  status: string;
  revision: number;
  data: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
};

export type ProjectRecord = BusinessRecord & {
  kind: 'project';
  data: {
    name: string;
    goal: string;
    acceptanceCriteria: string[];
    strategy: string;
    members: Array<{ userId: string; role: 'editor' | 'reviewer' | 'viewer' }>;
    resources: Record<string, string[]>;
    decisions: string[];
  };
};

export type MemoryRecord = BusinessRecord & {
  kind: 'memory';
  data: {
    content: string;
    source: string;
    layer: 'L0' | 'L1' | 'L2' | 'L3';
    confidence: number;
    scope: 'user' | 'project' | 'session' | 'agent';
    scopeId?: string;
    expiresAt?: string;
    enabled: boolean;
    syncState?: 'syncing' | 'synced' | 'pending-extraction' | 'local-policy' | 'failed';
    syncMessage?: string;
    syncedAt?: string;
  };
};

export type ToolSourceRecord = BusinessRecord & {
  kind: 'tool-source';
  data: {
    name: string;
    protocol: 'openapi' | 'mcp';
    location: 'internet' | 'local';
    version: string;
    enabled: boolean;
    description: string;
    categories: string[];
    capabilityTags: string[];
    riskLevel: 'low' | 'medium' | 'high';
    authType: 'none' | 'api-key' | 'oauth2' | 'service-account';
    authorizationStatus?: 'ready' | 'pending' | 'not-required';
    visibility: 'private' | 'tenant';
    healthStatus?: 'healthy' | 'unhealthy' | 'pending' | 'unknown';
    healthMessage?: string;
    lastCheckedAt?: string;
    latencyMs?: number;
    usageCount?: number;
    successRate?: number | null;
    allowedAgentIds: string[];
    operations?: Array<{ operationId: string; method: string; path: string }>;
    registeredToolNames?: string[];
    operationRisks?: Record<string, 'low' | 'medium' | 'high'>;
    endpoint?: string;
    pinnedDigest?: string;
    specification: Record<string, unknown>;
  };
};

export type ProjectDecisionRecord = BusinessRecord & {
  kind: 'decision';
  data: { title: string; decision: string; rationale: string; status: 'proposed' | 'accepted' | 'rejected' | 'superseded' };
};

export type ReviewAssignmentRecord = BusinessRecord & {
  kind: 'review-assignment';
  data: {
    reviewerId: string;
    targetType: 'task' | 'nexus' | 'artifact';
    targetId: string;
    note: string;
    assignedBy: string;
    decision?: 'approved' | 'changes_requested';
    reviewNote?: string;
    decidedBy?: string;
    decidedAt?: string;
  };
};

export type ProjectNotificationRecord = BusinessRecord & { kind: 'project-notification' };
export type ToolApprovalRecord = BusinessRecord & {
  kind: 'task-action';
  data: { action: 'tool-approval'; sourceId: string; operationId: string; risk: string; agentId: string; taskId?: string };
};

export type SolutionDefinition = {
  id: string;
  name: string;
  description: string;
  mode: AgentMode;
  inputDefinition: string[];
  workflowDefinition: string[];
  acceptanceDefinition: string[];
  deliveryDefinition: string[];
};

export type TaskEstimate = {
  profile: { kind: string; difficulty: string; route: string; requiresReview: boolean };
  sampleSize: number;
  confidence: 'low' | 'medium' | 'high';
  durationMs: { low: number; likely: number; high: number };
  tokens: { low: number | null; likely: number | null; high: number | null };
  agentCount: number;
  successRate: number | null;
  expectedHumanConfirmations: number;
  basis: string;
};

export type ModelSelection = {
  candidates: Array<{
    model: string;
    attempts: number;
    successes: number;
    failures: number;
    successRate?: number;
    averageLatencyMs?: number;
    totalLatencyMs?: number;
    totalTokens: number;
    feedbackRoutingIssues?: number;
    reviewerFirstPassRate?: number | null;
    retryRate?: number;
    humanTakeoverRate?: number;
    userScore?: number | null;
    explanation: string;
  }>;
  selectionPolicy: string;
};

export type TaskAction = {
  id: 'continue-analysis' | 'model-review' | 'save-nexus' | 'save-plugin' | 'rerun-step' | 'export-report' | 'create-schedule' | 'send-notification';
  label: string;
  enabled: boolean;
  href?: string;
};

const readJson = async <T>(response: Response, fallback: string): Promise<T> => {
  const body = await response.json().catch(() => null) as (T & { error?: string }) | null;
  if (!response.ok || !body) throw new Error(body?.error ?? `${fallback} (${response.status})`);
  return body;
};

const jsonRequest = <T>(path: string, method: string, body?: unknown) => fetch(path, {
  method,
  headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
}).then((response) => readJson<T>(response, '业务能力请求失败'));

export const listProjects = (signal?: AbortSignal) => fetch('/api/capabilities/projects', { signal })
  .then((response) => readJson<{ projects: ProjectRecord[] }>(response, '项目读取失败'))
  .then((body) => body.projects);

export const createProject = (input: { name: string; goal: string; acceptanceCriteria: string[]; strategy: string }) =>
  jsonRequest<{ project: ProjectRecord }>('/api/capabilities/projects', 'POST', input).then((body) => body.project);

export const updateProject = (projectId: string, input: Partial<ProjectRecord['data']> & { revision: number }) =>
  jsonRequest<{ project: ProjectRecord }>(`/api/capabilities/projects/${encodeURIComponent(projectId)}`, 'PATCH', input).then((body) => body.project);

export const archiveProject = (projectId: string, revision: number) =>
  jsonRequest<{ project: ProjectRecord }>(`/api/capabilities/projects/${encodeURIComponent(projectId)}/archive`, 'POST', { revision }).then((body) => body.project);

export const setProjectMember = (projectId: string, input: { userId: string; role: 'editor' | 'reviewer' | 'viewer'; revision: number }) =>
  jsonRequest<{ project: ProjectRecord }>(`/api/capabilities/projects/${encodeURIComponent(projectId)}/members`, 'PUT', input).then((body) => body.project);

export const removeProjectMember = (projectId: string, userId: string, revision: number) =>
  jsonRequest<{ project: ProjectRecord }>(`/api/capabilities/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(userId)}`, 'DELETE', { revision }).then((body) => body.project);

export const linkProjectResource = (projectId: string, input: { resourceType: 'task' | 'session' | 'nexus' | 'schedule' | 'artifact' | 'decision'; resourceId: string; revision: number }) =>
  jsonRequest<{ project: ProjectRecord }>(`/api/capabilities/projects/${encodeURIComponent(projectId)}/resources`, 'POST', input).then((body) => body.project);

export const unlinkProjectResource = (projectId: string, resourceType: string, resourceId: string, revision: number) =>
  jsonRequest<{ project: ProjectRecord }>(`/api/capabilities/projects/${encodeURIComponent(projectId)}/resources/${encodeURIComponent(resourceType)}/${encodeURIComponent(resourceId)}`, 'DELETE', { revision }).then((body) => body.project);

export const createProjectTask = (projectId: string, input: { title: string; input: string; mode: AgentMode; model?: string }) =>
  jsonRequest<{ project: ProjectRecord; task: WorkflowTask }>(`/api/capabilities/projects/${encodeURIComponent(projectId)}/tasks`, 'POST', input);

export const listProjectComments = (projectId: string, signal?: AbortSignal) => fetch(`/api/capabilities/projects/${encodeURIComponent(projectId)}/comments`, { signal })
  .then((response) => readJson<{ comments: BusinessRecord[] }>(response, '评论读取失败')).then((body) => body.comments);

export const createProjectComment = (projectId: string, body: string, target?: { targetType: 'project' | 'task' | 'nexus' | 'artifact'; targetId?: string }) =>
  jsonRequest<{ comment: BusinessRecord }>(`/api/capabilities/projects/${encodeURIComponent(projectId)}/comments`, 'POST', { body, targetType: target?.targetType ?? 'project', targetId: target?.targetId }).then((result) => result.comment);

export const listProjectNotifications = (signal?: AbortSignal) => fetch('/api/capabilities/project-notifications', { signal })
  .then((response) => readJson<{ notifications: ProjectNotificationRecord[] }>(response, '项目通知读取失败')).then((body) => body.notifications);

export const markProjectNotificationRead = (notificationId: string) =>
  jsonRequest<{ notification: ProjectNotificationRecord }>(`/api/capabilities/project-notifications/${encodeURIComponent(notificationId)}/read`, 'POST').then((body) => body.notification);

export const listProjectDecisions = (projectId: string, signal?: AbortSignal) => fetch(`/api/capabilities/projects/${encodeURIComponent(projectId)}/decisions`, { signal })
  .then((response) => readJson<{ decisions: ProjectDecisionRecord[] }>(response, '项目决策读取失败')).then((body) => body.decisions);

export const createProjectDecision = (projectId: string, input: { title: string; decision: string; rationale: string; status?: ProjectDecisionRecord['data']['status'] }) =>
  jsonRequest<{ decision: ProjectDecisionRecord }>(`/api/capabilities/projects/${encodeURIComponent(projectId)}/decisions`, 'POST', input).then((body) => body.decision);

export const updateProjectDecision = (projectId: string, decisionId: string, input: Partial<ProjectDecisionRecord['data']> & { revision: number }) =>
  jsonRequest<{ decision: ProjectDecisionRecord }>(`/api/capabilities/projects/${encodeURIComponent(projectId)}/decisions/${encodeURIComponent(decisionId)}`, 'PATCH', input).then((body) => body.decision);

export const listProjectReviews = (projectId: string, signal?: AbortSignal) => fetch(`/api/capabilities/projects/${encodeURIComponent(projectId)}/reviewers`, { signal })
  .then((response) => readJson<{ assignments: ReviewAssignmentRecord[] }>(response, '项目审核读取失败')).then((body) => body.assignments);

export const assignProjectReviewer = (projectId: string, input: { reviewerId: string; targetType: 'task' | 'nexus' | 'artifact'; targetId: string; note: string }) =>
  jsonRequest<{ assignment: ReviewAssignmentRecord }>(`/api/capabilities/projects/${encodeURIComponent(projectId)}/reviewers`, 'POST', input).then((body) => body.assignment);

export const decideProjectReview = (projectId: string, assignmentId: string, input: { revision: number; decision: 'approved' | 'changes_requested'; note: string }) =>
  jsonRequest<{ assignment: ReviewAssignmentRecord }>(`/api/capabilities/projects/${encodeURIComponent(projectId)}/reviewers/${encodeURIComponent(assignmentId)}/decision`, 'POST', input).then((body) => body.assignment);

export const listMemories = (signal?: AbortSignal) => fetch('/api/capabilities/memories', { signal })
  .then((response) => readJson<{ memories: MemoryRecord[]; memoryCore: 'configured' | 'degraded-local-policy' }>(response, '记忆读取失败'));

export const createMemory = (input: MemoryRecord['data']) => jsonRequest<{ memory: MemoryRecord }>('/api/capabilities/memories', 'POST', input).then((body) => body.memory);

export const updateMemory = (memoryId: string, input: Partial<MemoryRecord['data']> & { revision: number }) =>
  jsonRequest<{ memory: MemoryRecord }>(`/api/capabilities/memories/${encodeURIComponent(memoryId)}`, 'PATCH', input).then((body) => body.memory);

export const deleteMemory = async (memoryId: string) => {
  const response = await fetch(`/api/capabilities/memories/${encodeURIComponent(memoryId)}`, { method: 'DELETE' });
  if (!response.ok) await readJson(response, '记忆删除失败');
};

export const listToolSources = (signal?: AbortSignal) => fetch('/api/capabilities/tool-sources', { signal })
  .then((response) => readJson<{ sources: ToolSourceRecord[] }>(response, '工具目录读取失败')).then((body) => body.sources);

export const createToolSource = (input: ToolSourceRecord['data']) =>
  jsonRequest<{ source: ToolSourceRecord }>('/api/capabilities/tool-sources', 'POST', input).then((body) => body.source);

export const updateToolSource = (sourceId: string, input: Partial<ToolSourceRecord['data']> & { revision: number }) =>
  jsonRequest<{ source: ToolSourceRecord }>(`/api/capabilities/tool-sources/${encodeURIComponent(sourceId)}`, 'PATCH', input).then((body) => body.source);

export const checkToolSourceHealth = (sourceId: string) =>
  jsonRequest<{ source: ToolSourceRecord }>(`/api/capabilities/tool-sources/${encodeURIComponent(sourceId)}/health`, 'POST').then((body) => body.source);

export const listToolApprovals = (sourceId: string, signal?: AbortSignal) => fetch(`/api/capabilities/tool-sources/${encodeURIComponent(sourceId)}/approvals`, { signal })
  .then((response) => readJson<{ approvals: ToolApprovalRecord[] }>(response, '工具审批读取失败')).then((body) => body.approvals);

export const decideToolApproval = (sourceId: string, approvalId: string, input: { approved: boolean; revision: number; note?: string }) =>
  jsonRequest<{ approval: ToolApprovalRecord }>(`/api/capabilities/tool-sources/${encodeURIComponent(sourceId)}/approvals/${encodeURIComponent(approvalId)}`, 'POST', input).then((body) => body.approval);

export const listSolutions = (signal?: AbortSignal) => fetch('/api/capabilities/solutions', { signal })
  .then((response) => readJson<{ solutions: SolutionDefinition[] }>(response, '解决方案读取失败')).then((body) => body.solutions);

export const estimateTask = (input: string, mode: AgentMode, signal?: AbortSignal) => fetch('/api/capabilities/estimate', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input, mode }), signal,
}).then((response) => readJson<TaskEstimate>(response, '任务预估失败'));

export const getModelSelection = (signal?: AbortSignal) => fetch('/api/capabilities/selection', { signal })
  .then((response) => readJson<ModelSelection>(response, '模型策略读取失败'));

export const getTaskActions = (taskId: string, signal?: AbortSignal) => fetch(`/api/capabilities/tasks/${encodeURIComponent(taskId)}/actions`, { signal })
  .then((response) => readJson<{ actions: TaskAction[] }>(response, '后续动作读取失败')).then((body) => body.actions);

export const executeTaskAction = (taskId: string, action: TaskAction['id'], input: { instruction?: string; model?: string; idempotencyKey?: string; schedule?: { intervalSeconds?: number; runAt?: string }; notificationChannelId?: string } = {}) =>
  jsonRequest<{ result: Record<string, unknown>; receipt: BusinessRecord }>(`/api/capabilities/tasks/${encodeURIComponent(taskId)}/actions`, 'POST', {
    action,
    idempotencyKey: input.idempotencyKey ?? crypto.randomUUID(),
    instruction: input.instruction,
    model: input.model,
    schedule: input.schedule,
    notificationChannelId: input.notificationChannelId,
  });

export const submitTaskFeedback = (taskId: string, input: { score: number; issueTypes: string[]; note: string; revisedAnswer?: string; evidenceCorrections?: Array<{ evidenceId: string; correction: string }> }) =>
  jsonRequest<{ feedback: BusinessRecord }>('/api/capabilities/feedback', 'POST', { taskId, ...input }).then((body) => body.feedback);

export const updateTaskMemoryPolicy = (taskId: string, input: { enabled: boolean; disabledAgentIds?: string[] }) =>
  jsonRequest<{ taskId: string; policy: { enabled: boolean; disabledAgentIds: string[] } }>(`/api/tasks/${encodeURIComponent(taskId)}/memory-policy`, 'POST', input).then((body) => body.policy);

export const controlTaskAgent = (taskId: string, stepId: string, action: 'pause' | 'resume' | 'replace' | 'lock' | 'unlock' | 'skip' | 'rerun', input: Record<string, unknown> = {}) =>
  jsonRequest<{ task: WorkflowTask; affectedDescendants?: string[]; estimatedTokenChange?: number; riskIncreased?: boolean }>(`/api/tasks/${encodeURIComponent(taskId)}/nodes/${encodeURIComponent(stepId)}/${action}`, 'POST', input);
