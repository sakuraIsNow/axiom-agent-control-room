# 版本变更记录

本项目采用语义化版本。只有完成源码检查、测试、构建和规定的 QA 门禁后，版本才会进入正式标签。

## [2.3.0-rc.7] - 2026-09-07

### 路由与交付质量

- 浏览器与服务端共享降级决策和 Schema，复合检索保留附件、分析、交付与验证要求；健康 Router/Scheduler 模型决策仍为主，简单问题不强制多 Agent。
- 新增持久事件派生的 `executionQuality` 和路由请求 `diagnostics`，区分调用耗时、首个可见回答、已知/未知 Token、重试、人工介入、执行状态与来源证据；人工审核在重跑后不会被错误复用。
- 相同上游交接文本只传一次，保留引用与未决问题；审核问题未变且评分无改善时停止重复自动修正，仍遵守人工处理策略。
- 新增确定性路由故障与固定交付质量门禁，覆盖引用缺失/错配、漏项、截断、审核循环和跨轮要求变化；固定样例通过不代表任意回答事实正确。

### 真实交互验收

- 补齐有数据的中英文状态、动态 ARIA 和移动端长文案，保护用户命名与原文；缺失用量不显示为零。
- Agent Graph 专项改为挂载真实组件，覆盖点击、拖拽、暂停、历史切换及持续事件负载；修复暂停后空转和背面 Agent 点击被透明层遮挡。
- 本地完整门禁使用临时 API 和独立数据库，部署包排除编译出的测试文件。

本批验收结果及边界见 [rc.7 产品质量记录](docs/rc7-product-quality-20260907.md)。外部 MemoryCore、Harness/Codex sidecar 与真实媒体供应商仍需目标环境现场验收。

最终完整门禁 `37 passed / 0 failed / 3 skipped`，最终轮无重试；单测 `644 tests / 630 passed / 0 failed / 14 PostgreSQL skipped`，隔离 PostgreSQL 专项 `16/16` 补齐。路由故障 `137/137`、在线路由 `7/7`、固定交付 `14/14`、有数据双语 `10/10`、真实 Graph `22/22`、视觉 `172/172`、Fake MCP `44/44`。首轮英文告警失败和修复依据保留，不将最终通过表述为全程一次通过。

## [2.3.0-rc.6] - 2026-09-07

### 执行闭环与跨入口协作

- 通用 Agent 工具循环保存决策、观察和回执，支持有界连续执行、恢复复用、重复副作用拦截和未知结果人工核对。
- 复合附件保留原路由与真实输入；结构化上下文保留有原文出处的约束、决定和撤销记录。执行完成、人工接受与来源追溯分开呈现。
- 文本、视觉、绘图、视频和原生搜索配置按任务加密绑定；对话、Nexus、插件和日程透传一致，恢复与重跑继承原绑定。
- 图片生成/编辑和视频进入持久化专用执行，受理后查询与写入分离；不确定结果不自动重发，部分输出和缺失用量不冒充完整成功。
- 计划、工具、质量与结果核对使用统一人工处理面板；增加权限、版本冲突和并行审批控制，Nexus/Mini App 暂停后保留原请求与事件游标。
- “需要处理”栏统一毛玻璃列表样式与字号，取消嵌套彩色卡片；发布包包含中英文 README 和本版迁移说明。

验收记录：[第二批执行闭环](docs/execution-loop-upgrade-20260907.md)、[跨入口执行与人工协作](docs/cross-entry-consistency-20260907.md)。外部 MemoryCore、Harness/Codex sidecar 和目标供应商仍需部署环境验收，本候选版不把跳过项计为通过。

本批最终本地门禁为 `35 passed / 0 failed / 3 skipped`，在线路由评测重试一次后通过；单测 `611 tests / 597 passed / 0 failed / 14 PostgreSQL skipped`，隔离 PostgreSQL 专项 `16/16` 补齐，人工协作组件 `13/13`、视觉 `172/172`、Fake MCP `44/44`。复合检索在路由服务不可用时的分工退化仍是后续 P0，不以协作历史测试通过掩盖该边界。

## [2.3.0-rc.5] - 2026-09-04

### 中英文界面与文档

