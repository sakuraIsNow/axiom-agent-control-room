# Axiom 控制室 Dashboard 重建 + Agent Studio + 登录开屏

更新时间：2026-08-24

## 背景

`TODO.md` P1.7/P1.8（电影级重构）已交付：`src/components/shell/AxiomShell.tsx` 是当前默认渲染入口，`CinematicCore.tsx` 用 `MeshTransmissionMaterial` 做核心球玻璃质感，推理图/事件流/协作事件可视化均已接入真实数据。**本轮不是推翻重来，是在这个基础上新增一套并列的任务台入口**，同时补齐 Agent Studio（用户自建 Agent）和登录开屏页。

调研依据：本轮参考了 `d:\vsProject\platform\douyin` 目录下的开源素材（`emotion-ball-main.zip`、`orb-main.zip`、`morphicons-main.zip`、`fluidglass-ui-main.zip`、`prism-glass-main.zip`、`3D-card-acrylic-main.zip`、`particle-heart-main.zip`、`tim-ai-assistant-main.zip`）和一张任务管理平台参考截图（`3fae574b-fb1c-42cf-a71a-06eee075c5f3.jpg`），并对现有 `agentCatalog.ts`/`orchestrator.ts`/`pluginStore.ts` 做了逐行审查。所有结论基于直接读取源码核实，素材许可证边界见文末。

**核心原则（贯穿全文档）**：截图布局只借用信息架构和视觉语法，展示内容必须是 Axiom 真实的 Task/Event/Graph/SSE 数据，不能为了像截图而编造同比百分比、虚假排期或空洞的导航页。

---

## Part A：任务台 Dashboard（新并列入口）

### A.1 导航项：7 项真实能力，不是截图里的 8 项通用 PM 导航

逐项核对截图导航项与 Axiom 真实后端能力：

| 截图项 | 真实后端能力 | 处理方式 |
|---|---|---|
| 任务管理 | 有（`GET /api/tasks` → `WorkflowTaskSummary[]`） | 保留，作为任务台首页 |
| 项目总览 | 无（Axiom 无"项目"实体） | 砍掉，并入任务台首页 |
| 文件归档 | 无（`ArtifactStore` 只有 `put`/`get`，无 list/query，无 `/api/artifacts` 路由） | 砍掉，下沉为任务详情面板 Artifact 子区块 |
| 日程管理 | 有（`GET/POST /api/schedules`，`ScheduledTrigger`） | 保留为独立导航项 |
| 团队协作 | 有但仅任务级（`CollaborationMessage`/`Conflict`/`BudgetConstraint` 均挂 `taskId`，无跨任务聚合） | 砍掉独立页，下沉为详情面板/事件流 |
| 智能分析 | 有但仅任务级（`TaskProfile.reasons`、`ReviewResult.gaps`） | 砍掉独立页，下沉为详情面板"AI 助手建议" |
| 知识库 | 无（无可检索记忆/知识 API） | 砍掉 |
| 设置中心 | 有 | 保留 |

**原则**：只有拥有列表/CRUD/聚合级别后端能力的实体才配拥有独立导航项。

**最终 7 项导航**：任务台（默认首页）、沉浸模式（现有 `AxiomShell`，独立保留）、模板库、日程、工具与就绪、Agent Studio（阶段一）、设置。

### A.2 顶部统计卡片：4 张真实指标

Axiom 没有"待办"概念，只有 `WorkflowTaskStatus` 十态：

1. 排队中 = `queued + planning + awaiting_approval`
2. 运行中 = `running + reviewing + waiting_for_human + paused`
3. 已完成 = `completed`
4. 失败/取消 = `failed + cancelled`（复用 `server/runtime/contracts.ts` 已导出的 `terminalStatuses` 常量）

**同比数据**：改为"较过去 24 小时"滚动窗口对比，不新增每日快照表（`tasks` 表已有 `created_at`，两个范围查询即可，避免定时写入任务带来的数据漂移/时区风险）。**明确拒绝**用前端分页数据 `reduce` 计数——超过分页限制就会静默失真，等同于编造数字。

需要新增的后端能力：
- `server/runtime/contracts.ts`：`TaskStore` 接口新增 `getTaskStats(tenantId): Promise<{ byStatus: Record<WorkflowTaskStatus, number>; createdLast24h: number; createdPrev24h: number }>`
- `server/runtime/postgresTaskStore.ts` / `sqliteTaskStore.ts`：各自实现
- `server/runtime/taskApi.ts`：新增 `GET /api/tasks/stats`

