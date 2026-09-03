export type AgentMode = 'analyze' | 'build' | 'decide';

export type AgentPhase =
  | 'idle'
  | 'routing'
  | 'context'
  | 'inference'
  | 'complete'
  | 'error';

export type ChatMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
  pending?: boolean;
  attachments?: ChatAttachment[];
  /** Durable link between one workflow run and the assistant turn it owns. */
  taskId?: string;
  agentRole?: string;
  route?: string;
};

export type ChatIntent =
  | 'conversation'
  | 'agent-registry'
  | 'web-search'
  | 'academic-search'
  | 'github-research'
  | 'image-generation'
  | 'video-generation'
  | 'image-analysis'
  | 'document-analysis'
  | 'report-export'
  | 'task';

export type ReportExportDecision = {
  scope: 'last-answer' | 'conversation';
  format: 'md' | 'docx' | 'tex' | 'pdf';
  title?: string;
};

export type ChatRouteDecision = {
  intent: ChatIntent;
  execution: 'gateway' | 'workflow';
  agentRole: string;
  workflowRoute: 'direct' | 'single-agent' | 'team' | 'full-workflow';
  requiresSearch: boolean;
  reason: string;
  source: 'router-agent' | 'semantic-model' | 'deterministic-fallback';
  skillIds: string[];
  routingVersion: string;
  routerModel?: string;
  reportExport?: ReportExportDecision;
  router: TurnRoutingDecision;
  scheduler: TurnSchedulingDecision;
};

export type TurnRoutingDecision = {
  intent: ChatIntent;
  taskKind: string;
  difficulty: string;
  requiresExternalFacts: boolean;
  requiredCapabilities: string[];
  candidateAgentIds: string[];
  candidateSkillIds: string[];
  confidence: number;
  rationale: string;
  reportExport?: ReportExportDecision;
};

export type TurnSchedulingStep = {
  id: string;
  title: string;
  agentId: string;
  objective: string;
  dependsOn: string[];
  skillIds: string[];
};

