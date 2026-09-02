# ✦ Axiom Agent Control Room

> 把一句话交给一组真正会分工的 Agent。Axiom 会判断任务难度、安排合适的 Agent、展示实时进度，并在交付前帮你检查结果。

当前发布版本：**v1.1.0**（`v1.0.0` 为可回退的基线版本）

![Axiom 任务台](docs/images/overview.png)

## 🌌 先用一句话认识 Axiom

Axiom 是一个可以自己安排工作的 AI 控制台。

你不需要先学习工作流、节点或调度规则，只要告诉它想完成什么：

```text
“帮我调研几个开源项目，比较优缺点，最后整理成一份可以分享的报告。”
```

系统会自动完成：

```text
理解任务 → 判断难度 → 选择 Agent → 并行协作 → 检查结果 → 交付
```

简单问题不会被强行拆成复杂流程；需要搜索、分析、绘图或复核时，才会增加对应的 Agent。

## 🧭 前后端结构介绍

- 🎨 **前端**：`src/`，使用 React + Vite + TypeScript（`.tsx`）。
- ⚙️ **后端**：`server/`，使用 Node.js + Hono + TypeScript（`.ts`），负责 API、Agent 调度、模型调用、任务和数据库。

开发时执行 `npm run dev`，前后端会一起启动：前端 `4300`，后端 `8787`。

## 🏆 这个平台的优势

TypeScript 全栈只是开发方式，真正的优势来自平台如何完成任务：

- 🚦 **按需分配 Agent**：简单问题快速回答，复杂任务才启用多个 Agent，减少等待和模型费用。
- ⚡ **能并行就并行**：互不依赖的研究、分析或构建步骤可以同时进行，不必排队一个个完成。
- 🧭 **每轮都会重新判断**：你临时改变想法时，系统只让相关 Agent 参与，不会把整条 Graph 从头跑一遍。
- ✍️ **执行中也能补充要求**：复杂任务还在运行时可以继续输入修改意见，系统会在安全步骤接收并显示“已接收 / 已应用”，不会另建一条重复任务。
- ✅ **交付前会检查**：Reviewer 可以要求修正，结果不是“模型说完成了”就直接交给你。
- 🔄 **中断也能继续**：任务、事件和检查点会保存，刷新页面、网络短暂断开或 Worker 重启后仍可恢复。
- 👀 **过程看得见**：Agent Graph、实时事件和任务阶段来自真实执行状态，不是播放一段固定动画。
- 🔌 **模型可以替换**：默认 DeepSeek，也支持自己的兼容接口；视觉、绘图和视频服务可以单独配置。
- 🛡️ **高风险操作先确认**：写文件、发布等动作可以停下来等人工批准，避免 Agent 擅自完成危险操作。

## 🆕 v1.1.0 运行时升级

这一版参考 DeepSeek Reasonix、DeepSeek Harness、Codex app-server 和 Agent Nexus 的运行时设计，把“多个 Agent 一起回答”升级为可以恢复、可以验证、可以解释的执行系统。

- 🧭 **稳定的任务计划**：Planner 生成的步骤会先检查依赖关系，拒绝重复步骤、悬空依赖、自我依赖和循环；互不依赖的步骤会被安排到同一执行波次并行运行。
- 🧩 **统一运行上下文**：每条任务事件都会记录租户、用户、会话、工作流、对话轮次、重试次数、运行代次和入口来源。普通对话、任务、插件、Agent Nexus、Harness 和 API 使用同一套上下文标识。
- 🕸️ **Graph 与真实执行一致**：Graph 节点带有父子关系、执行波次和单调递增的版本号。页面展示的节点状态来自持久化事件，不是预设动画。
- 🔒 **写入冲突自动排队**：Agent 声明需要修改的目录或资源范围后，互不冲突的写入可以并行，重叠写入会自动拆分波次并留下调度记录，减少相互覆盖。
- 🧾 **交付证据摘要**：任务完成时会汇总已完成步骤、失败或跳过步骤、验收条件、来源证据、Artifact、工具回执、审核结果和未解决缺口，模型说“完成”不再等于系统已验证完成。
- 🔎 **Agent 目录实时回答**：询问“有哪些子智能体”或“支持哪些能力”时，系统读取当前运行目录和已发布自定义 Agent，不使用固定列表，也不会误触发联网搜索。
- ♻️ **失败可继续**：任务、检查点、事件和交付证据会持久化；网络断开、Worker 重启或单个 Agent 失败后，可以从可用检查点继续，已有结果会保留为部分交付。
- 🧭 **路由理由可见**：对话顶部会显示本轮是直接回答、单 Agent 还是 Agent 小组，以及实际参与的 Agent、能力和 Router 置信度；历史会话也能从持久计划恢复。
- ✍️ **任务执行中可引导**：补充要求进入同一任务的下一安全执行点并只应用一次。接入外部 Harness 时，只有 Codex/DeepSeek transport 真正接受 steer 才会显示成功。

