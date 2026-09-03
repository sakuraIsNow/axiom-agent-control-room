import type { WorkflowTemplateDefinition } from './contracts.js';

export type BuiltInTemplate = {
  id: string;
  name: string;
  description: string;
  definition: WorkflowTemplateDefinition;
};

const policy = (overrides: Partial<WorkflowTemplateDefinition['policy']> = {}): WorkflowTemplateDefinition['policy'] => ({
  requirePlanApproval: false,
  maxTokens: 50_000,
  maxCostUsd: 2,
  maxDurationMs: 15 * 60_000,
  maxConcurrentSteps: 3,
  ...overrides,
});

export const builtInTemplates: BuiltInTemplate[] = [
  {
    id: 'industry-news', name: '行业资讯', description: '按时间与主题收集行业动态，去重并形成可追溯简报。',
    definition: { mode: 'analyze', policy: policy(), agentIds: ['web-search-agent', 'analyst', 'reviewer'], toolNames: [], promptPrefix: '输入需要包含行业、关注主题与时间范围。流程为检索、来源去重、事件归类、影响分析和审查。验收要求每项关键动态带来源与发布时间，未知信息明确标注。交付为对话摘要与可导出简报。' },
  },
  {
    id: 'paper-research', name: '论文调研', description: '检索论文、复核方法与证据，形成有引用边界的综述。',
    definition: { mode: 'analyze', policy: policy({ maxConcurrentSteps: 3 }), agentIds: ['academic-search-agent', 'researcher', 'analyst', 'reviewer'], toolNames: [], promptPrefix: '输入需要包含研究问题、范围、年份和纳入标准。流程为论文检索、筛选、方法评估、结论对照与审查。验收要求引用可定位、区分论文结论和模型推断。交付为结构化综述与参考文献。' },
  },
  {
    id: 'github-evaluation', name: 'GitHub 项目评估', description: '核查仓库架构、维护活跃度、风险与接入成本。',
    definition: { mode: 'decide', policy: policy(), agentIds: ['web-search-agent', 'researcher', 'analyst', 'reviewer'], toolNames: ['workspace.search', 'workspace.read'], promptPrefix: '输入需要包含仓库地址、使用目标和技术约束。流程为仓库事实核查、架构分析、维护风险、许可证与接入评估。验收要求所有仓库事实可追溯，不把 README 宣传语当成已验证能力。交付为采用建议和验证清单。' },
  },
  {
    id: 'competitor-research', name: '竞品研究', description: '比较能力、体验、价格和可验证差异。',
    definition: { mode: 'decide', policy: policy(), agentIds: ['web-search-agent', 'researcher', 'analyst', 'reviewer'], toolNames: [], promptPrefix: '输入需要包含竞品范围、目标用户与比较维度。流程为来源收集、同口径对照、差异分析和审查。验收要求价格与功能标明查询时间，推断与事实分开。交付为对比表、结论与待验证项。' },
  },
  {
    id: 'requirements-analysis', name: '需求分析', description: '把目标和想法整理成可验收、可实施的产品需求。',
    definition: { mode: 'build', policy: policy(), agentIds: ['analyst', 'builder', 'reviewer'], toolNames: [], promptPrefix: '输入需要包含目标、用户、场景和限制。流程为范围澄清、角色与流程建模、边界识别、优先级和验收设计。验收要求每项需求可测试且不混淆方案与目标。交付为需求文档、验收标准和开放问题。' },
  },
  {
    id: 'data-report', name: '数据报告', description: '校验口径、分析指标和异常，形成可交付报告。',
    definition: { mode: 'analyze', policy: policy(), agentIds: ['researcher', 'analyst', 'reviewer'], toolNames: ['table.read', 'document.read'], promptPrefix: '输入需要包含数据、指标口径和业务问题。流程为数据质量检查、统计分析、异常核查与审查。验收要求计算口径透明、缺失值和限制明确。交付为结论、表格和可导出报告。' },
  },
  {
    id: 'marketing-content', name: '营销素材', description: '基于受众与已验证卖点生成多渠道素材。',
    definition: { mode: 'build', policy: policy(), agentIds: ['analyst', 'builder', 'reviewer'], toolNames: [], promptPrefix: '输入需要包含受众、渠道、品牌语气和可使用事实。流程为受众分析、角度设计、多版本生成与事实复核。验收要求不虚构能力，不越过品牌和合规边界。交付为分渠道素材与修改建议。' },
  },
  {
    id: 'work-summary', name: '工作总结', description: '从真实记录提炼完成项、影响、风险和下一步。',
    definition: { mode: 'analyze', policy: policy(), agentIds: ['researcher', 'analyst', 'reviewer'], toolNames: ['document.read'], promptPrefix: '输入需要包含工作记录与统计周期。流程为事实提取、成果归并、影响与风险分析、遗漏检查。验收要求不把计划写成已完成，数字保持原口径。交付为精简总结和下一步清单。' },
  },
  {
    id: 'document-review', name: '文档审查', description: '检查结构、一致性、证据、遗漏和可读性。',
    definition: { mode: 'analyze', policy: policy(), agentIds: ['researcher', 'analyst', 'reviewer'], toolNames: ['document.read'], promptPrefix: '输入需要包含文档与审查目标。流程为结构检查、声明与证据对应、一致性和可读性审查。验收要求问题可定位并给出可操作修改。交付为按严重度排序的问题与修订建议。' },
  },
  {
    id: 'plugin-builder', name: '插件生成', description: '定义交互、Agent、工具权限与验收，生成可审核插件。',
    definition: { mode: 'build', policy: policy({ requirePlanApproval: true }), agentIds: ['analyst', 'builder', 'reviewer'], toolNames: ['agent.propose'], promptPrefix: '输入需要包含插件目标、窗口形态、输入输出和需要的 Agent 能力。流程为交互定义、最小权限设计、实现、测试与发布检查。验收要求插件可运行、权限透明、失败诚实。交付为插件草稿、测试说明和发布建议。' },
  },
  {
    id: 'code-review',
    name: '代码审查',
    description: '并行收集变更上下文、分析风险，再经过质量门禁输出可执行审查意见。',
    definition: {
      mode: 'build',
      policy: policy({ requirePlanApproval: true }),
      agentIds: ['researcher', 'analyst', 'reviewer'],
      toolNames: ['workspace.git-status', 'workspace.search', 'workspace.read', 'workspace.test'],
      promptPrefix: '请以代码审查为目标，区分已验证事实、风险判断和待补证据；最后给出可执行的修正与测试建议。',
    },
  },
  {
    id: 'architecture-evaluation',
    name: '架构评估',
    description: '比较架构方案、识别生产风险、明确成本与恢复权衡，并保留验证标准。',
    definition: {
      mode: 'decide',
      policy: policy({ maxTokens: 40_000, maxCostUsd: 1.5 }),
      agentIds: ['researcher', 'analyst', 'reviewer'],
      toolNames: ['workspace.search', 'workspace.read'],
      promptPrefix: '请围绕架构决策输出方案比较、约束、风险、成本、恢复策略和验收标准；不要把比较问题升级成代码实现。',
    },
  },
  {
    id: 'incident-analysis',
    name: '故障分析',
    description: '重建故障时间线，区分事实与假设，生成缓解、恢复和防复发动作。',
    definition: {
      mode: 'analyze',
      policy: policy({ requirePlanApproval: true, maxDurationMs: 20 * 60_000 }),
      agentIds: ['researcher', 'analyst', 'builder', 'reviewer'],
      toolNames: ['workspace.search', 'workspace.read', 'workspace.test'],
      promptPrefix: '请先建立故障时间线和证据清单，再分析根因与影响，最后给出按优先级排序的恢复和防复发步骤。',
    },
  },
  {
    id: 'research-report',
    name: '研究报告',
    description: '收集边界明确的证据，分析观点和不确定性，形成带引用范围的研究结论。',
    definition: {
      mode: 'analyze',
      policy: policy({ maxTokens: 60_000, maxCostUsd: 3, maxConcurrentSteps: 2 }),
      agentIds: ['researcher', 'analyst', 'reviewer'],
      toolNames: ['workspace.search', 'workspace.read'],
      promptPrefix: '请明确研究范围、证据来源、假设和不确定性；结论必须与证据边界一致，并给出后续验证建议。',
    },
  },
];

export const getBuiltInTemplate = (id: string) => builtInTemplates.find((template) => template.id === id) ?? null;
