# ✦ Axiom Agent Control Room

> 把一句话交给一组真正会分工的 Agent。Axiom 会判断任务难度、安排合适的 Agent、展示实时进度，并在交付前帮你检查结果。

当前发布版本：**v2.1.0**（受控环境生产候选；`v2.0.0` 为本次升级前稳定基线）

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

## 🆕 最新运行时与交付升级

这一版参考 DeepSeek Reasonix、DeepSeek Harness、Codex app-server 和 Agent Nexus 的运行时设计，把“多个 Agent 一起回答”升级为可以恢复、可以验证、可以解释的执行系统。

- 🧭 **稳定的任务计划**：Planner 生成的步骤会先检查依赖关系，拒绝重复步骤、悬空依赖、自我依赖和循环；互不依赖的步骤会被安排到同一执行波次并行运行。
- 🧩 **统一运行上下文**：每条任务事件都会记录租户、用户、会话、工作流、对话轮次、重试次数、运行代次和入口来源。普通对话、任务、插件、Agent Nexus、Harness 和 API 使用同一套上下文标识。
- 🕸️ **Graph 与真实执行一致**：Graph 节点带有父子关系、执行波次和单调递增的版本号。页面展示的节点状态来自持久化事件，不是预设动画。
- 🧵 **外部 Thread 也能追踪**：Harness/Codex 的父子 Thread、打开/关闭状态和后代关系由持久事件重建；服务重启后仍可查询，不依赖进程内临时状态。
- 🔒 **写入冲突自动排队**：Agent 声明需要修改的目录或资源范围后，互不冲突的写入可以并行，重叠写入会自动拆分波次并留下调度记录，减少相互覆盖。
- 🧾 **交付证据摘要**：任务完成时会汇总已完成步骤、失败或跳过步骤、验收条件、来源证据、Artifact、工具回执、审核结果和未解决缺口，模型说“完成”不再等于系统已验证完成。
- 🔎 **Agent 目录实时回答**：询问“有哪些子智能体”或“支持哪些能力”时，系统读取当前运行目录和已发布自定义 Agent，不使用固定列表，也不会误触发联网搜索。
- ♻️ **失败可继续**：任务、检查点、事件和交付证据会持久化；网络断开、Worker 重启或单个 Agent 失败后，可以从可用检查点继续，已有结果会保留为部分交付。
- 🧭 **路由理由可见**：对话顶部会显示本轮是直接回答、单 Agent 还是 Agent 小组，以及实际参与的 Agent、能力和 Router 置信度；历史会话也能从持久计划恢复。
- ✍️ **任务执行中可引导**：补充要求进入同一任务的下一安全执行点并只应用一次。接入外部 Harness 时，只有 Codex/DeepSeek transport 真正接受 steer 才会显示成功。
- 🌿 **从检查点试另一种方案**：可以比较当前任务与历史检查点，从任一检查点派生分支；多人同时操作时用 revision 拒绝静默覆盖，合并冲突必须由用户明确选择。
- 📦 **大结果不再挤满上下文**：长文档、搜索结果和 Agent 中间结果保存为 Artifact，普通下游只接收摘要和 `result_ref`，需要复核或汇总时才在预算内读取全文。
- 🧠 **长对话可以可靠恢复**：摘要版本、覆盖消息、Artifact、审批和未完成事项写入数据库；历史消息变化会使旧摘要失效并自动重建，原始对话始终完整保留。
- 📈 **摘要效果看得见**：运行观测会显示上下文压缩、直接复用、消息覆盖和重建次数，并明确区分“保守估算”与 Provider 精确 Token 计数。
- 🚪 **第一次打开就能开始工作**：确认没有历史数据后，任务台会直接提供对话、插件和 Agent Nexus 三个入口；不是展示型登录页，点击后进入真实功能。
- 📣 **任务结果可靠外发**：任务完成、失败、等待确认或日程异常时，可以通过签名 Webhook 推送到自己的系统；投递具有持久队列、幂等、超时重试、死信恢复和脱敏审计，服务重启不会丢失待发送记录。
- 🧪 **按业务过程评测**：生产门禁不只看最终答案，还验证跨轮路由是否漂移、执行中改需求是否只应用一次、长结果引用边界、恢复一致性与版本冲突。
- 📎 **Nexus 文件真正进入流程**：图片、PDF、Word 和文本附件按原始二进制保存；测试和发布会固定同一组文件，文件变化后必须重新测试，避免正式运行偷偷读到另一版资料。
- 👁️ **视觉与文档 Agent 使用真实内容**：视觉 Agent 读取图片，文档 Agent 读取解析后的文件正文；其他 Agent 不会收到大段 Base64，附件被替换或跨用户引用时会直接拒绝。
- 🧰 **外部工具按需加入**：MCP/OpenAPI 工具按办公、研究、开发、业务、内容、运维和数据分类。系统结合任务、Agent 权限、健康状态和历史成功率，每一步默认只选择最相关的 6 个，而不是把全部工具塞给模型。
- 🩺 **工具状态可见**：能力目录会显示健康、待授权、异常、成功率、延迟和使用次数；异常或未授权工具不会进入 Agent 的可用目录。