export type TurnSchedulingDecision = {
  route: 'direct' | 'single-agent' | 'team' | 'full-workflow';
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

export type ImageAttachment = {
  id: string;
  kind?: 'image';
  url: string;
  alt: string;
};

export type VideoAttachment = {
  id: string;
  kind: 'video';
  url: string;
  alt: string;
  mimeType?: string;
  poster?: string;
};

export type FileAttachment = {
  id: string;
  kind: 'file';
  name: string;
  mimeType: string;
  size: number;
  dataUrl?: string;
  text?: string;
};

export type ChatAttachment = ImageAttachment | VideoAttachment | FileAttachment;

export type ProviderLocation = 'internet' | 'local';

export type ProviderServiceSettings = {
  useCustom: boolean;
  location: ProviderLocation;
  apiUrl: string;
  apiKey: string;
  model: string;
  /** Server-side encrypted credential reference. The API key is never persisted in browser storage. */
  credentialId?: string;
};

export type TextProviderSettings = ProviderServiceSettings;
export type ImageProviderSettings = ProviderServiceSettings;
export type VideoProviderSettings = ProviderServiceSettings;

export type ProviderSettings = {
  text: TextProviderSettings;
  vision: TextProviderSettings;
  image: ImageProviderSettings;
  video: VideoProviderSettings;
};

export type ExecutionPolicy = {
  requirePlanApproval: boolean;
  maxTokens?: number;
  maxCostUsd?: number;
  maxDurationMs?: number;
  maxConcurrentSteps?: number;
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
  lineage?: { taskId: string; stepId: string; toolCallId: string };
  createdAt: string;
};

export type ToolCall = { id?: string; name: string; args?: Record<string, unknown> };
export type ToolRisk = 'low' | 'medium' | 'high' | 'critical';
export type ToolParameterSchema = {
  type: 'object';
  properties: Record<string, { type: string; description?: string; maxLength?: number; minimum?: number; maximum?: number; items?: { type: string } }>;
  required?: string[];
  additionalProperties: boolean;
};
export type ToolDescriptor = {
  name: string;
  description: string;
  risk: ToolRisk;
  parameters: ToolParameterSchema;
  timeoutMs: number;
  approvalRequired: boolean;
};
export type ToolApproval = {
  id: string;
  signature: string;
  stepId: string;
  name: string;
  args: Record<string, unknown>;
  risk: ToolRisk;
  status: 'pending' | 'approved' | 'rejected';
  requestedAt: string;
  decidedAt?: string;
  decidedBy?: string;
  note?: string;
};

export type ImageRequest = {
  prompt: string;
  mode: 'generate' | 'edit';
  size: string;
  quality: 'low' | 'medium' | 'high' | 'auto';
  n: number;
  imageData?: string;
};

export type ImageResponse = {
  images: ImageAttachment[];
  model: string;
  durationMs: number;
};

export type RunEvent = {
  id: string;
  phase: AgentPhase;
  label: string;
  at: number;
};

/** Persisted collaboration telemetry extracted from the runtime event stream. */
export type CollaborationMessage = {
  eventId: string;
  taskId: string;
  sequence: number;
  fromAgentId: string;
  toAgentId: string;
  kind: string;
  content: string;
  artifactIds: string[];
  handoff?: AgentHandoff;
  at: string;
};

export type EvidenceItem = {
  id: string;
  claim: string;
  kind: 'user-fact' | 'tool-result' | 'external-source' | 'artifact' | 'dependency' | 'model-inference';
  source: string;
  verification: 'verified' | 'supported' | 'unverified' | 'contradicted';
  confidence: number;
  uri?: string;
  title?: string;
  locator?: string;
  artifactId?: string;
  publishedAt?: string;
  retrievedAt?: string;
};

export type AgentHandoff = {
  summary: string;
  status: 'complete' | 'partial' | 'blocked';
  artifactIds: string[];
  evidenceIds: string[];
  openQuestions: string[];
  completionCriteria: string[];
};

export type CollaborationConflict = {
  eventId: string;
  taskId: string;
  sequence: number;
  stepIds: string[];
  signals: string[];
  summary: string;
  resolution: string;
  iteration?: number;
  at: string;
};

export type BudgetConstraint = {
  eventId: string;
  taskId: string;
  sequence: number;
  iteration?: number;
  usedTokens: number;
  maxTokens: number;
  reserveTokens: number;
  estimatedBatchTokens: number;
  availableForBatch: number;
  reason: string;
  steps: Array<{ stepId: string; originalMaxTokens: number; maxTokens: number }>;
  at: string;
};

export type Usage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
};

export type WorkflowTaskStatus =
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

export type TaskProfile = {
  kind: string;
  difficulty: string;
  route: 'direct' | 'single-agent' | 'team' | 'full-workflow' | string;
  score: number;
  reasons: string[];
  maxSteps: number;
  requiresReview: boolean;
};

export type WorkflowEventType =
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
  | 'thread.closed'
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
  | 'node.pause_requested'
  | 'node.resume_requested'
  | 'node.replace_requested'
  | 'node.result_locked'
  | 'node.result_unlocked'
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
  | 'memory.policy_updated'
  | 'model.delta'
  | 'model.completed'
  | 'budget.exceeded'
  | 'budget.constrained'
  | 'estimate.updated'
  | 'human.note'
  | 'human.guidance_accepted'
  | 'human.guidance_applied'
  | 'artifact.created'
  | 'task.completed'
  | 'task.failed'
  | 'task.cancelled'
  | 'task.paused'
  | 'task.resumed';

export type WorkflowEvent = {
  id: string;
  type: WorkflowEventType;
  version: 1;
  taskId: string;
  runId: string;
  sequence: number;
  agentId?: string;
  timestamp: string;
  payload: Record<string, unknown>;
  runtimeContext?: {
    tenantId?: string;
    userId?: string;
    sessionId?: string;
    workflowId?: string;
    turnId?: string;
    attemptId?: string;
    runtimeGeneration?: string;
    ownerId?: string;
    source?: string;
    submissionId?: string;
  };
};

