import type { Logger } from 'pino';
import { z } from 'zod';
import type {
  ReviewResult,
  RuntimeEvent,
  StepResult,
  TaskStore,
  TaskProfile,
  TaskKind,
  TaskDifficulty,
  AgentGraph,
  AgentGraphNode,
  AgentGraphEdge,
  AgentMessage,
  WorkflowPlan,
  WorkflowStep,
  WorkflowTask,
  AgentStore,
  UserDefinedAgent,
} from './contracts.js';
import { EventHub } from './eventHub.js';
import type { AgentMemory } from './memoryClient.js';
import type { ModelClient, ModelToolDefinition } from './modelClient.js';
import { agentCatalog, appendMissingAgentDirectory } from './agentCatalog.js';
import { ToolApprovalRequiredError, ToolRegistry, type ToolExecution } from './toolRegistry.js';
import { executeWorkflowSpecialist, isWorkflowSpecialist } from './workflowSpecialists.js';
import { routeSkillIds, runtimeSkillCatalog, skillInstructions } from './skillCatalog.js';
import { evaluateWorkflowConditions } from './workflowConditions.js';
import { analyzeWorkflowDag, workflowDagIssueText } from './workflowDag.js';
import { summarizeCompletionEvidence } from './completionEvidence.js';
import { selectNonConflictingSteps } from './workflowConcurrency.js';
import type { ModelRoutingPolicy } from './modelRouting.js';
import type { ArtifactStore } from './artifactStore.js';
import type { ArtifactCatalog } from './artifactCatalog.js';

const nativeToolNameMaxLength = 64;

export type NativeToolAliasMap = {
  actualToAlias: Map<string, string>;
  aliasToActual: Map<string, string>;
};

/**
 * DeepSeek's function-call wire format rejects namespace separators such as
 * `workspace.read`. Keep the registry name as the source of truth and expose
 * a deterministic, protocol-safe alias only to the model.
 */
export const buildNativeToolAliasMap = (actualNames: string[]): NativeToolAliasMap => {
  const actualToAlias = new Map<string, string>();
  const aliasToActual = new Map<string, string>();
  const usedAliases = new Set<string>();

  for (const actualName of actualNames) {
    if (actualToAlias.has(actualName)) continue;
    const normalized = actualName.replace(/[^a-zA-Z0-9_-]/g, '_');
    const base = `axiom_${normalized}`.replace(/[^a-zA-Z0-9_-]/g, '_');
    let alias = base.slice(0, nativeToolNameMaxLength);
    let suffix = 1;
    while (usedAliases.has(alias) || !/^[a-zA-Z0-9_-]+$/.test(alias)) {
      suffix += 1;
      const suffixText = `_${suffix}`;
      alias = `${base.slice(0, nativeToolNameMaxLength - suffixText.length)}${suffixText}`;
    }
    usedAliases.add(alias);
    actualToAlias.set(actualName, alias);
    aliasToActual.set(alias, actualName);
  }

  return { actualToAlias, aliasToActual };
};

const builtinPlanRoles = ['researcher', 'analyst', 'builder', 'reviewer'] as const;
const plannerPlaceholderModels = new Set([
  'optional-model',
  'default-model',
  'auto-model',
  'auto',
  'default',
  'none',
  'null',
]);

const normalizePlannerModel = (value: unknown, allowedModels: Set<string>) => {
  if (typeof value !== 'string') return undefined;
  const model = value.trim();
  if (!model || plannerPlaceholderModels.has(model.toLowerCase())) return undefined;
  // A planner can only select from the runtime's explicit model catalog. This
  // prevents an LLM-generated label from becoming an upstream API request.
  if (!allowedModels.has(model)) return undefined;
  return model;
};

const isUnsupportedModelError = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:unsupported|supported API model names|invalid).*model|model.*(?:unsupported|not supported|invalid)/i.test(message);
};

const isReasoningModel = (model: string | undefined) => Boolean(model && /(?:reasoner|reasoning|deepseek-v4-pro|deepseek-r1|\br1\b)/i.test(model));

const failureLabel = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const status = (error as { status?: number } | null)?.status;
  if (status === 401 || /unauthori[sz]ed|invalid.*(?:api|key)|api key/i.test(message)) return '模型 API Key 无效或未授权';
  if (status === 403 || /forbidden|permission|权限/i.test(message)) return '模型服务拒绝了当前请求';
  if (status === 404 || /not found|unsupported.*model|model.*(?:not supported|invalid)/i.test(message)) return '当前模型在服务端不可用';
  if (status === 429 || /rate.?limit|too many requests|限流/i.test(message)) return '模型服务暂时限流';
  if (/timeout|timed out|超时/i.test(message)) return '模型响应超时';
  if (/fetch failed|network|连接|socket|econn/i.test(message)) return '无法连接模型服务';
  if (/empty response|no completion|没有返回/i.test(message)) return '模型没有返回最终内容';
  return message.replace(/\s+/g, ' ').slice(0, 240) || '模型执行失败';
};

const failureSummary = (failures: Array<{ title: string; error: unknown }>) => {
  const details = failures.slice(0, 4).map(({ title, error }) => `${title}：${failureLabel(error)}`);
  const suffix = failures.length > details.length ? `，另有 ${failures.length - details.length} 个 Agent` : '';
  return `部分 Agent 未完成（${details.join('；')}${suffix}）。已保存已完成步骤，可在任务管理中重试失败 Agent。`;
};

const buildPlanSchema = (customRoleIds: string[] = []) => z.object({
  summary: z.string().min(1).max(2_000),
  routingReason: z.string().min(1).max(2_000),
  steps: z.array(z.object({
    id: z.string().min(1).max(80),
    title: z.string().min(1).max(160),
    role: z.enum([...builtinPlanRoles, ...customRoleIds] as [string, ...string[]]),
    objective: z.string().min(1).max(4_000),
    dependsOn: z.array(z.string()).max(8).default([]),
    acceptanceCriteria: z.array(z.string().min(1).max(500)).min(1).max(8),
    skillIds: z.array(z.string().min(1).max(80)).max(12).default([]),
    model: z.string().min(1).max(120).optional(),
    toolNames: z.array(z.string().min(1).max(80)).max(16).optional(),
    writeScopes: z.array(z.string().min(1).max(240)).max(16).optional(),
    maxTokens: z.number().int().min(128).max(64_000).optional(),
    maxDurationMs: z.number().int().min(5_000).max(600_000).optional(),
    failureStrategy: z.enum(['retry', 'skip', 'pause']).default('retry'),
  })).min(1).max(8),
});

const stepOutputSchema = z.object({
  output: z.string().min(1),
  evidence: z.array(z.string()).max(20).default([]),
  confidence: z.number().min(0).max(1).default(0.65),
  toolCalls: z.array(z.object({
    name: z.string().min(1).max(80),
    args: z.record(z.string(), z.unknown()).default({}),
  })).max(4).default([]),
  handoff: z.string().max(2_000).optional(),
});

const reviewSchema = z.object({
  approved: z.boolean(),
  score: z.number().min(0).max(100),
  summary: z.string().min(1),
  gaps: z.array(z.string()).max(12).default([]),
  requiredCorrections: z.array(z.string()).max(12).default([]),
});

const extractJson = (content: string): unknown => {
  const unfenced = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try {
    return JSON.parse(unfenced);
  } catch {
    const start = unfenced.indexOf('{');
    const end = unfenced.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(unfenced.slice(start, end + 1));
    throw new Error('模型响应中没有可解析的 JSON 对象。');
  }
};

const fallbackPlan = (task: WorkflowTask): WorkflowPlan => ({
  summary: `为“${task.title}”执行经过验证的多 Agent 工作流。`,
  routingReason: '规划器响应不可用或格式无效，运行时已选择以证据为先的保守工作流。',
  steps: [
    {
      id: 'research',
      title: '收集约束与证据',
      role: 'researcher',
      objective: '识别与任务相关的事实、约束、假设、依赖关系和缺失信息。',
      dependsOn: [],
      acceptanceCriteria: ['重要结论具有证据边界', '未知信息和假设均已明确'],
      skillIds: routeSkillIds(latestUserInput(task.input), 'researcher'),
    },
    {
      id: 'analysis',
      title: '分析方案与风险',
      role: 'analyst',
      objective: '分析可行方案、失败模式、权衡关系和决策标准。',
      dependsOn: [],
      acceptanceCriteria: ['权衡关系具体明确', '风险包含缓解措施'],
      skillIds: routeSkillIds(latestUserInput(task.input), 'analyst'),
    },
    {
      id: 'execution',
      title: '构建可执行方案',
      role: 'builder',
      objective: '将已收集的证据和分析整理为完整、有序且可执行的结果。',
      dependsOn: ['research', 'analysis'],
      acceptanceCriteria: ['结果可以直接执行', '包含依赖关系和验证步骤'],
      skillIds: routeSkillIds(latestUserInput(task.input), 'builder'),
    },
  ],
});

const requiredRolesForProfile = (profile: TaskProfile) => {
  if (profile.route === 'full-workflow') return ['researcher', 'analyst', 'builder'];
  if (profile.route !== 'team') return [];
  if (profile.kind === 'implementation' && profile.reasons.some((reason) => reason.includes('系统级设计'))) {
    return ['researcher', 'analyst', 'builder'];
  }
  if (profile.kind === 'implementation' || profile.kind === 'operations') return ['analyst', 'builder'];
  if (profile.kind === 'creative') return ['analyst', 'builder'];
  return ['researcher', 'analyst'];
};

const roleStepTemplate = (role: string, task: WorkflowTask, existing: WorkflowStep[]): WorkflowStep => {
  const id = `${role}-support`;
  if (role === 'researcher') return {
    id,
    title: '收集约束与依据',
    role,
    objective: `围绕“${latestUserInput(task.input).slice(0, 180)}”提取事实、约束、假设和待确认信息。`,
    dependsOn: [],
    acceptanceCriteria: ['事实、假设和未知项分开记录', '关键约束可被后续 Agent 使用'],
    skillIds: routeSkillIds(latestUserInput(task.input), role),
  };
  if (role === 'analyst') return {
    id,
    title: '分析方案与边界',
    role,
    objective: '基于用户目标和已有依据，拆解方案、边界、风险、取舍与验收标准。',
    dependsOn: existing.some((step) => step.role === 'researcher') ? [existing.find((step) => step.role === 'researcher')!.id] : [],
    acceptanceCriteria: ['方案取舍有明确理由', '风险和验收标准可执行'],
    skillIds: routeSkillIds(latestUserInput(task.input), role),
  };
  return {
    id,
    title: '形成可执行交付',
    role,
    objective: '把前序 Agent 的依据和分析整合成可落地、可验证的交付结果。',
    dependsOn: existing.filter((step) => step.role === 'researcher' || step.role === 'analyst').map((step) => step.id),
    acceptanceCriteria: ['交付内容完整且可以直接执行', '包含验证方式和后续行动'],
    skillIds: routeSkillIds(latestUserInput(task.input), role),
  };
};

const ensurePlanCoverage = (task: WorkflowTask, profile: TaskProfile, input: WorkflowStep[]) => {
  const steps = [...input];
  for (const role of requiredRolesForProfile(profile)) {
    if (steps.some((step) => step.role === role)) continue;
    const candidate = roleStepTemplate(role, task, steps);
    let id = candidate.id;
    let suffix = 2;
    while (steps.some((step) => step.id === id)) id = `${candidate.id}-${suffix++}`;
    steps.push({ ...candidate, id });
  }
  return steps.slice(0, Math.max(1, profile.maxSteps));
};

const limitText = (value: string, max = 12_000) => value.length > max ? `${value.slice(0, max)}\n[内容已截断]` : value;

/**
 * Raised when the final synthesis reached the provider output ceiling and
 * could not be completed within the bounded continuation budget. Keeping the
 * partial text on the error lets the caller persist a truthful, recoverable
 * result instead of losing the work or reporting a false success.
 */
export class SynthesisIncompleteError extends Error {
  readonly partialContent: string;
  readonly continuationAttempts: number;

  constructor(partialContent: string, continuationAttempts: number, cause?: unknown) {
    super('最终交付内容未完整生成：模型输出达到上限，续写未能完成，请重试。');
    this.name = 'SynthesisIncompleteError';
    this.partialContent = partialContent;
    this.continuationAttempts = continuationAttempts;
    if (cause) this.cause = cause;
  }
}

/** Remove a repeated tail/head overlap when a provider repeats context. */
const mergeContinuation = (previous: string, continuation: string) => {
  const next = continuation.trimStart();
  if (!next) return previous;
  const maxOverlap = Math.min(previous.length, next.length, 12_000);
  for (let size = maxOverlap; size >= 24; size -= 1) {
    if (previous.slice(-size) === next.slice(0, size)) return previous + next.slice(size);
  }
  const needsSeparator = !previous.endsWith('\n') && !/^[，。！？；：、,.!?;:)]/.test(next);
  return `${previous}${needsSeparator ? '\n' : ''}${next}`;
};