### 🧭 从任务到业务交付

最新的业务能力 V2 把复杂任务的前后步骤连成了一个可执行闭环：失败或需求变化时只重排受影响部分；Agent 之间用结构化摘要、证据和 Artifact 交接；Reviewer 会阻止证据缺失或互相矛盾的结论进入已验证交付。

项目空间可以集中管理任务、会话、Agent Nexus、日程、决策、成员和审核。任务结束后可以继续分析、局部重跑、换模型复核、导出报告，或保存为 Nexus、插件和日程。平台还提供十种常用业务方案、可控长期记忆、按需选择的 MCP/OpenAPI 能力目录、真实反馈聚合，以及随运行事件更新的成本和时间预估。

平台可以接入很多种 MCP，但不会让每个 Agent 同时看到所有工具。大量工具会增加 Token、延迟和误选概率，也会扩大第三方服务故障与权限风险。更合适的方式是按用户需要组合“办公、研究、开发、业务、内容、运维、数据”等能力包，再由路由每轮挑选少量相关工具。需要 API Key、OAuth 或服务账号的 MCP 当前可以先登记，但会保持“待授权”，等下一批加密认证代理完成后才允许调用。

这些能力都有 SQLite/PostgreSQL 持久化、服务端权限和 API 回归，不是只在页面上展示。完整说明、使用边界和验收方法见 [业务能力 V2](docs/business-capabilities-v2.md)。

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

### ✅ 当前版本验收结果

当前源码版本已经通过：

```text
npm run check       通过
npm test            379 passed / 0 failed / 1 skipped
npm run qa:business-postgres
                    1 passed / 0 failed / 0 skipped（独立 PostgreSQL 测试库）
npm run build       通过
npm run qa:search-agent
                    通过
npm run qa:all      24 passed / 0 failed / 5 skipped
```

本轮门禁开始前已经确认 Docker 与 PostgreSQL 容器正常运行；24 个总门禁项目全部在第一次尝试通过。真实复杂任务产生 732 个连续事件和 624 个 SSE 流式增量，共使用 46,523 Token；Reviewer 评分 45 后触发一次真实人工确认，最终正常完成并保存 568 字符 Artifact。总门禁中的 PostgreSQL 专项最初因为未设置隔离测试库地址而跳过，随后在独立临时数据库中补跑为 `1 passed / 0 failed`，测试库已删除，未触碰业务数据库。

扣除已补跑的 PostgreSQL 后，仍未现场验收的是 4 项外部服务：TencentDB MemoryCore HTTP、Axiom MemoryCore 适配器、MinIO/S3/COS 对象存储和 Harness/Codex sidecar。配置对应 endpoint 或命令后，可以继续进行真实多 Worker 验收；跳过不等于通过，也不影响 SQLite、本地 Artifact 目录和协议级 Harness/Codex 回归。

### 📈 本机性能基线

下面是 2026-09-03 在 Windows 单节点、10 并发、每项 50 次请求下测得的 API 基线：

