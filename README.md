# Axiom Agent Control Room

Axiom 是一个带实时 3D 拓扑的生产化 Agent 控制台。默认执行路径不是单轮聊天，而是可持久化、可恢复、可审计的多 Agent 工作流：

`Axiom` 取“公理、基础原则”之意。平台把可验证状态、事件回放、证据链、工具审批、可恢复执行和人工接管当作任务运行的基础原则，而不是把所有问题都强行包装成复杂 Agent 流程。

```text
Task -> Planner -> parallel specialists -> checkpoint -> Reviewer
     -> correction loop -> Reviewer -> Synthesizer -> Artifact
```

运行时通过 SSE 把持久化事件推送到前端，Planner、Researcher、Analyst、Builder、Reviewer 和 Synthesizer 的真实状态会驱动 3D 场景及执行轨迹。

## 能力边界

- 默认 DeepSeek：使用服务端凭证和持久化工作流，支持并行子 Agent、重试、检查点、租约恢复、质量门禁和事件回放。
- 自定义文本模型：支持 OpenAI-compatible API URL、Key 和模型名，采用当前浏览器会话内的直连流式模式；Key 不写入 localStorage 或任务数据库。
- 绘图：独立于文本模型，任何会话均可文生图或图片编辑，支持服务端 DMX 配置和页面内临时自定义 Provider。
- MemoryCore：可选的 L0-L3 长期记忆 Adapter，具备多 Worker 幂等捕获、失败恢复、来源/置信度/过期过滤和受控维护 API；未配置时工作流可正常运行。接入与验收见 [`docs/memorycore-integration.md`](docs/memorycore-integration.md)。
- PostgreSQL：生产环境的持久化和多 Worker 协调层；SQLite 仅作为本地开发默认值。
- 会话型输入：问候、感谢和告别会进入轻量 Direct Response 路径，不会被错误地送入证据质量门禁；真正的分析、构建和决策任务仍走完整多 Agent 工作流。
- 用户插件：首版提供声明式 Prompt Plugin。用户可以配置模式、模型、固定提示和运行时输入字段，发布后从插件抽屉快速运行；插件只引用 Tool Registry，不执行任意上传脚本，运行结果仍进入 Task、Event、SSE、审批和 Artifact lineage。
- Axiom Studio：首次进入默认打开全新的空间工作台。它复用真实 Task/Event/Graph/SSE 状态，以 Command Bar、轨道/网络/事件三视图、节点聚焦检查器和实时数据条组织任务；提供动态自主智能体球、3D 粒子核心、Agent 网络、推理图、事件流和低噪声的电影级动效。旧 Mission Deck、Immersive Control Room 与经典工作台均保留为备用界面，并通过视图偏好和返回入口切换。
- 视觉实现参考 MIT 开源 ApexUI 的粒子海、Parallax 和 Glare 交互模式，全部在本地以 React/Three.js 实现，不加载外部运行时代码。

## 本地运行

要求 Node.js 22+。

```bash
npm install
npm run dev
```

- Web：`http://127.0.0.1:5173`
- API：`http://127.0.0.1:8787`

PowerShell 用户先执行：

```powershell
Copy-Item .env.example .env.local
```

然后编辑 `.env.local`，至少填写 `DEEPSEEK_API_KEY`。

PowerShell 用户可以使用上面的 `Copy-Item`；macOS/Linux 用户使用：

```bash
cp .env.example .env.local
```

至少配置 `DEEPSEEK_API_KEY` 才能调用默认文本模型。视觉模型可用独立的 `DEEPSEEK_VISION_API_KEY`、`DEEPSEEK_VISION_API_BASE` 和 `DEEPSEEK_VISION_MODEL` 覆盖；未设置时沿用 DeepSeek 文本服务。绘图还需要 `DMX_API_KEY`，或通过 `DMX_CONFIG_PATH` 读取本机 `ai-image-gen` Skill 的 DMX 配置。视频制作 Agent 使用 `VIDEO_API_BASE`、可选的 `VIDEO_API_KEY` 和 `VIDEO_MODEL` 连接本地视频服务，未配置时会明确显示不可用。

### 从全新环境复现

仓库不依赖本机的数据库、日志、构建产物或前端备份。全新机器可以按下面的流程启动：

```bash
git clone https://gitee.com/water-sim/axiom-agent-control-room.git
cd axiom-agent-control-room
npm install
cp .env.example .env.local
# 在 .env.local 中填写你自己的 DEEPSEEK_API_KEY
npm run dev
```

默认开发模式使用 SQLite，首次启动会在 `.data/` 自动创建数据库，适合个人试用。要使用 PostgreSQL 多 Worker 模式，可以启动仓库附带的本地 Docker 配置：

```bash
docker compose -f docker-compose.local.yml up -d postgres
```

然后在 `.env.local` 设置 `DATABASE_URL`，并执行迁移：