export type WorkflowTask = {
  id: string;
  runId: string;
  revision: number;
  sessionId: string;
  templateId?: string;
  title: string;
  input: string;
  mode: AgentMode;
  model?: string;
  modelCredentialId?: string;
  status: WorkflowTaskStatus;
  controlState?: Record<string, { paused: boolean; locked: boolean; lastActionAt: string; requestedBy?: string }>;
  memoryPolicy?: { enabled: boolean; disabledAgentIds: string[]; updatedAt?: string; updatedBy?: string };
  plan?: {
    summary: string;
    routingReason: string;
    steps?: Array<{ id: string; title: string; role: string; objective: string; dependsOn: string[]; acceptanceCriteria: string[]; skillIds?: string[]; recoveryForStepId?: string }>;
    profile?: TaskProfile;
    graph?: AgentGraph;
    version?: number;
    approvalStatus?: 'pending' | 'approved' | 'rejected';
    routingDecision?: TurnRoutingDecision;
    schedulingDecision?: TurnSchedulingDecision;
    routingVersion?: string;
    routerModel?: string;
    routerConfidence?: number;
  };
  stepResults: Array<{
    stepId: string;
    agentId: string;
    role: string;
    status: 'completed' | 'failed';
    output: string;
    resultRef?: ArtifactRef;
    outputChars?: number;
    outputTruncated?: boolean;
    evidence: string[];
    evidenceDetails?: EvidenceItem[];
    handoff?: AgentHandoff;
    confidence: number;
    attempts: number;
    durationMs: number;
    tokens?: number;
    toolCalls?: ToolCall[];
    artifacts?: ArtifactRef[];
    skipped?: boolean;
    recoveredByStepId?: string;
  }>;
  policy?: ExecutionPolicy;
  toolApprovals?: ToolApproval[];
  review?: {
    approved: boolean;
    score: number;
    summary: string;
    gaps: string[];
    requiredCorrections: string[];
  };
  result?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
};

export type WorkflowTaskSummary = {
  id: string;
  runId: string;
  revision: number;
  sessionId: string;
  userId: string;
  /** Origin recorded on task.created. Optional for summaries from older servers. */
  source?: 'agent-workflow' | 'plugin' | 'webhook' | 'schedule' | 'conversation' | string;
  triggerId?: string;
  manual?: boolean;
  activeAgentIds?: string[];
  selectedSkillIds?: string[];
  templateId?: string | null;
  title: string;
  input?: string;
  mode: AgentMode;
  model?: string | null;
  status: WorkflowTaskStatus;
  profile: TaskProfile | null;
  cancelRequested: boolean;
  createdAt: string;
  updatedAt: string;
  currentStage: string;
  durationMs: number;
  tokens: {
    prompt: number;
    completion: number;
    total: number;
  };
  estimatedCostUsd: number;
  modelCalls: number;
  queueWaitMs: number;
  attempts: number;
  estimate?: {
    progress: number;
    remainingSteps: number;
    durationMs: { low: number; likely: number; high: number };
    confidence: 'low' | 'medium' | 'high';
    updatedAt: string;
  };
  toolCalls: number;
  completedSteps: number;
  totalSteps: number;
  reviewScore?: number;
  pendingToolApprovals?: number;
  /** Model-independent delivery receipt reconstructed from durable events. */
  evidenceSummary?: {
    status: 'verified' | 'partial' | 'unverified' | 'not-required';
    totalSteps: number;
    completedSteps: number;
    failedSteps: number;
    skippedSteps: number;
    acceptanceCriteria: number;
    evidenceItems: number;
    verifiedEvidenceItems?: number;
    supportedEvidenceItems?: number;
    unverifiedEvidenceItems?: number;
    contradictedEvidenceItems?: number;
    recoveredFailures?: number;
    artifactRefs: number;
    toolReceipts: number;
    review: 'approved' | 'not-required' | 'pending' | 'rejected';
    gaps: string[];
  };
};

export type WorkflowCheckpointSummary = {
  checkpointId: string;
  eventId: string;
  sequence: number;
  createdAt: string;
  stage: string;
  revision: number;
  planVersion: number;
  graphRevision: number;
  completedSteps: number;
  failedSteps: number;
  totalSteps: number;
  restorable: boolean;
};

export type WorkflowCheckpointBranch = {
  taskId: string;
  checkpointId: string;
  kind: 'branch' | 'merge';
  title: string;
  status: WorkflowTaskStatus;
  revision: number;
  updatedAt: string;
};

export type WorkflowCheckpointDiff = {
  baseCheckpointId: string;
  targetTaskId: string;
  baseRevision: number;
  targetRevision: number;
  planChanged: boolean;
  steps: {
    added: string[];
    removed: string[];
    changed: string[];
    unchanged: string[];
  };
};