### A.3 中间任务看板区：列表态（按依赖层级）+ 3D 轮播态（Agent 状态化身）

**列表态按依赖层级分组**（同层 = 可并行执行的一批节点，唯一同时具备"稳定分组"和"真实执行阶段含义"的方案，不按角色/状态分组）。

顺手修复一处技术债：真实依赖层级算法目前锁死在 `src/App.tsx:477-506`（经典工作台专属 memo），`src/components/shell/GraphView.tsx:12` 反而用 `index % 4` 假网格。动作：
- 新增 `src/lib/graphLayers.ts`：`computeGraphLayers(graph): Array<{ level: number; nodes: AgentGraphNode[] }>`，从 `App.tsx` 原样提取。
- `App.tsx` 的 memo 改为调用它；`GraphView.tsx` 也换成它。
- 新增 `src/lib/graphPresentation.ts`：把 `GraphView.tsx`/`CinematicCore.tsx`/`Inspector.tsx` 里各自重复的 `nodeId`/`nodeTitle`/`statusText`/状态色映射统一提取。

**3D 轮播态展示"Agent 状态化身"，不是"任务卡片"**——任务列表已在列表态存在，轮播态若也是任务卡片就是同一份数据的二次列表化，无信息增量；"当前哪些 Agent 在工作、什么状态"是 Axiom 目前任何地方都没有以可聚焦卡片形式呈现的真实信息，也是用户要求的 emotion-ball 风格状态展示的落地位置。

具体设计：

- **`src/lib/agentStateMachine.ts`**（纯 TS，不依赖 R3F）：
  - 分段式状态 ID（借鉴 emotion-ball 分组原则）：`00-09` 生命周期（`00` 未创建/`01` 启动中）、`10-29` 等待类（`10` 排队等待）、`30-49` 代理工作状态（`30` 路由中/`31` 加载上下文/`32` 推理中/`33` 工具调用中/`34` 完成收尾/`35` 失败告警）、`50+` 预留给 Agent Studio 自定义角色，编号永不重排。
  - 每个状态定义含 `staticOverrides`（缩放/材质基线）+ `primitives`（sine/pulse/jitter/scan/glance/blink 六种参数化动画原语）+ 可选一次性 `keyframes` + `settle` 收尾行为。
  - 临界阻尼弹簧过渡（通用物理公式，非受版权限制的表现形式）：
    ```ts
    function springStep(x: number, v: number, target: number, dt: number, zeta = 1, omega = 8) {
      const a = -2 * zeta * omega * v - omega * omega * (x - target);
      const nv = v + a * dt;
      return [x + nv * dt, nv] as const;
    }
    ```
  - `resolveAgentStateId(status, phase)`：真实 `TopologyAgent.status`/`AgentPhase` → 状态 ID，全部基于已有真实字段。
- **`src/components/dashboard/AgentAvatar.tsx`**：单个 R3F mesh，`useFrame` 用 `springStep` 追向目标态。造型复用 `CinematicCore.tsx` 已有的 icosahedron + `meshPhysicalMaterial`（`getUiTheme(theme).roleColors`），下方加 drei `RoundedBox` 底座 + `Text` 铭牌——**原创合成造型，不复刻 emotion-ball 的 blob/wedge/gem 视觉形象**（即便许可证在非商用场景下允许，为保持 Axiom 自身视觉语言一致性仍不采用）。
- **`src/components/dashboard/AgentCarousel.tsx`**：独立 R3F Canvas，一维线性深度堆栈（区别于 `CinematicCore` 的环形布局），聚焦卡片居中清晰，两侧用 `@react-three/postprocessing` 的 `DepthOfField` 做失焦模糊。
- **不复用 `curveRouting.ts`**：轮播无连线避障需求，该模块继续只服务 `CinematicCore.tsx`/`AgentScene.tsx`/`GraphView.tsx`。
- **orb-main 的落点**：`orb-main/src/presets.ts` 的 39 字段参数结构（颜色/运动/形状/玻璃/外观/边缘）作为 `AgentStateDef` 视觉参数字段的类型设计参考；`effect.wgsl` 的 fbm 流体图案算法移植成 GLSL，通过 R3F `shaderMaterial` 或对 `MeshTransmissionMaterial` 做 `onBeforeCompile` 注入，作为 `AgentAvatar` 材质可选增强层。**不引入 WebGPU 管线**——已核实 `orb-main` 硬依赖 `navigator.gpu`，与当前项目 WebGL/`@react-three/fiber` 管线互斥（一个 `<canvas>` 不能同时被两种上下文获取），原样嵌入需要维护第二套独立渲染循环，代价过高。