### 🔁 一次任务的真实执行链路

```text
用户输入
  ↓
Router Agent：理解意图、难度和所需能力
  ↓
Scheduler Agent：选择本轮真正需要的 Agent 和 Skill
  ↓
DAG 计划：校验依赖并计算并行执行波次
  ↓
Researcher / Analyst / Builder / 工具调用
  ↓
Reviewer：检查证据、风险和验收条件
  ↓
Synthesizer：只汇总已验证的结果
  ↓
带证据的最终交付
```

每轮对话都会重新判断是否需要继续使用旧 Agent、跳过旧 Agent 或加入新 Agent；简单聊天不会被强行升级成完整工作流。

### ✅ v1.1.0 验收结果

当前源码版本已经通过：

```text
npm run check       通过
npm test            308 passed / 0 failed
npm run build       通过
npm run qa:search-agent
                    通过
npm run qa:all      22 passed / 0 failed / 3 skipped
```

跳过的 3 项只涉及尚未配置的外部服务：TencentDB MemoryCore、MinIO/S3/COS 对象存储。配置对应 endpoint 后，可以继续进行真实多 Worker 验收；这不影响 SQLite、本地文件目录和协议级 Harness/Codex 回归。

### 📈 本机性能基线

下面是 2026-08-29 在 Windows 单节点、10 并发、每项 50 次请求下测得的 API 基线：

| 接口 | 吞吐 | P95 延迟 |
| --- | ---: | ---: |
| 健康检查 | 1,472.58 请求/秒 | 11.01 ms |
| 就绪检查 | 2,031.08 请求/秒 | 5.69 ms |
| 任务列表 | 1,699.79 请求/秒 | 7.31 ms |
| 运行观测 | 682.26 请求/秒 | 31.67 ms |

这组数据衡量的是 Axiom 自己的 API、调度和数据库访问，不包含 DeepSeek 的网络延迟、排队时间或模型生成速度。可以用下面的命令在自己的机器上重新测试：

```bash
npm run perf:smoke
```

### ⚡ 为什么使用起来更快？

- 简单问题直接回答，跳过不必要的规划和多 Agent 往返。
- 互不依赖的步骤同时运行，复杂任务的总等待时间更短。
- SSE 会先把“正在分析、正在搜索、正在复核”等真实状态推到页面，不必等整段答案生成完才看到反应。
- 较长的对话会自动整理旧内容，只把当前任务真正需要的上下文交给模型。

所以，平台 API 可以很快响应，但最终答案的生成速度仍会受到模型服务、网络和任务复杂度影响；README 中的基线不会把第三方模型速度算成 Axiom 自己的性能。

## ✨ 你可以用它做什么

- 💬 **自然对话**：问问题、写方案、整理内容，支持流式回复。
- 🔎 **联网查资料**：搜索新闻、论文、GitHub 项目和最新信息，并保留来源。
- 🖼️ **看图和读文件**：识别图片，分析 Markdown、TXT、Word、PDF、SVG、HTML 等文件。
- 🎨 **直接绘图**：在对话里描述想法，由绘图 Agent 生成或编辑图片。
- 🧩 **多 Agent 协作**：研究、分析、构建、复核等角色按需加入，不会每次都全部运行。
- 🔁 **Agent Nexus**：搭建带条件分支、Loop 和并行路径的专属 Agent 流程。
- 🧱 **插件小程序**：创建天气、咨询、小游戏等独立插件，在平台内打开使用。
- 🧑‍💻 **人工接管**：高风险或需要确认的步骤会停下来，等你批准后继续。
- 📡 **实时可见**：任务进度、Agent Graph、事件流和最终交付状态都会实时更新。
- ✍️ **边做边改**：复杂任务执行中可以继续补充要求，页面会告诉你 Agent 已接收还是已经应用。

## 🗓️ Agent 日程

日程不再只是“每隔多少分钟重复同一句话”。你可以直接告诉日程 Agent：

```text
“每天早上 9 点搜索 Agent 行业动态，整理成 5 条摘要并保留来源。”
```

