# Axiom Agent Control Room 升级路线

## 项目定位

Axiom Agent Control Room 是一个面向长任务执行的人机协作 Agent Runtime，而不是单轮聊天 UI：

```text
任务分类 -> 按难度动态路由 -> Planner -> 子 Agent 协作
       -> 可恢复 Loop -> 工具与 Artifact -> Reviewer 质量门禁
       -> 人工接管或修正 -> Synthesizer -> 可审计交付
```

核心竞争力目标：在不让所有请求都进入复杂工作流的前提下，为真正复杂的任务提供可恢复、可审计、可干预、可验证的执行闭环。

> **2026-08-22 全面升级路线图**：`docs/upgrade-roadmap.md` 汇总了两轮独立代码审查（前端视觉/架构、后端 9 个核心运行时模块逐行审查）和市场对标分析的完整结论，是本文档 P0.6/P0.7/P1.7/P1.8 及若干补充条目的设计依据。执行以下新增条目前建议先读该文档对应章节，避免丢失背后的具体原因（哪些文件、哪些行号、哪些权衡）。
>
> **2026-08-24 前端彻底重建执行文档（当前最新，优先级最高）**：`docs/frontend-rebuild-v2-execution-plan.md` **替代**了 `docs/dashboard-agentstudio-roadmap.md` 里"新建 Dashboard 并列入口、旧前端隐藏保留"的架构决策——用户已明确要求旧前端（经典工作台/`AxiomMissionDeck`/`AxiomStudio`）物理删除，不再保留任何隐藏入口；同时纠正了上一轮把截图里的 3D 卡片轨道误做成"Agent 状态轮播"的错误（截图里的毛玻璃卡片对应的是历史会话/任务浏览，不是 Agent 拓扑，Agent 拓扑应该在"沉浸模式"里用已有的 `CinematicCore.tsx`+`agentStateMachine.ts` 实现）。P1.9/P1.10 之前已完成的部分（后端 `getTaskStats`/Agent Studio CRUD/`agentStateMachine.ts` 状态机本身）仍然有效，只是前端挂载位置和数据绑定需要按新文档调整，具体见该文档第 5/7 节。**该文档第 14 节的 4 个方向性问题用户已全部选择"做完整版"**（首页统计 4 项全做、Agent Studio 现在就接入 Planner 调度含"Agent 创建 Agent"、插件弹窗化做完整 mini-app 沙箱、详情面板"所属会话主题"字段派生逻辑），对应第 4.2/8/9/6 节，批次顺序见第 12 节——本文档 P1.10 的"阶段二 Planner 动态角色接入不在本次范围"这一表述已被推翻，不要按旧说法执行。

## 执行规则

- 按 P0、P1、P2 的顺序交付；每个条目必须有代码、测试和验收证据。
- Direct Response 不创建虚假的多 Agent 节点；只有 Planner 真实生成的步骤才能进入 Graph。
- 业务状态必须来自持久化 Task/Event，不用前端定时器伪造完成状态。
- 新能力优先复用已有 Task/Event、Tool Registry、Artifact 和 SSE 契约。
- 每批完成后运行 `npm run check`、`npm test`、`npm run build`；涉及 UI 时额外运行 `npm run qa:visual`。

## P0：当前生产候选必须补齐

### P0.1 真实 DAG Graph 可读性和可操作性

- [x] Graph 路由状态与 Direct Response 区分。
- [x] 节点详情显示角色、依赖、attempts、confidence、evidence、Artifact。
- [x] 将节点卡片升级为按依赖层级排列的 DAG 视图。
- [x] 依赖边区分 dependency、delegation、review，并支持自动定位 ready queue。
- [x] Graph 节点显示失败原因、工具数量、Token、耗时和受影响下游。
- [x] 3D 节点与 Graph 节点双向选中。

验收：team/full-workflow 任务能看到真实依赖层级；Direct 任务明确显示无需依赖图；节点控制后 Graph 状态与事件一致。

### P0.2 任务控制中心

- [x] 增加任务列表和状态筛选：queued、running、paused、awaiting approval、failed、completed。
- [x] 任务列表显示路由、难度、耗时、Token、成本、当前阶段和最近更新时间。
- [x] 支持从历史任务打开会话、继续暂停任务、重试失败任务和查看 Artifact。
- [x] 任务列表与 PostgreSQL `/api/tasks`、`/api/tasks/:taskId` 对齐，不依赖 localStorage 作为唯一来源。

验收：刷新页面或关闭浏览器后，仍可从任务列表找到并恢复任务。

### P0.3 Reviewer 失败人工接管

- [x] Reviewer 在自动修正后仍未通过时进入 `waiting_for_human`，而不是直接不可恢复地失败。
- [x] 增加批准当前结果、补充证据、重新规划、指定节点重跑四类操作。
- [x] 持久化人工决定、操作者和理由，并通过 SSE 回放。
- [x] 增加 reviewer rejection、manual takeover、correction success 指标。

验收：Reviewer 低于阈值时任务可在协作面板继续，不需要从头重跑。

### P0.4 运行时遥测

- [x] 前端显示 SSE `model.completed` 的 prompt/completion/total token。
- [x] 每任务累计 Token、成本、模型调用数、队列等待、P50/P95 阶段耗时。
- [x] Graph 节点显示 Token、耗时、重试和 Tool 调用数。
- [x] `/api/runtime/stats` 增加 route 命中率、Reviewer 驳回率、人工接管率、Tool 成功率。

验收：单任务和系统级指标可互相校验；SSE 重连不会重复累计。

### P0.5 回归测试和评测门禁

- [x] Direct、single-agent、team、full-workflow 路由回归 4/4。
- [x] PostgreSQL/SQLite 事件序列、租约、取消、恢复测试。
- [x] 增加 Graph 状态转换和人工控制 API 测试。
- [x] 增加 Reviewer 不通过后的人工接管测试。
- [x] 增加模型超时、429、SSE 断线、Worker 中止、Artifact 失败故障注入。
- [x] 建立真实业务 case 集并完成路由/难度基线验收。
- [x] 用真实执行结果持续记录完成率、证据完整率和人工接管率；`npm run qa:runtime` 产出脱敏样本 `qa/runtime-results.json`，并校验终态前的 SSE 增量。

验收：发布前所有单元、运行时、路由和视觉回归通过。

### P0.6 工具执行安全一致性

背景：经代码审查确认，`toolRegistry.ts` 里已注册的 12 个工具中只有 7 个（`workspace.search`/`read`/`git-status`/`git-diff`/`git-branch`/`git-commits`/`test`）真正经过 `toolExecutor.ts` 的 Docker 沙箱（`--network=none --read-only --cap-drop=ALL` 等生产级隔离配置）。另外 5 个（`workspace.write`、`workspace.patch`、`database.query`、`http.fetch`、`browser.open`）走的是 `handler` 型直接执行，完全绕过容器隔离，在 Node 主进程内直接跑——恰好是风险最高的写文件、数据库直连和出网操作。这是当前唯一一处"安全声明（README/docs 描述的沙箱边界）与实际实现不完全一致"的地方。详见 `docs/upgrade-roadmap.md` Part B.1。

- [x] 把 `workspace.write`/`workspace.patch` 纳入 Docker 沙箱执行路径，或明确文档标注当前不受容器隔离保护、依赖应用层校验。
- [x] 把 `database.query` 的连接和查询执行迁移到沙箱内，或补充说明其安全边界仅依赖只读事务 + 语句白名单。
- [x] 给 `http.fetch`/`browser.open` 的 `allowedHttpHost()` 补充云厂商 metadata 地址黑名单（`169.254.169.254` 等）和 IPv6 内网地址拦截，覆盖当前遗漏的 SSRF 风险面。
- [x] 补充针对性测试：确认高风险工具在沙箱内执行、metadata 地址请求被拒绝。

验收：Tool Registry 的沙箱覆盖率与文档描述的安全边界一致；SSRF 相关测试用例通过。

### P0.7 Readiness 真实探测

背景：`readiness.ts` 当前 11 项检查全部是"环境变量是否非空"，不做真实连通性探测——`DEEPSEEK_API_KEY` 配置了但已失效、`TDAI_MEMORY_ENDPOINT` 配置了但服务下线，都会显示 `ready`。`memoryClient.ts` 里已经写好的 `health()` 方法完全没有被 `readiness.ts` 调用，是可以低成本修复的缺口。

- [x] `readiness.ts` 的 `memory` 检查项改为调用 `memoryClient.health()` 做真实探测，而非只检查 `TDAI_MEMORY_ENDPOINT` 是否配置。
- [x] `model-provider` 检查项增加一次轻量级真实调用（如模型列表或健康端点），而非只检查 Key 是否非空；需考虑超时与调用成本，避免拖慢 `/api/runtime/readiness` 响应。
- [x] `sandbox` 检查项接入 Docker 镜像 probe，镜像缺失时不再显示 ready，并补充失效 probe 测试。
- [x] 评估其余检查项（`image-provider`、`harness`、`object-storage`）：当前保留配置级检查，后续按外部 Provider/对象存储协议补充低成本探测。

验收：`DEEPSEEK_API_KEY`/`TDAI_MEMORY_ENDPOINT` 配置了失效值时，`/api/runtime/readiness` 能反映真实不可用状态而非误报 `ready`。

## P1：核心业务能力扩展

### P1.1 工作流模板和版本

- [x] 保存任务为模板，包含模式、模型、Agent、工具、预算和审批策略；模板可在发布后创建任务并持久化关联。
- [x] 模板版本、发布、回滚、导入导出和团队共享；私有/团队可见性按租户成员权限过滤，导入默认私有草稿。
- [x] 模板 API 已接入 PostgreSQL/SQLite、租户隔离、归档保护和模型覆盖；接口说明见 `docs/workflow-templates.md`。
- [x] 提供代码审查、架构评估、故障分析、研究报告标准模板，并在工作流模板 UI 中支持创建草稿。

### P1.2 Tool Registry 扩展

- [x] workspace.patch / workspace.write，使用精确匹配、原子写入和持久化人工审批策略。
- [x] Git diff、branch、commit，默认只读；高风险工作区写操作统一进入人工批准。
- [x] 数据库只读查询、HTTP/API、浏览器、文档和表格工具适配器；`database.query` 仅允许单条 SELECT/WITH/EXPLAIN/SHOW，`http.fetch` / `browser.open` 仅允许 allowlist 主机，`document.read` / `table.read` 只读工作区并纳入审计与 Artifact lineage。
- [x] 工具风险等级、参数 schema、超时、配额、审计和 Artifact lineage；工具目录、审批 API 和回归测试见 `docs/tool-registry.md`。

### P1.3 Planner 和子 Agent 协议

- [x] 每个步骤输出 schema、验收条件、模型、工具、Token 预算、超时和失败策略；步骤预算会传递到兼容 Provider，超时使用步骤级 AbortSignal。
- [x] Agent 间结构化消息和中间 Artifact 共享；依赖步骤通过 `agent.message` 传递上游输出和 Artifact 引用，并补充运行时测试。
- [x] 并行结果冲突检测与竞争式验证提示；并行 Agent 出现明确相反结论时写入 `agent.conflict`，Reviewer 会收到冲突候选上下文。
- [x] 预算接近上限时自动收缩工作流；运行时按剩余 Token 预算压缩并行步骤的 `maxTokens`，并写入 `budget.constrained`。

