# Axiom 前端彻底重建执行文档 v2

更新时间：2026-08-24
状态：**替代** `docs/dashboard-agentstudio-roadmap.md` 中"并列保留旧前端"的架构决策。本文档是当前唯一有效的前端方向依据。

## 0. 为什么要有这份文档

上一轮按"新建 Dashboard 并列入口、旧前端隐藏保留"的思路做了实现，用户明确反馈两点：

1. 效果和参考截图（`douyin/3fae574b-fb1c-42cf-a71a-06eee075c5f3.jpg`）差距大，尤其是中间的毛玻璃卡片区——**这不是"哪些 Agent 在工作"的可视化，而是历史会话/任务的卡片化浏览**，之前的实现把这两个概念混在一起了。
2. **旧前端不要了**——不是隐藏、不是留应急入口，是真正从代码里拿掉。之前"无 git 仓库所以只隐藏不删除"的保守决策不再适用，用户已经明确要求彻底重建。

本文档的目的：把散落在整个对话历史中的所有需求（截图复刻、emotion-ball 拓扑、DeepSeek Harness 登录页、Agent/Skill 自建、路由保证、插件弹窗化、douyin 素材整合）收敛成一份可执行、可验收、不自相矛盾的规格说明，作为后续实现（无论是我自己继续做，还是交给另一个 agent）的唯一依据。

**不新增编造数据的原则不变**：截图里每一个视觉元素，落地前都要先确认 Axiom 有没有对应的真实后端能力；没有就砍掉或改成有真实语义的替代物，绝不为了像截图而编造假数据。这条原则贯穿全文档，具体映射见第 2 节。

---

## 1. 参考截图逐块拆解

截图来源：`WenXiBuddy`（一个項目管理产品的界面截图），布局如下（从左到右、从上到下）：

### 1.1 左侧栏（约 260px 宽，深色玻璃面板）
- 顶部品牌区：logo + 产品名
- 导航列表，当前项高亮为白色胶囊背景：任务管理、项目总览、文件归档、日程管理、团队协作、智能分析、知识库、设置中心（共 8 项）
- 底部：一个"我的工作区"下拉切换器 + 当前用户头像/姓名/角色的小卡片

### 1.2 顶部条
- 左侧：页面大标题"任务管理" + 一行副标题标语
- 中间：一个跨度很宽的全局搜索框（含快捷键提示 `⌘K`）
- 右侧：通知铃铛（带红点）、消息图标、一个醒目的"+ 新增任务"主按钮（带下拉箭头，暗示可以选模板新建）

### 1.3 统计卡片行（4 张，等宽横排）
每张卡片结构一致：左上角小标题 + 右上角一个带底色的圆形图标；卡片主体是大号数字；卡片底部一行"较昨日 ↑X%"或"↓X%"的同比文字。四张分别是：今日待办 / 进行中 / 已完成 / 逾期任务。

### 1.4 任务看板区（截图的视觉核心，左右两栏）
- **左栏"任务看板"**：顶部有"全部任务/我负责的/我参与的"筛选 tab + 状态筛选下拉 + 筛选/排序/视图切换图标；下方是按分组折叠的任务列表（"需求评审(3)"、"产品设计(4)"、"开发实现(5)"），每个分组可展开，组内每条任务显示编号、标题、优先级 tag、截止时间文案。
- **右栏 3D 毛玻璃卡片轨道**：一组白色半透明卡片以扇形/环形透视排列，最中间一张放大并高亮成绿色（当前聚焦项），卡片上有编号和小图标；聚焦卡片左侧悬浮一张深色玻璃小卡片，显示当前聚焦项目的名称、周期、完成百分比大字和一个"完成度"标签，带一个跳转箭头图标。

**这一整块的本质，是"任务/文档的可视化浏览器"，用 3D 卡片轨道做视觉焦点，不是团队成员或 Agent 的状态展示。**

### 1.5 底部时间线（甘特图风格）
"项目时间线"标题 + 日期范围 + 周/今天切换；下方是按天为刻度的横向时间轴，几条泳道（需求评审/产品设计/开发实现/测试验证），每条泳道上有一个横跨若干天的色块表示这个阶段的起止时间，当前日期有一条竖线标记。

### 1.6 右侧详情面板（"智能详情"）
- 顶部任务编号 + 标题 + 优先级 tag + 一个跳转/展开图标
- 一段任务描述文字
- 一组字段列表：负责人（头像+姓名）、所属项目、截止时间、当前状态（带色点）、优先级（带色点）、标签（多个 pill + 一个"+"）
- "AI 助手建议"区块：一个带图标的小标题 + 若干条建议列表 + "查看建议详情"按钮
- 底部两个操作按钮："编辑任务" + "完成任务"（绿色主按钮）