const isOutputLimitFinishReason = (reason: string | undefined) => Boolean(
  reason && /^(?:length|max_tokens|token_limit)$/i.test(reason.trim()),
);

type ParallelConflict = {
  stepIds: [string, string];
  signals: string[];
  summary: string;
};

const detectParallelConflicts = (results: StepResult[]): ParallelConflict[] => {
  const polarity = (output: string) => {
    const negative = /(不支持|不能|失败|不通过|不推荐|不可行|不成立|no|false|unsupported|fail(?:s|ed)?|reject(?:ed)?|not feasible)/i.test(output);
    return {
      // Negative phrases take precedence because Chinese negation contains
      // the positive token (for example, 不支持 contains 支持).
      positive: !negative && /(支持|可以|成功|通过|推荐|可行|成立|yes|true|supported|succeed(?:s|ed)?|pass(?:es|ed)?|recommend(?:ed)?|feasible)/i.test(output),
      negative,
    };
  };
  const conflicts: ParallelConflict[] = [];
  for (let leftIndex = 0; leftIndex < results.length; leftIndex += 1) {
    const left = results[leftIndex]!;
    if (left.status !== 'completed') continue;
    for (let rightIndex = leftIndex + 1; rightIndex < results.length; rightIndex += 1) {
      const right = results[rightIndex]!;
      if (right.status !== 'completed') continue;
      const leftPolarity = polarity(left.output);
      const rightPolarity = polarity(right.output);
      const signals: string[] = [];
      if (leftPolarity.positive && rightPolarity.negative) signals.push(`${left.stepId}:positive/${right.stepId}:negative`);
      if (leftPolarity.negative && rightPolarity.positive) signals.push(`${left.stepId}:negative/${right.stepId}:positive`);
      if (signals.length) {
        conflicts.push({
          stepIds: [left.stepId, right.stepId],
          signals,
          summary: '并行 Agent 对同一结论给出了相反倾向，必须由 Reviewer 或人工确认。',
        });
      }
    }
  }
  return conflicts;
};

const latestUserInput = (input: string) => {
  const matches = [...input.matchAll(/USER:\s*([\s\S]*?)(?=\n\n(?:ASSISTANT|USER):|$)/gi)];
  return (matches.at(-1)?.[1] ?? input).trim();
};

const normalizeTaskText = (input: string) => latestUserInput(input)
  .toLocaleLowerCase('zh-CN')
  .replace(/[\s\u3000]+/g, ' ')
  .replace(/[.!?,，。！？]+$/g, '')
  .trim();

const isConversationalInput = (input: string) => {
  const normalized = normalizeTaskText(input);
  if (normalized.length > 120) return false;
  if (/^(hi|hello|hey|yo|你好|您好|嗨|哈喽|早上好|下午好|晚上好|晚安|谢谢|感谢|thanks|thank you|bye|再见)(?:\s+(there|axiom|again))?$/.test(normalized)) return true;
  return !/(请|帮我|需要|实现|构建|设计|分析|评估|比较|审查|修复|编写|部署|如何|方案|代码|implement|build|design|analy[sz]e|compare|review|fix|deploy|plan|write|create)/i.test(normalized);
};

const isAgentCatalogQuestion = (input: string) => {
  const normalized = normalizeTaskText(input);
  return /(有哪些|哪几个|什么|列出|介绍|查看|显示|list|which|what).{0,24}(子.?agent|子智能体|智能体|agent|agents|角色|能力)/i.test(normalized)
    || /(子.?agent|子智能体|agent catalog|agent list|available agents|可用智能体)/i.test(normalized);
};

export const classifyTask = (input: string, mode: WorkflowTask['mode']): TaskProfile => {
  const normalized = normalizeTaskText(input);
  const social = /^(hi|hello|hey|yo|你好|您好|嗨|哈喽|早上好|下午好|晚上好|晚安|谢谢|感谢|thanks|thank you|bye|再见|你能做什么|你会做什么|what can you do)$/i.test(normalized);
  const implementation = /(实现|构建|开发|编写|设计|规划|方案|写|代码|修复|部署|搭建|implement|build|develop|design|architect|code|fix|deploy|create|write|function|script|program)/i.test(normalized);
  const research = /(研究|调研|调查|资料|文献|查找|事实|分析|梳理|总结|research|investigate|evidence|summarize|analy[sz]e)/i.test(normalized);
  const decision = mode === 'decide' || /(选择|决策|比较|对比|评估|权衡|方案|取舍|recommend|trade.?off|compare|decide|evaluate)/i.test(normalized);
  const operations = /(执行|运行|监控|排查|迁移|上线|运维|操作|operate|monitor|migrate|incident|runbook)/i.test(normalized);
  const creative = /(创作|文案|故事|绘图|图像|海报|创意|creative|copywriting|story|image|poster)/i.test(normalized);
  const explicitComparison = decision
    && /(比较|对比|权衡|trade.?off|compare|evaluate)/i.test(normalized)
    && !/(实现|编写|修复|写文件|implement|develop|fix|write code)/i.test(normalized);

  let kind: TaskKind = 'question';
  if (social) kind = 'conversation';
  // An explicit decision mode is authoritative. Words such as "deploy" can
  // appear in a trade-off question without turning the request into an
  // implementation task.
  else if (mode === 'decide' || explicitComparison || (decision && !implementation)) kind = 'decision';
  else if (implementation) kind = 'implementation';
  else if (operations) kind = 'operations';
  else if (research) kind = 'research';
  else if (creative) kind = 'creative';
  else if (!isConversationalInput(input)) kind = 'question';

  let score = 0;
  const reasons: string[] = [];
  if (normalized.length > 220) {
    score += 1;
    reasons.push('上下文较长');
  }
  if (normalized.length > 700) {
    score += 1;
    reasons.push('输入内容较多');
  }
  if (/(并且|同时|分别|步骤|阶段|要求|验收|验证|风险|依赖|and|then|steps|requirements|verify|risks|dependencies)/i.test(normalized)) {
    score += 1;
    reasons.push('包含多项约束');
  }
  if (decision && score < 2 && /(比较|对比|权衡|trade.?off|compare)/i.test(normalized)) {
    score += 1;
    reasons.push('需要明确比较和决策');
  }
  if (/(生产级|生产环境|production|workflow|工作流|架构|architecture|multi.?agent|多.?agent|多智能体|子.?agent|复杂|完整|全面|端到端|end.?to.?end|agent graph|loop|harness)/i.test(normalized)) {
    score += 2;
    reasons.push('涉及系统级范围');
  }
  if (/(任务队列|消息队列|失败恢复|可恢复|重试|依赖关系|验收标准|验收|成本控制|并发|持久化|数据库|队列|子.?agent.?协作|协作|task queue|failure recovery|acceptance criteria|dependencies|cost control|database|queue|retry|resume|checkpoint)/i.test(normalized)) {
    score += 1;
    reasons.push('包含运行与交付约束');
  }
  if (kind !== 'question' && kind !== 'conversation' && /(安全|认证|支付|数据库|迁移|合规|security|auth|payment|database|migration|compliance)/i.test(normalized)) {
    score += 2;
    reasons.push('属于高影响领域');
  }
  if ((kind === 'implementation' || kind === 'operations') && normalized.length > 80) {
    score += 1;
    reasons.push('包含实际执行内容');
  }
  if (mode === 'build' && normalized.length > 160) {
    score += 1;
    reasons.push('采用构建模式');
  }
  const systemDesign = /(?:设计|规划|架构|方案|design|architect|architecture)/i.test(normalized)
    && /(?:平台|系统|服务|网站|应用|产品|模块|接口|数据流|多智能体|agent|platform|system|service|application|product|module|api)/i.test(normalized);
  if (systemDesign) {
    score += 2;
    reasons.push('需要系统级设计与边界拆解');
  } else if (/(?:设计|规划|架构|方案|design|architect|architecture)/i.test(normalized)) {
    score += 1;
    reasons.push('需要形成结构化方案');
  }
  if (score === 0) reasons.push('请求简短且边界清晰');

  const difficulty: TaskDifficulty = score <= 0
    ? 'trivial'
    : score === 1
      ? 'easy'
      : score === 2
        ? 'moderate'
        : score <= 4
          ? 'hard'
          : 'complex';
  const route = kind === 'conversation' || (kind === 'question' && score <= 1)
    ? 'direct'
    : score <= 1
      ? 'single-agent'
      : score === 2
        ? 'team'
        : 'full-workflow';
  return {
    kind,
    difficulty,
    route,
    score,
    reasons,
    maxSteps: route === 'direct' ? 0 : route === 'single-agent' ? 1 : route === 'team' ? 3 : 8,
    requiresReview: route === 'full-workflow',
  };
};

const routingPlan = (task: WorkflowTask, profile: TaskProfile): WorkflowPlan => ({
  summary: `已为当前任务选择 ${profile.route} 路由（${profile.difficulty}）。`,
  routingReason: `任务分类评分 ${profile.score}：${profile.reasons.join('、')}。`,
  steps: [],
  profile,
});

const buildAgentGraph = (
  steps: WorkflowStep[],
  results: StepResult[] = [],
  includeQualityGate = false,
  synthesizerStatus: AgentGraphNode['status'] = 'queued',
  revision = 1,
): AgentGraph => {
  const resultByStep = new Map(results.map((result) => [result.stepId, result]));
  const qualityGateStep: WorkflowStep | null = includeQualityGate && !steps.some((step) => step.role === 'reviewer')
    ? { id: 'reviewer-final', title: '质量审查', role: 'reviewer', objective: '验证证据树。', dependsOn: steps.map((step) => step.id), acceptanceCriteria: ['质量门禁清晰明确'], skillIds: ['quality-review'] }
    : null;
  const graphSteps: WorkflowStep[] = qualityGateStep ? [...steps, qualityGateStep] : steps;
  const dag = analyzeWorkflowDag(graphSteps);
  const waveByStep = new Map(dag.waves.flatMap((wave, index) => wave.map((stepId) => [stepId, index] as const)));
  const synthesisDependencies = qualityGateStep
    ? [qualityGateStep.id]
    : graphSteps.map((step) => step.id);
  const nodes: AgentGraphNode[] = [
    {
      id: 'orchestrator',
      agentId: 'orchestrator',
      role: 'orchestrator',
      title: 'Orchestrator',
      dependsOn: [],
      status: results.length ? 'completed' : 'running',
      executionWave: 0,
    },
    ...graphSteps.map((step) => ({
      id: step.id,
      stepId: step.id,
      agentId: `${step.role}-${step.id}`,
      parentId: 'orchestrator',
      role: step.role,
      title: step.title,
      dependsOn: step.dependsOn,
      status: resultByStep.get(step.id)?.skipped ? 'skipped' : (resultByStep.get(step.id)?.status ?? 'queued') as AgentGraphNode['status'],
      executionWave: (waveByStep.get(step.id) ?? 0) + 1,
      skillIds: step.skillIds,
      writeScopes: step.writeScopes,
      tokens: resultByStep.get(step.id)?.tokens,
      durationMs: resultByStep.get(step.id)?.durationMs,
      attempts: resultByStep.get(step.id)?.attempts,
      toolCalls: resultByStep.get(step.id)?.toolCalls?.length ?? 0,
      failureReason: resultByStep.get(step.id)?.status === 'failed' ? resultByStep.get(step.id)?.output : undefined,
    })),
    {
      id: 'synthesizer',
      agentId: 'synthesizer',
      role: 'synthesizer',
      title: '汇总交付',
      dependsOn: synthesisDependencies,
      status: synthesizerStatus,
      parentId: 'orchestrator',
      executionWave: (dag.waves.length || 0) + 1,
    },
  ];
  const edges: AgentGraphEdge[] = graphSteps.flatMap((step) => {
    const dependencies = step.dependsOn.length ? step.dependsOn : ['orchestrator'];
    return dependencies.map((dependency) => ({
      from: dependency,
      to: step.id,
      kind: step.role === 'reviewer'
        ? 'review' as const
        : dependency === 'orchestrator'
          ? 'delegation' as const
          : 'dependency' as const,
    }));
  });
  if (synthesisDependencies.length > 0) {
    edges.push(...synthesisDependencies.map((dependency) => ({
      from: dependency,
      to: 'synthesizer',
      kind: 'dependency' as const,
    })));
  }
  return { nodes, edges, revision: Math.max(1, Math.floor(revision)) };
};

const retryDelay = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal.addEventListener('abort', () => {
    clearTimeout(timer);
    reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  }, { once: true });
});