### P1.3-H Harness 兼容层（参考 DeepSeek Harness rc.8 / Codex app-server）

参考基线：`deepseek-harness-master-v0.1.0-rc.8.zip`、`codex-main.zip`。两者只作为可替换 Runtime 参考，不直接嵌入当前 Node 服务。

- [x] 建立 `HarnessAdapter`、能力握手、Thread/Turn 控制和订阅接口；Builtin Runtime 保持唯一权威执行者。
- [x] 建立统一 `HarnessEvent`，覆盖 thread、turn、item、模型增量、工具、Agent 协作、队列和审批生命周期。
- [x] 将外部事件归一化为带 `threadId/turnId/itemId/externalSequence` 的 `RuntimeEvent`，由 TaskStore 重新分配租户内 sequence。
- [x] 增加重连/回放有界去重器，避免 SSE 和外部 Harness 事件重复计数。
- [x] 前端事件时间线兼容 Harness 事件，不再因新增事件类型丢失标签。
- [x] DeepSeek ACP JSON-RPC stdio transport：实现 `initialize`、`session/new`、`session/prompt`、`session/cancel`、`session/update` 和一次性审批响应；只有能力握手通过且显式设置 `DEEPSEEK_HARNESS_ACTIVE=true` 才能启用。HTTP 原生 transport 仍等待稳定的上游 wire contract。
- [x] ACP 任务委托桥接：新增 `HarnessTaskBridge` 和任务级 start/resume/interrupt API；仅暂停任务允许委托，外部事件经租户/任务校验、去重后写入 TaskStore，并在 turn 终态回写任务结果和可恢复状态。
- [x] Codex app-server JSON-RPC stdio/sidecar transport：已实现 v2 `initialize`/`thread`/`turn`/`item`/审批协议和可恢复事件桥接；真实 sidecar 仍需在部署环境固定 commit、workspace 与审批策略后现场验收。
- [x] 外部 Harness 审批回放、Artifact lineage、失败补偿和跨重启恢复：已完成 durable approval、事件游标恢复、断流暂停和协议级 fake sidecar 回归；真实 sidecar 集成仍需外部服务凭据。
- [ ] Agent Graph 持久化升级为 parent/child thread edge，支持 open/closed 状态和 breadth-first descendants。
- [x] **路线决策（新增）**：先交付 DeepSeek ACP stdio 的隔离 transport 和协议回归，保持 Builtin Runtime 为默认权威执行者；未实现的 Codex/HTTP transport 和 orchestrator 委托继续保持未完成状态，能力接口不会把“握手通过”误报为“任务已接管”。

### P1.4 记忆和模型适配

- [x] 配置 TencentDB MemoryCore L0-L3 长期记忆适配器：已完成 L1/L2/L3 召回、游标去重、过期/置信度过滤和持久化补偿；正式 endpoint 现场验收单独保留。
- [x] 记忆捕获与召回质量闭环：最新回合切片、SHA-256 去重、持久化游标、来源、置信度、过期过滤、分层预算和质量指标；L1-L3 提取仍由 MemoryCore 管线负责。
- [x] 模型按任务类型、Agent 角色、延迟、成本和成功率动态路由；候选模型受服务端目录约束，运行统计从 PostgreSQL/SQLite 任务事件恢复，显式任务模型和用户凭据优先。
- [x] 自定义 Provider 使用租户/用户隔离的 AES-256-GCM 加密凭证引用；恢复任务不依赖浏览器保存明文 Key。
- [x] **适配深度补充（新增）**：已接入 L0 删除、L1 更新/删除、L2 读写/删除和 L3 读写；`memory_capture_receipts` 在 PostgreSQL/SQLite 中用原子 claim、短租约、内容摘要和时间游标防止任务恢复或多 Worker 重复写入，失败后可重试。L2/L3 修改仅允许 owner/admin，参考实现没有原生 L3 delete，平台不伪造删除语义。协议、权限和验收边界见 `docs/memorycore-integration.md`。

### P1.5 运营控制台

- [x] Scheduler、Webhook、死信任务和重试策略 UI；日程状态、连续失败、自动退避、死信恢复和删除已接入，Webhook 要求带时间窗 HMAC 签名与幂等投递键。
- [x] Worker 租约、队列深度、模型健康、Tool 失败分布：新增租户隔离的 `GET /api/runtime/operations?hours=24`，从持久化任务租约和 `task_events` 聚合活动 Worker、过期租约、队列分层、模型调用表现和工具失败率；前端“运行观测”工作区提供 24 小时/3 天/7 天切换。
- [x] Token / 成本趋势、Agent 成功率、Reviewer 通过率和 SLA：同一运营快照返回模型 Token/成本、Agent 完成率、Reviewer 通过/驳回/人工接管、终态任务成功率和 P50/P95 完成时长；保留原有 7 日 Token 趋势用于首页概览。`npm run qa:operations` 覆盖真实 API、筛选切换、移动/桌面无溢出和浏览器错误。
- [x] **具体缺口已闭环（新增）**：`ScheduledTrigger` 已持久化 `failureCount`/`lastError`/`lastRunStatus`/`deadLetteredAt`，失败按指数退避，达到上限自动停用并可恢复；Webhook 已改为原始 JSON 正文、租户/用户身份和投递键参与 HMAC-SHA256 签名，默认五分钟时间窗，重复投递通过租户级幂等键复用原任务。覆盖测试见 `scheduler.test.ts`、`webhookSecurity.test.ts`、`taskApi.test.ts`。

### P1.6 用户插件与创作工作台

- [x] 声明式插件 schema、版本模型与 SQLite/PostgreSQL PluginStore。
- [x] 私有/团队可见、草稿 -> 发布 -> 归档状态流转。
- [x] Prompt Plugin 复用 Task/Run/Event/SSE 与人工审批闭环。
- [x] Mini App 插件：`kind=mini-app`、HTML 200KB 限制、sandbox iframe（不授予 `allow-same-origin`）和可拖拽弹窗。
- [x] 插件管理与运行迁入左侧完整工作区，保留版本标识和插件运行 lineage 元数据；Mini App 运行结果仍使用隔离窗口。
- [x] 插件参数 schema 校验；工具引用必须来自 Tool Registry。
- [ ] Workflow Plugin 复用 Task/Run/Event/SSE 的图形化编排。
- [ ] 插件失败恢复、签名和兼容性检查。
- [ ] 插件市场与 Agent Studio。

### P1.7 前端电影级重构

完整设计依据见 `docs/upgrade-roadmap.md` Part A（组件拆分、CSS 落位、3D 架构、状态管理决策、实施顺序、风险提示均已在其中详细展开，此处仅列可勾选项）。本项决定推翻 `docs/launch-readiness.md:66-74` 现有的克制视觉原则，做电影级视觉方向；该文档章节和 `App.tsx:2542` 系统说明页文案需同步更新。

- [x] 打 `frontend-backup/<时间戳>-pre-cinematic/` 快照（本项目非 git 仓库，此为唯一回滚手段）。
- [x] 抽取 `AgentScene.tsx` 的避障曲线路由算法（`buildConnectionPoints`/`curveClearance`/`curveLength`/`nodeRadius`）为共享模块 `src/lib/curveRouting.ts`。
- [x] 搭建 `src/components/shell/` 新外壳组件树（`AxiomShell`/`ShellHeader`/`ShellNavRail`/`ShellCommandBar`/`ShellObservatory`/`CoreView`/`GraphView`/`StreamView`/`MetricsStrip`/`Inspector`），从 `ImmersiveControlRoom.tsx` 收编 `CountUp` 组件和指针视差/全息 CSS 变量机制。
- [x] 新写 `CinematicCore.tsx`：核心球用 `MeshTransmissionMaterial`/`MeshRefractionMaterial` 做玻璃/金属质感升级（仅限单个英雄物体，其余节点保持 `meshPhysicalMaterial`+`clearcoat`），接入 `EffectComposer`+`Bloom`+`ChromaticAberration`+`Vignette` 后期处理。
- [x] 引入 `zustand`（已装未用）建立 `useShellStore`，只承载运行时/可视化状态切片（phase/agents/graph/selectedNodeId/runEvents/usage/durationMs/taskProfile），动作回调仍走 props；不迁移 `App.tsx` 的会话/任务列表/弹层状态。
- [x] 新增 `src/styles/shell.css`（或按需拆分），延续现有纯 CSS + 全局类名写法，通过 `data-theme` 消费现有 token；`src/lib/uiTheme.ts` 的 `scene` 字段调色保持为 3D 层唯一真源。
- [x] 切换 `App.tsx` 默认渲染入口为新外壳，经典工作台不再保留入口。
- [x] 物理删除 `AxiomMissionDeck.tsx`、`AxiomStudio.tsx`、`ImmersiveControlRoom.tsx`、`ImmersiveCore.tsx` 及旧 Agent 轮播组件，清理对应 `lazy()` 导入和引用。
- [x] 移动端复杂度降级：`dpr` 上限调低、移动端 `MeshTransmissionMaterial` 回退为 `meshPhysicalMaterial`、粒子/Sparkles 数量增加移动端档位。
- [x] 更新 `scripts/visual-qa.mjs` 选择器和断言以匹配新外壳 DOM 结构。
- [x] 更新 `docs/launch-readiness.md:66-74` 和 `App.tsx:2542` 的过时克制风格文案。

验收：`npm run check && npm test && npm run build && npm run qa:visual` 通过；四主题切换、真实任务提交、暂停/恢复、Dashboard 与沉浸模式来回切换手动验证无回归。

### P1.8 协作事件可视化（前后端联动）

背景与现状：P1.8 已完成。`applyWorkflowEvent`（`App.tsx:898-948`）会按任务和事件 ID 去重并保留 `agent.message`、`agent.conflict`、`budget.constrained` 原始 payload；新外壳的 GraphView/StreamView/Inspector 消费协作正文、冲突双方结论和步骤级预算压缩数据。

- [x] `applyWorkflowEvent` 为 `agent.message`/`agent.conflict`/`budget.constrained` 增加专属分支（参考现有 `tool.approval_requested`/`review.approval_requested` 分支模式），把 payload 存入新 state，按 taskId/id 去重。
- [x] 新外壳的 GraphView/StreamView/Inspector 渲染这些状态：协作消息正文、冲突双方具体结论（而非仅"存在冲突"）、预算压缩前后每个 step 的 token 分配变化。
- [x] 评估 `ImmersiveCore`/`AgentScene` 当前 10-12 个节点的可见截断上限：新 CinematicCore/GraphView 放宽到最多 16 个真实节点，旧备用视图仍保留其原有上限以控制 GPU 成本。

验收：真实触发并行冲突或预算压缩的任务场景下，新外壳能展示具体内容而非通用日志行。

### P1.9 任务台 Dashboard（新默认前端）

完整设计依据见 `docs/frontend-rebuild-v2-execution-plan.md`。旧经典工作台、`AxiomMissionDeck`、`AxiomStudio` 和遗留 `Immersive*` 前端已物理删除；当前仅保留 `dashboard`（默认任务台）与 `immersive`（沉浸模式）两种视图，不再提供 `classic`/`studio` 隐藏入口。