---

## 2. 映射到 Axiom 真实能力（逐项裁决）

| 截图元素 | Axiom 真实能力 | 裁决 |
|---|---|---|
| 左侧 8 项导航 | 见下表细分 | 保留 7 项，"知识库"砍掉（无检索记忆/知识 API） |
| "我的工作区"切换器 | 无多工作区概念，只有单租户 | 砍掉，用现有"用户/租户"信息替代，显示当前 principal |
| 全局搜索框 | 无跨字段全文搜索 API | **暂不做**，标注为 P2 待评估项，不假装能搜 |
| 通知铃铛/消息图标 | 无通知系统 | 砍掉 |
| "+ 新增任务"主按钮 | 有（`POST /api/tasks`） | 保留，作为左侧栏顶部主按钮（不是顶部条），原因见 3.1 |
| 4 张统计卡片 | 有（`GET /api/tasks/stats`，已实现） | 保留并丰富，见第 4 节 |
| 任务看板左栏（分组列表） | 有（依赖层级分组已实现），"我负责的/我参与的"筛选可用 `userId` 做 | 保留，按依赖层级分组的决策不变（唯一有真实执行阶段含义的分组维度） |
| **3D 毛玻璃卡片轨道** | 有（`GET /api/tasks` 历史任务列表） | **重新定义为"历史会话/任务卡片浏览器"**，不是 Agent 状态可视化，见第 5 节 |
| 悬浮聚焦信息卡（87% 完成度） | 无"任务进度百分比"概念（Axiom 任务是二元的 running/completed，没有连续进度值） | 改造为显示聚焦任务的真实字段（标题、路由类型、当前阶段、创建时间），不编造百分比 |
| 项目时间线（甘特图） | 有任务真实 `createdAt`/`updatedAt`，无"未来排期"概念（除非配置了 Schedule） | 保留"任务执行历史"时间线（已实现，非甘特图刻度），原因见 `docs/dashboard-agentstudio-roadmap.md` A.4（结论不变） |
| 右侧详情面板 | 见第 6 节细分 | 保留框架，字段逐个核实替换 |

### 2.1 左侧导航最终 7 项
任务台（首页）、沉浸模式（Agent 拓扑 3D 可视化，见第 5.3 节）、模板库、日程、工具与就绪、Agent Studio、设置。

---

## 3. 左侧栏详细设计

用户原话："左侧栏就是新建对话等内容，日程等"——即左侧栏的第一优先级是**新建任务的入口**，其次是导航。

### 3.1 结构（从上到下）
1. 品牌区：Axiom logo + 名称（复用现有 `dash-brand`）
2. **"+ 新建任务"主按钮**（醒目，参照截图右上角按钮的视觉权重，但位置移到左侧栏顶部，因为用户明确说"左侧栏就是新建对话"）——点击直接聚焦命令栏输入框，不弹二级菜单（Axiom 没有"任务模板快速选择下拉"这个截图里暗示的能力，如果要做，应该链接到已有的模板库而不是新造一个下拉）
3. 导航列表（7 项，见 2.1）
4. 底部：当前 principal 信息（`tenantId`/`userId`，真实数据，替代截图的"工作区切换器"）+ 运行时状态（readiness 灯）

### 3.2 与现有实现的差异
现有 `DashboardNavRail.tsx` 只有导航列表，没有顶部"新建任务"按钮（现在这个按钮在顶部 Header 里，逻辑上也存在，但视觉权重和位置不对）。需要把 `onNewTask` 移进 `DashboardNavRail` 组件顶部，Header 里可以保留一个次要的图标按钮或直接去掉。

---

## 4. 首页统计区丰富化方案

用户要求："首页就是这样的任务状态等内容（帮我丰富）"——这是要求我主动提出基于真实数据的丰富方案，而不是照抄截图凑数字。

### 4.1 现状（已实现）
4 张卡片：排队中 / 运行中 / 已完成 / 失败取消，每张带"较过去 24 小时"真实同比。

### 4.2 丰富化方案（用户已确认全部实现，每项标注数据来源与具体改动，禁止编造）

1. **Token/成本趋势迷你图**：卡片区下方加一条横向的 7 日 Token 消耗 sparkline（手写内联 SVG，参照 `TaskTimeline.tsx` 的做法，不引入图表库）。
   - 后端：`contracts.ts` `TaskStore` 接口新增 `getTaskStatsDaily(tenantId, days): Promise<Array<{ date: string; totalTokens: number; estimatedCostUsd: number }>>`；`postgresTaskStore.ts` 用 `task_events` 按 `DATE_TRUNC('day', timestamp)` + `type='model.completed'` 聚合 `payload->>'totalTokens'`/`payload->>'estimatedCostUsd'`；`sqliteTaskStore.ts` 用 `strftime('%Y-%m-%d', timestamp)` 等价实现。
   - 路由：`GET /api/tasks/stats/daily?days=7`。
   - 前端：`src/components/dashboard/TokenTrendSparkline.tsx`，接在 `StatCards` 下方；`src/lib/taskRuntime.ts` 新增 `getTaskStatsDaily()`。