**性能红线（设计阶段锁定，不能留到测试才发现）**：任务台的 `AgentCarousel` 和沉浸模式的 `CinematicCore` **不能同时挂载两个 R3F Canvas**——从任务台跳转沉浸模式必须先卸载轮播 Canvas 再挂载核心视图 Canvas，否则低端设备双 WebGL 上下文同时存活会掉帧甚至 context lost，要写进 `AxiomDashboard.tsx`/导航切换逻辑。

### A.4 底部时间线：任务执行历史，不是排期甘特图

Axiom 任务秒级到分钟级完成，套用截图"按天为刻度"的排期语法会产生大量空白刻度，是扭曲真实数据尺度。改为：

- `src/components/dashboard/TaskTimeline.tsx`：手写内联 `<svg>`（沿用 `GraphView.tsx` 已证明的惯例，不引入图表库新依赖）。
- 数据源 `GET /api/tasks`（最近 12-20 条），条形从 `createdAt` 画到（终态则 `updatedAt`，否则到当前时刻，运行中任务条形持续变长），颜色复用 `graphPresentation.ts` 状态色。刻度粒度自适应，明确不做按天刻度。
- **排期 tab 仅当 `GET /api/schedules` 返回非空数组时才出现**（`ScheduledTrigger` 是唯一有"未来时间"语义的数据，常驻空 tab 等于为不存在的数据占位）。出现时标注"预测值"（P1.5 调度器暂无失败重试保证，不能让用户误以为是确定发生的排期）。

### A.5 右侧详情面板："AI 助手建议"分两个子区块

`TaskProfile.reasons`（Planner 路由依据，任务刚创建即有）与 `ReviewResult.gaps`/`requiredCorrections`（Reviewer 审查诊断，权威性更高但出现更晚）产生时机不同，分开渲染：

- 子区块一"路由依据"：渲染 `reasons` 数组，只要有 `taskProfile` 就显示。
- 子区块二"审查发现"：仅当有 `review.completed` 事件时渲染，`gaps`（"完整性缺口"）和 `requiredCorrections`（"必须整改项"）分两组小标题，不合并成一个列表。

空状态原则：无 `taskProfile` 时不渲染任何子区块标题，只给占位文案；未进入审查阶段时"审查发现"子区块整个不出现（不是显示"暂无数据"）。

数据流：需确认 `review.completed` payload 是否已单独暴露到某个 state——若没有，需在 `App.tsx` 的 `applyWorkflowEvent` 归约器里新增 `reviewResult` state 字段并透传（本次少数需要碰归约逻辑的地方）。

### A.6 文件组织：新建并列组件树，不改造 `AxiomShell`

**决策**：新建 `src/components/dashboard/`，`AxiomShell.tsx` 及全部子组件原样保留、继续作为"沉浸模式"独立入口，只是不再是默认渲染分支。

理由：
1. `scripts/visual-qa.mjs` 已硬编码对 `.axiom-shell`/`.shell-core-canvas`/`.shell-graph-node`/`.shell-inspector-telemetry` 的断言（P1.7/P1.8 验收基线），原地重排会让新功能 bug 和老基线回归纠缠在一起。
2. "沉浸模式"要继续独立可达，天然要求并列组件树。
3. 沿用项目已有惯例：`App.tsx` 里 `AxiomStudio`/`AxiomShell`/`AgentScene`/`AxiomMissionDeck` 本就是并列存在、按开关切换的多套组件树。

```
src/components/dashboard/
  AxiomDashboard.tsx      — 新顶层容器：三栏布局，唯一新顶层入口，替换 App.tsx 默认渲染分支
  DashboardNavRail.tsx    — A.1 的 7 项导航
  StatCards.tsx           — A.2 的 4 张卡片
  TaskBoard.tsx           — A.3 列表态
  AgentCarousel.tsx / AgentAvatar.tsx — A.3 3D 轮播
  TaskTimeline.tsx        — A.4
  TaskDetailPanel.tsx     — A.5 右侧面板
src/lib/
  graphLayers.ts / graphPresentation.ts / agentStateMachine.ts
  useDashboardStore.ts    — zustand 新建（不塞进 useShellStore.ts，语义不同，混用会互相污染）
src/styles/
  dashboard.css           — 独立文件，新 --dash-* token 前缀，颜色必须从 src/lib/uiTheme.ts 的 UI_THEMES 读取，且一开始就补全 graphite/cobalt 主题覆盖（shell.css 目前只做了 obsidian/ivory，是要顺手修的债）
```