- [x] 后端：`TaskStore` 接口新增 `getTaskStats(tenantId)`（`server/runtime/contracts.ts`），`postgresTaskStore.ts`/`sqliteTaskStore.ts` 双实现，`taskApi.ts` 新增 `GET /api/tasks/stats`。
- [x] 抽取 `src/lib/graphLayers.ts`（`computeGraphLayers`，从 `App.tsx` 提取）和 `src/lib/graphPresentation.ts`（`nodeId`/`nodeTitle`/`statusText`/`taskStatusLabels`/状态色映射），`App.tsx` 与 `GraphView.tsx` 改为 import 复用，`GraphView.tsx` 的 `index % 4` 假网格换成真实依赖层级布局。
- [x] 搭建 `src/components/dashboard/`：`AxiomDashboard.tsx`（三栏骨架）、`DashboardNavRail.tsx`（7 项导航）、`StatCards.tsx`、`TaskBoard.tsx`（列表态，按依赖层级分组）。
- [x] `src/lib/agentStateMachine.ts`：分段式状态 ID（`00-09`/`10-29`/`30-49`/`50+`）、六种动画原语（sine/pulse/jitter/scan/glance/blink）、临界阻尼弹簧 `springStep`、`resolveAgentStateId`。
- [x] 任务台 3D 轨道改为 `TaskOrbitCarousel.tsx`，卡片绑定真实历史任务/会话（标题、路由、状态、更新时间），Agent 状态拓扑仅在沉浸模式展示；`CinematicCore` 已消费 `agentStateMachine` 的彩带状态。
- [x] `src/components/dashboard/TaskTimeline.tsx`：任务执行历史时间线（非排期甘特图），条形按真实 `createdAt`→`updatedAt`/当前时刻绘制。
- [x] `src/components/dashboard/TaskDetailPanel.tsx`：右侧详情面板，"AI 助手建议"分"路由依据"（`TaskProfile.reasons`）和"审查发现"（`ReviewResult.gaps`/`requiredCorrections`）两个子区块，各自独立空状态。
- [x] `App.tsx` 的 `applyWorkflowEvent` 归约器新增 `reviewResult` state 字段，`review.completed` payload 现已完整透传；`types.ts` 的 `WorkflowTask` 补 `review` 字段，`openCatalogTask` 恢复历史任务时同步回填。
- [x] `src/lib/useDashboardStore.ts`（zustand，新建，不塞进 `useShellStore.ts`），承载 `nav`/`selectedTaskId`/`stats`/`tasks` 切片。
- [x] `src/styles/dashboard.css`：真玻璃质感重写（不是占位扁平卡片）——`backdrop-filter: blur() saturate()`、环境光晕背景（radial-gradient ambient）、卡片右上角发光角标、圆角面板（20-24px），配方参考 `fluidglass-ui-main`/`prism-glass-main` 的 `references/*.css`（Apache-2.0，已在 Part D 许可证表中确认可用）改写为 `--dash-*` token，四主题（obsidian/graphite/ivory/cobalt）全覆盖。
- [x] `App.tsx` 默认渲染分支切到 `AxiomDashboard`；`VIEW_KEY` 从 `v1` 升级为 `v2`，避免老用户浏览器里遗留的 `classic`/`immersive` 偏好继续覆盖新默认值。
- [x] 业务功能入口全部迁移进新前端，不遗留在被隐藏的经典工作台里：模板库、插件、日程与智能体工作室使用左侧导航对应的完整主工作区；系统运行状态与模型设置只保留右上角入口；新增 `src/components/dashboard/ScheduleBoard.tsx` + `src/lib/scheduleRuntime.ts`，把此前完全没有前端界面的 `GET/POST/DELETE /api/schedules` 真实接上（比经典工作台原有能力更完整，非新增假功能）。
- [x] `scripts/visual-qa.mjs` 已改为验证 Dashboard 默认入口、任务轨道、四主题、沉浸 Canvas 动画、Graph 节点、移动端无溢出和浏览器无错误。
- [x] 经典工作台 JSX、`?view=classic`/`?view=studio` 入口和旧组件已物理删除。

验收：`npm run check && npm test && npm run build && npm run qa:visual` 已通过；老版 `localStorage`（`axiom-view-mode-v1`）不再覆盖新入口；四主题、真实任务提交、沉浸模式 Canvas/Graph、移动端无横向溢出和浏览器无错误均已纳入视觉 QA。

### P1.10 Agent Studio 阶段一（数据与只读集成）

完整设计依据见 `docs/dashboard-agentstudio-roadmap.md` Part B。阶段一的定义→存储→展示已完成，并已完成 Planner 动态角色接入和草稿 Agent 提案工具。

- [x] 新增 `server/runtime/agentStore.ts`（比照 `pluginStore.ts` 的双 store 实现模式：`normalizeDefinition`/`createAgent`/`updateValue` 代码结构）+ `user_agents` 表（PostgreSQL/SQLite，含 `roleId` 唯一索引）。
- [x] `contracts.ts` 新增 `UserDefinedAgent`/`CreateUserDefinedAgentInput`/`UpdateUserDefinedAgentInput` 类型：身份与生命周期字段对齐 `UserPlugin`，执行定义（systemPromptTemplate/whenToUseHint/defaultModel/allowedModels），工具与权限（toolAllowlist/maxToolCallsPerStep），执行边界（maxTokensDefault/maxDurationMsDefault/failureStrategyDefault），memoryRecall/requiresPlanApprovalOverride。**未复用/未扩展 `UserPlugin` 类型**。
- [x] `taskApi.ts` 新增端点：`GET/POST /api/agents/custom`、`PATCH /api/agents/custom/:agentId`、`POST /api/agents/custom/:agentId/publish|archive`，权限模型复用 `canManagePlugin` 同款 `canManageAgent` 模式；发布时校验系统提示词非空且工具白名单均在 `toolRegistry.catalog()` 内。
- [x] 前端 Agent Studio 管理页（`src/components/dashboard/AgentStudio.tsx`，挂载在 `DashboardNavRail` 对应导航项下）：Agent 列表、创建表单（角色 ID、名称、描述、触发提示语、系统提示词、工具白名单、类型）、发布/归档操作。
- [x] `roleId` 与内置六角色（planner/researcher/analyst/builder/reviewer/synthesizer）冲突检测（`isBuiltinRoleId`，创建时后端拒绝，已用真实 HTTP 请求验证 409 响应）。
- [x] Planner 按租户读取已发布自定义 Agent，动态扩展角色 schema 和提示词；自定义角色工具调用严格按 `toolAllowlist` 过滤，目录不可用时回退内置 `fallbackPlan()`。
- [x] `agent.propose` Tool 只创建 `draft` Agent，不会自动发布；通过统一 Tool Registry 执行并保留审计边界。

验收：可创建、发布、归档自定义 Agent 定义并持久化（已用真实 HTTP/Playwright 端到端验证）；已验证发布角色进入 Planner schema、真实执行并按 `toolAllowlist` 拒绝未授权工具；Agent Store 不可用时回退内置 `fallbackPlan()`；`npm run check && npm test && npm run build` 通过。

### P1.11 登录开屏页

完整设计依据见 `docs/dashboard-agentstudio-roadmap.md` Part C。纯视觉开屏页，**不新增任何后端认证逻辑**。**尚未实现**（本轮优先完成 Dashboard + Agent Studio 主线 + 玻璃质感视觉修正，登录开屏页留待下一轮）。

- [ ] 新增 `src/components/onboarding/LoginScreen.tsx`：鼠标响应网格背景（Canvas/WebGL，网格顶点位移随鼠标接近度衰减扭曲），任意输入或点击即可进入，状态存 `localStorage`（如 `axiom-onboarding-seen-v1`），已见过则跳过。
- [ ] 原创设计 Axiom 品牌 logo，做粒子化重组动画（可参考 `particle-heart-main.zip` 的生命周期阶段状态机+参数化粒子池架构，MIT 协议，8 阶段：complete/disperse/float/return/base/rise/orbit/aggregate）。
- [ ] `App.tsx` 顶层按 `localStorage` 标记决定是否插入该屏，不影响后续路由/状态逻辑。

验收：首次访问显示开屏页，任意交互后进入主界面且不再重复显示；`npm run qa:visual` 覆盖开屏页截图。

### P1.12 视觉素材整合遗留项（尚未完成）

用户明确要求参考 douyin 目录素材，以下几项目前**只完成了调研，尚未真正落地到代码里**，如实记录避免误报"已完成"：

- [x] `3D-card-acrylic-main.zip`（无 LICENSE，用户已确认认识作者、允许复用源码）：核心"环形卡片轨道"视觉与交互逻辑已移植为 `src/components/dashboard/TaskOrbitCarousel.tsx`（拖拽旋转、点击聚焦、自动巡航、透视/景深/亚克力玻璃材质全部保留，卡片内容绑定真实历史任务/会话）；Agent 拓扑只在沉浸模式展示，旧 `AgentOrbitCarousel.tsx` 已删除。
- [x] `morphicons-main.zip`（MIT）：已安装 `morphicons` 并在任务状态、任务列表和插件画廊等动作图标中使用 `MorphIcon`；视觉回归确认图标挂载、状态切换和 reduced-motion 参数正常。
- [ ] `orb-main.zip`（MIT，用户已确认本机有 GPU，可直接嵌入 WebGPU）：尚未落地。
- [ ] `tim-ai-assistant-main.zip`（无 LICENSE，用户已确认认识作者、允许复用源码）：尚未复用任何代码。
- [ ] `particle-heart-main.zip`（MIT）：8 阶段粒子生命周期架构尚未移植，等 P1.11 登录页一起做。

### P1.13 本轮 bug 修复与环境问题（2026-08-24）

- [x] **CORS 403 回归**：为绕开这台 Windows 机器 `5173` 端口被系统保留段占用的问题，把 Vite 默认端口永久改成 `4300`，但遗漏同步更新 `.env.local` 的 `AXIOM_ALLOWED_ORIGINS`，导致新前端所有 API 请求被拒（用户报告"发送显示异常"）。已修复：`AXIOM_ALLOWED_ORIGINS` 追加 `http://127.0.0.1:4300,http://localhost:4300`，并用 Playwright 复现+验证修复前后行为。
- [x] **`CinematicCore.tsx` 的 `Core` 组件 ref 用法错误**（P1.7 遗留，非本轮引入）：`useMemo(() => new Mesh(), [])` 生成裸 Three.js 实例直接当 React ref 传给 `<mesh ref={mesh}>`，触发 `"Unexpected ref object provided"` console 报错。改为标准 `useRef<Mesh>(null)` + `mesh.current` 判空访问。
- [x] `axiom-view-mode-v1` → `v2`：避免老用户浏览器里残留的 `classic`/`immersive` localStorage 偏好继续覆盖新默认入口。
- [x] 沉浸模式（`AxiomShell`/`shell.css`）视觉统一：命令栏、Observatory 框体、推理图节点、Inspector 面板圆角从原先的"切角 HUD"风格统一为与新任务台一致的圆角+`backdrop-filter`玻璃质感，3D 核心场景本身未改动。

