export type AgentCatalogEntry = {
  id: string;
  role: string;
  label: string;
  kind: 'orchestrator' | 'worker' | 'quality' | 'output';
  capabilities: string[];
  description: string;
};

/**
 * The model receives a live Agent directory as context, but it can still omit
 * an entry in its natural-language answer. Keep the directory truthful by
 * appending only the entries missing from that answer. The input is deliberately
 * structural so the same guard can be used by the task runtime and chat gateway
 * without coupling either path to the persistence model.
 */
export type LiveAgentDirectoryEntry = {
  id?: string;
  role?: string;
  label?: string;
  roleId?: string;
  name?: string;
  status?: string;
};

const directoryToken = (value: unknown) => String(value ?? '')
  .toLocaleLowerCase('zh-CN')
  .replace(/[\s_./:-]+/g, '')
  .replace(/(?:agents?|智能体)$/i, '')
  .trim();

const directoryAliases = (entry: LiveAgentDirectoryEntry) => [...new Set([
  entry.label,
  entry.name,
  entry.role,
  entry.roleId,
  entry.id,
].map(directoryToken).filter((token) => token.length > 1 && !/^(?:agent|agents|智能体|子智能体)$/i.test(token)))];

const directoryDisplayName = (entry: LiveAgentDirectoryEntry) => String(
  entry.label ?? entry.name ?? entry.role ?? entry.roleId ?? entry.id ?? '未命名 Agent',
).trim();

/**
 * Append a compact, live directory supplement when the model omitted entries.
 * No static role list is used: callers must provide the snapshot observed for
 * this request, and unpublished custom Agents should never be passed in.
 */
export const appendMissingAgentDirectory = (
  content: string,
  entries: readonly LiveAgentDirectoryEntry[],
) => {
  const visibleEntries = entries.filter((entry) => !entry.status || entry.status === 'published');
  const uniqueEntries = visibleEntries.filter((entry, index, all) => {
    const identity = directoryToken(entry.id ?? entry.roleId ?? entry.name ?? entry.label);
    return identity && all.findIndex((candidate) => directoryToken(candidate.id ?? candidate.roleId ?? candidate.name ?? candidate.label) === identity) === index;
  });
  const normalizedContent = directoryToken(content);
  const missing = uniqueEntries.filter((entry) => !directoryAliases(entry).some((alias) => normalizedContent.includes(alias)));
  if (missing.length === 0) return content;

  const maxNames = 24;
  const names = missing.slice(0, maxNames).map(directoryDisplayName);
  const remaining = missing.length - names.length;
  const suffix = `\n\n实时目录补充：${names.join('、')}${remaining > 0 ? `，另有 ${remaining} 个 Agent` : ''}。`;
  return content ? `${content}${suffix}` : suffix.slice(2);
};

export const agentCatalog: AgentCatalogEntry[] = [
  {
    id: 'planner',
    role: 'planner',
    label: '规划器',
    kind: 'orchestrator',
    capabilities: ['decompose', 'route', 'dependency-graph'],
    description: '分析任务类型和难度，生成步骤与依赖关系。',
  },
  {
    id: 'researcher',
    role: 'researcher',
    label: '研究员',
    kind: 'worker',
    capabilities: ['evidence', 'constraints', 'memory-recall'],
    description: '收集资料、事实、约束、假设和可验证证据。',
  },
  {
    id: 'analyst',
    role: 'analyst',
    label: '分析员',
    kind: 'worker',
    capabilities: ['tradeoffs', 'risk-analysis', 'verification'],
    description: '分析方案、权衡、风险、决策标准和验证方式。',
  },
  {
    id: 'builder',
    role: 'builder',
    label: '工程师',
    kind: 'worker',
    capabilities: ['solution-construction', 'repair', 'acceptance-criteria'],
    description: '构建可执行结果、实现方案和审查修正。',
  },
  {
    id: 'reviewer',
    role: 'reviewer',
    label: '审查员',
    kind: 'quality',
    capabilities: ['evidence-validation', 'quality-gate', 'correction-request'],
    description: '检查完整性、一致性、证据质量和可执行性。',
  },
  {
    id: 'synthesizer',
    role: 'synthesizer',
    label: '汇总员',
    kind: 'output',
    capabilities: ['aggregation', 'final-answer', 'uncertainty-preservation'],
    description: '汇总通过验证的结果，生成最终用户答案和 Artifact。',
  },
];

export const workerAgents = agentCatalog.filter((agent) => agent.kind === 'worker');
