import { createHash, randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { TaskRevisionConflictError, terminalStatuses, type AgentStore, type AgentWorkflowCanvas, type CompletionEvidenceSummary, type PersistedSessionMessage, type PluginStore, type RuntimeEvent, type TaskEventSummary, type TaskStatus, type TaskStore, type TemplateAccess, type TemplateStore, type UserDefinedAgent, type UserDefinedAgentDefinition, type UserPlugin, type UserPluginDefinition, type WorkflowTemplate, type WorkflowTemplateDefinition } from './contracts.js';
import { isBuiltinRoleId } from './agentStore.js';
import type { TaskCoordinator } from './coordinator.js';
import type { EventHub } from './eventHub.js';
import { agentCatalog } from './agentCatalog.js';
import { getRuntimeReadiness } from './readiness.js';
import { DeepSeekHarnessClient } from './harnessClient.js';
import type { HarnessAdapter, HarnessCapabilities } from './harness.js';
import { HarnessTaskBridge } from './harnessBridge.js';
import { TencentMemoryClient } from './memoryClient.js';
import type { RuntimeMetrics } from './metrics.js';
import { createArtifactStore } from './artifactStore.js';
import type { ArtifactCatalog } from './artifactCatalog.js';
import { InMemoryScheduler, PostgresScheduler, ScheduleHealthActionConflictError, scheduleHealthState, type ScheduledTrigger, type Scheduler } from './scheduler.js';
import { verifyPrincipal } from './principal.js';
import { DockerSandboxExecutor } from './toolExecutor.js';
import type { ModelClient, OpenAICompatibleModelClient } from './modelClient.js';
import type { ToolRegistry } from './toolRegistry.js';
import { classifyTask } from './orchestrator.js';
import { builtInTemplates, getBuiltInTemplate } from './templateCatalog.js';
import { agentWorkflowCanvasSchema, compileAgentWorkflow } from './workflowCompiler.js';
import { workflowSpecialistCatalog } from './workflowSpecialists.js';
import { runtimeSkillCatalog } from './skillCatalog.js';
import { verifyWebhookRequest } from './webhookSecurity.js';
import { chatRouteDecisionSchema, fallbackChatRoute, routeChatIntent, workflowPlanFromChatRoute, type ChatRouteDecision, type RoutingAgentDirectoryEntry } from './chatRouter.js';
import { generateReport } from './reportExport.js';
import { nextRunAtForCadence, scheduleCadenceSchema } from './scheduleCadence.js';
import { fallbackScheduleDraft, parseScheduleDraft, scheduleAgentPrompt } from './scheduleAgent.js';
import { checkpointsFromEvents, diffCheckpointToTask, mergeCheckpointBranch } from './checkpointRuntime.js';
import { attachPersistedContextMetadata, buildPersistedContextSummary, type DurableContextSourceMessage } from './contextSummary.js';
import { buildOperationsAlerts } from './operationsAlerts.js';
import { buildInAppNotifications } from './inAppNotifications.js';
import { createPluginRelease, inspectPluginCompatibility } from './pluginCompatibility.js';
import { buildScheduleInsights } from './scheduleInsights.js';
import { breadthFirstThreadDescendants, buildHarnessThreadGraph } from './harnessThreadGraph.js';

const executingTaskStatuses = new Set<TaskStatus>(['queued', 'planning', 'running', 'reviewing']);
// Agent Nexus owns its runner history. Its internal session IDs must never be
// migrated into the regular conversation list, otherwise deleting a normal
// conversation is undone the next time Nexus tasks are listed.
const isAgentNexusSessionId = (sessionId: string) => sessionId.startsWith('agent-nexus-');
const isLegacyWorkflowSessionId = (sessionId: string) => sessionId.startsWith('workflow-session-') || sessionId.startsWith('qa-workflow-session-');
const isLikelyAgentWorkflowTask = (task: { templateId?: string; sessionId: string; title: string; plan?: { profile?: { route?: string } } }) => Boolean(
  task.templateId
  && (
    isAgentNexusSessionId(task.sessionId)
    || isLegacyWorkflowSessionId(task.sessionId)
    || (task.plan?.profile?.route === 'full-workflow' && /(?:·|•)\s*(?:执行|run)\s*$/i.test(task.title.trim()))
  ),
);
const isLegacyNexusProjection = (session: { id: string; title?: string }) => {
  if (isAgentNexusSessionId(session.id) || isLegacyWorkflowSessionId(session.id)) return true;
  const title = session.title?.trim() ?? '';
  return /(?:agent nexus|agent workflow|智能体枢纽)/i.test(title) && /(?:·|•)\s*(?:执行|run)\s*$/i.test(title);
};

const deleteTerminalWorkflowTasks = async (
  store: TaskStore,
  templateId: string,
  tenantId: string,
  cleanup?: (task: NonNullable<Awaited<ReturnType<TaskStore['getTask']>>>, events: Awaited<ReturnType<TaskStore['getEvents']>>) => Promise<void>,
) => {
  // Workflow deletion removes its durable history from the task board too.
  // Active runs stay intact until they reach a terminal state; deleting them
  // here would make an in-flight runner impossible to observe or resume.
  const tasks = store.listTasksByTemplate
    ? await store.listTasksByTemplate(tenantId, templateId)
    : (await store.listTasks(tenantId, 100)).filter((task) => task.templateId === templateId);
  for (const task of tasks.filter((candidate) => terminalStatuses.has(candidate.status))) {
    const events = await store.getEvents(task.id).catch(() => []);
    if (!await store.deleteTask(task.id, tenantId)) continue;
    await cleanup?.(task, events);
  }
};

const createTaskSchema = z.object({
  sessionId: z.string().min(1).max(160),
  templateId: z.string().uuid().optional(),
  title: z.string().min(1).max(200).optional(),
  input: z.string().min(1).max(80_000),
  mode: z.enum(['analyze', 'build', 'decide']).default('analyze'),
  model: z.string().min(1).max(160).optional(),
  modelCredentialId: z.string().uuid().optional(),
  policy: z.object({
    requirePlanApproval: z.boolean().default(false),
    maxTokens: z.number().int().min(1_000).max(10_000_000).optional(),
    maxCostUsd: z.number().positive().max(100_000).optional(),
    maxDurationMs: z.number().int().min(30_000).max(86_400_000).optional(),
    maxConcurrentSteps: z.number().int().min(1).max(6).optional(),
  }).optional(),
  /** Validated output of the per-turn Router and Scheduler Agents. */
  routing: chatRouteDecisionSchema.optional(),
});

const completionEvidenceStatuses = new Set<CompletionEvidenceSummary['status']>(['verified', 'partial', 'unverified', 'not-required']);
const completionEvidenceReviews = new Set<CompletionEvidenceSummary['review']>(['approved', 'not-required', 'pending', 'rejected']);
const finiteCount = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
const parseCompletionEvidence = (value: unknown): CompletionEvidenceSummary | undefined => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  if (typeof source.status !== 'string' || !completionEvidenceStatuses.has(source.status as CompletionEvidenceSummary['status'])) return undefined;
  if (typeof source.review !== 'string' || !completionEvidenceReviews.has(source.review as CompletionEvidenceSummary['review'])) return undefined;
  const counts = ['totalSteps', 'completedSteps', 'failedSteps', 'skippedSteps', 'acceptanceCriteria', 'evidenceItems', 'artifactRefs', 'toolReceipts'] as const;
  const parsedCounts = Object.fromEntries(counts.map((key) => [key, finiteCount(source[key])])) as Record<(typeof counts)[number], number | null>;
  if (Object.values(parsedCounts).some((count) => count === null)) return undefined;
  const gaps = Array.isArray(source.gaps) && source.gaps.every((gap) => typeof gap === 'string') ? source.gaps.slice(0, 8) as string[] : [];
  return {
    status: source.status as CompletionEvidenceSummary['status'],
    totalSteps: parsedCounts.totalSteps!,
    completedSteps: parsedCounts.completedSteps!,
    failedSteps: parsedCounts.failedSteps!,
    skippedSteps: parsedCounts.skippedSteps!,
    acceptanceCriteria: parsedCounts.acceptanceCriteria!,
    evidenceItems: parsedCounts.evidenceItems!,
    artifactRefs: parsedCounts.artifactRefs!,
    toolReceipts: parsedCounts.toolReceipts!,
    review: source.review as CompletionEvidenceSummary['review'],
    gaps,
  };
};

const reportExportSchema = z.object({
  sessionId: z.string().min(1).max(160),
  scope: z.enum(['last-answer', 'conversation']),
  format: z.enum(['md', 'docx', 'tex', 'pdf']),
  instruction: z.string().min(1).max(8_000),
  title: z.string().min(1).max(120).optional(),
  modelCredentialId: z.string().uuid().optional(),
}).strict();

const templateDefinitionSchema = z.object({
  mode: z.enum(['analyze', 'build', 'decide']),
  model: z.string().min(1).max(160).optional(),
  policy: z.object({
    requirePlanApproval: z.boolean().default(false),
    maxTokens: z.number().int().min(1_000).max(10_000_000).optional(),
    maxCostUsd: z.number().positive().max(100_000).optional(),
    maxDurationMs: z.number().int().min(30_000).max(86_400_000).optional(),
    maxConcurrentSteps: z.number().int().min(1).max(6).optional(),
  }).default({ requirePlanApproval: false }),
  agentIds: z.array(z.string().min(1).max(80)).max(16).default([]),
  toolNames: z.array(z.string().min(1).max(80)).max(32).default([]),
  promptPrefix: z.string().max(4_000).optional(),
  plan: z.object({
    summary: z.string().min(1).max(2_000),
    routingReason: z.string().min(1).max(2_000),
    steps: z.array(z.object({
      id: z.string().min(1).max(80),
      title: z.string().min(1).max(160),
      role: z.enum(['researcher', 'analyst', 'builder', 'reviewer']),
      objective: z.string().min(1).max(4_000),
      dependsOn: z.array(z.string()).max(8).default([]),
      acceptanceCriteria: z.array(z.string().min(1).max(500)).min(1).max(8),
    })).min(1).max(8),
  }).optional(),
});

const createTemplateSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2_000).default(''),
  visibility: z.enum(['private', 'team']).default('private'),
  definition: templateDefinitionSchema,
});

const updateTemplateSchema = createTemplateSchema.partial().extend({
  status: z.enum(['draft', 'published', 'archived']).optional(),
});

const rollbackTemplateSchema = z.object({ version: z.number().int().positive() });
const saveTaskTemplateSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2_000).default(''),
  visibility: z.enum(['private', 'team']).default('private'),
});

const importTemplateSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(2_000).optional(),
  visibility: z.enum(['private', 'team']).default('private'),
  template: z.object({
    name: z.string().min(1).max(120),
    description: z.string().max(2_000).default(''),
    definition: templateDefinitionSchema,
  }),
});

const catalogTemplateSchema = z.object({
  catalogId: z.string().min(1).max(80),
  name: z.string().min(1).max(120).optional(),
  visibility: z.enum(['private', 'team']).default('private'),
});

const pluginFieldSchema = z.object({
  id: z.string().min(1).max(80),
  label: z.string().min(1).max(160),
  type: z.enum(['text', 'textarea', 'number', 'select']),
  required: z.boolean().optional(),
  options: z.array(z.string().min(1).max(120)).max(32).optional(),
});

const promptPluginDefinitionSchema = z.object({
  mode: z.enum(['analyze', 'build', 'decide']),
  promptPrefix: z.string().max(4_000).optional(),
  model: z.string().min(1).max(160).optional(),
  toolNames: z.array(z.string().min(1).max(80)).max(32).default([]),
  inputSchema: z.object({ fields: z.array(pluginFieldSchema).max(16) }).optional(),
}).strict();
const pluginAppearanceSchema = z.object({
  effect: z.enum(['aurora', 'plasma', 'liquid', 'prism', 'solar', 'nebula', 'chrome', 'pulse']),
  hue: z.number().int().min(0).max(359),
  seed: z.number().int().min(1).max(999_999),
}).strict();
const pluginDesignMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1).max(4_000),
  createdAt: z.string().datetime(),
}).strict();
const miniAppPluginDefinitionSchema = z.object({
  mode: z.enum(['analyze', 'build', 'decide']).default('build'),
  htmlContent: z.string().min(1).max(200_000),
  width: z.number().int().min(320).max(1_200).optional(),
  height: z.number().int().min(240).max(900).optional(),
  promptPrefix: z.string().max(4_000).optional(),
  model: z.string().min(1).max(160).optional(),
  toolNames: z.array(z.string().min(1).max(80)).max(32).default([]),
  inputSchema: z.object({ fields: z.array(pluginFieldSchema).max(16) }).optional(),
  appearance: pluginAppearanceSchema.optional(),
  agentEnabled: z.boolean().optional(),
  agentInstructions: z.string().max(8_000).optional(),
  designConversation: z.array(pluginDesignMessageSchema).max(24).optional(),
}).strict();
const pluginDefinitionSchema = z.union([promptPluginDefinitionSchema, miniAppPluginDefinitionSchema]);

const createPluginSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2_000).default(''),
  icon: z.string().max(32).optional(),
  kind: z.enum(['prompt', 'mini-app']).default('prompt'),
  visibility: z.enum(['private', 'team']).default('private'),
  definition: pluginDefinitionSchema,
});

const updatePluginSchema = createPluginSchema.partial().extend({ status: z.enum(['draft', 'published', 'archived']).optional() });
const rollbackPluginSchema = z.object({ version: z.number().int().positive() }).strict();
const pluginAgentProviderSchema = z.object({
  credentialId: z.string().uuid().optional(),
  apiUrl: z.string().url().max(2_000).optional(),
  apiKey: z.string().max(2_000).optional(),
  model: z.string().min(1).max(160),
  location: z.enum(['internet', 'local']),
}).strict().refine((value) => Boolean(value.credentialId || value.apiUrl), { message: 'apiUrl or credentialId is required.' });
const createPluginWithAgentSchema = z.object({
  goal: z.string().min(8).max(8_000),
  visibility: z.enum(['private', 'team']).default('private'),
  provider: pluginAgentProviderSchema.optional(),
}).strict();
const updatePluginWithAgentSchema = z.object({
  instruction: z.string().min(2).max(8_000),
  provider: pluginAgentProviderSchema.optional(),
}).strict();
const generatedPluginSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2_000).default(''),
  mode: z.enum(['analyze', 'build', 'decide']).default('analyze'),
  promptPrefix: z.string().min(1).max(4_000),
  toolNames: z.array(z.string().min(1).max(80)).max(16).default([]),
  fields: z.array(z.object({
    label: z.string().min(1).max(160),
    type: z.enum(['text', 'textarea', 'number', 'select']),
    required: z.boolean().default(false),
    options: z.array(z.string().min(1).max(120)).max(16).optional(),
  })).max(12).default([]),
}).strict();
const generatedMiniAppSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(2_000).optional(),
  htmlContent: z.string().min(1).max(200_000),
  agentEnabled: z.boolean().default(false),
  agentInstructions: z.string().max(8_000).default(''),
  summary: z.string().min(1).max(1_000),
}).strict();
const runPluginSchema = z.object({
  sessionId: z.string().min(1).max(160),
  input: z.string().max(80_000).optional(),
  values: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  title: z.string().max(200).optional(),
  policy: createTaskSchema.shape.policy,
});

const harnessStartSchema = z.object({
  input: z.string().min(1).max(80_000).optional(),
  model: z.string().min(1).max(160).optional(),
}).strict();
const harnessResumeSchema = z.object({
  threadId: z.string().min(1).max(200),
  afterSequence: z.number().int().min(0).max(10_000_000).optional(),
}).strict();

const agentDefinitionSchema = z.object({
  systemPromptTemplate: z.string().min(1).max(8_000),
  whenToUseHint: z.string().min(1).max(500),
  defaultModel: z.string().min(1).max(160).optional(),
  allowedModels: z.array(z.string().min(1).max(160)).max(16).optional(),
  toolAllowlist: z.array(z.string().min(1).max(80)).max(32).default([]),
  maxToolCallsPerStep: z.number().int().min(0).max(64).optional(),
  maxTokensDefault: z.number().int().min(1).optional(),
  maxDurationMsDefault: z.number().int().min(1_000).optional(),
  failureStrategyDefault: z.enum(['retry', 'skip', 'pause']).optional(),
  memoryRecall: z.boolean().default(false),
  requiresPlanApprovalOverride: z.boolean().optional(),
});

const createAgentSchema = z.object({
  roleId: z.string().min(1).max(64),
  name: z.string().min(1).max(120),
  description: z.string().max(2_000).default(''),
  icon: z.string().max(32).optional(),
  kind: z.enum(['worker', 'quality', 'output']).default('worker'),
  visibility: z.enum(['private', 'team']).default('private'),
  definition: agentDefinitionSchema,
});

const updateAgentSchema = createAgentSchema.omit({ roleId: true }).partial().extend({ status: z.enum(['draft', 'published', 'archived']).optional() });

const saveAgentWorkflowSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2_000).default(''),
  visibility: z.enum(['private', 'team']).default('private'),
  canvas: agentWorkflowCanvasSchema,
}).strict();

const runAgentWorkflowSchema = z.object({
  sessionId: z.string().min(1).max(160),
  input: z.string().min(1).max(80_000),
  title: z.string().min(1).max(200).optional(),
  model: z.string().min(1).max(160).optional(),
  modelCredentialId: z.string().uuid().optional(),
  policy: createTaskSchema.shape.policy,
}).strict();

const scheduleSchema = createTaskSchema.omit({ templateId: true, routing: true, model: true, policy: true }).extend({
  cadence: scheduleCadenceSchema.optional(),
  intervalSeconds: z.number().int().min(15).max(31_536_000).optional(),
  enabled: z.boolean().default(true),
  inputArtifactTaskId: z.string().uuid().optional(),
}).strict().refine((value) => value.cadence !== undefined || value.intervalSeconds !== undefined, {
  message: 'cadence or intervalSeconds is required.',
});

const scheduleDraftRequestSchema = z.object({
  request: z.string().min(1).max(8_000),
  sessionId: z.string().min(1).max(160),
  timezone: z.string().min(1).max(100).refine((value) => {
    try { new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date()); return true; } catch { return false; }
  }, 'Invalid IANA timezone.').default('Asia/Shanghai'),
  modelCredentialId: z.string().uuid().optional(),
}).strict();

const manualScheduleRunSchema = z.object({
  idempotencyKey: z.string().min(8).max(120).optional(),
}).strict();

const scheduleHealthActionSchema = z.object({
  suggestionId: z.string().min(1).max(160),
}).strict();

const notificationReadSchema = z.object({
  ids: z.array(z.string().min(1).max(512)).max(100).default([]),
  all: z.boolean().default(false),
}).strict().refine((value) => value.all || value.ids.length > 0, {
  message: 'At least one notification id or all=true is required.',
});

const noteSchema = z.object({
  message: z.string().min(1).max(8_000),
});

const guidanceSchema = z.object({
  message: z.string().min(1).max(8_000),
  behavior: z.enum(['continue', 'replan']).default('continue'),
}).strict();

const memoryAgentScopeSchema = z.object({
  agentId: z.string().min(1).max(160),
  sessionId: z.string().min(1).max(160).optional(),
}).strict();

const memoryAtomicUpdateSchema = memoryAgentScopeSchema.extend({
  content: z.string().min(1).max(8_192),
  background: z.string().max(2_000).optional(),
}).strict();

const memoryAtomicDeleteSchema = memoryAgentScopeSchema.strict();

const memoryConversationDeleteSchema = memoryAgentScopeSchema.extend({
  messageIds: z.array(z.string().min(1).max(160)).min(1).max(500).optional(),
  sessionIds: z.array(z.string().min(1).max(160)).min(1).max(100).optional(),
}).strict().refine((value) => Boolean(value.messageIds?.length || value.sessionIds?.length), {
  message: 'messageIds or sessionIds is required.',
});

const safeMemoryPath = z.string().min(1).max(500).refine((value) => (
  !value.startsWith('/') && !value.startsWith('\\') && !value.split(/[\\/]/).includes('..')
), { message: 'Memory path must be relative and cannot contain traversal segments.' });

const memoryScenarioReadSchema = memoryAgentScopeSchema.extend({ path: safeMemoryPath }).strict();
const memoryScenarioWriteSchema = memoryScenarioReadSchema.extend({
  content: z.string().min(1).max(80_000),
  summary: z.string().max(2_000).optional(),
}).strict();
const memoryCoreWriteSchema = memoryAgentScopeSchema.extend({ content: z.string().min(1).max(80_000) }).strict();

const pauseSchema = z.object({
  reason: z.string().max(1_000).optional(),
});

const planDecisionSchema = z.object({
  note: z.string().max(4_000).optional(),
});

const reviewDecisionSchema = z.object({
  note: z.string().max(4_000).optional(),
});

const toolDecisionSchema = z.object({
  approvalId: z.string().min(1).max(100).optional(),
  note: z.string().max(4_000).optional(),
});

const replanSchema = z.object({
  instruction: z.string().min(1).max(8_000),
  preserveCompleted: z.boolean().default(false),
});

const nodeControlSchema = z.object({
  reason: z.string().max(2_000).optional(),
  output: z.string().max(48_000).optional(),
  evidence: z.array(z.string().max(1_000)).max(20).default([]),
  confidence: z.number().min(0).max(1).default(1),
});

const checkpointBranchSchema = z.object({
  expectedRevision: z.number().int().min(0),
  operationId: z.string().uuid(),
  title: z.string().min(1).max(200).optional(),
  instruction: z.string().max(8_000).default(''),
  behavior: z.enum(['continue', 'replan']).default('continue'),
}).strict();

const checkpointMergeSchema = z.object({
  expectedRevision: z.number().int().min(0),
  operationId: z.string().uuid(),
  branchTaskId: z.string().uuid(),
  strategy: z.enum(['manual', 'prefer-branch', 'prefer-current']).default('manual'),
  title: z.string().min(1).max(200).optional(),
}).strict();

const runtimeIdSchema = z.string().uuid();

const sessionAttachmentSchema = z.object({
  id: z.string().min(1).max(160),
  kind: z.enum(['file', 'video', 'image']).optional(),
  url: z.string().max(4_000_000).optional(),
  alt: z.string().max(500).optional(),
  name: z.string().max(500).optional(),
  mimeType: z.string().max(160).optional(),
  size: z.number().int().nonnegative().max(20_000_000).optional(),
  dataUrl: z.string().max(4_000_000).optional(),
  text: z.string().max(160_000).optional(),
  poster: z.string().max(4_000_000).optional(),
}).strict();

const sessionMessageSchema = z.object({
  id: z.string().min(1).max(160),
  role: z.enum(['user', 'assistant']),
  content: z.string().max(80_000),
  createdAt: z.number().int().nonnegative().max(9_999_999_999_999),
  pending: z.boolean().optional(),
  taskId: z.string().max(160).optional(),
  route: z.string().max(80).optional(),
  agentRole: z.string().max(120).optional(),
  attachments: z.array(sessionAttachmentSchema).max(6).optional(),
}).strict();