### P1.14 对话输入能力与 Agent 路由（2026-08-25）

- [x] 历史任务列表增加独立纵向滚动容器；Agent Graph 禁止复制节点文字并移除操作提示。
- [x] 对话 Markdown GFM 表格增加可读表头、边框和横向滚动样式。
- [x] 对话支持图片、TXT、MD、CSV、JSON、PDF、DOC、DOCX 附件；文本文件前端提取，PDF/DOC/DOCX 服务端使用 `pdf-parse`/`word-extractor`/`mammoth` 抽取后再进入模型上下文。
- [x] DeepSeek 视觉模型接入：根据当前 `/models` 响应默认使用 `deepseek-v4-flash-vision-exp`，通过 `DEEPSEEK_VISION_MODEL` 可配置；文本默认仍为 `deepseek-chat`。
- [x] 对话内自动路由联网搜索 Agent 与绘图 Agent；搜索 Agent 按任务类型选择 GitHub Repository Search（开源 Agent 项目）、Bing（普通网页）并以 DuckDuckGo 作为降级源，天气走 Open-Meteo 结构化接口，保留来源 URL、检索日期和证据边界；绘图复用图像 Provider，结果通过 SSE 附件事件回到对话，不再依赖顶部绘图按钮。
- [x] 新增 `qa:chat` 流式多模态冒烟测试，验证 `image_url` 请求、SSE token 和 Markdown 表格增量。
- [x] 新增 `qa:search-agent` 搜索 Agent 冒烟测试：校验 `2026-08-25` 日期基准、天气结构化来源、GitHub 项目字段直出、开源项目/内部 Agent Registry 路由隔离。
- [x] 核实 DeepSeek 官方原生搜索：`GET /models` 返回 `deepseek-v4-flash`，`POST /responses` 的 `tools:[{type:"web_search"}]` 已通过真实 Key 返回 `web_search_call` 和流式文本；Axiom 对 DeepSeek Provider 自动使用原生搜索，失败时回退受控 Search Provider。

### 2026-08-26 Origin 与会话持久化修复
- [x] 开发环境允许 `localhost`、`127.0.0.1`、`[::1]` 的动态端口，生产环境仅允许 `AXIOM_ALLOWED_ORIGINS` 显式来源；Origin 策略已抽取并有单元测试。
- [x] 会话历史写入 PostgreSQL/SQLite `sessions` 表，按 `tenantId + userId` 隔离；刷新、服务重启和不同本机 origin 通过远程会话恢复。
- [x] 旧任务无 session 记录时由任务输入/结果迁移历史；删除会话写入 tombstone，任务仍保留在任务管理且历史不会复活。
- [x] 保存采用 `updatedAt` 单调更新，旧标签页不能覆盖新会话；删除竞态会清理前端待同步队列。
- [x] 新增 `qa:session-persistence`：验证刷新恢复、跨 origin 恢复和浏览器 0 错误；本轮回归通过。

## P2：规模化和产品化

- [ ] S3/COS/MinIO Artifact 对象存储与生命周期管理。
- [ ] OIDC / HMAC principal / RBAC / 租户配额 / Secret Manager。
- [ ] OpenTelemetry trace、日志关联和外部 Prometheus；`metrics.ts` 当前是纯内存 counters，进程重启即清零，多副本部署下每次滚动发布会产生假的指标断崖，需评估跨重启持久化或跨副本聚合方案。
- [ ] 3D 节点悬停、Graph 双向联动、低性能降级和 WebGL 失败后备视图。
- [ ] Three.js、R3F、postprocessing 按需分包，降低约 1 MB 场景 chunk。
- [ ] 移动端 Graph 全屏、节点详情抽屉和长日志虚拟滚动。
- [ ] MCP / OpenAPI 工具市场；Agent Studio 阶段一和 Planner 动态角色接入已在 P1.10 完成，本节剩余工具授权打磨、用量统计与市场，详见 `docs/dashboard-agentstudio-roadmap.md` Part B.2-B.4。
- [ ] 多租户计费、配额、审计查询和行业工作流。

## 本轮交付记录

- [x] 修复默认工作流 Token 横杠，处理 `model.completed` 并去重 SSE 回放。
- [x] 修复 Direct Response 拓扑误显示 Planner、Reviewer、Synthesizer。
- [x] 修复暂停任务无法输入协作 note。
- [x] 让 3D Orchestrator 根据 routing/context/inference/complete/error 阶段高亮。
- [x] 增加 Graph、Loop、协作和 Token 使用说明。
- [x] 视觉 QA 按实际路由判断节点数量。
- [x] 本轮 P0.1：按依赖层级升级 Graph 视图。
- [x] 本轮 P0.2：补任务控制中心基础列表。
- [x] 本轮 P0.3：补 Reviewer 人工接管闭环。
- [x] 本轮 P0.5：补 Graph 结构断言与 Reviewer HTTP 控制 API 测试。
- [x] 本轮 P0.5：补模型 SSE 流式增量、429/超时/断线和 Artifact 故障注入测试。
- [x] 本轮业务 Case：`scripts/business-cases.json`，路由与难度验收 5/5；真实执行质量样本由 `scripts/runtime-smoke.mjs` 持续写入 `qa/runtime-results.json`。
- [x] 本轮视觉与问答修正：3D 连线改为曲线路径并从节点表面开始/结束，避免穿过节点；自定义模型的子 Agent 目录问答改为运行时 Registry 真值；比较/权衡类问题在 analyze 模式下也正确路由到 team。
- [x] 本轮视觉收尾：拓扑节点采用更宽的椭圆轨道，连接候选路径按节点碰撞边界择优，运行时标题显示 `registry / live` 角色与实例计数；新增 Agent Registry 契约测试。
- [x] 本轮 P1.1：完成模板 JSON bundle 导入导出、私有/团队共享权限、标准模板目录、模板选择运行和模板库视觉回归。
- [x] 本轮 Harness 参考核查：固定 DeepSeek Harness `0.1.0-rc.8` 与 Codex `main` 压缩包，确认采用“适配器 + 统一事件”而非源码揉合。
- [x] 本轮 Harness 基础升级：新增 `HarnessAdapter`、Builtin adapter、Thread/Turn/Item/Approval 事件归一化和有界重放去重测试。
- [x] 本轮 P1.6：声明式用户 Prompt Plugin 的创建、发布、租户可见性、快速运行和 Task lineage 闭环。
- [x] 本轮前端交互收敛：插件改为左侧完整工作区；插件与模板控制区提高字号并减少长说明。
- [x] 本轮前端重构：主运行页移除非功能介绍，改为任务启动台；系统说明、执行边界和参考方向独立到说明页。
- [x] 本轮界面中文化：可见业务文案统一中文，仅保留 Agent、Graph、Loop、Harness、Artifact、Token、Provider、SSE 等专有名词。
- [x] 本轮 P1.2：加入 database.query、http.fetch、browser.open、document.read、table.read 的受限只读适配器，并补充安全策略与回归测试。
- [x] 本轮沉浸式前端：新增可切换的 Immersive Control Room，复用真实 Task/Event/Graph 数据，提供 3D 粒子核心、动态 Agent 网络、推理图、事件流、动态计数、玻璃态 HUD、金属质感和幻灯片式视图过渡；经典工作台保留为备用入口。
- [x] 本轮 P1.3 步骤契约：Planner 步骤支持 model、toolNames、maxTokens、maxDurationMs 和 failureStrategy；运行时传递 Provider 预算、限制 Builder 工具白名单，并支持 skip/pause 的恢复语义。
- [x] 本轮 Direct 路由校正：轻量问答不再发出 Planner、Reviewer 或 Artifact 假事件；事件流显示为直接响应，复杂工作流事件仅来自真实流程。
- [x] 本轮 APEX-UI 视觉参考：按 MIT 开源 ApexUI 的 Luminous Particle Ocean、Parallax、Glare/Glass 交互方向重构沉浸核心，加入指针响应粒子海、动态高光和视图进入过渡；不复制外部源码，经典工作台与原有沉浸页面均保留为回退入口。
- [x] 本轮首屏切换：沉浸控制台改为首次进入默认视图，用户返回经典工作台后持久化经典偏好；两套前端均可从入口互相切换。
- [x] 本轮前端重构：新增 Axiom Studio 空间工作台，重做首屏信息架构、Command Bar、轨道/网络/事件视图、节点聚焦检查器与移动端导航；旧 Mission Deck、Immersive Control Room 和经典工作台保留为回退入口，并备份至 `frontend-backup/20260822-093402-pre-studio`。
- [x] 本轮 P1.3：Agent 间结构化消息与中间 Artifact 共享；依赖步骤通过 `agent.message` 传递上游输出和 Artifact 引用，并补充运行时烟测，验证事件顺序、流式增量、终态和审查结果。
- [x] 本轮 P1.3 调度增强：并行 Agent 的明确正/负结论冲突会持久化为 `agent.conflict` 并进入 Reviewer 上下文；Token 预算接近上限时自动压缩并行步骤并记录 `budget.constrained`，补充冲突与预算回归测试。
- [x] 本轮 P1.9+P1.10：新建任务台 Dashboard（三栏布局、真实统计卡片、依赖层级列表态、历史任务玻璃轨道）与 Agent Studio（自定义 Agent 定义 CRUD、内置角色冲突检测、Planner 动态角色接入），设为新默认入口；沉浸模式保留真实 Agent Graph 与 3D 核心，旧经典工作台不再保留；`getTaskStats`/`agentStore`/自定义 Agent API 均已用真实 HTTP 请求和 Playwright 无头浏览器验证（0 console error）。P1.11 登录开屏和 P2 规模化能力仍按未完成项保留。

### 2026-08-25 frontend-rebuild-v2 执行记录
- [x] P0.6/P0.7 安全一致性与 Readiness 真实探测已完成，补充 metadata/IPv6 SSRF、Docker probe 和真实 Provider/Memory 探测测试。
- [x] P1.7/P1.8 前端重建与协作事件可视化已完成：旧前端物理删除，Dashboard/沉浸模式双视图，历史任务轨道、真实 Graph 彩带和协作消息/冲突/预算事件均消费 Task/Event/SSE 数据。
- [x] P1.10 自定义 Agent 动态 Planner、工具白名单、Agent Store 故障回退和 `agent.propose` draft 工具已完成；P1.6 mini-app 使用 `sandbox="allow-scripts"` iframe，未授予 `allow-same-origin`。
- [x] 本批新增回归测试后共 `56 tests passed`；`npm run check`、`npm test`、`npm run build`、`npm run qa:routing`、`npm run qa:runtime`、`npm run qa:visual`、`npm run qa:chat`、`npm run qa:search-agent` 全部通过。

## 标准验证命令

```bash
npm run check
npm test
npm run build
npm run qa:routing
npm run qa:runtime
npm run qa:visual
npm run qa:chat
npm run qa:search-agent
```