小改（不重写）：`App.tsx`（`graphLayers` memo 替换、默认渲染分支切到 `AxiomDashboard`、归约器新增 `reviewResult`、视图状态从二态扩为 `'dashboard'|'immersive'|'classic'` 三态）、`GraphView.tsx`（改用 `computeGraphLayers`）、`server/runtime/{contracts,postgresTaskStore,sqliteTaskStore,taskApi}.ts`（`getTaskStats`）、`scripts/visual-qa.mjs`（新增 `.axiom-dashboard` 断言，保留全部现有 `.axiom-shell` 断言）。

---

## Part B：Agent Studio（完整新子系统，本次只做阶段一）

现状核实：`agentCatalog.ts`（71 行硬编码常量）**完全不驱动 Planner 的角色选择**——Planner 角色枚举是 `orchestrator.ts` 里 zod 硬编码的 `roleSchema = z.enum(['researcher','analyst','builder','reviewer'])`，和 `agentCatalog.ts` 毫无关联。现有 Prompt Plugin（`pluginStore.ts`）运行时会被当成全新独立 `WorkflowTask` 提交，**不能被 Planner 派发为协作步骤的执行者**——这是"自建 Agent 必须是新子系统而非扩展插件"的根本原因。

### B.1 数据模型

新增 `user_agents` 表（比照 `pluginStore.ts` 的双 store 实现模式），`UserDefinedAgent` 字段：身份与生命周期（`id`/`tenantId`/`roleId`/`name`/`description`/`icon`/`kind: 'worker'|'quality'|'output'`/`status`/`visibility`/`version`/`history[]`/`createdBy`/时间戳，对齐 `UserPlugin`）+ 执行定义（`systemPromptTemplate`/`whenToUseHint`/`defaultModel`/`allowedModels`）+ 工具与权限（`toolAllowlist`/`maxToolCallsPerStep`）+ 执行边界（`maxTokensDefault`/`maxDurationMsDefault`/`failureStrategyDefault`）+ `memoryRecall`/`requiresPlanApprovalOverride`。

**不复用/不扩展 `UserPlugin` 类型**：语义不同（一次性任务模板 vs 被派发的协作步骤），混用会破坏现有稳定路径。

### B.2 调度接入（后续阶段，非本次范围）

`roleSchema` 动态化、`AgentRole`/`WorkflowStep.role` 放宽为 `string`+运行时校验、Planner prompt 动态拼接角色列表、`executeStep()` 里"只有 builder 能调工具"的硬编码改为目录驱动、`fallbackPlan()` 保持不依赖自定义 Agent。**`classifyTask()` 分级路由不改动**——任务复杂度判断和"该派谁去做"是正交问题，自定义 Agent 只应在已判定为 team/full-workflow 的任务里由 Planner 在步骤级别选用。

### B.3 工具授权（后续阶段）

底层审批机制（signature 匹配、`waiting_for_human`）对自定义 Agent 天然适用不需要改。需新增静态校验层：自定义 Agent 首次引用高风险工具时，Agent 定义本身走发布审批，`ToolApproval` payload 增加 `sourceAgentDefinitionId`/`sourceAgentVersion`。

### B.4 分阶段交付

1. **阶段一（本次范围）**：`user_agents` 表 + store + CRUD API + Agent Studio 管理页（创建/编辑/发布/归档），**不接入 Planner**，先打通"定义→存储→展示"闭环。
2. 阶段二：Planner 动态角色接入（B.2），风险最高，独立评审排期。
3. 阶段三：工具授权与审批体验打磨（B.3）。
4. 阶段四：用量统计、Agent 模板市场。

---

## Part C：登录开屏页

纯视觉开屏页，**不新增任何后端认证逻辑**（后端现状核实：`server/index.ts` 只有 `AXIOM_API_KEY` 服务间调用和反向代理注入的签名 principal 两种身份来源，`server/runtime/principal.ts` 是 HMAC 签名校验，完全没有用户名/密码/session 概念）。任意输入或点击即可进入，状态存 `localStorage`。

