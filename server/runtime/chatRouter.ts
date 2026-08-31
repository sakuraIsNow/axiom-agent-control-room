import { z } from 'zod';
import type { AgentGraph, TaskDifficulty, TaskKind, TaskProfile, TurnRoutingDecision, TurnSchedulingDecision, TurnSchedulingStep, WorkflowPlan, WorkflowStep } from './contracts.js';
import type { ModelClient } from './modelClient.js';
import { classifyTask } from './orchestrator.js';
import { routeSkillIds, runtimeSkillCatalog } from './skillCatalog.js';

export type ChatIntent = 'conversation' | 'agent-registry' | 'web-search' | 'academic-search' | 'github-research' | 'image-generation' | 'video-generation' | 'image-analysis' | 'document-analysis' | 'task';
export type RoutingAgentDirectoryEntry = { id: string; label: string; description: string; capabilities: string[]; available?: boolean };
export type RoutingSkillDirectoryEntry = { id: string; label: string; description: string };
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
  router: TurnRoutingDecision & { intent: ChatIntent };
  scheduler: TurnSchedulingDecision;
};
export type ChatRouteInput = {
  message: string;
  mode: 'analyze' | 'build' | 'decide';
  attachments?: Array<{ name?: string; mimeType?: string; kind?: string }>;
  conversationContext?: Array<{ role: 'user' | 'assistant'; content: string }>;
  currentGraph?: AgentGraph | null;
  availableAgents?: RoutingAgentDirectoryEntry[];
  availableSkills?: RoutingSkillDirectoryEntry[];
  onFallback?: (error: unknown) => void;
};

const routingVersion = 'router-scheduler/v1';
const intentSchema = z.enum(['conversation', 'agent-registry', 'web-search', 'academic-search', 'github-research', 'image-generation', 'video-generation', 'image-analysis', 'document-analysis', 'task']);
const routeSchema = z.enum(['direct', 'single-agent', 'team', 'full-workflow']);
const taskKindSchema = z.enum(['conversation', 'question', 'research', 'implementation', 'decision', 'creative', 'operations']);
const difficultySchema = z.enum(['trivial', 'easy', 'moderate', 'hard', 'complex']);

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
  router: routerAgentDecisionSchema,
  scheduler: schedulerAgentDecisionSchema,
}).strict();