平台会先生成一份草案，显示任务目标、执行时间和安排理由；只有你点击确认后才会启用。当前支持单次执行、固定间隔、每天固定时间和每周指定日期，并按用户时区计算下一次执行，固定时间不会因上一次任务晚结束而逐渐漂移。

每次真正到点时，平台会重新让 Router Agent 理解本次目标，再由调度 Agent 选择当轮需要的搜索、分析、构建、审核或其他 Agent 和 Skill。日程不会永久绑死某个 Agent，也不会把简单任务强行拆成复杂流程。

如果你在设置中启用了已保存的自定义文本模型，日程草案、到点路由和实际执行会使用同一份加密凭据引用；日程记录只保存凭据 ID，不保存或返回 API Key。

日程页还可以：

- ▶️ 立即运行一次，不改变原来的自动执行时间。
- 🧭 查看本次实际使用的 Agent、执行状态、步骤、Token 和交付验证结果。
- 🔁 在短暂故障后自动退避重试，连续失败 5 次后暂停并等待人工恢复。
- 🧱 在 PostgreSQL 多 Worker 部署中安全认领到期日程，并用幂等键避免重复任务。
- 🕰️ 继续读取旧版本创建的固定间隔日程，无需手动迁移。

## 🪟 界面一览

这些截图来自当前版本的本地验收流程，展示的是实际控制台，不是宣传样机。截图中的任务和对话是测试数据，不包含真实用户信息。

### 🛰️ 任务台：知道现在进行到哪一步

![任务总览](docs/images/overview.png)

左侧进入任务、对话、插件或 Agent Nexus；中间区域显示当前任务和实时 3D 场景；右侧可以看到负责人、阶段、审核状态和交付结果。

### 💬 对话：像聊天一样使用 Agent 团队

![对话与 Agent Graph](docs/images/conversation.png)

你只需要继续说下一句话。系统会根据新的内容重新判断本轮需要哪些 Agent，旧 Agent 可以被跳过，新 Agent 也可以临时加入。任务执行中还可以直接补充要求；对话顶部会显示本轮真实路径，右下角的 Agent Graph 会跟着执行状态变化。

### 🔗 Agent Nexus：把一组 Agent 组成自己的工作流

![Agent Nexus](docs/images/agent-nexus.png)

可以把“资料搜集 → 分析 → 复核 → 输出”连成一条流程，也可以加入条件分支和 Loop。每个 Agent 都有清晰的职责和输入输出，运行时可以查看每一步发生了什么。

### 🧩 插件：像打开一个小程序

![插件中心](docs/images/plugins.png)

插件可以由 Agent 协助创建，也可以自己配置。发布后从插件中心打开，插件运行期间会使用平台配置的模型和工具。

### ⚙️ 设置：换成你自己的模型

![模型设置](docs/images/settings.png)

默认使用 DeepSeek，也可以填写自己的 OpenAI-compatible 服务地址、模型名和 Key。文本模型、视觉模型、绘图服务和视频服务可以分开配置。

## 🚀 三步启动

### 1. 安装依赖

要求 **Node.js 22 或更高版本**。

```bash
git clone https://gitee.com/water-sim/axiom-agent-control-room.git
cd axiom-agent-control-room
npm install
```

### 2. 填写自己的模型配置

复制配置模板：

```bash
cp .env.example .env.local
```

Windows PowerShell：

```powershell
Copy-Item .env.example .env.local
```

打开 `.env.local`，至少填写：

```dotenv
DEEPSEEK_API_KEY=填写你自己的Key
```

项目不会附带可用 Key。`.env.local` 已被忽略，不会被 Git 提交。

### 3. 启动

```bash
npm run dev
```

打开：

- 前端：<http://127.0.0.1:4300>
- API：<http://127.0.0.1:8787>

默认使用 SQLite，第一次启动会自动在 `.data/` 创建本地数据库，适合个人试用。

## 🐘 想用 PostgreSQL？

项目附带了一个可以直接使用的本地 Docker 配置：

```bash
docker compose -f docker-compose.local.yml up -d postgres
```

然后在 `.env.local` 设置自己的连接地址：

```dotenv
DATABASE_URL=postgresql://postgres:change-me@127.0.0.1:5432/axiom
```

执行迁移并启动：

```bash
npm run db:migrate
npm run dev
```

SQLite 适合单人本地使用；PostgreSQL 用于多 Worker、任务恢复和受控生产环境。