- 仓库默认 `README.md` 改为面向国际用户的英文版，完整中文说明迁移到 `README.zh-CN.md`，两份文档提供双向语言入口。
- 平台默认语言改为英文，右上角增加全局语言选择器；用户可以切换简体中文，选择通过本地存储和 `?lang=` 深链接持久化。
- 翻译覆盖任务、对话、项目、模板、Agent Nexus、日程、Agent Studio、运行观测、插件、模型配置、Readiness 和通知中心；对话正文、用户数据、代码与 Artifact 保持原始语言。
- 新增 `qa:i18n` 浏览器门禁并纳入完整生产门禁，检查英文默认值、全部工作区的可见平台文案、中文持久化和语言回切。
- `npm test` 为 `433 tests / 432 passed / 0 failed / 1 skipped`；完整 `npm run qa:all:local` 为 `33 passed / 0 failed / 3 skipped`，33 个可运行门禁均在第一次尝试通过。

## [2.3.0-rc.4] - 2026-09-04

### MCP 安全与恢复评测

- 外部 MCP/OpenAPI 描述和结果统一按不可信数据处理：移除控制字符、提示边界标签和常见提示词注入片段，并用明确的结果边界标记交给 Agent 与 Artifact。
- 高风险工具审批增加默认 15 分钟有效期（可用 `AXIOM_TOOL_APPROVAL_TTL_MS` 配置，服务端限制 1 秒至 24 小时）；过期审批自动失效，不能继续执行写操作。
- 凭据轮换通过相同凭据 ID 重新加密替换，旧密文不再可解析，API 响应和列表继续不返回 Secret。
- 只读工具支持有限指数退避重试（默认最多 2 次重试，可用 `AXIOM_EXTERNAL_READ_RETRIES` 配置，最多 3 次）；中高风险写操作保持单次调用并继续使用审批幂等，避免重复副作用。

### 质量门禁

- Fake MCP 评测从 30 个 P0 + 5 个 P1 扩展为 30 个 P0 + 10 个 P1，新增恶意描述/结果、审批过期、凭据轮换和读写重试策略；`npm run qa:mcp-business` 为 40/40 通过，并纳入 `qa:all:local`。

## [2.3.0-rc.3] - 2026-09-04

### MCP 可靠性与故障闭环

- 新增 5 个 P1 Fake MCP 案例，覆盖非法 JSON-RPC、初始化失败、空工具目录、实时工具目录漂移和调用超时后的恢复；保留原有 30 个 P0 案例不变。
- MCP 健康探测会对实时 `tools/list` 生成规范化目录摘要，并与固定版本比较；目录漂移会持久化为不健康状态、从 Tool Registry 下线并阻断调用。
- MCP 调用超时增加 `AXIOM_MCP_CALL_TIMEOUT_MS` 配置，服务端限制在 10ms 至 120s，异常响应保持失败可审计，不会伪造成功。

### 质量门禁

- `npm run qa:mcp-business`：35 passed / 0 failed / 0 skipped，其中 P0 为 30/30，P1 为 5/5。
- 完整 `npm run qa:all:local` 会自动包含 35 个 MCP 案例；本地 PostgreSQL、MinIO、运行时、浏览器视觉回归和性能基线继续纳入同一门禁。
- Fake MCP 仍只代表本地可重复验收；真实 MemoryCore、目标对象存储和 Harness/Codex sidecar 仍需部署环境现场验证。

## [2.3.0-rc.2] - 2026-09-04

### 新增

- 新增本地 HTTP Fake MCP 质量门禁，真实覆盖 `initialize`、`notifications/initialized`、`tools/list` 和 `tools/call`，不绕过业务 API 直接测试内部函数。
- 完成 30 个 P0 业务评测案例，覆盖工具路由、简单对话无副作用、跨轮工具漂移、租户与 Agent 权限、工具目录隔离、Schema 参数校验、小时/月度/并发配额、熔断半开恢复、高风险拒绝与人工审核、审批幂等重试、Artifact lineage 和敏感信息脱敏。
- 工具参数在配额、审核和外部调用前校验；非法参数不会消耗配额、创建审核或触发 MCP 副作用。

### 质量门禁