const defaultAgents: RoutingAgentDirectoryEntry[] = [
  { id: 'direct-responder', label: '对话 Agent', description: '简短问答与自然对话。', capabilities: ['conversation', 'answer'] },
  { id: 'registry-agent', label: 'Agent 目录 Agent', description: '读取平台实时能力目录。', capabilities: ['agent-registry'] },
  { id: 'search-agent', label: '联网搜索 Agent', description: '检索实时事实。', capabilities: ['web-search', 'current-facts'] },
  { id: 'academic-search-agent', label: '论文搜索 Agent', description: '检索论文、DOI 与学术证据。', capabilities: ['academic-search', 'citations'] },
  { id: 'github-research-agent', label: 'GitHub 研究 Agent', description: '检索和分析开源项目。', capabilities: ['github-search', 'repository-analysis'] },
  { id: 'drawing-agent', label: '绘图 Agent', description: '生成或编辑图片。', capabilities: ['image-generation'] },
  { id: 'video-agent', label: '视频制作 Agent', description: '生成或编辑视频。', capabilities: ['video-generation'] },
  { id: 'vision-agent', label: '视觉分析 Agent', description: '识别并分析图片附件。', capabilities: ['image-analysis', 'vision'] },
  { id: 'document-agent', label: '文档分析 Agent', description: '解析 PDF、Word 与文本附件。', capabilities: ['document-analysis'] },
  { id: 'researcher', label: '研究员', description: '收集约束、事实和证据。', capabilities: ['research', 'evidence'] },
  { id: 'analyst', label: '分析员', description: '完成系统分析、方案权衡和风险判断。', capabilities: ['analysis', 'architecture', 'decision'] },
  { id: 'builder', label: '工程师', description: '形成可执行实现与验收步骤。', capabilities: ['implementation', 'testing'] },
  { id: 'reviewer', label: '审查员', description: '执行质量门禁并指出缺口。', capabilities: ['quality-review', 'verification'] },
];
const intentAgent: Record<Exclude<ChatIntent, 'task'>, string> = {
  conversation: 'direct-responder', 'agent-registry': 'registry-agent', 'web-search': 'search-agent', 'academic-search': 'academic-search-agent',
  'github-research': 'github-research-agent', 'image-generation': 'drawing-agent', 'video-generation': 'video-agent', 'image-analysis': 'vision-agent', 'document-analysis': 'document-agent',
};
const extractJson = (content: string) => {
  const unfenced = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  return JSON.parse(start >= 0 && end > start ? unfenced.slice(start, end + 1) : unfenced) as unknown;
};
const withSystemSynthesizer = (value: unknown): unknown => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return { ...value, synthesisAgentId: 'synthesizer' };
};
const unique = <T>(values: T[]) => [...new Set(values)];
const directories = (input: ChatRouteInput) => ({
  agents: (input.availableAgents?.length ? input.availableAgents : defaultAgents).filter((agent) => agent.available !== false).filter((agent, index, all) => all.findIndex((candidate) => candidate.id === agent.id) === index).slice(0, 64),
  skills: (input.availableSkills?.length ? input.availableSkills : runtimeSkillCatalog.map(({ id, label, description }) => ({ id, label, description }))).filter((skill, index, all) => all.findIndex((candidate) => candidate.id === skill.id) === index).slice(0, 64),
});
const currentGraphRoles = (input: ChatRouteInput) => unique((input.currentGraph?.nodes ?? []).map((node) => node.role).filter((value): value is string => typeof value === 'string' && !['orchestrator', 'synthesizer'].includes(value)));
const executionWaves = (steps: TurnSchedulingStep[]) => {
  const remaining = new Map(steps.map((step) => [step.id, step]));
  const completed = new Set<string>();
  const waves: string[][] = [];
  while (remaining.size) {
    const ready = [...remaining.values()].filter((step) => step.dependsOn.every((dependency) => completed.has(dependency)));
    if (!ready.length) throw new Error('Scheduler Agent returned a cyclic dependency graph.');
    waves.push(ready.map((step) => step.id));
    ready.forEach((step) => { remaining.delete(step.id); completed.add(step.id); });
  }
  return waves;
};

const fallbackSteps = (message: string, mode: ChatRouteInput['mode'], route: ChatRouteDecision['workflowRoute']): TurnSchedulingStep[] => {
  if (route === 'direct') return [];
  if (route === 'single-agent') {
    const agentId = mode === 'build' ? 'builder' : 'analyst';
    return [{ id: 'focused-response', title: agentId === 'builder' ? '形成可执行结果' : '完成专注分析', agentId, objective: message, dependsOn: [], skillIds: routeSkillIds(message, agentId) }];
  }
  const research: TurnSchedulingStep = { id: 'research', title: '梳理事实与约束', agentId: 'researcher', objective: `收集完成目标所需的事实、约束与证据：${message}`, dependsOn: [], skillIds: routeSkillIds(message, 'researcher') };
  const analysis: TurnSchedulingStep = { id: 'analysis', title: '分析方案与取舍', agentId: 'analyst', objective: `分析目标、边界、方案与风险：${message}`, dependsOn: [], skillIds: routeSkillIds(message, 'analyst') };
  if (route === 'team') return [research, analysis];
  const build: TurnSchedulingStep = { id: 'delivery', title: '形成可执行交付', agentId: 'builder', objective: `根据研究和分析形成可执行交付：${message}`, dependsOn: ['research', 'analysis'], skillIds: routeSkillIds(message, 'builder') };
  const review: TurnSchedulingStep = { id: 'quality-review', title: '验证交付质量', agentId: 'reviewer', objective: '检查完整性、证据、风险和验收标准。', dependsOn: ['delivery'], skillIds: ['quality-review'] };
  return [research, analysis, build, review];
};
const fallbackDecision = (input: ChatRouteInput, intent: ChatIntent, workflowRoute: ChatRouteDecision['workflowRoute'], reason: string): ChatRouteDecision => {
  const profile = classifyTask(input.message, input.mode);
  const steps = intent === 'task' ? fallbackSteps(input.message, input.mode, workflowRoute) : [];
  const activeAgentIds = intent === 'task' ? workflowRoute === 'direct' ? ['direct-responder'] : unique(steps.map((step) => step.agentId)) : [intentAgent[intent]];
  const selectedSkillIds = intent === 'task' ? unique(steps.flatMap((step) => step.skillIds)) : routeSkillIds(`${intent} ${input.message} ${reason}`, activeAgentIds[0]!);
  const existing = currentGraphRoles(input);
  const scheduler: TurnSchedulingDecision = {
    route: workflowRoute, activeAgentIds, skippedAgentIds: existing.filter((id) => !activeAgentIds.includes(id)), appendAgentIds: activeAgentIds.filter((id) => !existing.includes(id)), selectedSkillIds,
    executionWaves: executionWaves(steps), steps, requiresReview: workflowRoute === 'full-workflow', synthesisAgentId: 'synthesizer', reason,
  };
  const router: ChatRouteDecision['router'] = {
    intent, taskKind: (intent === 'task' ? profile.kind : intent === 'conversation' ? 'conversation' : 'question') as TaskKind,
    difficulty: (intent === 'task' ? profile.difficulty : intent === 'conversation' ? 'trivial' : 'easy') as TaskDifficulty,
    requiresExternalFacts: ['web-search', 'academic-search', 'github-research'].includes(intent), requiredCapabilities: activeAgentIds,
    candidateAgentIds: activeAgentIds, candidateSkillIds: selectedSkillIds, confidence: 0, rationale: reason,
  };
  return {
    intent, execution: intent === 'task' && workflowRoute !== 'direct' ? 'workflow' : 'gateway', agentRole: intent === 'task' && workflowRoute !== 'direct' ? 'orchestrator' : activeAgentIds[0]!,
    workflowRoute, requiresSearch: router.requiresExternalFacts, reason, source: 'deterministic-fallback', skillIds: selectedSkillIds, routingVersion, router, scheduler,
  };
};