export class WorkflowOrchestrator {
  private readonly taskModels = new Map<string, Promise<ModelClient>>();
  private readonly guidanceLocks = new Map<string, Promise<void>>();
  private readonly stepConcurrency: number;
  private readonly reasoningStepConcurrency: number;
  private readonly stepMaxAttempts: number;
  private readonly reasoningStepTimeoutMs: number;
  private readonly reviewCorrectionRounds: number;
  private readonly requireReviewApproval: boolean;
  private readonly reviewMinScore: number;
  private readonly synthesisMaxTokens: number;
  private readonly synthesisContinuationRounds: number;

  constructor(
    private readonly store: TaskStore,
    private readonly hub: EventHub,
    private readonly model: ModelClient,
    private readonly memory: AgentMemory,
    private readonly logger: Logger,
    private readonly tools?: ToolRegistry,
    private readonly agents?: AgentStore,
    private readonly modelResolver?: (task: WorkflowTask) => Promise<ModelClient | undefined>,
    private readonly modelRouting?: ModelRoutingPolicy,
    private readonly artifactStore?: ArtifactStore | null,
    private readonly artifactCatalog?: ArtifactCatalog | null,
  ) {
    // Dependency-ready steps define the useful parallelism; six is the
    // system safety ceiling, not a setting ordinary users need to tune.
    const configuredStepConcurrency = Number(process.env.AGENT_STEP_CONCURRENCY ?? 6);
    this.stepConcurrency = Math.min(6, Math.max(1, Number.isFinite(configuredStepConcurrency) ? configuredStepConcurrency : 6));
    const configuredReasoningConcurrency = Number(process.env.AGENT_REASONING_STEP_CONCURRENCY ?? 3);
    this.reasoningStepConcurrency = Math.min(
      this.stepConcurrency,
      Math.max(1, Number.isFinite(configuredReasoningConcurrency) ? configuredReasoningConcurrency : 3),
    );
    const configuredStepAttempts = Number(process.env.AGENT_STEP_MAX_ATTEMPTS ?? 2);
    this.stepMaxAttempts = Math.min(4, Math.max(1, Number.isFinite(configuredStepAttempts) ? configuredStepAttempts : 2));
    const configuredReasoningStepTimeout = Number(process.env.AGENT_REASONING_STEP_TIMEOUT_MS ?? 300_000);
    this.reasoningStepTimeoutMs = Math.max(
      120_000,
      Number.isFinite(configuredReasoningStepTimeout) ? configuredReasoningStepTimeout : 300_000,
    );
    this.reviewCorrectionRounds = Math.min(3, Math.max(0, Number(process.env.AGENT_REVIEW_CORRECTION_ROUNDS ?? 1)));
    this.requireReviewApproval = process.env.AGENT_REQUIRE_REVIEW_APPROVAL !== 'false';
    this.reviewMinScore = Math.min(100, Math.max(0, Number(process.env.AGENT_REVIEW_MIN_SCORE ?? 80)));
    // DeepSeek chat-compatible endpoints commonly cap one completion at 8k
    // tokens. Continuations provide a larger effective delivery without
    // sending an unsupported max_tokens value to those providers.
    const configuredSynthesisTokens = Number(process.env.AGENT_SYNTHESIS_MAX_TOKENS ?? 8_192);
    this.synthesisMaxTokens = Math.min(64_000, Math.max(1_024, Number.isFinite(configuredSynthesisTokens) ? configuredSynthesisTokens : 8_192));
    const configuredContinuationRounds = Number(process.env.AGENT_SYNTHESIS_MAX_CONTINUATIONS ?? 4);
    this.synthesisContinuationRounds = Math.min(6, Math.max(0, Number.isFinite(configuredContinuationRounds) ? configuredContinuationRounds : 4));
  }

  private modelForTask(task: WorkflowTask) {
    if (!this.modelResolver || !task.modelCredentialId) return Promise.resolve(this.model);
    const cached = this.taskModels.get(task.id);
    if (cached) return cached;
    const resolved = this.modelResolver(task).then((model) => model ?? this.model);
    this.taskModels.set(task.id, resolved);
    return resolved;
  }