| 接口 | 吞吐 | P95 延迟 |
| --- | ---: | ---: |
| 健康检查 | 1,722.04 请求/秒 | 8.86 ms |
| 就绪检查 | 2,460.17 请求/秒 | 5.12 ms |
| 任务列表 | 2,074.96 请求/秒 | 5.77 ms |
| 运行观测 | 929.22 请求/秒 | 11.57 ms |

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
- 📡 **实时可见**：任务进度、Agent Graph、事件流和最终交付状态都会实时更新；Graph 支持全屏、节点详情和真实事件抽屉，移动端也能直接查看当前 Agent。
- 🚦 **异常会主动提示**：运行观测会根据真实队列、Worker 租约、模型/工具失败、Artifact 清理和 Readiness 状态生成告警，不需要盯着数字猜问题。
- 📣 **结果可以推到你的系统**：在右上角通知铃铛中配置外发渠道后，任务完成、失败、需要确认或日程异常时，可以把签名 Webhook 发送到你自己的服务；失败投递可查看、重试或暂停。
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
- 🗓️ 切换本周或未来 35 天，提前看到哪些任务会在同一时间挤在一起。
- 🩺 发现连续失败、Token 突增或交付质量下降；平台只提出建议，必须由你确认后才会暂停、恢复或调整时间。
- ✅ 查看最近确认过的调整记录；重复点击旧建议或日程状态已经变化时，系统会拒绝执行。
- 🔗 让下一条日程接着使用上一条已经验证的结果，同时固定来源版本，避免内容悄悄变化。
- 🔁 在短暂故障后自动退避重试，连续失败 5 次后暂停并等待人工恢复。
- 🧱 在 PostgreSQL 多 Worker 部署中安全认领到期日程，并用幂等键避免重复任务。
- 🕰️ 继续读取旧版本创建的固定间隔日程，无需手动迁移。

平台不会根据“最近没打开”就猜测某条日程已经没用，也不会自行删除。需要改变执行安排时，页面会把原因和依据放在确认框里，决定权仍在你手里。

## 🪟 界面一览

这些截图来自当前版本的本地验收流程，展示的是实际控制台，不是宣传样机。截图中的任务和对话是测试数据，不包含真实用户信息。

### 🛰️ 任务台：知道现在进行到哪一步

![任务总览](docs/images/overview.png)

左侧进入任务、对话、插件或 Agent Nexus；中间区域显示当前任务和实时 3D 场景；右侧可以看到负责人、阶段、审核状态和交付结果。

### 💬 对话：像聊天一样使用 Agent 团队

![对话与 Agent Graph](docs/images/conversation.png)

你只需要继续说下一句话。系统会根据新的内容重新判断本轮需要哪些 Agent，旧 Agent 可以被跳过，新 Agent 也可以临时加入。任务执行中还可以直接补充要求；对话顶部会显示本轮真实路径，右下角的 Agent Graph 会跟着执行状态变化。点击节点可以查看角色、上游 Agent、Skill、Token、耗时、重试和工具调用；需要更多空间时可以全屏查看，低性能设备会自动减少动态效果。

### 🔗 Agent Nexus：把一组 Agent 组成自己的工作流

![Agent Nexus](docs/images/agent-nexus.png)

可以把“资料搜集 → 分析 → 复核 → 输出”连成一条流程，也可以加入条件分支和 Loop。每个 Agent 都有清晰的职责和输入输出，运行时可以查看每一步发生了什么。

### 🧩 插件：像打开一个小程序

![插件中心](docs/images/plugins.png)

插件可以由 Agent 协助创建，也可以自己配置。发布前会检查外部依赖、直连网络、字段冲突和工具可用性，并列出它申请的平台 Agent/工具权限。每次修改都会保留历史版本，恢复旧版本时会生成一个新草稿，不覆盖现有记录。

团队插件通过管理员审核后才会出现在插件市场。安装会固定到当时审核通过的版本，作者后来修改插件不会在用户不知情时自动替换；用户可以自己决定升级、卸载或恢复到仍然安全的旧版本。某个版本被撤回后，平台会立即停止运行该版本，避免继续使用已经发现问题的插件。

生产部署可以为发布版本生成完整性签名：配置至少 32 个字符的 `AXIOM_PLUGIN_SIGNING_KEY` 后，新发布插件会保存覆盖内容、权限、发布人和时间的 HMAC 签名；再启用 `AXIOM_REQUIRE_PLUGIN_SIGNATURE=true`，运行时只接受校验一致的版本。Prompt 插件运行和 Mini App 打开前都会从服务端重新读取当前版本并复核；内容、权限风险或验签配置变化时会拒绝运行。已有未签名插件需要在“版本与权限”中检查后重新发布。

