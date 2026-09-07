import { z } from 'zod';
import type { AgentGraph, TaskDifficulty, TaskKind, TaskProfile, TurnRoutingDecision, TurnSchedulingDecision, TurnSchedulingStep, WorkflowPlan, WorkflowStep } from './contracts.js';
import type { ModelClient } from './modelClient.js';
import { classifyTask } from './orchestrator.js';
import { routeSkillIds, runtimeSkillCatalog } from './skillCatalog.js';

export type ReportExportDecision = { scope: 'last-answer' | 'conversation'; format: 'md' | 'docx' | 'tex' | 'pdf'; title?: string };
export type ChatIntent = 'conversation' | 'agent-registry' | 'web-search' | 'academic-search' | 'github-research' | 'image-generation' | 'video-generation' | 'image-analysis' | 'document-analysis' | 'report-export' | 'task';
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
  reportExport?: ReportExportDecision;
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
  reportExport: reportExportDecisionSchema.optional(),
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
  { id: 'report-agent', label: '报告生成 Agent', description: '按用户语义整理会话并导出 Markdown、Word、LaTeX 或 PDF。', capabilities: ['report-export', 'document-generation'] },
  { id: 'researcher', label: '研究员', description: '收集约束、事实和证据。', capabilities: ['research', 'evidence'] },
  { id: 'analyst', label: '分析员', description: '完成系统分析、方案权衡和风险判断。', capabilities: ['analysis', 'architecture', 'decision'] },
  { id: 'builder', label: '工程师', description: '形成可执行实现与验收步骤。', capabilities: ['implementation', 'testing'] },
  { id: 'reviewer', label: '审查员', description: '执行质量门禁并指出缺口。', capabilities: ['quality-review', 'verification'] },
];
const intentAgent: Record<Exclude<ChatIntent, 'task'>, string> = {
  conversation: 'direct-responder', 'agent-registry': 'registry-agent', 'web-search': 'search-agent', 'academic-search': 'academic-search-agent',
  'github-research': 'github-research-agent', 'image-generation': 'drawing-agent', 'video-generation': 'video-agent', 'image-analysis': 'vision-agent', 'document-analysis': 'document-agent',
  'report-export': 'report-agent',
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
const attachmentRequirements = (input: ChatRouteInput) => {
  const image = (attachment: NonNullable<ChatRouteInput['attachments']>[number]) => attachment.kind === 'image'
    || attachment.mimeType?.startsWith('image/')
    || /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i.test(attachment.name ?? '');
  const attachments = input.attachments ?? [];
  return [
    ...(attachments.some(image) ? [{ capability: 'image-analysis', agentId: 'vision-agent' }] : []),
    ...(attachments.some((attachment) => !image(attachment)) ? [{ capability: 'document-analysis', agentId: 'document-agent' }] : []),
  ];
};
const requireAttachmentCapabilities = (router: ChatRouteDecision['router'], input: ChatRouteInput): ChatRouteDecision['router'] => {
  const requirements = attachmentRequirements(input);
  if (!requirements.length || router.intent === 'report-export'
    || ['image-generation', 'video-generation'].includes(router.intent) && requirements.every((item) => item.agentId === 'vision-agent')) return router;
  const specialist = router.intent === 'task' ? undefined : intentAgent[router.intent];
  const composite = router.intent === 'task' || requirements.some((requirement) => requirement.agentId !== specialist);
  return {
    ...router,
    intent: composite ? 'task' : router.intent,
    requiredCapabilities: unique([...router.requiredCapabilities, ...requirements.map((requirement) => requirement.capability)]),
    candidateAgentIds: unique([...router.candidateAgentIds.filter((id) => !composite || id !== 'direct-responder'), ...requirements.map((requirement) => requirement.agentId)]),
  };
};
const requireAttachmentSteps = (scheduler: TurnSchedulingDecision, router: ChatRouteDecision['router'], input: ChatRouteInput): TurnSchedulingDecision => {
  if (router.intent !== 'task') return scheduler;
  const missing = attachmentRequirements(input).filter((requirement) => !scheduler.steps.some((step) => step.agentId === requirement.agentId));
  if (!missing.length) return scheduler;
  const used = new Set(scheduler.steps.map((step) => step.id));
  const preparations = missing.map((requirement): TurnSchedulingStep => {
    let id = `attachment-${requirement.capability}`;
    while (used.has(id)) id += '-input';
    used.add(id);
    return { id, title: requirement.capability === 'image-analysis' ? '分析图片附件' : '分析文档附件', agentId: requirement.agentId, objective: `Analyze this turn's ${requirement.capability === 'image-analysis' ? 'image' : 'document'} attachments and pass source-backed findings to the dependent work. User request: ${input.message.slice(0, 1_500)}`, dependsOn: [], skillIds: [] };
  });
  const steps = [...preparations, ...scheduler.steps.map((step) => step.dependsOn.length ? step : { ...step, dependsOn: preparations.map((item) => item.id) })];
  if (steps.length > 8) throw new Error('Attachment requirements exceed the eight-step schedule budget.');
  return { ...scheduler, steps, activeAgentIds: unique(steps.map((step) => step.agentId)) };
};
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
const fallbackDecision = (input: ChatRouteInput, intent: ChatIntent, workflowRoute: ChatRouteDecision['workflowRoute'], reason: string, reportExport?: ReportExportDecision): ChatRouteDecision => {
  const profile = classifyTask(input.message, input.mode);
  const steps = intent === 'task' ? fallbackSteps(input.message, input.mode, workflowRoute) : [];
  const activeAgentIds = intent === 'task' ? workflowRoute === 'direct' ? ['direct-responder'] : unique(steps.map((step) => step.agentId)) : [intentAgent[intent]];
  // Route Skills from the user's turn. For ordinary specialist intents the
  // rationale can add useful semantic context (for example, an external
  // "事实" lookup needs evidence handling), but Registry rationale must not
  // leak the word "实时" into the web-research matcher.
  const skillRoutingText = intent === 'agent-registry'
    ? `${intent} ${input.message}`
    : `${intent} ${input.message} ${reason}`;
  const selectedSkillIds = intent === 'task'
    ? unique(steps.flatMap((step) => step.skillIds))
    : intent === 'agent-registry'
      ? []
      : routeSkillIds(skillRoutingText, activeAgentIds[0]!);
  const existing = currentGraphRoles(input);
  const scheduler: TurnSchedulingDecision = {
    route: workflowRoute, activeAgentIds, skippedAgentIds: existing.filter((id) => !activeAgentIds.includes(id)), appendAgentIds: activeAgentIds.filter((id) => !existing.includes(id)), selectedSkillIds,
    executionWaves: executionWaves(steps), steps, requiresReview: workflowRoute === 'full-workflow', synthesisAgentId: 'synthesizer', reason,
  };
  const router: ChatRouteDecision['router'] = {
    intent, taskKind: (intent === 'task' ? profile.kind : intent === 'conversation' ? 'conversation' : 'question') as TaskKind,
    difficulty: (intent === 'task' ? profile.difficulty : intent === 'conversation' ? 'trivial' : 'easy') as TaskDifficulty,
    requiresExternalFacts: ['web-search', 'academic-search', 'github-research'].includes(intent) || selectedSkillIds.includes('web-research') || selectedSkillIds.includes('github-inspection'), requiredCapabilities: activeAgentIds,
    candidateAgentIds: activeAgentIds, candidateSkillIds: selectedSkillIds, confidence: 0, rationale: reason,
    ...(reportExport ? { reportExport } : {}),
  };
  return {
    intent, execution: intent === 'task' && workflowRoute !== 'direct' ? 'workflow' : 'gateway', agentRole: intent === 'task' && workflowRoute !== 'direct' ? 'orchestrator' : activeAgentIds[0]!,
    workflowRoute, requiresSearch: router.requiresExternalFacts || activeAgentIds.some((id) => ['search-agent', 'academic-search-agent', 'github-research-agent'].includes(id)), reason, source: 'deterministic-fallback', skillIds: selectedSkillIds, routingVersion, router, scheduler,
    ...(reportExport ? { reportExport } : {}),
  };
};

const fallbackReportExport = (text: string): ReportExportDecision => {
  const format: ReportExportDecision['format'] = /(?:latex|\.tex\b|tex\s*格式)/i.test(text)
    ? 'tex'
    : /(?:markdown|\.md\b|md\s*格式)/i.test(text)
      ? 'md'
      : /(?:pdf)/i.test(text)
        ? 'pdf'
        : 'docx';
  const scope: ReportExportDecision['scope'] = /(?:完整|全部|整个|整段|全量).{0,12}(?:对话|会话|聊天|历史)|(?:对话|会话|聊天|历史).{0,12}(?:完整|全部|整个|全量)|full\s+(?:conversation|chat)|entire\s+(?:conversation|chat)/i.test(text)
    ? 'conversation'
    : 'last-answer';
  return { scope, format };
};

/** Regex-based routing is retained only as the model-unavailable fallback. */
const baseFallbackChatRoute = (input: ChatRouteInput): ChatRouteDecision => {
  const text = input.message.trim();
  const required = attachmentRequirements(input);
  const hasImage = required.some((item) => item.agentId === 'vision-agent');
  const hasDocument = required.some((item) => item.agentId === 'document-agent');
  const videoGeneration = /(?:生成|制作|创建|剪辑|合成).{0,18}(?:视频|短片|动画|影片)|(?:generate|create|make|edit).{0,18}(?:video|movie|clip|animation)/i.test(text);
  const imageGeneration = /(?:生成|绘制|画|制作|设计|编辑|修改).{0,16}(?:图片|图像|海报|插画|封面)|(?:draw|generate|create|edit).{0,16}(?:image|picture|poster|illustration)/i.test(text);
  const agentRegistry = /(?:有哪些|哪几个|列出|查看|介绍|可用).{0,20}(?:agent|智能体|子智能体)|(?:agent|agents).{0,20}(?:available|list|registry|catalog)/i.test(text);
  const capabilityRegistry = /(?:你有.{0,24}(?:能力|功能)(?:吗|么)?|你(?:能|可以|会)(?:进行|使用|调用)?.{0,20}(?:吗|么)|你(?:支持|提供)(?:联网搜索|搜索|图片识别|视觉分析|文档分析|绘图|视频生成|工具)|有哪些能力|支持哪些功能)/i.test(text);
  const reportExport = /(?:导出|下载|另存为|保存为|输出为).{0,30}(?:以上|上述|回答|内容|对话|会话|聊天|报告|文档|文件|markdown|md|word|docx|latex|tex|pdf)|(?:把|将).{0,30}(?:以上|上述|回答|内容|对话|会话|聊天).{0,20}(?:导出|下载|另存|保存|生成).{0,15}(?:报告|文档|文件|markdown|md|word|docx|latex|tex|pdf)|(?:生成|制作).{0,8}(?:word|docx|latex|tex|pdf|markdown|md)(?:格式)?(?:报告|文档|文件)/i.test(text);
  const academicSearch = /(?:论文|文献|期刊|学术|arxiv|doi|paper|literature|academic|journal)/i.test(text);
  const githubResearch = /(?:github|开源仓库|代码仓库|repository|repo)|(?:开源|open[ -]?source).{0,30}(?:agent|智能体|项目|框架|工具|仓库)/i.test(text);
  const webSearch = /(?:天气|气温|预报|新闻|价格|股价|汇率|联网|上网|搜索|查找|网页|最新|目前|现在|今天|实时|weather|forecast|news|price|current|latest|today|internet)/i.test(text);
  const workflowSignals = /(?:多智能体|multi[- ]?agent|agent\s*graph|工作流|协作|协同|先由|首先由|再由|然后由|接着由|最后由|分别由|first|then|next|finally|followed by|->)/i.test(text);
  const workflowRoleCount = [/(?:搜索|研究|检索|search|research(?:er)?)\s*agent/i, /(?:架构|分析|方案|analyst|architect(?:ure)?)\s*agent/i, /(?:数据库|数据|database|db)\s*agent/i, /(?:实现|开发|构建|编程|builder|developer)\s*agent/i, /(?:审查|审核|评审|reviewer|review)\b/i, /(?:汇总|综合|整合|synthesizer|synthesis)\b/i].filter((pattern) => pattern.test(text)).length;
  const conversation = /^(?:你在吗|在吗|你好|您好|嗨|谢谢|感谢|再见|hi|hello|hey|thanks|bye)[？?！!。,\.\s]*$/i.test(text);
  if (workflowSignals && workflowRoleCount >= 2) return fallbackDecision(input, 'task', 'full-workflow', '兜底规则检测到明确的多 Agent 协作顺序。');
  if (reportExport) return fallbackDecision(input, 'report-export', 'direct', '兜底规则检测到明确的会话报告导出动作。', fallbackReportExport(text));
  if (videoGeneration) return fallbackDecision(input, 'video-generation', 'direct', '兜底规则检测到视频生成目标。');
  if (imageGeneration) return fallbackDecision(input, 'image-generation', 'direct', '兜底规则检测到图像生成目标。');
  if (hasImage && hasDocument) return fallbackDecision(input, 'task', 'direct', '图片与文档附件需要组合分析能力。');
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

export const fallbackChatRoute = (input: ChatRouteInput): ChatRouteDecision => {
  const decision = baseFallbackChatRoute(input);
  const router = requireAttachmentCapabilities(decision.router, input);
  if (router.intent !== 'task' || !attachmentRequirements(input).length) return { ...decision, router };
  const specialist = decision.intent === 'task' || decision.intent === 'conversation' ? undefined : intentAgent[decision.intent];
  const initial = specialist && !decision.scheduler.steps.length ? {
    ...decision.scheduler,
    steps: [{ id: 'specialist-delivery', title: decision.reason.slice(0, 120), agentId: specialist, objective: input.message, dependsOn: [], skillIds: decision.skillIds }],
  } : decision.scheduler;
  const prepared = requireAttachmentSteps(initial, router, input);
  const route = routeForScheduledSteps(prepared.route, router.difficulty, prepared.steps.length);
  const existing = currentGraphRoles(input);
  const scheduler = { ...prepared, route, executionWaves: executionWaves(prepared.steps), appendAgentIds: prepared.activeAgentIds.filter((id) => !existing.includes(id)), skippedAgentIds: existing.filter((id) => !prepared.activeAgentIds.includes(id)) };
  return { ...decision, intent: 'task', execution: 'workflow', agentRole: 'orchestrator', workflowRoute: route, router, scheduler };
};

/**
 * Applies server-side constraints to a decision returned by the browser's
 * routing pass. A decision can be stale when a request is retried, so an
 * obviously explicit specialist capability must not be bypassed. We keep
 * model-selected task routes intact because a task may intentionally combine
 * retrieval with analysis or implementation.
 */
export const enforceChatRouteSafety = (routing: ChatRouteDecision, input: ChatRouteInput): ChatRouteDecision => {
  const fallback = fallbackChatRoute(input);
  if (['image-generation', 'video-generation'].includes(routing.intent)
    && attachmentRequirements(input).every((item) => item.agentId === 'vision-agent')) return durableMediaRoute(routing, input.message);
  const hardSpecialistIntents = new Set<ChatIntent>([
    'report-export',
    'image-generation',
    'video-generation',
    'image-analysis',
    'document-analysis',
    'agent-registry',
  ]);
  if (routing.intent === 'conversation' && fallback.intent !== 'conversation') return fallback;
  if (hardSpecialistIntents.has(fallback.intent) && routing.intent !== fallback.intent && (routing.intent !== 'task' || fallback.intent === 'report-export')) return fallback;
  const router = requireAttachmentCapabilities(routing.router, input);
  if (router.intent === 'task' && attachmentRequirements(input).length) {
    let prepared: TurnSchedulingDecision;
    try { prepared = requireAttachmentSteps(routing.scheduler, router, input); } catch { return fallback; }
    const route = routeForScheduledSteps(prepared.route, router.difficulty, prepared.steps.length);
    const existing = currentGraphRoles(input);
    routing = { ...routing, intent: 'task', router, workflowRoute: route, scheduler: { ...prepared, route, executionWaves: executionWaves(prepared.steps), appendAgentIds: prepared.activeAgentIds.filter((id) => !existing.includes(id)), skippedAgentIds: existing.filter((id) => !prepared.activeAgentIds.includes(id)) } };
  }
  const specialistRole = intentAgent[routing.intent as Exclude<ChatIntent, 'task'>];
  if (routing.intent !== 'task') {
    // Specialist gateway intents never create a workflow task. Normalize stale
    // browser state so the UI and server use the same execution contract.
    return {
      ...routing,
      execution: 'gateway',
      workflowRoute: 'direct',
      agentRole: specialistRole ?? routing.agentRole,
      scheduler: {
        ...routing.scheduler,
        route: 'direct',
        activeAgentIds: specialistRole ? [specialistRole] : routing.scheduler.activeAgentIds,
        steps: [],
        executionWaves: [],
        requiresReview: false,
      },
      requiresSearch: routing.requiresSearch
        || routing.router.requiresExternalFacts
        || routing.router.candidateAgentIds.some((id) => ['search-agent', 'academic-search-agent', 'github-research-agent'].includes(id)),
    };
  }

  const route = routing.workflowRoute;
  const schedulerRoute = routing.scheduler.route;
  const steps = routing.scheduler.steps;
  // A task route with no executable steps cannot be sent to the workflow
  // coordinator. Fall back to the same deterministic plan used when routing
  // is unavailable instead of creating a task that can never advance.
  if (route !== 'direct' && (!steps.length || !routing.scheduler.activeAgentIds.length)) return fallback;
  if (route === 'direct') {
    return {
      ...routing,
      execution: 'gateway',
      workflowRoute: 'direct',
      agentRole: 'direct-responder',
      scheduler: {
        ...routing.scheduler,
        route: 'direct',
        activeAgentIds: ['direct-responder'],
        appendAgentIds: routing.scheduler.appendAgentIds.filter((id) => id === 'direct-responder'),
        steps: [],
        executionWaves: [],
        requiresReview: false,
      },
      requiresSearch: routing.requiresSearch || routing.router.requiresExternalFacts,
    };
  }
  if (schedulerRoute !== route) {
    // Keep a valid model-selected plan, but make its duplicated route fields
    // agree before persisting it in the task and graph history.
    routing = {
      ...routing,
      scheduler: { ...routing.scheduler, route },
    };
  }
  return {
    ...routing,
    execution: 'workflow',
    workflowRoute: route,
    agentRole: 'orchestrator',
    requiresSearch: routing.requiresSearch
      || routing.router.requiresExternalFacts
      || routing.router.candidateAgentIds.some((id) => ['search-agent', 'academic-search-agent', 'github-research-agent'].includes(id)),
  };
};

const assertKnownIds = (values: string[], known: Set<string>, label: string) => {
  const invalid = values.filter((value) => !known.has(value));
  if (invalid.length) throw new Error(`${label} references unavailable ids: ${invalid.join(', ')}`);
};
const validateRouter = (router: ChatRouteDecision['router'], input: ChatRouteInput, agentIds: Set<string>, skillIds: Set<string>) => {
  if (router.confidence < 0.55) throw new Error('Router confidence is below threshold.');
  assertKnownIds(router.candidateAgentIds, agentIds, 'Router Agent');
  assertKnownIds(router.candidateSkillIds, skillIds, 'Router Skill');
  if (router.intent !== 'report-export' && attachmentRequirements(input).some((requirement) => !router.candidateAgentIds.includes(requirement.agentId))) throw new Error('Attachments require their analysis capabilities.');
  if (router.intent === 'report-export' && !router.reportExport) throw new Error('Report export intent requires format and scope.');
  if (router.intent !== 'report-export' && router.reportExport) throw new Error('Only report export intent may include report export settings.');
  if (router.intent !== 'task' && !router.candidateAgentIds.includes(intentAgent[router.intent])) throw new Error('Required specialist is absent.');
};
const normalizeRouter = (router: ChatRouteDecision['router']): ChatRouteDecision['router'] => {
  if (router.intent === 'agent-registry') {
    return {
      ...router,
      requiresExternalFacts: false,
      requiredCapabilities: ['registry-agent'],
      candidateAgentIds: ['registry-agent'],
      candidateSkillIds: [],
    };
  }
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

/**
 * An explicit file action is a hard product intent. The Router Agent still
 * chooses the title and, when valid, the requested format/scope, but a
 * malformed or over-broad model classification must not turn a download
 * request into an ordinary answer. The deterministic classifier is only used
 * here as a safety constraint; ordinary report-writing remains a task.
 */
const enforceExplicitReportExport = (
  router: ChatRouteDecision['router'],
  input: ChatRouteInput,
): ChatRouteDecision['router'] => {
  const explicit = fallbackChatRoute(input);
  if (explicit.intent !== 'report-export' || !explicit.reportExport) return router;
  if (router.intent === 'report-export' && router.reportExport) return router;
  return {
    ...explicit.router,
    confidence: Math.max(0.92, router.confidence),
    rationale: `${router.rationale} 检测到用户明确的文件导出动作，已启用报告导出护栏。`,
    reportExport: explicit.reportExport,
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
  scheduler = requireAttachmentSteps(scheduler, router, input);
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
Attachments are additive required capabilities, never mutually exclusive intents. Image inputs require image-analysis/vision-agent; document inputs require document-analysis/document-agent. Mixed attachments or attachment analysis combined with research, reasoning, creation, or implementation are tasks; preserve every useful stage in a minimal plan.
Intents: conversation only for greetings, thanks, social chat, or casual small talk; agent-registry; web-search for a simple current-fact lookup; academic-search; github-research; image-generation; video-generation; image-analysis; document-analysis; report-export only when the user explicitly asks to export, download, save, or generate a file from an existing answer/conversation; task for every comparison, decision, analysis, design, planning, implementation, report-writing request without an explicit file-export action, or multi-stage request. A retrieval request that also needs analysis or implementation is a task and should include the relevant search Agent plus reasoning/build Agents. Do not call every task complex. Confidence below 0.55 triggers fallback.
For report-export, include reportExport with scope last-answer or conversation and format md, docx, tex, or pdf. Infer scope and format from the user's wording. Default to last-answer and docx when unspecified. For every other intent, omit reportExport. Never ask ordinary users whether they want an export.
Return JSON only: {"intent":"...","taskKind":"conversation|question|research|implementation|decision|creative|operations","difficulty":"trivial|easy|moderate|hard|complex","requiresExternalFacts":false,"requiredCapabilities":["..."],"candidateAgentIds":["..."],"candidateSkillIds":["..."],"confidence":0.0,"rationale":"...","reportExport":{"scope":"last-answer|conversation","format":"md|docx|tex|pdf","title":"optional"}}.`,
      user: JSON.stringify({ latestUserTurn: input.message.slice(0, 8_000), mode: input.mode, attachments: input.attachments ?? [], conversationContext: (input.conversationContext ?? []).slice(-12).map((message) => ({ ...message, content: message.content.slice(0, 2_000) })), availableAgents: agents, availableSkills: skills, currentSessionGraph: graph }),
    });
    const router = requireAttachmentCapabilities(enforceExplicitReportExport(
      normalizeRouter(routerAgentDecisionSchema.parse(extractJson(routerCompletion.content)) as ChatRouteDecision['router']),
      input,
    ), input);
    validateRouter(router, input, agentIds, skillIds);
    const schedulerCompletion = await model.complete({
      signal, responseFormat: 'json', temperature: 0, maxTokens: 1_800,
      system: `You are the Scheduler Agent for a production multi-Agent runtime. Do not answer and do not change Router intent.
Use only Router candidate IDs. Activate only Agents useful this turn; do not run every Agent already in the Graph. skippedAgentIds lists prior unused Agent roles. appendAgentIds lists genuinely new active roles.
For non-task specialist intents, always return direct with that one specialist and no steps. For tasks: direct has no steps; single-agent exactly 1; team 2-3; full-workflow normally has 3-8 dependency-aware steps and is reserved for hard/complex work with justified dependencies. A small implementation plus review is team, not full-workflow. executionWaves contains dependency-ready step IDs. Every active Agent must own a step. Dependencies must form a DAG. synthesisAgentId must be synthesizer.
For attachment tasks, schedule each required attachment analysis capability. Make reasoning or delivery that uses those attachments depend on the relevant analysis steps. Preserve this turn's goal; do not restart unrelated Agents from earlier turns.
Return JSON only: {"route":"direct|single-agent|team|full-workflow","activeAgentIds":["..."],"skippedAgentIds":["..."],"appendAgentIds":["..."],"selectedSkillIds":["..."],"executionWaves":[["step-id"]],"steps":[{"id":"...","title":"...","agentId":"...","objective":"...","dependsOn":[],"skillIds":[]}],"requiresReview":false,"synthesisAgentId":"synthesizer","reason":"..."}.`,
      user: JSON.stringify({ latestUserTurn: input.message.slice(0, 8_000), mode: input.mode, routerDecision: router, candidateAgents: agents.filter((agent) => router.candidateAgentIds.includes(agent.id)), candidateSkills: skills.filter((skill) => router.candidateSkillIds.includes(skill.id)), currentSessionGraph: graph }),
    });
    const scheduler = validateScheduler(schedulerAgentDecisionSchema.parse(withSystemSynthesizer(extractJson(schedulerCompletion.content))), router, input, agentIds, skillIds);
    const execution = router.intent === 'task' && scheduler.route !== 'direct' ? 'workflow' : 'gateway';
    return chatRouteDecisionSchema.parse({
      intent: router.intent, execution, agentRole: execution === 'workflow' ? 'orchestrator' : scheduler.activeAgentIds[0], workflowRoute: scheduler.route,
      requiresSearch: router.requiresExternalFacts
        || router.candidateAgentIds.some((id) => ['search-agent', 'academic-search-agent', 'github-research-agent'].includes(id)),
      reason: scheduler.reason, source: 'router-agent', skillIds: scheduler.selectedSkillIds,
      routingVersion, routerModel: model.model, ...(router.reportExport ? { reportExport: router.reportExport } : {}), router, scheduler,
    }) as ChatRouteDecision;
  } catch (error) {
    input.onFallback?.(error);
    return deterministicFallback();
  }
};

const difficultyScore: Record<TaskDifficulty, number> = { trivial: 0, easy: 1, moderate: 2, hard: 4, complex: 6 };
const specialists = new Set(['search-agent', 'academic-search-agent', 'github-research-agent', 'drawing-agent', 'video-agent', 'vision-agent', 'document-agent']);
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
// A generation request is still one specialist, but its external write must
// use the durable execution ledger instead of a connection-bound gateway.
export const durableMediaRoute = (decision: ChatRouteDecision, objective = ''): ChatRouteDecision => {
  if (!['image-generation', 'video-generation'].includes(decision.intent)) return decision;
  const role = decision.intent === 'image-generation' ? 'drawing-agent' : 'video-agent';
  const steps: TurnSchedulingStep[] = [{ id: 'media-generation', agentId: role,
    title: role === 'drawing-agent' ? '图像生成' : '视频生成',
    objective: objective || '完成用户请求的生成或编辑，返回实际服务产物。', dependsOn: [], skillIds: decision.skillIds }];
  return { ...decision, execution: 'workflow', workflowRoute: 'single-agent', agentRole: role,
    scheduler: { ...decision.scheduler, route: 'single-agent', activeAgentIds: [role], steps,
      executionWaves: [['media-generation']], requiresReview: false } };
};

export const workflowPlanFromChatRoute = (inputDecision: ChatRouteDecision): WorkflowPlan | undefined => {
  const decision = durableMediaRoute(inputDecision);
  if (decision.execution !== 'workflow') return undefined;
  const profile: TaskProfile = {
    kind: decision.router.taskKind, difficulty: decision.router.difficulty, route: decision.scheduler.route, score: difficultyScore[decision.router.difficulty],
    reasons: [decision.router.rationale, decision.scheduler.reason], maxSteps: decision.scheduler.steps.length, requiresReview: decision.scheduler.requiresReview,
  };
  const steps: WorkflowStep[] = decision.scheduler.steps.map((step) => {
    const reportWritingStep = decision.router.taskKind === 'research'
      && step.agentId === 'builder'
      && /(?:报告|report)/i.test(`${step.title} ${step.objective}`);
    return {
      id: step.id, title: step.title, role: step.agentId, objective: step.objective, dependsOn: step.dependsOn,
      acceptanceCriteria: reportWritingStep
        ? ['完整覆盖用户明确要求的研究维度，不以摘要代替正文。', '关键技术、成熟度、案例、成本和落地策略均有证据或明确的不确定性说明。']
        : [`完成“${step.title}”并给出可验证的结果。`],
      skillIds: reportWritingStep ? unique([...step.skillIds.filter((id) => id !== 'implementation'), 'report-authoring']) : step.skillIds,
      maxTokens: step.agentId === 'reviewer' || reportWritingStep ? 8_192 : 6_144,
      maxDurationMs: step.agentId === 'drawing-agent' ? 600_000 : step.agentId === 'video-agent' ? 900_000 : 120_000,
      failureStrategy: 'retry',
      ...(specialists.has(step.agentId) || reportWritingStep ? { agentContract: { source: 'builtin' as const, agentId: step.agentId, displayName: step.title, toolAllowlist: [] } } : {}),
    };
  });
  return {
    summary: `调度 Agent 已为本轮选择 ${steps.length} 个执行步骤。`, routingReason: decision.reason, steps, profile, graph: graphForSteps(steps), version: 1,
    approvalStatus: 'approved', approvedAt: new Date().toISOString(), approvedBy: 'router-scheduler-control-plane', routingDecision: decision.router,
    schedulingDecision: decision.scheduler, routingVersion: decision.routingVersion, routerModel: decision.routerModel, routerConfidence: decision.router.confidence,
  };
};