/** Regex-based routing is retained only as the model-unavailable fallback. */
export const fallbackChatRoute = (input: ChatRouteInput): ChatRouteDecision => {
  const text = input.message.trim();
  const attachments = input.attachments ?? [];
  const hasImage = attachments.some((attachment) => attachment.mimeType?.startsWith('image/') || /\.(png|jpe?g|webp|gif)$/i.test(attachment.name ?? ''));
  const hasDocument = attachments.some((attachment) => !attachment.mimeType?.startsWith('image/'));
  const videoGeneration = /(?:生成|制作|创建|剪辑|合成).{0,18}(?:视频|短片|动画|影片)|(?:generate|create|make|edit).{0,18}(?:video|movie|clip|animation)/i.test(text);
  const imageGeneration = /(?:生成|绘制|画|制作|设计|编辑|修改).{0,16}(?:图片|图像|海报|插画|封面)|(?:draw|generate|create|edit).{0,16}(?:image|picture|poster|illustration)/i.test(text);
  const agentRegistry = /(?:有哪些|哪几个|列出|查看|介绍|可用).{0,20}(?:agent|智能体|子智能体)|(?:agent|agents).{0,20}(?:available|list|registry|catalog)/i.test(text);
  const capabilityRegistry = /(?:你有.{0,24}(?:能力|功能)(?:吗|么)?|你(?:能|可以|会)(?:进行|使用|调用)?.{0,20}(?:吗|么)|你(?:支持|提供)(?:联网搜索|搜索|图片识别|视觉分析|文档分析|绘图|视频生成|工具)|有哪些能力|支持哪些功能)/i.test(text);
  const academicSearch = /(?:论文|文献|期刊|学术|arxiv|doi|paper|literature|academic|journal)/i.test(text);
  const githubResearch = /(?:github|开源仓库|代码仓库|repository|repo)|(?:开源|open[ -]?source).{0,30}(?:agent|智能体|项目|框架|工具|仓库)/i.test(text);
  const webSearch = /(?:天气|气温|预报|新闻|价格|股价|汇率|联网|上网|搜索|查找|网页|最新|目前|现在|今天|实时|weather|forecast|news|price|current|latest|today|internet)/i.test(text);
  const workflowSignals = /(?:多智能体|multi[- ]?agent|agent\s*graph|工作流|协作|协同|先由|首先由|再由|然后由|接着由|最后由|分别由|first|then|next|finally|followed by|->)/i.test(text);
  const workflowRoleCount = [/(?:搜索|研究|检索|search|research(?:er)?)\s*agent/i, /(?:架构|分析|方案|analyst|architect(?:ure)?)\s*agent/i, /(?:数据库|数据|database|db)\s*agent/i, /(?:实现|开发|构建|编程|builder|developer)\s*agent/i, /(?:审查|审核|评审|reviewer|review)\b/i, /(?:汇总|综合|整合|synthesizer|synthesis)\b/i].filter((pattern) => pattern.test(text)).length;
  const conversation = /^(?:你在吗|在吗|你好|您好|嗨|谢谢|感谢|再见|hi|hello|hey|thanks|bye)[？?！!。,\.\s]*$/i.test(text);
  if (workflowSignals && workflowRoleCount >= 2) return fallbackDecision(input, 'task', 'full-workflow', '兜底规则检测到明确的多 Agent 协作顺序。');
  if (videoGeneration) return fallbackDecision(input, 'video-generation', 'direct', '兜底规则检测到视频生成目标。');
  if (imageGeneration) return fallbackDecision(input, 'image-generation', 'direct', '兜底规则检测到图像生成目标。');
  if (hasImage) return fallbackDecision(input, 'image-analysis', 'direct', '图片附件要求视觉能力。');
  if (hasDocument) return fallbackDecision(input, 'document-analysis', 'direct', '文档附件要求文档解析能力。');
  if (academicSearch) return fallbackDecision(input, 'academic-search', 'direct', '兜底规则检测到学术检索目标。');
  if (githubResearch) return fallbackDecision(input, 'github-research', 'direct', '兜底规则检测到 GitHub 检索目标。');
  if (agentRegistry || capabilityRegistry) return fallbackDecision(input, 'agent-registry', 'direct', '兜底规则检测到实时 Agent 能力查询。');
  if (webSearch) return fallbackDecision(input, 'web-search', 'direct', '兜底规则检测到外部实时事实。');
  if (conversation) return fallbackDecision(input, 'conversation', 'direct', '短对话无需建立工作流。');
  const profile = classifyTask(text, input.mode);
  return fallbackDecision(input, 'task', profile.route, `兜底分类为 ${profile.kind} / ${profile.difficulty}。`);
};