2. **Reviewer 通过率卡片**：新增第 5 张统计卡（或 4 卡下方一行小指标条，视觉密度评估后再定），显示"审查通过率"。
   - 后端：`getTaskStats` 返回体扩展 `reviewApprovalRate: number | null`（`task_events` 里 `type='review.completed'` 的 `payload->>'approved'` 布尔值统计，样本为 0 时返回 `null` 而不是 0，前端显示"暂无审查数据"而不是假的 0%）。
   - 这是对现有 `getTaskStats` 查询的扩展，不是新端点。
3. **平均任务时长**：`WorkflowTaskSummary.durationMs` 已在返回体里，前端在已完成任务集合上直接计算平均值。零后端改动，`StatCards.tsx` 或"已完成"卡片下追加一行 `<small>`。
4. **"我的任务"筛选**：`TaskBoard` 增加按 `userId` 过滤的 tab（"全部/我的"），对应截图"我负责的"。
   - 后端：`summarizeTask()`（`taskApi.ts`）返回体补充 `userId` 字段（`task.userId` 已存在于 `WorkflowTask`，只是摘要函数没有透传）。
   - `types.ts` 的 `WorkflowTaskSummary` 补 `userId: string` 字段。
   - 前端：`TaskBoard.tsx` 顶部加 tab，用当前 principal 的 `userId`（需要一个能拿到当前用户 id 的途径——检查 `identity()`/`verifyPrincipal()` 是否已经把 `userId` 传到前端可读的地方；如果没有，需要一个轻量 `GET /api/whoami` 或类似端点返回当前 `userId`，不能在前端硬编码或猜测）。

> 实现顺序建议：先做 3（零成本）→ 4（后端小改动，价值高）→ 2（复用现有端点扩展）→ 1（新端点+新组件，工作量最大，放最后）。

---

## 5. 历史会话/任务玻璃卡片轮播（重新定义，取代之前的 Agent 状态轮播）

### 5.1 上一轮的错误
上一轮把截图的 3D 卡片轨道理解成"emotion-ball 风格展示当前哪些 Agent 在工作"，做成了 `AgentOrbitCarousel.tsx`（卡片内容是 Agent 角色/状态）。用户这次明确纠正：**毛玻璃卡片对应的是历史会话或任务**，不是 Agent。

### 5.2 修正方案
- 复用已经实现的交互框架（`AgentOrbitCarousel.tsx` 的拖拽旋转/自动巡航/亚克力材质/点击聚焦逻辑全部保留，这部分是纯视觉工程，和绑定什么数据无关），改造为 `TaskOrbitCarousel.tsx`：
  - 数据源：`GET /api/tasks`（已有，与 `TaskBoard` 共用同一份 `taskCatalog`）
  - 每张卡片显示：任务标题、路由类型（direct/single-agent/team/full-workflow）、状态、相对时间（"3 分钟前"）
  - 聚焦卡片高亮色按**任务状态**着色（completed=绿色、running=蓝色、failed=红色），不再按 Agent role 着色
  - 点击卡片 = 调用 `onOpenTask`（与 `TaskBoard` 行点击是同一个回调，只是视觉呈现是 3D 卡片而不是列表行——**这是同一份数据的两种视图，不是编造新数据**）
  - 悬浮聚焦信息卡：显示聚焦任务的真实字段（标题、当前阶段 `currentStage`、创建时间），不显示不存在的"完成度百分比"

### 5.3 emotion-ball 风格"Agent 拓扑"应该放在哪
用户最早的需求原文是"各个智能体的拓扑包括能看到当前是哪些智能体在工作的展示样式用 emotion ball 的项目中的样式展示"——这是一个独立需求，不应该强行塞进截图的任务卡片轨道里（截图本身没有这个元素，是用户额外提的）。

