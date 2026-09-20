import { routeSkillIds } from '../runtime/skillCatalog.js';

export type ReportExportDecision = { scope: 'last-answer' | 'conversation'; format: 'md' | 'docx' | 'tex' | 'pdf'; title?: string };
export type ChatIntent = 'conversation' | 'agent-registry' | 'web-search' | 'academic-search' | 'github-research' | 'image-generation' | 'video-generation' | 'image-analysis' | 'document-analysis' | 'report-export' | 'task';
type TaskRoute = 'direct' | 'single-agent' | 'team' | 'full-workflow';
type SchedulingStep = { id: string; title: string; agentId: string; objective: string; dependsOn: string[]; skillIds: string[] };
export type ChatRouteDecision = {
  intent: ChatIntent;
  execution: 'gateway' | 'workflow';
  agentRole: string;
  workflowRoute: TaskRoute;
  requiresSearch: boolean;
  reason: string;
  source: 'router-agent' | 'semantic-model' | 'deterministic-fallback';
  skillIds: string[];
  routingVersion: string;
  routerModel?: string;
  reportExport?: ReportExportDecision;
  router: {
    intent: ChatIntent;
    taskKind: 'conversation' | 'question' | 'research' | 'implementation' | 'decision' | 'creative' | 'operations';
    difficulty: 'trivial' | 'easy' | 'moderate' | 'hard' | 'complex';
    requiresExternalFacts: boolean;
    requiredCapabilities: string[];
    candidateAgentIds: string[];
    candidateSkillIds: string[];
    confidence: number;
    rationale: string;
    reportExport?: ReportExportDecision;
  };
  scheduler: {
    route: TaskRoute;
    activeAgentIds: string[];
    skippedAgentIds: string[];
    appendAgentIds: string[];
    selectedSkillIds: string[];
    executionWaves: string[][];
    steps: SchedulingStep[];
    requiresReview: boolean;
    synthesisAgentId: string;
    reason: string;
  };
};
export type FallbackRouteInput = {
  message: string;
  mode: 'analyze' | 'build' | 'decide';
  attachments?: Array<{ name?: string; mimeType?: string; kind?: string }>;
  currentGraph?: { nodes: Array<{ role?: string }> } | null;
};

const unique = (values: string[]) => [...new Set(values)];
export const intentAgent: Record<Exclude<ChatIntent, 'task'>, string> = {
  conversation: 'direct-responder', 'agent-registry': 'registry-agent', 'web-search': 'search-agent',
  'academic-search': 'academic-search-agent', 'github-research': 'github-research-agent',
  'image-generation': 'drawing-agent', 'video-generation': 'video-agent', 'image-analysis': 'vision-agent',
  'document-analysis': 'document-agent', 'report-export': 'report-agent',
};

export const attachmentRequirements = (input: Pick<FallbackRouteInput, 'attachments'>) => {
  const isImage = (item: NonNullable<FallbackRouteInput['attachments']>[number]) => item.kind === 'image'
    || Boolean(item.mimeType?.startsWith('image/')) || /\.(png|jpe?g|webp|gif|bmp|tiff?)$/i.test(item.name ?? '');
  return [
    ...((input.attachments ?? []).some(isImage) ? [{ capability: 'image-analysis', agentId: 'vision-agent' }] : []),
    ...((input.attachments ?? []).some((item) => !isImage(item)) ? [{ capability: 'document-analysis', agentId: 'document-agent' }] : []),
  ];
};

export const schedulingWaves = (steps: SchedulingStep[]) => {
  const remaining = new Map(steps.map((step) => [step.id, step]));
  const completed = new Set<string>();
  const waves: string[][] = [];
  while (remaining.size) {
    const ready = [...remaining.values()].filter((step) => step.dependsOn.every((id) => completed.has(id)));
    if (!ready.length) throw new Error('Schedule contains unresolved or cyclic dependencies.');
    waves.push(ready.map((step) => step.id));
    ready.forEach((step) => { remaining.delete(step.id); completed.add(step.id); });
  }
  return waves;
};