const assertKnownIds = (values: string[], known: Set<string>, label: string) => {
  const invalid = values.filter((value) => !known.has(value));
  if (invalid.length) throw new Error(`${label} references unavailable ids: ${invalid.join(', ')}`);
};
const validateRouter = (router: ChatRouteDecision['router'], input: ChatRouteInput, agentIds: Set<string>, skillIds: Set<string>) => {
  if (router.confidence < 0.55) throw new Error('Router confidence is below threshold.');
  assertKnownIds(router.candidateAgentIds, agentIds, 'Router Agent');
  assertKnownIds(router.candidateSkillIds, skillIds, 'Router Skill');
  const attachments = input.attachments ?? [];
  const hasImage = attachments.some((attachment) => attachment.mimeType?.startsWith('image/') || attachment.kind === 'image');
  const hasDocument = attachments.some((attachment) => !attachment.mimeType?.startsWith('image/') && attachment.kind !== 'image');
  if (hasImage && (router.intent !== 'image-analysis' || !router.candidateAgentIds.includes('vision-agent'))) throw new Error('Image attachments require Vision Agent.');
  if (hasDocument && (router.intent !== 'document-analysis' || !router.candidateAgentIds.includes('document-agent'))) throw new Error('Documents require Document Agent.');
  if (router.intent !== 'task' && !router.candidateAgentIds.includes(intentAgent[router.intent])) throw new Error('Required specialist is absent.');
};
const normalizeRouter = (router: ChatRouteDecision['router']): ChatRouteDecision['router'] => {
  const conversationIsActuallyTask = router.intent === 'conversation'
    && (router.taskKind !== 'conversation' || router.candidateAgentIds.some((id) => id !== 'direct-responder'));
  if (!conversationIsActuallyTask) return router;
  const taskAgents = router.candidateAgentIds.filter((id) => id !== 'direct-responder');
  return {
    ...router,
    intent: 'task',
    candidateAgentIds: taskAgents.length ? taskAgents : router.candidateAgentIds,
    rationale: `${router.rationale} Router 的任务类型或候选能力表明本轮需要执行任务，已纠正寒暄意图。`,
  };
};
const routeForScheduledSteps = (
  requested: TurnSchedulingDecision['route'],
  difficulty: TaskDifficulty,
  stepCount: number,
): TurnSchedulingDecision['route'] => {
  if (stepCount === 0) return 'direct';
  if (stepCount === 1) return 'single-agent';
  if (stepCount >= 4) return 'full-workflow';
  if (requested === 'full-workflow' && stepCount >= 3 && (difficulty === 'hard' || difficulty === 'complex')) return 'full-workflow';
  return 'team';
};
const validateScheduler = (scheduler: TurnSchedulingDecision, router: ChatRouteDecision['router'], input: ChatRouteInput, agentIds: Set<string>, skillIds: Set<string>): TurnSchedulingDecision => {
  assertKnownIds(scheduler.activeAgentIds, agentIds, 'Scheduler Agent');
  assertKnownIds(scheduler.appendAgentIds, agentIds, 'Scheduler append');
  assertKnownIds(scheduler.selectedSkillIds, skillIds, 'Scheduler Skill');
  assertKnownIds(scheduler.steps.map((step) => step.agentId), agentIds, 'Scheduler step');
  assertKnownIds(scheduler.steps.flatMap((step) => step.skillIds), skillIds, 'Scheduler step Skill');
  const candidates = new Set(router.candidateAgentIds);
  const candidateSkills = new Set(router.candidateSkillIds);
  if (scheduler.activeAgentIds.some((id) => !candidates.has(id))) throw new Error('Scheduler selected an Agent outside Router candidates.');
  if (scheduler.selectedSkillIds.some((id) => !candidateSkills.has(id))) throw new Error('Scheduler selected a Skill outside Router candidates.');
  if (scheduler.steps.some((step) => !candidates.has(step.agentId) || step.skillIds.some((id) => !candidateSkills.has(id)))) throw new Error('Scheduler step is outside Router candidates.');
  const stepIds = scheduler.steps.map((step) => step.id);
  if (new Set(stepIds).size !== stepIds.length || scheduler.steps.some((step) => step.dependsOn.some((dependency) => !stepIds.includes(dependency) || dependency === step.id))) throw new Error('Scheduler dependencies are invalid.');
  const specialist = router.intent === 'task' ? null : intentAgent[router.intent];
  const existing = currentGraphRoles(input);
  if (specialist) {
    const selectedSkillIds = unique(scheduler.selectedSkillIds.filter((id) => candidateSkills.has(id)));
    return {
      ...scheduler,
      route: 'direct',
      activeAgentIds: [specialist],
      skippedAgentIds: unique([...scheduler.skippedAgentIds, ...existing.filter((id) => id !== specialist)]),
      appendAgentIds: existing.includes(specialist) ? [] : [specialist],
      selectedSkillIds,
      executionWaves: [],
      steps: [],
      requiresReview: false,
    };
  }
  const route = routeForScheduledSteps(scheduler.route, router.difficulty, scheduler.steps.length);
  const activeAgentIds = route === 'direct' ? ['direct-responder'] : unique(scheduler.steps.map((step) => step.agentId));
  if (activeAgentIds.some((id) => !candidates.has(id))) throw new Error('Scheduled execution requires an Agent outside Router candidates.');
  if (route !== 'direct' && activeAgentIds.length === 0) throw new Error('Workflow schedule has no executable Agent.');
  if (route === 'direct' && !candidates.has('direct-responder')) throw new Error('Direct task requires Direct Responder in Router candidates.');
  const selectedSkillIds = route === 'direct'
    ? unique(scheduler.selectedSkillIds)
    : unique(scheduler.steps.flatMap((step) => step.skillIds));
  if (selectedSkillIds.some((id) => !candidateSkills.has(id))) throw new Error('Scheduled execution requires a Skill outside Router candidates.');
  const normalizedSteps = route === 'direct' ? [] : scheduler.steps;
  executionWaves(normalizedSteps);
  return {
    ...scheduler,
    route,
    activeAgentIds,
    skippedAgentIds: unique([...scheduler.skippedAgentIds, ...existing.filter((id) => !activeAgentIds.includes(id))]),
    appendAgentIds: unique(activeAgentIds.filter((id) => !existing.includes(id))),
    selectedSkillIds,
    executionWaves: executionWaves(normalizedSteps),
    steps: normalizedSteps,
    requiresReview: normalizedSteps.some((step) => step.agentId === 'reviewer'),
  };
};