裁决：**这个需求应该在"沉浸模式"里实现**，理由：
- "沉浸模式"（`AxiomShell`/`CinematicCore.tsx`）本来就是 Axiom 已有的、专门做 3D Agent 拓扑可视化的入口，`GraphView`/`CoreView` 已经在展示真实的 `TopologyAgent[]`/`AgentGraph`
- emotion-ball 的核心技术贡献（分段状态 ID、临界阻尼弹簧、彩带特效）已经在 `agentStateMachine.ts` 里实现了，只是上一轮错误地把它挂在了任务卡片轮播上
- 正确的挂载点：`CinematicCore.tsx` 里现有的 `Agent()` 组件（渲染 `SceneNode`，即拓扑图上的每个 Agent 节点）应该消费 `agentStateMachine.ts` 的状态定义和彩带效果，而不是新造一个 `AgentAvatar.tsx`/`AgentCarousel.tsx` 组件树
- 动作：**废弃** `src/components/dashboard/AgentAvatar.tsx` 和 `AgentCarousel.tsx`（不再需要独立存在），把彩带特效逻辑迁移进 `CinematicCore.tsx` 的 `Agent()` 组件

---

## 6. 右侧"智能详情"面板字段核实

| 截图字段 | Axiom 真实数据 | 裁决 |
|---|---|---|
| 任务编号 | `task.id`（真实 UUID，可截短显示） | 保留 |
| 标题 | `task.title` | 保留 |
| 优先级 tag | 无优先级概念，但有 `TaskProfile.difficulty`（trivial/easy/moderate/hard/complex） | 用 `difficulty` 替代，语义相近且真实 |
| 描述 | `task.input`（用户原始输入） | 保留 |
| 负责人 | `task.userId` | 保留（无头像图片系统，用文字/首字母圆形代替） |
| 所属项目 | 无"项目"实体；但 `sessionId` 下可能挂了多个任务（同一次对话里连续提交的多个任务），"这一串任务最初想做什么"是真实存在、且和当前任务"标题"不同的信息 | **用户已确认**：提取任务目的作为"所属项目"字段，不用裸 `sessionId`。做法：标签文案改为"所属会话主题"；取值为**同一 `sessionId` 下最早一条任务的 `title`**（`taskCatalog` 已经带 `sessionId`+`createdAt`，前端按 `sessionId` 分组取 `min(createdAt)` 那条的 `title` 即可，零后端改动）。当会话只有一个任务时，这个值会和"标题"行相同——这是真实结果，不做特殊隐藏处理（对用户是一致的，不是 bug）。 |
| 截止时间 | 无 deadline 概念 | **砍掉，不编造**；如果任务来自 Schedule，可以显示"下一次预测触发时间"作为语义相近的替代，但要明确标注来源 |
| 当前状态 | `task.status`（十态） | 保留，已有色点映射（`graphPresentation.ts`） |
| 优先级 | 同上，用 `difficulty` | 与"优先级 tag"合并显示，不重复 |
| 标签 pills | 无自由标签系统 | 用 `TaskProfile.kind`（conversation/question/research/...）+ `route`（direct/team/...）渲染成 pill，真实数据 |
| AI 助手建议 | 已实现（路由依据+审查发现两个子区块） | 保留，是本文档里少数已经做对的部分 |
| "编辑任务"按钮 | 任务一旦创建，`input` 不可编辑 | 改成"重新提交"（复制当前任务的 input 到命令栏，走 `retryWorkflowTask` 或新开一个任务），语义更贴近真实能力 |
| "完成任务"按钮 | 当任务处于 `waiting_for_human`/`awaiting_approval` 需要人工决策时，这就是真实的 approve 操作（已有 API：`approveWorkflowPlan`/`approveWorkflowReview`/`approveWorkflowTool`） | 保留，仅在真实需要人工决策的状态下显示，其余状态不显示这个按钮（不能常驻一个点了没反应的假按钮） |

---

## 7. 旧前端彻底移除（本轮的核心变更）

### 7.1 范围
物理删除，而不是隐藏：
- `src/App.tsx` 里经典工作台的 JSX 渲染分支（`viewMode === 'classic'` 对应的约 1500+ 行侧边栏+工作台代码）
- `src/components/AxiomMissionDeck.tsx`
- `src/components/AxiomStudio.tsx`（连带 `legacyStudio`/`?view=studio` 判断逻辑）
- 如果存在的 `ImmersiveControlRoom.tsx`/`ImmersiveCore.tsx`（TODO.md P1.7 里已经标记过要删，之前一直没做，这次一起做）
- `?view=classic` 隐藏应急入口机制整个去掉，`VIEW_KEY` 简化为二态：`'dashboard' | 'immersive'`

### 7.2 保留什么
- `AxiomDashboard`（任务台，新默认唯一首页）
- `AxiomShell`/`CinematicCore`（沉浸模式，重新定位为"Agent 拓扑可视化"入口，见 5.3）
- 所有后端能力和业务状态管理逻辑（`App.tsx` 里的 `sessions`/`applyWorkflowEvent`/`streamWorkflowEvents` 等——这些是业务逻辑核心，和"前端长什么样"无关，必须原样保留，绝不能因为删 UI 连带删掉真实业务状态管理）