const exportDecision = (text: string): ReportExportDecision | undefined => {
  const explicit = /(?:导出|下载|另存为|保存为|输出为).{0,30}(?:以上|上述|回答|内容|对话|会话|聊天|报告|文档|文件|markdown|md|word|docx|latex|tex|pdf)|(?:把|将).{0,30}(?:以上|上述|回答|内容|对话|会话|聊天).{0,20}(?:导出|下载|另存|保存|生成).{0,15}(?:报告|文档|文件|markdown|md|word|docx|latex|tex|pdf)|(?:生成|制作).{0,8}(?:word|docx|latex|tex|pdf|markdown|md)(?:格式)?(?:报告|文档|文件)|\b(?:export|download|save as)\b.{0,40}\b(?:answer|conversation|chat|report|document|file|markdown|word|docx|latex|pdf)\b/i.test(text);
  if (!explicit) return undefined;
  const format = /(?:latex|\.tex\b|tex\s*格式)/i.test(text) ? 'tex'
    : /(?:markdown|\.md\b|md\s*格式)/i.test(text) ? 'md' : /pdf/i.test(text) ? 'pdf' : 'docx';
  const scope = /(?:完整|全部|整个|整段|全量).{0,12}(?:对话|会话|聊天|历史)|(?:对话|会话|聊天|历史).{0,12}(?:完整|全部|整个|全量)|(?:full|entire|all).{0,12}(?:conversation|chat|history)/i.test(text) ? 'conversation' : 'last-answer';
  return { format, scope };
};

/** A narrow negative permission guard, not a semantic task classifier. The
 * current turn can prohibit another retrieval even if the previous Graph used
 * search. Keep this shared by browser fallback and server-side validation. */
