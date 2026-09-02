import type { PersistedContextSummary } from './contextSummary.js';

export type TaskStatus =
  | 'queued'
  | 'planning'
  | 'awaiting_approval'
  | 'running'
  | 'reviewing'
  | 'waiting_for_human'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type AgentRole = string;

export type TaskKind = 'conversation' | 'question' | 'research' | 'implementation' | 'decision' | 'creative' | 'operations';
export type TaskDifficulty = 'trivial' | 'easy' | 'moderate' | 'hard' | 'complex';
export type TaskRoute = 'direct' | 'single-agent' | 'team' | 'full-workflow';

export type TaskProfile = {
  kind: TaskKind;
  difficulty: TaskDifficulty;
  route: TaskRoute;
  score: number;
  reasons: string[];
  maxSteps: number;
  requiresReview: boolean;
};

/** Structured output produced by the per-turn semantic Router Agent. */
export type TurnRoutingDecision = {
  intent: string;
  taskKind: TaskKind;
  difficulty: TaskDifficulty;
  requiresExternalFacts: boolean;
  requiredCapabilities: string[];
  candidateAgentIds: string[];
  candidateSkillIds: string[];
  confidence: number;
  rationale: string;
  reportExport?: {
    scope: 'last-answer' | 'conversation';
    format: 'md' | 'docx' | 'tex' | 'pdf';
    title?: string;
  };
};

export type TurnSchedulingStep = {
  id: string;
  title: string;
  agentId: string;
  objective: string;
  dependsOn: string[];
  skillIds: string[];
};

/** Structured output produced by the per-turn Scheduler Agent. */
export type TurnSchedulingDecision = {
  route: TaskRoute;
  activeAgentIds: string[];
  skippedAgentIds: string[];
  appendAgentIds: string[];
  selectedSkillIds: string[];
  executionWaves: string[][];
  steps: TurnSchedulingStep[];
  requiresReview: boolean;
  synthesisAgentId: string;
  reason: string;
};

export type WorkflowStep = {
  id: string;
  title: string;
  role: string;
  objective: string;
  dependsOn: string[];
  acceptanceCriteria: string[];
  skillIds?: string[];
  model?: string;
  toolNames?: string[];
  /** Relative workspace paths this step may write; empty means read-only. */
  writeScopes?: string[];
  maxTokens?: number;
  maxDurationMs?: number;
  failureStrategy?: 'retry' | 'skip' | 'pause';
  agentContract?: WorkflowStepAgentContract;
  conditions?: WorkflowStepCondition[];
  loopPath?: Array<{ id: string; iteration: number; maxIterations: number; entry: boolean }>;
  loop?: {
    id: string;
    iteration: number;
    maxIterations: number;
    entry: boolean;
  };
};

export type WorkflowStepCondition = {
  sourceStepId: string;
  expression: string;
  branch: 'true' | 'false';
};

export type WorkflowAgentSource = 'builtin' | 'platform' | 'workflow';

/** Immutable Agent instructions resolved when a visual workflow is saved. */
export type WorkflowStepAgentContract = {
  source: WorkflowAgentSource;
  agentId: string;
  displayName: string;
  systemPromptTemplate?: string;
  toolAllowlist: string[];
};