### ⚙️ 设置：换成你自己的模型

![模型设置](docs/images/settings.png)

默认使用 DeepSeek，也可以填写自己的 OpenAI-compatible 服务地址、模型名和 Key。文本模型、视觉模型、绘图服务和视频服务可以分开配置。

## 🚀 三步启动

### 1. 安装依赖

要求 **Node.js 22 或更高版本**。基础对话可以直接使用 Node.js；要启用隔离工具执行或运行完整生产门禁，还需要先启动 Docker，并准备沙箱镜像。

```bash
git clone https://gitee.com/water-sim/axiom-agent-control-room.git
cd axiom-agent-control-room
npm install
```

完整门禁前可先检查 Docker：

```bash
docker info
docker image inspect ubuntu:22.04
```

如果第二条命令提示镜像不存在，执行：

```bash
docker pull ubuntu:22.04
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
npm run qa:business # 分段业务闭环评测
npm run qa:context-summary # 持久摘要 API 回归
npm run qa:harness-live # 已配置 sidecar 的真实能力握手
npm run qa:object-storage # 已配置 MinIO/S3/COS 时验证跨 Worker Artifact
npm run qa:all      # 生产门禁回归
npm run release:package # 构建可部署 ZIP，并生成 SHA-256 校验文件
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
| Nexus 附件 | `AXIOM_NEXUS_ARTIFACT_BUDGET_BYTES` | 单任务可加载的附件总预算，默认 20 MB |
| 外部工具路由 | `AXIOM_EXTERNAL_TOOL_TOP_K` | 每个 Agent 步骤最多注入的相关 MCP/OpenAPI 工具，默认 6 |
| 外发通知 | `AXIOM_NOTIFICATION_SECRET`、`AXIOM_NOTIFICATION_RETENTION_DAYS` | 签名 Webhook、失败重试与投递审计 |

`qa:harness-live` 只有在 sidecar 命令已配置时才执行真实握手；未配置时生产门禁会明确标为跳过。协议模拟测试不能替代目标服务器上的真实任务、断流和跨 Worker 演练。

更完整的变量说明见 [`.env.example`](.env.example)。

外发渠道位于页面右上角的“通知 → 外发通知”。页面支持测试、暂停、编辑、删除和死信重投；Webhook 地址与签名密钥会加密保存，浏览器只会收到脱敏地址。删除渠道会擦除地址和密钥，已脱敏的投递审计按配置的保留期保存。接收方验签与幂等处理见 [`docs/outbound-notifications.md`](docs/outbound-notifications.md)。

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
- [工具目录](docs/tool-registry.md)：MCP/OpenAPI 按需路由、健康、权限、审批和执行边界。
- [MemoryCore 接入](docs/memorycore-integration.md)：长期记忆配置与验收。
- [业务能力 V2](docs/business-capabilities-v2.md)：15 项业务闭环、数据边界与验收方法。
- [Harness 适配器](docs/harness-adapters.md)：DeepSeek Harness/Codex 的可选接入方式。
- [上下文窗口与持久摘要](docs/context-window.md)：长对话如何压缩、校验并恢复。
- [业务闭环评测](docs/runtime-business-evaluation.md)：分段评测维度和失败定位方式。
- [Reasonix 运行时采纳说明](docs/reasonix-runtime-adoption.md)：DAG、统一运行上下文、写入冲突调度和交付证据的设计边界。
- [上线就绪度](docs/launch-readiness.md)：当前能力、风险和生产前置条件。
- [v2.1.0 迁移指南](docs/migration-v2.1.md)：从 v2.0.0 升级二进制附件与 MCP 路由。
- [v2.0.0 迁移指南](docs/migration-v2.md)：从 v1.1.0 升级到 v2 的基础步骤。
- [版本变更记录](CHANGELOG.md)：每个正式版本的新增能力、行为变化和外部依赖。

## 📄 开源许可

本项目使用 [MIT License](LICENSE)。你可以自由学习、修改和部署，但请自行配置模型服务并对生产环境负责。

## 🙌 贡献

欢迎提交 Issue、改进文档或发起 Pull Request。涉及 Agent 执行、安全边界、任务恢复和数据隔离的改动，请同时补充测试或回归脚本。
