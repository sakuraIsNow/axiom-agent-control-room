const kindLabels: Record<string, string> = {
  conversation: '对话',
  question: '问答',
  implementation: '实现任务',
  research: '研究任务',
  decision: '决策任务',
  operations: '运维任务',
  creative: '创作任务',
  task: '任务',
};

const difficultyLabels: Record<string, string> = {
  trivial: '简易',
  easy: '简单',
  moderate: '中等',
  hard: '较难',
  complex: '复杂',
};

const routeLabels: Record<string, string> = {
  direct: '直接响应',
  'single-agent': '单智能体',
  team: '小组协作',
  'full-workflow': '完整工作流',
  workflow: '工作流',
  analyze: '分析',
  build: '构建',
  decide: '决策',
};

const reasonLabels: Record<string, string> = {
  'longer context': '上下文较长',
  'large input': '输入内容较多',
  'multiple constraints': '包含多项约束',
  'explicit decision comparison': '需要明确比较和决策',
  'system-level scope': '涉及系统级范围',
  'operational constraints': '包含运行与交付约束',
  'high-impact domain': '属于高影响领域',
  'execution surface': '包含实际执行内容',
  'build mode': '采用构建模式',
  'short self-contained request': '请求简短且边界清晰',
};

const stageLabels: Record<string, string> = {
  unknown: '未知阶段',
  queued: '等待执行',
  planning: '任务规划',
  planner: '任务规划',
  'plan approval': '计划审批',
  running: '任务执行',
  review: '质量审查',
  reviewer: '质量审查',
  reviewing: '质量审查',
  'human review': '人工审核',
  waiting_for_human: '人工审核',
  paused: '已暂停',
  synthesizer: '结果汇总',
  completed: '已完成',
  failed: '执行失败',
  cancelled: '已取消',
  'tool execution': '工具执行',
  'direct-response': '直接响应',
  'quality-gate': '质量门禁',
  'focused task agent': '专注执行 Agent',
};

