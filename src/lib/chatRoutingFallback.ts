import type { AgentGraph, AgentMode, ChatRouteDecision, FileAttachment, ImageAttachment } from '../types';

type Attachment = ImageAttachment | FileAttachment;
const routeVersion = 'router-scheduler/local-fallback-v1';
const hasAny = (value: string, patterns: RegExp[]) => patterns.some((pattern) => pattern.test(value));
const unique = (values: string[]) => [...new Set(values)];

const skillIdsFor = (text: string, roles: string[]) => {
  const skills: string[] = [];
  if (hasAny(text, [/search/i, /latest/i, /current/i, /today/i, /weather/i, /news/i, /联网/, /搜索/, /最新/, /今天/, /天气/, /新闻/, /实时/])) skills.push('web-research', 'evidence-research');
  if (hasAny(text, [/github/i, /repository/i, /repo/i, /开源/, /仓库/, /源码/])) skills.push('github-inspection');
  if (hasAny(text, [/architect/i, /platform/i, /system/i, /api/i, /design/i, /架构/, /平台/, /系统/, /服务/, /接口/, /设计/])) skills.push('architecture-design');
  if (hasAny(text, [/implement/i, /build/i, /fix/i, /code/i, /test/i, /实现/, /开发/, /修复/, /代码/, /测试/, /部署/])) skills.push('implementation');
  if (hasAny(text, [/report/i, /document/i, /markdown/i, /pdf/i, /word/i, /报告/, /文档/, /导出/])) skills.push('document-analysis');
  if (roles.includes('reviewer')) skills.push('quality-review');
  return unique(skills).slice(0, 5);
};

const graphRoles = (graph: AgentGraph | null | undefined) => unique(
  (graph?.nodes ?? []).map((node) => node.role).filter((role): role is string => Boolean(role) && !['orchestrator', 'synthesizer'].includes(role)),
);

const specialist = (intent: ChatRouteDecision['intent']): string => ({
  conversation: 'direct-responder',
  'agent-registry': 'registry-agent',
  'web-search': 'search-agent',
  'academic-search': 'academic-search-agent',
  'github-research': 'github-research-agent',
  'image-generation': 'drawing-agent',
  'video-generation': 'video-agent',
  'image-analysis': 'vision-agent',
  'document-analysis': 'document-agent',
  'report-export': 'report-agent',
  task: 'direct-responder',
}[intent]);

const reportExport = (text: string): ChatRouteDecision['reportExport'] | undefined => {
  if (!/(export|download|save|导出|下载|保存)/i.test(text)) return undefined;
  const format = /(?:\.pdf|\bpdf\b)/i.test(text) ? 'pdf' : /(?:\.tex\b|latex|latex格式)/i.test(text) ? 'tex' : /(?:\.md\b|markdown)/i.test(text) ? 'md' : 'docx';
  const scope = /(?:导出|下载).{0,12}(?:全部|完整|整个|会话|对话|历史)/i.test(text) || /(?:conversation|chat|history).{0,12}(?:export|download)/i.test(text) ? 'conversation' : 'last-answer';
  return { scope, format };
};

const taskRoute = (text: string, mode: AgentMode) => {
  const explicitStages = hasAny(text, [/first.+then/i, /then.+finally/i, /multi.?agent/i, /workflow/i, /loop/i, /先.*再.*最后/, /多智能体/, /工作流/, /流程/, /循环/]);
  const implementation = hasAny(text, [/implement/i, /build/i, /fix/i, /code/i, /实现/, /开发/, /修复/, /代码/, /部署/]);
  const broad = text.length > 80 || hasAny(text, [/compare/i, /analysis/i, /architecture/i, /design/i, /research/i, /比较/, /分析/, /架构/, /设计/, /研究/]);
  if (explicitStages || (broad && implementation)) return 'full-workflow' as const;
  if (broad || mode === 'decide') return 'team' as const;
  return 'single-agent' as const;
};