```bash
npm run db:migrate
npm run dev
```

需要构建单体生产候选包时：

```bash
npm run check
npm test
npm run build
npm start
```

构建后访问 `http://127.0.0.1:8787`。`npm start` 会由 Hono 同时提供 API 和 `dist/` 中的前端；开发阶段的 `npm run dev` 则分别使用 Vite（5173）和 API（8787）。

### 配置原则

- `.env.local` 只存在于本机，不要提交到仓库；`.env.example` 是可公开的配置模板。
- 任何模型、绘图、视频、MemoryCore 或 Harness 凭据都必须使用你自己的 Key，项目不会内置可用凭据。
- 不配置可选服务时，基础文本对话和 SQLite 任务流程仍可以运行；对应功能会在 Readiness 中显示为未配置或降级。
- 生产环境请使用 PostgreSQL、HTTPS、可信身份代理、Secret Manager 和对象存储，具体门禁见 [`docs/launch-readiness.md`](docs/launch-readiness.md)。

## 运行时 API

```text
GET  /api/health
GET  /api/runtime/health
GET  /api/runtime/readiness
GET  /api/runtime/capabilities
GET  /api/runtime/metrics
GET  /api/runtime/stats
POST /api/runtime/triage
GET  /api/agents
GET  /api/plugins
POST /api/plugins
PATCH /api/plugins/:pluginId
POST /api/plugins/:pluginId/run
POST /api/tasks
POST /api/webhooks/tasks
GET  /api/schedules
POST /api/schedules
DELETE /api/schedules/:scheduleId
GET  /api/tasks
GET  /api/tasks/:taskId
POST /api/tasks/:taskId/cancel
POST /api/tasks/:taskId/pause
POST /api/tasks/:taskId/resume
POST /api/tasks/:taskId/notes
POST /api/tasks/:taskId/retry
GET  /api/tasks/:taskId/events?after=<sequence>
GET  /api/tasks/:taskId/artifacts/result
POST /api/chat
POST /api/images
```

事件流支持 `Last-Event-ID` 与 `after` 回放。服务端会先订阅实时事件、再读取历史事件，消除了回放与订阅之间的丢事件窗口。任务状态和事件先持久化再广播。

## 可靠性模型

- PostgreSQL 使用 `FOR UPDATE SKIP LOCKED` 和任务租约支持多 Worker 抢占。
- Worker 定期续租；进程退出或租约丢失不会被误判为用户取消，任务可由其他 Worker 恢复。
- 每批依赖就绪的步骤并行执行，批次结束保存 `stepResults` 检查点。
- 依赖步骤会生成结构化 `agent.message`，把上游输出、交接说明和 Artifact 引用传给下游 Agent；消息同时写入事件流，支持回放与审计。
- Planner 为每个步骤生成模型、工具白名单、Token 预算、超时和失败策略；Builder 工具请求受步骤白名单约束，步骤失败可按 `retry`、`skip` 或 `pause` 恢复。
- 并行 Agent 的明确相反结论会生成 `agent.conflict` 事件并交给 Reviewer 验证；当任务 Token 上限逼近时，运行时会保留质量门禁预算并压缩并行步骤的 `maxTokens`，通过 `budget.constrained` 记录调度依据。
- 模型请求对超时、HTTP 408/409/429 和 5xx 做指数退避重试。
- 任务有总执行超时，避免永久占用 Worker。
- Reviewer 可要求修正并再次审核；默认质量门禁未通过时任务失败，不会伪装成成功。
- 排队任务取消会立即进入 `cancelled` 终态；执行中任务通过持久化取消标记协作中止。

关键参数：

```dotenv
AGENT_TASK_CONCURRENCY=2
AGENT_STEP_CONCURRENCY=6
AGENT_STEP_MAX_ATTEMPTS=2
AGENT_TASK_LEASE_MS=90000
AGENT_TASK_TIMEOUT_MS=900000
AGENT_MODEL_TIMEOUT_MS=120000
AGENT_MODEL_MAX_ATTEMPTS=3
AGENT_REVIEW_CORRECTION_ROUNDS=1
AGENT_REQUIRE_REVIEW_APPROVAL=true
AGENT_REVIEW_MIN_SCORE=80
```

## 生产部署

### 本地 PostgreSQL 与沙箱

本项目可以复用本机已有的 PostgreSQL Docker 镜像：

```bash
docker start pgsql
npm run db:migrate
```

生产候选配置至少需要：

```dotenv
DATABASE_URL=postgresql://postgres:password@127.0.0.1:5432/axiom
AXIOM_API_KEY=long-random-service-key
AXIOM_PRINCIPAL_SECRET=long-random-signing-secret
AXIOM_PROVIDER_SECRET=long-random-provider-encryption-secret
AXIOM_TOOL_EXECUTOR=docker
AXIOM_TOOL_SANDBOX_IMAGE=ubuntu:24.04
PROMETHEUS_ENABLED=true
```