export type WorkflowTemplateVisibility = 'private' | 'team';

export type TaskStats = {
  byStatus: Record<WorkflowTaskStatus, number>;
  createdLast24h: number;
  createdPrev24h: number;
  reviewApprovalRate: number | null;
};

export type TaskStatsDaily = {
  date: string;
  totalTokens: number;
  estimatedCostUsd: number;
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
  models: Array<{
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
  }>;
  tools: Array<{ name: string; calls: number; successes: number; failures: number; failureRate: number; lastFailureAt?: string }>;
  agents: Array<{ agentId: string; role?: string; started: number; completed: number; failed: number; successRate: number | null }>;
  contextSummaries?: {
    summaries: number;
    sourceMessages: number;
    sourceTokens: number;
    summaryTokens: number;
    compressionPercent: number | null;
    averageCoveragePercent: number | null;
    evaluations: number;
    reuseCount: number;
    reuseRate: number | null;
    incrementalCount: number;
    rebuildCount: number;
    exactSummaries: number;
    estimatedSummaries: number;
    tokenizerNames: string[];
  };
  reviewer: { started: number; completed: number; approved: number; rejected: number; humanTakeover: number; approvalRate: number | null };
  artifacts?: { total: number; active: number; orphaned: number; deletePending: number; deleted: number; cleanupFailures: number; totalBytes: number };
  sla: { terminalTasks: number; completed: number; failed: number; cancelled: number; successRate: number | null; p50DurationMs: number; p95DurationMs: number };
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

export type InAppNotificationKind =
  | 'approval_required'
  | 'task_completed'
  | 'partial_delivery'
  | 'task_failed'
  | 'plugin_failed'
  | 'schedule_dead_letter'
  | 'artifact_cleanup_failed';

export type InAppNotification = {
  id: string;
  kind: InAppNotificationKind;
  severity: 'attention' | 'warning' | 'success' | 'info';
  title: string;
  message: string;
  createdAt: string;
  read: boolean;
  target: {
    view: 'tasks' | 'chat' | 'plugins' | 'schedules' | 'operations';
    taskId?: string;
    sessionId?: string;
    scheduleId?: string;
    pluginId?: string;
  };
  action: {
    kind: 'open' | 'retry-task' | 'resume-schedule' | 'retry-artifact-cleanup';
    label: string;
    resourceId?: string;
  };
};

export type InAppNotificationFeed = {
  generatedAt: string;
  unreadCount: number;
  notifications: InAppNotification[];
};

export type OutboundNotificationChannel = {
  id: string;
  name: string;
  type: 'webhook';
  location: 'internet' | 'local';
  endpointDisplay: string;
  eventKinds: InAppNotificationKind[];
  enabled: boolean;
  hasSigningSecret: boolean;
  createdAt: string;
  updatedAt: string;
};

export type OutboundNotificationDelivery = {
  id: string;
  channelId: string;
  channelName: string;
  endpointDisplay: string;
  notificationId: string;
  eventKind: InAppNotificationKind | 'test';
  status: 'pending' | 'delivering' | 'retrying' | 'delivered' | 'dead_letter';
  attemptCount: number;
  totalAttempts: number;
  nextAttemptAt: string;
  lastAttemptAt?: string;
  deliveredAt?: string;
  responseStatus?: number;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
};

export type OutboundNotificationCatalog = {
  channels: OutboundNotificationChannel[];
  deliveries: OutboundNotificationDelivery[];
  supportedEventKinds: InAppNotificationKind[];
};

export type ScheduleCadence =
  | { kind: 'once'; runAt: string; timezone: string }
  | { kind: 'interval'; intervalSeconds: number; timezone: string }
  | { kind: 'daily'; timeOfDay: string; timezone: string }
  | { kind: 'weekly'; timeOfDay: string; weekdays: number[]; timezone: string };

export type ScheduleDraft = {
  title: string;
  input: string;
  mode: AgentMode;
  schedule: ScheduleCadence;
  agentPolicy: 'auto';
  reason: string;
};

export type ScheduledTrigger = {
  id: string;
  sessionId: string;
  title: string;
  input: string;
  mode: AgentMode;
  modelCredentialId?: string;
  inputArtifact?: {
    artifactId: string;
    sourceTaskId: string;
    sourceScheduleId?: string;
    sourceTaskRevision: number;
    sourceTaskUpdatedAt: string;
    contentSha256: string;
    title: string;
  };
  cadence: ScheduleCadence;
  intervalSeconds: number;
  enabled: boolean;
  nextRunAt: string;
  createdAt: string;
  lastRunAt?: string;
  failureCount: number;
  lastError?: string;
  lastRunStatus?: 'success' | 'failed' | 'dead-letter';
  deadLetteredAt?: string;
};

export type ScheduleOccurrence = {
  id: string;
  scheduleId: string;
  title: string;
  startsAt: string;
  estimatedDurationMinutes: number;
  estimatedLoad: number;
  windowLoad: number;
  capacity: 'available' | 'busy' | 'overloaded';
  conflictScheduleIds: string[];
};

export type ScheduleCapacityConflict = {
  id: string;
  startsAt: string;
  endsAt: string;
  load: number;
  limit: number;
  scheduleIds: string[];
  titles: string[];
};

export type ScheduleHealthSuggestion = {
  id: string;
  scheduleId: string;
  kind: 'failure_streak' | 'cost_spike' | 'quality_decline' | 'capacity_conflict';
  severity: 'attention' | 'warning';
  title: string;
  reason: string;
  evidence: string[];
  recommendedAction: 'pause' | 'resume' | 'reschedule';
  actionLabel: string;
  proposedCadence?: ScheduleCadence;
};

export type ScheduleInsights = {
  generatedAt: string;
  range: { from: string; to: string; days: number; truncated: boolean };
  capacity: { limit: number; peakLoad: number; busyWindows: number; overloadedWindows: number };
  occurrences: ScheduleOccurrence[];
  conflicts: ScheduleCapacityConflict[];
  suggestions: ScheduleHealthSuggestion[];
};

export type ScheduleHealthActionAudit = {
  id: string;
  scheduleId: string;
  suggestionId: string;
  kind: ScheduleHealthSuggestion['kind'];
  action: ScheduleHealthSuggestion['recommendedAction'];
  reason: string;
  evidence: string[];
  proposedCadence?: ScheduleCadence;
  before: {
    enabled: boolean;
    cadence: ScheduleCadence;
    nextRunAt: string;
    failureCount: number;
    lastRunStatus?: ScheduledTrigger['lastRunStatus'];
    deadLetteredAt?: string;
  };
  after: {
    enabled: boolean;
    cadence: ScheduleCadence;
    nextRunAt: string;
    failureCount: number;
    lastRunStatus?: ScheduledTrigger['lastRunStatus'];
    deadLetteredAt?: string;
  };
  confirmedBy: string;
  confirmedAt: string;
};

export type UserDefinedAgentKind = 'worker' | 'quality' | 'output';

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
  status: 'draft' | 'published' | 'archived';
  visibility: 'private' | 'team';
  version: number;
  definition: UserDefinedAgentDefinition;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

export type PluginInputField = {
  id: string;
  label: string;
  type: 'text' | 'textarea' | 'number' | 'select';
  required?: boolean;
  options?: string[];
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

export type PluginDeclaredPermission = {
  id: string;
  label: string;
  kind: 'platform-agent' | 'tool';
  risk: 'low' | 'medium' | 'high' | 'critical';
};

export type PluginRelease = {
  schemaVersion: 1;
  platformVersion: string;
  pluginVersion: number;
  integrity: string;
  signature?: string;
  signedAt: string;
  signedBy: string;
  permissions: PluginDeclaredPermission[];
  warnings: string[];
};

export type PluginCompatibilityReport = {
  compatible: boolean;
  errors: string[];
  warnings: string[];
  permissions: PluginDeclaredPermission[];
  integrity: string;
  releaseState: 'draft' | 'unsigned' | 'signed' | 'invalid';
  signatureRequired: boolean;
};

export type UserPlugin = {
  id: string;
  tenantId: string;
  name: string;
  description: string;
  icon?: string;
  kind: 'prompt' | 'mini-app';
  status: 'draft' | 'published' | 'archived';
  visibility: 'private' | 'team';
  version: number;
  definition: {
    mode: AgentMode;
    promptPrefix?: string;
    model?: string;
    toolNames?: string[];
    inputSchema?: { fields: PluginInputField[] };
    workflowId?: string;
    workflowVersion?: number;
    htmlContent?: string;
    width?: number;
    height?: number;
    appearance?: PluginAppearance;
    agentEnabled?: boolean;
    agentInstructions?: string;
    designConversation?: PluginDesignMessage[];
  };
  history: Array<{
    version: number;
    definition: UserPlugin['definition'];
    name?: string;
    description?: string;
    icon?: string;
    visibility?: 'private' | 'team';
    release?: PluginRelease;
    updatedAt: string;
    updatedBy: string;
  }>;
  release?: PluginRelease;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

export type PluginMarketRelease = {
  tenantId: string;
  pluginId: string;
  pluginVersion: number;
  plugin: UserPlugin;
  status: 'pending' | 'approved' | 'rejected' | 'revoked';
  submittedBy: string;
  submittedAt: string;
  reviewedBy?: string;
  reviewedAt?: string;
  reviewNote?: string;
  revokedBy?: string;
  revokedAt?: string;
};

export type PluginInstallation = {
  tenantId: string;
  userId: string;
  pluginId: string;
  pluginVersion: number;
  installedAt: string;
  updatedAt: string;
};

export type PluginMarketEntry = {
  release: PluginMarketRelease;
  installation?: PluginInstallation;
  updateAvailable: boolean;
};

export type WorkflowTemplate = {
  id: string;
  tenantId: string;
  name: string;
  description: string;
  status: 'draft' | 'published' | 'archived';
  visibility: WorkflowTemplateVisibility;
  version: number;
  definition: {
    mode: AgentMode;
    model?: string;
    policy: ExecutionPolicy;
    agentIds: string[];
    toolNames: string[];
    promptPrefix?: string;
  };
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

export type BuiltInTemplate = {
  id: string;
  name: string;
  description: string;
  definition: WorkflowTemplate['definition'];
};

export type TopologyAgent = {
  id: string;
  label: string;
  role: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  parentId?: string;
  stepId?: string;
  title?: string;
  objective?: string;
  dependsOn?: string[];
  confidence?: number;
  output?: string;
  evidence?: string[];
  attempts?: number;
  durationMs?: number;
  tokens?: number;
  failureReason?: string;
  toolCalls?: ToolCall[];
  artifacts?: ArtifactRef[];
  skillIds?: string[];
};

export type AgentGraphNode = {
  id: string;
  stepId?: string;
  agentId?: string;
  parentId?: string;
  executionWave?: number;
  role: string;
  title: string;
  dependsOn: string[];
  skillIds?: string[];
  writeScopes?: string[];
  status?: TopologyAgent['status'] | 'skipped' | 'waiting_for_human' | 'cancelled';
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
  revision?: number;
};

export type PersistedContextSummary = {
  summaryId: string;
  sessionId: string;
  version: number;
  algorithm: string;
  content: string;
  coveredMessageIds: string[];
  coveredFrom?: string;
  coveredTo?: string;
  sourceDigest: string;
  artifactIds: string[];
  approvalEventIds: string[];
  unresolvedItems: string[];
  durableFacts: string[];
  createdAt: string;
  quality?: {
    schemaVersion: 1;
    tokenizer: { name: string; mode: 'estimated' | 'exact' };
    lastAction: 'created' | 'incremental' | 'rebuilt' | 'reused';
    sourceMessages: number;
    sourceCharacters: number;
    sourceTokens: number;
    summaryCharacters: number;
    summaryTokens: number;
    compressionPercent: number | null;
    coveragePercent: number;
    evaluations: number;
    reuseCount: number;
    incrementalCount: number;
    rebuildCount: number;
    updatedAt: string;
  };
};

export type Session = {
  id: string;
  title: string;
  messages: ChatMessage[];
  updatedAt: number;
  activeTaskId?: string;
  activeAssistantId?: string;
  /** Session-scoped graph for direct specialist turns and cross-refresh restore. */
  agentGraph?: AgentGraph;
  /** Server-generated and digest-verified compact history for model context. */
  contextSummary?: PersistedContextSummary;
};
