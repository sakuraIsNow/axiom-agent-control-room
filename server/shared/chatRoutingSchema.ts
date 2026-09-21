import { z } from 'zod';

const intentSchema = z.enum(['conversation', 'agent-registry', 'web-search', 'academic-search', 'github-research', 'image-generation', 'video-generation', 'image-analysis', 'document-analysis', 'report-export', 'task']);
const reportExportDecisionSchema = z.object({
  scope: z.enum(['last-answer', 'conversation']),
  format: z.enum(['md', 'docx', 'tex', 'pdf']),
  title: z.string().min(1).max(120).optional(),
}).strict();
const routeSchema = z.enum(['direct', 'single-agent', 'team', 'full-workflow']);
const taskKindSchema = z.enum(['conversation', 'question', 'research', 'implementation', 'decision', 'creative', 'operations']);
const difficultySchema = z.enum(['trivial', 'easy', 'moderate', 'hard', 'complex']);
// Models commonly emit `null` for an optional object even when the prompt says
// to omit it. Normalize that harmless representation instead of discarding
// the complete Router/Scheduler decision and falling back to regex triage.
const optionalReportExportSchema = z.preprocess(
  (value) => value === null ? undefined : value,
  reportExportDecisionSchema.optional(),
);

export const routerAgentDecisionSchema = z.object({
  intent: intentSchema,
  taskKind: taskKindSchema,
  difficulty: difficultySchema,
  requiresExternalFacts: z.boolean(),
  requiredCapabilities: z.array(z.string().min(1).max(80)).max(12),
  candidateAgentIds: z.array(z.string().min(1).max(80)).min(1).max(12),
  candidateSkillIds: z.array(z.string().min(1).max(80)).max(12),
  confidence: z.number().min(0).max(1),
  rationale: z.string().min(1).max(600),
  reportExport: optionalReportExportSchema,
}).strict();
const schedulingStepSchema = z.object({
  id: z.string().min(1).max(64),
  title: z.string().min(1).max(120),
  agentId: z.string().min(1).max(80),
  objective: z.string().min(1).max(2_000),
  dependsOn: z.array(z.string().min(1).max(64)).max(8),
  skillIds: z.array(z.string().min(1).max(80)).max(8),
}).strict();
export const schedulerAgentDecisionSchema = z.object({
  route: routeSchema,
  activeAgentIds: z.array(z.string().min(1).max(80)).min(1).max(10),
  skippedAgentIds: z.array(z.string().min(1).max(120)).max(24),
  appendAgentIds: z.array(z.string().min(1).max(80)).max(10),
  selectedSkillIds: z.array(z.string().min(1).max(80)).max(12),
  executionWaves: z.array(z.array(z.string().min(1).max(64)).min(1).max(8)).max(8),
  steps: z.array(schedulingStepSchema).max(8),
  requiresReview: z.boolean(),
  synthesisAgentId: z.literal('synthesizer'),
  reason: z.string().min(1).max(600),
}).strict();
export const chatRouteDecisionSchema = z.object({
  intent: intentSchema,
  execution: z.enum(['gateway', 'workflow']),
  agentRole: z.string().min(1).max(80),
  workflowRoute: routeSchema,
  requiresSearch: z.boolean(),
  reason: z.string().min(1).max(600),
  source: z.enum(['router-agent', 'semantic-model', 'deterministic-fallback']),
  skillIds: z.array(z.string().min(1).max(80)).max(12),
  routingVersion: z.string().min(1).max(80),
  routerModel: z.string().min(1).max(160).optional(),
  decisionRouting: z.object({
    mode: z.enum(['shadow', 'hybrid']), provider: z.literal('jev'), model: z.string().min(1).max(160),
    outcome: z.enum(['selected', 'shadow', 'fallback']), reason: z.string().min(1).max(80).optional(),
  }).strict().optional(),
  reportExport: reportExportDecisionSchema.optional(),
  router: routerAgentDecisionSchema,
  scheduler: schedulerAgentDecisionSchema,
}).strict();