export const routeChatIntent = async (input: ChatRouteInput, model: ModelClient, signal: AbortSignal): Promise<ChatRouteDecision> => {
  let fallback: ChatRouteDecision | undefined;
  const deterministicFallback = () => fallback ??= fallbackChatRoute(input);
  const { agents, skills } = directories(input);
  const agentIds = new Set(agents.map((agent) => agent.id));
  const skillIds = new Set(skills.map((skill) => skill.id));
  const graph = { nodes: (input.currentGraph?.nodes ?? []).map(({ id, agentId, role, title, status }) => ({ id, agentId, role, title, status })), edges: input.currentGraph?.edges ?? [] };
  try {
    const routerCompletion = await model.complete({
      signal, responseFormat: 'json', temperature: 0, maxTokens: 900,
      system: `You are the Router Agent for a production Agent platform. Classify and select candidates only; never answer or schedule.
Use the latest turn, compact conversation context, attachments, live Agent/Skill directories, and cumulative session Graph. Choose only supplied IDs and the smallest sufficient candidate set. Existing Graph Agents need not run again. Add capabilities only when this turn needs them.
Intents: conversation only for greetings, thanks, social chat, or casual small talk; agent-registry; web-search for a simple current-fact lookup; academic-search; github-research; image-generation; video-generation; image-analysis; document-analysis; task for every comparison, decision, analysis, design, planning, implementation, or multi-stage request. A retrieval request that also needs analysis or implementation is a task and should include the relevant search Agent plus reasoning/build Agents. Do not call every task complex. Confidence below 0.55 triggers fallback.
Return JSON only: {"intent":"...","taskKind":"conversation|question|research|implementation|decision|creative|operations","difficulty":"trivial|easy|moderate|hard|complex","requiresExternalFacts":false,"requiredCapabilities":["..."],"candidateAgentIds":["..."],"candidateSkillIds":["..."],"confidence":0.0,"rationale":"..."}.`,
      user: JSON.stringify({ latestUserTurn: input.message.slice(0, 8_000), mode: input.mode, attachments: input.attachments ?? [], conversationContext: (input.conversationContext ?? []).slice(-12).map((message) => ({ ...message, content: message.content.slice(0, 2_000) })), availableAgents: agents, availableSkills: skills, currentSessionGraph: graph }),
    });
    const router = normalizeRouter(routerAgentDecisionSchema.parse(extractJson(routerCompletion.content)) as ChatRouteDecision['router']);
    validateRouter(router, input, agentIds, skillIds);
    const schedulerCompletion = await model.complete({
      signal, responseFormat: 'json', temperature: 0, maxTokens: 1_800,
      system: `You are the Scheduler Agent for a production multi-Agent runtime. Do not answer and do not change Router intent.
Use only Router candidate IDs. Activate only Agents useful this turn; do not run every Agent already in the Graph. skippedAgentIds lists prior unused Agent roles. appendAgentIds lists genuinely new active roles.
For non-task specialist intents, always return direct with that one specialist and no steps. For tasks: direct has no steps; single-agent exactly 1; team 2-3; full-workflow normally has 3-8 dependency-aware steps and is reserved for hard/complex work with justified dependencies. A small implementation plus review is team, not full-workflow. executionWaves contains dependency-ready step IDs. Every active Agent must own a step. Dependencies must form a DAG. synthesisAgentId must be synthesizer.
Return JSON only: {"route":"direct|single-agent|team|full-workflow","activeAgentIds":["..."],"skippedAgentIds":["..."],"appendAgentIds":["..."],"selectedSkillIds":["..."],"executionWaves":[["step-id"]],"steps":[{"id":"...","title":"...","agentId":"...","objective":"...","dependsOn":[],"skillIds":[]}],"requiresReview":false,"synthesisAgentId":"synthesizer","reason":"..."}.`,
      user: JSON.stringify({ latestUserTurn: input.message.slice(0, 8_000), mode: input.mode, routerDecision: router, candidateAgents: agents.filter((agent) => router.candidateAgentIds.includes(agent.id)), candidateSkills: skills.filter((skill) => router.candidateSkillIds.includes(skill.id)), currentSessionGraph: graph }),
    });
    const scheduler = validateScheduler(schedulerAgentDecisionSchema.parse(withSystemSynthesizer(extractJson(schedulerCompletion.content))), router, input, agentIds, skillIds);
    const execution = router.intent === 'task' && scheduler.route !== 'direct' ? 'workflow' : 'gateway';
    return chatRouteDecisionSchema.parse({
      intent: router.intent, execution, agentRole: execution === 'workflow' ? 'orchestrator' : scheduler.activeAgentIds[0], workflowRoute: scheduler.route,
      requiresSearch: ['web-search', 'academic-search', 'github-research'].includes(router.intent), reason: scheduler.reason, source: 'router-agent', skillIds: scheduler.selectedSkillIds,
      routingVersion, routerModel: model.model, router, scheduler,
    }) as ChatRouteDecision;
  } catch (error) {
    input.onFallback?.(error);
    return deterministicFallback();
  }
};