### 7.3 执行顺序（降低风险）
1. 先确认 `AxiomDashboard` + `AxiomShell` 两条路径已经覆盖了经典工作台里的**全部**业务功能入口（模板库/插件/工具就绪/设置/日程——上一轮已经做了这一步，见 `TODO.md` P1.9 记录），逐项过一遍确认没有遗漏
2. 打 `frontend-backup/<时间戳>-pre-teardown/` 快照（本项目无 git，这是唯一回滚手段，删除前必须做）
3. 删除经典工作台 JSX 块，同步删除其专属的、不再被引用的 state（如果有工作台专属而 Dashboard 不需要的 state，需要逐个确认是否还被业务逻辑复用）
4. 删除 `AxiomMissionDeck.tsx`/`AxiomStudio.tsx`/遗留的 Immersive* 文件，清理 `App.tsx` 里对应的 `lazy()` 导入
5. 清理 `src/styles.css`（如果经典工作台有专属死 CSS）
6. `npm run check && npm test && npm run build` 全过，`grep -r` 确认没有遗留的死引用
7. `scripts/visual-qa.mjs` 里如果还有针对经典工作台 DOM 结构的断言，一并删除

---

## 8. Agent Studio 完整化路线（用户已确认现在排期，非搁置）

用户原始需求："平台可有很多agent，甚至几百个，以及几百个skill，但是用户不需要选择某个agent，是通过用户语义然后agent和skill路由去自动分配"、"emotion-ball对应的agent graph也要灵活一些，不能只固定几个"、"用户后期自建的agent（也可通过agent创建agent）"。

现状：P1.10 阶段一（数据+CRUD+展示，不接入 Planner）已完成。以下是**本轮要做**的 Planner 动态接入方案（对照 `docs/dashboard-agentstudio-roadmap.md` Part B.2 的原始设计展开为具体步骤）：

### 8.1 `roleSchema` 动态化
- 现状：`server/runtime/orchestrator.ts` 里 `roleSchema = z.enum(['researcher', 'analyst', 'builder', 'reviewer'])` 是模块级静态常量。
- 改造：`WorkflowOrchestrator.plan()` 方法签名新增参数，在调用处传入"当前租户已发布的自定义 Agent 列表"（从 `agentStore.listAgents(tenantId, limit, access)` 过滤 `status === 'published'`）；`roleSchema` 改为函数 `buildRoleSchema(customRoleIds: string[])`，运行时用 `z.enum([...builtinRoles, ...customRoleIds])` 动态构造，每次 `plan()` 调用时重新生成（不做全局缓存，避免自定义 Agent 发布/归档后 Planner 仍用旧 schema 的一致性问题）。
- `AgentRole` 类型：从字面量联合 `'planner' | 'researcher' | 'analyst' | 'builder' | 'reviewer' | 'synthesizer'` 放宽为 `string`，但保留一个 `isBuiltinRole()` 判断函数（已有 `isBuiltinRoleId`，复用）用于内部逻辑分支判断。

### 8.2 Planner Prompt 动态拼接角色说明
- 现状：Planner 的 system prompt 里硬编码"Use only these roles: researcher, analyst, builder, reviewer"。
- 改造：prompt 构建函数新增一段，遍历已发布自定义 Agent，逐个拼接 `- ${roleId}: ${whenToUseHint}`（`whenToUseHint` 字段在 P1.10 已经设计好，专门就是为了这一步）。

### 8.3 `executeStep()` 的工具调用权限改造
- 现状：`orchestrator.ts` 的 `executeStep()` 硬编码"只有 `step.role === 'builder'` 才能触发工具调用"。
- 改造：判断逻辑改成查目录——内置角色维持原有硬编码表（`builder` 能调工具，其余不能，保持向后兼容不回归），自定义角色按 `UserDefinedAgent.definition.toolAllowlist` 是否非空决定是否进入工具调用分支，且实际可调用的工具集合按 `toolAllowlist` 过滤（不能超出 Agent 定义时声明的范围）。

### 8.4 `fallbackPlan()` 保持不变
- 兜底路径继续完全不依赖自定义 Agent 目录，保证 `agentStore` 异常/租户没有已发布 Agent 时系统仍能退化到内置六角色跑通。这是**红线**，不能因为这次改造被破坏。

### 8.5 `classifyTask()` 不改动
- 任务复杂度路由判断（direct/single-agent/team/full-workflow）和"具体派谁做"是正交问题，维持之前的判断不变——自定义 Agent 只在已经判定为 team/full-workflow 的任务里，由 Planner 在步骤级别选用。

