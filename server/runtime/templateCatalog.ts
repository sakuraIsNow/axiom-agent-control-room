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
