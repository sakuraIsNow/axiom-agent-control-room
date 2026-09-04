import { createHash } from 'node:crypto';

export type CapabilityPackId = 'development' | 'research' | 'office' | 'data' | 'content' | 'operations' | 'business';

export type CapabilityPackDefinition = {
  id: CapabilityPackId;
  name: string;
  summary: string;
  version: string;
  recommended: boolean;
  order: number;
  capabilities: string[];
  connectors: Array<{
    id: string;
    name: string;
    auth: 'none' | 'optional' | 'required';
    status: 'builtin' | 'available' | 'planned';
    note: string;
  }>;
  permissions?: string[];
  riskLevel?: 'low' | 'medium' | 'high';
};

export const capabilityPackCatalog: CapabilityPackDefinition[] = [
  {
    id: 'development', name: '开发与代码', summary: '读取和评估代码仓库、版本与工程证据。', version: '1.0.0', recommended: true, order: 1,
    capabilities: ['GitHub 项目研究', '代码与许可证评估', '仓库文档读取', '工程报告'],
    connectors: [
      { id: 'github-public', name: 'GitHub 公共仓库', auth: 'optional', status: 'builtin', note: '公开仓库无需 Key；高频访问或私有仓库需要 Token/GitHub App。' },
      { id: 'gitee', name: 'Gitee', auth: 'optional', status: 'available', note: '公开仓库可直接研究，私有仓库需要授权。' },
    ],
  },
  {
    id: 'research', name: '研究与论文', summary: '检索论文、核查来源并形成可追溯研究报告。', version: '1.0.0', recommended: true, order: 2,
    capabilities: ['论文检索', '来源核验', '文献综述', '研究报告'],
    connectors: [
      { id: 'deepseek-search', name: 'DeepSeek 原生搜索', auth: 'required', status: 'builtin', note: '使用平台搜索模型配置。' },
      { id: 'open-research', name: '开放论文来源', auth: 'optional', status: 'available', note: '可按需接入 arXiv、Crossref、PubMed 等 MCP/OpenAPI。' },
    ],
  },
  {
    id: 'office', name: '办公协作', summary: '连接沟通、日历和云文档，让 Agent 参与日常协作。', version: '1.0.0', recommended: true, order: 3,
    capabilities: ['飞书消息', '飞书云文档', '飞书日历', '任务通知'],
    connectors: [
      { id: 'feishu', name: '飞书', auth: 'required', status: 'available', note: '需要飞书开放平台 App ID、App Secret 和相应权限。' },
      { id: 'microsoft-365', name: 'Microsoft 365', auth: 'required', status: 'planned', note: '后续通过 OAuth 2 能力接入。' },
    ],
  },
  {
    id: 'data', name: '数据分析', summary: '读取受控数据源，完成分析、校验与报告。', version: '1.0.0', recommended: true, order: 4,
    capabilities: ['PostgreSQL 只读查询', 'CSV/JSON 分析', '数据报告', 'Artifact 交付'],
    connectors: [
      { id: 'postgresql', name: 'PostgreSQL', auth: 'required', status: 'builtin', note: '建议使用独立只读账号与允许的查询范围。' },
      { id: 'openapi-data', name: '数据 OpenAPI', auth: 'optional', status: 'available', note: '可导入固定版本 OpenAPI。' },
    ],
  },
  {
    id: 'content', name: '内容创作', summary: '把文本、图片和视频生成能力组成可复用流程。', version: '1.0.0', recommended: false, order: 5,
    capabilities: ['图片生成与编辑', '视频制作', '网页内容', '多格式导出'],
    connectors: [
      { id: 'image-provider', name: '图片模型', auth: 'required', status: 'builtin', note: '使用平台图片模型配置。' },
      { id: 'video-provider', name: '视频模型', auth: 'required', status: 'builtin', note: '配置本地或互联网视频服务后启用。' },
    ],
  },
  {
    id: 'operations', name: '运维观测', summary: '读取运行指标和告警，形成诊断与处置建议。', version: '1.0.0', recommended: false, order: 6,
    capabilities: ['运行健康检查', 'Prometheus 指标', '告警分析', '部署核查'],
    connectors: [
      { id: 'axiom-runtime', name: 'Axiom Runtime', auth: 'none', status: 'builtin', note: '读取平台自身健康、队列和运行指标。' },
      { id: 'observability-mcp', name: '外部观测 MCP', auth: 'required', status: 'available', note: '可接入受控监控与日志服务。' },
    ],
  },
  {
    id: 'business', name: '企业业务', summary: '连接 CRM、工单、审批和内部业务系统。', version: '1.0.0', recommended: false, order: 7,
    capabilities: ['客户与工单查询', '业务审批', '通知交付', '业务审计'],
    connectors: [
      { id: 'business-openapi', name: '企业 OpenAPI', auth: 'required', status: 'available', note: '需要目标系统 OpenAPI/MCP 地址和测试凭据。' },
    ],
  },
];

export const capabilityPackById = (id: string) => capabilityPackCatalog.find((pack) => pack.id === id);
export const recommendedCapabilityPackIds = capabilityPackCatalog.filter((pack) => pack.recommended).map((pack) => pack.id);

/** Stable manifest identity used by the internal capability market. */
export const capabilityPackManifestDigest = (pack: CapabilityPackDefinition) => createHash('sha256')
  .update(JSON.stringify({ id: pack.id, version: pack.version, capabilities: pack.capabilities, connectors: pack.connectors, permissions: pack.permissions ?? [], riskLevel: pack.riskLevel ?? 'low' }))
  .digest('hex');
