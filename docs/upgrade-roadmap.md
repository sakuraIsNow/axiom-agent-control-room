# 前后端全面升级路线图

更新时间：2026-08-22

> 状态说明（2026-08-29）：Part B.1 的模块表和优先级是 2026-08-22 的审查基线，不是当前实现状态。P0.6/P0.7、MemoryCore L0-L3、Harness/Codex transport、协作事件可视化和 Agent Nexus 高级控制流已按 `TODO.md` 完成；真实 TencentDB、真实 sidecar 和外部对象存储仍需部署凭据做现场验收。

## 背景与目标

本文档整合了两轮独立代码审查（前端视觉/架构调研 + 后端 9 个核心运行时模块逐行审查）和一次市场对标分析（Devin、Manus、Genspark、LangGraph、LangSmith/Langfuse 等）的结论，目标是把 Axiom 从"有差异化定位但视觉传达力不足、部分后端能力是简化版"的状态，升级为"视觉表现力和后端实现深度都撑得住定位"的有竞争力产品。文中 Part B.1 的问题描述保留用于追溯本轮改造动因，当前状态以 `docs/launch-readiness.md`、对应实现文档和 `TODO.md` 为准。

**核心判断**：Axiom 的差异化定位是真实的——可恢复执行（PostgreSQL 租约 + `FOR UPDATE SKIP LOCKED`）、分级路由（不是所有请求都开多 Agent）、证据门禁 + 人工接管（Reviewer 强制分数阈值防止自我放水）——这几点在 2026 年的市场里确实稀缺，多数"Agent 应用"层产品（Manus/Genspark 这类云端黑盒执行）没有对等能力，LangGraph/CrewAI 这类框架也需要使用者自己搭建才能获得。但审查发现两类问题拉低了这个定位的说服力：

1. **前端视觉传达力不足**：功能真实存在，但被埋没在过于克制的界面里，后端产生的丰富数据（如 `agent.message`/`agent.conflict`/`budget.constrained` 的真实内容）目前甚至没有被前端呈现出来。
2. **部分后端模块是"能跑但简化"而非"生产级"**：具体见下方 Part B，尤其是工具沙箱覆盖率和 Scheduler 的失败处理，这两块存在与文档描述不完全一致的地方。

本文档分三部分：Part A 前端电影级重构，Part B 后端安全与可靠性加固，Part C 前后端联动项（两侧都要改）。所有条目的可勾选清单版本已经写入 `TODO.md` 的 P0.6/P0.7/P1.7/P1.8 节，本文档提供背后的完整设计依据。

---

## Part A：前端电影级重构

### A.1 现状

代码库里已有 4 代前端并存：

1. **经典工作台**（`App.tsx` 内联 JSX）— 表单化，功能最全，是唯一始终维护、始终正确的界面。
2. **Axiom Studio**（`src/components/AxiomStudio.tsx`）— 当前默认沉浸式外壳，`localStorage` 键 `axiom-view-mode-v1` 控制。
3. **Axiom Mission Deck**（`src/components/AxiomMissionDeck.tsx`）— 已写好，在 `App.tsx` 中 `lazy()` 导入但从未被任何 JSX 分支渲染，是死代码路径。
4. **Immersive Control Room**（`src/components/ImmersiveControlRoom.tsx`）— 已写好，连 import 都没有，完全未挂载；但包含两个值得收编的机制：指针视差 + 全息光泽（`--parallax-x/y`/`--glare-x/y` CSS 变量驱动）和 `CountUp` 动态计数组件（`ImmersiveControlRoom.tsx:53-68`）。

三套沉浸式外壳彼此是近乎重复的平行实现（各自的 header/nav rail/command bar/graph 视图/指标条互不共享），都包裹同一个底层 3D 组件 `src/components/ImmersiveCore.tsx`。

`docs/launch-readiness.md:66-74` 现有的"前端改造原则"明确反对大面积渐变/光球装饰和夸张控件，`App.tsx:2542` 系统说明页写着"AXIOM 保留真实任务状态，不做纯展示动画"——这是刻意的克制选择，不是没做到位。**本轮升级决定反其道而行之，做电影级、更强视觉冲击力的方向**，因此 `docs/launch-readiness.md:66-74` 和 `App.tsx:2542` 的文案需要在实施过程中同步更新，不再视为约束。

### A.2 决策：整合为一套新外壳，经典工作台作为唯一备用

