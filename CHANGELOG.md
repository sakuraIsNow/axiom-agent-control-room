# 版本变更记录

本项目采用语义化版本。只有完成源码检查、测试、构建和规定的 QA 门禁后，版本才会进入正式标签。

## [2.1.0] - 2026-09-03

### 新增

- Agent Nexus 图片、PDF、Word 和文本附件使用真实二进制 Artifact 存储；单节点文件存储与 S3/MinIO/COS 共用同一接口。
- Nexus 测试与 Release 固定附件快照、SHA-256 和附件集合摘要；附件变化会让旧测试过期，发布差异可以识别附件增加、删除和内容变化。
- 视觉 Agent 读取真实图片 part，文档 Agent 读取共享解析器提取的正文；运行时按租户、流程、MIME、大小和摘要校验，并在任务内缓存对象存储读取。
- OpenAI-compatible 模型客户端新增兼容的多模态 `userContent`，DeepSeek 视觉端点可以继续使用 Files API 上传流程。
- MCP/OpenAPI 能力目录新增能力分类、关键词、健康状态、认证状态、Agent 权限、风险与调用质量指标。
- Tool Registry 新增任务级 Top-K 外部工具路由，结合语义相关度、权限、健康、认证、成功率、延迟和风险，每步默认最多注入 6 个相关操作，硬上限 12。
- 工具目录页面新增健康检查、待授权提示、成功率、探测延迟和使用次数，并使用现有主题和毛玻璃视觉体系。

### 变更

- Nexus 新上传附件不再回退为 Base64 Markdown；存储不支持二进制时明确返回 503。
- Release 摘要现在同时覆盖流程定义与附件集合，相同定义但不同文件不会复用旧 Release。
- Orchestrator 不再把全部动态外部工具暴露给模型；内置工具保持兼容，外部工具按当前任务和 Agent 按需选择。
- 异常、待授权或当前 Agent 无权使用的 MCP/OpenAPI 操作不会注册到模型工具目录；显式指定工具也不能绕过过滤。

### 当前边界

- 需要认证的 MCP 可登记认证类型，但 API Key、OAuth 2、服务账号 Secret 的加密代理与 Token 刷新尚未交付，当前保持“待授权”和禁用。
- 多 Worker 二进制附件必须配置 MinIO/S3/COS；本地文件目录仅适合单节点。外部对象存储仍需在目标环境运行 `npm run qa:object-storage` 现场验收。
- 能力包市场、定时健康巡检、租户工具配额和跨副本指标聚合属于下一批，不将本版目录能力描述为无审核的公共 MCP 市场。

## [2.0.0] - 2026-09-03

### 新增

- Router Agent 与 Scheduler Agent 按每轮语义、任务难度和实际能力动态生成 Agent Graph；简单问题保留轻量直连路径。
- 可恢复 DAG、并行执行波次、动态 Replanner、结构化 Agent 契约、交接记录和交付证据摘要。
- Agent Nexus 测试、发布、固定版本运行、条件分支、多 Loop、嵌套 Loop、局部重跑、附件与 Artifact 引用。
- 项目空间、长期记忆管理、Agent 日程、多人协作、人工指导、反馈闭环和交付后动作。
- MCP/OpenAPI 动态工具源，接入统一 Tool Registry、参数校验、SSRF 防护、审批、配额、审计和 Artifact lineage。
- 插件小程序创建、修改、版本历史、审核市场、固定版本安装、签名校验和撤回熔断。
- Markdown、GFM 表格、SVG、HTML、图片和文档分析，以及 Markdown、Word、LaTeX、PDF 报告导出。
- PostgreSQL/SQLite 双实现、任务租约、断点恢复、通知外发、运行观测、告警和业务过程评测。
- S3 兼容 ArtifactStore 第一阶段，支持 AWS S3、MinIO 和腾讯 COS 的租户作用域对象读写与 Readiness 探测。

### 变更

- Agent Nexus 从“草稿直接运行”升级为“先测试、再发布、按固定发布版本运行”。
- 对话、任务、插件、Nexus、Harness 和 API 使用统一运行上下文与持久事件，不再用页面动画推测执行状态。
- 长结果优先保存为 Artifact；下游 Agent 默认接收摘要和引用，只有授权角色在预算内读取全文。
- 日程改为自然语言草案确认，并在每次触发时重新路由 Agent，而不是永久绑定固定执行链。
- 插件和外部工具发布改为权限声明、风险检查、版本固定与运行前复核。

### 不兼容变更

- 未发布的 Agent Nexus 草稿不能再创建正式运行，旧客户端可能收到 HTTP 409；需要先测试并发布。
- 生产模式默认拒绝 SQLite，只有显式设置 `ALLOW_SQLITE_PRODUCTION=true` 才允许例外启动。
- 启用 `AXIOM_REQUIRE_PLUGIN_SIGNATURE=true` 后，旧的未签名插件必须重新检查并发布。
- 多 Worker 部署必须让所有实例共享 PostgreSQL、对象存储和相同的凭据加密/签名密钥。

### 外部部署前置条件

- Node.js 22 或更高版本。
- 多 Worker 或受控生产部署使用 PostgreSQL；SQLite 仅用于本地单用户试用。
- 工具隔离执行需要 Docker 与固定版本沙箱镜像。
- 跨 Worker 大文件与二进制 Artifact 需要 S3/MinIO/COS；本地文件存储只适合单实例。
- TencentDB MemoryCore、DeepSeek Harness 和 Codex sidecar 都是可选能力，只有配置并通过现场探测后才算可用。
- 公网部署仍需 OIDC/可信反向代理、HTTPS、Secret Manager、限流、备份、监控和恢复演练。

升级和回滚步骤见 [docs/migration-v2.md](docs/migration-v2.md)。

## [1.1.0]

- 建立可回退的开源稳定基线。
- 提供对话、任务管理、Agent Graph、插件、Agent Nexus、模型配置和基础运行时能力。

## [1.0.0]

- 首个开源基线版本。