当前 Docker 工具执行器默认关闭网络、根文件系统只读、只挂载任务工作区、限制 CPU/内存/PID，并只允许白名单命令。所有 Tool Registry 调用都必须先通过 `AXIOM_TOOL_EXECUTOR=docker` 执行门禁；命令型工具实际运行在 Docker 沙箱内。`document.read`、`table.read`、`database.query`、`http.fetch`、`browser.open`、`workspace.write` 和 `workspace.patch` 在目录中明确标为 `host-bounded`：它们依赖应用层路径/只读事务/allowlist/原子写校验，但不虚称为容器内执行。工具目录会返回 `executionBoundary`，Readiness 也会探测 Docker 镜像是否真实可用。

`AXIOM_PRINCIPAL_SECRET` 启用后，网关要求 HMAC 签名的 `x-axiom-principal` 和 `x-axiom-principal-signature`。本地调试可以用：

```bash
AXIOM_PRINCIPAL_SECRET=... AXIOM_TENANT_ID=local AXIOM_USER_ID=local-user npm run principal:sign
```

自定义文本、视觉、绘图和视频服务可以在设置页保存为服务端凭据。配置 `AXIOM_PROVIDER_SECRET` 后，API Key 会使用 AES-256-GCM 加密写入 `provider_credentials` 表，浏览器只保留随机 `credentialId`；该密钥必须在所有 Worker 上保持一致，且不会通过 API 返回。未配置时仍可使用一次性直连，但不会被标记为已安全托管。

复杂任务路由回归测试：

```bash
npm run qa:routing
```

该测试会覆盖 direct、single-agent、team、full-workflow 四种路由，并输出准确率。

生产模式默认拒绝 SQLite，必须配置 PostgreSQL：

```dotenv
NODE_ENV=production
DATABASE_URL=postgresql://user:password@host:5432/axiom
AXIOM_ALLOWED_ORIGINS=https://control.example.com
```

认证二选一：

```dotenv
AXIOM_API_KEY=long-random-service-key
# 或由可信反向代理完成用户认证并注入租户身份
AXIOM_TRUST_PROXY_AUTH=true
```

当前 `x-axiom-tenant-id` 和 `x-axiom-user-id` 只应由可信认证代理注入，不能直接信任公网客户端。生产还需要 HTTPS、反向代理限流、Secret Manager、PostgreSQL 备份、日志采集和结果对象存储。`AXIOM_API_KEY` 更适合服务间调用；同源浏览器部署推荐可信认证代理。

构建和启动：

```bash
npm run build
npm start
```

## 外部框架取舍

- DeepSeek Harness：参考其 session、checkpoint、subagent、MCP、sandbox、telemetry 和 ACP 设计。当前版本使用自己的稳定 Task/Event Contract 和内建 Harness contract：durable loop、checkpoint resume、dependency graph、subagent delegation、human steering、review gate 已在内置 Orchestrator 中生效；`DEEPSEEK_HARNESS_URL` 仍是可选 sidecar 边界。
- TencentDB Agent Memory：通过独立 HTTP Adapter 接入 L0-L3 记忆，不承担调度职责。
- HarnessEval-W：需要参考，但不应成为运行时依赖。项目吸收了它的 case-specific routing、sub-question decomposition、specialist evidence、parent validation 和 evidence tree/trace 思路；视觉世界评测代码不属于本产品运行路径。
- uiverse-galaxy、aceternity-saasternity、React Bits、GSAP/Anime：只吸收适合控制台的动效与交互模式。Three.js/R3F 保持为事件驱动的 3D Runtime 拓扑，不合并整套展示站点。
- LobeHub/Open WebUI：参考 Provider 与会话产品设计，不复制其整套应用。
- Cesium/MapLibre/MapStore2：只有在任务需要地理空间工具时才通过 Tool Adapter 接入，不进入核心 Bundle。

## 验证

```bash
npm run check
npm test
npm run build
npm run qa:visual
```

`npm test` 覆盖 SQLite 事件序列、租约、取消、基础设施中断恢复，以及完整的并行子 Agent、Reviewer 纠正和合成流程。视觉 QA 会检查桌面/移动布局、横向溢出、浏览器错误、3D Canvas 非空像素与连续帧变化。

上线门禁、当前能力边界、竞品差异和生产前置条件见 [`docs/launch-readiness.md`](docs/launch-readiness.md)。

## 密钥安全

`.env.local` 已被 Git 忽略。健康接口不会返回 Key，日志对常见 Key 格式做脱敏。不要把用户自定义 Provider Key 放入异步 Task；如果以后要让自定义 Provider 也支持恢复执行，必须先实现租户隔离的加密凭证库、AES-GCM、密钥版本和轮换机制。