- 新沉浸式外壳成为默认入口，替换 `AxiomStudio` 当前的角色。
- 经典工作台保留为唯一可切换的备用入口。
- `AxiomMissionDeck.tsx` 和 `ImmersiveControlRoom.tsx` 中有价值的机制（`CountUp`、指针视差+全息 CSS 变量驱动）被收编进新外壳后，两个源文件整体移入 `frontend-backup/`（沿用项目已有的 `frontend-backup/YYYYMMDD[-HHMMSS]-pre-<feature>/` 命名惯例——**本项目不是 git 仓库，这是唯一的回滚手段**），不再作为独立可切换入口保留。
- `ImmersiveCore.tsx` 在新外壳上线、旧外壳清退后没有任何调用方，同批删除。

### A.3 视觉方向

以"自主智能体核心"为唯一视觉锚点，四条主线：

1. **动态自主智能体球**：用已安装的 `@react-three/drei`（10.7.8）的 `MeshTransmissionMaterial`/`MeshRefractionMaterial` 把 `ImmersiveCore.tsx` 里现有的 `CoreOrb`（icosahedron + 2 tori）升级为玻璃/金属质感核心，替代当前简单的 `meshPhysicalMaterial`。**仅此一个核心对象使用高开销材质**——已直接读取 drei 源码确认：`MeshTransmissionMaterial` 默认（`transmissionSampler = false`）每个实例都用 `useFBO` 分配独立渲染目标，并在主渲染通道之外额外对整个场景做一次完整渲染，这是逐实例的开销，不能用于场景中的多个次要物体。其余节点继续用现有的 `meshPhysicalMaterial`+`clearcoat`（`AgentNode`/`RuntimeNode` 现状已经如此，效果本身不差）。
2. **推理图 / Agent 网络可视化**：复用 `src/components/AgentScene.tsx` 里已存在、真正做了避障的 Catmull-Rom 曲线连线算法（`buildConnectionPoints`/`curveClearance`，`AgentScene.tsx:43-106`）——用 `CatmullRomCurve3` 评估多组弯曲/深度候选路径，按"离其他节点球体的距离"打分选最优路径。这套逻辑目前只服务经典工作台的 inspector 面板，没有被三套沉浸式外壳共享（`ImmersiveCore.tsx` 的 `Connections` 组件，`:97-113`，是直线+固定深度偏移的简化实现，完全不做避障）。**做法**：把 `buildConnectionPoints`/`curveClearance`/`curveLength`/`nodeRadius` 抽成纯函数模块 `src/lib/curveRouting.ts`（只依赖 `Vector3`/`CatmullRomCurve3` 数学，不耦合 React/组件），`AgentScene.tsx` 和新外壳的 GraphView 都从这个模块导入。
3. **粒子海 / 全息覆盖层 / 电影级视差**：`ImmersiveCore.tsx` 已有 `LuminousParticleOcean`（220 点正弦波场，指针响应）可以直接加强密度和响应范围；`ImmersiveControlRoom.tsx` 已有的指针视差 + 全息扫描机制直接移植进新外壳。用已安装的 `@react-three/postprocessing`（3.0.5）的 `EffectComposer` 叠加 `Bloom` + `ChromaticAberration` + `Vignette` 做电影调色感——**目前项目里只有 `AgentScene.tsx`（经典工作台专用）在用 `Bloom`，`ImmersiveCore.tsx`（当前默认外壳的核心视觉）完全没有任何后期处理**，这是零新增依赖就能拿到电影感的空当。
4. **玻璃态 UI / 金属质感 / 大胆排版**：CSS 层面延伸现有 `--surface`/`--line`/`--modal-bg` token 体系，新增一组玻璃态专用 token，不发明平行的类名系统。经典工作台刻意关闭 `backdrop-filter` 的既有约定保持不变——玻璃效果仍只出现在新沉浸式外壳。

### A.4 组件拆分

新外壳拆分到 `src/components/shell/`，不再写单体组件：

```
src/components/shell/
  AxiomShell.tsx        — 根组件：布局网格、视图态、键盘快捷键
  ShellHeader.tsx        — 品牌角标、phase/live 指示、provider 徽章
  ShellNavRail.tsx       — 视图切换 + 工作区导航
  ShellCommandBar.tsx    — 输入框、发送/停止、模式选择
  ShellObservatory.tsx   — 视口容器，在 CoreView/GraphView/StreamView 间切换
  CoreView.tsx           — 包裹 CinematicCore
  GraphView.tsx          — 推理图可视化（复用 curveRouting.ts）
  StreamView.tsx         — 事件时间线
  MetricsStrip.tsx        — 指标条，接入 CountUp
  Inspector.tsx          — 选中节点详情面板
  useParallax.ts          — 从 ImmersiveControlRoom 收编的指针视差 Hook
  CountUp.tsx             — 从 ImmersiveControlRoom.tsx:53-68 收编
```