const sessionGraphNodeSchema = z.object({
  id: z.string().min(1).max(160),
  stepId: z.string().max(160).optional(),
  agentId: z.string().max(160).optional(),
  role: z.string().min(1).max(120),
  title: z.string().max(240),
  dependsOn: z.array(z.string().max(160)).max(32),
  skillIds: z.array(z.string().max(160)).max(32).optional(),
  status: z.enum(['queued', 'running', 'completed', 'failed']).optional(),
  tokens: z.number().int().nonnegative().max(10_000_000).optional(),
  durationMs: z.number().int().nonnegative().max(86_400_000).optional(),
  attempts: z.number().int().nonnegative().max(100).optional(),
  toolCalls: z.number().int().nonnegative().max(10_000).optional(),
  failureReason: z.string().max(2_000).optional(),
}).strict();

const sessionGraphEdgeSchema = z.object({
  from: z.string().min(1).max(160),
  to: z.string().min(1).max(160),
  kind: z.enum(['dependency', 'delegation', 'review']),
}).strict();

const sessionGraphSchema = z.object({
  nodes: z.array(sessionGraphNodeSchema).max(32),
  edges: z.array(sessionGraphEdgeSchema).max(64),
}).strict().superRefine((graph, ctx) => {
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  if (nodeIds.size !== graph.nodes.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['nodes'], message: 'Graph contains duplicate Agent IDs.' });
  }
  for (const node of graph.nodes) {
    for (const dependency of node.dependsOn) {
      if (!nodeIds.has(dependency)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['nodes'], message: `Graph dependency does not exist: ${dependency}.` });
      }
    }
  }
  const edgeIds = new Set<string>();
  const indegree = new Map([...nodeIds].map((id) => [id, 0]));
  const outgoing = new Map([...nodeIds].map((id) => [id, [] as string[]]));
  for (const edge of graph.edges) {
    const edgeId = `${edge.from}\u0000${edge.to}\u0000${edge.kind}`;
    if (edgeIds.has(edgeId)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['edges'], message: 'Graph contains duplicate edges.' });
    }
    edgeIds.add(edgeId);
    if (edge.from === edge.to || !nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['edges'], message: 'Graph edge references a missing Agent or itself.' });
      continue;
    }
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
    outgoing.get(edge.from)?.push(edge.to);
  }
  const ready = [...indegree].filter(([, degree]) => degree === 0).map(([id]) => id);
  let visited = 0;
  while (ready.length > 0) {
    const id = ready.shift()!;
    visited += 1;
    outgoing.get(id)?.forEach((next) => {
      const degree = (indegree.get(next) ?? 1) - 1;
      indegree.set(next, degree);
      if (degree === 0) ready.push(next);
    });
  }
  if (visited !== nodeIds.size) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['edges'], message: 'Graph dependencies must be acyclic.' });
  }
});

const sessionUpsertSchema = z.object({
  id: z.string().min(1).max(160).optional(),
  title: z.string().max(200),
  messages: z.array(sessionMessageSchema).max(400),
  updatedAt: z.number().int().nonnegative().max(9_999_999_999_999),
  activeTaskId: z.string().max(160).optional(),
  activeAssistantId: z.string().max(160).optional(),
  agentGraph: sessionGraphSchema.optional(),
}).strict();

const encodeEvent = (event: RuntimeEvent) => new TextEncoder().encode(
  `id: ${event.sequence}\nevent: runtime\ndata: ${JSON.stringify(event)}\n\n`,
);

const identity = (headers: Headers) => ({
  ...(verifyPrincipal(headers) ?? {
    tenantId: headers.get('x-axiom-tenant-id')?.trim().slice(0, 120) || 'local',
    userId: headers.get('x-axiom-user-id')?.trim().slice(0, 120) || 'local-user',
    role: 'member' as const,
  }),
});

const templateAccess = (principal: ReturnType<typeof identity>): TemplateAccess => ({
  userId: principal.userId,
  role: principal.role,
});

const canManageTemplate = (template: WorkflowTemplate, principal: ReturnType<typeof identity>) =>
  principal.role === 'owner' || principal.role === 'admin' || template.createdBy === principal.userId;

const canManagePlugin = (plugin: UserPlugin, principal: ReturnType<typeof identity>) =>
  principal.role === 'owner' || principal.role === 'admin' || plugin.createdBy === principal.userId;

const canManageAgent = (agent: UserDefinedAgent, principal: ReturnType<typeof identity>) =>
  principal.role === 'owner' || principal.role === 'admin' || agent.createdBy === principal.userId;

const canGovernLongTermMemory = (principal: ReturnType<typeof identity>) =>
  principal.role === 'owner' || principal.role === 'admin';