  private plannerModelCatalog(task: WorkflowTask) {
    const configured = (process.env.AXIOM_ALLOWED_MODELS ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    return new Set([this.model.model, task.model, ...configured].filter((value): value is string => Boolean(value)));
  }

  private async customAgentDirectory(task: WorkflowTask): Promise<UserDefinedAgent[]> {
    if (!this.agents) return [];
    try {
      const listed = await this.agents.listAgents(task.tenantId, 100, { userId: task.userId, role: 'member' });
      return listed.filter((agent) => agent.status === 'published');
    } catch (error) {
      this.logger.warn({ taskId: task.id, error }, 'custom agent directory unavailable; using built-in roles');
      return [];
    }
  }

  private async persistResultArtifact(task: WorkflowTask, content: string) {
    if (!this.artifactStore) return undefined;
    try {
      const stored = await this.artifactStore.put(`result:${task.id}`, content, task.tenantId);
      try {
        await this.artifactCatalog?.register({
          id: `result:${task.id}`,
          tenantId: task.tenantId,
          taskId: task.id,
          source: 'result',
          storageKey: stored.key,
          bytes: stored.bytes,
          mimeType: 'text/markdown',
          referenceKey: 'result',
        });
      } catch (error) {
        this.logger.warn({ taskId: task.id, error }, 'result Artifact catalog registration failed; object remains authoritative');
      }
      return { kind: this.artifactStore.kind, key: stored.key, bytes: stored.bytes };
    } catch (error) {
      this.logger.warn({ taskId: task.id, error }, 'result Artifact storage failed; durable task result remains authoritative');
      return { kind: this.artifactStore.kind, error: 'Artifact storage unavailable.' };
    }
  }

  private async emit(
    task: Pick<WorkflowTask, 'id' | 'runId'>,
    event: Omit<RuntimeEvent, 'id' | 'taskId' | 'runId' | 'sequence' | 'timestamp' | 'version'>,
  ) {
    const persisted = await this.store.appendEvent(task, event);
    this.hub.publish(persisted);
    return persisted;
  }

  private async assertActive(taskId: string, signal: AbortSignal) {
    if (signal.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    const current = await this.store.getTask(taskId);
    if (!current || current.cancelRequested) throw new DOMException('Task cancelled', 'AbortError');
    if (current.status === 'paused') throw new DOMException('Task paused', 'AbortError');
  }

  private async humanNotes(taskId: string) {
    const events = await this.store.getEvents(taskId);
    return events
      .filter((event) => event.type === 'human.note')
      .map((event) => {
        const note = typeof event.payload.message === 'string' ? event.payload.message : '';
        const author = typeof event.payload.author === 'string' ? event.payload.author : 'operator';
        return note ? `[${author}] ${note}` : '';
      })
      .filter(Boolean)
      .slice(-8)
      .join('\n');
  }

  private async applyPendingGuidance(task: WorkflowTask, stage: string, targetAgentIds: string[] = []) {
    const previous = this.guidanceLocks.get(task.id) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    this.guidanceLocks.set(task.id, queued);
    await previous;
    try {
      const events = await this.store.getEvents(task.id);
      const appliedIds = new Set(events
        .filter((event) => event.type === 'human.guidance_applied')
        .map((event) => String(event.payload.guidanceId ?? ''))
        .filter(Boolean));
      const pending = events
        .filter((event) => event.type === 'human.guidance_accepted')
        .filter((event) => event.payload.delivery !== 'external-harness')
        .filter((event) => {
          const guidanceId = String(event.payload.guidanceId ?? '');
          return Boolean(guidanceId) && !appliedIds.has(guidanceId);
        })
        .slice(0, 8);
      if (!pending.length) return { text: '', guidanceIds: [] as string[] };

      const guidanceIds: string[] = [];
      const lines: string[] = [];
      for (const event of pending) {
        const guidanceId = String(event.payload.guidanceId);
        const message = typeof event.payload.message === 'string' ? limitText(event.payload.message, 4_000) : '';
        if (!message) continue;
        guidanceIds.push(guidanceId);
        lines.push(message);
        await this.emit(task, {
          type: 'human.guidance_applied',
          payload: {
            guidanceId,
            acceptedSequence: event.sequence,
            behavior: event.payload.behavior === 'replan' ? 'replan' : 'continue',
            delivery: 'builtin-next-safe-point',
            applicationPoint: stage,
            targetAgentIds,
          },
        });
      }
      return { text: lines.join('\n'), guidanceIds };
    } finally {
      release();
      if (this.guidanceLocks.get(task.id) === queued) this.guidanceLocks.delete(task.id);
    }
  }

  private async budgetUsage(taskId: string) {
    const events = await this.store.getEvents(taskId);
    return events.reduce((usage, event) => {
      if (event.type !== 'model.completed') return usage;
      usage.tokens += Number(event.payload.totalTokens ?? 0);
      usage.costUsd += Number(event.payload.estimatedCostUsd ?? 0);
      return usage;
    }, { tokens: 0, costUsd: 0 });
  }

  private async complete(
    task: WorkflowTask,
    stage: string,
    request: Parameters<ModelClient['complete']>[0],
  ) {
    const before = await this.budgetUsage(task.id);
    if ((task.policy.maxTokens && before.tokens >= task.policy.maxTokens)
      || (task.policy.maxCostUsd && before.costUsd >= task.policy.maxCostUsd)) {
      await this.emit(task, { type: 'budget.exceeded', payload: { stage, ...before, policy: task.policy } });
      throw new Error(`Task budget exceeded before ${stage}.`);
    }
    const spanId = crypto.randomUUID();
    const streamAgentId = stage.startsWith('single-agent:')
      ? `solo-${stage.slice('single-agent:'.length)}`
      : stage.startsWith('agent:')
        ? stage.slice('agent:'.length).split(':')[0]
        : stage === 'planner'
          ? 'planner'
        : stage === 'reviewer'
          ? 'reviewer-final'
            : stage.startsWith('synthesizer')
              ? 'synthesizer'
              : undefined;
    let bufferedContent = '';
    let bufferedReasoning = '';
    let lastDeltaFlushAt = 0;
    const flushDelta = async () => {
      if (!bufferedContent && !bufferedReasoning) return;
      const content = bufferedContent;
      const reasoning = bufferedReasoning;
      bufferedContent = '';
      bufferedReasoning = '';
      lastDeltaFlushAt = Date.now();
      await this.emit(task, {
        type: 'model.delta',
        agentId: streamAgentId,
        payload: { stage, content, reasoning },
      });
    };
    const modelClient = await this.modelForTask(task);
    const completion = await modelClient.complete({
      ...request,
      model: request.model ?? task.model,
      onDelta: async (delta) => {
        if (request.streamDeltas === false) return;
        bufferedContent += delta.content ?? '';
        bufferedReasoning += delta.reasoning ?? '';
        if (Date.now() - lastDeltaFlushAt >= 45 || bufferedContent.length >= 1_024) await flushDelta();
      },
      onRetry: async (nextAttempt) => {
        await flushDelta();
        await this.emit(task, {
          type: 'model.delta',
          agentId: streamAgentId,
          payload: { stage, reset: true, attempt: nextAttempt },
        });
      },
    });
    await flushDelta();
    const promptTokens = Number(completion.usage?.prompt_tokens ?? completion.usage?.input_tokens ?? 0);
    const completionTokens = Number(completion.usage?.completion_tokens ?? completion.usage?.output_tokens ?? 0);
    const totalTokens = Number(completion.usage?.total_tokens ?? promptTokens + completionTokens);
    const inputRate = Number(process.env.AGENT_INPUT_COST_PER_1K_USD ?? 0);
    const outputRate = Number(process.env.AGENT_OUTPUT_COST_PER_1K_USD ?? 0);
    const estimatedCostUsd = (promptTokens / 1_000) * inputRate + (completionTokens / 1_000) * outputRate;
    const after = { tokens: before.tokens + totalTokens, costUsd: before.costUsd + estimatedCostUsd };
    await this.emit(task, {
      type: 'model.completed',
      payload: {
        stage,
        spanId,
        model: request.model ?? task.model ?? modelClient.model,
        attempts: completion.attempts,
        durationMs: completion.durationMs,
        promptTokens,
        completionTokens,
        totalTokens,
        toolCalls: completion.toolCalls?.length ?? 0,
        ...(completion.finishReason ? { finishReason: completion.finishReason } : {}),
        estimatedCostUsd,
        cumulative: after,
      },
    });
    if ((task.policy.maxTokens && after.tokens > task.policy.maxTokens)
      || (task.policy.maxCostUsd && after.costUsd > task.policy.maxCostUsd)) {
      await this.emit(task, { type: 'budget.exceeded', payload: { stage, ...after, policy: task.policy } });
      throw new Error(`Task budget exceeded during ${stage}.`);
    }
    return completion;
  }

  private async completeStepWithFallback(
    task: WorkflowTask,
    stage: string,
    request: Parameters<ModelClient['complete']>[0],
  ) {
    try {
      return await this.complete(task, stage, request);
    } catch (error) {
      const requestedModel = request.model?.trim();
      const fallbackModel = task.model ?? (await this.modelForTask(task)).model;
      if (!requestedModel || !fallbackModel || requestedModel === fallbackModel || !isUnsupportedModelError(error)) throw error;
      await this.emit(task, {
        type: 'agent.retrying',
        agentId: stage.startsWith('agent:') ? stage.slice('agent:'.length).split(':')[0] : undefined,
        payload: {
          stage,
          failedModel: requestedModel,
          fallbackModel,
          reason: 'unsupported-model',
          error: limitText(error instanceof Error ? error.message : '上游不支持该模型。', 1_000),
        },
      });
      return this.complete(task, stage, { ...request, model: fallbackModel });
    }
  }

  private async plan(task: WorkflowTask, memoryContext: string, signal: AbortSignal, profile: TaskProfile): Promise<WorkflowPlan> {
    const customAgents = await this.customAgentDirectory(task);
    const customRoles = customAgents.map((agent) => agent.roleId).filter((roleId) => /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(roleId));
    const dynamicPlanSchema = buildPlanSchema(customRoles);
    const roleHints = customAgents.length
      ? `\nCustom published roles:\n${customAgents.map((agent) => `- ${agent.roleId}: ${agent.definition.whenToUseHint}`).join('\n')}`
      : '';
    const skillHints = runtimeSkillCatalog.map((skill) => `- ${skill.id}: ${skill.description} 可用于 ${skill.roles.join('、')}`).join('\n');
    const guidance = await this.applyPendingGuidance(task, 'planner', ['planner']);
    const completion = await this.complete(task, 'planner', {
      signal,
      responseFormat: 'json',
      temperature: 0.1,
       system: `You are the planner in a production multi-agent runtime.
Use the triage profile to size the workflow. For a team route, prefer 2-3 measurable steps. For a full-workflow route, use 3-8 steps. Do not add agents when the objective does not need them. Use built-in roles researcher, analyst, builder, reviewer or a custom published role listed below.${roleHints}
Select only the skills needed for each step from this catalog; a skill is an instruction bundle, not an extra Agent:
${skillHints}
Independent steps should have no dependencies so they can run concurrently. Dependent steps must reference earlier step IDs.
Return JSON only: {"summary":"...","routingReason":"...","steps":[{"id":"...","title":"...","role":"researcher|analyst|builder|reviewer","objective":"...","dependsOn":[],"acceptanceCriteria":["..."],"skillIds":["architecture-design"],"model":"one model from the allowed catalog, or omit this field","toolNames":[],"writeScopes":[],"maxTokens":4096,"maxDurationMs":120000,"failureStrategy":"retry|skip|pause"}]}.
Every step must include acceptanceCriteria. Use a smaller token and time budget for narrow steps. Use skip only when downstream work can proceed without the step; use pause when operator input is required.
All human-readable fields must follow the user's language. If the task contains Chinese, write summary, routingReason, step titles, objectives, and acceptanceCriteria in Simplified Chinese. Keep role IDs, step IDs, schema keys, and enum values unchanged.
Do not claim tools or evidence that are not available.`,
       user: `${memoryContext}\n\nTriage profile: ${JSON.stringify(profile)}\n\nAllowed model catalog (step model is optional): ${JSON.stringify([...this.plannerModelCatalog(task)])}\n\nTask mode: ${task.mode}\nTask: ${task.input}${guidance.text ? `\n\nUser guidance received during execution:\n${guidance.text}` : ''}`,
    });
    const parsed = dynamicPlanSchema.parse(extractJson(completion.content));
    const allowedModels = this.plannerModelCatalog(task);
    const covered = ensurePlanCoverage(task, profile, parsed.steps as WorkflowStep[]);
    const known = new Set<string>();
    const steps: WorkflowStep[] = covered.map((step, index) => {
      const { model: plannerModel, ...stepWithoutModel } = step;
      const id = step.id.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 60) || `step-${index + 1}`;
      const uniqueId = known.has(id) ? `${id}-${index + 1}` : id;
      const dependsOn = step.dependsOn.filter((dependency) => known.has(dependency) && dependency !== uniqueId);
      known.add(uniqueId);
      const normalizedModel = normalizePlannerModel(plannerModel, allowedModels);
      const selectedModel = normalizedModel
        ?? (task.model ? task.model : this.modelRouting?.select(allowedModels, { kind: profile.kind, role: step.role }));
      return {
        ...stepWithoutModel,
        id: uniqueId,
        dependsOn,
        skillIds: routeSkillIds(latestUserInput(task.input), step.role, step.skillIds),
        writeScopes: step.writeScopes?.length ? [...new Set(step.writeScopes.map((scope) => scope.trim()).filter(Boolean))] : (step.role === 'builder' ? ['workspace:*'] : []),
        ...(selectedModel ? { model: selectedModel } : {}),
        maxTokens: step.maxTokens ?? (step.role === 'reviewer' ? 8_192 : 6_144),
        maxDurationMs: step.maxDurationMs ?? 120_000,
        failureStrategy: step.failureStrategy ?? 'retry',
      };
    });
    const boundedSteps = steps.slice(0, Math.max(1, profile.maxSteps));
    const dag = analyzeWorkflowDag(boundedSteps);
    if (!dag.valid) throw new Error(dag.issues.map(workflowDagIssueText).join(' '));
    const allowedIds = new Set(boundedSteps.map((step) => step.id));
    return {
      ...parsed,
      steps: boundedSteps.map((step) => ({
        ...step,
        dependsOn: step.dependsOn.filter((dependency) => allowedIds.has(dependency)),
      })),
      profile,
      graph: buildAgentGraph(boundedSteps, [], profile.requiresReview),
    };
  }

  private async executeStep(
    task: WorkflowTask,
    step: WorkflowStep,
    completed: StepResult[],
    humanNotes: string,
    signal: AbortSignal,
  ): Promise<StepResult> {
    const agentId = `${step.role}-${step.id}`;
    // Visual workflows snapshot the effective Agent contract into the plan so
    // resumed runs never depend on a mutable Agent Studio record.
    const customAgent = step.agentContract
      ? undefined
      : (await this.customAgentDirectory(task)).find((agent) => agent.roleId === step.role);
    const customTools = customAgent?.definition.toolAllowlist ?? [];
    const allowedTools = step.agentContract?.toolAllowlist ?? (customAgent ? customTools : (step.toolNames ?? []));
    const canUseTools = step.agentContract ? allowedTools.length > 0 : step.role === 'builder' || customTools.length > 0;
    const roleGuidance = step.agentContract?.systemPromptTemplate ?? customAgent?.definition.systemPromptTemplate;
    const selectedSkillInstructions = skillInstructions(step.skillIds);
    const detailedResearchReport = task.plan?.profile?.kind === 'research'
      && /(?:详细|完整|深度|研究).{0,30}(?:报告|方案)|(?:报告|方案).{0,30}(?:成熟度|成本|落地|依据)|detailed\s+(?:research\s+)?report/i.test(task.input);
    for (const loop of step.loopPath ?? (step.loop ? [step.loop] : [])) {
      if (!loop.entry) continue;
      await this.emit(task, {
        type: 'loop.iteration',
        agentId,
        payload: {
          scope: 'workflow-loop',
          loopId: loop.id,
          iteration: loop.iteration,
          maxIterations: loop.maxIterations,
          entryStepId: step.id,
        },
      });
    }
    await this.emit(task, {
      type: 'agent.spawned',
      agentId,
      payload: {
        role: step.role,
        title: step.title,
        stepId: step.id,
        dependsOn: step.dependsOn,
        skillIds: step.skillIds,
        model: step.model,
        toolNames: allowedTools,
        writeScopes: step.writeScopes ?? (step.role === 'builder' ? ['workspace:*'] : []),
        maxTokens: step.maxTokens,
        maxDurationMs: step.maxDurationMs,
        failureStrategy: step.failureStrategy ?? 'retry',
        agentSource: step.agentContract?.source ?? (customAgent ? 'platform' : 'builtin'),
        agentName: step.agentContract?.displayName ?? customAgent?.name ?? step.title,
        workflowLoop: step.loopPath ?? step.loop,
        conditions: step.conditions,
        capabilities: ['reason', 'review-context'],
      },
    });
    await this.emit(task, {
      type: 'agent.assigned',
      agentId,
      payload: { stepId: step.id, objective: step.objective, dependsOn: step.dependsOn, skillIds: step.skillIds },
    });
    await this.emit(task, {
      type: 'agent.started',
      agentId,
      payload: {
        stepId: step.id,
        role: step.role,
        title: step.title,
        objective: step.objective,
        dependsOn: step.dependsOn,
        skillIds: step.skillIds,
      },
    });
    await this.emit(task, { type: 'memory.recall.started', agentId, payload: { query: limitText(step.objective, 500) } });
    const recall = await this.memory.recall(task, agentId, `${task.input}\n${step.objective}`, signal).catch(() => ({
      context: '', itemCount: 0, available: false, items: [],
      quality: { candidates: 0, expiredFiltered: 0, lowConfidenceFiltered: 0, byLayer: { L1: 0, L2: 0, L3: 0 } },
    }));
    await this.emit(task, {
      type: 'memory.recall.completed',
      agentId,
      payload: { available: recall.available, itemCount: recall.itemCount, quality: recall.quality },
    });

    const dependencyResults = completed.filter((result) => step.dependsOn.includes(result.stepId));
    const dependencyMessages: AgentMessage[] = dependencyResults.map((result) => ({
      id: `${task.id}:${step.id}:handoff:${result.stepId}`,
      fromAgentId: result.agentId,
      toAgentId: agentId,
      kind: result.artifacts?.length ? 'artifact-share' : 'dependency-context',
      content: limitText(result.output, 8_000),
      artifactIds: (result.artifacts ?? []).map((artifact) => artifact.id),
      createdAt: new Date().toISOString(),
    }));
    for (const message of dependencyMessages) {
      await this.emit(task, {
        type: 'agent.message',
        agentId,
        payload: {
          messageId: message.id,
          fromAgentId: message.fromAgentId,
          toAgentId: message.toAgentId,
          kind: message.kind,
          content: message.content,
          artifactIds: message.artifactIds,
        },
      });
    }
    const dependencyContext = dependencyResults
      .map((result) => `### ${result.stepId} (${result.role})\n${limitText(result.output, 8_000)}\nArtifact refs: ${(result.artifacts ?? []).map((artifact) => artifact.id).join(', ') || 'None.'}`)
      .join('\n\n');
    const specialistId = step.agentContract?.agentId;
    if (specialistId && isWorkflowSpecialist(specialistId)) {
      const specialistStartedAt = Date.now();
      const specialistSignal = step.maxDurationMs
        ? AbortSignal.any([signal, AbortSignal.timeout(Math.max(step.maxDurationMs, specialistId === 'video-agent' ? 900_000 : specialistId === 'drawing-agent' ? 600_000 : 120_000))])
        : signal;
      const attemptsAllowed = step.failureStrategy === 'retry' ? this.stepMaxAttempts : 1;
      let specialistResult: Awaited<ReturnType<typeof executeWorkflowSpecialist>> | undefined;
      let lastSpecialistError: unknown;
      let specialistAttempt = 0;
      for (specialistAttempt = 1; specialistAttempt <= attemptsAllowed; specialistAttempt += 1) {
        try {
          specialistResult = await executeWorkflowSpecialist(specialistId, [
            `用户输入：\n${task.input}`,
            `当前 Agent 目标：\n${step.objective}`,
            dependencyContext ? `上游 Agent 输出（优先作为本 Agent 输入）：\n${dependencyContext}` : '',
            humanNotes ? `人工补充：\n${humanNotes}` : '',
          ].filter(Boolean).join('\n\n'), specialistSignal);
          break;
        } catch (caught) {
          lastSpecialistError = caught;
          if (signal.aborted) throw signal.reason ?? caught;
          if (specialistAttempt >= attemptsAllowed) throw caught;
          await this.emit(task, {
            type: 'agent.retrying',
            agentId,
            payload: {
              stepId: step.id,
              role: step.role,
              title: step.title,
              objective: step.objective,
              dependsOn: step.dependsOn,
              skillIds: step.skillIds,
              failedAttempt: specialistAttempt,
              nextAttempt: specialistAttempt + 1,
              error: limitText(caught instanceof Error ? caught.message : '服务 Agent 执行失败。', 1_000),
            },
          });
          await retryDelay(Math.min(2_500, 500 * 2 ** (specialistAttempt - 1)), signal);
        }
      }
      if (!specialistResult) throw lastSpecialistError ?? new Error('服务 Agent 没有返回结果。');
      await this.assertActive(task.id, signal);
      const durationMs = Date.now() - specialistStartedAt;
      await this.emit(task, {
        type: 'model.completed',
        agentId,
        payload: {
          stage: `agent:${step.id}:specialist`,
          model: specialistResult.model,
          attempts: specialistAttempt,
          durationMs,
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          serviceAgent: specialistId,
        },
      });
      const result: StepResult = {
        stepId: step.id,
        agentId,
        role: step.role,
        status: 'completed',
        output: limitText(specialistResult.output, 48_000),
        evidence: specialistResult.evidence.map((item) => limitText(item, 1_000)),
        confidence: specialistResult.confidence,
        attempts: specialistAttempt,
        durationMs,
        tokens: 0,
        messages: dependencyMessages,
      };
      await this.emit(task, {
        type: 'agent.completed',
        agentId,
        payload: {
          stepId: step.id,
          role: step.role,
          title: step.title,
          objective: step.objective,
          dependsOn: step.dependsOn,
          skillIds: step.skillIds,
          output: limitText(result.output, 8_000),
          evidence: result.evidence,
          confidence: result.confidence,
          stepAttempts: result.attempts,
          durationMs,
          messages: result.messages,
          agentSource: 'service',
          serviceAgent: specialistId,
          model: specialistResult.model,
        },
      });
      return result;
    }
    const startedAt = Date.now();
    let completion: Awaited<ReturnType<ModelClient['complete']>> | undefined;
    let stepAttempt = 0;
    let lastError: unknown;
    const stepModelName = step.model ?? task.model ?? (await this.modelForTask(task)).model;
    const requestedStepTimeout = step.maxDurationMs ?? 120_000;
    const stepTimeoutMs = isReasoningModel(stepModelName)
      ? Math.max(requestedStepTimeout, this.reasoningStepTimeoutMs)
      : requestedStepTimeout;
    const stepSignal = AbortSignal.any([signal, AbortSignal.timeout(stepTimeoutMs)]);
    const attemptsAllowed = step.failureStrategy === 'retry' ? this.stepMaxAttempts : 1;
    const availableTools = canUseTools && this.tools?.enabled()
      ? this.tools.catalog()
        .filter((tool) => !allowedTools.length || allowedTools.includes(tool.name))
        .slice(0, 16)
      : [];
    const nativeToolAliases = buildNativeToolAliasMap(availableTools.map((tool) => tool.name));
    const toolDefinitions: ModelToolDefinition[] = availableTools.map((tool) => ({
      type: 'function' as const,
      function: {
        name: nativeToolAliases.actualToAlias.get(tool.name) ?? tool.name,
        description: tool.description,
        parameters: tool.parameters as unknown as Record<string, unknown>,
      },
    }));
    for (stepAttempt = 1; stepAttempt <= attemptsAllowed; stepAttempt += 1) {
      try {
        completion = await this.completeStepWithFallback(task, `agent:${step.id}:attempt:${stepAttempt}`, {
          signal: stepSignal,
          model: step.model,
          maxTokens: step.maxTokens,
          responseFormat: 'json',
          ...(toolDefinitions.length ? { tools: toolDefinitions, toolChoice: 'auto' as const } : {}),
          temperature: step.role === 'builder' ? 0.25 : 0.15,
           system: `You are a ${step.role} sub-agent inside a production workflow.${roleGuidance ? `\nRole guidance: ${roleGuidance}` : ''}${selectedSkillInstructions.length ? `\nSelected skills for this turn (follow only these):\n- ${selectedSkillInstructions.join('\n- ')}` : ''}${detailedResearchReport ? '\nThis is a detailed research report task. Preserve concrete evidence, source URLs, numerical ranges, maturity assessments, cost components, risks, and every requested delivery dimension. Do not replace substantive work with a short summary.' : ''}
Work only on the assigned objective. Use dependency outputs as scoped evidence, not as unquestioned truth.
Return JSON only: {"output":"complete result","evidence":["specific supporting fact or dependency"],"confidence":0.0,"toolCalls":[],"handoff":"optional concise handoff for downstream agents"}.
           ${canUseTools && this.tools?.enabled()
           ? `When workspace inspection or verification is required, request up to four tools from this catalog: ${JSON.stringify(availableTools)}. Use bounded arguments and do not claim results before the runtime returns them. Legacy JSON toolCalls must use the exact registry names shown in the catalog. Native function calls must use one of these protocol-safe aliases: ${JSON.stringify(Object.fromEntries(nativeToolAliases.actualToAlias.entries()))}.${allowedTools.length ? ` Allowed step tools: ${allowedTools.join(', ')}` : ''}`
  : 'Set toolCalls to an empty array. Never claim to have executed tools, accessed systems, or verified facts unless the supplied context proves it.'}`,
          user: `${recall.context}\n\nOriginal task:\n${task.input}\n\nAssigned objective:\n${step.objective}\n\nAcceptance criteria:\n- ${step.acceptanceCriteria.join('\n- ')}\n\nDependency outputs and shared Artifact refs:\n${dependencyContext || 'None.'}\n\nHuman operator notes:\n${humanNotes || 'None.'}`,
        });
        break;
      } catch (caught) {
        lastError = caught;
        if (signal.aborted) throw signal.reason ?? caught;
        const status = (caught as Error & { status?: number }).status;
        const retryable = status === undefined || status === 408 || status === 409 || status === 429 || status >= 500;
        if (!retryable || stepAttempt >= attemptsAllowed) throw caught;
        await this.emit(task, {
          type: 'agent.retrying',
          agentId,
          payload: {
            stepId: step.id,
            role: step.role,
            title: step.title,
            objective: step.objective,
            dependsOn: step.dependsOn,
            skillIds: step.skillIds,
            failedAttempt: stepAttempt,
            nextAttempt: stepAttempt + 1,
            error: limitText(caught instanceof Error ? caught.message : 'Sub-agent attempt failed.', 1_000),
          },
        });
        await retryDelay(Math.min(2_500, 300 * 2 ** (stepAttempt - 1)), signal);
      }
    }
    if (!completion) throw lastError ?? new Error('Sub-agent returned no completion.');
    await this.assertActive(task.id, signal);

    let structured: z.infer<typeof stepOutputSchema>;
    try {
      structured = stepOutputSchema.parse(extractJson(completion.content));
    } catch {
      structured = {
        output: completion.content || (completion.toolCalls?.length ? 'Native tool calls requested.' : 'Model returned no structured output.'),
        evidence: [],
        confidence: 0.5,
        toolCalls: [],
      };
    }
    const normalizeToolName = (name: string) => nativeToolAliases.aliasToActual.get(name) ?? name;
    const structuredToolCalls = structured.toolCalls.map((call) => ({ ...call, name: normalizeToolName(call.name) }));
    const nativeToolCalls = (completion.toolCalls ?? []).map((call) => ({ name: normalizeToolName(call.name), args: call.args }));
    const requestedToolCalls = [...structuredToolCalls, ...nativeToolCalls].slice(0, 4);
    const toolExecutions: ToolExecution[] = [];
    if (canUseTools && requestedToolCalls.length && this.tools?.enabled()) {
      for (const invocation of requestedToolCalls) {
        await this.assertActive(task.id, signal);
        if (allowedTools.length && !allowedTools.includes(invocation.name)) {
          await this.emit(task, {
            type: 'tool.failed',
            agentId,
            payload: { stepId: step.id, name: invocation.name, error: 'Tool is not allowed by the agent contract.', contractToolNames: allowedTools },
          });
          continue;
        }
        await this.emit(task, {
          type: 'tool.started',
          agentId,
          payload: { stepId: step.id, name: invocation.name, args: invocation.args },
        });
        try {
          const execution = await this.tools.execute(task, step.id, invocation);
          toolExecutions.push(execution);
          await this.emit(task, {
            type: execution.exitCode === 0 ? 'tool.completed' : 'tool.failed',
            agentId,
            payload: {
              stepId: step.id,
              name: invocation.name,
              callId: execution.call.id,
              auditId: execution.auditId,
              exitCode: execution.exitCode,
              durationMs: execution.durationMs,
              artifact: execution.artifact,
              artifactError: execution.artifactError,
              stderr: limitText(execution.stderr, 1_000),
            },
          });
          if (execution.artifact) {
            await this.emit(task, {
              type: 'artifact.created',
              agentId,
              payload: { ...execution.artifact, lineage: { taskId: task.id, stepId: step.id, toolCallId: execution.call.id } },
            });
          }
        } catch (error) {
          if (error instanceof ToolApprovalRequiredError) {
            const approval = error.approval;
            const approvals = [...(task.toolApprovals ?? []).filter((item) => item.signature !== approval.signature), approval];
            const waiting = await this.store.updateTask(task.id, { status: 'waiting_for_human', toolApprovals: approvals });
            await this.emit(waiting, {
              type: 'tool.approval_requested',
              agentId,
              payload: {
                approval,
                stepId: step.id,
                name: approval.name,
                risk: approval.risk,
              },
            });
            throw error;
          }
          await this.emit(task, {
            type: 'tool.failed',
            agentId,
            payload: { stepId: step.id, name: invocation.name, error: limitText(error instanceof Error ? error.message : 'Tool execution failed.', 1_000) },
          });
        }
      }
    }
    if (toolExecutions.length) {
      const verifiedToolContext = toolExecutions.map((execution) => [
        `Tool: ${execution.call.name}`,
        `Exit code: ${execution.exitCode}`,
        `Audit ID: ${execution.auditId}`,
        `Output:\n${limitText(execution.output, 12_000)}`,
        execution.stderr ? `Stderr:\n${limitText(execution.stderr, 3_000)}` : '',
      ].filter(Boolean).join('\n')).join('\n\n');
      const finalCompletion = await this.completeStepWithFallback(task, `agent:${step.id}:tool-synthesis`, {
        signal: stepSignal,
        model: step.model,
        maxTokens: step.maxTokens,
        responseFormat: 'json',
        temperature: 0.1,
        system: `You are a builder finalizing a workflow step from real sandbox tool results.
Do not claim a tool succeeded when its exit code is non-zero. Cite audit IDs in evidence.
Return JSON only: {"output":"complete result","evidence":["specific verified fact"],"confidence":0.0,"toolCalls":[]}.`,
        user: `Original objective:\n${step.objective}\n\nAcceptance criteria:\n- ${step.acceptanceCriteria.join('\n- ')}\n\nVerified tool results:\n${verifiedToolContext}`,
      });
      try {
        structured = stepOutputSchema.parse(extractJson(finalCompletion.content));
      } catch {
        structured = { output: finalCompletion.content, evidence: [], confidence: 0.55, toolCalls: [] };
      }
    }
    const artifacts = toolExecutions.flatMap((execution) => execution.artifact ? [execution.artifact] : []);
    const toolCalls = toolExecutions.map((execution) => execution.call);
    const result: StepResult = {
      stepId: step.id,
      agentId,
      role: step.role,
      status: 'completed',
      output: limitText(structured.output, 48_000),
      evidence: structured.evidence.map((item) => limitText(item, 1_000)),
      confidence: structured.confidence,
      attempts: stepAttempt,
      durationMs: Date.now() - startedAt,
      tokens: Number(completion.usage?.total_tokens ?? (completion.usage?.prompt_tokens ?? 0) + (completion.usage?.completion_tokens ?? 0)),
      toolCalls,
      artifacts,
      messages: dependencyMessages,
    };
    await this.emit(task, {
      type: 'agent.completed',
      agentId,
      payload: {
        stepId: step.id,
        role: step.role,
        title: step.title,
        objective: step.objective,
        dependsOn: step.dependsOn,
        skillIds: step.skillIds,
        output: limitText(result.output, 8_000),
        evidence: result.evidence,
        confidence: result.confidence,
        stepAttempts: result.attempts,
        upstreamAttempts: completion.attempts,
        durationMs: result.durationMs,
        toolCalls: result.toolCalls,
        artifacts: result.artifacts,
        messages: result.messages,
        handoff: structured.handoff,
        usage: completion.usage,
      },
    });
    return result;
  }

  private async review(
    task: WorkflowTask,
    results: StepResult[],
    signal: AbortSignal,
  ): Promise<ReviewResult> {
    const reviewerId = 'reviewer-final';
    await this.emit(task, { type: 'review.started', agentId: reviewerId, payload: { resultCount: results.length } });
    const recall = await this.memory.recall(task, reviewerId, `${task.input}\n${results.map((result) => result.output).join('\n')}`, signal).catch(() => ({
      context: '', itemCount: 0, available: false, items: [],
      quality: { candidates: 0, expiredFiltered: 0, lowConfidenceFiltered: 0, byLayer: { L1: 0, L2: 0, L3: 0 } },
    }));
    const guidance = await this.applyPendingGuidance(task, 'reviewer', [reviewerId]);
    const completion = await this.complete(task, 'reviewer', {
      signal,
      responseFormat: 'json',
      temperature: 0.05,
      system: `You are the independent reviewer in a production agent workflow.
Check completeness, internal consistency, unsupported claims, acceptance criteria, and executability.
Score with an integer from 0 to 100. Approve only when the evidence tree is sufficient and score is at least ${this.reviewMinScore}.
Write summary, gaps, and requiredCorrections in the user's language. If the task contains Chinese, all three fields must use Simplified Chinese. Keep JSON keys and boolean/number values unchanged.
Return JSON only: {"approved":true,"score":0,"summary":"...","gaps":[],"requiredCorrections":[]}.`,
      user: `${recall.context}\n\nTask:\n${task.input}\n\nPlan:\n${JSON.stringify(task.plan)}\n\nParallel conflict candidates:\n${JSON.stringify(detectParallelConflicts(results))}\n\nSub-agent evidence tree:\n${results.map((result) => JSON.stringify({
        stepId: result.stepId,
        role: result.role,
        output: limitText(result.output, 10_000),
        evidence: result.evidence,
        confidence: result.confidence,
      })).join('\n')}${guidance.text ? `\n\nUser guidance received during execution:\n${guidance.text}` : ''}`,
    });
    let review: ReviewResult;
    try {
      const parsedReview = reviewSchema.parse(extractJson(completion.content));
      const scoreMeetsGate = parsedReview.score >= this.reviewMinScore;
      review = {
        ...parsedReview,
        approved: parsedReview.approved && scoreMeetsGate,
        requiredCorrections: parsedReview.approved && !scoreMeetsGate
          ? [
              ...parsedReview.requiredCorrections,
              `将有证据支持的质量评分从 ${parsedReview.score} 提升到至少 ${this.reviewMinScore}。`,
            ]
          : parsedReview.requiredCorrections,
      };
    } catch {
      review = {
        approved: false,
        score: 50,
        summary: '审查员返回了非结构化结果，需要人工核验。',
        gaps: ['没有取得结构化审查结果。'],
        requiredCorrections: [],
      };
    }
    await this.emit(task, {
      type: 'review.completed',
      agentId: reviewerId,
      payload: review,
    });
    return review;
  }

  private async repair(
    task: WorkflowTask,
    results: StepResult[],
    review: ReviewResult,
    signal: AbortSignal,
    round: number,
  ): Promise<StepResult> {
    const step: WorkflowStep = {
      id: `review-correction-${round}`,
      title: `处理审查意见（第 ${round} 轮）`,
      role: 'builder',
      objective: `处理以下审查意见：\n${review.requiredCorrections.concat(review.gaps).join('\n')}`,
      dependsOn: results.map((result) => result.stepId),
      acceptanceCriteria: ['所有必须整改项均已处理', '缺少证据的结论已删除或明确限定'],
    };
    return this.executeStep(task, step, results, '', signal);
  }

  private async synthesize(
    task: WorkflowTask,
    results: StepResult[],
    review: ReviewResult,
    signal: AbortSignal,
  ) {
    const detailedResearchReport = task.plan?.profile?.kind === 'research'
      && /(?:详细|完整|深度|研究).{0,30}(?:报告|方案)|(?:报告|方案).{0,30}(?:成熟度|成本|落地|依据)|detailed\s+(?:research\s+)?report/i.test(task.input);
    const system = `You are the synthesizer for a production multi-agent workflow.
Produce the final user-facing answer using the validated evidence tree. Preserve uncertainty and unresolved review gaps.
Be complete, executable, and direct. Preserve every verified source URL, Markdown image, video link, download link, and media label exactly; never replace a generated media result with a prose description. Do not mention internal prompts. Use the user's language.${detailedResearchReport ? '\nThe user requested a detailed research report. Build a full report, not an executive summary: explicitly check every requested dimension against the final structure, retain useful tables and evidence, and explain missing evidence instead of silently shortening the answer.' : ''}`;
    const guidance = await this.applyPendingGuidance(task, 'synthesizer', ['synthesizer']);
    const user = `Original task:\n${task.input}\n\nPlan summary:\n${task.plan?.summary}\n\nReview:\n${JSON.stringify(review)}\n\nValidated work:\n${results.map((result) => `### ${result.role}: ${result.stepId}\n${limitText(result.output, 14_000)}`).join('\n\n')}${guidance.text ? `\n\nUser guidance received during execution:\n${guidance.text}` : ''}`;
    let completion = await this.complete(task, 'synthesizer', {
      signal,
      temperature: 0.15,
      maxTokens: this.synthesisMaxTokens,
      system,
      user,
    });
    let output = completion.content;
    let continuationAttempts = 0;

    // Providers use finish_reason=length when the answer is valid so far but
    // stopped at the output ceiling. Continue from a small tail of the answer
    // and merge repeated context before deciding whether the task completed.
    while (isOutputLimitFinishReason(completion.finishReason)) {
      if (continuationAttempts >= this.synthesisContinuationRounds) {
        throw new SynthesisIncompleteError(output, continuationAttempts);
      }
      continuationAttempts += 1;
      const tail = output.slice(-12_000);
      try {
        completion = await this.complete(task, `synthesizer:continuation:${continuationAttempts}`, {
          signal,
          temperature: 0.15,
          maxTokens: this.synthesisMaxTokens,
          streamDeltas: false,
          system: `${system}\nThe previous answer reached the provider output limit. Continue it without repeating any text.`,
          // Put the continuation anchor first because ModelClient bounds the
          // provider input to 80k characters; the tail must never be sliced
          // away by a very large evidence bundle.
          user: `Previous answer tail (the last characters may end mid-sentence):\n${tail}\n\nContinue exactly from that point. Output only the missing continuation; do not add a preface, summary, or duplicate headings.\n\nOriginal task context:\n${user}`,
        });
      } catch (error) {
        if (signal.aborted) throw signal.reason ?? error;
        throw new SynthesisIncompleteError(output, continuationAttempts, error);
      }
      const previousOutput = output;
      const merged = mergeContinuation(previousOutput, completion.content);
      if (merged === output) throw new SynthesisIncompleteError(output, continuationAttempts);
      const appended = merged.slice(previousOutput.length);
      if (appended) {
        await this.emit(task, {
          type: 'model.delta',
          agentId: 'synthesizer',
          payload: { stage: `synthesizer:continuation:${continuationAttempts}`, content: appended },
        });
      }
      output = merged;
    }

    if (output.length > 64_000) throw new SynthesisIncompleteError(output, continuationAttempts);
    return output;
  }

  private async captureMemory(task: WorkflowTask, result: string, signal: AbortSignal) {
    await this.emit(task, {
      type: 'memory.capture.started',
      agentId: 'orchestrator',
      payload: { sessionId: task.sessionId },
    }).catch((error) => this.logger.warn({ taskId: task.id, error }, 'memory capture start event failed'));
    try {
      const capture = await this.memory.capture(task, task.input, result, signal);
      await this.emit(task, {
        type: capture.skipped ? 'memory.capture.skipped' : 'memory.capture.completed',
        agentId: 'orchestrator',
        payload: {
          capturedCount: capture.capturedCount,
          cursor: capture.cursor,
          contentDigest: capture.contentDigest,
          ...(capture.reason ? { reason: capture.reason } : {}),
          ...(capture.serverTotalCount !== undefined ? { serverTotalCount: capture.serverTotalCount } : {}),
        },
      }).catch((error) => this.logger.warn({ taskId: task.id, error }, 'memory capture result event failed'));
    } catch (error) {
      this.logger.warn({ taskId: task.id, error }, 'memory capture failed');
      await this.emit(task, {
        type: 'memory.capture.failed',
        agentId: 'orchestrator',
        payload: { error: limitText(error instanceof Error ? error.message : 'MemoryCore capture failed.', 1_000), recoverable: true },
      }).catch((eventError) => this.logger.warn({ taskId: task.id, error: eventError }, 'memory capture failure event failed'));
    }
  }

  private async runSingleAgent(task: WorkflowTask, signal: AbortSignal, recovered: boolean, profile: TaskProfile) {
    const prompt = latestUserInput(task.input);
    const role = profile.kind === 'research' ? 'researcher'
      : profile.kind === 'decision' || profile.kind === 'question' ? 'analyst'
        : 'builder';
    const agentId = `solo-${role}`;
    const skillIds = routeSkillIds(prompt, role);
    task = await this.store.updateTask(task.id, { status: 'planning', error: '', plan: routingPlan(task, profile) });
    await this.emit(task, {
      type: 'task.started',
      payload: { model: task.model ?? this.model.model, recovered, profile },
    });
    await this.emit(task, {
      type: 'task.planning',
      agentId: 'planner',
      payload: { mode: task.mode, profile, route: profile.route },
    });
    await this.emit(task, {
      type: 'task.planned',
      agentId: 'planner',
      payload: { profile, route: profile.route, reason: '任务分类选择了单智能体专注执行。' },
    });
    task = await this.store.updateTask(task.id, { status: 'running' });
    await this.emit(task, {
      type: 'agent.spawned',
      agentId,
      payload: { role, title: '专注执行 Agent', stepId: 'single-agent', dependsOn: [], capabilities: ['reason', 'execute', 'answer'], skillIds },
    });
    await this.emit(task, {
      type: 'agent.assigned',
      agentId,
      payload: { stepId: 'single-agent', objective: prompt, dependsOn: [], skillIds },
    });
    await this.emit(task, {
      type: 'agent.started',
      agentId,
      payload: { stepId: 'single-agent', role, title: '专注执行 Agent', objective: prompt, dependsOn: [], skillIds },
    });
    const startedAt = Date.now();
    const guidance = await this.applyPendingGuidance(task, `single-agent:${role}`, [agentId]);
    const completion = await this.complete(task, `single-agent:${role}`, {
      signal,
      temperature: profile.kind === 'creative' ? 0.55 : 0.2,
      system: `You are the focused ${role} agent in a flexible production runtime. Solve only the user's request. Do not invent tool execution or evidence. Return a complete, direct answer in the user's language.`,
      user: `${prompt}${guidance.text ? `\n\nUser guidance received during execution:\n${guidance.text}` : ''}`,
    });
    await this.assertActive(task.id, signal);
    const stepResult: StepResult = {
      stepId: 'single-agent',
      agentId,
      role,
      status: 'completed',
      output: limitText(completion.content, 48_000),
      evidence: [],
      confidence: 0.8,
      attempts: Math.max(1, completion.attempts),
      durationMs: Date.now() - startedAt,
    };
    await this.emit(task, {
      type: 'agent.completed',
      agentId,
      payload: {
        stepId: 'single-agent',
        role,
        title: '专注执行 Agent',
        objective: prompt,
        dependsOn: [],
        output: limitText(completion.content, 8_000),
        confidence: 0.8,
        stepAttempts: 1,
        upstreamAttempts: completion.attempts,
        durationMs: Date.now() - startedAt,
        skillIds,
      },
    });
    const review: ReviewResult = {
      approved: true,
      score: 100,
      summary: '任务分类选择了单智能体路由，无需执行证据树审查。',
      gaps: [],
      requiredCorrections: [],
    };
    const finalContent = limitText(completion.content, 64_000);
    const resultStorage = await this.persistResultArtifact(task, finalContent);
    task = await this.store.updateTask(task.id, {
      status: 'completed',
      review,
      result: finalContent,
      stepResults: [stepResult],
      plan: routingPlan(task, profile),
    });
    await this.emit(task, {
      type: 'review.completed',
      agentId: 'reviewer-final',
      payload: { ...review, skipped: true, profile },
    });
    await this.emit(task, {
      type: 'artifact.created',
      payload: { artifactId: `result:${task.id}`, kind: 'markdown', size: task.result?.length ?? 0, storage: resultStorage },
    });
    await this.captureMemory(task, task.result ?? '', signal);
    await this.emit(task, {
      type: 'task.completed',
      payload: {
        result: task.result,
        review,
        agentCount: 1,
        profile,
        evidenceSummary: summarizeCompletionEvidence(undefined, [stepResult], review, false),
      },
    });
    return task;
  }

  private async runConversational(task: WorkflowTask, signal: AbortSignal, recovered: boolean, profile: TaskProfile) {
    const prompt = latestUserInput(task.input);
    const agentId = `direct-responder-${task.id.slice(0, 8)}`;
    const stepId = 'direct-response';
    const skillIds = routeSkillIds(prompt, 'direct-responder');
    const startedAt = Date.now();
    task = await this.store.updateTask(task.id, { status: 'planning', error: '', plan: routingPlan(task, profile) });
    await this.emit(task, {
      type: 'task.started',
      payload: { model: task.model ?? this.model.model, recovered, intent: 'conversation', profile },
    });
    task = await this.store.updateTask(task.id, { status: 'running' });
    await this.emit(task, {
      type: 'agent.spawned',
      agentId,
      payload: { role: 'direct-responder', title: '直连响应器', stepId, capabilities: ['reason', 'answer'], skillIds },
    });
    await this.emit(task, {
      type: 'agent.assigned',
      agentId,
      payload: { stepId, objective: prompt, dependsOn: [], skillIds },
    });
    await this.emit(task, {
      type: 'agent.started',
      agentId,
      payload: { role: 'direct-responder', title: '直连响应器', stepId, objective: prompt, dependsOn: [], skillIds },
    });
    const customAgents = isAgentCatalogQuestion(prompt) ? await this.customAgentDirectory(task) : [];
    const registryContext = isAgentCatalogQuestion(prompt)
      ? `\nThe user is asking about available Agents. Answer intelligently from this live directory snapshot; compute counts from the data, distinguish built-in roles from published custom Agents, and do not use a canned response or expose raw JSON field names. Use 2-4 concise sentences for a yes/no capability question, or a compact table/short grouped list for a catalog question. Omit roles unrelated to the exact question.\n${JSON.stringify({ detectedAt: new Date().toISOString(), builtIn: agentCatalog, publishedCustom: customAgents.map((agent) => ({ roleId: agent.roleId, name: agent.name, kind: agent.kind, status: agent.status, description: agent.description, toolAllowlist: agent.definition.toolAllowlist })) })}`
      : '';
    const guidance = await this.applyPendingGuidance(task, 'direct-response', [agentId]);
    const completion = await this.complete(task, 'direct-response', {
      signal,
      temperature: 0.3,
      system: `You are Axiom, a concise and warm conversational agent for direct responses. Answer the user naturally in their language. Do not invent a task, analysis, evidence tree, runtime capability, or tool execution. If required runtime evidence is unavailable, say so instead of returning a fixed fallback.${registryContext}`,
      user: `${prompt}${guidance.text ? `\n\nUser guidance received during execution:\n${guidance.text}` : ''}`,
    });
    const response = isAgentCatalogQuestion(prompt)
      ? appendMissingAgentDirectory(completion.content, [
        ...agentCatalog,
        ...customAgents.map((agent) => ({ id: agent.id, roleId: agent.roleId, name: agent.name })),
      ])
      : completion.content;
    if (response.length > completion.content.length) {
      await this.emit(task, {
        type: 'model.delta',
        agentId,
        payload: { stage: 'direct-response', content: response.slice(completion.content.length) },
      });
    }
    await this.assertActive(task.id, signal);
    const durationMs = Date.now() - startedAt;
    const result: StepResult = {
      stepId,
      agentId,
      role: 'direct-responder',
      status: 'completed',
      output: limitText(response, 48_000),
      evidence: [],
      confidence: 0.8,
      attempts: 1,
      durationMs,
    };
    const finalContent = limitText(response, 64_000);
    await this.persistResultArtifact(task, finalContent);
    task = await this.store.updateTask(task.id, {
      status: 'completed',
      result: finalContent,
      stepResults: [result],
    });
    await this.emit(task, {
      type: 'agent.completed',
      agentId,
      payload: {
        stepId,
        role: 'direct-responder',
        title: '直连响应器',
        objective: prompt,
        dependsOn: [],
        output: limitText(response, 8_000),
        evidence: [],
        confidence: result.confidence,
        stepAttempts: 1,
        durationMs,
        skillIds,
      },
    });
    await this.captureMemory(task, task.result ?? '', signal);
    await this.emit(task, {
      type: 'task.completed',
      payload: {
        result: task.result,
        agentCount: 1,
        intent: profile.kind,
        route: 'direct',
        profile,
        evidenceTree: false,
        evidenceSummary: summarizeCompletionEvidence(undefined, [result], undefined, false),
      },
    });
    return task;
  }

  async run(initialTask: WorkflowTask, signal: AbortSignal) {
    let task = initialTask;
    const recovered = initialTask.status !== 'queued';
    try {
      await this.assertActive(task.id, signal);
      const priorControlEvents = await this.store.getEvents(task.id);
      const profile = task.plan?.profile ?? classifyTask(task.input, task.mode);
      const routingDecision = task.plan?.routingDecision;
      const schedulingDecision = task.plan?.schedulingDecision;
      if (routingDecision && schedulingDecision && !priorControlEvents.some((event) => event.type === 'routing.decided')) {
        await this.emit(task, {
          type: 'routing.started',
          agentId: 'router-agent',
          payload: { routingVersion: task.plan?.routingVersion, routerModel: task.plan?.routerModel },
        });
        await this.emit(task, {
          type: 'routing.decided',
          agentId: 'router-agent',
          payload: { ...routingDecision, profile, routingVersion: task.plan?.routingVersion, routerModel: task.plan?.routerModel },
        });
        await this.emit(task, {
          type: 'scheduling.started',
          agentId: 'scheduler-agent',
          payload: { candidateAgentIds: routingDecision.candidateAgentIds, currentRoute: profile.route },
        });
        await this.emit(task, {
          type: 'scheduling.decided',
          agentId: 'scheduler-agent',
          payload: { ...schedulingDecision, profile, graph: task.plan?.graph },
        });
        for (const agentId of schedulingDecision.skippedAgentIds) {
          await this.emit(task, { type: 'agent.skipped', agentId, payload: { reason: '本轮语义目标不需要该 Agent。', scope: 'turn' } });
        }
        if (schedulingDecision.appendAgentIds.length) {
          await this.emit(task, {
            type: 'graph.extended',
            agentId: 'scheduler-agent',
            payload: { agentIds: schedulingDecision.appendAgentIds, graph: task.plan?.graph, reason: '本轮需要新的 Agent 能力。' },
          });
        }
      }
      if (profile.route === 'direct') {
        return await this.runConversational(task, signal, recovered, profile);
      }
      if (profile.route === 'single-agent' && !schedulingDecision) {
        return await this.runSingleAgent(task, signal, recovered, profile);
      }
      task = await this.store.updateTask(task.id, { status: 'planning', error: '' });
      await this.emit(task, { type: 'task.started', payload: { model: task.model ?? this.model.model, recovered, profile } });
      await this.emit(task, { type: 'task.planning', agentId: schedulingDecision ? 'scheduler-agent' : 'planner', payload: { mode: task.mode, profile, source: schedulingDecision ? 'scheduler-agent' : 'planner' } });

      let plan = task.plan;
      if (!plan) {
        const recall = await this.memory.recall(task, 'planner', task.input, signal).catch(() => ({
          context: '', itemCount: 0, available: false, items: [],
          quality: { candidates: 0, expiredFiltered: 0, lowConfidenceFiltered: 0, byLayer: { L1: 0, L2: 0, L3: 0 } },
        }));
        try {
          plan = await this.plan(task, recall.context, signal, profile);
        } catch (error) {
          this.logger.warn({ taskId: task.id, error }, 'planner returned invalid output; using fallback plan');
          plan = { ...fallbackPlan(task), profile };
        }
        await this.assertActive(task.id, signal);
        const version = Math.max(1, task.planVersion ?? 0);
        const approvalStatus = task.policy.requirePlanApproval ? 'pending' as const : 'approved' as const;
        plan = {
          ...plan,
          profile,
           graph: plan.graph ?? buildAgentGraph(plan.steps, [], profile.requiresReview, 'queued', 1),
          version,
          approvalStatus,
          ...(!task.policy.requirePlanApproval ? { approvedAt: new Date().toISOString(), approvedBy: 'runtime-policy' } : {}),
        };
        task = await this.store.updateTask(task.id, { plan, planVersion: version });
        await this.emit(task, { type: 'task.planned', agentId: 'planner', payload: { plan, profile, graph: plan.graph } });
        await this.emit(task, { type: 'graph.updated', agentId: 'planner', payload: { graph: plan.graph, reason: 'plan-created' } });
        if (task.policy.requirePlanApproval) {
          task = await this.store.updateTask(task.id, { status: 'awaiting_approval' });
          await this.emit(task, {
            type: 'plan.approval_requested',
            agentId: 'planner',
            payload: { plan, version, graph: plan.graph },
          });
          return task;
        }
      }

      if (plan && !priorControlEvents.some((event) => event.type === 'task.planned')) {
        await this.emit(task, { type: 'task.planned', agentId: 'scheduler-agent', payload: { plan, profile, graph: plan.graph, source: schedulingDecision ? 'scheduler-agent' : 'precomputed-plan' } });
        if (plan.graph) await this.emit(task, { type: 'graph.updated', agentId: 'scheduler-agent', payload: { graph: plan.graph, reason: 'scheduler-plan-created' } });
      }

       const dag = analyzeWorkflowDag(plan.steps);
       if (!dag.valid) throw new Error(dag.issues.map(workflowDagIssueText).join(' '));
       let graphRevision = Math.max(1, plan.graph?.revision ?? 1);
       const nextGraph = (resultsForGraph: StepResult[], status: AgentGraphNode['status'] = 'queued') => {
         graphRevision += 1;
         return buildAgentGraph(plan!.steps, resultsForGraph, profile.requiresReview, status, graphRevision);
       };
       if (plan.graph && plan.graph.revision !== graphRevision) {
         plan = { ...plan, graph: { ...plan.graph, revision: graphRevision } };
         task = await this.store.updateTask(task.id, { plan });
       }

      if (plan.approvalStatus === 'pending' || plan.approvalStatus === 'rejected') {
        task = await this.store.updateTask(task.id, { status: 'awaiting_approval' });
        if (plan.approvalStatus === 'pending' && !priorControlEvents.some((event) => event.type === 'plan.approval_requested')) {
          await this.emit(task, {
            type: 'plan.approval_requested',
            agentId: 'scheduler-agent',
            payload: { plan, version: plan.version ?? task.planVersion ?? 1, graph: plan.graph },
          });
        }
        return task;
      }

      task = await this.store.updateTask(task.id, { status: 'running' });
      let results = [...task.stepResults];
      const workflowFailures: Array<{ stepId: string; title: string; error: unknown }> = [];
      const pending = new Map(plan.steps
        .filter((step) => !results.some((result) => result.stepId === step.id && (result.status === 'completed' || result.skipped)))
        .map((step) => [step.id, step]));
      const runtimeTaskModel = await this.modelForTask(task);
      const taskModelName = task.model ?? runtimeTaskModel.model;
      const waveConcurrency = isReasoningModel(taskModelName)
        ? this.reasoningStepConcurrency
        : this.stepConcurrency;

      const graph = plan.graph ?? buildAgentGraph(plan.steps, results, profile.requiresReview);
      const priorIterations = priorControlEvents.filter((event) => event.type === 'loop.iteration' && event.payload.scope !== 'workflow-loop').length;
      await this.emit(task, {
        type: 'loop.started',
        payload: {
          loopId: task.runId,
          route: profile.route,
          maxIterations: plan.steps.length + this.reviewCorrectionRounds + 1,
          startIteration: priorIterations,
          resumed: recovered || priorIterations > 0,
          graph,
        },
      });
      let loopIteration = priorIterations;
      while (pending.size > 0) {
        await this.assertActive(task.id, signal);
        loopIteration += 1;
        // A failed step is also a durable checkpoint. Downstream Agents receive
        // its diagnostic output and can continue with a bounded partial result
        // instead of becoming stuck on an unresolved dependency join.
        const completedIds = new Set(results
          .filter((result) => result.status === 'completed' || result.status === 'failed' || result.skipped)
          .map((result) => result.stepId));
        const readyCandidates = [...pending.values()]
          .filter((step) => step.dependsOn.every((dependency) => completedIds.has(dependency)))
          .slice(0, Math.min(waveConcurrency, task.policy.maxConcurrentSteps ?? waveConcurrency));
        if (!readyCandidates.length) throw new Error('Workflow plan contains an unresolved dependency cycle.');

        // Condition edges are evaluated only after all source Agents have a
        // durable result. A skipped branch becomes a completed checkpoint so
        // joins can proceed without executing the unselected Agent.
        const resultsByStepId = new Map(results.map((result) => [result.stepId, result]));
        const executableCandidates: WorkflowStep[] = [];
        for (const step of readyCandidates) {
          const decision = evaluateWorkflowConditions(step.conditions, resultsByStepId);
          if (!decision.ready) continue;
          if (!step.conditions?.length || decision.selected) {
            if (step.conditions?.length) {
              for (const condition of step.conditions) {
                await this.emit(task, {
                  type: 'branch.selected',
                  agentId: `${step.role}-${step.id}`,
                  payload: { stepId: step.id, sourceStepId: condition.sourceStepId, expression: condition.expression, branch: condition.branch },
                });
              }
            }
            executableCandidates.push(step);
            continue;
          }
          pending.delete(step.id);
          const skipped: StepResult = {
            stepId: step.id,
            agentId: `${step.role}-${step.id}`,
            role: step.role,
            status: 'completed',
            output: '条件分支未命中，已跳过此 Agent。',
            evidence: [],
            confidence: 1,
            attempts: 0,
            durationMs: 0,
            tokens: 0,
            skipped: true,
          };
          results.push(skipped);
          await this.emit(task, {
            type: 'branch.skipped',
            agentId: skipped.agentId,
            payload: {
              stepId: step.id,
              conditions: step.conditions,
              reason: 'condition-not-matched',
            },
          });
        }
        if (readyCandidates.length > 0 && executableCandidates.length === 0) {
          // All candidates were skipped; persist the checkpoint before the
          // next scheduling pass so the state survives a process restart.
          task = await this.store.updateTask(task.id, { stepResults: results });
          await this.emit(task, {
            type: 'checkpoint.saved',
            payload: { completedSteps: results.filter((result) => result.status === 'completed' || result.skipped).length, totalSteps: plan.steps.length },
          });
          continue;
        }

        let ready = selectNonConflictingSteps(
          executableCandidates,
          Math.min(waveConcurrency, task.policy.maxConcurrentSteps ?? waveConcurrency),
        );
        if (ready.length < executableCandidates.length) {
          await this.emit(task, {
            type: 'queue.updated',
            payload: {
              iteration: loopIteration,
              selectedSteps: ready.map((step) => step.id),
              deferredSteps: executableCandidates.filter((step) => !ready.some((selected) => selected.id === step.id)).map((step) => step.id),
              reason: '检测到 Agent 写入范围重叠，已拆分为后续波次。',
            },
          });
        }
        if (task.policy.maxTokens) {
          const usage = await this.budgetUsage(task.id);
          const reserveTokens = profile.requiresReview
            ? Math.min(12_000, Math.max(2_048, Math.floor(task.policy.maxTokens * 0.18)))
            : Math.min(6_000, Math.max(1_024, Math.floor(task.policy.maxTokens * 0.1)));
          const estimatedBatchTokens = ready.reduce((sum, step) => sum + (step.maxTokens ?? 6_144), 0);
          const availableForBatch = task.policy.maxTokens - usage.tokens - reserveTokens;
          if (estimatedBatchTokens > availableForBatch) {
            const perStepBudget = Math.max(512, Math.floor(Math.max(0, availableForBatch) / Math.max(1, ready.length)));
            ready = ready.map((step) => ({
              ...step,
              maxTokens: Math.max(128, Math.min(step.maxTokens ?? 6_144, perStepBudget)),
            }));
            await this.emit(task, {
              type: 'budget.constrained',
              payload: {
                iteration: loopIteration,
                usedTokens: usage.tokens,
                maxTokens: task.policy.maxTokens,
                reserveTokens,
                estimatedBatchTokens,
                availableForBatch,
                steps: ready.map((step) => ({ stepId: step.id, originalMaxTokens: readyCandidates.find((candidate) => candidate.id === step.id)?.maxTokens ?? 6_144, maxTokens: step.maxTokens })),
                reason: '并行批次预计会挤占 Reviewer/Synthesizer 预算，已按剩余预算压缩步骤。',
              },
            });
          }
        }

        const legacyNotes = await this.humanNotes(task.id);
        const guidance = await this.applyPendingGuidance(task, `loop:${loopIteration}`, ready.map((step) => `${step.role}-${step.id}`));
        const notes = [legacyNotes, guidance.text].filter(Boolean).join('\n');
        await this.emit(task, {
          type: 'loop.iteration',
          payload: {
            iteration: loopIteration,
            readySteps: ready.map((step) => step.id),
            completedSteps: results.filter((result) => result.status === 'completed').map((result) => result.stepId),
            humanNotes: notes ? notes.split('\n').length : 0,
            guidanceIds: guidance.guidanceIds,
          },
        });
        const batch = await Promise.allSettled(ready.map((step) => this.executeStep(task, step, results, notes, signal)));
        const completedBatchResults: StepResult[] = [];
        let approvalPause: ToolApprovalRequiredError | undefined;
        let humanPause = false;
        for (let index = 0; index < batch.length; index += 1) {
          const outcome = batch[index]!;
          const step = ready[index]!;
          if (outcome.status === 'rejected' && outcome.reason instanceof ToolApprovalRequiredError) {
            // Keep the blocked step pending. Completed siblings can still be checkpointed,
            // while the outer run exits through the durable waiting_for_human state.
            approvalPause = outcome.reason;
            continue;
          }
          if (outcome.status === 'rejected' && step.failureStrategy === 'pause') {
            humanPause = true;
            await this.emit(task, {
              type: 'task.paused',
              payload: { stepId: step.id, reason: limitText(outcome.reason instanceof Error ? outcome.reason.message : 'Step requires operator intervention.', 2_000), failureStrategy: 'pause' },
            });
            continue;
          }
          pending.delete(step.id);
          if (outcome.status === 'fulfilled') {
            results.push(outcome.value);
            completedBatchResults.push(outcome.value);
          } else {
            const failed: StepResult = {
              stepId: step.id,
              agentId: `${step.role}-${step.id}`,
              role: step.role,
              status: 'failed',
              output: outcome.reason instanceof Error ? outcome.reason.message : 'Sub-agent failed.',
              evidence: [],
              confidence: 0,
              attempts: this.stepMaxAttempts,
              durationMs: 0,
              tokens: 0,
              skipped: step.failureStrategy === 'skip',
            };
            results.push(failed);
            if (!failed.skipped) workflowFailures.push({ stepId: step.id, title: step.title, error: outcome.reason });
            await this.emit(task, {
              type: 'agent.failed',
              agentId: failed.agentId,
              payload: {
                stepId: step.id,
                role: step.role,
                title: step.title,
                objective: step.objective,
                dependsOn: step.dependsOn,
                skillIds: step.skillIds,
                model: step.model,
                error: limitText(failed.output, 2_000),
                diagnosis: failureLabel(outcome.reason),
                skipped: failed.skipped === true,
                failureStrategy: step.failureStrategy ?? 'retry',
              },
            });
          }
        }
        for (const conflict of detectParallelConflicts(completedBatchResults)) {
          await this.emit(task, {
            type: 'agent.conflict',
            payload: {
              ...conflict,
              iteration: loopIteration,
              resolution: 'reviewer-validation-required',
            },
          });
        }
        const checkpointGraph = nextGraph(results);
        task = await this.store.updateTask(task.id, { stepResults: results, plan: { ...plan, graph: checkpointGraph } });
        await this.emit(task, {
          type: 'checkpoint.saved',
          payload: {
            completedSteps: results.filter((result) => result.status === 'completed').length,
            failedSteps: results.filter((result) => result.status === 'failed' && !result.skipped).length,
            totalSteps: plan.steps.length,
          },
        });
        await this.emit(task, {
          type: 'graph.updated',
          payload: {
            graph: checkpointGraph,
            reason: 'checkpoint',
            iteration: loopIteration,
          },
        });
        if (approvalPause) throw approvalPause;
        if (humanPause) {
          task = await this.store.updateTask(task.id, { status: 'waiting_for_human', stepResults: results, error: '步骤失败策略要求人工处理。' });
          throw new Error('Workflow paused for operator intervention.');
        }
      }

      await this.assertActive(task.id, signal);
      const completedResults = results.filter((result) => result.status === 'completed' && !result.skipped);
      if (workflowFailures.length > 0 && completedResults.length === 0) {
        throw new Error(failureSummary(workflowFailures));
      }
      let review: ReviewResult;
      if (profile.requiresReview && task.review?.approved) {
        // A human-approved review is durable. Resuming the task must not call
        // the reviewer again and potentially invalidate that decision.
        review = task.review;
      } else if (profile.requiresReview) {
        task = await this.store.updateTask(task.id, { status: 'reviewing' });
        review = await this.review(task, results, signal);
        for (let round = 1; !review.approved && round <= this.reviewCorrectionRounds; round += 1) {
          if (review.requiredCorrections.length === 0 && review.gaps.length === 0) break;
          const correction = await this.repair(task, results, review, signal, round);
          results = [...results, correction];
          loopIteration += 1;
          await this.emit(task, {
            type: 'loop.iteration',
            payload: { iteration: loopIteration, phase: 'review-correction', round, readySteps: [correction.stepId] },
          });
          task = await this.store.updateTask(task.id, { stepResults: results });
          review = await this.review(task, results, signal);
        }
      } else {
        review = {
          approved: true,
          score: 100,
          summary: '任务分类选择了小组协作，无需进入完整证据质量门禁。',
          gaps: [],
          requiredCorrections: [],
        };
        await this.emit(task, {
          type: 'review.completed',
          agentId: 'reviewer-final',
          payload: { ...review, skipped: true, profile },
        });
      }
      task = await this.store.updateTask(task.id, { review });
      if (!review.approved && this.requireReviewApproval) {
        task = await this.store.updateTask(task.id, { status: 'waiting_for_human', review });
        await this.emit(task, {
          type: 'review.approval_requested',
          agentId: 'reviewer-final',
          payload: { ...review, profile, iteration: loopIteration },
        });
        return task;
      }

      const result = await this.synthesize(task, results, review, signal);
      await this.assertActive(task.id, signal);
      const resultStorage = await this.persistResultArtifact(task, result);
       const finalGraph = nextGraph(results, 'completed');
      task = await this.store.updateTask(task.id, {
        status: 'completed',
        result,
        error: workflowFailures.length ? failureSummary(workflowFailures) : null,
        review,
        stepResults: results,
        plan: { ...plan, graph: finalGraph },
      });
      await this.emit(task, {
        type: 'loop.completed',
        payload: { iterations: loopIteration, reviewScore: review.score, approved: review.approved },
      });
      await this.emit(task, {
        type: 'artifact.created',
        payload: { artifactId: `result:${task.id}`, kind: 'markdown', size: result.length, storage: resultStorage },
      });
      await this.captureMemory(task, result, signal);
      await this.emit(task, {
        type: 'task.completed',
        payload: {
          result,
          review,
          agentCount: new Set(results.map((item) => item.agentId)).size,
          profile,
          graph: finalGraph,
          evidenceSummary: summarizeCompletionEvidence(plan, results, review, profile.requiresReview),
          partial: workflowFailures.length > 0,
          ...(workflowFailures.length ? {
            failures: workflowFailures.map((failure) => ({ stepId: failure.stepId, title: failure.title, diagnosis: failureLabel(failure.error) })),
          } : {}),
        },
      });
      return task;
    } catch (caught) {
      const current = await this.store.getTask(task.id);
      if (current?.cancelRequested) {
        task = await this.store.updateTask(task.id, { status: 'cancelled', cancelRequested: true });
        await this.emit(task, { type: 'task.cancelled', payload: { reason: 'Cancellation requested.' } });
        return task;
      }
      if (current?.status === 'paused') {
        this.logger.info({ taskId: task.id }, 'workflow paused at a recoverable checkpoint');
        return current;
      }
      if (current?.status === 'waiting_for_human') {
        this.logger.info({ taskId: task.id }, 'workflow is waiting for a durable human decision');
        return current;
      }
      if (signal.aborted && signal.reason instanceof DOMException && signal.reason.name !== 'TimeoutError') {
        this.logger.warn({ taskId: task.id, reason: signal.reason.message }, 'workflow interrupted and left recoverable');
        return current ?? task;
      }
      const message = caught instanceof Error ? caught.message : 'Unknown workflow failure.';
      const incomplete = caught instanceof SynthesisIncompleteError;
      const partialResult = incomplete ? limitText(caught.partialContent, 64_000) : current?.result;
      const synthesisContinuationAttempts = incomplete ? caught.continuationAttempts : undefined;
      task = await this.store.updateTask(task.id, {
        status: 'failed',
        error: limitText(message, 4_000),
        ...(partialResult ? { result: partialResult } : {}),
      });
      await this.emit(task, {
        type: 'task.failed',
        payload: {
          error: limitText(message, 2_000),
          ...(partialResult ? { result: partialResult } : {}),
          ...(incomplete ? { partial: true, synthesisContinuationAttempts } : {}),
        },
      });
      this.logger.error({ taskId: task.id, error: caught }, 'workflow task failed');
      return task;
    } finally {
      this.taskModels.delete(initialTask.id);
    }
  }
}
