# 上线就绪度与产品能力评估

更新时间：2026-09-03

## 结论

当前版本是“本地或受控单节点生产候选”，不是可以直接暴露到公网的企业生产系统。任务、事件、租约恢复、动态路由、子 Agent 并行、Reviewer 质量门禁、PostgreSQL 持久化、PostgreSQL 调度和 Docker 沙箱已经形成可运行闭环。当前启动实例的 `GET /api/health` 返回 `ready`；`GET /api/runtime/readiness` 返回 `degraded` 且没有硬阻塞，PostgreSQL、文本与图像模型、Docker 沙箱和 Prometheus 已就绪。未启用签名租户身份、未配置视频服务和长期记忆、对象存储仍使用本地目录是当前四项降级告警。用户级任务、日程和 Artifact 通知已经可以通过签名 Webhook 外发；邮件渠道、运营级系统告警自动外发和真实 PostgreSQL 多 Worker 演练仍待完成。

这意味着：内部试用、单团队灰度和受控网络部署可以开始；面向多个租户、外部用户或高价值自动化任务前，必须完成下面的上线门禁。

## 最新本机验证（2026-09-03）

本轮门禁开始前已确认 Docker Engine `28.0.1` 正常运行且 `ubuntu:22.04` 沙箱镜像可用。在当前 Windows 单节点、本地测试数据和 10 并发条件下，50 次请求全部返回 HTTP 200；本次 `npm run perf:smoke` 的并发吞吐为 health `1829.88 RPS / P95 8.22ms`、Readiness `2734.18 RPS / P95 4.53ms`、运行观测 `856.02 RPS / P95 29.16ms`、任务列表 `2375.65 RPS / P95 5.37ms`。标准单元/API 门禁为 `358 passed / 0 failed`；`npm run qa:all` 为 `24 passed / 0 failed / 4 skipped`，24 项均在第一次尝试通过。本次复杂 Runtime 产生 798 个连续事件、704 个可见流式增量和 27,706 Token，通过 Reviewer 92 分门禁并正常交付 1,243 字符的 Artifact。4 个跳过项分别是未配置的 TencentDB MemoryCore HTTP、Axiom MemoryCore 适配器、外部 Artifact 存储和 Harness/Codex sidecar 命令，跳过不等于通过。该基线包含真实模型任务、Docker 沙箱探测和浏览器回归，但不代表公网容量；运行 `npm run perf:smoke` 和 `npm run qa:all` 可在本机重新生成完整结果，生成的结果文件默认不提交到仓库。

## 当前真实能力