### 8.6 Agent Graph 节点数量灵活化
- `CinematicCore.tsx`/`GraphView.tsx` 当前硬编码"最多 16 个可见节点"上限。当自定义 Agent 大量参与协作图时：
  - 3D 视图（`CinematicCore`）：保持 16 个上限（GPU 渲染成本红线，不因为逻辑上支持更多 Agent 就无限渲染），超出部分归并成一个"+N 更多"占位节点。
  - 2D 推理图（`GraphView`）：依赖层级分组本身不设硬编码上限（`computeGraphLayers` 已经是按真实依赖关系分组，理论上支持任意数量），但同层节点过多时需要横向滚动或分页——UI 细节留给实现时按实际测试效果调整，不在本文档定死具体数字。

### 8.7 "Agent 创建 Agent"
- 语义：某个 Agent 的执行结果里包含"建议创建/发布一个新的 `UserDefinedAgent` 定义"。
- 落地方式：**不做自动发布**（自动化程度到"自动创建并发布一个能被后续任务调度的新角色"这一步风险过高，一旦生成质量差的 Agent 定义被自动接入调度，会污染后续所有任务的 Planner 决策）。改为：
  1. 新增一个 Tool Registry 工具 `agent.propose`（低风险等级，只读写 `user_agents` 表的 `draft` 状态，不涉及发布）。
  2. 参数：`roleId`、`name`、`systemPromptTemplate`、`whenToUseHint`、`toolAllowlist` 等，与 `CreateUserDefinedAgentInput` 对齐。
  3. 效果：调用后在 `user_agents` 表新建一条 `status: 'draft'` 记录，**不会**被 Planner 读取（Planner 只读 `status === 'published'`），需要人工在 Agent Studio 页面里审阅后手动点击"发布"才会真正生效。
  4. 这样"Agent 创建 Agent"是真实可用的能力，但保留了人工审核这个安全阀，不是自动化到失控的地步。

### 8.8 Skill 系统
- 用户提到的"skill"，当前 Axiom 的对应物拆成两部分：`toolAllowlist`（Agent 能调用哪些 Tool Registry 工具）+ `systemPromptTemplate`/`whenToUseHint`（Agent 的能力边界描述）。**不新增独立的 Skill 抽象层**——`UserDefinedAgent` 本身已经承载了"一个角色 + 一组工具授权"的语义，再加一层 Skill 概念会造成"Agent 引用 Skill，Skill 又引用 Tool"的三层间接，对当前规模（P1.10 阶段一验证阶段）是过度设计。如果未来出现"多个 Agent 需要共享同一组工具+提示词模板"的真实场景，再考虑拆出 Skill 层。

### 8.9 风险与测试要求
这是本文档里风险最高的一块（触碰核心调度路径），执行时必须：
- `server/runtime/orchestrator.test.ts` 补充"自定义角色参与真实计划生成"的用例（mock 一个已发布自定义 Agent，验证 Planner 输出的 plan 里出现该角色、`executeStep()` 正确按其 `toolAllowlist` 限制工具调用）。
- 补充"自定义 Agent 目录读取失败/为空"时 `fallbackPlan()` 仍能正常工作的回归测试（红线验证）。
- 补充 `agent.propose` 工具的沙箱执行测试（确认它走的是受限的 Tool Registry 执行路径，不是绕过审批直接写 `published` 状态）。

---

## 9. 插件弹窗化（用户已确认做完整版：新插件类型 + 安全沙箱）

用户需求："插件可以用弹窗的形式呈现，如我让agent帮我做了一个贪吃蛇游戏插件，这个插件可是一个小弹窗的游戏"。

现状核实：`UserPlugin`（`pluginStore.ts`）目前的执行模型是"生成 prompt，提交为一个新 `WorkflowTask`"，本质是文本任务，不是"渲染一个交互式小程序"。这是一个新的插件类型，不是现有 `UserPluginKind = 'prompt'` 的扩展。

### 9.1 数据模型
- `contracts.ts`：`UserPluginKind` 从字面量 `'prompt'` 扩展为 `'prompt' | 'mini-app'`。
- 新增 `MiniAppPluginDefinition` 类型：
  ```ts
  type MiniAppPluginDefinition = {
    mode: 'mini-app'; // 与 UserPluginDefinition 的 mode 字段区分
    htmlContent: string; // 自包含 HTML，内联 <style>/<script>，不允许外部资源引用（见 9.3）
    width?: number; height?: number; // 默认窗口尺寸
  };
  ```
- `UserPlugin.definition` 按 `kind` 判别：`kind === 'prompt'` 时是现有 `UserPluginDefinition`，`kind === 'mini-app'` 时是 `MiniAppPluginDefinition`（TypeScript 判别联合类型，不是简单 optional 字段拼接）。