- 鼠标响应网格背景：Canvas/WebGL 实现，网格顶点位移随鼠标接近度衰减扭曲（业界成熟技法）。**已尝试 `WebFetch` 访问 DeepSeek Harness 官网核实实际效果，被环境安全策略拦截；`WebSearch` 也未找到可靠的第三方描述**，因此不基于无法核实的具体网站细节，独立设计。
- 粒子化 logo：需原创设计 Axiom 品牌 logo，粒子加载时从分散重组成 logo 形状，鼠标靠近局部扰动。可参考 `particle-heart-main.zip`（MIT）的"生命周期阶段状态机+参数化粒子池"架构（8 阶段演化），是 Canvas 2D 单文件实现，若登录页 3D 化需要把逻辑移植到 Three.js `Points`+`BufferGeometry`。
- 新增 `src/components/onboarding/LoginScreen.tsx` + 独立样式，`App.tsx` 顶层按 `localStorage` 标记决定是否插入，不影响后续路由/状态逻辑。

---

## Part D：素材来源与许可证边界

| 素材 | 许可证 | 结论 |
|---|---|---|
| `orb-main.zip` | MIT | 可用，但 WebGPU 硬依赖不兼容现有 WebGL/R3F 管线，只移植 shader 算法和参数 schema |
| `emotion-ball-main.zip` | 双许可（引擎/数据非商业免费+可付费商用；球形角色视觉形象商用永久禁止） | Axiom 非商用，理论上均可用；本方案仍只借鉴引擎架构，原创视觉造型 |
| `morphicons-main.zip` | MIT | 可 `npm install morphicons` + `npm install lucide`（数据包，与现有 `lucide-react` 并存），用于任务状态图标切换、命令栏 mode 图标切换，不用于高频重渲染列表 |
| `fluidglass-ui-main.zip` | Apache-2.0 | 纯 WebGL1 流体玻璃 shader，可用于非 R3F 的 2D DOM 卡片背景，不用于已在 R3F Canvas 内的元素 |
| `prism-glass-main.zip` | Apache-2.0 | 纯 CSS/JS 调色引擎，作为 `dashboard.css` token 系统设计参考 |
| `3D-card-acrylic-main.zip` | 无 LICENSE，默认保留所有权利 | 不可复用代码/资源，仅确认"纯 CSS 3D transform 可行"，本方案实际用 R3F 轮播 |
| `particle-heart-main.zip` | MIT | 可用，Canvas 2D 粒子引擎架构参考，用于登录页 |
| `tim-ai-assistant-main.zip` | 无 LICENSE，默认保留所有权利 | 不可复用代码/美术资源，仅工程模式互相印证 |

---

## 优先级与批次顺序

1. **后端与数据层**：`getTaskStats` 双实现 + 路由、`reviewResult` 归约字段。纯后端改动，风险最低，最先做。
2. **Dashboard 布局骨架 + 列表态**：`AxiomDashboard`/`DashboardNavRail`/`StatCards`/`TaskBoard`/`graphLayers.ts`/`graphPresentation.ts`/`TaskDetailPanel` 基础版。完成后跑 `visual-qa.mjs` 新断言，是后续批次地基，必须单独验收。
3. **3D 轮播 + Agent 状态机**：`agentStateMachine.ts`/`AgentAvatar.tsx`/`AgentCarousel.tsx`。风险最高（`springStep` 参数需反复调试、必须验证任务台/沉浸模式两个 R3F Canvas 不同时挂载），单独跑帧率验收。
4. **时间线 + AI 建议面板**：`TaskTimeline.tsx`、建议子区块、`ReviewResult` 数据接线。依赖批次 1，重点验证三种空状态覆盖。
5. **登录开屏页**：独立模块，不依赖前 4 批，可并行或穿插。
6. **QA 基线扩展 + 主题覆盖补全**：`shell.css`/`dashboard.css` 补齐 graphite/cobalt，`visual-qa.mjs` 新增 `.axiom-dashboard` 断言（保留全部现有 `.axiom-shell` 断言）。放最后，依赖前面批次的最终 DOM 结构。
7. **Agent Studio 阶段一**：数据表 + CRUD API + 管理页，不接入 Planner，可与批次 2-4 并行（文件作用域基本不冲突）。

**明确不在本次范围**：Agent Studio 阶段二（Planner 动态角色接入）——风险最高，需独立评审后再排期；orb-main 的 WebGPU 管线、emotion-ball 的球形角色视觉、3D-card-acrylic/tim-ai-assistant 的代码/资源直接复用——均不采用，理由见 Part D。

## 验证要求

```bash
npm run check
npm test
npm run build
npm run qa:routing
npm run qa:runtime
npm run qa:visual
```

涉及前端视觉的批次（2/3/4/5/6）必须运行 `npm run qa:visual`；批次 1 必须运行 `npm test`；批次 3 额外需要人工帧率验收。本项目无 git 仓库，进入实现阶段前先按 `frontend-backup/<时间戳>-pre-dashboard/` 惯例打快照。