| 能力 | 当前状态 | 证据/边界 |
| --- | --- | --- |
| 任务持久化与恢复 | 已可用 | PostgreSQL task/event 表、租约、`FOR UPDATE SKIP LOCKED`、SSE 事件回放 |
| 智能分级路由 | 已可用 | `direct`、`single-agent`、`team`、`full-workflow` 四路回归评测 4/4 |
| 子 Agent 协作 | 已可用 | Planner 生成依赖批次，Researcher/Analyst/Builder 并行，Reviewer 可要求修正 |
| 失败处理 | 已可用 | 模型超时/429/5xx 退避重试；推理模型自适应超时与并发；流读取停滞可中止；部分 Agent 失败时保留检查点并生成部分交付，全部失败才终止 |
| 工具执行隔离 | 有边界可用 | Docker `--network=none`、只读根文件系统、能力丢弃、命令白名单；当前已接入 4 个只读/测试 Tool Registry 工具，写入和发布工具仍需策略审批 |
| 图片生成/编辑 | 已可用 | 独立于文本会话的 Image Runtime；服务端 DMX 或临时自定义 Provider |
| 长期记忆 | 适配器与恢复闭环已完成，部署未启用 | `TencentMemoryClient` 已完成 L1/L2/L3 召回、过期/置信度过滤、时间游标去重、跨重启收据和失败补偿；当前平台正式环境仍未配置 `TDAI_MEMORY_ENDPOINT`，真实 TencentDB 现场验收待凭据 |
| 多实例 Artifact | 生命周期目录已接入，外部存储部署未验收 | `artifact_records`/`artifact_references` 持久化来源、保留期、引用和清理状态；S3 兼容 Put/Get/Delete、租户作用域 key、超时和 `HeadBucket` 探测已接入；`npm run qa:object-storage` 可在配置 endpoint 后验证双 Worker 读写、租户隔离、删除和大对象回读；当前仍使用本地目录，需配置 MinIO/S3/COS 并完成真实验收 |
| 多实例触发器 | 基础可用 | 配置 `DATABASE_URL` 时使用 PostgreSQL `FOR UPDATE SKIP LOCKED` 调度和租约；Webhook 已有 HMAC、幂等、指数退避和死信恢复，仍需外部告警与多实例压测 |
| 用户与租户隔离 | 仅有边界 | HMAC principal 已实现，但本地未启用；公网不能信任客户端租户 header |
| 可观测性 | 基础可用 | Prometheus 文本指标、持久任务/事件运营快照和告警 API 已启用；进程内 counters 重启清零，OTel exporter 尚未接入 |
| Harness/Codex transport | 协议级完成，现场接入待配置 | DeepSeek ACP 与 Codex app-server v2 JSON-RPC stdio、Thread/Turn/Item 事件、审批回放、断点恢复和断流补偿已通过 fake sidecar；真实 sidecar 需固定版本和 workspace |
| Agent Nexus 控制流 | 已可用 | 条件 DSL、多 Loop/嵌套 Loop（最多 256 步）、分支事件、DAG 展开和节点级局部重跑已通过单元/API 回归 |
| 插件发布与恢复 | 已可用 | 发布前检查完整结构、直连网络、外部资源、字段冲突和工具权限；修改后自动回草稿，历史版本以新版本恢复；Prompt 运行与 Mini App 打开前均重读当前版本；可选 HMAC 签名覆盖内容、权限和发布身份，内容、权限风险、签名或验签配置漂移时拒绝运行 |
| 租户内插件市场 | 已可用 | 作者提交具体版本，签名租户 `owner/admin` 审核后生成不可变市场快照；安装固定版本，新版需显式升级；撤回版本立即禁止启动和运行，并可恢复到仍有效的安全审核版本。当前范围是租户内市场，不是跨租户公共应用商店 |
| Checkpoint 分支与合并 | 已可用 | revision 原子冲突检测、幂等分支、差异比较和三方合并已通过单元/API/浏览器回归；冲突策略必须显式选择 |
| 长结果与上下文恢复 | 已可用，外部对象存储待现场配置 | 大步骤输出使用 `result_ref`，普通 Agent 只接收预览，Reviewer/Synthesizer 有界回读；持久摘要带来源 digest，漂移后自动重建；运行观测展示压缩、覆盖、复用、重建和 tokenizer 可信模式，当前默认仍是保守 Token 估算；对象存储故障时数据库保留全文 |
| 首次使用路径 | 已可用 | 仅在默认任务页且任务和会话均成功确认为空时显示工作区内引导，三个入口直接进入对话、插件和 Agent Nexus；已有用户、接口读取失败和 URL 深链接恢复场景不误弹，桌面/移动端浏览器回归已覆盖 |
| 运行告警 | 已可用 | `GET /api/runtime/alerts` 根据队列积压、租约过期、模型/工具失败、Artifact 清理和 Readiness 生成带严重级别的告警；阈值由环境变量控制 |
| 用户外发 Webhook | 已可用，部署接收端待现场验收 | 从真实站内通知幂等投影到持久 Outbox；地址与签名密钥加密，投递带 HMAC 签名、租约、指数退避、死信、人工重投和脱敏审计；公网目标只允许 HTTPS 并在发送前复核 DNS。邮件渠道尚未实现 |

## 上线前必须补齐

### 1. 身份、租户与密钥

- 在反向代理或 OIDC 网关完成登录、租户解析和角色映射，再注入签名的 `x-axiom-principal`。
- 开启 `AXIOM_API_KEY` 或可信代理认证，并限制 `AXIOM_ALLOWED_ORIGINS` 到正式域名。
- 文本模型、图片模型和自定义 Provider Key 进入 Secret Manager；当前浏览器临时 Key 只适合会话直连，不支持可恢复任务。
- 增加租户配额、并发配额、单任务成本上限和审计查询权限。

### 2. 持久化与分布式运行

- 为已接入的 S3/COS/MinIO adapter 配置真实 bucket，运行 `npm run qa:object-storage` 完成双 Worker 读写/删除、租户前缀、生命周期策略和大文件回读验收；大文件分片能力仍需按目标供应商协议补充。
- 使用运行观测中的 Artifact 面板检查孤儿和待清理数量；任务删除失败会保留在 `delete_pending` 重试队列，可通过 `POST /api/runtime/artifacts/cleanup` 由租户管理员重试。
- scheduler、入站 Webhook 与外发通知 Outbox 在真实 PostgreSQL 多实例环境完成租约、幂等、退避、死信恢复和故障演练；使用真实 HTTPS 接收端验证 HMAC、重复投递和密钥轮换。
- PostgreSQL 配置备份、恢复演练、连接池上限、慢查询监控和迁移回滚策略。

### 3. 工具与执行安全

- 制作包含 `node`、`npm`、`git`、`rg` 等依赖的专用 sandbox image，替换通用 `ubuntu:22.04`。
- 将 Tool Registry、参数 schema、审批策略、超时和结果 Artifact 正式接入 Planner/Builder workflow。当前沙箱是安全边界，不等于模型已经拥有可审计工具调用能力。
- 对写文件、网络访问、凭证读取和发布操作增加人工批准或租户级策略。

### 4. Harness、MemoryCore 与 Nexus 现场验收

