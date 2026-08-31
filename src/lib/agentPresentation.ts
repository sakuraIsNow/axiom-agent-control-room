const BUILTIN_AGENT_NAMES: Record<string, string> = {
  orchestrator: '调度器',
  planner: '规划器',
  researcher: '研究员',
  analyst: '分析员',
  builder: '工程师',
  reviewer: '审查员',
  synthesizer: '汇总员',
  'direct-responder': '直接响应',
  'vision-agent': '视觉分析',
  'drawing-agent': '绘图 Agent',
  'video-agent': '视频制作 Agent',
  'search-agent': '联网搜索',
  'weather-agent': '天气核验',
  'academic-search-agent': '论文搜索',
  'github-research-agent': 'GitHub 研究',
  'document-agent': '文档分析',
  'registry-agent': 'Agent 检测',
  'router-agent': '语义路由',
  'scheduler-agent': '调度 Agent',
  agent: '智能体',
};

const hasHanCharacters = (value: string) => /[\u3400-\u9fff]/u.test(value);

/** Keep runtime role ids private while giving the graph a readable Chinese identity. */
export function agentDisplayName(role?: string, fallback?: string) {
  const raw = role?.trim() ?? '';
  const normalized = raw.toLowerCase().replace(/[_\s]+/g, '-');
  const direct = BUILTIN_AGENT_NAMES[normalized];
  if (direct) return direct;
  if (normalized.startsWith('reviewer')) return BUILTIN_AGENT_NAMES.reviewer;
  if (normalized.startsWith('researcher')) return BUILTIN_AGENT_NAMES.researcher;
  if (normalized.startsWith('analyst')) return BUILTIN_AGENT_NAMES.analyst;
  if (normalized.startsWith('builder')) return BUILTIN_AGENT_NAMES.builder;
  if (normalized.startsWith('planner')) return BUILTIN_AGENT_NAMES.planner;
  if (normalized.startsWith('synthesizer')) return BUILTIN_AGENT_NAMES.synthesizer;
  if (hasHanCharacters(raw)) return raw;
  if (fallback && hasHanCharacters(fallback) && fallback.length <= 12) return fallback;
  return BUILTIN_AGENT_NAMES.agent;
}
