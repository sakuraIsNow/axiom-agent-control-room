# ✦ Axiom Agent Control Room

> 把一句话交给一组真正会分工的 Agent。Axiom 会判断任务难度、安排合适的 Agent、展示实时进度，并在交付前帮你检查结果。

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

## 🧭 后端在哪里？

有，后端就在仓库的 `server/` 目录。

- 🎨 **前端**：`src/`，使用 React + Vite + TypeScript（`.tsx`）。
- ⚙️ **后端**：`server/`，使用 Node.js + Hono + TypeScript（`.ts`），负责 API、Agent 调度、模型调用、任务和数据库。

开发时执行 `npm run dev`，前后端会一起启动：前端 `5173`，后端 `8787`。

### 🌱 TypeScript 全栈有什么好处？

前后端使用同一种语言，接口数据和类型可以保持一致，少一些“前端以为是这样、后端实际是那样”的问题；代码更容易复用、重构和测试，新成员也只需要学习一套主要语言。TypeScript 还会在运行前提示很多拼写和数据错误，让项目更容易长期维护。

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

## 🪟 界面一览

这些截图来自当前版本的本地验收流程，展示的是实际控制台，不是宣传样机。截图中的任务和对话是测试数据，不包含真实用户信息。

### 🛰️ 任务台：知道现在进行到哪一步

![任务总览](docs/images/overview.png)

左侧进入任务、对话、插件或 Agent Nexus；中间区域显示当前任务和实时 3D 场景；右侧可以看到负责人、阶段、审核状态和交付结果。

### 💬 对话：像聊天一样使用 Agent 团队

![对话与 Agent Graph](docs/images/conversation.png)

你只需要继续说下一句话。系统会根据新的内容重新判断本轮需要哪些 Agent，旧 Agent 可以被跳过，新 Agent 也可以临时加入。右下角的 Agent Graph 会跟着真实执行状态变化。

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

- 前端：<http://127.0.0.1:5173>
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
- [上线就绪度](docs/launch-readiness.md)：当前能力、风险和生产前置条件。

## 📄 开源许可

本项目使用 [MIT License](LICENSE)。你可以自由学习、修改和部署，但请自行配置模型服务并对生产环境负责。

## 🙌 贡献

欢迎提交 Issue、改进文档或发起 Pull Request。涉及 Agent 执行、安全边界、任务恢复和数据隔离的改动，请同时补充测试或回归脚本。