**状态管理**：引入 `zustand`（5.0.15 已安装但全项目零处使用），但只限定在渲染热点的运行时数据切片，不做全局迁移。`App.tsx`（3119 行）混合了会话/消息态、任务控制回调、弹层可见性开关，以及新外壳真正需要的运行时/图数据（phase、topologyAgents、agentGraph、runEvents、usage、loopState）。如果继续把全部 ~25 个 props 透传下去，任何一个状态变化（哪怕只是某个弹层开关）都会导致整棵新外壳子树重渲染。做法：新建一个只装运行时/可视化切片的 `useShellStore`，由 `applyWorkflowEvent` 直接写入，叶子组件用 `useShellStore(s => s.phase)` 选择器订阅。动作回调（onSend/onPause/onBack 等）依然走 props。**`App.tsx` 里会话/任务列表/弹层状态不在本次范围内，不要借机把它们也搬进 zustand**。

**CSS 落位**：新外壳样式放到物理独立的新文件（`src/styles/shell.css`，体量大可再拆），延续现有纯 CSS + 全局类名写法，不引入 CSS Modules（项目零先例，没必要为一套外壳引入第二种样式方言）。在 `main.tsx` 里额外 import，Vite 会在构建时合并。`data-theme` + `src/lib/uiTheme.ts` 的桥接机制保持不变——3D 层的调色继续以 `uiTheme.ts` 的 `scene` 字段为唯一真源（3D 组件在 JS 里直接读取十六进制值，不经过 CSS 变量）。

**3D 架构**：新写 `CinematicCore.tsx`，不在 `ImmersiveCore.tsx` 原地扩展（两者服务的相机模型本质不同：`AgentScene` 是可拖拽相机的聚焦检查面板，`ImmersiveCore`/`CinematicCore` 是固定相机的常驻氛围英雄视觉，强行合并会重新制造"一个组件塞下所有逻辑"的问题）。

### A.5 事件数据缺口（前端能呈现多丰富，取决于这一步）

已通读 `applyWorkflowEvent` 全文（`App.tsx:900-1182`）并逐项 grep 确认：**`agent.message`、`agent.conflict`、`budget.constrained` 这三类事件目前只走函数最前面的通用分支**（`addRunEvent(nextPhase, workflowEventLabel(event))`），没有任何专属分支——它们携带的真实数据（协作消息正文、冲突的具体结论、预算压缩的步骤级细节）在被拍扁成一句"XXX 发送了协作消息"这样的日志行之后，**原始 payload 彻底丢弃，没有保存到任何组件能读取的状态里**。新外壳要呈现这三类事件的真实内容，必须先给 `applyWorkflowEvent` 加新分支（做法可以照抄现有 `tool.approval_requested`/`review.approval_requested` 分支的模式：从 `event.payload` 取字段、设新的 state、按 taskId/id 去重）。**这是 `App.tsx` 本体的改动，是前端可视化能否体现后端真实能力的前置依赖**，详见 Part C。

同时需要决定：`ImmersiveCore`/`AgentScene` 当前都把可见节点数截断在 10-12 个（`ImmersiveCore.buildNodes` 用 `.slice(0, 12)`，`AgentScene.buildNodes` 用 `.slice(-10)`），既然目标是"更丰富的推理图可视化"，这个截断上限是否放宽应该是明确决定。

### A.6 风险提示