### 2026-08-25 DeepSeek 原生能力适配
- [x] 增加 Provider capability registry，并在 `/api/health` 暴露 DeepSeek 的 text/vision/web_search/function_call/responses_stream/json_output/file_image 能力边界。
- [x] Planner 保持 JSON Output + Axiom schema 校验；Builder/自定义 Agent 可向 DeepSeek 声明原生 function tools，模型调用统一回收到 Tool Registry，继续执行白名单、审批、配额、审计和沙箱策略。
- [x] 适配 DeepSeek Function Call 工具名约束：模型协议层使用 `axiom_*` 安全别名，返回后映射回带命名空间的真实 Tool Registry 名称，不改变权限、审批、配额和审计契约；`qa:runtime` 已验证原生工具调用路径。
- [x] 增加 DeepSeek Files API 图片上传与 24 小时内存缓存；上传失败自动回退 inline `image_url`，不影响自定义 Provider。
- [x] 新增 `docs/deepseek-native-capabilities.md`，明确 DeepSeek 原生 API 与 Axiom 执行层的职责边界。
- [x] 增加扫描 PDF 页面渲染、页码/表格上下文和 Vision 分页分析；扫描 PDF 限制前两页/1200px 宽度，文本 PDF 保留页码标记和表格 Markdown。
- [ ] 为 PDF 页面视觉分析补充真实扫描样本和引用定位回归测试。

### 2026-08-26 对话语义路由与会话一致性

- [x] 所有新消息先经过服务端语义路由，按普通对话、Agent Registry、联网搜索、论文搜索、GitHub 研究、绘图、图片识别、文档分析和普通任务分配专用 Agent。
- [x] 天气、新闻、价格、论文、GitHub 与其他实时外部事实统一优先使用 DeepSeek `deepseek-v4-flash` `/responses` + `web_search`；普通对话自定义 Provider 不得关闭或替代专用搜索 Agent。
- [x] “有哪些 Agent / 是否支持某能力”改为读取内置 Registry、网关 Agent、Provider 探测结果与当前可见自定义 Agent 后由模型动态回答，不再返回固定六角色文案。
- [x] Assistant 消息持久化 `taskId`、路由与 Agent 角色，历史任务只更新精确绑定的回答，不再回退覆盖首条 Assistant 消息。
- [x] 新建或切换会话只断开本地 SSE 观察，不再隐式调用任务取消；返回原会话时按 `activeTaskId` 自动恢复持久化事件流。
- [x] 同一会话的简单追问保留最近一次实质多 Agent Graph；重新选择会话时优先恢复最近的非 direct 工作流 Graph。
- [x] 任务管理按 `sessionId` 聚合同一会话的普通任务；Agent Nexus 按 `templateId` 聚合跨执行会话的同一智能体流，相同标题的不同普通会话不再错误合并。
- [x] 修复任务卡片删除只移除代表运行的问题：删除卡片时会提交该分组的全部终态运行 ID，删除后从服务端权威列表刷新；新增 `qa:task-delete` 覆盖同一会话多次运行的端到端回归。
- [x] 增加 `qa:session-routing` 端到端回归，覆盖 PostgreSQL/SQLite 多 worker 团队任务、追问“你在吗”、旧回答与 Graph 不变，以及新建会话不取消运行中任务；真实验收结果为 team、4 个 Graph Agent、0 次导航取消请求。
- [x] 本轮标准验收完成：`npm run check`、`npm test`（67/67）、`npm run build`、`qa:chat`、`qa:search-agent`、`qa:routing`（4/4）、`qa:business`（5/5）、`qa:runtime`、`qa:session-routing`、`qa:visual` 全部通过；视觉验收浏览器控制台 0 错误。

### 2026-08-26 日期、历史记录与 Graph 恢复一致性

- [x] 每日工作进程和 Token 趋势按 `AXIOM_TIME_ZONE` 业务时区生成连续自然日，默认 `Asia/Shanghai`；当天没有 Token 消耗时仍返回当天的 0 值，前端时间线默认选择当天。
- [x] 空白会话不再写入本地或远端存储；连续点击新建复用同一个空白草稿；远端会话按 `sessionId` 合并并清除无存活任务对应的过期 `pending` 状态。
- [x] 全部会写数据的浏览器 QA 使用独立租户并在结束后清理；增加 dry-run QA 污染清理器和数据隔离回归，历史明确 QA 记录已清理，真实同名会话不按标题粗暴合并。
- [x] 会话切换按 Assistant 消息的真实 `taskId` 恢复对应工作流；完成任务的规划期 `running/queued` Graph 快照与持久化步骤结果统一规范化，历史 Agent 不再永久显示“思考中”。
- [x] 增加会话 DOM ID 唯一性、空白草稿、Graph 精确恢复、终态 Agent、导航不取消后台任务和分组任务删除回归；本轮 `npm run check`、`npm test`（79/79）、`npm run build`、`qa:data-isolation`、`qa:session-persistence`、`qa:task-delete`、`qa:session-routing`、`qa:visual` 全部通过，浏览器控制台 0 错误。

### 2026-08-26 DeepSeek 严格搜索与历史 QA 数据清理

- [x] 所有需要联网检索的意图只允许调用 `deepseek-v4-flash` 的 `/responses + web_search`；移除运行分支中的 Open-Meteo、Bing、DuckDuckGo、GitHub API 和普通对话模型降级。
- [x] DeepSeek 搜索失败或未配置时返回 `deepseek-native-search-failed` 与 `fallbackDisabled=true`；脱敏诊断仅写服务端日志，用户回答使用简短的 Search Agent 失败提示，不暴露 Provider、API 或服务端时间。
- [x] DeepSeek 搜索结果未返回 URL 时，在最终回答中仅标注“本次检索未返回可点击来源链接”，不伪造来源，也不展示搜索实现元数据。
- [x] 修复本地 QA 清理器未覆盖旧英文/乱码测试文案以及暂停任务无法删除的问题；清除隔离上线前产生的 72 个 QA 会话和 72 个 QA 任务，追加清除 1 个暂停任务，普通 `hello`、“你是谁”等未命中数据保持不变。
- [x] 严格搜索回归覆盖天气、GitHub 研究、无效 DeepSeek Key 和 Agent Registry：成功路径均为 `deepseek-native-search`，故意失败路径为 `deepseek-native-search-failed`；`npm run check`、`npm test`（79/79）、`npm run build`、`qa:search-agent`、`qa:data-isolation`、`qa:visual` 全部通过。

### 2026-08-27 历史运行态与搜索回答完整性

- [x] localStorage 恢复时不再信任旧 `activeTaskId/pending`；远端会话仍保留较新的消息内容，但运行态只由服务端存活任务决定，避免打开历史后永久显示执行中。
- [x] “模型生成中/持续生成”替换为真实路由、Gateway 状态与 Workflow Event 驱动的 Agent 动作文案；模型增量事件也以执行 Agent 的阶段行为呈现。
- [x] 搜索回答不再追加模型名、API 类型和服务端检索时间；历史搜索回答在恢复时自动清理旧技术尾注。
- [x] 原生搜索输出预算默认提高到 6144；`response.incomplete` 不再当成功，首次超限会清空不完整内容、压缩条目并重试一次，二次不完整则返回明确失败而不保存半截 Markdown。
- [x] `qa:search-agent` 增加 reset 事件解析、游戏 GitHub 长列表完整性、未闭合 Markdown 与技术元数据断言；`qa:session-persistence` 增加“本地较新且引用不存在任务”的 stale pending 回归。
- [x] 补齐可恢复等待态边界：仅 `queued/planning/running/reviewing` 显示 Agent 执行动画；`awaiting_approval/waiting_for_human/paused` 显示真实等待原因，不再标记 Assistant pending，也不恢复 Graph 运行态。
- [x] 截图中的质量审核历史已按真实任务数据原位修复：合并同时间戳重复用户消息，保留任务与 9 个步骤结果，Assistant 显示“审查 Agent 已完成质量检查（75/100），当前结果需要你确认。”
- [x] 新 Dashboard 右栏接通真实人工质量审核：历史 `waiting_for_human` 任务恢复审批态，支持审核意见、批准交付、驳回整改与毛玻璃二次确认；右栏可滚动且操作区保持可见，操作后刷新服务端权威状态。新增隔离 `qa:human-review`，验证取消不产生审批请求；`npm run check`、`npm test`（84/84）、`npm run build`、`qa:human-review`、`qa:session-persistence`、`qa:visual` 全部通过，浏览器控制台 0 错误。

### 2026-08-27 平台中文展示一致性

- [x] 新增 `src/lib/taskPresentation.ts` 中文展示层：任务类型、难度、路由、阶段、路由依据、Agent 类型、发布状态和 Readiness 状态统一中文显示，内部枚举、数据库值和 API 协议保持不变。
- [x] Dashboard 右侧任务详情、任务轨道、每日工作进程、智能体工作室和备用电影级 Shell 的普通英文已改为中文；保留 AXIOM、Agent、Agent Graph、Tool Registry、Harness、Loop、Artifact、Token、API、URL、SSE、DeepSeek 等产品或技术专用名词。
- [x] 对已持久化的旧 Reviewer 英文摘要、缺口和整改项增加精确展示映射；未来 Planner/Reviewer 的中文任务从源头要求人类可读字段使用简体中文，角色 ID、步骤 ID、Schema key 和枚举值保持协议原值。
- [x] Readiness 探测、工具目录和运行时默认说明统一中文；健康探测失败不再把底层纯英文异常直接展示给用户。
- [x] 新增 `src/lib/errorPresentation.ts` 用户错误展示边界：纯英文 Provider/API 错误回退为对应中文操作提示，保留 HTTP 状态码；已有中文说明、用户输入、模型回答、代码和外部文件内容不做强制翻译。
- [x] 修复工具人工批准/驳回事件中的四处乱码；系统生成的暂停原因改为中文。
- [x] 大范围修改前已备份到 `frontend-backup/20260827-122911-platform-chinese-presentation`；最终 `npm run check`、`npm test`（88/88）、`npm run build`、`qa:human-review`、`qa:session-persistence`、`qa:visual` 全部通过，右栏中文展示、Readiness 中文展示、桌面/移动端布局和浏览器 0 错误均已验证。

### 2026-08-27 普通用户模型与创作服务配置

- [x] 插件入口迁入左侧“新建任务”下方，插件列表、创建、发布和运行使用完整主工作区，不再使用插件管理弹窗；Mini App 结果继续在无同源权限的隔离窗口运行。
- [x] 模型设置删除界面主题、执行策略、Token/成本/时长/并行节点等普通用户无需理解的参数，只保留文本、视觉、绘图和视频四类独立服务配置。
- [x] 文本模型与视觉模型拆分请求契约；默认保持 `deepseek-chat` 与 `deepseek-v4-flash-vision-exp`，自定义 API Key 仍只保存在当前页面内存。
- [x] 新增 `video-generation` 语义意图和视频制作 Agent；支持本地服务 URL、可选 API Key、模型名称、同步 URL 与常见异步任务查询响应，未配置或响应不兼容时明确失败。
- [x] 视频附件支持 SSE、对话内播放和会话持久化；服务端健康信息与 Agent Registry 如实报告视频服务是否已配置。
- [x] 普通任务不再由前端提交 Token 或并行上限；运行时按依赖图自动选择可并行步骤，系统默认安全并行上限提高到 6，并仍可由环境变量收紧。
- [x] “生产门禁”重写为真实的“系统运行状态”：首屏只显示模型服务、任务记录、文件与工具、长期记忆，技术探测详情折叠；设置、运行状态和插件工作区统一毛玻璃视觉。
- [x] 修复插件页重复刷新竞态：进入页面只触发一次列表请求，同一时刻只允许一个刷新请求，刷新状态稳定结束且不会交替显示错误；左栏删除“设置”，模型配置只保留右上角入口，并加入真实浏览器回归断言。
- [x] 本轮标准验收完成：`npm run check`、`npm test`（89/89）、`npm run build`、`npm run qa:visual`、`npm run qa:session-persistence`、`npm run qa:human-review` 全部通过；桌面与移动端无横向溢出，浏览器控制台 0 错误。