const difficultyScore: Record<TaskDifficulty, number> = { trivial: 0, easy: 1, moderate: 2, hard: 4, complex: 6 };
const specialists = new Set(['search-agent', 'academic-search-agent', 'github-research-agent', 'drawing-agent', 'video-agent']);
const graphForSteps = (steps: WorkflowStep[]): AgentGraph => {
  const nodes: AgentGraph['nodes'] = [
    { id: 'orchestrator', agentId: 'orchestrator', role: 'orchestrator', title: '调度 Agent', dependsOn: [], status: 'running' },
    ...steps.map((step) => ({ id: step.id, stepId: step.id, agentId: `${step.role}-${step.id}`, role: step.role, title: step.title, dependsOn: step.dependsOn, skillIds: step.skillIds, status: 'queued' as const })),
    { id: 'synthesizer', agentId: 'synthesizer', role: 'synthesizer', title: '汇总交付', dependsOn: steps.map((step) => step.id), status: 'queued' },
  ];
  const edges: AgentGraph['edges'] = steps.flatMap((step) => (step.dependsOn.length ? step.dependsOn : ['orchestrator']).map((dependency) => ({ from: dependency, to: step.id, kind: dependency === 'orchestrator' ? 'delegation' as const : step.role === 'reviewer' ? 'review' as const : 'dependency' as const })));
  edges.push(...steps.map((step) => ({ from: step.id, to: 'synthesizer', kind: 'dependency' as const })));
  return { nodes, edges };
};
export const workflowPlanFromChatRoute = (decision: ChatRouteDecision): WorkflowPlan | undefined => {
  if (decision.execution !== 'workflow') return undefined;
  const profile: TaskProfile = {
    kind: decision.router.taskKind, difficulty: decision.router.difficulty, route: decision.scheduler.route, score: difficultyScore[decision.router.difficulty],
    reasons: [decision.router.rationale, decision.scheduler.reason], maxSteps: decision.scheduler.steps.length, requiresReview: decision.scheduler.requiresReview,
  };
  const steps: WorkflowStep[] = decision.scheduler.steps.map((step) => ({
    id: step.id, title: step.title, role: step.agentId, objective: step.objective, dependsOn: step.dependsOn,
    acceptanceCriteria: [`完成“${step.title}”并给出可验证的结果。`], skillIds: step.skillIds, maxTokens: step.agentId === 'reviewer' ? 8_192 : 6_144, maxDurationMs: 120_000, failureStrategy: 'retry',
    ...(specialists.has(step.agentId) ? { agentContract: { source: 'builtin' as const, agentId: step.agentId, displayName: step.title, toolAllowlist: [] } } : {}),
  }));
  return {
    summary: `调度 Agent 已为本轮选择 ${steps.length} 个执行步骤。`, routingReason: decision.reason, steps, profile, graph: graphForSteps(steps), version: 1,
    approvalStatus: 'approved', approvedAt: new Date().toISOString(), approvedBy: 'router-scheduler-control-plane', routingDecision: decision.router,
    schedulingDecision: decision.scheduler, routingVersion: decision.routingVersion, routerModel: decision.routerModel, routerConfidence: decision.router.confidence,
  };
};