- **移动端性能**：经典工作台现有应对方式是"缩小画布尺寸"（`.agent-scene` 移动断点下 `min-height` 从 235px 降到 133px），但不降低渲染复杂度。透射材质的额外全场景渲染开销和画布显示尺寸无关，缩小画布不能降低这部分成本。需要真正的移动端复杂度降级：`dpr` 上限调低、移动端用 `meshPhysicalMaterial` 回退、粒子数量进一步降低（`ImmersiveCore.tsx` 已有 active/idle 两档数量切换先例，照此模式加一档移动端数量）。
- **Bundle 体积**：`TODO.md` P2 已记录"约 1MB 场景 chunk"。已核实最近一次构建产物：`dist/assets/Line-JOVWEEOc.js` 实际是 898KB（drei 线渲染模块，`AgentScene`/`ImmersiveCore` 共用），这才是真正的来源。本次升级不会缩小这个体积，引入 `MeshTransmissionMaterial`/`Environment` 只会略微增加，分包优化不在本次范围但要如实承认。
- **GSAP 与 React 渲染周期**：如果新外壳用 GSAP 做视图切换动画，避免用条件渲染卸载/挂载组件的方式（会打断 GSAP tween），改为三视图同时挂载、用 GSAP 控制透明度/位移做 crossfade。
- **SSR/hydration**：不适用，`server/index.ts` 只用 `serveStatic`，`main.tsx` 用 `createRoot(...).render(...)`，纯客户端渲染，无需考虑。

### A.7 实施顺序（5 个可独立验证的批次）

不建议单批次一次性改完——本项目没有 git 仓库，`frontend-backup/` 手工快照是唯一回滚手段。

1. **快照 + 前置重构**：打 `frontend-backup/<时间戳>-pre-cinematic/` 快照；抽取 `curveRouting.ts`（纯重构，无视觉变化）。验证：`npm run check`、`npm run build`。
2. **新外壳并行搭建（不接入口）**：搭建 `src/components/shell/`、`src/styles/shell.css`、`CinematicCore.tsx`，收编 `CountUp` 和视差机制。不改 `App.tsx` 渲染分支。验证：`npm run check`。
3. **切换默认入口**：把 `App.tsx:1766-1797` 的 `immersiveOpen` 分支改为渲染新外壳；`AxiomStudio.tsx` 暂时保留以便对比。这是唯一有真实用户可见影响面的一步，单独成批。验证：`npm run check && npm test && npm run build && npm run qa:visual`，并手动过一遍四主题切换、真实任务提交、暂停/恢复、经典工作台来回切换。
4. **清退孤儿外壳**：删除 `AxiomMissionDeck.tsx`、`ImmersiveControlRoom.tsx`、`ImmersiveCore.tsx`（先 grep 确认零引用），清理 `App.tsx` 里的 `lazy()` 导入，删除 `styles.css` 里的死代码（注意先确认类名前缀没有被经典工作台的"进入沉浸模式"入口按钮复用）。验证：`npm run check && npm run build`。
5. **QA 与文档同步**：更新 `scripts/visual-qa.mjs` 选择器、`docs/launch-readiness.md:66-74` 和 `App.tsx:2542` 的过时文案。验证：`npm run check && npm test && npm run build && npm run qa:visual`。

如果第 2 批之前需要呈现 `agent.message`/`agent.conflict`/`budget.constrained` 的真实内容，要先完成 Part C 的 `App.tsx` 归约器改动。

### A.8 本地设计参考（技法参考，不做代码直接搬运）

技术栈不同（目标项目是 Vite + 纯 CSS + R3F，多数参考项目基于 Next.js + Tailwind + Framer Motion），仅学技法，重写实现：