- 新增 `npm run qa:mcp-business`，输出 TAP 结果并生成 `qa/mcp-business-eval-results.json`。
- `npm run qa:all:local` 已自动包含 MCP 业务评测；最近一次专项结果为 `30 passed / 0 failed / 0 skipped`，耗时约 3.2 秒；完整本地门禁结果为 `32 passed / 0 failed / 3 skipped`。
- Fake MCP 仅用于本地可重复的业务安全评测，不代表真实 MemoryCore、S3/COS、OAuth 或 Harness/Codex sidecar 已完成目标环境现场验收。

## [2.2.0] - 2026-09-04

### 新增

- 新增可重复的 `qa:object-storage:local`：自动准备固定版本 MinIO、幂等创建测试桶，并验证双 Store 跨 Worker 读取、租户隔离、范围删除、大对象和二进制 Artifact。
- 新增跨 OS 进程的 PostgreSQL Worker 故障演练：强制终止持有租约的 Worker，让两个后继 Worker 竞争过期任务，并验证唯一接管、旧 owner 隔离、连续事件序号和单次终态。
- 新增扫描 PDF 回归：在内存中生成三页图片 PDF 和两页文本 PDF，验证前两页视觉预算、页码定位、页面顺序和文本页边界。
- 新增 `qa:all:local`，使用一次性 PostgreSQL 数据库和本机 MinIO 执行完整稳定版门禁，结束后自动删除测试库和测试对象。

### 修复

- PostgreSQL Task Store 初始化增加 advisory transaction lock 和 schema 版本哨兵；新 Worker 不再重复执行 DDL，修复首次并发建表竞态以及运行期认领与重复 `ALTER TABLE` 的死锁。
- 生产门禁隔离基础回归与外部验收环境，只有 PostgreSQL、MinIO、MemoryCore 和 Harness 专项收到各自配置，避免环境变量改变无关单测的 Store 行为。
- S3 配置测试完整保存和恢复对象存储环境，修复在真实 MinIO 配置下继承 path-style 开关导致的错误失败。
- 发布包的 `db:migrate` 改为运行已打包的 `server-dist/migrate.js`，不再依赖未包含的 TypeScript 源码和已由 `npm ci --omit=dev` 排除的 `tsx`；源码开发可使用 `db:migrate:dev`。

### 验收

- `npm run check`、`npm run build` 通过；`npm test` 为 `388 tests / 387 passed / 0 failed / 1 skipped`，跳过项由独立 PostgreSQL 专项覆盖。
- `npm run qa:all:local` 为 `30 passed / 0 failed / 3 skipped`，30 个可运行项目均首次通过；跳过项仅为未配置端点的 MemoryCore HTTP、MemoryCore Axiom 适配器和 Harness/Codex sidecar。
- 真实复杂 Runtime 产生 513 个连续事件、411 个 SSE 增量和 24,014 Token；Reviewer 低分触发人工门禁，明确批准后最终交付 717 字符 Artifact。
- 10 并发、每接口 50 次请求均为 HTTP 200；health、Readiness、运行观测和任务列表 P95 分别为 12.72、6.36、15.50、9.22 ms。

## [2.2.0-rc.2] - 2026-09-04

### 修复

- 生产门禁在未设置 `QA_URL` 时统一使用单体服务 `http://127.0.0.1:8787`，并向浏览器、API、跨 Origin 和恢复测试传递一致地址，不再误访问已经停用的 `4300` 前端端口。
- 将多格式报告导出和人工审核后交付结果回填纳入 `qa:all`，避免两条关键交付路径在总门禁中漏测。
- 为生产前端补充缓存策略：HTML 与普通入口使用 `no-cache`，Vite 哈希资源使用一年期 `immutable` 缓存；新增策略单元测试并通过临时生产服务真实响应头验证。

### 文档与版本

- README 增加按使用场景组织的已实现功能表，明确内置能力与需要模型、飞书、MemoryCore、对象存储或 Harness sidecar 的配置边界。
- 更新候选版测试、真实长任务和 25 并发性能基线；版本从 `2.2.0-rc.1` 递增为 `2.2.0-rc.2`，不提前宣告 `2.2.0` 稳定版。

### 验收