### 9.2 后端
- `pluginStore.ts` 的 `normalizeDefinition` 按 `kind` 分支处理；`mini-app` 分支对 `htmlContent` 做长度限制（例如 200KB 上限，防止滥用存储）和基础字符串校验（不做 HTML 解析级别的净化，净化交给渲染时的 iframe sandbox 属性，而不是存储时改写内容——存储时改写用户代码容易改出新 bug，运行时沙箱隔离才是可靠边界）。
- `taskApi.ts`：`POST /api/plugins` 的 zod schema 按 `kind` 判别校验；**不新增运行端点**——mini-app 类插件不走 `POST /plugins/:id/run`（那个端点是"生成 prompt 提交 WorkflowTask"的语义，mini-app 插件没有这个语义），前端直接用 `GET /api/plugins` 拿到的 `htmlContent` 渲染，不经过运行时。

### 9.3 安全边界（不能省略的部分）
- 渲染方式：`<iframe sandbox="allow-scripts" srcDoc={htmlContent} />`——**不使用** `allow-same-origin`（防止 iframe 内脚本访问父页面 `localStorage`/cookie/DOM），**不使用** `dangerouslySetInnerHTML` 挂到主文档。
- CSP：iframe 内容通过 `srcDoc` 加载时天然是 `null` origin，无法发起跨域请求读取 Axiom 自身的 API（即使用户在 mini-app 里写 `fetch('/api/tasks')`，会因为浏览器同源策略+缺少 `allow-same-origin` 而被拒绝）——这是本方案安全性的核心依据，必须保留，不能因为"用户体验"给 mini-app 加 `allow-same-origin`。
- 存储配额：单租户 mini-app 插件总数/总大小需要有上限（复用现有 Plugin 的 `listPlugins` limit 机制，另加一个 `htmlContent` 总大小校验，防止把数据库当文件存储滥用）。

### 9.4 前端
- 新增 `src/components/plugins/MiniAppWindow.tsx`：可拖拽（复用 `react-use-gesture` 或手写 pointer 事件，参照 `AgentOrbitCarousel.tsx` 已经写过的 pointer drag 逻辑风格）、可关闭、默认居中浮动窗口，内部挂载上述 sandboxed iframe。
- 插件列表/抽屉里，`kind === 'mini-app'` 的插件卡片"运行"按钮，点击后不走现有的"运行参数表单"流程（那是 prompt 插件专属的），直接弹出 `MiniAppWindow`。
- Agent Studio 或插件创建页需要一个入口让用户/Agent 提交 `htmlContent`（例如一个文本域直接贴 HTML，或者未来由 Agent 通过工具调用生成——生成 mini-app 代码本身是 Builder 角色配合一个新 Tool `plugin.createMiniApp` 的工作，那个 Tool 的高风险等级应设为 `high`，写入需要人工审批，复用现有 `workspace.write` 类的审批机制模式）。

### 9.5 风险与测试
- 补充测试：确认 iframe 渲染时 `allow-same-origin` 确实没有被设置（防止未来有人为了修 bug 顺手加上却没意识到破坏了安全边界）。
- 补充测试：`htmlContent` 超出大小限制时创建请求被拒绝。
- 人工验证：一个真实的贪吃蛇/井字棋等自包含 HTML 游戏能在 `MiniAppWindow` 里正常运行，且无法通过任何手段访问父页面的 `fetch('/api/...')`。

---

## 10. Douyin 素材整合最终状态

| 素材 | 许可证 | 状态 |
|---|---|---|
| `3D-card-acrylic-main.zip` | 无 LICENSE，用户已授权复用 | 已复用（`AgentOrbitCarousel.tsx`，即将按第 5 节改造成 `TaskOrbitCarousel.tsx`） |
| `emotion-ball-main.zip` | 双许可，非商用可全用 | 状态机+彩带已实现（`agentStateMachine.ts`），按 5.3 节需要迁移挂载点到 `CinematicCore.tsx` |
| `fluidglass-ui-main.zip` / `prism-glass-main.zip` | Apache-2.0 | 已用于 `dashboard.css` 玻璃质感 token |
| `morphicons-main.zip` | MIT | **未开始**，`npm install morphicons` 后替换任务状态/命令栏图标 |
| `orb-main.zip` | MIT，用户本机有 GPU | **未开始**，独立 WebGPU `<canvas>`，可用于登录页背景或 Agent Studio 预览场景 |
| `tim-ai-assistant-main.zip` | 无 LICENSE，用户已授权复用 | **未开始**，其六态状态机逻辑可与 `agentStateMachine.ts` 交叉参考，代码本身暂无明确挂载点 |
| `particle-heart-main.zip` | MIT | **未开始**，等登录页一起做 |