- **react-bits-main.zip**：`Backgrounds/Orb`、`Backgrounds/Particles`、`Backgrounds/Galaxy`、`Backgrounds/Ballpit` 对应"3D 粒子核心"；`Animations/MetallicPaint` 对应"金属质感"；`Components/GlassSurface`/`FluidGlass`/`GlassIcons` 对应"玻璃态 UI"；`TextAnimations/CountUp` 对应"动态计数"。License 已核实：`MIT + Commons Clause v1.0`，允许作为应用一部分使用（含商业用途），只禁止把组件本身单独转售/再许可/打包成库分发——按此条款可以直接移植/改写组件源码（需保留版权声明），但因技术栈不同仍需重写样式与依赖。
- **aceternity-saasternity/**（Next.js+Tailwind+shadcn）：`spotlight.tsx`、`glare-card.tsx`、`glowing-effect.tsx`、`sparkles.tsx`、`shooting-stars.tsx`、`vortex.tsx` 是玻璃/光效/粒子背景的技法参考；`hero-parallax.tsx` 对应"电影级视差"。
- **uiverse-galaxy/**（纯 HTML/CSS 片段库）：技法可直接改写进现有纯 CSS token 体系，是控件级微交互成本最低的来源。
- **gsap-skills-main.zip**：`gsap-plugins` 文档里的 `MorphSVGPlugin`、`Physics2DPlugin`，`gsap-scrolltrigger` 文档里的 `pin`+`scrub`+`batch()` 是"幻灯片式过渡"的技术依据。

---

## Part B：后端安全与可靠性加固

以下结论来自对 `server/runtime/orchestrator.ts`、`scheduler.ts`、`memoryClient.ts`、`harnessClient.ts`/`harness.ts`、`toolExecutor.ts`/`toolRegistry.ts`、`metrics.ts`、`readiness.ts`、`postgresTaskStore.ts`/`sqliteTaskStore.ts` 的逐行审查，并核对了 `TencentDB-Agent-Memory-feat-server_team.zip` 参考源码。

### B.1 模块现状速览

| 模块 | 结论 |
|---|---|
| `orchestrator.ts` | 真实可用、有工程深度的调度器（`Promise.allSettled` 批次并发、指数退避重试、AbortSignal 组合超时、Reviewer 强制分数阈值防自我放水）。但"智能"部分是朴素启发式：`agent.conflict` 检测（`:108-146`）是**正则关键词极性匹配**，不是语义比较；`budget.constrained` 压缩（`:1071-1099`）是**剩余预算平均分配**，不考虑角色权重。 |
| `scheduler.ts` | 定时任务认领逻辑是生产级实现（`PostgresScheduler.tick()` 用 `FOR UPDATE SKIP LOCKED` + 事务）。但**没有死信队列、没有指数退避重试、没有失败计数**——`ScheduledTrigger` 类型里连 `failureCount` 字段都没有，失败的触发器会无限静默重试、从不告警。Webhook（`taskApi.ts:734-744`）只有共享密钥比对，没有 HMAC 签名验证 payload、没有防重放窗口。 |
| `memoryClient.ts` | **2026-08-22 审查基线**：接口设计规范（照参考系统官方 adapter 模式实现），但只用了 MemoryCore v3 API 面的 **4/17+ 个端点**（约 20-25%），全部是只读+纯追加，没有更新/删除/L2-L3 写入能力，也**没有去重游标**——任务因租约丢失重跑时，`capture()` 可能被调用两次，重复写入记忆。当前实现已由 P0.6/P0.7 后续改造覆盖，详见 `docs/memorycore-recovery.md`。 |
| `harnessClient.ts`/`harness.ts` | **2026-08-22 审查基线**：能力握手（`handshake()`）是真实网络请求，不是 mock。但当时 `startThread`/`startTurn`/`subscribe` 等六个核心方法**全部显式抛错**，且 orchestrator.ts/coordinator.ts 里没有任何调用点。当前已由 ACP stdio、Codex app-server v2 和 `HarnessTaskBridge` 覆盖，详见 `docs/harness-transport.md`。 |
| `toolExecutor.ts`/`toolRegistry.ts` | **2026-08-22 审查基线**：Docker 沙箱配置本身是生产级标准（`--network=none --read-only --cap-drop=ALL` 等），但当时**12 个已注册工具里只有 7 个（58%）真正经过沙箱**，且 HTTP/浏览器 allowlist 未覆盖 metadata 地址。当前 handler 工具已显式标注 `host-bounded`、统一经过 Docker 执行门禁，并补充 IPv4/IPv6/metadata 拦截，详见 `docs/tool-registry.md`。 |
| `metrics.ts` | 真实、可用的 Prometheus 指标实现，字段设计合理。但纯内存存储，**进程重启即清零**；全仓库零 `@opentelemetry/*` 引用，无分布式追踪能力。 |
| `readiness.ts` | **2026-08-22 审查基线**：轻量、诚实但检查深度有限——当时 11 项检查全部是**"环境变量是否非空"**，不做真实连通性探测。当前已调用 MemoryCore、模型、Docker、对象存储和 Harness 的真实探测，并对结果做短 TTL 缓存，详见 `server/runtime/readiness.ts`。 |
| `postgresTaskStore.ts` vs `sqliteTaskStore.ts` | 两者 API 对称，Postgres 版本是教科书式正确的多 Worker 实现（`SKIP LOCKED` + advisory lock）。风险点：**租约丢失后的副作用去重/补偿在两边都没有加强**——如果工具调用了外部 API 但结果还没来得及写入 `stepResults` 时租约丢失，重跑可能导致副作用重复执行，orchestrator.ts 没有为此设计幂等键。 |

### B.2 优先修复的 5 件事（按影响程度排序）

1. **工具执行安全一致性**（对应 `TODO.md` P0.6，已完成）：命令型工具走 Docker 沙箱；handler 型工具显式标注 `host-bounded`，统一经过 Docker 执行门禁，并由应用层路径、只读事务、allowlist、原子写和人工审批提供边界；HTTP/浏览器适配器已拦截云 metadata、IPv4/IPv6 内网地址。
2. **Readiness 真实探测**（对应 `TODO.md` P0.7，已完成）：`readiness.ts` 已调用 MemoryCore、模型、Docker、对象存储和 Harness 探测，并使用短 TTL 与并发合并避免刷新风暴；未配置的可选依赖会显示为降级而不是伪造 ready。
3. **Scheduler/Webhook 死信队列与重试策略**（对应 `TODO.md` 现有 P1.5，补充具体发现）：给 `ScheduledTrigger` 加 `failureCount`/`lastError`/`lastRunStatus` 字段，失败按指数退避重新排期而非固定间隔重试，超过上限进入死信状态并可查询/告警。
4. **协作事件数据接入**（对应 Part C / `TODO.md` P1.8）：见下方 Part C，属于前后端联动项。
5. **可观测性升级**（对应 `TODO.md` 现有 P2 OTel 项，补充具体发现）：接入 OTel exporter，Prometheus counters 从纯内存改为可跨重启持久化/跨副本聚合的方案。优先级低于前 3 项，因为当前单节点部署下影响有限，但要谈多副本生产部署就是硬性前提。

**DeepSeek Harness 决策**（对应 `TODO.md` 现有 P1.3-H，已完成第一阶段）：当前采用显式启用的 ACP JSON-RPC stdio transport，并由 `HarnessTaskBridge` 接入任务委托、统一事件、审批回放、断流暂停和跨重启恢复；Codex app-server v2 使用同一隔离 stdio 边界。HTTP capability discovery 保留为兼容探测，不会冒充可执行 transport；真实 sidecar 的版本、workspace 和审批策略仍需部署环境固定后现场验收。

---

## Part C：前后端联动项——协作事件可视化

这是本次升级里唯一同时需要改前端和后端的条目，价值也最高：后端已经产生了 `agent.message`（Agent 间结构化交接消息）、`agent.conflict`（并行 Agent 结论冲突检测结果）、`budget.constrained`（预算压缩详情）三类事件，但目前这些数据在到达前端之前就被拍扁丢弃了。

**后端侧**（`App.tsx` 归约器，属于前端代码但逻辑是"承接后端数据"）：`applyWorkflowEvent`（`App.tsx:900-1182`）需要为这三类事件增加专属分支，参考现有 `tool.approval_requested`（`:1055-1069`）/`review.approval_requested`（`:1030-1051`）分支的模式：从 `event.payload` 取字段、设新的 state、按 taskId/id 去重。

**前端侧**：新外壳的 GraphView/StreamView（或 Inspector）渲染这些新状态——协作消息正文、冲突双方的具体结论（不只是"有冲突"）、预算压缩前后每个 step 的 token 分配变化。

这一项建议排在 Part A 实施顺序的第 2 批之前完成（如果设计稿要求呈现这些内容），因为它是新可视化能否体现后端真实能力的前置依赖，不能在新组件写完之后才补。

---

## 优先级总览

| 编号 | 条目 | 类型 | 对应 TODO.md |
|---|---|---|---|
| P0.6 | 工具执行安全一致性 | 后端安全 | 新增 |
| P0.7 | Readiness 真实探测 | 后端可靠性 | 新增 |
| P1.5（补充） | Scheduler/Webhook 死信与重试 | 后端可靠性 | 已有条目，补充具体发现 |
| P1.3-H（补充） | DeepSeek Harness 路线决策 | 后端范围界定 | 已有条目，补充决策要求 |
| P1.7 | 前端电影级重构 | 前端 | 新增 |
| P1.8 | 协作事件可视化 | 前后端联动 | 新增 |
| P2（补充） | OTel + 指标持久化 | 后端可观测性 | 已有条目，补充具体发现 |

## 验证要求

沿用项目现有标准命令，每批改动后运行：

```bash
npm run check
npm test
npm run build
npm run qa:routing
npm run qa:runtime
npm run qa:visual
```

涉及前端视觉的改动必须运行 `npm run qa:visual`；涉及后端安全/调度改动的建议补充人工审查（沙箱隔离边界、SSRF 黑名单覆盖率无法被现有自动化测试完全验证）。本项目不是 git 仓库，任何大范围改动前应参考 `frontend-backup/` 惯例先做快照。