export const fallbackChatRoute = (input: { message: string; mode: AgentMode; attachments?: Attachment[]; currentGraph?: AgentGraph | null }): ChatRouteDecision => {
  const text = input.message.trim();
  const attachments = input.attachments ?? [];
  const hasImage = attachments.some((attachment) => 'url' in attachment || attachment.mimeType?.startsWith('image/'));
  const hasDocument = attachments.some((attachment) => 'text' in attachment || ('mimeType' in attachment && !attachment.mimeType.startsWith('image/')));
  const exportDecision = reportExport(text);
  const conversation = /^(hi|hello|hey|thanks|thank you|你好|您好|嗨|谢谢|你在吗|在吗)[!！。.?？\s]*$/i.test(text);
  const imageGeneration = hasAny(text, [/generate.+(?:image|picture|poster)/i, /(?:生成|绘制|画|制作|设计).{0,16}(?:图片|图像|海报|插画)/]);
  const videoGeneration = hasAny(text, [/generate.+(?:video|movie|clip)/i, /(?:生成|制作|创建|剪辑).{0,18}(?:视频|短片|动画)/]);
  const academic = hasAny(text, [/paper/i, /doi/i, /arxiv/i, /论文/, /文献/, /学术/]);
  const github = hasAny(text, [/github/i, /repository/i, /repo/i, /仓库/, /开源项目/]);
  const search = hasAny(text, [/search/i, /latest/i, /current/i, /today/i, /weather/i, /news/i, /联网/, /搜索/, /最新/, /今天/, /天气/, /新闻/, /实时/]);
  const registry = hasAny(text, [/available.+agents?/i, /agent.+(?:list|registry|catalog)/i, /有哪些智能体/, /可用.*agent/i, /智能体.*能力/]);

  let intent: ChatRouteDecision['intent'] = 'task';
  if (conversation) intent = 'conversation';
  else if (exportDecision) intent = 'report-export';
  else if (videoGeneration) intent = 'video-generation';
  else if (imageGeneration) intent = 'image-generation';
  else if (hasImage) intent = 'image-analysis';
  else if (hasDocument) intent = 'document-analysis';
  else if (academic) intent = 'academic-search';
  else if (github) intent = 'github-research';
  else if (registry) intent = 'agent-registry';
  else if (search) intent = 'web-search';

  const role = specialist(intent);
  const route = intent === 'task' ? taskRoute(text, input.mode) : 'direct';
  const existing = graphRoles(input.currentGraph);
  const stepRoles = intent === 'task' ? route === 'single-agent' ? [input.mode === 'build' ? 'builder' : 'analyst'] : route === 'team' ? ['researcher', 'analyst'] : ['researcher', 'analyst', 'builder', 'reviewer'] : [role];
  const selectedSkills = intent === 'task' ? skillIdsFor(text, stepRoles) : skillIdsFor(`${intent} ${text}`, [role]);
  const steps = intent === 'task' && route !== 'direct' ? stepRoles.map((stepRole, index) => ({
    id: `fallback-${index + 1}`,
    title: `${stepRole} step`,
    agentId: stepRole,
    objective: text,
    dependsOn: index === 0 ? [] : route === 'full-workflow' && stepRole !== 'reviewer' ? [] : [`fallback-${index}`],
    skillIds: skillIdsFor(text, [stepRole]),
  })) : [];
  const activeAgentIds = intent === 'task' ? unique(stepRoles) : [role];
  const selectedRoute = intent === 'task' ? route : 'direct';
  const scheduler = {
    route: selectedRoute,
    activeAgentIds,
    skippedAgentIds: existing.filter((agentId) => !activeAgentIds.includes(agentId)),
    appendAgentIds: activeAgentIds.filter((agentId) => !existing.includes(agentId)),
    selectedSkillIds: selectedSkills,
    executionWaves: steps.length ? steps.map((step) => [step.id]) : [],
    steps,
    requiresReview: selectedRoute === 'full-workflow',
    synthesisAgentId: 'synthesizer',
    reason: 'Routing service unavailable; a conservative local route keeps this turn executable.',
  } satisfies ChatRouteDecision['scheduler'];
  const requiresExternalFacts = intent === 'web-search' || intent === 'academic-search' || intent === 'github-research' || (intent === 'task' && search);
  const router = {
    intent,
    taskKind: intent === 'conversation' ? 'conversation' : intent === 'task' ? 'question' : 'question',
    difficulty: intent === 'conversation' ? 'trivial' : route === 'full-workflow' ? 'hard' : route === 'team' ? 'moderate' : 'easy',
    requiresExternalFacts,
    requiredCapabilities: activeAgentIds,
    candidateAgentIds: activeAgentIds,
    candidateSkillIds: selectedSkills,
    confidence: 0,
    rationale: 'Local safety fallback selected the smallest route that can handle the request.',
    ...(exportDecision ? { reportExport: exportDecision } : {}),
  } satisfies ChatRouteDecision['router'];
  return {
    intent,
    execution: intent === 'task' && selectedRoute !== 'direct' ? 'workflow' : 'gateway',
    agentRole: intent === 'task' && selectedRoute !== 'direct' ? 'orchestrator' : role,
    workflowRoute: selectedRoute,
    requiresSearch: requiresExternalFacts,
    reason: 'Routing service unavailable; local safety fallback selected a conservative route.',
    source: 'deterministic-fallback',
    skillIds: selectedSkills,
    routingVersion: routeVersion,
    ...(exportDecision ? { reportExport: exportDecision } : {}),
    router,
    scheduler,
  };
};