- 为 TencentDB MemoryCore 配置 `TDAI_MEMORY_ENDPOINT` 和 Secret Manager 凭据，重启两个 Worker，运行 `npm run qa:all` 验证真实 L0-L3、L2 异步场景、过期/置信度过滤、游标去重和失败补偿。
- 为 DeepSeek Harness 或 Codex app-server 固定 sidecar 版本、命令、工作区和审批策略，使用真实 Thread/Turn/Subscribe 流验证审批回放、Artifact lineage、断点恢复和异常断流重连。Codex `0.149.1` 已完成真实 stdio 握手，但这不替代任务级和跨 Worker 验收；DeepSeek rc.8 还需要 Node >=22.19、pnpm 和已构建 ACP 命令。
- 在 Agent Nexus 建立条件分支、独立 Loop 和嵌套 Loop 业务 case，验证 branch/loop 事件顺序、局部 rerun 只重跑 descendants，并记录任务成功率、人工接管率和成本。

### 5. 质量、评测与运营

- `npm run qa:business` 已按 HarnessEval-W 的分段思路保存 metadata、partial progress 和 artifact validation，覆盖按难度路由、跨轮 Agent/Skill 漂移、执行中改需求、Harness steer 真实状态、长结果边界、摘要恢复和 Checkpoint 冲突。下一步继续增加真实行业任务集、引用正确率、证据树和跨模型/跨版本质量基线；当前 6 个控制流分段不能代表所有真实业务准确率。
- 记录每个模型请求的 trace/span、token、成本、重试、队列等待和人工接管率；把内存 counters 外置到 Prometheus/OTel。当前摘要压缩、覆盖、复用和重建已进入持久运营快照，但 Provider 精确 tokenizer 与摘要语义质量基线仍待接入。
- 用户级任务、日程和 Artifact 通知已经可通过签名 Webhook 外发；下一步将 `GET /api/runtime/alerts` 的运营级系统告警接入 Grafana Alerting、PagerDuty 或邮件，并按租户和环境配置阈值。当前通用邮件渠道尚未实现。
- 对高风险输出增加引用、证据来源、置信度和“未验证假设”字段，并建立线上反馈闭环。

## 相对常见产品的差异

本平台的可验证优势不是“回答更像人”，而是把 Agent 当成可恢复的执行系统：

1. **按难度扩容，而不是所有请求都开多 Agent。** 闲聊和短事实问题走 Direct Response，窄任务走单 Agent，中等任务才启用小团队，复杂任务才进入 Reviewer 质量门禁。这直接降低延迟和调用成本。
2. **任务是可恢复、可审计的对象。** 事件先写 PostgreSQL 再广播，支持断线回放、Worker 租约和检查点；这比只保存聊天消息的 Agent UI 更适合长任务。
3. **质量门禁位于交付路径。** Reviewer 可以拒绝结果并触发修正，Synthesizer 只能汇总已验证结果，避免把“模型生成完成”误当成“业务完成”。
4. **模型、记忆、Harness、工具和图片通道是适配器边界。** 可以切换 DeepSeek 或 OpenAI-compatible Provider，也能在不重写调度器的情况下接入 MemoryCore、Harness、S3 和沙箱。
5. **运行时状态可视化。** 3D 拓扑由真实 workflow event 驱动，能够看到 Planner、子 Agent、Reviewer 的状态，不是单纯的装饰动画。

这些是产品方向上的核心能力，但目前还不是不可替代的市场护城河。要形成真正竞争力，需要用真实业务数据证明：相同成本下的任务成功率、人工接管率、恢复成功率、证据完整度和长任务 SLA 明显优于 Open WebUI、LobeHub、通用工作流编排器或单 Agent Coding 工具。

## 电影级运行外壳

唯一生产入口是 `AxiomDashboard`。其中的 Agent Graph 由真实 Task、Graph、Event 和 SSE 驱动，使用独立于 WebGL 的 CSS 3D 渲染；节点保留立体体积、可拖拽旋转、双向选择、全屏和详情抽屉。系统会根据减少动态偏好、CPU 核数、设备内存、省流模式、页面可见性和视口状态自动降低或暂停动画，因此浏览器不支持 WebGL 时也不需要切换到第二套任务界面。旧 R3F 场景源码仍保留供后续实验，但未挂载到生产入口，也不会进入或预加载生产构建；旧经典工作台、旧 Studio 和遗留 Immersive 入口已删除。

## 前端改造原则

当前界面已按控制台而非营销页重做：

- 参考 `uiverse-galaxy` 的触感反馈、状态指示和小尺寸动作控件，但去掉不适合运营系统的夸张按钮。
- 参考 `aceternity-saasternity` 的 3D/悬停层次，将 3D 仅用于运行时拓扑，不用大面积渐变和光球装饰。
- 参考 `react-bits`/GSAP 的渐进出现和 reduced-motion 处理，首屏改成任务入口、路由上下文和交付状态。
- 保持移动端输入区、运行拓扑和执行轨迹可用，并用真实状态显示 `DEGRADED / LOCAL`，不伪装成已经完全生产化。
