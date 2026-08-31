export type RuntimeSkill = {
  id: string;
  label: string;
  description: string;
  keywords: RegExp;
  roles: string[];
  instruction: string;
};

/**
 * Skills are bounded runtime capabilities, not additional Agents. The router
 * selects only the skills relevant to the current turn and injects their
 * instructions into the selected Agent's scoped prompt.
 */
export const runtimeSkillCatalog: RuntimeSkill[] = [
  {
    id: 'architecture-design',
    label: '架构设计',
    description: '拆解系统边界、组件、数据流和关键取舍。',
    keywords: /(设计|架构|平台|系统|服务|模块|数据流|接口|architecture|platform|system|service|module|data flow|api)/i,
    roles: ['researcher', 'analyst', 'builder'],
    instruction: '明确边界、组件职责、数据流、接口契约、失败模式和可验证的取舍。',
  },
  {
    id: 'evidence-research',
    label: '证据研究',
    description: '整理事实、约束、假设和可验证证据。',
    keywords: /(研究|调研|资料|文献|事实|证据|来源|调查|research|evidence|source|investigate)/i,
    roles: ['researcher', 'analyst'],
    instruction: '区分事实、假设和未知项；为关键结论提供可追溯证据或明确证据缺口。',
  },
  {
    id: 'web-research',
    label: '联网检索',
    description: '检索时效信息并保留来源。',
    keywords: /(联网|上网|搜索|网页|最新|目前|现在|今天|实时|天气|新闻|价格|web|search|latest|current|today|weather|news|price)/i,
    roles: ['researcher', 'analyst'],
    instruction: '需要外部事实时先检索，再回答；保留来源 URL 和数据时间，不得凭空补全。',
  },
  {
    id: 'github-inspection',
    label: '代码仓库分析',
    description: '检查 GitHub 仓库、版本、Issue 和许可证。',
    keywords: /(github|仓库|源码|代码库|release|issue|license|repository|repo)/i,
    roles: ['researcher', 'analyst', 'builder'],
    instruction: '区分仓库声明与已核验实现，记录版本、入口、依赖和许可证，不得伪造文件内容。',
  },
  {
    id: 'document-analysis',
    label: '文档解析',
    description: '从 Markdown、PDF、Word、文本和表格中提取结构化信息。',
    keywords: /(文档|附件|报告|pdf|word|markdown|md|txt|csv|表格|document|report)/i,
    roles: ['researcher', 'analyst', 'builder'],
    instruction: '先提取文档结构和原文证据，再给出摘要、表格或结论；标注无法读取的部分。',
  },
  {
    id: 'implementation',
    label: '方案实现',
    description: '把分析结果转成可执行步骤、代码和验收项。',
    keywords: /(实现|开发|编写|修复|部署|搭建|代码|测试|实现|implement|develop|build|fix|deploy|code|test)/i,
    roles: ['builder'],
    instruction: '输出可执行步骤、依赖、变更点和验证命令；不要声称未执行的操作已经完成。',
  },
  {
    id: 'quality-review',
    label: '质量审查',
    description: '检查完整性、一致性、风险和验收标准。',
    keywords: /(审查|复核|验证|验收|质量|风险|一致性|review|verify|validate|quality|risk)/i,
    roles: ['analyst', 'reviewer', 'builder'],
    instruction: '检查遗漏、矛盾、无证据结论和不可执行项，并给出具体修正建议。',
  },
  {
    id: 'visual-generation',
    label: '视觉生成',
    description: '组织图片、SVG、界面和视觉资产的生成要求。',
    keywords: /(绘图|图片|图像|海报|插画|svg|视觉|设计图|image|draw|poster|illustration|visual)/i,
    roles: ['builder'],
    instruction: '明确尺寸、风格、内容和输出格式；媒体结果必须保留为可渲染或可下载的产物。',
  },
];

const roleFamily = (role: string) => {
  const normalized = role.toLowerCase().replace(/[_\s]+/g, '-');
  if (normalized.includes('search') || normalized === 'registry-agent' || normalized === 'researcher') return 'researcher';
  if (normalized.includes('document') || normalized === 'analyst' || normalized === 'reviewer') return 'analyst';
  if (normalized.includes('drawing') || normalized.includes('video') || normalized.includes('vision') || normalized === 'builder') return 'builder';
  if (normalized === 'planner' || normalized === 'orchestrator' || normalized === 'synthesizer') return 'analyst';
  return normalized;
};

const roleMatches = (skill: RuntimeSkill, role: string) => {
  const normalized = role.toLowerCase().replace(/[_\s]+/g, '-');
  return skill.roles.includes(role)
    || skill.roles.includes(normalized)
    || skill.roles.includes(roleFamily(normalized))
    || skill.roles.includes('*');
};

export const routeSkillIds = (input: string, role: string, requested: string[] = []) => {
  const selected = new Set<string>();
  const requestedSet = new Set(requested);
  for (const skill of runtimeSkillCatalog) {
    if (requestedSet.has(skill.id) && roleMatches(skill, role)) selected.add(skill.id);
    if (roleMatches(skill, role) && skill.keywords.test(input)) selected.add(skill.id);
  }
  // The reviewer always receives the quality skill, while a planner-selected
  // role never receives unrelated capabilities merely because they exist.
  if (role === 'reviewer') selected.add('quality-review');
  return [...selected].slice(0, 5);
};

export const skillInstructions = (skillIds: string[] | undefined) => (skillIds ?? [])
  .map((id) => runtimeSkillCatalog.find((skill) => skill.id === id)?.instruction)
  .filter((instruction): instruction is string => Boolean(instruction));

export const skillLabels = (skillIds: string[] | undefined) => (skillIds ?? [])
  .map((id) => runtimeSkillCatalog.find((skill) => skill.id === id)?.label)
  .filter((label): label is string => Boolean(label));