const memoryFailure = (error: unknown) => {
  const message = (error instanceof Error ? error.message : 'MemoryCore request failed.')
    .replace(/\bsk-[A-Za-z0-9_-]{10,}\b/g, '[redacted-key]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, 'Bearer [redacted-token]');
  return {
    status: (message.includes('disabled') ? 503 : 502) as 502 | 503,
    body: { error: message.includes('disabled') ? '长期记忆服务尚未配置。' : `长期记忆服务请求失败：${message.slice(0, 500)}` },
  };
};

const isAgentWorkflow = (template: WorkflowTemplate) => template.definition.kind === 'agent-workflow' && Boolean(template.definition.workflow);

const templateBundle = (template: WorkflowTemplate) => ({
  schemaVersion: 1 as const,
  exportedAt: new Date().toISOString(),
  template: {
    name: template.name,
    description: template.description,
    definition: template.definition,
  },
  source: { templateId: template.id, version: template.version },
});

const enqueueErrorResponse = (error: unknown) => {
  const candidate = error as { code?: unknown; constraint?: unknown; message?: unknown };
  const message = typeof candidate.message === 'string' ? candidate.message : 'Task enqueue failed.';
  if (/not found/i.test(message)) return { status: 404 as const, message };
  if (candidate.code === '23505' || candidate.constraint === 'idx_tasks_idempotency') return { status: 409 as const, message };
  if (/^(?:08|53|57)/.test(String(candidate.code ?? '')) || /(?:ECONN|connection|database|pool|timeout|timed out|unavailable|network)/i.test(message)) {
    return { status: 503 as const, message: '任务存储暂时不可用，请稍后重试。' };
  }
  // Keep the historical conflict contract for known business-rule failures
  // (for example, attempting to run a draft template).
  return { status: 409 as const, message };
};

// Keep unavailable external Harnesses distinct from task-state conflicts. A
// client can retry a 503 after fixing configuration or reconnecting a sidecar,
// while a 409 requires changing the requested task operation.
const harnessCommandFailureStatus = (result: { capabilities?: { configured?: boolean; compatible?: boolean; active?: boolean } }) => {
  const capabilities = result.capabilities;
  if (!capabilities || capabilities.configured !== true || capabilities.compatible !== true || capabilities.active !== true) return 503 as const;
  return 409 as const;
};

export const createTaskApi = (dependencies: {
  store: TaskStore;
  hub: EventHub;
  coordinator: TaskCoordinator;
  metrics?: RuntimeMetrics;
  toolRegistry?: ToolRegistry;
  artifactStore?: import('./artifactStore.js').ArtifactStore | null;
  artifactCatalog?: ArtifactCatalog | null;
  model?: OpenAICompatibleModelClient;
  reportModelFactory?: (credentialId: string | undefined, tenantId: string, userId: string) => ModelClient | Promise<ModelClient>;
  scheduleModelFactory?: (credentialId: string | undefined, tenantId: string, userId: string) => ModelClient | Promise<ModelClient>;
  pluginModelFactory?: (provider?: z.infer<typeof pluginAgentProviderSchema>, tenantId?: string, userId?: string) => ModelClient | Promise<ModelClient>;
  templates?: TemplateStore;
  plugins?: PluginStore;
  agents?: AgentStore;
  memory?: TencentMemoryClient;
  resolveModelCredential?: (credentialId: string, tenantId: string, userId: string) => Promise<{ id: string; model: string } | null>;
  harnessAdapter?: HarnessAdapter;
}) => {
  const api = new Hono();
  const { store, hub, coordinator } = dependencies;
  const metrics = dependencies.metrics;
  const artifactStore = dependencies.artifactStore === undefined ? createArtifactStore() : dependencies.artifactStore;
  const artifactCatalog = dependencies.artifactCatalog ?? null;
  // Probe the same Harness implementation that owns delegated execution. A
  // previous implementation always reported the DeepSeek capability probe,
  // even when a Codex app-server sidecar was the active transport.
  const fallbackHarness = new DeepSeekHarnessClient();
  const harnessHandshake = (signal?: AbortSignal): Promise<HarnessCapabilities | Awaited<ReturnType<DeepSeekHarnessClient['handshake']>>> => (
    dependencies.harnessAdapter?.handshake(signal) ?? fallbackHarness.handshake(signal)
  );
  const harnessBridge = dependencies.harnessAdapter
    ? new HarnessTaskBridge(store, hub, dependencies.harnessAdapter)
    : null;
  // Reconnect external threads from durable Task/Event records after a worker
  // restart. The bridge remains idle when no sidecar is configured.
  harnessBridge?.startRecovery();
  const memory = dependencies.memory ?? new TencentMemoryClient();
  const toolExecutor = new DockerSandboxExecutor();
  const model = dependencies.model;
  const toolRegistry = dependencies.toolRegistry;
  const templates = dependencies.templates;
  const plugins = dependencies.plugins;
  const agents = dependencies.agents;
  const pluginSigningKey = process.env.AXIOM_PLUGIN_SIGNING_KEY?.trim() || undefined;
  const pluginSignatureRequired = process.env.AXIOM_REQUIRE_PLUGIN_SIGNATURE === 'true';
  const inspectPlugin = (plugin: UserPlugin) => inspectPluginCompatibility(plugin, toolRegistry?.catalog() ?? [], {
    signingKey: pluginSigningKey,
    signatureRequired: pluginSignatureRequired,
  });
  const inspectPluginForPublish = (plugin: UserPlugin) => inspectPluginCompatibility(plugin, toolRegistry?.catalog() ?? [], {
    signingKey: pluginSigningKey,
    signatureRequired: false,
  });
  const readinessDependencies = {
    memory,
    model,
    sandbox: toolExecutor,
    objectStore: artifactStore ?? undefined,
    harness: { handshake: harnessHandshake },
  };

  const cleanupTaskArtifacts = async (
    task: Awaited<ReturnType<TaskStore['getTask']>>,
    eventSnapshot?: Awaited<ReturnType<TaskStore['getEvents']>>,
  ) => {
    if (!artifactStore || !task) return;
    const ids = new Set<string>([`result:${task.id}`]);
    for (const result of task.stepResults ?? []) {
      for (const artifact of result.artifacts ?? []) ids.add(artifact.id);
    }
    const events = eventSnapshot ?? await store.getEvents(task.id).catch(() => []);
    for (const event of events) {
      if (event.type !== 'artifact.created' && event.type !== 'tool.completed') continue;
      const payload = event.payload as Record<string, unknown>;
      if (typeof payload.artifactId === 'string') ids.add(payload.artifactId);
      if (typeof payload.id === 'string' && event.type === 'artifact.created') ids.add(payload.id);
      const artifact = payload.artifact;
      if (artifact && typeof artifact === 'object' && typeof (artifact as { id?: unknown }).id === 'string') {
        ids.add((artifact as { id: string }).id);
      }
    }
    await artifactCatalog?.removeTaskReferences(task.tenantId, task.id, [...ids]);
    await Promise.all([...ids].map(async (id) => {
      const catalogRecord = await artifactCatalog?.get(task.tenantId, id);
      // A schedule or another task still owns this Artifact. Removing the
      // source task must not break the downstream, version-pinned input.
      if (catalogRecord && catalogRecord.referenceCount > 0) return;
      await artifactCatalog?.markDeletePending(task.tenantId, id, '任务已删除，等待 Artifact 清理。');
      try {
        await artifactStore.delete(id, task.tenantId);
        await artifactCatalog?.markDeleted(task.tenantId, id);
      } catch (error) {
        await artifactCatalog?.recordCleanupFailure(task.tenantId, id, error instanceof Error ? error.message : 'Artifact 删除失败。');
      }
    }));
  };
  const contextSummaryMetadata = async (
    tenantId: string,
    userId: string,
    sessionId: string,
    messages: PersistedSessionMessage[],
    coveredMessageIds: string[],
  ) => {
    const coveredIds = new Set(coveredMessageIds);
    const taskIds = [...new Set(messages
      .filter((message) => coveredIds.has(message.id) && message.taskId)
      .map((message) => message.taskId!))].slice(0, 24);
    const artifactIds: string[] = [];
    const approvalEventIds: string[] = [];
    const unresolvedItems: string[] = messages
      .filter((message) => coveredIds.has(message.id) && message.pending)
      .map((message) => `消息 ${message.id} 尚在处理中。`);
    const durableFacts: string[] = [];
    const approvalTypes = new Set<RuntimeEvent['type']>([
      'approval.requested', 'approval.resolved', 'plan.approval_requested', 'plan.approved', 'plan.rejected',
      'tool.approval_requested', 'tool.approved', 'tool.rejected', 'review.approval_requested', 'review.approved', 'review.rejected',
    ]);
    for (const taskId of taskIds) {
      const task = await store.getTask(taskId, tenantId);
      if (!task || task.userId !== userId || task.sessionId !== sessionId) continue;
      const events = await store.getEvents(taskId).catch(() => []);
      if (!terminalStatuses.has(task.status)) unresolvedItems.push(`任务“${task.title}”当前状态为 ${task.status}。`);
      for (const gap of task.review?.gaps ?? []) unresolvedItems.push(`审查待处理：${gap}`);
      for (const correction of task.review?.requiredCorrections ?? []) unresolvedItems.push(`整改要求：${correction}`);
      for (const event of events) {
        if (approvalTypes.has(event.type)) approvalEventIds.push(event.id);
        if (event.type === 'artifact.created') {
          const id = event.payload.id ?? event.payload.artifactId
            ?? (event.payload.artifact && typeof event.payload.artifact === 'object' ? (event.payload.artifact as { id?: unknown }).id : undefined);
          if (typeof id === 'string' && id) artifactIds.push(id);
        }
        if (event.type === 'agent.conflict') durableFacts.push(`Agent 冲突：${String(event.payload.topic ?? event.payload.reason ?? '已交由审查 Agent 处理')}`);
        if (event.type === 'human.note' || event.type === 'human.guidance_accepted') {
          const message = typeof event.payload.message === 'string' ? event.payload.message : '';
          if (message) durableFacts.push(`人工要求：${message}`);
        }
        if (event.type === 'review.approved') durableFacts.push('人工已批准当前审查结果。');
        if (event.type === 'review.rejected') durableFacts.push('人工已驳回当前结果并要求整改。');
      }
    }
    return { artifactIds, approvalEventIds, unresolvedItems, durableFacts };
  };
  type CreateTaskData = z.infer<typeof createTaskSchema>;

  const taskStage = (task: Awaited<ReturnType<TaskStore['getTask']>>, eventSummary: TaskEventSummary) => {
    if (!task) return 'unknown';
    if (task.status === 'completed') return 'completed';
    if (task.status === 'failed') return 'failed';
    if (task.status === 'cancelled') return 'cancelled';
    if (task.status === 'paused') return 'paused';
    if (task.status === 'waiting_for_human') return 'human review';
    if (task.status === 'awaiting_approval') return 'plan approval';
    const latest = eventSummary.latest;
    if (!latest) return task.status;
    if (latest.type === 'model.completed' && typeof latest.payload.stage === 'string') return latest.payload.stage;
    if ((latest.type === 'agent.started' || latest.type === 'agent.completed') && typeof latest.payload.title === 'string') return latest.payload.title;
    if (latest.type.startsWith('review.')) return 'review';
    if (latest.type.startsWith('tool.')) return typeof latest.payload.name === 'string' ? `tool: ${latest.payload.name}` : 'tool execution';
    if (latest.type.startsWith('plan.')) return 'planning';
    return latest.type.replaceAll('.', ' ');
  };

  const summarizeTask = async (
    task: NonNullable<Awaited<ReturnType<TaskStore['getTask']>>>,
    providedSummary?: TaskEventSummary,
  ) => {
    const summary = providedSummary ?? (await store.getTaskEventSummaries([task.id], task.tenantId)).get(task.id) ?? {
      modelCalls: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      estimatedCostUsd: 0,
      retries: 0,
      toolCalls: 0,
    };
    const source = summary.source;
    const evidenceSummary = summary.latest?.type === 'task.completed'
      ? parseCompletionEvidence(summary.latest.payload.evidenceSummary)
      : undefined;
    // Agent Nexus task cards are projections of the workflow, so a workflow
    // rename is reflected in every existing run without mutating immutable
    // task input/history records.
    const workflow = task.templateId && templates
      ? await templates.getTemplate(task.templateId, task.tenantId)
      : null;
    const displayTitle = (source === 'agent-workflow' || workflow?.definition.kind === 'agent-workflow') && workflow
      ? `${workflow.name} · 执行`
      : task.title;
    const tokens = {
      prompt: summary.promptTokens,
      completion: summary.completionTokens,
      total: summary.totalTokens,
    };
    const attempts = task.stepResults.reduce((total, result) => total + Math.max(0, result.attempts || 0), 0)
      + summary.retries;
    const totalSteps = task.plan?.steps.length ?? 0;
    const queuedAt = summary.queuedAt;
    const startedAt = summary.startedAt;
    return {
      id: task.id,
      runId: task.runId,
      revision: task.revision,
      sessionId: task.sessionId,
      userId: task.userId,
      ...(source ? { source } : {}),
      ...(summary.triggerId ? { triggerId: summary.triggerId } : {}),
      ...(summary.manual !== undefined ? { manual: summary.manual } : {}),
      ...(summary.activeAgentIds ? { activeAgentIds: summary.activeAgentIds } : {}),
      ...(summary.selectedSkillIds ? { selectedSkillIds: summary.selectedSkillIds } : {}),
      templateId: task.templateId ?? null,
      title: displayTitle,
      input: task.input,
      mode: task.mode,
      model: task.model ?? null,
      status: task.status,
      profile: task.plan?.profile ?? null,
      cancelRequested: task.cancelRequested,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      currentStage: taskStage(task, summary),
      durationMs: Math.max(0, new Date(task.updatedAt).getTime() - new Date(task.createdAt).getTime()),
      tokens,
      estimatedCostUsd: summary.estimatedCostUsd,
      modelCalls: summary.modelCalls,
      queueWaitMs: queuedAt && startedAt ? Math.max(0, new Date(startedAt).getTime() - new Date(queuedAt).getTime()) : 0,
      attempts,
      toolCalls: summary.toolCalls,
      pendingToolApprovals: task.toolApprovals?.filter((approval) => approval.status === 'pending').length ?? 0,
      completedSteps: task.stepResults.filter((result) => result.status === 'completed').length,
      totalSteps,
      ...(task.review ? { reviewScore: task.review.score } : {}),
      ...(evidenceSummary ? { evidenceSummary } : {}),
    };
  };

  const messagesFromTask = (task: NonNullable<Awaited<ReturnType<TaskStore['getTask']>>>) => {
    const matches = [...task.input.matchAll(/(?:^|\n\n)(USER|ASSISTANT):\n([\s\S]*?)(?=\n\n(?:USER|ASSISTANT):\n|$)/gi)];
    const messages: PersistedSessionMessage[] = matches.map((match, index) => ({
      id: `${task.id}-message-${index}`,
      role: (match[1]!.toUpperCase() === 'USER' ? 'user' : 'assistant') as PersistedSessionMessage['role'],
      content: match[2]!.trim(),
      createdAt: new Date(task.createdAt).getTime() + index,
      taskId: match[1]!.toUpperCase() === 'ASSISTANT' ? task.id : undefined,
      route: task.plan?.profile?.route,
      agentRole: task.plan?.profile?.route === 'direct' ? 'direct-responder' : 'orchestrator',
    })).filter((message) => message.content.length > 0 || message.role === 'user');
    if (messages.length === 0) {
      messages.push({
        id: `${task.id}-user`,
        role: 'user',
        content: task.input.trim(),
        createdAt: new Date(task.createdAt).getTime(),
      });
    }
    const result = task.result || (task.error ? `工作流失败：${task.error}` : '');
    if (result) {
      const last = messages.at(-1);
      if (last?.role === 'assistant' && !last.content.trim()) last.content = result;
      else messages.push({
        id: `${task.id}-assistant`,
        role: 'assistant',
        content: result,
        createdAt: new Date(task.updatedAt).getTime(),
        taskId: task.id,
        route: task.plan?.profile?.route,
        agentRole: task.plan?.profile?.route === 'direct' ? 'direct-responder' : 'orchestrator',
      });
    }
    return messages.slice(-400);
  };

  const enqueueTask = async (
    input: CreateTaskData,
    tenantId: string,
    userId: string,
    metadata: Record<string, unknown> = {},
    idempotencyKey?: string,
    access: TemplateAccess = { userId, role: 'member' },
  ) => {
    const normalizedIdempotencyKey = idempotencyKey?.trim().slice(0, 160);
    if (normalizedIdempotencyKey) {
      const existing = await store.findTaskByIdempotency(tenantId, normalizedIdempotencyKey);
      if (existing) return { task: existing, eventsUrl: `/api/tasks/${existing.id}/events`, deduplicated: true };
    }
    const template = input.templateId && templates
      ? await templates.getTemplate(input.templateId, tenantId, access)
      : null;
    if (input.templateId && !template) throw new Error('Workflow template not found.');
    if (template && template.status !== 'published') throw new Error('Only published workflow templates can create tasks.');
    let credentialModel: string | undefined;
    let modelCredentialId: string | undefined;
    if (input.modelCredentialId) {
      const credential = dependencies.resolveModelCredential
        ? await dependencies.resolveModelCredential(input.modelCredentialId, tenantId, userId)
        : null;
      if (!credential) throw new Error('Text model credential not found or not owned by the current user.');
      modelCredentialId = credential.id;
      credentialModel = credential.model;
    }
    const effectivePolicy = { ...(template?.definition.policy ?? {}), ...(input.policy ?? {}) };
    const routedPlan = input.routing ? workflowPlanFromChatRoute(input.routing) : undefined;
    const initialPlan = template?.definition.plan ?? routedPlan;
    const createInput = {
      tenantId,
      userId,
      sessionId: input.sessionId,
      templateId: input.templateId,
      title: input.title?.trim() || input.input.trim().slice(0, 80),
      input: [template?.definition.promptPrefix, input.input.trim()].filter(Boolean).join('\n\n'),
      mode: input.mode,
      model: input.model?.trim() || template?.definition.model || credentialModel,
      modelCredentialId,
      policy: effectivePolicy,
      idempotencyKey: normalizedIdempotencyKey,
      plan: initialPlan ? {
        ...initialPlan,
        version: initialPlan.version ?? 1,
        approvalStatus: effectivePolicy.requirePlanApproval ? 'pending' as const : 'approved' as const,
        ...(!effectivePolicy.requirePlanApproval ? {
          approvedAt: initialPlan.approvedAt ?? new Date().toISOString(),
          approvedBy: initialPlan.approvedBy ?? 'runtime-policy',
        } : {}),
      } : undefined,
    } satisfies Parameters<TaskStore['createTask']>[0];
    let task: Awaited<ReturnType<TaskStore['createTask']>>;
    try {
      task = await store.createTask(createInput);
    } catch (error) {
      // The preflight lookup and INSERT are intentionally separate so the
      // normal path stays cheap. Under concurrent webhook/browser retries,
      // the database unique index is the final arbiter; turn that race into
      // the same successful deduplication response as the preflight hit.
      const candidate = error as { code?: unknown; constraint?: unknown; message?: unknown };
      const message = typeof candidate.message === 'string' ? candidate.message : '';
      const idempotencyConflict = normalizedIdempotencyKey
        && (candidate.code === '23505'
          || /(?:idempotency|idx_tasks_idempotency|tasks\.tenant_id, tasks\.idempotency_key)/i.test(message)
          || candidate.constraint === 'idx_tasks_idempotency');
      if (idempotencyConflict) {
        const existing = await store.findTaskByIdempotency(tenantId, normalizedIdempotencyKey);
        if (existing) return { task: existing, eventsUrl: `/api/tasks/${existing.id}/events`, deduplicated: true };
      }
      throw error;
    }
    metrics?.recordTask('created');
    const created = await store.appendEvent(task, {
      type: 'task.created',
      payload: {
        title: task.title,
        mode: task.mode,
        tenantId,
        userId,
        ...(input.routing ? {
          source: metadata.source ?? 'conversation',
          routingVersion: input.routing.routingVersion,
          routerModel: input.routing.routerModel,
          routerConfidence: input.routing.router.confidence,
          activeAgentIds: input.routing.scheduler.activeAgentIds,
          selectedSkillIds: input.routing.scheduler.selectedSkillIds,
        } : {}),
        ...metadata,
      },
    });
    hub.publish(created);
    const queued = await store.appendEvent(task, {
      type: 'task.queued',
      payload: { queue: process.env.DATABASE_URL ? 'postgres-lease' : 'sqlite-lease', ...metadata },
    });
    hub.publish(queued);
    coordinator.nudge();
    return { task, eventsUrl: `/api/tasks/${task.id}/events`, deduplicated: false };
  };

  const liveScheduleRoutingAgents = async (tenantId: string, userId: string): Promise<RoutingAgentDirectoryEntry[]> => {
    const customAgents = agents
      ? await agents.listAgents(tenantId, 100, { userId, role: 'member' }).catch(() => [])
      : [];
    const entries: RoutingAgentDirectoryEntry[] = [
      { id: 'direct-responder', label: '对话 Agent', description: '处理直接说明与轻量内容整理。', capabilities: ['conversation', 'answer'], available: true },
      { id: 'registry-agent', label: 'Agent 目录 Agent', description: '读取实时 Agent 与 Skill 目录。', capabilities: ['agent-registry'], available: true },
      { id: 'vision-agent', label: '视觉分析 Agent', description: '分析图片附件。', capabilities: ['image-analysis', 'vision'], available: true },
      { id: 'document-agent', label: '文档分析 Agent', description: '分析 PDF、Word 与文本附件。', capabilities: ['document-analysis'], available: true },
      { id: 'report-agent', label: '报告生成 Agent', description: '生成可下载的结构化报告。', capabilities: ['report-export', 'document-generation'], available: true },
      ...agentCatalog.filter((agent) => agent.kind === 'worker' || agent.kind === 'quality').map((agent) => ({
        id: agent.role,
        label: agent.label,
        description: agent.description,
        capabilities: agent.capabilities,
        available: true,
      })),
      ...workflowSpecialistCatalog().map((agent) => ({
        id: agent.id,
        label: agent.label,
        description: agent.description,
        capabilities: agent.capabilities,
        available: agent.available,
      })),
      ...customAgents.filter((agent) => agent.status === 'published').map((agent) => ({
        id: agent.roleId,
        label: agent.name,
        description: agent.definition.whenToUseHint || agent.description,
        capabilities: ['custom-agent', ...agent.definition.toolAllowlist],
        available: true,
      })),
    ];
    return entries.filter((entry, index) => entries.findIndex((candidate) => candidate.id === entry.id) === index);
  };

  const ensureScheduledWorkflow = (decision: ChatRouteDecision, objective: string): ChatRouteDecision => {
    if (decision.execution === 'workflow') return decision;
    const agentId = decision.scheduler.activeAgentIds[0] ?? decision.agentRole ?? 'analyst';
    const stepId = 'scheduled-action';
    return chatRouteDecisionSchema.parse({
      ...decision,
      execution: 'workflow',
      agentRole: 'orchestrator',
      workflowRoute: 'single-agent',
      reason: `${decision.reason} 日程触发已转换为可追踪的单 Agent 执行。`,
      scheduler: {
        ...decision.scheduler,
        route: 'single-agent',
        activeAgentIds: [agentId],
        appendAgentIds: [agentId],
        executionWaves: [[stepId]],
        steps: [{
          id: stepId,
          title: '执行本次日程目标',
          agentId,
          objective,
          dependsOn: [],
          skillIds: decision.scheduler.selectedSkillIds,
        }],
        requiresReview: false,
      },
    });
  };

  const routeScheduledTrigger = async (trigger: ScheduledTrigger) => {
    const availableAgents = await liveScheduleRoutingAgents(trigger.tenantId, trigger.userId);
    const routeInput = {
      message: trigger.input,
      mode: trigger.mode,
      availableAgents,
      availableSkills: runtimeSkillCatalog.map((skill) => ({ id: skill.id, label: skill.label, description: skill.description })),
    };
    const routeModel = dependencies.scheduleModelFactory
      ? await dependencies.scheduleModelFactory(trigger.modelCredentialId, trigger.tenantId, trigger.userId)
      : model;
    const decision = routeModel
      ? await routeChatIntent(routeInput, routeModel, AbortSignal.timeout(45_000))
      : fallbackChatRoute(routeInput);
    return ensureScheduledWorkflow(decision, trigger.input);
  };

  const artifactContentForSchedule = async (trigger: ScheduledTrigger) => {
    if (!trigger.inputArtifact) return { input: trigger.input };
    const sourceTask = await store.getTask(trigger.inputArtifact.sourceTaskId, trigger.tenantId);
    if (sourceTask && (sourceTask.userId !== trigger.userId || sourceTask.status !== 'completed')) {
      throw new Error('日程接续的已验证结果已不可用。');
    }
    const content = await artifactStore?.get(trigger.inputArtifact.artifactId, trigger.tenantId) ?? sourceTask?.result;
    if (!content) throw new Error('日程接续的 Artifact 内容已不可用。');
    const contentSha256 = createHash('sha256').update(content, 'utf8').digest('hex');
    if ((sourceTask && sourceTask.revision !== trigger.inputArtifact.sourceTaskRevision) || contentSha256 !== trigger.inputArtifact.contentSha256) {
      throw new Error('日程接续的结果版本已经变化，请重新选择并确认。');
    }
    const excerpt = content.slice(0, 24_000);
    return {
      input: `${trigger.input}\n\n[已验证日程输入]\n来源：${trigger.inputArtifact.title}\nArtifact：${trigger.inputArtifact.artifactId}\n版本：任务 revision ${trigger.inputArtifact.sourceTaskRevision} / sha256 ${trigger.inputArtifact.contentSha256}\n内容：\n${excerpt}${content.length > excerpt.length ? '\n[内容已按上下文预算截断，完整结果保留在 Artifact 中]' : ''}`,
      artifact: trigger.inputArtifact,
    };
  };

  const enqueueScheduledTrigger = async (trigger: ScheduledTrigger, manual = false, requestId?: string) => {
    const linkedInput = await artifactContentForSchedule(trigger);
    const executionTrigger = { ...trigger, input: linkedInput.input };
    const routing = chatRouteDecisionSchema.parse(await routeScheduledTrigger(executionTrigger));
    const idempotencyKey = manual
      ? `schedule:${trigger.id}:manual:${requestId ?? randomUUID()}`
      : `schedule:${trigger.id}:${trigger.nextRunAt}`;
    return enqueueTask(
      { ...executionTrigger, routing },
      trigger.tenantId,
      trigger.userId,
      { triggerId: trigger.id, source: 'schedule', manual, routingSource: routing.source, ...(linkedInput.artifact ? { inputArtifact: linkedInput.artifact } : {}) },
      idempotencyKey,
      { userId: trigger.userId, role: 'member' },
    );
  };

  const scheduler: Scheduler = (process.env.DATABASE_URL
    ? new PostgresScheduler(process.env.DATABASE_URL, async (trigger: ScheduledTrigger) => {
      await enqueueScheduledTrigger(trigger);
    })
    : new InMemoryScheduler(async (trigger: ScheduledTrigger) => {
      await enqueueScheduledTrigger(trigger);
    }));
  void scheduler.ready().then(() => scheduler.start()).catch(() => undefined);

  const notificationFeed = async (principal: ReturnType<typeof identity>) => {
    const [tenantTasks, schedules, artifactCleanup] = await Promise.all([
      store.listTasks(principal.tenantId, 100),
      scheduler.list(principal.tenantId),
      artifactCatalog?.listCleanupCandidates(principal.tenantId, 100) ?? Promise.resolve([]),
    ]);
    const tasks = tenantTasks.filter((task) => task.userId === principal.userId);
    const eventSummaries = await store.getTaskEventSummaries(tasks.map((task) => task.id), principal.tenantId);
    const source = {
      tasks,
      eventSummaries,
      schedules: schedules.filter((schedule) => schedule.userId === principal.userId),
      artifactCleanup,
    };
    const unreadProjection = buildInAppNotifications(source);
    const readIds = new Set(await store.getReadNotificationIds(
      principal.tenantId,
      principal.userId,
      unreadProjection.map((item) => item.id),
    ));
    return buildInAppNotifications({ ...source, readIds });
  };

  const pluginPrompt = (plugin: UserPlugin, rawInput: string, values: Record<string, string | number> | undefined) => {
    const fields = plugin.definition.inputSchema?.fields ?? [];
    const lines = fields.flatMap((field) => {
      const value = values?.[field.id];
      if (value === undefined || String(value).trim() === '') {
        if (field.required) throw new Error(`Plugin input "${field.label}" is required.`);
        return [];
      }
      if (field.type === 'select' && field.options?.length && !field.options.includes(String(value))) {
        throw new Error(`Plugin input "${field.label}" has an invalid option.`);
      }
      if (field.type === 'number' && !Number.isFinite(Number(value))) {
        throw new Error(`Plugin input "${field.label}" must be a number.`);
      }
      return [`${field.label}: ${String(value).trim().slice(0, 8_000)}`];
    });
    const freeform = rawInput.trim().slice(0, 80_000);
    return [plugin.definition.promptPrefix, lines.join('\n'), freeform].filter(Boolean).join('\n\n');
  };

  const parseGeneratedPlugin = (content: string) => {
    const normalized = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    const start = normalized.indexOf('{');
    const end = normalized.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('插件设计 Agent 没有返回结构化草稿。');
    return generatedPluginSchema.parse(JSON.parse(normalized.slice(start, end + 1)));
  };

  const parseGeneratedMiniApp = (content: string) => {
    const normalized = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    const start = normalized.indexOf('{');
    const end = normalized.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('插件开发 Agent 没有返回结构化结果。');
    return generatedMiniAppSchema.parse(JSON.parse(normalized.slice(start, end + 1)));
  };

  api.get('/plugins', async (c) => {
    if (!plugins) return c.json({ error: '插件服务尚未初始化。' }, 503);
    const principal = identity(c.req.raw.headers);
    const requestedLimit = Number(c.req.query('limit') ?? 50);
    const limit = Number.isFinite(requestedLimit) ? Math.min(100, Math.max(1, Math.floor(requestedLimit))) : 50;
    return c.json({ plugins: await plugins.listPlugins(principal.tenantId, limit, templateAccess(principal)) });
  });

  api.get('/plugins/:pluginId/compatibility', async (c) => {
    if (!plugins) return c.json({ error: '插件服务尚未初始化。' }, 503);
    const principal = identity(c.req.raw.headers);
    const plugin = await plugins.getPlugin(c.req.param('pluginId'), principal.tenantId, templateAccess(principal));
    if (!plugin) return c.json({ error: '插件不存在。' }, 404);
    return c.json({ report: inspectPlugin(plugin) });
  });

  api.post('/plugins', async (c) => {
    if (!plugins) return c.json({ error: 'Plugins are not initialized.' }, 503);
    const parsed = createPluginSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Invalid plugin definition.', details: parsed.error.flatten() }, 400);
    const principal = identity(c.req.raw.headers);
    const plugin = await plugins.createPlugin({
      tenantId: principal.tenantId,
      createdBy: principal.userId,
      name: parsed.data.name,
      description: parsed.data.description,
      icon: parsed.data.icon,
      kind: parsed.data.kind,
      visibility: principal.role === 'viewer' ? 'private' : parsed.data.visibility,
      definition: parsed.data.definition as UserPluginDefinition,
    });
    return c.json({ plugin }, 201);
  });

  api.post('/plugins/agent-create', async (c) => {
    if (!plugins) return c.json({ error: '插件服务尚未初始化。' }, 503);
    const parsed = createPluginWithAgentSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: '请完整描述插件用途，并检查模型配置。', details: parsed.error.flatten() }, 400);
    const principal = identity(c.req.raw.headers);
    try {
      const designModel = dependencies.pluginModelFactory
        ? await dependencies.pluginModelFactory(parsed.data.provider, principal.tenantId, principal.userId)
        : model;
      if (!designModel) return c.json({ error: '插件设计 Agent 尚未配置文本模型。' }, 503);
      const availableTools = (toolRegistry?.catalog() ?? []).map((tool) => tool.name);
      const completion = await designModel.complete({
        system: [
          '你是 Axiom 的插件设计 Agent。根据用户目标设计一个可复用的提示词插件草稿。',
          '只返回一个 JSON 对象，不要 Markdown、解释或代码围栏。',
          'JSON 字段必须且只能包含：name、description、mode、promptPrefix、toolNames、fields。',
          'mode 只能是 analyze、build、decide。fields 每项包含 label、type、required，可选 options；type 只能是 text、textarea、number、select。',
          'promptPrefix 要写清角色、约束、执行步骤和输出要求，但不要包含用户本次的具体数据。',
          `可用工具：${availableTools.length ? availableTools.join(', ') : '无'}。toolNames 只能从这个列表选择，没有必要则返回空数组。`,
        ].join('\n'),
        user: parsed.data.goal,
        responseFormat: 'json',
        temperature: 0.15,
        maxTokens: 2_400,
        signal: c.req.raw.signal,
      });
      const generated = parseGeneratedPlugin(completion.content);
      const allowedTools = new Set(availableTools);
      const fields = generated.fields.map((field, index) => ({
        id: `field-${index + 1}`,
        label: field.label,
        type: field.type,
        required: field.required,
        ...(field.type === 'select' && field.options?.length ? { options: field.options } : {}),
      }));
      const plugin = await plugins.createPlugin({
        tenantId: principal.tenantId,
        createdBy: principal.userId,
        name: generated.name,
        description: generated.description,
        kind: 'prompt',
        visibility: principal.role === 'viewer' ? 'private' : parsed.data.visibility,
        definition: {
          mode: generated.mode,
          promptPrefix: generated.promptPrefix,
          toolNames: generated.toolNames.filter((name) => allowedTools.has(name)),
          ...(fields.length ? { inputSchema: { fields } } : {}),
        },
      });
      return c.json({ plugin, generatedBy: { agent: 'plugin-designer', model: designModel.model } }, 201);
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (/API key|API URL|model is not configured|本地服务|互联网/u.test(message)) return c.json({ error: message }, 400);
      return c.json({ error: '插件设计 Agent 暂时无法生成有效草稿，请调整描述或检查文本模型后重试。' }, 502);
    }
  });

  api.post('/plugins/:pluginId/agent-edit', async (c) => {
    if (!plugins) return c.json({ error: '插件服务尚未初始化。' }, 503);
    const parsed = updatePluginWithAgentSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: '请说明需要创建或修改的插件功能。', details: parsed.error.flatten() }, 400);
    const principal = identity(c.req.raw.headers);
    const current = await plugins.getPlugin(c.req.param('pluginId'), principal.tenantId);
    if (!current) return c.json({ error: '插件不存在。' }, 404);
    if (!canManagePlugin(current, principal)) return c.json({ error: '只有插件创建者或租户管理员可以修改此插件。' }, 403);
    if (current.kind !== 'mini-app' || !('htmlContent' in current.definition)) return c.json({ error: '只有小程序插件支持 Agent 对话开发。' }, 409);
    if (current.status === 'archived') return c.json({ error: '已归档插件不能修改。' }, 409);
    try {
      const designModel = dependencies.pluginModelFactory
        ? await dependencies.pluginModelFactory(parsed.data.provider, principal.tenantId, principal.userId)
        : model;
      if (!designModel) return c.json({ error: '插件开发 Agent 尚未配置文本模型。' }, 503);
      const recentConversation = (current.definition.designConversation ?? []).slice(-12)
        .map((message) => `${message.role === 'user' ? '用户' : 'Agent'}：${message.content}`)
        .join('\n');
      const completion = await designModel.complete({
        system: [
          '你是 Axiom 的 Mini App 插件开发 Agent，负责根据用户指令创建或修改一个可直接运行的自包含网页小程序。',
          '只返回一个 JSON 对象，不要 Markdown、解释或代码围栏。JSON 字段必须且只能包含：name（可选）、description（可选）、htmlContent、agentEnabled、agentInstructions、summary。',
          'htmlContent 必须是完整的单文件 HTML，CSS 和 JavaScript 全部内联；不得引用 CDN、外部图片、外部字体或发起 fetch/WebSocket。布局必须适配当前窗口大小并具备清晰的空状态、错误状态和键盘可访问性。',
          '需要模型、实时天气、联网检索、论文或 GitHub 分析时，不要在插件内直连服务。调用平台 Agent 桥：window.parent.postMessage({type:"axiom.plugin.agent.request",requestId,prompt},"*")，并监听 axiom.plugin.agent.delta / axiom.plugin.agent.response；返回内容字段为 content。',
          '只有确实需要平台 Agent 时 agentEnabled 才为 true，并在 agentInstructions 中写明该插件内 Agent 的职责和输出边界；否则返回 false 和空字符串。',
          '修改任务必须返回合并全部已有功能后的完整 HTML，不得只返回补丁。summary 用简短中文说明本轮完成内容。',
        ].join('\n'),
        user: [
          `插件名称：${current.name}`,
          `插件尺寸：${current.definition.width ?? 720} x ${current.definition.height ?? 520}`,
          `既有说明：${current.description || '无'}`,
          recentConversation ? `最近设计对话：\n${recentConversation}` : '',
          `当前完整 HTML：\n${current.definition.htmlContent.slice(0, 120_000)}`,
          `本轮用户指令：\n${parsed.data.instruction}`,
        ].filter(Boolean).join('\n\n'),
        responseFormat: 'json',
        temperature: 0.12,
        maxTokens: 12_000,
        signal: c.req.raw.signal,
      });
      const generated = parseGeneratedMiniApp(completion.content);
      const timestamp = new Date().toISOString();
      const conversation = [
        ...(current.definition.designConversation ?? []),
        { role: 'user' as const, content: parsed.data.instruction, createdAt: timestamp },
        { role: 'assistant' as const, content: generated.summary, createdAt: timestamp },
      ].slice(-24);
      const plugin = await plugins.updatePlugin(current.id, principal.tenantId, {
        updatedBy: principal.userId,
        ...(generated.name ? { name: generated.name } : {}),
        ...(generated.description !== undefined ? { description: generated.description } : {}),
        definition: {
          ...current.definition,
          htmlContent: generated.htmlContent,
          agentEnabled: generated.agentEnabled,
          agentInstructions: generated.agentInstructions,
          designConversation: conversation,
        },
      });
      return c.json({ plugin, message: generated.summary, generatedBy: { agent: 'mini-app-builder', model: designModel.model } });
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (/API key|API URL|model is not configured|本地服务|互联网/u.test(message)) return c.json({ error: message }, 400);
      return c.json({ error: '插件开发 Agent 没有生成可用结果，请缩小修改范围或检查文本模型后重试。' }, 502);
    }
  });

  api.post('/plugins/:pluginId/agent-edit/stream', async (c) => {
    if (!plugins) return c.json({ error: '插件服务尚未初始化。' }, 503);
    const parsed = updatePluginWithAgentSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: '请说明需要创建或修改的插件功能。', details: parsed.error.flatten() }, 400);
    const principal = identity(c.req.raw.headers);
    const current = await plugins.getPlugin(c.req.param('pluginId'), principal.tenantId);
    if (!current) return c.json({ error: '插件不存在。' }, 404);
    if (!canManagePlugin(current, principal)) return c.json({ error: '只有插件创建者或租户管理员可以修改此插件。' }, 403);
    if (current.kind !== 'mini-app' || !('htmlContent' in current.definition)) return c.json({ error: '只有小程序插件支持 Agent 对话开发。' }, 409);
    if (current.status === 'archived') return c.json({ error: '已归档插件不能修改。' }, 409);
    if (!dependencies.pluginModelFactory && !model) return c.json({ error: '插件开发 Agent 尚未配置文本模型。' }, 503);
    const miniAppDefinition = current.definition;

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start: async (controller) => {
        const send = (event: string, data: Record<string, unknown>) => {
          if (c.req.raw.signal.aborted) return;
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        };
        const startedAt = Date.now();
        try {
          send('status', { phase: 'context', message: '插件 Agent 正在读取当前版本' });
          const designModel = dependencies.pluginModelFactory
            ? await dependencies.pluginModelFactory(parsed.data.provider, principal.tenantId, principal.userId)
            : model;
          if (!designModel) throw new Error('插件开发 Agent 尚未配置文本模型。');
          const recentConversation = (miniAppDefinition.designConversation ?? []).slice(-12)
            .map((message) => `${message.role === 'user' ? '用户' : 'Agent'}：${message.content}`)
            .join('\n');
          let generatedChars = 0;
          let lastProgress = 0;
          send('status', { phase: 'inference', message: '插件 Agent 正在生成完整界面' });
          const completion = await designModel.complete({
            system: [
              '你是 Axiom 的 Mini App 插件开发 Agent，负责根据用户指令创建或修改一个可直接运行的自包含网页小程序。',
              '只返回一个 JSON 对象，不要 Markdown、解释或代码围栏。JSON 字段必须且只能包含：name（可选）、description（可选）、htmlContent、agentEnabled、agentInstructions、summary。',
              'htmlContent 必须是完整的单文件 HTML，CSS 和 JavaScript 全部内联；不得引用 CDN、外部图片、外部字体或发起 fetch/WebSocket。布局必须适配当前窗口大小并具备清晰的空状态、错误状态和键盘可访问性。',
              '需要模型、实时天气、联网检索、论文或 GitHub 分析时，不要在插件内直连服务。调用平台 Agent 桥：window.parent.postMessage({type:"axiom.plugin.agent.request",requestId,prompt},"*")，并监听 axiom.plugin.agent.delta / axiom.plugin.agent.response；返回内容字段为 content。',
              '只有确实需要平台 Agent 时 agentEnabled 才为 true，并在 agentInstructions 中写明该插件内 Agent 的职责和输出边界；否则返回 false 和空字符串。',
              '修改任务必须返回合并全部已有功能后的完整 HTML，不得只返回补丁。summary 用简短中文说明本轮完成内容。',
            ].join('\n'),
            user: [
              `插件名称：${current.name}`,
              `插件尺寸：${miniAppDefinition.width ?? 720} x ${miniAppDefinition.height ?? 520}`,
              `既有说明：${current.description || '无'}`,
              recentConversation ? `最近设计对话：\n${recentConversation}` : '',
              `当前完整 HTML：\n${miniAppDefinition.htmlContent.slice(0, 120_000)}`,
              `本轮用户指令：\n${parsed.data.instruction}`,
            ].filter(Boolean).join('\n\n'),
            responseFormat: 'json',
            temperature: 0.12,
            maxTokens: 12_000,
            signal: c.req.raw.signal,
            onDelta: async ({ content }) => {
              if (!content) return;
              generatedChars += content.length;
              if (generatedChars - lastProgress < 480) return;
              lastProgress = generatedChars;
              send('progress', { message: `插件 Agent 已生成约 ${generatedChars} 个字符，正在继续校验` });
            },
            onRetry: async (nextAttempt) => send('status', { phase: 'retry', message: `插件 Agent 正在重试模型请求（第 ${nextAttempt} 次）` }),
          });
          send('status', { phase: 'validation', message: '插件 Agent 正在校验并保存版本' });
          const generated = parseGeneratedMiniApp(completion.content);
          const timestamp = new Date().toISOString();
          const conversation = [
            ...(miniAppDefinition.designConversation ?? []),
            { role: 'user' as const, content: parsed.data.instruction, createdAt: timestamp },
            { role: 'assistant' as const, content: generated.summary, createdAt: timestamp },
          ].slice(-24);
          const plugin = await plugins.updatePlugin(current.id, principal.tenantId, {
            updatedBy: principal.userId,
            ...(generated.name ? { name: generated.name } : {}),
            ...(generated.description !== undefined ? { description: generated.description } : {}),
            definition: {
              ...miniAppDefinition,
              htmlContent: generated.htmlContent,
              agentEnabled: generated.agentEnabled,
              agentInstructions: generated.agentInstructions,
              designConversation: conversation,
            },
          });
          send('complete', {
            plugin,
            message: generated.summary,
            generatedBy: { agent: 'mini-app-builder', model: designModel.model },
            durationMs: Date.now() - startedAt,
          });
        } catch (error) {
          if (!c.req.raw.signal.aborted) {
            const message = error instanceof Error ? error.message : '插件开发 Agent 请求失败。';
            const userMessage = /API key|API URL|model is not configured|本地服务|互联网/u.test(message)
              ? message
              : '插件开发 Agent 没有生成可用结果，请缩小修改范围或检查文本模型后重试。';
            send('error', { message: userMessage });
          }
        } finally {
          controller.close();
        }
      },
    });
    return new Response(stream, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' } });
  });

  api.patch('/plugins/:pluginId', async (c) => {
    if (!plugins) return c.json({ error: '插件服务尚未初始化。' }, 503);
    const parsed = updatePluginSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: '插件修改内容无效。', details: parsed.error.flatten() }, 400);
    const principal = identity(c.req.raw.headers);
    const current = await plugins.getPlugin(c.req.param('pluginId'), principal.tenantId);
    if (!current) return c.json({ error: '插件不存在。' }, 404);
    if (!canManagePlugin(current, principal)) return c.json({ error: '只有插件创建者或租户管理员可以修改此插件。' }, 403);
    if (parsed.data.status === 'published') return c.json({ error: '请使用插件发布操作完成兼容检查。' }, 409);
    try {
      const plugin = await plugins.updatePlugin(current.id, principal.tenantId, {
        updatedBy: principal.userId,
        ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
        ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
        ...(parsed.data.icon !== undefined ? { icon: parsed.data.icon } : {}),
        ...(parsed.data.visibility !== undefined ? { visibility: parsed.data.visibility } : {}),
        ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}),
        ...(parsed.data.definition !== undefined ? { definition: parsed.data.definition as UserPluginDefinition } : {}),
      });
      return c.json({ plugin });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Plugin update failed.';
      return c.json({ error: message }, /not found/i.test(message) ? 404 : 409);
    }
  });

  api.post('/plugins/:pluginId/publish', async (c) => {
    if (!plugins) return c.json({ error: '插件服务尚未初始化。' }, 503);
    const principal = identity(c.req.raw.headers);
    const current = await plugins.getPlugin(c.req.param('pluginId'), principal.tenantId);
    if (!current) return c.json({ error: '插件不存在。' }, 404);
    if (!canManagePlugin(current, principal)) return c.json({ error: '只有插件创建者或租户管理员可以发布此插件。' }, 403);
    if (pluginSignatureRequired && !pluginSigningKey) {
      return c.json({ error: '部署要求插件签名，但服务端尚未配置签名密钥。', report: inspectPlugin(current) }, 503);
    }
    const report = inspectPluginForPublish(current);
    if (!report.compatible) return c.json({ error: '插件未通过发布检查。', report }, 409);
    const release = createPluginRelease(current, report, principal.userId, pluginSigningKey);
    try {
      const plugin = await plugins.publishPlugin(current.id, principal.tenantId, release);
      return c.json({ plugin, report: inspectPlugin(plugin) });
    } catch (error) {
      const message = error instanceof Error ? error.message : '插件发布失败。';
      return c.json({ error: message }, /not found/i.test(message) ? 404 : 409);
    }
  });

  api.post('/plugins/:pluginId/rollback', async (c) => {
    if (!plugins) return c.json({ error: '插件服务尚未初始化。' }, 503);
    const parsed = rollbackPluginSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: '请选择需要恢复的历史版本。' }, 400);
    const principal = identity(c.req.raw.headers);
    const current = await plugins.getPlugin(c.req.param('pluginId'), principal.tenantId);
    if (!current) return c.json({ error: '插件不存在。' }, 404);
    if (!canManagePlugin(current, principal)) return c.json({ error: '只有插件创建者或租户管理员可以恢复版本。' }, 403);
    try {
      const plugin = await plugins.rollbackPlugin(current.id, principal.tenantId, parsed.data.version, principal.userId);
      return c.json({ plugin, report: inspectPlugin(plugin) });
    } catch (error) {
      const message = error instanceof Error ? error.message : '插件版本恢复失败。';
      return c.json({ error: message }, /not found/i.test(message) ? 404 : 409);
    }
  });

  api.post('/plugins/:pluginId/launch', async (c) => {
    if (!plugins) return c.json({ error: '插件服务尚未初始化。' }, 503);
    const principal = identity(c.req.raw.headers);
    const plugin = await plugins.getPlugin(c.req.param('pluginId'), principal.tenantId, templateAccess(principal));
    if (!plugin) return c.json({ error: '插件不存在。' }, 404);
    if (plugin.kind !== 'mini-app') return c.json({ error: '只有 Mini App 插件可以在独立窗口中打开。' }, 409);
    if (plugin.status !== 'published') {
      if (!canManagePlugin(plugin, principal)) return c.json({ error: '只有插件创建者或租户管理员可以预览草稿。' }, 403);
      return c.json({ plugin, mode: 'preview' as const, report: inspectPlugin(plugin) });
    }
    const report = inspectPlugin(plugin);
    if (!report.compatible) return c.json({ error: '插件当前版本未通过运行检查，请修复后重新发布。', report }, 409);
    return c.json({ plugin, mode: 'run' as const, report });
  });

  api.delete('/plugins/:pluginId', async (c) => {
    if (!plugins) return c.json({ error: '插件服务尚未初始化。' }, 503);
    const principal = identity(c.req.raw.headers);
    const current = await plugins.getPlugin(c.req.param('pluginId'), principal.tenantId);
    if (!current) return c.json({ error: '插件不存在。' }, 404);
    if (!canManagePlugin(current, principal)) return c.json({ error: '只有插件创建者或租户管理员可以删除此插件。' }, 403);
    if (!await plugins.deletePlugin(current.id, principal.tenantId)) return c.json({ error: '插件删除失败。' }, 409);
    return c.body(null, 204);
  });

  api.post('/plugins/:pluginId/run', async (c) => {
    if (!plugins) return c.json({ error: '插件服务尚未初始化。' }, 503);
    const parsed = runPluginSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'A plugin session and input are required.', details: parsed.error.flatten() }, 400);
    const principal = identity(c.req.raw.headers);
    const plugin = await plugins.getPlugin(c.req.param('pluginId'), principal.tenantId, templateAccess(principal));
    if (!plugin) return c.json({ error: '插件不存在。' }, 404);
    if (plugin.kind === 'mini-app') return c.json({ error: 'Mini-app plugins open in the client window and do not create a workflow task.' }, 409);
    if (plugin.status !== 'published') return c.json({ error: '只有已发布插件可以运行。' }, 409);
    const compatibility = inspectPlugin(plugin);
    if (!compatibility.compatible) return c.json({ error: '插件当前版本未通过运行检查，请修复后重新发布。', report: compatibility }, 409);
    try {
      const input = pluginPrompt(plugin, parsed.data.input ?? '', parsed.data.values);
      if (!input.trim()) return c.json({ error: 'Plugin input is required.' }, 400);
      const result = await enqueueTask({
        sessionId: parsed.data.sessionId,
        title: parsed.data.title?.trim() || plugin.name,
        input,
        mode: plugin.definition.mode,
        model: plugin.definition.model,
        policy: parsed.data.policy,
      }, principal.tenantId, principal.userId, { source: 'plugin', pluginId: plugin.id, pluginVersion: plugin.version }, c.req.header('idempotency-key'), templateAccess(principal));
      return c.json({ ...result, pluginId: plugin.id, pluginVersion: plugin.version }, 202);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Plugin run failed.';
      return c.json({ error: message }, 409);
    }
  });

  api.get('/agents/custom', async (c) => {
    if (!agents) return c.json({ error: 'Agent Studio is not initialized.' }, 503);
    const principal = identity(c.req.raw.headers);
    const requestedLimit = Number(c.req.query('limit') ?? 50);
    const limit = Number.isFinite(requestedLimit) ? Math.min(100, Math.max(1, Math.floor(requestedLimit))) : 50;
    return c.json({ agents: await agents.listAgents(principal.tenantId, limit, templateAccess(principal)) });
  });

  api.post('/agents/custom', async (c) => {
    if (!agents) return c.json({ error: 'Agent Studio is not initialized.' }, 503);
    const parsed = createAgentSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Invalid agent definition.', details: parsed.error.flatten() }, 400);
    const principal = identity(c.req.raw.headers);
    if (isBuiltinRoleId(parsed.data.roleId.trim().toLowerCase())) {
      return c.json({ error: `Role id "${parsed.data.roleId}" conflicts with a built-in Axiom role (planner/researcher/analyst/builder/reviewer/synthesizer).` }, 409);
    }
    try {
      const agent = await agents.createAgent({
        tenantId: principal.tenantId,
        createdBy: principal.userId,
        roleId: parsed.data.roleId,
        name: parsed.data.name,
        description: parsed.data.description,
        icon: parsed.data.icon,
        kind: parsed.data.kind,
        visibility: principal.role === 'viewer' ? 'private' : parsed.data.visibility,
        definition: parsed.data.definition as UserDefinedAgentDefinition,
      });
      return c.json({ agent }, 201);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Agent creation failed.';
      return c.json({ error: message }, 409);
    }
  });

  api.patch('/agents/custom/:agentId', async (c) => {
    if (!agents) return c.json({ error: 'Agent Studio is not initialized.' }, 503);
    const parsed = updateAgentSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Invalid agent update.', details: parsed.error.flatten() }, 400);
    const principal = identity(c.req.raw.headers);
    const current = await agents.getAgent(c.req.param('agentId'), principal.tenantId);
    if (!current) return c.json({ error: 'Agent not found.' }, 404);
    if (!canManageAgent(current, principal)) return c.json({ error: 'Only the agent owner or tenant admin can edit this agent.' }, 403);
    try {
      const agent = await agents.updateAgent(current.id, principal.tenantId, {
        updatedBy: principal.userId,
        ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
        ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
        ...(parsed.data.icon !== undefined ? { icon: parsed.data.icon } : {}),
        ...(parsed.data.visibility !== undefined ? { visibility: parsed.data.visibility } : {}),
        ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}),
        ...(parsed.data.definition !== undefined ? { definition: parsed.data.definition as UserDefinedAgentDefinition } : {}),
      });
      return c.json({ agent });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Agent update failed.';
      return c.json({ error: message }, /not found/i.test(message) ? 404 : 409);
    }
  });

  api.post('/agents/custom/:agentId/publish', async (c) => {
    if (!agents) return c.json({ error: 'Agent Studio is not initialized.' }, 503);
    const principal = identity(c.req.raw.headers);
    const current = await agents.getAgent(c.req.param('agentId'), principal.tenantId);
    if (!current) return c.json({ error: 'Agent not found.' }, 404);
    if (!canManageAgent(current, principal)) return c.json({ error: 'Only the agent owner or tenant admin can publish this agent.' }, 403);
    if (!current.definition.systemPromptTemplate.trim()) return c.json({ error: 'Agent needs a system prompt before publishing.' }, 409);
    const configuredTools = new Set((toolRegistry?.catalog() ?? []).map((tool) => tool.name));
    const unavailableTool = current.definition.toolAllowlist.find((name) => !configuredTools.has(name));
    if (unavailableTool) return c.json({ error: `Agent references unavailable tool: ${unavailableTool}.` }, 409);
    const agent = await agents.updateAgent(current.id, principal.tenantId, { updatedBy: principal.userId, status: 'published' });
    return c.json({ agent });
  });

  api.post('/agents/custom/:agentId/archive', async (c) => {
    if (!agents) return c.json({ error: 'Agent Studio is not initialized.' }, 503);
    const principal = identity(c.req.raw.headers);
    const current = await agents.getAgent(c.req.param('agentId'), principal.tenantId);
    if (!current) return c.json({ error: 'Agent not found.' }, 404);
    if (!canManageAgent(current, principal)) return c.json({ error: 'Only the agent owner or tenant admin can archive this agent.' }, 403);
    const agent = await agents.updateAgent(current.id, principal.tenantId, { updatedBy: principal.userId, status: 'archived' });
    return c.json({ agent });
  });

  api.get('/runtime/health', async (c) => {
    const harnessProbe = harnessHandshake(c.req.raw.signal);
    const [readiness, harnessStatus] = await Promise.all([
      getRuntimeReadiness({ ...readinessDependencies, harness: { handshake: () => harnessProbe } }),
      harnessProbe,
    ]);
    return c.json({
      status: readiness.state,
      persistence: process.env.DATABASE_URL ? 'postgresql' : 'sqlite',
      workerConcurrency: Number(process.env.AGENT_TASK_CONCURRENCY ?? 2),
      stepConcurrency: Number(process.env.AGENT_STEP_CONCURRENCY ?? 3),
      memory: Boolean(process.env.TDAI_MEMORY_ENDPOINT),
      harness: harnessStatus,
    });
  });

  api.get('/runtime/readiness', async (c) => c.json(await getRuntimeReadiness(readinessDependencies)));

  api.get('/memory/capture-stats', async (c) => {
    const principal = identity(c.req.raw.headers);
    return c.json({ stats: await memory.captureStats(principal.tenantId, principal.userId) });
  });

  api.patch('/memory/atomic/:memoryId', async (c) => {
    const principal = identity(c.req.raw.headers);
    if (principal.role === 'viewer') return c.json({ error: '只读成员不能修改长期记忆。' }, 403);
    const parsed = memoryAtomicUpdateSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: '记忆内容、Agent 范围或会话范围不合法。' }, 400);
    try {
      const memoryItem = await memory.updateAtomic({
        tenantId: principal.tenantId,
        userId: principal.userId,
        agentId: parsed.data.agentId,
        sessionId: parsed.data.sessionId,
      }, c.req.param('memoryId'), parsed.data.content, parsed.data.background, c.req.raw.signal);
      return c.json({ memory: memoryItem });
    } catch (error) {
      const failure = memoryFailure(error);
      return c.json(failure.body, failure.status);
    }
  });

  api.delete('/memory/atomic/:memoryId', async (c) => {
    const principal = identity(c.req.raw.headers);
    if (principal.role === 'viewer') return c.json({ error: '只读成员不能删除长期记忆。' }, 403);
    const parsed = memoryAtomicDeleteSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Agent 范围或会话范围不合法。' }, 400);
    try {
      const result = await memory.deleteAtomic({
        tenantId: principal.tenantId,
        userId: principal.userId,
        agentId: parsed.data.agentId,
        sessionId: parsed.data.sessionId,
      }, [c.req.param('memoryId')], c.req.raw.signal);
      return c.json(result);
    } catch (error) {
      const failure = memoryFailure(error);
      return c.json(failure.body, failure.status);
    }
  });

  api.delete('/memory/conversations', async (c) => {
    const principal = identity(c.req.raw.headers);
    if (principal.role === 'viewer') return c.json({ error: '只读成员不能删除长期记忆。' }, 403);
    const parsed = memoryConversationDeleteSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: '需要提供要删除的消息或会话，并指定 Agent 范围。' }, 400);
    try {
      const result = await memory.deleteConversation({
        tenantId: principal.tenantId,
        userId: principal.userId,
        agentId: parsed.data.agentId,
        sessionId: parsed.data.sessionId,
      }, parsed.data, c.req.raw.signal);
      return c.json(result);
    } catch (error) {
      const failure = memoryFailure(error);
      return c.json(failure.body, failure.status);
    }
  });

  api.get('/memory/scenario', async (c) => {
    const principal = identity(c.req.raw.headers);
    const parsed = memoryScenarioReadSchema.safeParse({
      agentId: c.req.query('agentId'), sessionId: c.req.query('sessionId') || undefined, path: c.req.query('path'),
    });
    if (!parsed.success) return c.json({ error: '需要合法的 Agent ID 和相对场景路径。' }, 400);
    try {
      const scenario = await memory.readScenario({
        tenantId: principal.tenantId, userId: principal.userId, agentId: parsed.data.agentId, sessionId: parsed.data.sessionId,
      }, parsed.data.path, c.req.raw.signal);
      return c.json({ scenario });
    } catch (error) {
      const failure = memoryFailure(error);
      return c.json(failure.body, failure.status);
    }
  });

  api.put('/memory/scenario', async (c) => {
    const principal = identity(c.req.raw.headers);
    if (!canGovernLongTermMemory(principal)) return c.json({ error: '只有租户管理员可以修改 L2 场景记忆。' }, 403);
    const parsed = memoryScenarioWriteSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: '场景记忆内容或路径不合法。' }, 400);
    try {
      const scenario = await memory.writeScenario({
        tenantId: principal.tenantId, userId: principal.userId, agentId: parsed.data.agentId, sessionId: parsed.data.sessionId,
      }, parsed.data.path, parsed.data.content, parsed.data.summary, c.req.raw.signal);
      return c.json({ scenario });
    } catch (error) {
      const failure = memoryFailure(error);
      return c.json(failure.body, failure.status);
    }
  });

  api.delete('/memory/scenario', async (c) => {
    const principal = identity(c.req.raw.headers);
    if (!canGovernLongTermMemory(principal)) return c.json({ error: '只有租户管理员可以删除 L2 场景记忆。' }, 403);
    const parsed = memoryScenarioReadSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: '需要合法的 Agent ID 和相对场景路径。' }, 400);
    try {
      const result = await memory.removeScenario({
        tenantId: principal.tenantId, userId: principal.userId, agentId: parsed.data.agentId, sessionId: parsed.data.sessionId,
      }, parsed.data.path, c.req.raw.signal);
      return c.json(result);
    } catch (error) {
      const failure = memoryFailure(error);
      return c.json(failure.body, failure.status);
    }
  });

  api.get('/memory/core', async (c) => {
    const principal = identity(c.req.raw.headers);
    const parsed = memoryAgentScopeSchema.safeParse({ agentId: c.req.query('agentId'), sessionId: c.req.query('sessionId') || undefined });
    if (!parsed.success) return c.json({ error: '需要合法的 Agent ID。' }, 400);
    try {
      const core = await memory.readCore({
        tenantId: principal.tenantId, userId: principal.userId, agentId: parsed.data.agentId, sessionId: parsed.data.sessionId,
      }, c.req.raw.signal);
      return c.json({ core });
    } catch (error) {
      const failure = memoryFailure(error);
      return c.json(failure.body, failure.status);
    }
  });

  api.put('/memory/core', async (c) => {
    const principal = identity(c.req.raw.headers);
    if (!canGovernLongTermMemory(principal)) return c.json({ error: '只有租户管理员可以修改 L3 核心画像。' }, 403);
    const parsed = memoryCoreWriteSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: '核心画像内容或 Agent 范围不合法。' }, 400);
    try {
      const core = await memory.writeCore({
        tenantId: principal.tenantId, userId: principal.userId, agentId: parsed.data.agentId, sessionId: parsed.data.sessionId,
      }, parsed.data.content, c.req.raw.signal);
      return c.json({ core });
    } catch (error) {
      const failure = memoryFailure(error);
      return c.json(failure.body, failure.status);
    }
  });

  api.get('/runtime/capabilities', async (c) => c.json({
    readiness: await getRuntimeReadiness(readinessDependencies),
    harness: await harnessHandshake(c.req.raw.signal),
    memory: await memory.health(c.req.raw.signal),
    sandbox: await toolExecutor.probe(),
    routes: ['direct', 'single-agent', 'team', 'full-workflow'],
    agents: agentCatalog.map(({ id, role, label, capabilities }) => ({ id, role, label, capabilities })),
    skills: runtimeSkillCatalog.map(({ id, label, description, roles }) => ({ id, label, description, roles })),
    execution: {
      eventStream: 'sse-replayable',
      persistence: process.env.DATABASE_URL ? 'postgresql' : 'sqlite',
      toolExecutor: { ...toolExecutor.describe(), probe: await toolExecutor.probe() },
      tools: toolRegistry?.catalog() ?? [],
    },
  }));

  api.get('/runtime/skills', (c) => c.json({
    skills: runtimeSkillCatalog.map(({ id, label, description, roles }) => ({ id, label, description, roles })),
  }));

  api.get('/runtime/tools', async (c) => c.json({
    enabled: Boolean(toolRegistry?.enabled()),
    executor: { ...toolExecutor.describe(), probe: await toolExecutor.probe() },
    quotas: { maxCallsPerTask: Number(process.env.AXIOM_TOOL_MAX_CALLS_PER_TASK ?? 8) },
    tools: toolRegistry?.catalog() ?? [],
  }));

  api.get('/runtime/metrics', (c) => {
    if (!metrics) return c.json({ error: 'Metrics are not initialized.' }, 503);
    c.header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    return c.body(metrics.prometheus());
  });

  api.get('/runtime/stats', (c) => c.json(metrics?.snapshot() ?? null));

  api.get('/runtime/operations', async (c) => {
    const { tenantId } = identity(c.req.raw.headers);
    const requestedHours = Number(c.req.query('hours') ?? 24);
    const hours = Number.isFinite(requestedHours) ? Math.min(168, Math.max(1, Math.floor(requestedHours))) : 24;
    const snapshot = await store.getOperationsSnapshot(tenantId, hours);
    return c.json({ ...snapshot, ...(artifactCatalog ? { artifacts: await artifactCatalog.stats(tenantId) } : {}) });
  });

  api.get('/runtime/alerts', async (c) => {
    const { tenantId } = identity(c.req.raw.headers);
    const requestedHours = Number(c.req.query('hours') ?? 24);
    const hours = Number.isFinite(requestedHours) ? Math.min(168, Math.max(1, Math.floor(requestedHours))) : 24;
    const [baseSnapshot, readiness] = await Promise.all([
      store.getOperationsSnapshot(tenantId, hours),
      getRuntimeReadiness(readinessDependencies),
    ]);
    const snapshot = artifactCatalog
      ? { ...baseSnapshot, artifacts: await artifactCatalog.stats(tenantId) }
      : baseSnapshot;
    return c.json(buildOperationsAlerts(snapshot, readiness));
  });

  api.get('/runtime/artifacts', async (c) => {
    if (!artifactCatalog) return c.json({ error: 'Artifact 生命周期目录尚未初始化。' }, 503);
    const { tenantId } = identity(c.req.raw.headers);
    const requestedLimit = Number(c.req.query('limit') ?? 50);
    const limit = Number.isFinite(requestedLimit) ? Math.min(500, Math.max(1, Math.floor(requestedLimit))) : 50;
    return c.json({ stats: await artifactCatalog.stats(tenantId), orphans: await artifactCatalog.listOrphans(tenantId, limit) });
  });

  api.post('/runtime/artifacts/cleanup', async (c) => {
    if (!artifactCatalog) return c.json({ error: 'Artifact 生命周期目录尚未初始化。' }, 503);
    const principal = identity(c.req.raw.headers);
    if (principal.role !== 'owner' && principal.role !== 'admin') return c.json({ error: '只有租户管理员可以执行 Artifact 清理。' }, 403);
    const requestedLimit = Number(c.req.query('limit') ?? 50);
    const limit = Number.isFinite(requestedLimit) ? Math.min(500, Math.max(1, Math.floor(requestedLimit))) : 50;
    const candidates = await artifactCatalog.listCleanupCandidates(principal.tenantId, limit);
    let deleted = 0;
    let failed = 0;
    for (const candidate of candidates) {
      await artifactCatalog.markDeletePending(principal.tenantId, candidate.id, '生命周期清理任务。');
      try {
        if (!artifactStore) throw new Error('Artifact 存储未配置。');
        await artifactStore.delete(candidate.id, principal.tenantId);
        await artifactCatalog.markDeleted(principal.tenantId, candidate.id);
        deleted += 1;
      } catch (error) {
        await artifactCatalog.recordCleanupFailure(principal.tenantId, candidate.id, error instanceof Error ? error.message : 'Artifact 删除失败。');
        failed += 1;
      }
    }
    return c.json({ scanned: candidates.length, deleted, failed, stats: await artifactCatalog.stats(principal.tenantId) });
  });

  api.get('/runtime/triggers', (c) => c.json({
    webhook: Boolean(process.env.AXIOM_WEBHOOK_SECRET),
    scheduler: {
      enabled: process.env.AXIOM_SCHEDULER_ENABLED !== 'false',
      persistence: process.env.DATABASE_URL ? 'postgresql' : 'memory-single-node',
    },
  }));

  api.post('/runtime/triage', async (c) => {
    const body = await c.req.json().catch(() => null) as { input?: unknown; mode?: unknown } | null;
    const input = typeof body?.input === 'string' ? body.input.trim() : '';
    const mode = body?.mode === 'build' || body?.mode === 'decide' ? body.mode : 'analyze';
    if (!input) return c.json({ error: 'A triage input is required.' }, 400);
    return c.json({ profile: classifyTask(input, mode) });
  });

  api.get('/agents', (c) => c.json({ agents: [...agentCatalog, ...workflowSpecialistCatalog()] }));

  api.get('/workflows', async (c) => {
    if (!templates) return c.json({ error: '工作流存储尚未初始化。' }, 503);
    const principal = identity(c.req.raw.headers);
    const items = await templates.listTemplates(principal.tenantId, 100, templateAccess(principal), 'agent-workflow');
    return c.json({ workflows: items.filter((item) => item.status !== 'archived') });
  });

  api.get('/workflows/:workflowId', async (c) => {
    if (!templates) return c.json({ error: '工作流存储尚未初始化。' }, 503);
    const principal = identity(c.req.raw.headers);
    const workflow = await templates.getTemplate(c.req.param('workflowId'), principal.tenantId, templateAccess(principal));
    if (!workflow || !isAgentWorkflow(workflow) || workflow.status === 'archived') return c.json({ error: '工作流不存在。' }, 404);
    return c.json({ workflow });
  });

  const compileWorkflowForPrincipal = async (canvas: AgentWorkflowCanvas, principal: ReturnType<typeof identity>) => {
    const platformAgents = agents
      ? (await agents.listAgents(principal.tenantId, 100, templateAccess(principal))).filter((agent) => agent.status === 'published')
      : [];
    const availableTools = (toolRegistry?.catalog() ?? []).map((tool) => tool.name);
    return compileAgentWorkflow(canvas, platformAgents, availableTools);
  };

  api.post('/workflows/validate', async (c) => {
    const parsed = agentWorkflowCanvasSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ valid: false, issues: [{ code: 'invalid-schema', message: '工作流结构无效。' }], details: parsed.error.flatten() }, 400);
    const principal = identity(c.req.raw.headers);
    const compiled = await compileWorkflowForPrincipal(parsed.data as AgentWorkflowCanvas, principal);
    return c.json({ valid: compiled.issues.length === 0, issues: compiled.issues, plan: compiled.issues.length === 0 ? compiled.plan : undefined });
  });

  api.post('/workflows', async (c) => {
    if (!templates) return c.json({ error: '工作流存储尚未初始化。' }, 503);
    const parsed = saveAgentWorkflowSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: '工作流定义无效。', details: parsed.error.flatten() }, 400);
    const principal = identity(c.req.raw.headers);
    const canvas = parsed.data.canvas as AgentWorkflowCanvas;
    const compiled = await compileWorkflowForPrincipal(canvas, principal);
    if (compiled.issues.length) return c.json({ error: '工作流尚未通过执行校验。', issues: compiled.issues }, 409);
    const agentIds = [...new Set(compiled.plan.steps.map((step) => step.agentContract?.agentId ?? step.role))];
    const toolNames = [...new Set(compiled.plan.steps.flatMap((step) => step.toolNames ?? []))];
    const created = await templates.createTemplate({
      tenantId: principal.tenantId,
      createdBy: principal.userId,
      name: parsed.data.name.trim(),
      description: parsed.data.description.trim(),
      visibility: principal.role === 'viewer' ? 'private' : parsed.data.visibility,
      definition: {
        kind: 'agent-workflow',
        mode: 'analyze',
        policy: { requirePlanApproval: false, maxConcurrentSteps: 6 },
        agentIds,
        toolNames,
        plan: compiled.plan,
        workflow: canvas,
      },
    });
    const workflow = await templates.updateTemplate(created.id, principal.tenantId, { status: 'published', updatedBy: principal.userId });
    return c.json({ workflow }, 201);
  });

  api.patch('/workflows/:workflowId', async (c) => {
    if (!templates) return c.json({ error: '工作流存储尚未初始化。' }, 503);
    const parsed = saveAgentWorkflowSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: '工作流定义无效。', details: parsed.error.flatten() }, 400);
    const principal = identity(c.req.raw.headers);
    const current = await templates.getTemplate(c.req.param('workflowId'), principal.tenantId);
    if (!current || !isAgentWorkflow(current)) return c.json({ error: '工作流不存在。' }, 404);
    if (!canManageTemplate(current, principal)) return c.json({ error: '只有工作流创建者或租户管理员可以修改。' }, 403);
    const canvas = parsed.data.canvas as AgentWorkflowCanvas;
    const compiled = await compileWorkflowForPrincipal(canvas, principal);
    if (compiled.issues.length) return c.json({ error: '工作流尚未通过执行校验。', issues: compiled.issues }, 409);
    const agentIds = [...new Set(compiled.plan.steps.map((step) => step.agentContract?.agentId ?? step.role))];
    const toolNames = [...new Set(compiled.plan.steps.flatMap((step) => step.toolNames ?? []))];
    const workflow = await templates.updateTemplate(current.id, principal.tenantId, {
      name: parsed.data.name.trim(),
      description: parsed.data.description.trim(),
      visibility: principal.role === 'viewer' ? 'private' : parsed.data.visibility,
      status: 'published',
      updatedBy: principal.userId,
      definition: {
        kind: 'agent-workflow',
        mode: current.definition.mode,
        model: current.definition.model,
        policy: { ...current.definition.policy, requirePlanApproval: false },
        agentIds,
        toolNames,
        plan: { ...compiled.plan, version: current.version + 1 },
        workflow: canvas,
      },
    });
    return c.json({ workflow });
  });

  api.delete('/workflows/:workflowId', async (c) => {
    if (!templates) return c.json({ error: '工作流存储尚未初始化。' }, 503);
    const principal = identity(c.req.raw.headers);
    const current = await templates.getTemplate(c.req.param('workflowId'), principal.tenantId);
    if (!current || !isAgentWorkflow(current)) return c.json({ error: '工作流不存在。' }, 404);
    if (!canManageTemplate(current, principal)) return c.json({ error: '只有工作流创建者或租户管理员可以删除。' }, 403);
    await templates.updateTemplate(current.id, principal.tenantId, { status: 'archived', updatedBy: principal.userId });
    await deleteTerminalWorkflowTasks(store, current.id, principal.tenantId, cleanupTaskArtifacts);
    return c.body(null, 204);
  });

  api.post('/workflows/:workflowId/run', async (c) => {
    if (!templates) return c.json({ error: '工作流存储尚未初始化。' }, 503);
    const parsed = runAgentWorkflowSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: '工作流输入无效。', details: parsed.error.flatten() }, 400);
    const principal = identity(c.req.raw.headers);
    const workflow = await templates.getTemplate(c.req.param('workflowId'), principal.tenantId, templateAccess(principal));
    if (!workflow || !isAgentWorkflow(workflow) || workflow.status !== 'published') return c.json({ error: '工作流不存在或尚未发布。' }, 404);
    try {
      return c.json(await enqueueTask({
        sessionId: parsed.data.sessionId,
        templateId: workflow.id,
        title: parsed.data.title ?? `${workflow.name} · 执行`,
        input: parsed.data.input,
        mode: workflow.definition.mode,
        model: parsed.data.model,
        modelCredentialId: parsed.data.modelCredentialId,
        policy: parsed.data.policy,
      }, principal.tenantId, principal.userId, { source: 'agent-workflow', workflowId: workflow.id, workflowVersion: workflow.version }, c.req.header('idempotency-key'), templateAccess(principal)), 202);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : '工作流启动失败。' }, 409);
    }
  });

  api.get('/template-catalog', (c) => c.json({ templates: builtInTemplates }));

  api.get('/templates', async (c) => {
    if (!templates) return c.json({ error: 'Workflow templates are not initialized.' }, 503);
    const principal = identity(c.req.raw.headers);
    const requestedLimit = Number(c.req.query('limit') ?? 50);
    const limit = Number.isFinite(requestedLimit) ? Math.min(100, Math.max(1, Math.floor(requestedLimit))) : 50;
    return c.json({ templates: await templates.listTemplates(principal.tenantId, limit, templateAccess(principal), 'template') });
  });

  api.post('/templates', async (c) => {
    if (!templates) return c.json({ error: 'Workflow templates are not initialized.' }, 503);
    const parsed = createTemplateSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Invalid workflow template.', details: parsed.error.flatten() }, 400);
    const { tenantId, userId, role } = identity(c.req.raw.headers);
    const definition = parsed.data.definition as WorkflowTemplateDefinition;
    const template = await templates.createTemplate({
      tenantId,
      createdBy: userId,
      name: parsed.data.name.trim(),
      description: parsed.data.description.trim(),
      definition,
      visibility: role === 'viewer' ? 'private' : parsed.data.visibility,
    });
    return c.json({ template }, 201);
  });

  api.post('/templates/from-catalog', async (c) => {
    if (!templates) return c.json({ error: 'Workflow templates are not initialized.' }, 503);
    const parsed = catalogTemplateSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Invalid template catalog selection.', details: parsed.error.flatten() }, 400);
    const principal = identity(c.req.raw.headers);
    const catalog = getBuiltInTemplate(parsed.data.catalogId);
    if (!catalog) return c.json({ error: 'Built-in template not found.' }, 404);
    const template = await templates.createTemplate({
      tenantId: principal.tenantId,
      createdBy: principal.userId,
      name: parsed.data.name?.trim() || catalog.name,
      description: catalog.description,
      definition: catalog.definition,
      visibility: principal.role === 'viewer' ? 'private' : parsed.data.visibility,
    });
    return c.json({ template, catalogId: catalog.id }, 201);
  });

  api.post('/templates/import', async (c) => {
    if (!templates) return c.json({ error: 'Workflow templates are not initialized.' }, 503);
    const parsed = importTemplateSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Invalid workflow template bundle.', details: parsed.error.flatten() }, 400);
    const principal = identity(c.req.raw.headers);
    const template = await templates.createTemplate({
      tenantId: principal.tenantId,
      createdBy: principal.userId,
      name: parsed.data.name?.trim() || parsed.data.template.name.trim(),
      description: parsed.data.description?.trim() || parsed.data.template.description.trim(),
      definition: parsed.data.template.definition as WorkflowTemplateDefinition,
      // Imported bundles always start as drafts. Sharing is an explicit choice
      // made by the importing operator after reviewing the definition.
      visibility: 'private',
    });
    return c.json({ template, importedFromVersion: parsed.data.schemaVersion }, 201);
  });

  api.post('/tasks/:taskId/template', async (c) => {
    if (!templates) return c.json({ error: 'Workflow templates are not initialized.' }, 503);
    const parsed = saveTaskTemplateSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'A template name is required.', details: parsed.error.flatten() }, 400);
    const principal = identity(c.req.raw.headers);
    const { tenantId, userId } = principal;
    const task = await store.getTask(c.req.param('taskId'), tenantId);
    if (!task) return c.json({ error: 'Task not found.' }, 404);
    const agentIds = [...new Set(task.plan?.steps.map((step) => step.role) ?? [])];
    const toolNames = [...new Set(task.stepResults.flatMap((result) => result.toolCalls?.map((call) => call.name) ?? []))];
    const template = await templates.createTemplate({
      tenantId,
      createdBy: userId,
      name: parsed.data.name.trim(),
      description: parsed.data.description.trim() || `Saved from task ${task.id.slice(0, 8)}.`,
      definition: {
        mode: task.mode,
        model: process.env.DEEPSEEK_MODEL ?? 'deepseek-chat',
        policy: task.policy,
        agentIds,
        toolNames,
        ...(task.plan ? { plan: task.plan } : {}),
      },
      visibility: principal.role === 'viewer' ? 'private' : parsed.data.visibility,
    });
    return c.json({ template, sourceTaskId: task.id }, 201);
  });

  api.get('/templates/:templateId', async (c) => {
    if (!templates) return c.json({ error: 'Workflow templates are not initialized.' }, 503);
    const principal = identity(c.req.raw.headers);
    const template = await templates.getTemplate(c.req.param('templateId'), principal.tenantId, templateAccess(principal));
    if (!template) return c.json({ error: 'Workflow template not found.' }, 404);
    return c.json({ template });
  });

  api.patch('/templates/:templateId', async (c) => {
    if (!templates) return c.json({ error: 'Workflow templates are not initialized.' }, 503);
    const parsed = updateTemplateSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Invalid workflow template update.', details: parsed.error.flatten() }, 400);
    const principal = identity(c.req.raw.headers);
    const { tenantId, userId } = principal;
    try {
      const current = await templates.getTemplate(c.req.param('templateId'), tenantId);
      if (!current) return c.json({ error: 'Workflow template not found.' }, 404);
      if (!canManageTemplate(current, principal)) return c.json({ error: 'Only the template owner or tenant admin can edit this template.' }, 403);
      const update = {
        updatedBy: userId,
        ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
        ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
        ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}),
        ...(parsed.data.visibility !== undefined ? { visibility: parsed.data.visibility } : {}),
        ...(parsed.data.definition !== undefined
          ? { definition: parsed.data.definition as unknown as WorkflowTemplateDefinition }
          : {}),
      };
      const template = await templates.updateTemplate(c.req.param('templateId'), tenantId, update);
      return c.json({ template });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Template update failed.';
      return c.json({ error: message }, /not found/i.test(message) ? 404 : 409);
    }
  });

  api.post('/templates/:templateId/publish', async (c) => {
    if (!templates) return c.json({ error: 'Workflow templates are not initialized.' }, 503);
    const principal = identity(c.req.raw.headers);
    const { tenantId, userId } = principal;
    try {
      const current = await templates.getTemplate(c.req.param('templateId'), tenantId);
      if (!current) return c.json({ error: 'Workflow template not found.' }, 404);
      if (!canManageTemplate(current, principal)) return c.json({ error: 'Only the template owner or tenant admin can publish this template.' }, 403);
      const template = await templates.updateTemplate(c.req.param('templateId'), tenantId, { status: 'published', updatedBy: userId });
      return c.json({ template });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Template publish failed.';
      return c.json({ error: message }, /not found/i.test(message) ? 404 : 409);
    }
  });

  api.post('/templates/:templateId/archive', async (c) => {
    if (!templates) return c.json({ error: 'Workflow templates are not initialized.' }, 503);
    const principal = identity(c.req.raw.headers);
    const { tenantId, userId } = principal;
    try {
      const current = await templates.getTemplate(c.req.param('templateId'), tenantId);
      if (!current) return c.json({ error: 'Workflow template not found.' }, 404);
      if (!canManageTemplate(current, principal)) return c.json({ error: 'Only the template owner or tenant admin can archive this template.' }, 403);
      const template = await templates.updateTemplate(c.req.param('templateId'), tenantId, { status: 'archived', updatedBy: userId });
      return c.json({ template });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Template archive failed.';
      return c.json({ error: message }, /not found/i.test(message) ? 404 : 409);
    }
  });

  api.post('/templates/:templateId/rollback', async (c) => {
    if (!templates) return c.json({ error: 'Workflow templates are not initialized.' }, 503);
    const parsed = rollbackTemplateSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'A template version is required.' }, 400);
    const principal = identity(c.req.raw.headers);
    const { tenantId, userId } = principal;
    try {
      const current = await templates.getTemplate(c.req.param('templateId'), tenantId);
      if (!current) return c.json({ error: 'Workflow template not found.' }, 404);
      if (!canManageTemplate(current, principal)) return c.json({ error: 'Only the template owner or tenant admin can roll back this template.' }, 403);
      const template = await templates.rollbackTemplate(c.req.param('templateId'), tenantId, parsed.data.version, userId);
      return c.json({ template });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Template rollback failed.';
      return c.json({ error: message }, /not found/i.test(message) ? 404 : 409);
    }
  });

  api.post('/templates/:templateId/share', async (c) => {
    if (!templates) return c.json({ error: 'Workflow templates are not initialized.' }, 503);
    const principal = identity(c.req.raw.headers);
    const current = await templates.getTemplate(c.req.param('templateId'), principal.tenantId);
    if (!current) return c.json({ error: 'Workflow template not found.' }, 404);
    if (!canManageTemplate(current, principal)) return c.json({ error: 'Only the template owner or tenant admin can share this template.' }, 403);
    const template = await templates.updateTemplate(current.id, principal.tenantId, { visibility: 'team', updatedBy: principal.userId });
    return c.json({ template });
  });

  api.post('/templates/:templateId/unshare', async (c) => {
    if (!templates) return c.json({ error: 'Workflow templates are not initialized.' }, 503);
    const principal = identity(c.req.raw.headers);
    const current = await templates.getTemplate(c.req.param('templateId'), principal.tenantId);
    if (!current) return c.json({ error: 'Workflow template not found.' }, 404);
    if (!canManageTemplate(current, principal)) return c.json({ error: 'Only the template owner or tenant admin can unshare this template.' }, 403);
    const template = await templates.updateTemplate(current.id, principal.tenantId, { visibility: 'private', updatedBy: principal.userId });
    return c.json({ template });
  });

  api.get('/templates/:templateId/export', async (c) => {
    if (!templates) return c.json({ error: 'Workflow templates are not initialized.' }, 503);
    const principal = identity(c.req.raw.headers);
    const template = await templates.getTemplate(c.req.param('templateId'), principal.tenantId, templateAccess(principal));
    if (!template) return c.json({ error: 'Workflow template not found.' }, 404);
    const filename = `${template.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'axiom-template'}.json`;
    c.header('Content-Type', 'application/json; charset=utf-8');
    c.header('Content-Disposition', `attachment; filename="${filename}"`);
    return c.body(JSON.stringify(templateBundle(template), null, 2));
  });

  api.post('/tasks', async (c) => {
    const contentLength = Number(c.req.header('content-length') ?? 0);
    if (Number.isFinite(contentLength) && contentLength > 128 * 1024) {
      return c.json({ error: 'Task request is larger than 128 KB.' }, 413);
    }
    const parsed = createTaskSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Invalid task request.', details: parsed.error.flatten() }, 400);
    const principal = identity(c.req.raw.headers);
    const { tenantId, userId } = principal;
    try {
      return c.json(await enqueueTask(parsed.data, tenantId, userId, {}, c.req.header('idempotency-key'), templateAccess(principal)), 202);
    } catch (error) {
      const failure = enqueueErrorResponse(error);
      return c.json({ error: failure.message }, failure.status);
    }
  });

  api.post('/webhooks/tasks', async (c) => {
    const configuredSecret = process.env.AXIOM_WEBHOOK_SECRET?.trim();
    if (!configuredSecret) return c.json({ error: 'Webhook trigger is not configured.' }, 503);
    const contentLength = Number(c.req.header('content-length') ?? 0);
    if (Number.isFinite(contentLength) && contentLength > 128 * 1024) {
      return c.json({ error: 'Webhook request is larger than 128 KB.' }, 413);
    }
    const principal = identity(c.req.raw.headers);
    const rawBody = await c.req.text();
    if (Buffer.byteLength(rawBody, 'utf8') > 128 * 1024) {
      return c.json({ error: 'Webhook request is larger than 128 KB.' }, 413);
    }
    const verification = verifyWebhookRequest(c.req.raw.headers, rawBody, configuredSecret, principal);
    if (!verification.ok) return c.json({ error: verification.error }, verification.status);
    let payload: unknown = null;
    try { payload = JSON.parse(rawBody || 'null'); } catch { /* handled by schema validation */ }
    const parsed = createTaskSchema.safeParse(payload);
    if (!parsed.success) return c.json({ error: 'Invalid webhook task payload.', details: parsed.error.flatten() }, 400);
    const { tenantId, userId } = principal;
    try {
      return c.json(await enqueueTask(parsed.data, tenantId, userId, {
        source: 'webhook',
        webhookTimestamp: verification.timestampSeconds,
        webhookDeliveryId: verification.idempotencyKey,
      }, verification.idempotencyKey, templateAccess(principal)), 202);
    } catch (error) {
      const failure = enqueueErrorResponse(error);
      return c.json({ error: failure.message }, failure.status);
    }
  });

  const listScheduleRuns = async (scheduleId: string, tenantId: string, userId: string, limit = 20) => {
    const candidates = store.listTasksByTrigger
      ? await store.listTasksByTrigger(tenantId, scheduleId, limit)
      : await store.listTasks(tenantId, Math.max(100, limit));
    const eventSummaries = await store.getTaskEventSummaries(candidates.map((task) => task.id), tenantId);
    const triggerTasks = store.listTasksByTrigger
      ? candidates
      : candidates.filter((task) => eventSummaries.get(task.id)?.triggerId === scheduleId).slice(0, limit);
    const owned = triggerTasks.filter((task) => task.userId === userId).slice(0, limit);
    return Promise.all(owned.map((task) => summarizeTask(task, eventSummaries.get(task.id))));
  };

  const scheduleForPrincipal = async (scheduleId: string, principal: ReturnType<typeof identity>) => {
    const schedule = await scheduler.get(scheduleId, principal.tenantId);
    return schedule?.userId === principal.userId ? schedule : null;
  };

  const scheduleArtifactCandidate = async (taskId: string, principal: ReturnType<typeof identity>) => {
    const task = await store.getTask(taskId, principal.tenantId);
    if (!task || task.userId !== principal.userId || task.status !== 'completed' || !task.result?.trim()) return null;
    const summary = (await store.getTaskEventSummaries([task.id], principal.tenantId)).get(task.id);
    const evidence = summary?.latest?.type === 'task.completed' ? parseCompletionEvidence(summary.latest.payload.evidenceSummary) : undefined;
    if (evidence?.status !== 'verified') return null;
    const artifactId = `result:${task.id}`;
    return {
      artifactId,
      taskId: task.id,
      ...(summary?.triggerId ? { sourceScheduleId: summary.triggerId } : {}),
      title: task.title,
      createdAt: task.updatedAt,
      bytes: Buffer.byteLength(task.result, 'utf8'),
      revision: task.revision,
      inputArtifact: {
        artifactId,
        sourceTaskId: task.id,
        ...(summary?.triggerId ? { sourceScheduleId: summary.triggerId } : {}),
        sourceTaskRevision: task.revision,
        sourceTaskUpdatedAt: task.updatedAt,
        contentSha256: createHash('sha256').update(task.result, 'utf8').digest('hex'),
        title: task.title,
      },
      content: task.result,
    };
  };

  const scheduleInsightsFor = async (principal: ReturnType<typeof identity>, days = 35) => {
    const schedules = (await scheduler.list(principal.tenantId)).filter((schedule) => schedule.userId === principal.userId);
    const runEntries = await Promise.all(schedules.map(async (schedule) => [
      schedule.id,
      await listScheduleRuns(schedule.id, principal.tenantId, principal.userId, 6),
    ] as const));
    return buildScheduleInsights({
      schedules,
      runsBySchedule: Object.fromEntries(runEntries),
      days,
      capacityLimit: Number(process.env.AXIOM_SCHEDULE_CAPACITY ?? 4),
    });
  };

  api.post('/schedules/draft', async (c) => {
    if (process.env.AXIOM_SCHEDULER_ENABLED === 'false') return c.json({ error: '日程服务当前未启用。' }, 503);
    const parsed = scheduleDraftRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: '日程描述或时区无效。', details: parsed.error.flatten() }, 400);
    const principal = identity(c.req.raw.headers);
    let modelError: unknown;
    try {
      const draftModel = dependencies.scheduleModelFactory
        ? await dependencies.scheduleModelFactory(parsed.data.modelCredentialId, principal.tenantId, principal.userId)
        : model;
      if (!draftModel) throw new Error('日程 Agent 尚未配置文本模型。');
      const completion = await draftModel.complete({
        signal: AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(45_000)]),
        responseFormat: 'json',
        temperature: 0,
        maxTokens: 1_200,
        system: scheduleAgentPrompt(new Date(), parsed.data.timezone),
        user: parsed.data.request,
      });
      const generated = parseScheduleDraft(completion.content);
      const draft = parseScheduleDraft(JSON.stringify({
        ...generated,
        schedule: { ...generated.schedule, timezone: parsed.data.timezone },
      }));
      if (draft.schedule.kind === 'once' && !nextRunAtForCadence(draft.schedule, new Date())) {
        return c.json({ error: '日程 Agent 返回的单次执行时间已经过去，请补充一个未来时间。' }, 422);
      }
      return c.json({ draft, source: 'schedule-agent', model: draftModel.model, createsSchedule: false });
    } catch (error) {
      modelError = error;
    }

    const fallback = fallbackScheduleDraft(parsed.data.request, parsed.data.timezone);
    if (fallback) {
      return c.json({
        draft: fallback,
        source: 'deterministic-fallback',
        createsSchedule: false,
        warning: '日程 Agent 本次不可用，已使用有限的常用时间表达解析。请确认草案后再保存。',
      });
    }
    const detail = modelError instanceof Error ? modelError.message.slice(0, 300) : '未知模型错误';
    return c.json({ error: '日程 Agent 未能生成可靠草案，且当前描述无法由有限规则安全解析。日程没有被创建。', detail }, 502);
  });

  api.get('/schedules', async (c) => {
    const { tenantId, userId } = identity(c.req.raw.headers);
    const [allSchedules, healthActions] = await Promise.all([
      scheduler.list(tenantId),
      scheduler.listHealthActions(tenantId, userId, 20),
    ]);
    const schedules = allSchedules.filter((schedule) => schedule.userId === userId);
    if (schedules.length === 0) {
      return c.json({ schedules, latestRuns: {}, healthActions, persistence: process.env.DATABASE_URL ? 'postgresql' : 'memory-single-node' });
    }
    const tasks = await store.listTasks(tenantId, 100);
    const summaries = await store.getTaskEventSummaries(tasks.map((task) => task.id), tenantId);
    const scheduleIds = new Set(schedules.map((schedule) => schedule.id));
    const latestRuns: Record<string, Awaited<ReturnType<typeof summarizeTask>>> = {};
    for (const task of tasks) {
      const summary = summaries.get(task.id);
      const triggerId = summary?.triggerId;
      if (!triggerId || !scheduleIds.has(triggerId) || latestRuns[triggerId]) continue;
      latestRuns[triggerId] = await summarizeTask(task, summary);
    }
    return c.json({ schedules, latestRuns, healthActions, persistence: process.env.DATABASE_URL ? 'postgresql' : 'memory-single-node' });
  });

  api.get('/schedules/health-actions', async (c) => {
    const principal = identity(c.req.raw.headers);
    const requestedLimit = Number(c.req.query('limit') ?? 20);
    const limit = Number.isFinite(requestedLimit) ? Math.min(100, Math.max(1, Math.floor(requestedLimit))) : 20;
    return c.json({ actions: await scheduler.listHealthActions(principal.tenantId, principal.userId, limit) });
  });

  api.get('/schedules/insights', async (c) => {
    const principal = identity(c.req.raw.headers);
    const requestedDays = Number(c.req.query('days') ?? 35);
    const days = Number.isFinite(requestedDays) ? Math.min(42, Math.max(1, Math.floor(requestedDays))) : 35;
    return c.json(await scheduleInsightsFor(principal, days));
  });

  api.get('/schedules/artifact-inputs', async (c) => {
    const principal = identity(c.req.raw.headers);
    const requestedLimit = Number(c.req.query('limit') ?? 50);
    const limit = Number.isFinite(requestedLimit) ? Math.min(100, Math.max(1, Math.floor(requestedLimit))) : 50;
    const tasks = (await store.listTasks(principal.tenantId, Math.max(100, limit * 2)))
      .filter((task) => task.userId === principal.userId && task.status === 'completed' && Boolean(task.result?.trim()));
    const candidates = await Promise.all(tasks.map((task) => scheduleArtifactCandidate(task.id, principal)));
    return c.json({
      artifacts: candidates.filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate)).slice(0, limit).map(({ inputArtifact: _inputArtifact, content: _content, ...candidate }) => candidate),
    });
  });

  api.post('/schedules', async (c) => {
    if (process.env.AXIOM_SCHEDULER_ENABLED === 'false') return c.json({ error: 'Scheduler is disabled.' }, 503);
    const parsed = scheduleSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Invalid schedule.', details: parsed.error.flatten() }, 400);
    const { tenantId, userId } = identity(c.req.raw.headers);
    try {
      if (parsed.data.modelCredentialId) {
        const credential = dependencies.resolveModelCredential
          ? await dependencies.resolveModelCredential(parsed.data.modelCredentialId, tenantId, userId)
          : null;
        if (!credential) return c.json({ error: '文本模型凭据不存在或不属于当前用户。' }, 400);
      }
      const linked = parsed.data.inputArtifactTaskId
        ? await scheduleArtifactCandidate(parsed.data.inputArtifactTaskId, { tenantId, userId, role: 'member' })
        : null;
      if (parsed.data.inputArtifactTaskId && !linked) {
        return c.json({ error: '只能接续当前用户已完成且通过验证的任务结果。' }, 400);
      }
      if (linked && (!artifactStore || !artifactCatalog)) {
        return c.json({ error: 'Artifact 持久化服务未就绪，当前不能建立日程结果联动。' }, 503);
      }
      const { inputArtifactTaskId: _inputArtifactTaskId, ...scheduleInput } = parsed.data;
      const schedule = await scheduler.upsert({
        ...scheduleInput,
        ...(linked ? { inputArtifact: linked.inputArtifact } : {}),
        title: parsed.data.title ?? parsed.data.input.slice(0, 80),
        tenantId,
        userId,
      });
      if (linked && artifactCatalog && artifactStore) {
        try {
          const existingRecord = await artifactCatalog.get(tenantId, linked.artifactId);
          const existingContent = await artifactStore.get(linked.artifactId, tenantId);
          const stored = existingContent === linked.content
            ? { key: existingRecord?.storageKey, bytes: linked.bytes }
            : await artifactStore.put(linked.artifactId, linked.content, tenantId);
          if (!existingRecord) {
            await artifactCatalog.register({
              id: linked.artifactId,
              tenantId,
              taskId: linked.taskId,
              source: 'result',
              ...(stored.key ? { storageKey: stored.key } : {}),
              bytes: stored.bytes,
              mimeType: 'text/markdown',
              createdAt: linked.createdAt,
              referenceKey: 'result',
            });
          }
          await artifactCatalog.register({
            id: linked.artifactId,
            tenantId,
            taskId: schedule.id,
            source: 'result',
            ...(stored.key ? { storageKey: stored.key } : {}),
            bytes: stored.bytes,
            mimeType: 'text/markdown',
            createdAt: linked.createdAt,
            referenceKey: `schedule-input:${schedule.id}`,
          });
        } catch (error) {
          await scheduler.remove(schedule.id, tenantId).catch(() => undefined);
          return c.json({ error: error instanceof Error ? `日程结果引用保存失败：${error.message}` : '日程结果引用保存失败。' }, 503);
        }
      }
      return c.json({ schedule, persistence: process.env.DATABASE_URL ? 'postgresql' : 'memory-single-node' }, 201);
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : '日程创建失败。' }, 400);
    }
  });

  api.get('/schedules/:scheduleId/runs', async (c) => {
    const principal = identity(c.req.raw.headers);
    const scheduleId = c.req.param('scheduleId');
    if (!await scheduleForPrincipal(scheduleId, principal)) return c.json({ error: 'Schedule not found.' }, 404);
    const requestedLimit = Number(c.req.query('limit') ?? 20);
    const limit = Number.isFinite(requestedLimit) ? Math.min(100, Math.max(1, Math.floor(requestedLimit))) : 20;
    return c.json({ runs: await listScheduleRuns(scheduleId, principal.tenantId, principal.userId, limit) });
  });

  api.post('/schedules/:scheduleId/run', async (c) => {
    if (process.env.AXIOM_SCHEDULER_ENABLED === 'false') return c.json({ error: '日程服务当前未启用。' }, 503);
    const parsed = manualScheduleRunSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: '立即运行请求无效。', details: parsed.error.flatten() }, 400);
    const principal = identity(c.req.raw.headers);
    const schedule = await scheduleForPrincipal(c.req.param('scheduleId'), principal);
    if (!schedule) return c.json({ error: 'Schedule not found.' }, 404);
    try {
      return c.json(await enqueueScheduledTrigger(schedule, true, parsed.data.idempotencyKey), 202);
    } catch (error) {
      const failure = enqueueErrorResponse(error);
      return c.json({ error: failure.message }, failure.status);
    }
  });

  api.delete('/schedules/:scheduleId', async (c) => {
    const principal = identity(c.req.raw.headers);
    const schedule = await scheduleForPrincipal(c.req.param('scheduleId'), principal);
    if (!schedule) return c.json({ error: 'Schedule not found.' }, 404);
    if (!await scheduler.remove(c.req.param('scheduleId'), principal.tenantId)) return c.json({ error: 'Schedule not found.' }, 404);
    if (schedule.inputArtifact) {
      await artifactCatalog?.removeTaskReferences(principal.tenantId, schedule.id, [schedule.inputArtifact.artifactId]);
    }
    return c.body(null, 204);
  });

  api.post('/schedules/:scheduleId/resume', async (c) => {
    if (process.env.AXIOM_SCHEDULER_ENABLED === 'false') return c.json({ error: 'Scheduler is disabled.' }, 503);
    const principal = identity(c.req.raw.headers);
    if (!await scheduleForPrincipal(c.req.param('scheduleId'), principal)) return c.json({ error: 'Schedule not found.' }, 404);
    const schedule = await scheduler.resume(c.req.param('scheduleId'), principal.tenantId);
    if (!schedule) return c.json({ error: 'Schedule not found.' }, 404);
    return c.json({ schedule }, 200);
  });

  api.post('/schedules/:scheduleId/health-action', async (c) => {
    if (process.env.AXIOM_SCHEDULER_ENABLED === 'false') return c.json({ error: '日程服务当前未启用。' }, 503);
    const parsed = scheduleHealthActionSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: '日程调整确认无效。', details: parsed.error.flatten() }, 400);
    const principal = identity(c.req.raw.headers);
    const scheduleId = c.req.param('scheduleId');
    const currentSchedule = await scheduleForPrincipal(scheduleId, principal);
    if (!currentSchedule) return c.json({ error: 'Schedule not found.' }, 404);
    const insights = await scheduleInsightsFor(principal, 35);
    const recommendation = insights.suggestions.find((item) => item.id === parsed.data.suggestionId && item.scheduleId === scheduleId);
    if (!recommendation) return c.json({ error: '这条建议已过期，日程没有改变。请刷新后重新确认。' }, 409);
    try {
      const result = await scheduler.applyHealthAction({
        tenantId: principal.tenantId,
        userId: principal.userId,
        scheduleId,
        suggestionId: recommendation.id,
        kind: recommendation.kind,
        action: recommendation.recommendedAction,
        reason: recommendation.reason,
        evidence: recommendation.evidence,
        ...(recommendation.proposedCadence ? { proposedCadence: recommendation.proposedCadence } : {}),
        expected: scheduleHealthState(currentSchedule),
        confirmedBy: principal.userId,
      });
      if (!result) return c.json({ error: '日程状态已经改变，本次调整未执行。' }, 409);
      return c.json({ schedule: result.schedule, applied: result.audit });
    } catch (error) {
      if (error instanceof ScheduleHealthActionConflictError) {
        return c.json({ error: '这条建议已执行或日程状态已经改变，请刷新后查看。' }, 409);
      }
      throw error;
    }
  });

  api.get('/notifications', async (c) => {
    const principal = identity(c.req.raw.headers);
    const requestedLimit = Number(c.req.query('limit') ?? 40);
    const limit = Number.isFinite(requestedLimit) ? Math.min(100, Math.max(1, Math.floor(requestedLimit))) : 40;
    const unreadOnly = c.req.query('unreadOnly') === 'true';
    const notifications = await notificationFeed(principal);
    const visible = unreadOnly ? notifications.filter((item) => !item.read) : notifications;
    return c.json({
      generatedAt: new Date().toISOString(),
      unreadCount: notifications.filter((item) => !item.read).length,
      notifications: visible.slice(0, limit),
    });
  });

  api.post('/notifications/read', async (c) => {
    const parsed = notificationReadSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: '通知已读请求无效。', details: parsed.error.flatten() }, 400);
    const principal = identity(c.req.raw.headers);
    const notifications = await notificationFeed(principal);
    const availableIds = new Set(notifications.map((item) => item.id));
    const ids = parsed.data.all
      ? [...availableIds]
      : [...new Set(parsed.data.ids)].filter((id) => availableIds.has(id));
    const marked = await store.markNotificationsRead(principal.tenantId, principal.userId, ids);
    const newlyRead = new Set(ids);
    return c.json({
      marked,
      unreadCount: notifications.filter((item) => !item.read && !newlyRead.has(item.id)).length,
    });
  });

  api.get('/tasks', async (c) => {
    const { tenantId } = identity(c.req.raw.headers);
    const requestedLimit = Number(c.req.query('limit') ?? 50);
    const limit = Number.isFinite(requestedLimit) ? Math.min(100, Math.max(1, Math.floor(requestedLimit))) : 50;
    const tasks = await store.listTasks(tenantId, limit);
    const eventSummaries = await store.getTaskEventSummaries(tasks.map((task) => task.id), tenantId);
    return c.json({ tasks: await Promise.all(tasks.map((task) => summarizeTask(task, eventSummaries.get(task.id)))) });
  });

  api.get('/sessions', async (c) => {
    const { tenantId, userId } = identity(c.req.raw.headers);
    const requestedLimit = Number(c.req.query('limit') ?? 50);
    const limit = Number.isFinite(requestedLimit) ? Math.min(100, Math.max(1, Math.floor(requestedLimit))) : 50;
    const [persisted, deletedIds, tasks] = await Promise.all([
      store.listSessions(tenantId, userId, limit),
      store.listDeletedSessionIds(tenantId, userId),
      store.listTasks(tenantId, Math.min(100, Math.max(limit * 2, 50))),
    ]);
    // Older Nexus builds persisted a projection under workflow-session-*.
    // Recover the source from task.created for custom titles, then hide every
    // known Nexus session before it can be returned to the chat client.
    const nexusSessionIds = new Set<string>(
      tasks.filter((task) => task.userId === userId && isLikelyAgentWorkflowTask(task)).map((task) => task.sessionId),
    );
    await Promise.all(tasks
      .filter((task) => task.userId === userId && task.templateId && !nexusSessionIds.has(task.sessionId))
      .map(async (task) => {
        const created = (await store.getEvents(task.id)).find((event) => event.type === 'task.created');
        if (created?.payload.source === 'agent-workflow') nexusSessionIds.add(task.sessionId);
      }));
    const isNexusSession = (session: { id: string; title?: string }) => nexusSessionIds.has(session.id) || isLegacyNexusProjection(session);
    const reconciled = await Promise.all(persisted.filter((session) => !isNexusSession(session)).map(async (session) => {
      if (!session.messages.some((message) => message.pending) && !session.activeTaskId) return session;
      const activeTask = session.activeTaskId
        ? tasks.find((task) => task.id === session.activeTaskId) ?? await store.getTask(session.activeTaskId, tenantId)
        : null;
      const taskIsActive = Boolean(activeTask && executingTaskStatuses.has(activeTask.status));
      const activeAssistantId = taskIsActive ? session.activeAssistantId : undefined;
      const normalized = {
        ...session,
        activeTaskId: taskIsActive ? session.activeTaskId : undefined,
        activeAssistantId,
        messages: session.messages.map((message) => ({
          ...message,
          pending: message.id === activeAssistantId ? Boolean(message.pending) : false,
        })),
      };
      await store.upsertSession(tenantId, userId, normalized).catch(() => undefined);
      return normalized;
    }));
    const byId = new Map(reconciled.map((session) => [session.id, session]));
    const deleted = new Set(deletedIds);
    // Migrate legacy task-only conversations. This keeps old history visible
    // after a browser origin changes even before the client has synced it.
    for (const task of tasks.filter((item) => item.userId === userId && !deleted.has(item.sessionId) && !isNexusSession({ id: item.sessionId, title: item.title }))) {
      if (byId.has(task.sessionId)) continue;
      byId.set(task.sessionId, {
        id: task.sessionId,
        tenantId,
        userId,
        title: task.title,
        messages: messagesFromTask(task),
        updatedAt: new Date(task.updatedAt).getTime(),
        ...(executingTaskStatuses.has(task.status) ? { activeTaskId: task.id } : {}),
      });
    }
    return c.json({
      sessions: [...byId.values()].sort((left, right) => right.updatedAt - left.updatedAt).slice(0, limit),
      deletedSessionIds: deletedIds,
      persistence: process.env.DATABASE_URL ? 'postgresql' : 'sqlite',
    });
  });

  api.post('/reports/export', async (c) => {
    const parsed = reportExportSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: '报告导出参数不完整或格式不受支持。', details: parsed.error.flatten() }, 400);
    const principal = identity(c.req.raw.headers);
    const session = (await store.listSessions(principal.tenantId, principal.userId, 100))
      .find((candidate) => candidate.id === parsed.data.sessionId);
    if (!session) return c.json({ error: '会话不存在，或当前用户无权导出该会话。' }, 404);
    let reportModel: ModelClient | undefined;
    try {
      reportModel = dependencies.reportModelFactory
        ? await dependencies.reportModelFactory(parsed.data.modelCredentialId, principal.tenantId, principal.userId)
        : model;
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : '报告生成模型配置不可用。' }, 400);
    }
    if (!reportModel) return c.json({ error: '报告生成 Agent 的文本模型尚未配置。' }, 503);
    try {
      const signal = AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(240_000)]);
      const report = await generateReport(reportModel, session, parsed.data, signal);
      const asciiName = `axiom-report.${parsed.data.format}`;
      return new Response(new Uint8Array(report.bytes), {
        status: 200,
        headers: {
          'Content-Type': report.mimeType,
          'Content-Length': String(report.bytes.byteLength),
          'Content-Disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(report.fileName)}`,
          'Cache-Control': 'private, no-store',
          'X-Content-Type-Options': 'nosniff',
          'X-Axiom-Report-Agent': 'report-agent',
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : '报告生成失败。';
      return c.json({ error: message }, /没有可导出|还没有可导出/.test(message) ? 409 : 502);
    }
  });

  api.put('/sessions/:sessionId', async (c) => {
    const sessionId = c.req.param('sessionId');
    const contentLength = Number(c.req.header('content-length') ?? 0);
    if (contentLength > 10 * 1024 * 1024) return c.json({ error: 'Session history exceeds the 10 MB limit.' }, 413);
    const parsed = sessionUpsertSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success || parsed.data.id && parsed.data.id !== sessionId) return c.json({ error: 'Invalid session history.' }, 400);
    const { tenantId, userId } = identity(c.req.raw.headers);
    try {
      const previous = (await store.listSessions(tenantId, userId, 100)).find((session) => session.id === sessionId);
      let contextSummary = buildPersistedContextSummary(
        sessionId,
        parsed.data.messages as DurableContextSourceMessage[],
        previous?.contextSummary,
        {
          recentMessages: 12,
          triggerMessages: 16,
          maxMessages: 24,
          maxCharacters: 48_000,
          maxSummaryCharacters: 8_000,
          maxTokens: Math.max(512, Number(process.env.AXIOM_CONTEXT_MAX_TOKENS ?? 12_000)),
        },
      );
      if (contextSummary) {
        contextSummary = attachPersistedContextMetadata(
          contextSummary,
          await contextSummaryMetadata(tenantId, userId, sessionId, parsed.data.messages, contextSummary.coveredMessageIds),
        );
      }
      const session = await store.upsertSession(tenantId, userId, {
        ...parsed.data,
        id: sessionId,
        contextSummary,
      } as never);
      return c.json({ session });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : 'Session could not be persisted.' }, 409);
    }
  });

  api.delete('/sessions/:sessionId', async (c) => {
    const { tenantId, userId } = identity(c.req.raw.headers);
    const sessionId = c.req.param('sessionId');
    if (!await store.deleteSession(sessionId, tenantId, userId)) return c.json({ error: 'Session not found.' }, 404);
    // Conversation deletion and task management share the same durable run
    // records. Remove terminal runs owned by this session so a deleted chat
    // cannot reappear as an orphaned task card. Active runs stay visible until
    // they reach a terminal state and can be deleted safely by the operator.
    const sessionTasks = await store.listTasks(tenantId, 100);
    for (const task of sessionTasks.filter((item) => item.userId === userId && item.sessionId === sessionId && terminalStatuses.has(item.status))) {
      const events = await store.getEvents(task.id).catch(() => []);
      if (await store.deleteTask(task.id, tenantId)) await cleanupTaskArtifacts(task, events);
    }
    return c.body(null, 204);
  });

  api.get('/tasks/stats', async (c) => {
    const { tenantId } = identity(c.req.raw.headers);
    const stats = await store.getTaskStats(tenantId);
    return c.json(stats);
  });

  api.get('/tasks/stats/daily', async (c) => {
    const { tenantId } = identity(c.req.raw.headers);
    const requestedDays = Number(c.req.query('days') ?? 7);
    const days = Number.isFinite(requestedDays) ? Math.min(31, Math.max(1, Math.floor(requestedDays))) : 7;
    return c.json({ days: await store.getTaskStatsDaily(tenantId, days) });
  });

  api.get('/whoami', (c) => {
    const principal = identity(c.req.raw.headers);
    return c.json({ tenantId: principal.tenantId, userId: principal.userId, role: principal.role });
  });

  api.get('/tasks/:taskId', async (c) => {
    const { tenantId } = identity(c.req.raw.headers);
    const task = await store.getTask(c.req.param('taskId'), tenantId);
    if (!task) return c.json({ error: 'Task not found.' }, 404);
    return c.json({ task });
  });

  api.get('/tasks/:taskId/checkpoints', async (c) => {
    const principal = identity(c.req.raw.headers);
    const taskId = c.req.param('taskId');
    if (!runtimeIdSchema.safeParse(taskId).success) return c.json({ error: '任务 ID 格式无效。' }, 400);
    const task = await store.getTask(taskId, principal.tenantId);
    if (!task) return c.json({ error: 'Task not found.' }, 404);
    const events = await store.getEvents(task.id);
    const checkpoints = checkpointsFromEvents(events).map(({ snapshot: _snapshot, ...checkpoint }) => checkpoint);
    const branchEvents = events.filter((event) => event.type === 'checkpoint.branch_created' || event.type === 'checkpoint.merge_created');
    const branches = (await Promise.all(branchEvents.map(async (event) => {
      const branchTaskId = typeof event.payload.branchTaskId === 'string'
        ? event.payload.branchTaskId
        : typeof event.payload.mergedTaskId === 'string' ? event.payload.mergedTaskId : '';
      if (!branchTaskId) return null;
      const branch = await store.getTask(branchTaskId, principal.tenantId);
      if (!branch) return null;
      return {
        taskId: branch.id,
        checkpointId: typeof event.payload.checkpointId === 'string' ? event.payload.checkpointId : '',
        kind: event.type === 'checkpoint.merge_created' ? 'merge' : 'branch',
        title: branch.title,
        status: branch.status,
        revision: branch.revision,
        updatedAt: branch.updatedAt,
      };
    }))).filter((branch): branch is NonNullable<typeof branch> => Boolean(branch));
    return c.json({ taskId: task.id, currentRevision: task.revision, checkpoints, branches });
  });

  api.get('/tasks/:taskId/checkpoints/:checkpointId/diff', async (c) => {
    const principal = identity(c.req.raw.headers);
    const taskId = c.req.param('taskId');
    const checkpointId = c.req.param('checkpointId');
    if (!runtimeIdSchema.safeParse(taskId).success) return c.json({ error: '任务 ID 格式无效。' }, 400);
    if (!runtimeIdSchema.safeParse(checkpointId).success) return c.json({ error: '检查点 ID 格式无效。' }, 400);
    const task = await store.getTask(taskId, principal.tenantId);
    if (!task) return c.json({ error: 'Task not found.' }, 404);
    const checkpoint = checkpointsFromEvents(await store.getEvents(task.id))
      .find((candidate) => candidate.checkpointId === checkpointId);
    if (!checkpoint) return c.json({ error: '检查点不存在。' }, 404);
    if (!checkpoint.restorable) return c.json({ error: '这个旧检查点没有完整快照，只能查看，不能比较或恢复。' }, 409);
    const targetTaskId = c.req.query('targetTaskId')?.trim() || task.id;
    if (!runtimeIdSchema.safeParse(targetTaskId).success) return c.json({ error: '目标任务 ID 格式无效。' }, 400);
    const target = targetTaskId === task.id ? task : await store.getTask(targetTaskId, principal.tenantId);
    if (!target) return c.json({ error: '要比较的任务不存在。' }, 404);
    return c.json({ diff: diffCheckpointToTask(checkpoint, target) });
  });

  api.post('/tasks/:taskId/checkpoints/:checkpointId/branch', async (c) => {
    const principal = identity(c.req.raw.headers);
    const taskId = c.req.param('taskId');
    const checkpointId = c.req.param('checkpointId');
    if (!runtimeIdSchema.safeParse(taskId).success) return c.json({ error: '任务 ID 格式无效。' }, 400);
    if (!runtimeIdSchema.safeParse(checkpointId).success) return c.json({ error: '检查点 ID 格式无效。' }, 400);
    const source = await store.getTask(taskId, principal.tenantId);
    if (!source) return c.json({ error: 'Task not found.' }, 404);
    if (principal.role !== 'owner' && principal.role !== 'admin' && source.userId !== principal.userId) {
      return c.json({ error: '只有任务创建者或租户管理员可以派生新方案。' }, 403);
    }
    const parsed = checkpointBranchSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: '缺少当前版本号或分支操作标识。' }, 400);
    const checkpoint = checkpointsFromEvents(await store.getEvents(source.id))
      .find((candidate) => candidate.checkpointId === checkpointId);
    if (!checkpoint) return c.json({ error: '检查点不存在。' }, 404);
    if (!checkpoint.snapshot) return c.json({ error: '这个旧检查点没有完整快照，无法派生新方案。' }, 409);

    const idempotencyKey = `checkpoint-branch:${source.id}:${parsed.data.operationId}`;
    const existing = await store.findTaskByIdempotency(source.tenantId, idempotencyKey);
    if (existing) return c.json({ task: existing, checkpointId, idempotent: true }, 200);
    let reserved;
    try {
      reserved = await store.updateTask(source.id, {}, parsed.data.expectedRevision);
    } catch (error) {
      if (error instanceof TaskRevisionConflictError) {
        return c.json({ error: '任务刚刚产生了新进展，请刷新版本后再操作。', code: error.code, expectedRevision: error.expectedRevision, actualRevision: error.actualRevision }, 409);
      }
      throw error;
    }

    const instruction = parsed.data.instruction.trim();
    const branch = await store.createTask({
      tenantId: source.tenantId,
      userId: source.userId,
      sessionId: source.sessionId,
      templateId: source.templateId,
      title: parsed.data.title?.trim() || `${source.title} · 分支方案`,
      input: source.input,
      mode: source.mode,
      model: source.model,
      modelCredentialId: source.modelCredentialId,
      policy: source.policy,
      idempotencyKey,
      ...(parsed.data.behavior === 'continue' && checkpoint.snapshot.plan ? { plan: checkpoint.snapshot.plan } : {}),
    });
    const prepared = await store.updateTask(branch.id, {
      stepResults: checkpoint.snapshot.stepResults,
      planVersion: checkpoint.planVersion,
      review: null,
      result: null,
      error: null,
      cancelRequested: false,
    });
    const created = await store.appendEvent(prepared, {
      type: 'task.created',
      payload: { title: prepared.title, mode: prepared.mode, source: 'checkpoint-branch', parentTaskId: source.id, checkpointId, operationId: parsed.data.operationId },
    });
    hub.publish(created);
    const branched = await store.appendEvent(prepared, {
      type: 'checkpoint.branch_created',
      agentId: 'operator-checkpoint',
      payload: { sourceTaskId: source.id, branchTaskId: prepared.id, checkpointId, sourceRevision: reserved.revision, requestedBy: principal.userId },
    });
    hub.publish(branched);
    if (instruction) {
      const guidanceId = randomUUID();
      const guidance = await store.appendEvent(prepared, {
        type: 'human.guidance_accepted',
        payload: { guidanceId, message: instruction, behavior: parsed.data.behavior, author: principal.userId, delivery: 'builtin-next-safe-point' },
      });
      hub.publish(guidance);
    }
    const queued = await store.appendEvent(prepared, { type: 'task.queued', payload: { parentTaskId: source.id, checkpointId } });
    hub.publish(queued);
    const sourceEvent = await store.appendEvent(reserved, {
      type: 'checkpoint.branch_created',
      agentId: 'operator-checkpoint',
      payload: { sourceTaskId: source.id, branchTaskId: prepared.id, checkpointId, sourceRevision: reserved.revision, requestedBy: principal.userId },
    });
    hub.publish(sourceEvent);
    coordinator.nudge();
    return c.json({ task: prepared, checkpointId, sourceRevision: reserved.revision }, 202);
  });

  api.post('/tasks/:taskId/checkpoints/:checkpointId/merge', async (c) => {
    const principal = identity(c.req.raw.headers);
    const taskId = c.req.param('taskId');
    const checkpointId = c.req.param('checkpointId');
    if (!runtimeIdSchema.safeParse(taskId).success) return c.json({ error: '任务 ID 格式无效。' }, 400);
    if (!runtimeIdSchema.safeParse(checkpointId).success) return c.json({ error: '检查点 ID 格式无效。' }, 400);
    const source = await store.getTask(taskId, principal.tenantId);
    if (!source) return c.json({ error: 'Task not found.' }, 404);
    if (principal.role !== 'owner' && principal.role !== 'admin' && source.userId !== principal.userId) {
      return c.json({ error: '只有任务创建者或租户管理员可以合并方案。' }, 403);
    }
    const parsed = checkpointMergeSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: '合并参数不完整。' }, 400);
    const checkpoint = checkpointsFromEvents(await store.getEvents(source.id))
      .find((candidate) => candidate.checkpointId === checkpointId);
    if (!checkpoint?.snapshot) return c.json({ error: '检查点不存在或没有可恢复快照。' }, 409);
    const branch = await store.getTask(parsed.data.branchTaskId, principal.tenantId);
    if (!branch) return c.json({ error: '分支任务不存在。' }, 404);
    const branchEvents = await store.getEvents(branch.id);
    const belongsToCheckpoint = branchEvents.some((event) => event.type === 'checkpoint.branch_created'
      && event.payload.sourceTaskId === source.id
      && event.payload.checkpointId === checkpointId);
    if (!belongsToCheckpoint) return c.json({ error: '所选任务不是从这个检查点派生的分支。' }, 409);
    if (executingTaskStatuses.has(branch.status)) return c.json({ error: '分支仍在执行，请等待完成或暂停后再合并。' }, 409);

    const idempotencyKey = `checkpoint-merge:${source.id}:${parsed.data.operationId}`;
    const existing = await store.findTaskByIdempotency(source.tenantId, idempotencyKey);
    if (existing) return c.json({ task: existing, checkpointId, idempotent: true }, 200);
    const mergedState = mergeCheckpointBranch(checkpoint, source, branch, parsed.data.strategy);
    if (!mergedState.canMerge) {
      return c.json({
        error: '当前方案和分支修改了相同内容，请明确选择以哪个方案为准。',
        code: 'CHECKPOINT_MERGE_CONFLICT',
        conflicts: mergedState.conflicts,
      }, 409);
    }
    let reserved;
    try {
      reserved = await store.updateTask(source.id, {}, parsed.data.expectedRevision);
    } catch (error) {
      if (error instanceof TaskRevisionConflictError) {
        return c.json({ error: '任务刚刚产生了新进展，请刷新版本后再操作。', code: error.code, expectedRevision: error.expectedRevision, actualRevision: error.actualRevision }, 409);
      }
      throw error;
    }

    const merged = await store.createTask({
      tenantId: source.tenantId,
      userId: source.userId,
      sessionId: source.sessionId,
      templateId: source.templateId,
      title: parsed.data.title?.trim() || `${source.title} · 合并方案`,
      input: source.input,
      mode: source.mode,
      model: source.model,
      modelCredentialId: source.modelCredentialId,
      policy: source.policy,
      idempotencyKey,
      ...(mergedState.plan ? { plan: mergedState.plan } : {}),
    });
    const prepared = await store.updateTask(merged.id, {
      stepResults: mergedState.stepResults,
      planVersion: Math.max(source.planVersion ?? 0, branch.planVersion ?? 0, checkpoint.planVersion),
      review: null,
      result: null,
      error: null,
      cancelRequested: false,
    });
    const created = await store.appendEvent(prepared, {
      type: 'task.created',
      payload: { title: prepared.title, mode: prepared.mode, source: 'checkpoint-merge', parentTaskId: source.id, branchTaskId: branch.id, checkpointId, operationId: parsed.data.operationId },
    });
    hub.publish(created);
    const mergePayload = {
      sourceTaskId: source.id,
      branchTaskId: branch.id,
      mergedTaskId: prepared.id,
      checkpointId,
      sourceRevision: reserved.revision,
      strategy: parsed.data.strategy,
      resolvedConflicts: mergedState.conflicts,
      requestedBy: principal.userId,
    };
    const mergedEvent = await store.appendEvent(prepared, { type: 'checkpoint.merge_created', agentId: 'operator-checkpoint', payload: mergePayload });
    hub.publish(mergedEvent);
    const queued = await store.appendEvent(prepared, { type: 'task.queued', payload: { parentTaskId: source.id, branchTaskId: branch.id, checkpointId } });
    hub.publish(queued);
    const sourceEvent = await store.appendEvent(reserved, { type: 'checkpoint.merge_created', agentId: 'operator-checkpoint', payload: mergePayload });
    hub.publish(sourceEvent);
    coordinator.nudge();
    return c.json({ task: prepared, checkpointId, sourceRevision: reserved.revision, resolvedConflicts: mergedState.conflicts }, 202);
  });

  // External Harness delegation is deliberately explicit and starts only from
  // a paused task. This prevents the built-in coordinator and a sidecar from
  // claiming the same work at the same time. Events are persisted into the
  // normal task stream, so the existing SSE replay remains authoritative.
  api.post('/tasks/:taskId/harness/start', async (c) => {
    if (!harnessBridge) return c.json({ error: '外部 Harness 委托未配置。' }, 503);
    const principal = identity(c.req.raw.headers);
    const task = await store.getTask(c.req.param('taskId'), principal.tenantId);
    if (!task) return c.json({ error: 'Task not found.' }, 404);
    if (principal.role !== 'owner' && principal.role !== 'admin' && task.userId !== principal.userId) {
      return c.json({ error: '只有任务创建者或租户管理员可以委托外部 Harness。' }, 403);
    }
    const parsed = harnessStartSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: '外部 Harness 输入无效。' }, 400);
    const result = await harnessBridge.start(task, parsed.data.input?.trim() || task.input, {
      model: parsed.data.model || task.model,
    });
    if (!result.accepted) return c.json({ error: result.reason || '外部 Harness 暂时不可用。', capabilities: result.capabilities }, harnessCommandFailureStatus(result));
    return c.json(result, 202);
  });

  api.post('/tasks/:taskId/harness/resume', async (c) => {
    if (!harnessBridge) return c.json({ error: '外部 Harness 委托未配置。' }, 503);
    const principal = identity(c.req.raw.headers);
    const task = await store.getTask(c.req.param('taskId'), principal.tenantId);
    if (!task) return c.json({ error: 'Task not found.' }, 404);
    if (principal.role !== 'owner' && principal.role !== 'admin' && task.userId !== principal.userId) {
      return c.json({ error: '只有任务创建者或租户管理员可以恢复外部 Harness。' }, 403);
    }
    const parsed = harnessResumeSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: '恢复外部 Harness 需要 threadId。' }, 400);
    const result = await harnessBridge.resume(task, parsed.data.threadId, parsed.data.afterSequence);
    if (!result.accepted) return c.json({ error: result.reason || '外部 Harness 暂时不可用。', capabilities: result.capabilities }, harnessCommandFailureStatus(result));
    return c.json(result, 202);
  });

  api.post('/tasks/:taskId/harness/interrupt', async (c) => {
    if (!harnessBridge) return c.json({ error: '外部 Harness 委托未配置。' }, 503);
    const principal = identity(c.req.raw.headers);
    const task = await store.getTask(c.req.param('taskId'), principal.tenantId);
    if (!task) return c.json({ error: 'Task not found.' }, 404);
    if (principal.role !== 'owner' && principal.role !== 'admin' && task.userId !== principal.userId) {
      return c.json({ error: '只有任务创建者或租户管理员可以中断外部 Harness。' }, 403);
    }
    const result = await harnessBridge.interrupt(task.id);
    return result.accepted ? c.json(result, 202) : c.json(result, 409);
  });

  api.delete('/tasks/:taskId', async (c) => {
    const taskId = c.req.param('taskId');
    const principal = identity(c.req.raw.headers);
    const task = await store.getTask(taskId, principal.tenantId);
    if (!task) return c.json({ error: 'Task not found.' }, 404);
    if (principal.role !== 'owner' && principal.role !== 'admin' && task.userId !== principal.userId) {
      return c.json({ error: 'Task not found.' }, 404);
    }
    if (!terminalStatuses.has(task.status)) {
      return c.json({ error: 'Only completed, failed, or cancelled tasks can be deleted.' }, 409);
    }
    const events = await store.getEvents(task.id).catch(() => []);
    if (!await store.deleteTask(taskId, principal.tenantId)) return c.json({ error: 'Task not found.' }, 404);
    await cleanupTaskArtifacts(task, events);
    return c.body(null, 204);
  });

  api.post('/tasks/:taskId/notes', async (c) => {
    const taskId = c.req.param('taskId');
    const { tenantId, userId } = identity(c.req.raw.headers);
    const task = await store.getTask(taskId, tenantId);
    if (!task) return c.json({ error: 'Task not found.' }, 404);
    if (terminalStatuses.has(task.status)) return c.json({ error: 'Task is already terminal.' }, 409);
    const parsed = noteSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'A non-empty operator note is required.' }, 400);
    const event = await store.appendEvent(task, {
      type: 'human.note',
      payload: { message: parsed.data.message.trim(), author: userId, source: 'operator' },
    });
    hub.publish(event);
    coordinator.nudge();
    return c.json({ note: event, taskId }, 202);
  });

  api.post('/tasks/:taskId/guidance', async (c) => {
    const taskId = c.req.param('taskId');
    const principal = identity(c.req.raw.headers);
    const task = await store.getTask(taskId, principal.tenantId);
    if (!task) return c.json({ error: 'Task not found.' }, 404);
    if (principal.role !== 'owner' && principal.role !== 'admin' && task.userId !== principal.userId) {
      return c.json({ error: '只有任务创建者或租户管理员可以追加执行要求。' }, 403);
    }
    if (terminalStatuses.has(task.status)) return c.json({ error: '任务已经结束，无法再追加执行要求。' }, 409);
    const parsed = guidanceSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: '请输入有效的补充要求。' }, 400);

    const guidanceId = randomUUID();
    const message = parsed.data.message.trim();
    const behavior = parsed.data.behavior;
    const delegated = await harnessBridge?.steer(task.id, behavior === 'replan' ? `请重新规划当前任务，并应用以下要求：${message}` : message);
    if (delegated && !delegated.accepted) {
      return c.json({
        error: delegated.reason || '外部 Harness 未接受实时引导。',
        capabilities: delegated.capabilities,
        status: 'unavailable',
      }, harnessCommandFailureStatus(delegated));
    }

    const delivery = delegated ? 'external-harness' : 'builtin-next-safe-point';
    const accepted = await store.appendEvent(task, {
      type: 'human.guidance_accepted',
      payload: { guidanceId, message, behavior, author: principal.userId, delivery },
    });
    hub.publish(accepted);

    if (delegated) {
      const applied = await store.appendEvent(task, {
        type: 'human.guidance_applied',
        payload: {
          guidanceId,
          acceptedSequence: accepted.sequence,
          behavior,
          delivery,
          applicationPoint: 'external-harness-control-plane',
        },
      });
      hub.publish(applied);
      return c.json({ taskId, guidanceId, status: 'applied', delivery, accepted, applied }, 202);
    }

    if (behavior === 'replan') {
      if (task.status === 'running' || task.status === 'reviewing' || task.status === 'planning') coordinator.abort(task.id);
      const replanned = await store.updateTask(task.id, {
        status: 'queued',
        plan: null,
        planVersion: (task.planVersion ?? 0) + 1,
        review: null,
        result: null,
        error: null,
        cancelRequested: false,
      });
      const event = await store.appendEvent(replanned, {
        type: 'plan.replanned',
        agentId: 'planner',
        payload: { guidanceId, instruction: message, preserveCompleted: true, requestedBy: principal.userId },
      });
      hub.publish(event);
    }
    coordinator.nudge();
    return c.json({ taskId, guidanceId, status: 'accepted', delivery, accepted }, 202);
  });

  api.post('/tasks/:taskId/pause', async (c) => {
    const taskId = c.req.param('taskId');
    const { tenantId, userId } = identity(c.req.raw.headers);
    const task = await store.getTask(taskId, tenantId);
    if (!task) return c.json({ error: 'Task not found.' }, 404);
    if (terminalStatuses.has(task.status)) return c.json({ error: 'Task is already terminal.' }, 409);
    if (task.status === 'paused') return c.json({ taskId, status: 'paused' }, 200);
    const parsed = pauseSchema.safeParse(await c.req.json().catch(() => null));
    const reason = parsed.success ? parsed.data.reason?.trim() || 'Paused by operator.' : 'Paused by operator.';
    const paused = await store.updateTask(taskId, { status: 'paused' });
    const event = await store.appendEvent(paused, {
      type: 'task.paused',
      payload: { reason, author: userId, source: 'operator' },
    });
    hub.publish(event);
    coordinator.abort(taskId);
    return c.json({ task: paused, event }, 202);
  });

  api.post('/tasks/:taskId/resume', async (c) => {
    const taskId = c.req.param('taskId');
    const { tenantId, userId } = identity(c.req.raw.headers);
    const task = await store.getTask(taskId, tenantId);
    if (!task) return c.json({ error: 'Task not found.' }, 404);
    if (task.status !== 'paused') return c.json({ error: 'Only paused tasks can be resumed.' }, 409);
    const resumed = await store.updateTask(taskId, { status: 'queued', cancelRequested: false, error: '' });
    const event = await store.appendEvent(resumed, {
      type: 'task.resumed',
      payload: { author: userId, source: 'operator', checkpointSteps: resumed.stepResults.length },
    });
    hub.publish(event);
    coordinator.nudge();
    return c.json({ task: resumed, event }, 202);
  });

  api.post('/tasks/:taskId/approve-plan', async (c) => {
    const taskId = c.req.param('taskId');
    const { tenantId, userId } = identity(c.req.raw.headers);
    const task = await store.getTask(taskId, tenantId);
    if (!task) return c.json({ error: 'Task not found.' }, 404);
    if (!task.plan?.steps.length) return c.json({ error: 'Task has no plan to approve.' }, 409);
    if (task.status !== 'awaiting_approval') return c.json({ error: 'Task is not waiting for plan approval.' }, 409);
    const parsed = planDecisionSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'Invalid plan approval.' }, 400);
    const approvedAt = new Date().toISOString();
    const plan = { ...task.plan, approvalStatus: 'approved' as const, approvedAt, approvedBy: userId };
    const approved = await store.updateTask(taskId, { status: 'queued', plan, error: null });
    const event = await store.appendEvent(approved, {
      type: 'plan.approved',
      agentId: 'planner',
      payload: { version: approved.planVersion, approvedAt, approvedBy: userId, note: parsed.data.note?.trim() || '' },
    });
    hub.publish(event);
    coordinator.nudge();
    return c.json({ task: approved, event }, 202);
  });

  api.post('/tasks/:taskId/reject-plan', async (c) => {
    const taskId = c.req.param('taskId');
    const { tenantId, userId } = identity(c.req.raw.headers);
    const task = await store.getTask(taskId, tenantId);
    if (!task) return c.json({ error: 'Task not found.' }, 404);
    if (!task.plan?.steps.length) return c.json({ error: 'Task has no plan to reject.' }, 409);
    const parsed = planDecisionSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'Invalid plan rejection.' }, 400);
    const rejected = await store.updateTask(taskId, {
      status: 'paused',
      plan: { ...task.plan, approvalStatus: 'rejected' },
      error: parsed.data.note?.trim() || 'Plan rejected by operator.',
    });
    const event = await store.appendEvent(rejected, {
      type: 'plan.rejected',
      agentId: 'planner',
      payload: { version: rejected.planVersion, rejectedBy: userId, note: parsed.data.note?.trim() || '' },
    });
    hub.publish(event);
    return c.json({ task: rejected, event }, 202);
  });

  api.post('/tasks/:taskId/approve-review', async (c) => {
    const taskId = c.req.param('taskId');
    const { tenantId, userId } = identity(c.req.raw.headers);
    const task = await store.getTask(taskId, tenantId);
    if (!task) return c.json({ error: 'Task not found.' }, 404);
    if (task.status !== 'waiting_for_human' || !task.review) return c.json({ error: 'Task is not waiting for review approval.' }, 409);
    const parsed = reviewDecisionSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'Invalid review decision.' }, 400);
    const note = parsed.data.note?.trim() || 'Approved by operator despite the automated quality gate.';
    const review = { ...task.review, approved: true, summary: `${task.review.summary} 人工审核：${note || '操作员批准当前结果。'}` };
    const approved = await store.updateTask(taskId, { status: 'queued', review, error: null, cancelRequested: false });
    const event = await store.appendEvent(approved, {
      type: 'review.approved',
      agentId: 'operator-review',
      payload: { approvedBy: userId, note, score: review.score },
    });
    hub.publish(event);
    coordinator.nudge();
    return c.json({ task: approved, event }, 202);
  });

  api.post('/tasks/:taskId/reject-review', async (c) => {
    const taskId = c.req.param('taskId');
    const { tenantId, userId } = identity(c.req.raw.headers);
    const task = await store.getTask(taskId, tenantId);
    if (!task) return c.json({ error: 'Task not found.' }, 404);
    if (task.status !== 'waiting_for_human' || !task.review) return c.json({ error: 'Task is not waiting for review approval.' }, 409);
    const parsed = reviewDecisionSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'Invalid review decision.' }, 400);
    const note = parsed.data.note?.trim() || 'Review rejected by operator; replan is required.';
    const rejected = await store.updateTask(taskId, { status: 'paused', error: note, cancelRequested: false });
    const event = await store.appendEvent(rejected, {
      type: 'review.rejected',
      agentId: 'operator-review',
      payload: { rejectedBy: userId, note, score: task.review.score },
    });
    hub.publish(event);
    return c.json({ task: rejected, event }, 202);
  });

  api.post('/tasks/:taskId/approve-tool', async (c) => {
    const taskId = c.req.param('taskId');
    const principal = identity(c.req.raw.headers);
    const task = await store.getTask(taskId, principal.tenantId);
    if (!task) return c.json({ error: 'Task not found.' }, 404);
    if (principal.role !== 'owner' && principal.role !== 'admin' && task.userId !== principal.userId) return c.json({ error: 'Only the task owner or tenant admin can approve a tool call.' }, 403);
    if (task.status !== 'waiting_for_human') return c.json({ error: 'Task is not waiting for a tool approval.' }, 409);
    const parsed = toolDecisionSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'Invalid tool approval.' }, 400);
    const approval = task.toolApprovals?.find((item) => item.status === 'pending' && (!parsed.data.approvalId || item.id === parsed.data.approvalId));
    if (!approval) return c.json({ error: 'No matching pending tool approval was found.' }, 409);
    const note = parsed.data.note?.trim() || 'Approved by task operator.';
    const decidedAt = new Date().toISOString();
    const approvals = (task.toolApprovals ?? []).map((item) => item.id === approval.id
      ? { ...item, status: 'approved' as const, decidedAt, decidedBy: principal.userId, note }
      : item);
    const delegatedApproval = await harnessBridge?.approve(task.id, approval.id, 'approved', note);
    if (delegatedApproval && !delegatedApproval.accepted) {
      return c.json({ error: delegatedApproval.reason || '外部 Harness 未接受此审批。' }, 409);
    }
    // An active external Harness still owns the task after its approval is
    // resolved. Keep it running and do not wake the built-in coordinator, or
    // both executors could claim the same task concurrently.
    const approved = await store.updateTask(taskId, {
      status: delegatedApproval ? 'running' : 'queued',
      toolApprovals: approvals,
      error: null,
      cancelRequested: false,
    });
    const event = await store.appendEvent(approved, {
      type: 'tool.approved',
      agentId: 'operator-tool',
      payload: {
        approval: approvals.find((item) => item.id === approval.id),
        approvedBy: principal.userId,
        note,
        ...(delegatedApproval ? { externalHarness: true } : {}),
      },
    });
    hub.publish(event);
    if (!delegatedApproval) coordinator.nudge();
    return c.json({ task: approved, event }, 202);
  });

  api.post('/tasks/:taskId/reject-tool', async (c) => {
    const taskId = c.req.param('taskId');
    const principal = identity(c.req.raw.headers);
    const task = await store.getTask(taskId, principal.tenantId);
    if (!task) return c.json({ error: 'Task not found.' }, 404);
    if (principal.role !== 'owner' && principal.role !== 'admin' && task.userId !== principal.userId) return c.json({ error: 'Only the task owner or tenant admin can reject a tool call.' }, 403);
    if (task.status !== 'waiting_for_human') return c.json({ error: 'Task is not waiting for a tool approval.' }, 409);
    const parsed = toolDecisionSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'Invalid tool rejection.' }, 400);
    const approval = task.toolApprovals?.find((item) => item.status === 'pending' && (!parsed.data.approvalId || item.id === parsed.data.approvalId));
    if (!approval) return c.json({ error: 'No matching pending tool approval was found.' }, 409);
    const note = parsed.data.note?.trim() || 'Rejected by task operator.';
    const decidedAt = new Date().toISOString();
    const approvals = (task.toolApprovals ?? []).map((item) => item.id === approval.id
      ? { ...item, status: 'rejected' as const, decidedAt, decidedBy: principal.userId, note }
      : item);
    const delegatedRejection = await harnessBridge?.approve(task.id, approval.id, 'rejected', note);
    if (delegatedRejection && !delegatedRejection.accepted) {
      return c.json({ error: delegatedRejection.reason || '外部 Harness 未接受此审批。' }, 409);
    }
    const rejected = await store.updateTask(taskId, { status: 'paused', toolApprovals: approvals, error: note, cancelRequested: false });
    const event = await store.appendEvent(rejected, {
      type: 'tool.rejected',
      agentId: 'operator-tool',
      payload: { approval: approvals.find((item) => item.id === approval.id), rejectedBy: principal.userId, note },
    });
    hub.publish(event);
    return c.json({ task: rejected, event }, 202);
  });

  api.post('/tasks/:taskId/replan', async (c) => {
    const taskId = c.req.param('taskId');
    const { tenantId, userId } = identity(c.req.raw.headers);
    const task = await store.getTask(taskId, tenantId);
    if (!task) return c.json({ error: 'Task not found.' }, 404);
    if (task.status === 'running' || task.status === 'reviewing' || task.status === 'planning') coordinator.abort(taskId);
    const parsed = replanSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'A replan instruction is required.' }, 400);
    const instructionEvent = await store.appendEvent(task, {
      type: 'human.note',
      payload: { message: `Replan instruction: ${parsed.data.instruction.trim()}`, author: userId, source: 'replan' },
    });
    hub.publish(instructionEvent);
    const replanned = await store.updateTask(taskId, {
      status: 'queued',
      plan: null,
      planVersion: (task.planVersion ?? 0) + 1,
      stepResults: parsed.data.preserveCompleted ? task.stepResults : [],
      review: null,
      result: null,
      error: null,
      cancelRequested: false,
    });
    const event = await store.appendEvent(replanned, {
      type: 'plan.replanned',
      agentId: 'planner',
      payload: { version: replanned.planVersion, instruction: parsed.data.instruction.trim(), preserveCompleted: parsed.data.preserveCompleted, requestedBy: userId },
    });
    hub.publish(event);
    coordinator.nudge();
    return c.json({ task: replanned, event }, 202);
  });

  const descendantsOf = (task: NonNullable<Awaited<ReturnType<TaskStore['getTask']>>>, stepId: string) => {
    const descendants = new Set<string>([stepId]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const step of task.plan?.steps ?? []) {
        if (!descendants.has(step.id) && step.dependsOn.some((dependency) => descendants.has(dependency))) {
          descendants.add(step.id);
          changed = true;
        }
      }
    }
    return descendants;
  };

  api.post('/tasks/:taskId/nodes/:nodeId/:action', async (c) => {
    const taskId = c.req.param('taskId');
    const nodeId = c.req.param('nodeId');
    const action = c.req.param('action');
    if (!['retry', 'rerun', 'skip', 'complete'].includes(action)) return c.json({ error: 'Unknown node action.' }, 404);
    const { tenantId, userId } = identity(c.req.raw.headers);
    const task = await store.getTask(taskId, tenantId);
    if (!task) return c.json({ error: 'Task not found.' }, 404);
    const step = task.plan?.steps.find((candidate) => candidate.id === nodeId);
    if (!step) return c.json({ error: 'Workflow node not found.' }, 404);
    const parsed = nodeControlSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'Invalid node control request.' }, 400);
    const events = action === 'rerun' ? await store.getEvents(task.id) : [];
    const existingResult = task.stepResults.find((result) => result.stepId === nodeId);
    if (action === 'rerun') {
      if (task.status === 'awaiting_approval' || task.status === 'waiting_for_human') {
        return c.json({ error: '该任务正在等待审批或人工处理，完成当前决策后才能局部重跑。' }, 409);
      }
      if (!existingResult || (existingResult.status !== 'completed' && existingResult.status !== 'failed' && !existingResult.skipped)) {
        return c.json({ error: '只能重跑已经执行完成、失败或跳过的 Agent。' }, 409);
      }
      const completedResultIds = new Set(task.stepResults
        .filter((result) => result.status === 'completed' || result.skipped)
        .map((result) => result.stepId));
      const missingDependencies = step.dependsOn.filter((dependency) => !completedResultIds.has(dependency));
      if (missingDependencies.length > 0) {
        return c.json({ error: '局部重跑前必须先完成全部上游 Agent。', missingDependencies }, 409);
      }
      const lastTerminalSequence = events.reduce((latest, event) => {
        if ((event.type === 'agent.completed' || event.type === 'agent.failed') && event.payload.stepId === nodeId) return Math.max(latest, event.sequence);
        return latest;
      }, -1);
      const startedAfterResult = events.some((event) => event.type === 'agent.started'
        && event.payload.stepId === nodeId
        && event.sequence > lastTerminalSequence);
      if (startedAfterResult && task.status === 'running') {
        return c.json({ error: '该 Agent 当前仍在运行，无法局部重跑。' }, 409);
      }
    }
    if (task.status === 'running' || task.status === 'reviewing' || task.status === 'planning') coordinator.abort(taskId);

    const invalidated = descendantsOf(task, nodeId);
    let results = task.stepResults.filter((result) => !invalidated.has(result.stepId));
    const preservedUpstreamSteps = task.stepResults
      .filter((result) => !invalidated.has(result.stepId))
      .map((result) => result.stepId);
    const rerunAttempt = action === 'rerun' ? (existingResult?.attempts ?? 0) + 1 : undefined;
    const parentCheckpoint = action === 'rerun'
      ? { sequence: events.at(-1)?.sequence ?? 0, taskUpdatedAt: task.updatedAt, stepId: nodeId }
      : undefined;
    let eventType: 'node.retry_requested' | 'node.rerun_requested' | 'node.skip_requested' | 'node.completed_manually';
    if (action === 'skip' || action === 'complete') {
      const manual = action === 'complete';
      results = [...results, {
        stepId: nodeId,
        agentId: `operator-${nodeId}`,
        role: step.role,
        status: 'completed' as const,
        output: parsed.data.output?.trim() || (manual ? 'Completed manually by operator.' : `Skipped by operator: ${parsed.data.reason?.trim() || 'No reason supplied.'}`),
        evidence: parsed.data.evidence,
        confidence: parsed.data.confidence,
        attempts: 0,
        durationMs: 0,
        skipped: !manual,
        manual: true,
      }];
      eventType = manual ? 'node.completed_manually' : 'node.skip_requested';
    } else {
      eventType = action === 'retry' ? 'node.retry_requested' : 'node.rerun_requested';
    }
    const updated = await store.updateTask(taskId, {
      status: task.plan?.approvalStatus === 'pending' ? 'awaiting_approval' : 'queued',
      stepResults: results,
      review: null,
      result: null,
      error: null,
      cancelRequested: false,
    });
    const event = await store.appendEvent(updated, {
      type: eventType,
      agentId: `operator-${nodeId}`,
      payload: {
        stepId: nodeId,
        action,
        reason: parsed.data.reason?.trim() || '',
        invalidatedSteps: [...invalidated],
        requestedBy: userId,
        ...(rerunAttempt !== undefined ? { rerunAttempt, parentCheckpoint, preservedUpstreamSteps } : {}),
      },
    });
    hub.publish(event);
    const graphEvent = await store.appendEvent(updated, {
      type: 'graph.updated',
      payload: { graph: updated.plan?.graph, reason: `node-${action}`, invalidatedSteps: [...invalidated] },
    });
    hub.publish(graphEvent);
    if (updated.status === 'queued') coordinator.nudge();
    return c.json({ task: updated, event, invalidatedSteps: [...invalidated] }, 202);
  });

  api.post('/tasks/:taskId/cancel', async (c) => {
    const taskId = c.req.param('taskId');
    const { tenantId } = identity(c.req.raw.headers);
    const cancelled = await store.requestCancel(taskId, tenantId);
    if (!cancelled) return c.json({ error: 'Task was not found or is already terminal.' }, 409);
    const task = await store.getTask(taskId, tenantId);
    if (task?.status === 'cancelled') {
      const event = await store.appendEvent(task, {
        type: 'task.cancelled',
        payload: { reason: 'Cancellation requested before execution.' },
      });
      hub.publish(event);
    }
    coordinator.abort(taskId);
    coordinator.nudge();
    return c.json({ taskId, cancelRequested: true }, 202);
  });

  api.post('/tasks/:taskId/retry', async (c) => {
    const { tenantId } = identity(c.req.raw.headers);
    const original = await store.getTask(c.req.param('taskId'), tenantId);
    if (!original) return c.json({ error: 'Task not found.' }, 404);
    if (original.status !== 'failed' && original.status !== 'cancelled') {
      return c.json({ error: 'Only failed or cancelled tasks can be retried.' }, 409);
    }
    const retried = await store.createTask({
      tenantId: original.tenantId,
      userId: original.userId,
      sessionId: original.sessionId,
      title: original.title,
      input: original.input,
      mode: original.mode,
      model: original.model,
      modelCredentialId: original.modelCredentialId,
    });
    metrics?.recordTask('created');
    const created = await store.appendEvent(retried, {
      type: 'task.created',
      payload: { title: retried.title, mode: retried.mode, retryOfTaskId: original.id },
    });
    hub.publish(created);
    const queued = await store.appendEvent(retried, {
      type: 'task.queued',
      payload: { retryOfTaskId: original.id },
    });
    hub.publish(queued);
    coordinator.nudge();
    return c.json({ task: retried, retryOfTaskId: original.id, eventsUrl: `/api/tasks/${retried.id}/events` }, 202);
  });

  api.get('/tasks/:taskId/tools/audit', async (c) => {
    const { tenantId } = identity(c.req.raw.headers);
    const task = await store.getTask(c.req.param('taskId'), tenantId);
    if (!task) return c.json({ error: 'Task not found.' }, 404);
    const events = (await store.getEvents(task.id)).filter((event) => event.type === 'tool.started'
      || event.type === 'tool.completed'
      || event.type === 'tool.failed'
      || event.type === 'tool.approval_requested'
      || event.type === 'tool.approved'
      || event.type === 'tool.rejected');
    return c.json({ taskId: task.id, approvals: task.toolApprovals ?? [], events });
  });

  api.get('/tasks/:taskId/artifacts/result', async (c) => {
    const { tenantId } = identity(c.req.raw.headers);
    const task = await store.getTask(c.req.param('taskId'), tenantId);
    if (!task) return c.json({ error: 'Task not found.' }, 404);
    if (!task.result) return c.json({ error: 'Result artifact is not available.' }, 404);
    const artifactId = `result:${task.id}`;
    let stored = artifactStore ? await artifactStore.get(artifactId, task.tenantId).then((content) => content ? { key: 'existing', bytes: Buffer.byteLength(content, 'utf8') } : null).catch(() => null) : null;
    if (artifactStore && !stored) {
      try {
        stored = await artifactStore.put(artifactId, task.result, task.tenantId);
      } catch {
        // The durable task result remains available when external storage is temporarily unavailable.
        stored = null;
      }
    }
    if (stored && artifactCatalog) {
      try {
        await artifactCatalog.register({
          id: artifactId,
          tenantId: task.tenantId,
          taskId: task.id,
          source: 'result',
          ...(stored.key !== 'existing' ? { storageKey: stored.key } : {}),
          bytes: stored.bytes,
          mimeType: 'text/markdown',
          referenceKey: 'result',
        });
      } catch {
        // Catalog repair is independent from serving the durable task result.
      }
    }
    return c.json({
      artifact: {
        id: artifactId,
        taskId: task.id,
        kind: 'markdown',
        content: task.result,
        createdAt: task.updatedAt,
        storage: stored ? { kind: artifactStore?.kind, key: stored.key, bytes: stored.bytes } : { kind: 'database' },
      },
    });
  });

  api.get('/tasks/:taskId/thread-graph', async (c) => {
    const taskId = c.req.param('taskId');
    const { tenantId } = identity(c.req.raw.headers);
    const task = await store.getTask(taskId, tenantId);
    if (!task) return c.json({ error: 'Task not found.' }, 404);
    const graph = buildHarnessThreadGraph(await store.getEvents(task.id));
    const rootThreadId = c.req.query('root')?.trim().slice(0, 200);
    const descendants = rootThreadId ? breadthFirstThreadDescendants(graph, rootThreadId) : undefined;
    if (rootThreadId && descendants === null) return c.json({ error: 'Thread not found.' }, 404);
    return c.json({ taskId: task.id, graph, ...(descendants ? { rootThreadId, descendants } : {}) });
  });

  api.get('/tasks/:taskId/events', async (c) => {
    const taskId = c.req.param('taskId');
    const { tenantId } = identity(c.req.raw.headers);
    const task = await store.getTask(taskId, tenantId);
    if (!task) return c.json({ error: 'Task not found.' }, 404);
    const queryAfter = Number(c.req.query('after') ?? 0);
    const headerAfter = Number(c.req.header('last-event-id') ?? 0);
    const after = Number.isFinite(queryAfter) && queryAfter > 0 ? queryAfter : headerAfter;

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        let closed = false;
        let unsubscribe: () => void = () => undefined;
        let heartbeat: NodeJS.Timeout | undefined;
        let replaying = true;
        let lastSequence = Number.isFinite(after) ? after : 0;
        const pending: RuntimeEvent[] = [];
        const close = () => {
          if (closed) return;
          closed = true;
          unsubscribe();
          if (heartbeat) clearInterval(heartbeat);
          controller.close();
        };
        const push = (event: RuntimeEvent) => {
          if (closed || event.sequence <= lastSequence) return;
          lastSequence = event.sequence;
          controller.enqueue(encodeEvent(event));
          if (event.type === 'task.completed'
            || event.type === 'task.failed'
            || event.type === 'task.cancelled'
            || event.type === 'plan.approval_requested'
            || event.type === 'plan.rejected'
            || event.type === 'review.approval_requested'
            || event.type === 'review.rejected'
            || event.type === 'tool.approval_requested'
            || event.type === 'tool.rejected') {
            setTimeout(close, 20);
          }
        };
        const receive = (event: RuntimeEvent) => {
          if (closed || event.sequence <= lastSequence) return;
          if (replaying) pending.push(event);
          else push(event);
        };

        try {
          // Subscribe before replay so events committed during the database read are buffered.
          unsubscribe = hub.subscribe(taskId, receive);
          c.req.raw.signal.addEventListener('abort', close, { once: true });
          const replay = await store.getEvents(taskId, lastSequence);
          for (const event of replay) push(event);
          replaying = false;
          pending.sort((left, right) => left.sequence - right.sequence);
          for (const event of pending) push(event);
          pending.length = 0;
          const current = await store.getTask(taskId);
          if (current && terminalStatuses.has(current.status)) {
            close();
            return;
          }
          heartbeat = setInterval(() => {
            if (!closed) controller.enqueue(new TextEncoder().encode(`: heartbeat ${Date.now()}\n\n`));
          }, 15_000);
          heartbeat.unref();
        } catch (error) {
          unsubscribe();
          if (!closed) controller.error(error);
        }
      },
    });

    return new Response(stream, {
      headers: {
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'Content-Type': 'text/event-stream; charset=utf-8',
        'X-Accel-Buffering': 'no',
      },
    });
  });

  return api;
};