export type AgentWorkflowScopedAgent = {
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

export type AgentWorkflowNode = {
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

export type AgentWorkflowEdge = {
  id: string;
  source: string;
  target: string;
  kind: 'flow' | 'loop' | 'condition';
  maxIterations?: number;
  loopId?: string;
  condition?: {
    expression: string;
    branch: 'true' | 'false';
  };
};

export type AgentWorkflowCanvas = {
  schemaVersion: 1;
  nodes: AgentWorkflowNode[];
  edges: AgentWorkflowEdge[];
  scopedAgents: AgentWorkflowScopedAgent[];
  viewport?: { x: number; y: number; zoom: number };
};

export type WorkflowPlan = {
  summary: string;
  routingReason: string;
  steps: WorkflowStep[];
  profile?: TaskProfile;
  graph?: AgentGraph;
  version?: number;
  approvalStatus?: 'pending' | 'approved' | 'rejected';
  approvedAt?: string;
  approvedBy?: string;
  /** Durable per-turn control-plane decisions used to build this plan. */
  routingDecision?: TurnRoutingDecision;
  schedulingDecision?: TurnSchedulingDecision;
  routingVersion?: string;
  routerModel?: string;
  routerConfidence?: number;
};

export type WorkflowTemplateStatus = 'draft' | 'published' | 'archived';
export type WorkflowTemplateVisibility = 'private' | 'team';

export type TemplateAccess = {
  userId: string;
  role: 'owner' | 'admin' | 'member' | 'viewer';
};

export type WorkflowTemplateDefinition = {
  kind?: 'template' | 'agent-workflow';
  mode: WorkflowTask['mode'];
  model?: string;
  policy: ExecutionPolicy;
  agentIds: string[];
  toolNames: string[];
  promptPrefix?: string;
  plan?: WorkflowPlan;
  workflow?: AgentWorkflowCanvas;
};

export type WorkflowTemplate = {
  id: string;
  tenantId: string;
  name: string;
  description: string;
  status: WorkflowTemplateStatus;
  visibility: WorkflowTemplateVisibility;
  version: number;
  definition: WorkflowTemplateDefinition;
  history: Array<{
    version: number;
    definition: WorkflowTemplateDefinition;
    status: WorkflowTemplateStatus;
    updatedAt: string;
    updatedBy: string;
  }>;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

export type CreateWorkflowTemplateInput = Pick<WorkflowTemplate, 'tenantId' | 'name' | 'description' | 'createdBy'> & {
  definition: WorkflowTemplateDefinition;
  visibility?: WorkflowTemplateVisibility;
};

export type UpdateWorkflowTemplateInput = {
  name?: string;
  description?: string;
  definition?: WorkflowTemplateDefinition;
  status?: WorkflowTemplateStatus;
  visibility?: WorkflowTemplateVisibility;
  updatedBy: string;
};

export interface TemplateStore {
  initialize(): Promise<void>;
  close(): Promise<void>;
  listTemplates(tenantId: string, limit?: number, access?: TemplateAccess, kind?: 'template' | 'agent-workflow'): Promise<WorkflowTemplate[]>;
  getTemplate(templateId: string, tenantId?: string, access?: TemplateAccess): Promise<WorkflowTemplate | null>;
  createTemplate(input: CreateWorkflowTemplateInput): Promise<WorkflowTemplate>;
  updateTemplate(templateId: string, tenantId: string, input: UpdateWorkflowTemplateInput): Promise<WorkflowTemplate>;
  rollbackTemplate(templateId: string, tenantId: string, version: number, updatedBy: string): Promise<WorkflowTemplate>;
}

export type UserPluginKind = 'prompt' | 'mini-app';
export type UserPluginStatus = 'draft' | 'published' | 'archived';
export type UserPluginVisibility = 'private' | 'team';

export type PluginInputField = {
  id: string;
  label: string;
  type: 'text' | 'textarea' | 'number' | 'select';
  required?: boolean;
  options?: string[];
};

export type PromptPluginDefinition = {
  mode: WorkflowTask['mode'];
  promptPrefix?: string;
  model?: string;
  toolNames?: string[];
  inputSchema?: { fields: PluginInputField[] };
};

export type PluginVisualEffect = 'aurora' | 'plasma' | 'liquid' | 'prism' | 'solar' | 'nebula' | 'chrome' | 'pulse';

export type PluginAppearance = {
  effect: PluginVisualEffect;
  hue: number;
  seed: number;
};

export type PluginDesignMessage = {
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
};

export type MiniAppPluginDefinition = {
  mode: WorkflowTask['mode'];
  htmlContent: string;
  width?: number;
  height?: number;
  promptPrefix?: string;
  model?: string;
  toolNames?: string[];
  inputSchema?: { fields: PluginInputField[] };
  appearance?: PluginAppearance;
  agentEnabled?: boolean;
  agentInstructions?: string;
  designConversation?: PluginDesignMessage[];
};

export type UserPluginDefinition = PromptPluginDefinition | MiniAppPluginDefinition;

export type UserPlugin = {
  id: string;
  tenantId: string;
  name: string;
  description: string;
  icon?: string;
  kind: UserPluginKind;
  status: UserPluginStatus;
  visibility: UserPluginVisibility;
  version: number;
  definition: UserPluginDefinition;
  history: Array<{ version: number; definition: UserPluginDefinition; updatedAt: string; updatedBy: string }>;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

export type CreateUserPluginInput = Pick<UserPlugin, 'tenantId' | 'name' | 'description' | 'createdBy'> & {
  icon?: string;
  kind?: UserPluginKind;
  visibility?: UserPluginVisibility;
  definition: UserPluginDefinition;
};

export type UpdateUserPluginInput = Partial<Pick<UserPlugin, 'name' | 'description' | 'icon' | 'visibility' | 'status' | 'definition'>> & {
  updatedBy: string;
};

export interface PluginStore {
  initialize(): Promise<void>;
  close(): Promise<void>;
  listPlugins(tenantId: string, limit?: number, access?: TemplateAccess): Promise<UserPlugin[]>;
  getPlugin(pluginId: string, tenantId?: string, access?: TemplateAccess): Promise<UserPlugin | null>;
  createPlugin(input: CreateUserPluginInput): Promise<UserPlugin>;
  updatePlugin(pluginId: string, tenantId: string, input: UpdateUserPluginInput): Promise<UserPlugin>;
  deletePlugin(pluginId: string, tenantId: string): Promise<boolean>;
}

export type UserDefinedAgentKind = 'worker' | 'quality' | 'output';
export type UserDefinedAgentStatus = 'draft' | 'published' | 'archived';
export type UserDefinedAgentVisibility = 'private' | 'team';

export type UserDefinedAgentDefinition = {
  systemPromptTemplate: string;
  whenToUseHint: string;
  defaultModel?: string;
  allowedModels?: string[];
  toolAllowlist: string[];
  maxToolCallsPerStep?: number;
  maxTokensDefault?: number;
  maxDurationMsDefault?: number;
  failureStrategyDefault?: 'retry' | 'skip' | 'pause';
  memoryRecall: boolean;
  requiresPlanApprovalOverride?: boolean;
};

export type UserDefinedAgent = {
  id: string;
  tenantId: string;
  roleId: string;
  name: string;
  description: string;
  icon?: string;
  kind: UserDefinedAgentKind;
  status: UserDefinedAgentStatus;
  visibility: UserDefinedAgentVisibility;
  version: number;
  definition: UserDefinedAgentDefinition;
  history: Array<{ version: number; definition: UserDefinedAgentDefinition; updatedAt: string; updatedBy: string }>;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

export type CreateUserDefinedAgentInput = Pick<UserDefinedAgent, 'tenantId' | 'roleId' | 'name' | 'description' | 'createdBy'> & {
  icon?: string;
  kind?: UserDefinedAgentKind;
  visibility?: UserDefinedAgentVisibility;
  definition: UserDefinedAgentDefinition;
};

export type UpdateUserDefinedAgentInput = Partial<Pick<UserDefinedAgent, 'name' | 'description' | 'icon' | 'visibility' | 'status' | 'definition'>> & {
  updatedBy: string;
};

export const builtinAgentRoleIds = ['planner', 'researcher', 'analyst', 'builder', 'reviewer', 'synthesizer'] as const;

export interface AgentStore {
  initialize(): Promise<void>;
  close(): Promise<void>;
  listAgents(tenantId: string, limit?: number, access?: TemplateAccess): Promise<UserDefinedAgent[]>;
  getAgent(agentId: string, tenantId?: string, access?: TemplateAccess): Promise<UserDefinedAgent | null>;
  createAgent(input: CreateUserDefinedAgentInput): Promise<UserDefinedAgent>;
  updateAgent(agentId: string, tenantId: string, input: UpdateUserDefinedAgentInput): Promise<UserDefinedAgent>;
}

export type ToolCall = {
  id?: string;
  name: string;
  args?: Record<string, unknown>;
};

export type ToolRisk = 'low' | 'medium' | 'high' | 'critical';

export type ToolParameterProperty = {
  type: 'string' | 'number' | 'boolean' | 'array';
  description?: string;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  items?: { type: 'string' | 'number' | 'boolean' };
};

export type ToolParameterSchema = {
  type: 'object';
  properties: Record<string, ToolParameterProperty>;
  required?: string[];
  additionalProperties: boolean;
};

export type ToolApprovalStatus = 'pending' | 'approved' | 'rejected';

export type ToolApproval = {
  id: string;
  signature: string;
  stepId: string;
  name: string;
  args: Record<string, unknown>;
  risk: ToolRisk;
  status: ToolApprovalStatus;
  requestedAt: string;
  decidedAt?: string;
  decidedBy?: string;
  note?: string;
};

export type ArtifactRef = {
  id: string;
  kind: 'tool-output' | 'step-output' | 'result' | 'evidence';
  name: string;
  key?: string;
  bytes?: number;
  mimeType?: string;
  sourceStepId?: string;
  sourceToolCallId?: string;
  lineage?: {
    taskId: string;
    stepId: string;
    toolCallId: string;
  };
  createdAt: string;
};

export type AgentMessage = {
  id: string;
  fromAgentId: string;
  toAgentId: string;
  kind: 'dependency-context' | 'artifact-share' | 'handoff';
  content: string;
  artifactIds: string[];
  createdAt: string;
};

export type ExecutionPolicy = {
  requirePlanApproval: boolean;
  maxTokens?: number;
  maxCostUsd?: number;
  maxDurationMs?: number;
  maxConcurrentSteps?: number;
};

export type AgentGraphNode = {
  id: string;
  stepId?: string;
  agentId?: string;
  /** Parent in the execution tree; the orchestrator is the root for now. */
  parentId?: string;
  /** Zero-based dependency wave used by the scheduler and Graph UI. */
  executionWave?: number;
  role: AgentRole | 'orchestrator';
  title: string;
  dependsOn: string[];
  skillIds?: string[];
  writeScopes?: string[];
  status?: 'queued' | 'running' | 'completed' | 'failed' | 'skipped' | 'waiting_for_human' | 'cancelled';
  tokens?: number;
  durationMs?: number;
  attempts?: number;
  toolCalls?: number;
  failureReason?: string;
};

export type AgentGraphEdge = {
  from: string;
  to: string;
  kind: 'dependency' | 'delegation' | 'review';
};

export type AgentGraph = {
  nodes: AgentGraphNode[];
  edges: AgentGraphEdge[];
  /** Monotonic graph revision, incremented whenever a plan/checkpoint changes. */
  revision?: number;
};

export type StepResult = {
  stepId: string;
  agentId: string;
  role: WorkflowStep['role'];
  status: 'completed' | 'failed';
  output: string;
  /** Full output location when the database field contains a bounded preview. */
  resultRef?: ArtifactRef;
  outputChars?: number;
  outputTruncated?: boolean;
  evidence: string[];
  confidence: number;
  attempts: number;
  durationMs: number;
  tokens?: number;
  toolCalls?: ToolCall[];
  artifacts?: ArtifactRef[];
  messages?: AgentMessage[];
  skipped?: boolean;
  manual?: boolean;
};

export type ReviewResult = {
  approved: boolean;
  score: number;
  summary: string;
  gaps: string[];
  requiredCorrections: string[];
};

export type WorkflowTask = {
  id: string;
  runId: string;
  /** Monotonic task revision used for optimistic human-control writes. */
  revision: number;
  tenantId: string;
  userId: string;
  sessionId: string;
  templateId?: string;
  title: string;
  input: string;
  mode: 'analyze' | 'build' | 'decide';
  model?: string;
  /** Tenant-scoped encrypted text-provider reference used by resumable workers. */
  modelCredentialId?: string;
  status: TaskStatus;
  plan?: WorkflowPlan;
  stepResults: StepResult[];
  review?: ReviewResult;
  toolApprovals?: ToolApproval[];
  result?: string;
  error?: string;
  cancelRequested: boolean;
  planVersion?: number;
  policy: ExecutionPolicy;
  idempotencyKey?: string;
  createdAt: string;
  updatedAt: string;
};

export type PersistedSessionAttachment = {
  id: string;
  kind?: 'file' | 'video' | 'image';
  url?: string;
  alt?: string;
  name?: string;
  mimeType?: string;
  size?: number;
  dataUrl?: string;
  text?: string;
  poster?: string;
};

export type PersistedSessionMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
  pending?: boolean;
  taskId?: string;
  route?: string;
  agentRole?: string;
  attachments?: PersistedSessionAttachment[];
};

export type PersistedSession = {
  id: string;
  tenantId: string;
  userId: string;
  title: string;
  messages: PersistedSessionMessage[];
  updatedAt: number;
  activeTaskId?: string;
  activeAssistantId?: string;
  /** Graph assembled by direct specialist turns; independent from task graphs. */
  agentGraph?: AgentGraph;
  /** Server-generated summary; original messages remain authoritative. */
  contextSummary?: PersistedContextSummary;
};

export type UpsertSessionInput = Omit<PersistedSession, 'tenantId' | 'userId' | 'contextSummary'> & {
  contextSummary?: PersistedContextSummary | null;
};

export type RuntimeEventType =
  | 'task.created'
  | 'task.queued'
  | 'task.started'
  | 'routing.started'
  | 'routing.decided'
  | 'scheduling.started'
  | 'scheduling.decided'
  | 'harness.connected'
  | 'harness.disconnected'
  | 'thread.started'
  | 'thread.resumed'
  | 'thread.forked'
  | 'turn.started'
  | 'turn.completed'
  | 'turn.interrupted'
  | 'turn.failed'
  | 'item.started'
  | 'item.completed'
  | 'task.planning'
  | 'task.planned'
  | 'plan.approval_requested'
  | 'plan.approved'
  | 'plan.rejected'
  | 'plan.replanned'
  | 'graph.updated'
  | 'branch.selected'
  | 'branch.skipped'
  | 'loop.started'
  | 'loop.iteration'
  | 'loop.completed'
  | 'agent.spawned'
  | 'agent.assigned'
  | 'agent.started'
  | 'agent.retrying'
  | 'agent.completed'
  | 'agent.failed'
  | 'agent.message'
  | 'agent.conflict'
  | 'agent.interrupted'
  | 'agent.resumed'
  | 'agent.skipped'
  | 'graph.extended'
  | 'queue.updated'
  | 'approval.requested'
  | 'approval.resolved'
  | 'tool.started'
  | 'tool.completed'
  | 'tool.failed'
  | 'tool.approval_requested'
  | 'tool.approved'
  | 'tool.rejected'
  | 'node.retry_requested'
  | 'node.skip_requested'
  | 'node.completed_manually'
  | 'node.rerun_requested'
  | 'review.started'
  | 'review.completed'
  | 'review.approval_requested'
  | 'review.approved'
  | 'review.rejected'
  | 'checkpoint.saved'
  | 'checkpoint.branch_created'
  | 'checkpoint.merge_created'
  | 'memory.recall.started'
  | 'memory.recall.completed'
  | 'memory.capture.started'
  | 'memory.capture.completed'
  | 'memory.capture.skipped'
  | 'memory.capture.failed'
  | 'model.delta'
  | 'model.completed'
  | 'budget.exceeded'
  | 'budget.constrained'
  | 'human.note'
  | 'human.guidance_accepted'
  | 'human.guidance_applied'
  | 'artifact.created'
  | 'task.completed'
  | 'task.failed'
  | 'task.cancelled'
  | 'task.paused'
  | 'task.resumed';

export type RuntimeEvent = {
  id: string;
  type: RuntimeEventType;
  version: 1;
  taskId: string;
  runId: string;
  sequence: number;
  agentId?: string;
  timestamp: string;
  payload: Record<string, unknown>;
  /** Cross-entrypoint execution identity used for replay and diagnostics. */
  runtimeContext?: RuntimeExecutionContext;
};

export type RuntimeExecutionContext = {
  tenantId?: string;
  userId?: string;
  sessionId?: string;
  workflowId?: string;
  turnId?: string;
  attemptId?: string;
  runtimeGeneration?: string;
  ownerId?: string;
  source?: RuntimeEventSource;
  submissionId?: string;
};

export type RuntimeEventSource = 'builtin' | 'harness' | 'plugin' | 'agent-nexus' | 'schedule' | 'webhook' | 'conversation' | 'api';

export type CompletionEvidenceSummary = {
  status: 'verified' | 'partial' | 'unverified' | 'not-required';
  totalSteps: number;
  completedSteps: number;
  failedSteps: number;
  skippedSteps: number;
  acceptanceCriteria: number;
  evidenceItems: number;
  artifactRefs: number;
  toolReceipts: number;
  review: 'approved' | 'not-required' | 'pending' | 'rejected';
  gaps: string[];
};

/** Aggregates used by task list projections; avoids loading each task's full event stream. */
export type TaskEventSummary = {
  source?: string;
  /** Owning schedule/plugin/webhook trigger reconstructed from task.created. */
  triggerId?: string;
  manual?: boolean;
  activeAgentIds?: string[];
  selectedSkillIds?: string[];
  modelCalls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
  retries: number;
  toolCalls: number;
  queuedAt?: string;
  startedAt?: string;
  latest?: {
    type: RuntimeEventType;
    timestamp: string;
    payload: Record<string, unknown>;
  };
};

/** Durable model-routing observations reconstructed from task events. */
export type ModelRoutingStats = {
  model: string;
  attempts: number;
  successes: number;
  failures: number;
  totalLatencyMs: number;
  totalTokens: number;
  lastUsedAt?: string;
};

export type CreateTaskInput = Pick<WorkflowTask, 'tenantId' | 'userId' | 'sessionId' | 'title' | 'input' | 'mode'> & {
  policy?: Partial<ExecutionPolicy>;
  idempotencyKey?: string;
  templateId?: string;
  model?: string;
  modelCredentialId?: string;
  plan?: WorkflowPlan;
};

export type TaskPatch = {
  status?: TaskStatus;
  plan?: WorkflowPlan | null;
  stepResults?: StepResult[];
  review?: ReviewResult | null;
  toolApprovals?: ToolApproval[] | null;
  result?: string | null;
  error?: string | null;
  cancelRequested?: boolean;
  planVersion?: number;
  policy?: ExecutionPolicy;
};

export class TaskRevisionConflictError extends Error {
  readonly code = 'TASK_REVISION_CONFLICT';

  constructor(
    readonly taskId: string,
    readonly expectedRevision: number,
    readonly actualRevision: number,
  ) {
    super(`Task ${taskId} revision changed from ${expectedRevision} to ${actualRevision}.`);
    this.name = 'TaskRevisionConflictError';
  }
}

export type TaskStats = {
  byStatus: Record<TaskStatus, number>;
  createdLast24h: number;
  createdPrev24h: number;
  reviewApprovalRate: number | null;
};

export type TaskStatsDaily = {
  date: string;
  totalTokens: number;
  estimatedCostUsd: number;
};

export type OperationsModelSummary = {
  model: string;
  calls: number;
  successes: number;
  failures: number;
  successRate: number | null;
  averageLatencyMs: number;
  totalTokens: number;
  promptCacheHitTokens: number;
  promptCacheMissTokens: number;
  promptCacheHitRate: number | null;
  estimatedCostUsd: number;
  lastUsedAt?: string;
  health: 'healthy' | 'degraded' | 'unknown';
};

export type OperationsToolSummary = {
  name: string;
  calls: number;
  successes: number;
  failures: number;
  failureRate: number;
  lastFailureAt?: string;
};

export type OperationsAgentSummary = {
  agentId: string;
  role?: string;
  started: number;
  completed: number;
  failed: number;
  successRate: number | null;
};

export type OperationsSnapshot = {
  generatedAt: string;
  windowHours: number;
  workers: {
    active: number;
    leases: Array<{ workerId: string; taskCount: number; leaseExpiresAt?: string }>;
    staleLeases: number;
  };
  queue: {
    queued: number;
    planning: number;
    running: number;
    reviewing: number;
    awaitingApproval: number;
    waitingForHuman: number;
    paused: number;
    totalActive: number;
    oldestQueuedAt?: string;
    oldestWaitMs: number;
  };
  models: OperationsModelSummary[];
  tools: OperationsToolSummary[];
  agents: OperationsAgentSummary[];
  reviewer: {
    started: number;
    completed: number;
    approved: number;
    rejected: number;
    humanTakeover: number;
    approvalRate: number | null;
  };
  artifacts?: {
    total: number;
    active: number;
    orphaned: number;
    deletePending: number;
    deleted: number;
    cleanupFailures: number;
    totalBytes: number;
  };
  sla: {
    terminalTasks: number;
    completed: number;
    failed: number;
    cancelled: number;
    successRate: number | null;
    p50DurationMs: number;
    p95DurationMs: number;
  };
};

export type OperationsAlertSeverity = 'critical' | 'warning' | 'info';

export type OperationsAlert = {
  id: string;
  severity: OperationsAlertSeverity;
  title: string;
  detail: string;
  metric: string;
  value: number | string;
  threshold?: number | string;
  source: 'queue' | 'worker' | 'model' | 'tool' | 'review' | 'artifact' | 'readiness';
};

export type OperationsAlertsSnapshot = {
  generatedAt: string;
  windowHours: number;
  readinessState?: 'ready' | 'degraded' | 'blocked';
  summary: { critical: number; warning: number; info: number };
  alerts: OperationsAlert[];
};


export interface TaskStore {
  initialize(): Promise<void>;
  close(): Promise<void>;
  createTask(input: CreateTaskInput): Promise<WorkflowTask>;
  getTask(taskId: string, tenantId?: string): Promise<WorkflowTask | null>;
  deleteTask(taskId: string, tenantId: string): Promise<boolean>;
  findTaskByIdempotency(tenantId: string, idempotencyKey: string): Promise<WorkflowTask | null>;
  getModelRoutingStats?: () => Promise<ModelRoutingStats[]>;
  listTasks(tenantId: string, limit?: number): Promise<WorkflowTask[]>;
  /** Tasks with an external Harness event history that may need reconnecting after a restart. */
  listRecoverableHarnessTasks?(limit?: number): Promise<WorkflowTask[]>;
  /** List every task for a workflow when administrative cleanup needs more than the UI page size. */
  listTasksByTemplate?(tenantId: string, templateId: string): Promise<WorkflowTask[]>;
  /** List task runs created by one durable schedule trigger. */
  listTasksByTrigger?(tenantId: string, triggerId: string, limit?: number): Promise<WorkflowTask[]>;
  getTaskEventSummaries(taskIds: string[], tenantId: string): Promise<Map<string, TaskEventSummary>>;
  getTaskStats(tenantId: string): Promise<TaskStats>;
  getTaskStatsDaily(tenantId: string, days: number): Promise<TaskStatsDaily[]>;
  getOperationsSnapshot(tenantId: string, windowHours?: number): Promise<OperationsSnapshot>;
  updateTask(taskId: string, patch: TaskPatch, expectedRevision?: number): Promise<WorkflowTask>;
  requestCancel(taskId: string, tenantId: string): Promise<boolean>;
  claimNextTask(workerId: string, leaseMs: number): Promise<WorkflowTask | null>;
  renewLease(taskId: string, workerId: string, leaseMs: number): Promise<boolean>;
  releaseLease(taskId: string, workerId: string): Promise<void>;
  appendEvent(task: Pick<WorkflowTask, 'id' | 'runId'>, event: Omit<RuntimeEvent, 'id' | 'taskId' | 'runId' | 'sequence' | 'timestamp' | 'version'>): Promise<RuntimeEvent>;
  getEvents(taskId: string, afterSequence?: number): Promise<RuntimeEvent[]>;
  listSessions(tenantId: string, userId: string, limit?: number): Promise<PersistedSession[]>;
  listDeletedSessionIds(tenantId: string, userId: string): Promise<string[]>;
  upsertSession(tenantId: string, userId: string, input: UpsertSessionInput): Promise<PersistedSession>;
  deleteSession(sessionId: string, tenantId: string, userId: string): Promise<boolean>;
}

export const terminalStatuses = new Set<TaskStatus>(['completed', 'failed', 'cancelled']);