## 🧠 它是怎样工作的

### 普通问题

问候、简单解释和短事实问题会走轻量路径，快速返回，不浪费多 Agent 调用。

### 需要完成的任务

系统会根据你的目标自动安排角色，例如：

```text
研究 Agent ─┐
分析 Agent ─┼→ 复核 Agent → 汇总 Agent → 交付
构建 Agent ─┘
```

每一轮新消息都会重新评估。并不是 Graph 里出现过的 Agent 都要再次执行，真正相关的才会参与。

### 需要确认的操作

涉及写文件、发布或其他高风险动作时，系统会暂停并等待人工批准；取消、暂停、恢复、重试和断线重连都会留下可追踪记录。

## 🧰 常用命令

```bash
npm run check       # TypeScript 检查
npm test            # 单元和运行时测试
npm run build       # 构建前端和服务端
npm start           # 运行构建后的单体服务
npm run qa:visual   # 浏览器界面验收
npm run qa:all      # 生产门禁回归
```

生产构建完成后访问 <http://127.0.0.1:8787>，Hono 会同时提供 API 和 `dist/` 中的前端。

## 🔌 可选能力配置

不配置这些服务时，基础对话和本地任务仍然可以使用；对应模块会显示“未配置”或“降级”。

| 能力 | 配置项 | 用途 |
| --- | --- | --- |
| 文本模型 | `DEEPSEEK_API_KEY`、`DEEPSEEK_API_BASE`、`DEEPSEEK_MODEL` | 对话、分析和 Agent 执行 |
| 视觉模型 | `DEEPSEEK_VISION_*` | 图片识别和文件视觉分析 |
| 原生搜索 | `DEEPSEEK_NATIVE_SEARCH=true`、`DEEPSEEK_NATIVE_SEARCH_MODEL` | 联网搜索与来源整理 |
| 绘图 | `DMX_API_KEY`、`DMX_BASE_URL`、`DMX_MODEL` | 生成和编辑图片 |
| 视频 | `VIDEO_API_BASE`、`VIDEO_API_KEY`、`VIDEO_MODEL` | 连接本地视频生成服务 |
| 长期记忆 | `TDAI_MEMORY_ENDPOINT`、`TDAI_MEMORY_API_KEY` | 可选的 MemoryCore L0-L3 记忆 |
| 外部 Agent | `DEEPSEEK_HARNESS_*`、`CODEX_APP_SERVER_*` | 接入 Harness 或 Codex sidecar |

更完整的变量说明见 [`.env.example`](.env.example)。

## 🛡️ 安全和生产提示

这个开源仓库提供的是“本地或受控单节点生产候选”，不是打开端口就可以直接面对公网的多租户 SaaS。

正式部署前至少需要：

- 使用 PostgreSQL，不要在公网生产环境使用 SQLite。
- 通过 OIDC 或可信反向代理注入用户和租户身份。
- 把模型 Key 放到 Secret Manager，不要写进前端或任务内容。
- 启用 HTTPS、限流、日志采集、备份和对象存储。
- 根据实际环境验收 Docker 沙箱、MemoryCore、Harness/Codex sidecar 和多 Worker 恢复。

具体上线门禁见 [`docs/launch-readiness.md`](docs/launch-readiness.md)。

## 📚 想继续了解

- [升级路线图](docs/upgrade-roadmap.md)：为什么这样设计前后端。
- [Agent Nexus 控制流](docs/agent-nexus-control-flow.md)：分支、Loop、DAG 和局部重跑。
- [执行闭环](docs/execution-loop.md)：任务如何从输入走到交付。
- [工具目录](docs/tool-registry.md)：工具权限、审批和执行边界。
- [MemoryCore 接入](docs/memorycore-integration.md)：长期记忆配置与验收。
- [Harness 适配器](docs/harness-adapters.md)：DeepSeek Harness/Codex 的可选接入方式。
- [Reasonix 运行时采纳说明](docs/reasonix-runtime-adoption.md)：DAG、统一运行上下文、写入冲突调度和交付证据的设计边界。
- [上线就绪度](docs/launch-readiness.md)：当前能力、风险和生产前置条件。

## 📄 开源许可

本项目使用 [MIT License](LICENSE)。你可以自由学习、修改和部署，但请自行配置模型服务并对生产环境负责。

## 🙌 贡献

欢迎提交 Issue、改进文档或发起 Pull Request。涉及 Agent 执行、安全边界、任务恢复和数据隔离的改动，请同时补充测试或回归脚本。