### 2026-08-27 插件设计 Agent 与模型来源

- [x] 大范围改动前快照保存到 `frontend-backup/20260827-163500-plugin-agent-provider-location`。
- [x] 插件工作区提供“Agent 创建”和“自定义创建”两个真实入口；Agent 创建使用当前文本模型生成结构化提示词插件草稿，经 Zod 校验和 Tool Registry 工具过滤后写入 PluginStore。
- [x] 文本、视觉、绘图、视频四类模型都支持“互联网 API / 本地服务”来源选择，旧配置按 URL 自动迁移；来源类型随聊天、语义路由、绘图、视频和插件 Agent 请求发送到服务端。
- [x] 本地 OpenAI 兼容服务允许省略 API Key 且不发送空 Authorization；服务端拒绝来源类型与 URL 不匹配的配置，覆盖回环、局域网、Docker 主机名、本地域名和公网域名。
- [x] 标准验收完成：`npm run check`、`npm test`（93/93）、`npm run build`、`npm run qa:visual` 全部通过；插件 Agent 持久化、来源分类、本地无密钥请求、两个创建入口与四组来源控件均有自动化回归覆盖，浏览器控制台 0 错误。

### 2026-08-27 模板主工作区与导航收敛

- [x] 大范围改动前快照保存到 `frontend-backup/20260827-templates-main-workspace`。
- [x] 模板库从弹窗迁移为 `TemplateWorkspace` 完整主工作区，保留标准模板创建、JSON 导入、发布、共享、取消共享、导出和使用模板的真实业务能力。
- [x] 模板目录与用户模板统一使用 Dashboard 毛玻璃视觉；选中的已发布模板使用绿色状态反馈，桌面与移动端均无横向溢出。
- [x] 模板加载改为进入页面时按需读取，并对模板列表与标准目录的并发刷新去重；刷新状态稳定结束，不再与挂载请求竞态。
- [x] 左侧删除与右上角重复的“工具与就绪”，系统运行状态只保留右上角扳手入口。
- [x] 标准验收完成：`npm run check`、`npm test`（93/93）、`npm run build`、`npm run qa:visual` 全部通过；模板主工作区、毛玻璃、无弹窗、单次刷新、导航收敛和浏览器控制台 0 错误均已纳入回归。

### 2026-08-27 对话 Artifact 与 Agent Mini App

- [x] 大范围改动前快照保存到 `frontend-backup/20260827-chat-artifacts-agent-miniapps`。
- [x] 对话回复和上传文件支持 Markdown、SVG、HTML 识别与渲染；SVG/HTML 使用无同源权限的 sandbox iframe，Markdown 支持 GFM 表格，每个 Artifact 均可复制源码并按正确扩展名下载。
- [x] Artifact 文档注入严格 CSP：禁止联网、嵌套页面、对象和表单提交；SVG 禁止脚本，HTML 仅允许自包含内联脚本，不使用 `dangerouslySetInnerHTML`。
- [x] 插件创建改为“空白 Mini App 外壳 + Agent 持续开发”流程；创建前可设置名称、说明、私有/团队范围、打开宽高和八种材质或随机材质。
- [x] 插件目录改为毛玻璃方形图标阵列，每个图标包含四层动态圆环、稳定随机材质和下方名称；旧插件可稳定派生外观，新插件外观持久化到 SQLite/PostgreSQL。
- [x] 插件开发工作区提供连续 Agent 对话与实时预览；每轮 Agent 返回完整自包含 HTML，保存修改摘要、最近 24 条设计对话和版本历史，并复用当前平台文本模型配置。
- [x] Mini App 使用独占式全屏毛玻璃模态层，同一时间只打开一个；窗口尺寸来自插件配置，主页面操作被遮挡，`Escape` 或关闭按钮退出。
- [x] 插件内 Agent 通过受控 `postMessage` 桥接平台语义路由，可分配普通文本、DeepSeek 搜索、论文、GitHub 等现有 Agent；iframe 不能直接访问平台 API 或互联网，请求来源限定为当前插件 iframe，单插件同一时刻只执行一个 Agent 请求。
- [x] 插件支持所有者或租户管理员永久物理删除；删除确认明确提示不可恢复，SQLite/PostgreSQL 均实现真实删除并覆盖租户权限测试。
- [x] 修复 Prompt/Mini App definition schema 非 strict 导致 Mini App HTML 可能被静默丢弃的问题，两类插件定义现已严格互斥。
- [x] 自动回归扩展到 96 项测试；视觉 QA 覆盖八种材质、四层圆环、Agent 设计区、独占窗口、不可恢复删除提示和三类 Artifact 的真实 iframe/DOM 渲染，临时数据使用隔离租户并在结束后删除。
### 2026-08-27 插件开发 SSE 对话闭环

- [x] 插件开发对话改为真实 SSE：发送后立即显示用户消息和 Agent 工作状态，持续更新读取上下文、模型生成、重试、校验保存和生成字符进度；消息区自动滚动到最新状态。
- [x] 完整 HTML 只在结构校验通过后保存和刷新预览；流式失败保留用户指令和错误状态，不保存不完整版本；切换或离开插件时中止旧流，避免跨插件回写。
- [x] 插件发布成功后直接退出设计页并返回插件目录；发布失败仍停留在当前插件并显示错误。
- [x] 新增 SSE 接口回归，覆盖权限拒绝、模型未配置、事件顺序、进度、完成版本和非法输出不落库；标准验收为 `npm run check`、`npm test`（98/98）、`npm run build`、`npm run qa:visual` 全部通过。
### 2026-08-27 Mini App 窗口尺寸持续配置

- [x] 草稿和已发布 Mini App 的设计页新增“窗口大小”编辑器，可在创建后继续修改宽高；范围与创建流程一致，为宽 `320–1200px`、高 `240–900px`。
- [x] 保存通过 PluginStore 版本更新持久化完整插件定义，并同步目录、设计页和当前 Mini App 数据；重新打开插件使用最新尺寸，保存失败保留编辑器和错误提示。
- [x] 视觉回归真实执行 `640×480 -> 700×520` 的 PATCH、退出设计页并重新打开插件，浏览器实测窗口为 `700×520`；`npm run check`、`npm test`（98/98）、`npm run build`、`npm run qa:visual` 全部通过，控制台 0 错误。

### 2026-08-27 历史会话定位与 Agent Graph 鲁棒性

- [x] 历史会话切换改为 `useLayoutEffect` 在浏览器绘制前直接定位到底部，消息容器禁用平滑滚动；视觉回归用 26 条长历史消息验证首帧 `scrollTop` 与底部位置完全一致，不再出现从顶部滑到底部的过程。
- [x] Agent Graph 新增运行时结构校验：拒绝重复节点、悬空依赖、非法边、自环、重复边和循环图；实时事件与持久化恢复均失败关闭，不让损坏快照进入可视化状态。
- [x] Graph 更新增加按任务隔离的单调 `sequence` 游标；重复事件和旧事件不能覆盖新 checkpoint，切换会话后的迟到事件不能污染当前会话。
- [x] Dashboard Graph 可见容量由 8 提升到 16，超过 8 个节点启用中心加双环高密度布局；实时 Agent 状态保留容量由 10 提升到 24，超限时明确显示“可见数/总数”而不是静默隐藏。
- [x] `agent.started`、`agent.retrying`、`agent.completed`、`agent.failed` 事件补齐 `role/title/objective/dependsOn`；连字符自定义角色不再依赖不可靠的 Agent ID 字符串拆分。
- [x] `qa:runtime` 改为隔离租户测试后自动取消并物理删除自身任务；本轮已物理清理 `runtime-smoke` 隔离租户历史遗留的 33 条终态测试任务及其级联事件，后续调度回归不再向数据库累积测试任务。
- [x] 标准验收完成：`npm run check`、`npm test`（104/104）、`npm run build`、`npm run qa:visual`、`npm run qa:runtime`、`npm run qa:session-routing`、`npm run qa:agentgraph3d` 全部通过；真实运行时任务产生 339 个连续事件并完成 Reviewer 门禁，会话路由实测为 4 Agent 的 `team` 工作流。

### 2026-08-28 手动 Agent 工作流编排

- [x] 大范围改动前快照保存到 `frontend-backup/20260828-agent-workflow-studio`，覆盖 `src/`、`server/`、`scripts/`、`TODO.md` 和 `package.json`。
- [x] 左侧新增“工作流编排”完整工作区；提供已保存工作流、平台 Agent、工作流私有 Agent、拖拽画布、平移缩放、端口连线、节点检查器和对话式运行区，不使用独立弹窗。
- [x] 普通连线编译为确定性依赖 DAG，支持顺序、并行分支和汇合；Loop 使用最大 `2–12` 轮的显式回边，保存时展开为无环执行步骤，禁止普通环、自环、悬空节点、重复连线、不可达输出和无界循环。
- [x] 工作流私有 Agent 只嵌入当前工作流定义，不写入 `user_agents`；保存时把系统提示词、工具白名单、模型、预算、超时和失败策略冻结到 `WorkflowStep.agentContract`，恢复任务不依赖可变 Agent Studio 记录。
- [x] 工作流保存、版本、私有/团队可见和 PostgreSQL/SQLite 持久化复用现有版本存储，但通过 `kind=agent-workflow` 和存储级查询与普通模板隔离；创建者/管理员才可修改和删除，跨租户读取返回 404。
- [x] 工作流执行复用真实 Task/Run/Event/SSE、依赖并行、Agent Message、Checkpoint、Graph、工具审批、暂停/恢复和最终 Synthesizer；手动画布携带 `full-workflow` Profile，运行时跳过自动 Planner，不改写用户步骤。
- [x] 已配置的联网搜索、论文搜索、GitHub 研究、绘图和视频 Agent 作为服务 Agent 接入画布；搜索强制 DeepSeek `/responses + web_search`，绘图返回可渲染 Markdown 图片，未配置服务在 Agent 库中禁用并说明原因。
- [x] 视觉回归覆盖主工作区、毛玻璃、输入/Agent/输出节点、SVG 连线、节点拖拽、Loop 模式、工作流保存、私有 Agent 创建、检查器、对话运行区、桌面/移动端无横向溢出和浏览器控制台 0 错误。
- [x] 新增 `qa:workflow` 在线烟测：真实保存并运行两轮 Loop，SSE 得到 127 个连续事件，四个展开步骤全部启动，逐层 Checkpoint/Graph 更新和最终答案完整，测试任务与工作流自动清理。

### 2026-08-28 动态 Agent 与 Skill 语义路由