- `npm run check`、`npm run build` 通过；`npm test` 为 `385 passed / 0 failed / 1 skipped`。
- `npm run qa:all` 为 `27 passed / 0 failed / 4 skipped`，所有可运行项目均首轮通过；四个跳过项仍是未配置的 MemoryCore HTTP、MemoryCore Axiom 适配器、外部对象存储和 Harness/Codex sidecar 现场验收。
- 真实复杂任务产生 939 个连续事件、842 个 SSE 增量和 44,681 Token，经过一次人工确认后完整结束。
- 25 并发、每接口 200 次请求均为 HTTP 200；health、Readiness、运行观测和任务列表 P95 分别为 21.38、11.77、34.40、14.78 ms。

## [2.2.0-rc.1] - 2026-09-04

### 新增

- 新增开发与代码、研究与论文、办公协作、数据分析、内容创作、运维观测和企业业务七类能力包；前四类作为首批推荐包按租户默认启用，其余能力按需安装。
- 新增飞书企业自建应用连接器，支持读取云文档、日历、群消息，以及在统一高风险审批后发送文本消息。
- 新增 SQLite/PostgreSQL 双实现的集成凭据仓库，使用 AES-256-GCM 和租户/凭据/provider AAD 加密 App Secret；API 只返回 Secret 字段名，不返回明文。
- 项目空间“能力”页新增能力包启停、飞书连接、真实健康验证、断开连接和高级 MCP/OpenAPI 目录。

### 变更

- 外部工具候选目录增加租户和已安装能力包过滤，其他租户的工具或未启用能力包中的工具不会进入当前模型上下文。
- 飞书连接只有在开放平台真实签发 `tenant_access_token` 后才标记为可用；连接办公能力会同步启用办公协作包。
- 服务启动会恢复每个租户的能力包状态、加密连接引用和健康的飞书工具，用户明确停用的推荐包不会在重启后自动恢复。
- 集成主密钥必须不少于 32 个字符；凭据 ID 冲突在数据库层按租户拒绝，多位管理员各自拥有独立的飞书凭据与工具源。
- PostgreSQL 凭据表初始化使用 advisory lock，避免多个 Worker 首次同时启动时触发系统目录竞态。

### 当前边界

- 飞书当前使用应用身份的 `tenant_access_token`，不等同于飞书用户 OAuth；个人身份日历、用户委托权限和 OAuth 撤销仍待后续实现。
- 通用 MCP API Key 注入、OAuth 2 回调、Token 刷新与撤销尚未完成；除已实现的飞书连接器外，认证型来源仍保持待授权和禁用。
- 能力包目录与租户安装已完成，跨租户市场签名、发布审核、版本兼容、后台健康巡检、熔断和租户级调用预算仍在下一批。

### 验收

- `npm test`：`384 passed / 0 failed / 1 skipped`；唯一跳过项是未在该命令中配置的 PostgreSQL 专项。
- `npm run qa:all`：`24 passed / 0 failed / 5 skipped`，所有可运行门禁均首轮通过；飞书能力页、密码掩码、弹窗居中和推荐能力包已进入浏览器回归。
- PostgreSQL 独立临时库专项：`1 passed / 0 failed`，覆盖多 Worker 首次初始化、加密凭据跨实例恢复和跨租户隔离；临时库已删除。

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
## [2.3.0-rc.1] - 2026-09-04

### 新增

- 内网企业治理存储，SQLite/PostgreSQL 双实现，持久化租户策略、工具配额窗口、工具健康和运行指标。
- 租户工具源数量、schema Token、小时/月度调用和并发配额；配额拒绝在服务端原子执行。
- Tool Registry 调用熔断状态机（healthy/degraded/open/half-open），连续失败自动熔断，冷却后半开恢复。
- 通用 MCP/OpenAPI 凭据 API，统一加密保存 API Key、OAuth2 和服务账号 Secret，支持轮换与删除。
- 能力包安装记录增加 manifest digest、权限、风险和审核状态；新增 `qa:governance` 生产门禁。

### 边界

- 本版只完成内网可自证的控制面；真实 OAuth 供应商、OIDC、TencentDB MemoryCore、云对象存储、邮件和 Harness/Codex sidecar 仍需目标环境现场验收。

### 验收

- `npm run check` 通过。
- `npm test`：391 tests / 390 passed / 0 failed / 1 skipped。
- `npm run qa:all:local`：31 passed / 0 failed / 3 skipped；`npm run qa:governance`：2 passed / 0 failed。