export const explicitlyDisablesRetrieval = (text: string): boolean => {
  // Quoted phrases/code are reference data, not the user's instruction. Keep
  // apostrophes inside words (don't) intact when stripping single-quoted topics.
  // Retain an inert placeholder: deleting a quoted object entirely would turn
  // "don't search for 'weather'" into an apparent global prohibition.
  const instruction = text.replace(/```[\s\S]*?```|`[^`\r\n]*`|“[^”]*”|「[^」]*」|『[^』]*』|‘[^’]*’|"[^"\r\n]*"/g, ' [quoted] ')
    .replace(/(?<![A-Za-z0-9])'[^'\r\n]*'(?![A-Za-z0-9])/g, ' [quoted] ');
  const clauses = instruction.split(/[，。；！？,;.!?\r\n]+/).map((clause) => clause.trim()).filter(Boolean);
  const globalProhibition = (clause: string) =>
    /^(?:(?:请你|本轮|这轮|这次|此次|现在|接下来|请|先|也)\s*)*(?:不要|无需|不再|不用|不必|禁止|停止)(?:\s*(?:再次|再|重新|继续|进行|任何|额外))*\s*(?:联网(?:搜索|检索|查询)?|上网(?:搜索|检索|查询)?|搜索|检索|查找|查询)(?:了|吧|即可|就行)?$/i.test(clause)
    || /^(?:please\s+)?(?:do\s+not|don['’]t|no\s+longer|no\s+need\s+to|without|stop|avoid|no)\s+(?:(?:any|further|additional|new|another|online|web)\s+)*(?:re[- ]?)?(?:search(?:ing)?|brows(?:e|ing)|retriev(?:e|ing|al)|look(?:ing)?\s+up)(?:\s+(?:again|anymore|at\s+all|the\s+web|online|externally))*$/i.test(clause);
  if (!clauses.some(globalProhibition)) return false;
  // Do not resolve a local prohibition or a later countermand using a regex.
  // A separate affirmative retrieval instruction leaves the decision to Router.
  const affirmativeRetrieval = (clause: string) =>
    /^(?:(?:但是|不过|改为|改成|而是|然后|现在|帮我|还是|需要|但|只|仅|请|再)\s*)*(?:联网|上网)?(?:搜索|检索|查询|查找|查一下|搜一下)\s*\S/i.test(clause)
    || /^(?:(?:but|instead|only|please|now|then|still|just|rather)\s+)*(?:search|browse|retrieve|look\s+up)\b/i.test(clause);
  return !clauses.some((clause) => !globalProhibition(clause) && affirmativeRetrieval(clause));
};

/** Evidence inputs and requested outputs are additive, and only this turn supplies requirements. */
const requirementsFor = (text: string) => {
  const comparison = /(?:比较|对比|权衡|取舍|选型|决策|评估|\b(?:compare|comparison|trade.?offs?|recommend|decide|evaluate)\b)/i.test(text);
  const analysis = /(?:分析|设计|规划|制定|方案|\b(?:analy[sz]e|analysis|design|plan|architect)\b)/i.test(text);
  const verification = /(?:验证|核验|复核|验收|审核|审查|\b(?:verify|validate|verification|review|test)\b)/i.test(text);
  // Deployment mentioned as a comparison dimension is not an instruction to deploy.
  const implementation = /(?:实现|开发|编写|修复|搭建|\b(?:implement|develop|build|fix|write code)\b)/i.test(text)
    || !comparison && /(?:部署|\bdeploy\b)/i.test(text);
  const authoring = /(?:写|撰写|生成|整理).{0,15}(?:报告|方案|计划)|\b(?:write|draft|produce)\b.{0,25}\b(?:report|proposal|plan)\b/i.test(text);
  const systemDesign = analysis && /(?:平台|系统|架构|服务|数据流|\b(?:platform|system|architecture|service)\b)/i.test(text);
  const roleCount = [/(?:搜索|研究|检索|search|research(?:er)?)\s*agent/i, /(?:架构|分析|方案|analyst|architect(?:ure)?)\s*agent/i, /(?:数据库|数据|database|db)\s*agent/i, /(?:实现|开发|builder|developer)\s*agent/i, /(?:审查|审核|reviewer|review)\b/i].filter((pattern) => pattern.test(text)).length;
  const explicitWorkflow = roleCount >= 2 && /(?:先由|再由|最后由|工作流|协作|first|then|finally|->)/i.test(text);
  const noRetrieval = explicitlyDisablesRetrieval(text);
  const retrieval: Exclude<ChatIntent, 'task'> | undefined = noRetrieval ? undefined : /(?:论文|文献|期刊|学术|\b(?:arxiv|doi|papers?|literature|academic|journal)\b)/i.test(text) ? 'academic-search'
    : /(?:github|开源仓库|代码仓库|\b(?:repository|repo)\b)|(?:开源|open[ -]?source).{0,30}(?:agent|智能体|项目|框架|工具|仓库)/i.test(text) ? 'github-research'
      : /(?:天气|气温|预报|新闻|价格|股价|汇率|联网|上网|搜索|检索|查找|网页|最新|目前|现在|今天|实时|官方资料|\b(?:search|weather|forecast|news|price|current|latest|today|internet|official sources)\b)/i.test(text) ? 'web-search' : undefined;
  return { comparison, analysis, verification, implementation, authoring, systemDesign, explicitWorkflow, retrieval,
    hasDeliverable: comparison || analysis || verification || implementation || authoring || explicitWorkflow };
};

/** Used only when routing is unavailable or invalid; healthy model plans remain authoritative. */
export const fallbackChatRoute = (input: FallbackRouteInput): ChatRouteDecision => {
  const text = input.message.trim();
  const requirements = requirementsFor(text);
  const attachments = attachmentRequirements(input);
  const reportExport = exportDecision(text);
  const conversation = /^(?:你在吗|在吗|你好|您好|嗨|谢谢|感谢|再见|hi|hello|hey|thanks|thank you|bye)[？?！!。,\.\s]*$/i.test(text);
  const registry = /(?:有哪些|哪几个|列出|查看|介绍|可用).{0,20}(?:agent|智能体|子智能体)|(?:agent|agents).{0,20}(?:available|list|registry|catalog)|available.{0,20}agents?/i.test(text)
    || /(?:你有.{0,24}(?:能力|功能)(?:吗|么)?|你(?:能|可以|会)(?:进行|使用|调用)?.{0,20}(?:吗|么)|你(?:支持|提供)(?:联网搜索|搜索|图片识别|视觉分析|文档分析|绘图|视频生成|工具)|有哪些能力|支持哪些功能)/i.test(text);
  const video = /(?:生成|制作|创建|剪辑|合成).{0,18}(?:视频|短片|动画|影片)|(?:generate|create|make|edit).{0,18}(?:video|movie|clip|animation)/i.test(text);
  const image = /(?:生成|绘制|画|制作|设计|编辑|修改).{0,16}(?:图片|图像|海报|插画|封面)|(?:draw|generate|create|edit).{0,16}(?:image|picture|poster|illustration)/i.test(text);
  // Reading or summarizing an attachment alone is still one specialist operation.
  const attachmentOnly = attachments.length > 0 && !requirements.comparison && !requirements.implementation
    && !requirements.verification && !requirements.authoring && !requirements.systemDesign && !requirements.retrieval
    && !/(?:设计|规划|制定|方案|\b(?:design|plan|architect)\b)/i.test(text);
  let intent: ChatIntent = 'task';
  if (reportExport) intent = 'report-export';
  else if (registry) intent = 'agent-registry';
  else if (video) intent = 'video-generation';
  else if (image) intent = 'image-generation';
  else if (conversation && !attachments.length) intent = 'conversation';
  else if (attachmentOnly && attachments.length === 1) intent = attachments[0]!.capability as ChatIntent;
  else if (!attachments.length && requirements.retrieval && !requirements.hasDeliverable) intent = requirements.retrieval;

  const compositeMedia = ['image-generation', 'video-generation'].includes(intent)
    && (attachments.some((item) => item.agentId === 'document-agent') || requirements.retrieval || requirements.comparison || requirements.verification || requirements.implementation);
  const specialistDelivery = compositeMedia ? intentAgent[intent as Exclude<ChatIntent, 'task'>] : undefined;
  if (compositeMedia) intent = 'task';
  const steps: SchedulingStep[] = [];
  const addStep = (id: string, agentId: string, title: string, objective: string, dependsOn: string[], requestedSkills: string[] = []) => {
    steps.push({ id, agentId, title, objective: `${objective}\nUser request: ${text}`.slice(0, 2_000), dependsOn,
      skillIds: routeSkillIds(text, agentId, requestedSkills).filter((id) => requirements.retrieval || !['web-research', 'github-inspection'].includes(id)) });
  };
  if (intent === 'task') {
    for (const attachment of attachments) {
      addStep(`attachment-${attachment.capability}`, attachment.agentId, attachment.capability === 'image-analysis' ? 'Analyze image attachments' : 'Analyze document attachments',
        'Extract source-backed findings from this turn\'s attachments for dependent work.', [], attachment.capability === 'document-analysis' ? ['document-analysis'] : []);
    }
    if (requirements.retrieval) addStep('research', intentAgent[requirements.retrieval], 'Retrieve supporting evidence',
      'Retrieve relevant sources, preserve URLs and dates, and identify evidence gaps for the requested conclusions.', [], ['web-research', 'evidence-research', ...(requirements.retrieval === 'github-research' ? ['github-inspection'] : [])]);
    const needsAnalysis = !attachmentOnly && (requirements.comparison || requirements.analysis && !specialistDelivery || requirements.authoring || requirements.explicitWorkflow);
    if (!steps.length && (requirements.comparison || requirements.systemDesign || requirements.explicitWorkflow)) {
      addStep('research', 'researcher', 'Establish facts and constraints', 'Identify supplied facts, constraints, assumptions and decision criteria.', [], ['evidence-research']);
    }
    if (needsAnalysis) addStep('analysis', 'analyst', 'Analyze and recommend',
      'Use predecessor evidence to address every requested comparison, risk and decision criterion. Produce the requested recommendation or analysis deliverable, and distinguish supported conclusions from unknowns.', steps.map((step) => step.id), requirements.comparison ? ['quality-review'] : []);
    if (specialistDelivery) addStep('specialist-delivery', specialistDelivery, 'Produce requested media', 'Use attachment findings to produce the requested media.', steps.map((step) => step.id));
    else if (requirements.implementation || requirements.explicitWorkflow) addStep('delivery', 'builder', 'Implement requested changes',
      'Produce only the requested implementation, executable steps and acceptance checks using the predecessor findings.', steps.map((step) => step.id), ['implementation']);
    if (requirements.verification || requirements.explicitWorkflow) addStep('quality-review', 'reviewer', 'Verify the conclusions and delivery',
      'Check the requested conclusions against predecessor evidence and the user\'s acceptance criteria. Report gaps and actual verification results; do not claim unperformed checks passed.', steps.map((step) => step.id), ['quality-review']);
    if (!steps.length && requirements.hasDeliverable) addStep('focused-response', input.mode === 'build' ? 'builder' : 'analyst', 'Complete the requested task', 'Complete the user\'s requested deliverable.', []);
  }
  const route: TaskRoute = steps.length >= 4 ? 'full-workflow' : steps.length >= 2 ? 'team' : steps.length === 1 ? 'single-agent' : 'direct';
  const activeAgentIds = intent === 'task' ? steps.length ? unique(steps.map((step) => step.agentId)) : ['direct-responder'] : [intentAgent[intent]];
  const selectedSkillIds = intent === 'task' ? unique(steps.flatMap((step) => step.skillIds))
    : intent === 'agent-registry' || intent === 'conversation' ? []
      : routeSkillIds(`${intent} ${text}`, activeAgentIds[0]!, ['web-search', 'academic-search', 'github-research'].includes(intent) ? ['web-research', 'evidence-research'] : []);
  const existing = unique((input.currentGraph?.nodes ?? []).map((node) => node.role).filter((role): role is string => Boolean(role) && !['orchestrator', 'synthesizer'].includes(role!)));
  const requiresSearch = intent === 'task' ? Boolean(requirements.retrieval) : ['web-search', 'academic-search', 'github-research'].includes(intent);
  const reason = intent === 'report-export' ? '兜底规则检测到明确的会话报告导出动作。'
    : 'Routing unavailable; preserve this turn\'s required capabilities and dependent deliverables.';
  const taskKind: ChatRouteDecision['router']['taskKind'] = intent === 'conversation' ? 'conversation'
    : intent !== 'task' ? 'question' : requirements.comparison || input.mode === 'decide' ? 'decision'
      : requirements.implementation ? 'implementation' : requirements.retrieval || requirements.authoring ? 'research' : 'question';
  return {
    intent, execution: steps.length ? 'workflow' : 'gateway', agentRole: steps.length ? 'orchestrator' : activeAgentIds[0]!,
    workflowRoute: route, requiresSearch, reason, source: 'deterministic-fallback', skillIds: selectedSkillIds,
    routingVersion: 'router-scheduler/fallback-v3', ...(reportExport ? { reportExport } : {}),
    router: { intent, taskKind, difficulty: route === 'full-workflow' ? 'hard' : route === 'team' ? 'moderate' : route === 'single-agent' ? 'easy' : 'trivial',
      requiresExternalFacts: requiresSearch, requiredCapabilities: unique([...activeAgentIds, ...attachments.map((item) => item.capability)]), candidateAgentIds: activeAgentIds,
      candidateSkillIds: selectedSkillIds, confidence: 0, rationale: reason, ...(reportExport ? { reportExport } : {}) },
    scheduler: { route, activeAgentIds, skippedAgentIds: existing.filter((id) => !activeAgentIds.includes(id)), appendAgentIds: activeAgentIds.filter((id) => !existing.includes(id)),
      selectedSkillIds, executionWaves: schedulingWaves(steps), steps, requiresReview: steps.some((step) => step.agentId === 'reviewer'), synthesisAgentId: 'synthesizer', reason },
  };
};