const runtimeTextLabels = new Map<string, string>([
  ['Conversation route does not require evidence-tree review.', '对话路由不需要执行证据树审查。'],
  ['Triage selected a team route; the full evidence quality gate was not required.', '任务分类选择了小组协作，无需进入完整证据质量门禁。'],
  ['Triage selected a focused single-agent route; evidence-tree review was not required.', '任务分类选择了单智能体路由，无需执行证据树审查。'],
  ['The triage profile selected one focused agent.', '任务分类选择了单智能体专注执行。'],
  ['Reviewer returned an unstructured response; manual verification is required.', '审查员返回了非结构化结果，需要人工核验。'],
  ['Structured reviewer output was unavailable.', '没有取得结构化审查结果。'],
  ['Parallel agent outputs require review.', '并行 Agent 输出需要进一步审查。'],
  ['Step token budget was constrained.', '步骤 Token 预算已受到限制。'],
  ['Evidence tree lacks concrete artifacts for steps 1-5 (e.g., actual plan, research report, analysis report, draft deliverable, review report)', '步骤 1 至 5 的证据树缺少具体产物，例如实际计划、研究报告、分析报告、交付草稿和审查报告。'],
  ['Step 6 and 7 claim implementation but no code snippets or test results are provided', '步骤 6 和 7 声称已完成实现，但没有提供代码片段或测试结果。'],
  ['Step 8 review output is vague and lacks specific test results and code quality report details', '步骤 8 的审查结果过于笼统，缺少具体测试结果和代码质量报告细节。'],
  ['Recovery loop mechanism is designed but not demonstrated with a working example or test', '恢复循环机制已有设计，但没有通过可运行示例或测试进行证明。'],
  ['Quality gates and acceptance evidence mechanisms are designed but not fully implemented or verified', '质量门禁和验收证据机制已有设计，但尚未完整实现或验证。'],
  ['No evidence of actual execution or test logs for the pipeline', '没有提供该工作流真实执行或测试日志的证据。'],
  ['Acceptance criteria mapping is claimed but not shown in detail', '任务声称已建立验收标准映射，但没有展示具体明细。'],
  ['Provide concrete evidence artifacts for each step, such as actual plan JSON, research report, analysis report, draft deliverable, review report, and final response', '为每个步骤提供具体证据产物，例如实际计划 JSON、研究报告、分析报告、交付草稿、审查报告和最终答复。'],
  ['Include code snippets or repository links for the core framework and agent modules, with unit and integration test results', '提供核心框架和 Agent 模块的代码片段或仓库链接，并附上单元测试与集成测试结果。'],
  ['Add detailed test reports showing pass/fail for normal and failure scenarios, including recovery loop tests', '补充详细测试报告，展示正常与异常场景的通过/失败结果，并包含恢复循环测试。'],
  ['Provide a code quality review report with specific findings and improvements', '提供代码质量审查报告，列出具体发现和改进项。'],
  ['Demonstrate the recovery loop with a concrete example, including state persistence, retry, and checkpoint restoration', '使用具体示例证明恢复循环，包括状态持久化、重试和检查点恢复。'],
  ['Show evidence of quality gate enforcement with actual gate check results and failure handling', '提供质量门禁真实执行的证据，包括门禁检查结果和失败处理。'],
  ['Provide a detailed acceptance criteria mapping linking each criterion to specific evidence files and test results', '提供详细的验收标准映射，将每项标准关联到具体证据文件和测试结果。'],
  ['The plan and evidence tree cover the required multi-agent service design with roles, collaboration, recovery loop, quality gates, and acceptance evidence. However, there are significant gaps: the evidence tree lacks concrete artifacts for most steps (e.g., actual code, test reports, logs), and the reviewer step\'s evidence is vague. The recovery loop design is described but not demonstrated with executable code or tests. The quality gates and evidence mechanisms are designed but not fully implemented or verified. The final review correction claims evidence but does not provide actual files or detailed results. Overall, the design is plausible but not sufficiently backed by executable evidence to meet production-grade standards. Human approval: Approved by operator despite the automated quality gate.', '计划和证据树覆盖了多 Agent 服务所需的角色、协作、恢复循环、质量门禁和验收证据，但仍有明显缺口：多数步骤缺少实际代码、测试报告和日志等具体产物，审查步骤的证据也较为笼统。恢复循环、质量门禁和证据机制尚未通过可执行代码或测试充分验证，因此当前设计尚缺少达到生产级标准所需的执行证据。人工审核：操作员已批准当前结果。'],
]);

export const taskKindLabel = (value?: string | null) => kindLabels[value ?? ''] ?? '任务';
export const taskDifficultyLabel = (value?: string | null) => difficultyLabels[value ?? ''] ?? '未分类';
export const taskRouteLabel = (value?: string | null) => routeLabels[value ?? ''] ?? '自定义路由';
export const taskReasonLabel = (value: string) => reasonLabels[value] ?? localizeRuntimeText(value);

export const taskStageLabel = (value?: string | null) => {
  const normalized = value?.trim().toLowerCase() ?? '';
  if (!normalized) return '暂无阶段';
  if (normalized.startsWith('tool:')) return `工具：${value!.slice(value!.indexOf(':') + 1).trim()}`;
  return stageLabels[normalized] ?? localizeRuntimeText(value!);
};

export const localizeRuntimeText = (value: string) => {
  const normalized = value.trim();
  const exact = runtimeTextLabels.get(normalized);
  if (exact) return exact;
  const scoreCorrection = normalized.match(/^Raise the evidence-backed quality score from (\d+) to at least (\d+)\.$/u);
  if (scoreCorrection) return `将有证据支持的质量评分从 ${scoreCorrection[1]} 提升到至少 ${scoreCorrection[2]}。`;
  return value;
};

export const customAgentKindLabel = (value: string) => ({ worker: '执行型', quality: '质量型', output: '输出型' })[value] ?? value;
export const publicationStatusLabel = (value: string) => ({ draft: '草稿', published: '已发布', archived: '已归档' })[value] ?? value;
export const readinessStateLabel = (value: string) => ({ ready: '就绪', degraded: '需关注', blocked: '已阻断' })[value] ?? value;