---

## 11. 登录开屏页（P1.11，独立不阻塞其他批次）

维持 `docs/dashboard-agentstudio-roadmap.md` Part C 的设计结论不变：纯视觉开屏页，不新增后端认证，鼠标响应网格背景 + 粒子化 logo（`particle-heart-main` 架构参考）。本文档不重复展开。

---

## 12. 执行批次（重新排序，反映第 14 节已确认的决策）

1. **旧前端物理删除**（第 7 节）——风险最高但用户明确要求优先，且不删干净后续所有视觉工作都是在"两套前端并存"的地基上做，越晚删越难。打快照后立刻做。
2. **左侧栏改造**（第 3 节）——"新建任务"按钮移入侧栏顶部，导航微调。
3. **历史任务玻璃卡片轮播改造**（第 5.1-5.2 节）——`AgentOrbitCarousel.tsx` → `TaskOrbitCarousel.tsx`，数据源切换。
4. **Agent 拓扑彩带效果迁移**（第 5.3 节）——从废弃的 `AgentAvatar.tsx` 迁移进 `CinematicCore.tsx`。
5. **右侧详情面板字段修正**（第 6 节）——按表格逐项替换，去掉编造字段，含"所属会话主题"派生逻辑。
6. **首页统计丰富化，全部 4 项**（第 4.2 节）——按文档内建议顺序：平均任务时长 → 我的任务筛选 → Reviewer 通过率 → Token 趋势图（工作量递增）。
7. **登录开屏页**（第 11 节）——独立进行，可与批次 2-6 穿插并行。
8. **插件弹窗化完整版**（第 9 节）——mini-app 插件类型 + iframe 沙箱，独立模块，可与批次 6-7 并行（文件作用域基本不冲突：`pluginStore.ts`/`MiniAppWindow.tsx` vs Dashboard 组件树）。
9. **Agent Studio Planner 接入**（第 8 节）——放最后，因为直接触碰核心调度路径（`orchestrator.ts`），需要在前面 8 个批次把新前端跑稳之后再动风险最高的部分；且 8.1-8.5 之间有严格的内部依赖顺序（先 schema 动态化，再 prompt 拼接，再工具权限，最后才是"Agent 创建 Agent"）。
10. **剩余 douyin 素材**（第 10 节：morphicons/orb-main/tim-ai-assistant/particle-heart）——穿插在批次 7（登录页用得上 particle-heart/orb-main）和其他视觉批次之间，无强依赖顺序。

## 13. 验证要求

沿用项目标准命令：

```bash
npm run check
npm test
npm run build
npm run qa:routing
npm run qa:runtime
npm run qa:visual
```

第 7 节（旧前端删除）完成后，必须额外做一次全量人工过一遍新前端的每个导航项和每个按钮，确认经典工作台覆盖的功能没有在删除过程中丢失——这是本次重建最大的回归风险点。

批次 9（Agent Studio Planner 接入）完成后，除标准命令外必须额外跑：`orchestrator.test.ts` 里新增的自定义角色参与计划、`fallbackPlan()` 兜底、`agent.propose` 沙箱执行三组测试全部通过，且用一个真实提交的 team/full-workflow 任务人工验证 Planner 确实选用了某个自定义 Agent 角色（不能只看单测通过就认为集成成功）。

批次 8（插件弹窗化）完成后，必须人工验证一个真实 mini-app（贪吃蛇/井字棋级别）能正常运行，且用浏览器开发者工具确认 iframe 无法访问父页面的 `fetch`/`localStorage`。

---

## 14. 开放问题裁决记录（已由用户逐项确认，不再是开放项）

以下 4 个问题已经过用户明确回答，记录在案，后续实现不应再对这些方向产生疑问或反复确认：

1. **首页统计丰富化范围**：全部 4 项都做（平均任务时长 / 我的任务筛选 / Reviewer 通过率 / Token 趋势图），不是只做零成本的一项。具体设计见第 4.2 节。
2. **Agent Studio 完整化**：现在就排期，Planner 动态角色接入（含"Agent 创建 Agent"）纳入本轮范围，不是搁置到未来。具体设计见第 8 节（8.1-8.9）。
3. **插件弹窗化范围**：做完整版——新增 `mini-app` 插件类型 + iframe 安全沙箱，不是"现有插件运行结果套个浮动窗口"的视觉小改动。具体设计见第 9 节（9.1-9.5）。
4. **"所属项目"字段**：不砍掉、不用裸 `sessionId`，提取真实的"任务目的"信息——取同一 `sessionId` 下最早一条任务的标题作为"所属会话主题"。具体设计见第 6 节表格对应行。