- [x] 系统设计、平台规划、架构和数据流类输入不再依赖用户写出 Agent 名称；确定性分类将其提升到 `team` 或 `full-workflow`，语义模型不得把较高复杂度降级为直接回答。
- [x] Planner 计划不足时按当前任务类型补齐必要的研究、分析和实现角色，只补缺失角色，不把所有平台 Agent 无脑加入每轮执行；系统级“设计一个平台”即使只返回一个步骤，也会补齐研究员、分析员和构建员。
- [x] 同一会话的后续输入按最新语义创建增量调度：只运行本轮真正相关的 Agent，保留历史 Graph，并对同角色直达 Agent 去重；不同角色或新能力才增加 Graph 节点。
- [x] 复杂会话后的搜索、论文、GitHub、文档、视觉、绘图、视频和 Agent 查询等专用直达 Agent 会追加到当前 Graph，并实时更新完成/失败状态；普通寒暄不会增加节点。
- [x] 新增运行时 Skill 目录与 `/api/runtime/skills`，Skill 作为受限指令能力按 Agent 角色和用户输入筛选；工作流 Agent、直达 Gateway 和原生搜索均只接收本轮相关 Skill。
- [x] Agent 生命周期和 Graph 节点携带 `skillIds`；Inspector 可查看本轮技能；最终 Synthesizer 节点及其依赖写入持久化 Graph，历史恢复与实时事件保持一致。
- [x] 新增系统设计、专用 Agent 与 Skill 隔离测试，以及运行时 Skill API 测试；Skill 只扫描最新一条用户输入，历史轮次的搜索/绘图关键词不会污染当前 Agent；本轮 `npm run check`、`npm test`（136/136）、`npm run build` 全部通过。
- [x] 浏览器会话回归覆盖“复杂任务 → 普通寒暄 → Agent 注册表查询”：寒暄不改变原 Graph，专用 Agent 查询会追加 Graph 节点；`npm run qa:session-routing` 通过。
- [x] 自定义文本 Provider 的可恢复工作流绑定：任务只持久化租户/用户隔离的 `modelCredentialId` 引用，不写入明文 API Key；多 Worker 恢复时由服务端重新解密并创建 ModelClient，一次性明文 Key 仍保留直连 Gateway 兼容路径。
- [x] 直达专用 Agent 追加的 Graph 节点已纳入 Session Store：SQLite/PostgreSQL 使用受限 `graph_json` 快照持久化，跨刷新/跨会话恢复，状态更新以 ref 为单一时序来源；任务 Graph 仍独立留在 TaskStore，避免把任务快照混入普通会话；API 回归覆盖结构校验、租户隔离和删除墓碑。
- [ ] 工作流附件输入与视觉/文档 Agent 节点尚未接入；需要先定义节点间二进制 Artifact 引用、大小限制和跨 Worker 对象存储协议，不能复用浏览器内存附件冒充持久化能力。
- [x] 高级控制流支持条件分支、多个独立 Loop 与嵌套 Loop；编译器使用稳定 `loopPath` 展开为最多 256 个无环步骤，并在运行时持久化 branch/loop 事件。

### 2026-08-28 Agent 工作流易用性与稳定性修复
- [x] 工作流工作台改为分项容错加载：工作流、平台 Agent 与工具目录任一接口短暂失败时，不再阻断画布和其余能力；所有来源不可用时安全降级为空列表。
- [x] 左侧工作流与 Agent 列表固定为独立纵向滚动区域，增加稳定滚动槽和边界回弹控制，内容增加时不挤压画布。
- [x] 修正输入、Agent、输出三种卡片的真实宽高参与连线几何计算，连接端点落在端口中心；普通连接和 Loop 回边增加端点类型校验，并支持拖到输入端口完成连接。
- [x] 用户界面统一使用“Agent 设置 / Agent 目标 / Agent 能力 / 连接设置”，隐藏模型覆盖、Token、超时和失败策略等高级参数，执行参数由平台默认策略自动安排。
- [x] 工具注册名改为中文能力名称，支持展开查看能力说明；底层 registry 名称和执行协议保持不变。
- [x] Agent 画布、平台 Agent 列表和工作流私有 Agent 使用 Emoji 标识并持久化 icon 字段，旧工作流按名称和角色自动回退到稳定图标。
- [x] 增加来源接口部分失败与全失败单测，并在视觉 QA 中覆盖滚动样式、Agent 术语、Emoji 和连线端点几何；完成 `npm run check`、`npm test`、`npm run build`、`npm run qa:visual`、`npm run qa:workflow`。

### 2026-08-28 Agent Nexus 三栏工作台
- [x] 工作流编排工作区更名为 `Agent Nexus`（智能体枢纽）；左侧保留 Agent 目录，中间画布收窄，右侧改为与画布同高的竖直运行区，消息和输入框始终可见。
- [x] Agent、输入端、输出端和连接设置改为点击后打开工作台内毛玻璃弹窗；弹窗支持修改、保存并关闭，不再占用画布网格空间，遮罩开启时阻止背景误操作。
- [x] 增加拖拽与点击判定，拖动 Agent 后不会误打开设置弹窗；Escape、关闭按钮和遮罩均可退出设置。
- [x] 视觉 QA 覆盖右侧运行栏、弹窗不改变布局、输出/Agent 选中状态一致性和拖拽回归；完成 `npm run check`、`npm test`、`npm run build`、`npm run qa:visual`、`npm run qa:workflow`。

### 2026-08-28 工作流选中状态布局修复
- [x] 修复条件错误提示导致工作流画布落入 `auto` 网格行的问题；选中“输出”或“Agent”时，工作流网格始终占满主体区域，运行区贴合底部，不再出现下方空白。
- [x] 视觉 QA 增加输出/Agent 选中状态的网格高度与底边一致性回归断言 `workflowSelectionKeepsLayoutStable`。

### 2026-08-28 Agent Nexus 导航与设置体验修复
- [x] 修复运行区消息末尾 `scrollIntoView()` 误滚动外层工作区的问题；切换到 Agent Nexus 后始终从顶部进入，手机和窄屏不再落在画布中段。
- [x] 保留 Nexus 级设置入口：名称、说明、私有/团队可见范围可在毛玻璃弹窗中保存；删除操作改为二次确认并沿用现有持久化删除接口。
- [x] 重新执行 `npm run check`、`npm test`、`npm run build`、`npm run qa:visual`、`npm run qa:workflow`，全部通过。

### 2026-08-28 Agent Nexus 弹窗定位修复
- [x] 修复设置面板继承检查器 `grid-area` 导致弹窗偏右的问题；弹窗改为视口级遮罩并强制面板水平、垂直居中，覆盖桌面与移动端。
- [x] 未保存修改指示器改为琥珀色状态点，并补充无障碍名称 `存在未保存更改`，避免白点含义不明。
- [x] 视觉 QA 增加 `workflowInspectorModalCentered` 与 Nexus 设置字段断言；完整回归全部通过。

### 2026-08-28 Agent Nexus 会话恢复与上下文
- [x] Nexus 运行会话使用稳定的 `agent-nexus-<workflowId>` 标识；每次执行携带最近 24 条对话上下文，Agent 可理解同一 Nexus 内的连续追问。
- [x] 上下文自动摘要：普通对话、主页工作流和 Agent Nexus 在超过 16 轮或 48K 字符时，保留最近 12 轮原文并将更早消息压缩为有界摘要；摘要仅用于模型请求，不修改历史记录，附带回归测试。
- [x] 上下文预算增强（第一阶段）：增加可替换 tokenizer 接口、默认保守 Token 估算、`AXIOM_CONTEXT_MAX_TOKENS` 配置，并在摘要结果返回版本号、覆盖范围和估算用量；即使预算很紧也保留最新用户输入。
- [ ] 摘要后续增强：改用 tokenizer 级预算，并持久化摘要版本、覆盖范围、Artifact/审批引用和压缩质量指标。
- [x] 重新进入 Nexus 时从该 Nexus 的已持久化任务恢复用户输入和最终 Agent 输出；不同 Nexus 的历史互不串线，不污染普通对话历史。
- [x] 新增 `qa:workflow-history` 回归烟测，验证离开工作区再进入后历史消息仍可见。
- [x] 2026-08-28 Scheduler reliability: failure backoff, dead-letter state, resume API, tenant isolation regression tests, and dashboard status display.
- [x] 2026-08-28 Dashboard navigation recovery: URL view/task/session state, refresh and browser history restoration with invalid-id fallback.
- [x] 2026-08-28 Agent Studio usability: natural-language-first creation, automatic identifiers and prompts, advanced settings collapsed.

### 2026-08-29 Provider 凭据安全与可恢复调用
- [x] 新增 PostgreSQL/SQLite `provider_credentials` 仓库，按租户和用户隔离，API Key 使用 AES-256-GCM 加密，接口只返回元数据与引用 ID。
- [x] 普通聊天、语义路由、视觉分析、绘图、视频和插件 Agent 支持 `credentialId`，服务端执行时解密并记录最近使用时间，客户端不再持久化明文 Key。
- [x] 设置页增加“安全保存凭据 / 更新安全凭据”入口；保留一次性直连兼容路径，未配置 `AXIOM_PROVIDER_SECRET` 时不会伪装成已安全保存。
- [x] 增加凭据仓库单元测试：加密不回显、用户/租户隔离、错误密钥配置和删除权限。

### 2026-08-29 性能与可恢复模型路由修复
- [x] Readiness 真实探测增加 5 秒短 TTL 缓存、并发探测合并和未配置依赖跳过，避免每次页面刷新触发昂贵健康调用；失败状态仍保持 `degraded`。
- [x] 任务列表事件遥测改为按任务批量聚合，PostgreSQL/SQLite 均在同一查询内执行租户隔离，消除 N+1 查询。
- [x] `queued`、`paused`、`awaiting_approval` 和 `waiting_for_human` 任务取消后立即进入终态并落库 `task.cancelled`，避免人工门禁任务无法删除或长期占用资源。
- [x] 修复 Orchestrator 覆盖步骤模型的问题：`WorkflowStep.model` 现在优先于任务默认模型，模型完成事件记录实际选择；补充步骤级模型回归测试。
- [x] 约束 Planner 的步骤模型选择：只接受任务默认模型、运行时模型或 `AXIOM_ALLOWED_MODELS` 中的候选；`optional-model` 等占位值会被清除，避免把自然语言占位符发送给 Provider。
- [x] 对已持久化的未知步骤模型增加上游拒绝回退：Provider 明确返回“不支持模型”时自动改用任务模型，并通过运行事件记录失败模型与回退模型。
- [x] 安全凭据引用可绑定可恢复任务：任务/重试任务只保存 `modelCredentialId`，Worker 领取后按租户和用户重新解析 Provider，重启和多 Worker 不依赖浏览器明文 Key。
- [x] 新增 `npm run perf:smoke` 可重复 GET 基准脚本，输出 `qa/performance-results.json`，覆盖 health、Readiness、运营快照和任务列表的顺序/并发延迟、吞吐和错误率；运营快照在 40 并发下 P95 约 21ms，0 错误。
- [x] `npm run qa:runtime` 真实 DeepSeek 工作流烟测通过：烟测可在规划/工具/审查人工门禁后调用真实批准 API 并按序号续接 SSE；最近一次终态为 `task.completed`，包含 383 个流式增量事件、持久化 Graph/Review/Artifact，并完成任务清理。
- [x] DeepSeek 原生搜索增加传输层重试：网络瞬断、408、409、429 和 5xx 最多退避重试 3 次；认证/参数类 4xx 仍快速失败，且响应流支持用户取消。
- [x] Vite 入口按 React、3D、Markdown、图标和动画拆分缓存块，最大 JavaScript chunk 从约 577KB 降至约 183KB，构建不再出现大包警告。
- [x] 动态模型路由基础：新增受控候选目录、成功率/延迟/Token 观测、成本提示和 `/api/runtime/model-routing` 快照；显式任务模型优先，候选池通过 `AXIOM_ALLOWED_MODELS` 配置。
- [x] 动态模型路由持久化与能力匹配：从任务事件恢复跨重启统计，按 `AXIOM_MODEL_COSTS` 中的 `kinds`/`roles` 画像叠加任务类型和 Agent 角色亲和度；无画像模型保持兼容。
- [x] 运营观测闭环：新增 `GET /api/runtime/operations` 和 Dashboard“运行观测”页，基于 PostgreSQL/SQLite 持久化任务、事件和租约展示队列深度、Worker 租约、模型/工具/Agent 表现、审查接管和 SLA；事件时间窗口增加索引，不使用前端伪造状态，覆盖 `npm run qa:operations`。

### 下一步实施顺序
- [x] 运营控制台第一批：持久化队列/Worker/模型/工具/Agent/Reviewer/SLA 快照 API 与 Dashboard“运行观测”工作区已完成，下一步在此基础上接入告警与跨重启指标。
- [x] Artifact 第一阶段：接入 S3 兼容 `ArtifactStore`，支持 AWS S3、MinIO、腾讯 COS 的 Put/Get/Delete、租户作用域对象 key、超时、`HeadBucket` Readiness 探测、路径解析和本地文件降级；最终结果在任务进入终态前写入，删除任务/会话会清理事件关联对象；工具 Artifact 写入失败不会诱发已执行工具重试。
- [x] MemoryCore L0-L3 深度接入：完成时间游标去重、来源/置信度/过期过滤、L1/L2/L3 更新删除、记忆质量指标、跨重启收据和失败补偿；真实 TencentDB endpoint 的现场验收按部署凭据单独执行。
- [x] Artifact 生命周期治理（第一版）：新增持久化 `artifact_records`/`artifact_references` 目录，记录来源、租户、任务、保留期限、引用数和清理状态；任务删除会进入待清理队列，失败记录可重试，`GET/POST /api/runtime/artifacts` 提供孤儿扫描、清理和运行观测统计；启动时自动从既有任务/事件回填目录。
- [ ] Artifact 外部存储生产验收仍待真实 MinIO/S3/COS：跨 Worker Put/Get/Delete、租户前缀隔离、断点/超时、大文件分片和跨实例清理演练。
- [x] DeepSeek Harness ACP Thread/Turn/Subscribe transport，并接入任务委托与断点恢复：ACP JSON-RPC stdio、统一事件、审批回放、Artifact/任务关联、断流暂停和跨重启恢复已通过 fake sidecar；HTTP capability discovery 仅用于兼容探测，真实 sidecar 现场验收仍需部署配置。
- [x] Codex app-server JSON-RPC stdio/sidecar transport，固定 commit、workspace 和审批策略：协议 transport 与边界测试已完成，部署固定项待现场配置。
- [x] Agent Nexus 条件分支、多 Loop、嵌套 Loop、节点级局部恢复和单节点重跑：已完成受限条件 DSL、最多 256 步展开、稳定 Loop 路径、分支事件和 rerun 检查点。
- [ ] OpenTelemetry、Prometheus、日志关联、队列/Worker 指标和跨重启持久化。
- [ ] 插件签名、兼容性检查、版本回滚、权限声明和插件市场。
- [ ] tokenizer 级上下文预算、摘要版本持久化和压缩质量评估。
- [ ] 登录开屏、3D Graph 降级视图、移动端节点抽屉、长日志虚拟滚动和场景按需分包。

### 2026-08-29 运行验收与一致性修复
- [x] 完成标准门禁：`npm run check`、`npm test`（191/191；后续回归扩展至 214/214）、`npm run build`、`qa:runtime`、`qa:visual`、`qa:operations`、`qa:routing`、`qa:business`、会话/删除/审核/Workflow/Nexus/隔离/搜索/聊天/3D Graph 回归全部通过，浏览器控制台无错误。
- [x] 完成本机并发基准：50 请求、10 并发、全部 HTTP 200；在无其他 QA 负载时 health/Readiness/运行观测/任务列表并发吞吐约 1831/2572/1116/2495 RPS，P95 约 9.0/4.7/23.6/5.3 ms（仅代表当前单节点、本机数据库规模）。
- [x] 修复本地 Artifact 文件名碰撞：清洗前缀追加内容 ID 摘要，兼容读取旧格式；写入改为临时文件 + 原子改名，补充跨 Worker 读取/删除回归。
- [x] 修复幂等键并发竞态：数据库唯一约束冲突现在复用首个任务，不再把网络重试误报为 409；补充 12 路并发任务创建回归。
- [x] 区分任务创建错误：数据库连接、超时和网络故障返回 503，草稿模板等业务冲突继续返回 409；测试服务端存储故障响应。
- [x] 清理本轮 QA 专用 `qa-human-review-session`，避免验收数据污染用户历史。

### 2026-08-29 性能、运行态与展示一致性复核
- [x] 重启 API 到当前源码版本并确认端口收敛：前端仅监听 `127.0.0.1:4300`，API 仅监听 `127.0.0.1:8787`，`4302` 未监听；健康检查、Readiness 和业务回归均使用同一 API 进程。
- [x] 验证 W3C Trace Context 响应链路：健康接口返回 `X-Trace-Id`、`traceparent`、`X-Request-Id`，CORS 暴露响应头并允许客户端传入 `Traceparent`。
- [x] 完成最新门禁：`npm run check`、`npm test`（214/214）、`npm run build`、`qa:runtime`、`qa:chat`、`qa:search-agent`、`qa:session-persistence`、`qa:data-isolation`、`qa:task-delete`、`qa:human-review`、`qa:workflow-history`、`qa:nexus-session`、`qa:workflow`、`qa:routing`、`qa:business`、`qa:operations`、`qa:agentgraph3d`、`qa:visual`、`qa:object-storage`（未配置时跳过）、`perf:smoke` 全部通过，视觉回归浏览器控制台错误为 0；`qa:session-routing` 首次受外部模型瞬态影响失败，自动重试后通过，门禁报告保留两次尝试记录。
- [x] 完成本机性能基准（50 请求、10 并发、所有 HTTP 200）：health `1755.21 RPS / P95 10.28ms`，Readiness `2616.09 / 4.33ms`，运行观测 `781.05 / 41.33ms`，任务列表 `2356.86 / 4.76ms`；结果见 `qa/performance-results.json`。该数据仅代表当前单节点和本机 PostgreSQL 数据规模，不作为公网容量承诺。
- [x] 修复单智能体和小组路由的系统阶段文案仍显示英文的问题：新运行事件使用中文标题/摘要，展示层兼容旧持久化值 `Focused task agent`、`Triage selected...`，用户输入和模型原文不被误翻译。
- [x] 修复 Artifact 迁移期间的跨租户删除风险：带租户的文件/S3 删除只触碰当前租户前缀；无租户删除仅供显式维护调用，旧无租户对象不会被普通任务删除顺手清除。
- [x] 新增可重复的 `npm run qa:all` 生产门禁：按固定顺序串行执行静态检查、单测、构建、SSE/业务/隔离/审核/工作流/视觉/性能回归；配置 `TDAI_MEMORY_ENDPOINT` 时追加 MemoryCore 真实验收，未配置时明确标记跳过。
- [x] 稳定视觉回归中的 Artifact iframe 等待：QA 现在同时确认 iframe 可见、`contentDocument.readyState === complete` 且 SVG/HTML 目标 DOM 已生成，避免资源加载竞态造成误报。

### 2026-08-29 Agent Registry 回答完整性与真实 MemoryCore 验收
- [x] Agent Registry 回答继续由本次请求的实时快照驱动；当模型遗漏内置或已发布自定义 Agent 时，运行时只追加缺失的真实名称，不返回固定目录、不泄露原始 JSON，也不重复已覆盖项。
- [x] 任务编排 Direct Response 与主页 `/api/chat` 流式路径均补发动态目录增量，历史任务结果和实时 SSE 展示保持一致；普通聊天和非 Registry 路由不触发补齐。
- [x] 增加空回答、全量已覆盖、遗漏内置角色和已发布自定义 Agent 的单测；单元测试基线提升至 `217/217`，源码重启后的 `qa:search-agent` 一次通过。
- [x] 复核 Registry 快照含草稿/归档 Agent 的边界：补齐层和调用方均只接受 `published`，不可用的自定义 Agent 不会出现在可用目录回答；过滤补丁后的 `check`、`test`、`build` 和真实 `qa:search-agent` 均通过。
- [x] 配置隔离的本地 MemoryCore Gateway 完成真实 HTTP L0/L1/L3 和 Axiom Adapter 验收；跨租户隔离、去重、更新、删除和 Core 读写通过，L2 异步场景未在等待窗口生成并按 warning 记录。
- [x] 带真实 MemoryCore 的完整 `npm run qa:all` 通过：`22 passed / 0 failed / 1 skipped`；唯一跳过项为未配置外部 S3/MinIO/COS 的 `qa:object-storage`，不把本地文件目录冒充多实例验收。

### 下一阶段执行顺序（2026-08-29 复核后）
1. [ ] Artifact 外部存储真实验收：使用本地 PostgreSQL + MinIO/S3/COS 双 Worker 完成跨进程 Put/Get/Delete、租户前缀隔离、断点/超时和任务删除清理验证。
2. [x] Artifact 生命周期治理：为 Artifact 增加创建来源、保留期限和引用状态，提供孤儿扫描/清理任务，清理失败进入可重试队列并可在运行观测中查看；SQLite/PostgreSQL 目录和自动回填已完成，真实对象存储验收仍属于第 1 项。
3. [x] MemoryCore 生产服务接入：L0-L3 适配器、跨重启收据、游标去重、过期/置信度过滤和失败补偿已完成；正式 TencentDB endpoint 的现场验收待部署凭据。
4. [x] Harness transport 生产接入：DeepSeek ACP/Codex v2 stdio、审批回放、Artifact/事件关联、跨重启断点恢复和失败补偿已完成协议级回归；真实 sidecar 现场验收待部署环境。
5. [x] Workflow 高级恢复：条件分支、多 Loop/嵌套 Loop、节点级局部恢复和单节点重跑已完成，并补充图结构、事件顺序和人工审核 API 回归。
6. [ ] 可观测性与规模压测：接入 OpenTelemetry/外部 Prometheus，关联 trace/span、队列等待、模型成本和人工接管；在多 Worker、大数据量下重跑性能基准。
