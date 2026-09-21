# Jev 可选决策路由接入记录

日期：2026-09-21。版本：`2.3.0-rc.8 + Unreleased`。本次不发布标签或推送仓库，不自动重启日常服务。

## 范围

Jev 是结构化决策模型，不按聊天补全接口调用。本次使用 `POST /v1/systemone` 和固定版本 `jev-1.13.0`，由 Choice/Noul 输出判断意图、难度、外部事实需求、Agent 和 Skill 候选。

- Jev 不生成最终答案，不执行工具，不授权权限，也不自行写出可运行 DAG。
- 原有文本模型 Scheduler 继续安排步骤、依赖、并行和本轮跳过的 Agent；实际工作仍由配置的大语言模型和专用服务完成。
- 原 Router 的提示词、校验与纠错流程保留；旧路由可独立运行，不依赖 Jev 的 key 或服务可用性。
- 不更改现有按成功率、延迟、成本选择步骤模型的策略，不把“Agent/Skill 选择”混称为“自动替换所有模型”。
- 不增加独立用户选择推荐页面；需要开放选择建议时，仍由普通对话处理。

参考接口文档：[API](https://docs.typesafe.ai/api.md)、[模型](https://docs.typesafe.ai/models.md)、[置信度](https://docs.typesafe.ai/confidence.md)、[Jev 1.13 边界](https://docs.typesafe.ai/model-jaggedness/jev-1.13.md)。官方对中文、精确计算、日期比较、深度推理与对抗输入的限制不因本次接入消失。

## 备份与回退

快照：`frontend-backup/20260921-pre-jev-routing.zip`，3,383,326 字节。已检查包含原 `server/runtime/chatRouter.ts` 和共享 Schema，排除凭据、数据、构建产物和日志。初次 `Compress-Archive` 因日常日志被占用未成功，改为排除运行产物后打包；没有停止日常服务。

回退无需覆盖文件或数据库：将 `.env.local` 的 `AXIOM_DECISION_ROUTER` 改为 `legacy`，重启本次构建的服务。快照只用于源文件核对，不能直接覆盖仍在使用的用户配置或数据。

## 三种模式

| 配置 | 行为 |
| --- | --- |
| `legacy` | 默认；不访问 Jev，完整使用原 LLM Router/Scheduler |
| `jev-shadow` | 先观察 Jev，再执行完整原路由；不收窄旧路由候选，不影响分工，但增加等待与调用费用 |
| `jev-hybrid` | 接受通过严格校验的 Jev 选择，继续调用原 Scheduler；不确定、异常或 Scheduler 拒绝后回到旧 Router |

配置示例，只放服务端 `.env.local`，不要放 `VITE_` 变量：

```dotenv
AXIOM_DECISION_ROUTER=jev-hybrid
TYPESAFE_API_KEY_FILE=C:/path/to/private/jev-key.txt
TYPESAFE_API_BASE=https://api.typesafe.ai
TYPESAFE_MODEL=jev-1.13.0
AXIOM_JEV_TIMEOUT_MS=4000
AXIOM_JEV_MIN_CONFIDENCE=0.85
AXIOM_LOCAL_MODEL_HOSTS=llm.corp.example
```

也可使用部署系统注入 `TYPESAFE_API_KEY`，它优先于文件。文件接受原始 key 或 `key:` 前缀，最大 4096 字节；不得提交到仓库。本机只保存对用户桌面既有密钥文件的引用，没有复制明文 key。

启动时读取一次配置。`GET /api/runtime/decision-routing` 返回脱敏模式、模型和配置状态，不返回密钥或文件路径。`ready` 仅表示配置可以构造适配器，**不是在线健康探测通过**；无效配置自动保留旧路由。默认 `.env.example` 为 `legacy`。

本机 `.env.local` 已设为 `jev-hybrid`，但既有日常进程没有重启，所以本次修改尚未在那个进程内启用。

## 数据与执行边界

- 发送本轮文本、最近最多 8 条且每条最多 1500 字符的上下文、当前 Graph、候选目录与附件元数据。最终序列化采用字段白名单：附件仅 `name/mimeType/kind`，不发送额外正文、图片二进制、文件对象或下载地址；目录和 Graph 也不转发契约外字段。此前仅靠 TS 窄类型不能阻止 HTTP 额外属性外发，独立审查发现后补齐实际校验及回归。
- Internet 模型会话启用 Jev 后，以上数据会额外发送给 Typesafe。处理敏感数据前应评估这一新增供应商。
- 本地服务地址、本机/私有 IP、`.local` 和服务端 `AXIOM_LOCAL_MODEL_HOSTS` 精确声明的域名绕过 Jev。该列表不接受 URL 或通配符；不依靠 DNS 自动推断任意企业域名。私有 FQDN 应显式配置或保持 `legacy`。
- Jev 单次无重试；服务配置默认 4 秒，允许 0.5 到 10 秒，共享整次路由时间和取消信号。响应读取也受超时与体积限制，禁止重定向。
- 请求最多 64,000 字符；响应最多 128,000 字符且不超过 512,000 字节。严格校验问题 ID、类型、候选、概率、目录、附件依赖和计划环路。
- 低置信度、困难/复杂任务、报告导出及语义矛盾主动退让。每个 Agent/Skill 独立选择，允许多个，不为展示 Graph 强行增加 Agent。
- Jev 置信度不能启用原 Router 的简短对话快路径。Scheduler 对 Jev 候选校验失败后最多回原路由一次；用户取消不会另起模型重试。
- Jev 的真实调用、耗时和可用 Token 进入诊断。失败回退不算首次成功；无 Token 的响应保持未知。不记录原始响应、错误正文或凭据。
- 尚未加入 Jev 专属共享熔断或并发限额，故障时可能每轮增加至超时边界的等待。不能据单次模型耗时声称整个任务更快或更便宜。

## 实现与回归

- `server/runtime/jevDecisionRouter.ts`：原生协议、有限请求、严格响应和决策校验。
- `server/runtime/decisionRouting.ts`：服务端模式与密钥文件加载。
- `server/runtime/chatRouter.ts`：可选决策层、原路由保留、Scheduler 和诊断；同时修复已有附件 Agent 的下游依赖遗漏。
- `server/index.ts`、`server/runtime/taskApi.ts`：对话和日程入口；计划、事件和共享类型保留决策来源。
- `server/runtime/modelClient.ts`、`providerLocation.ts`：本地模型隐私分流，包含需要 API key 的本地服务。
- `qa/lib/jev-routing-cases.mjs`、`scripts/jev-routing-eval.mjs`：独立判定的 26 例中文合成路由评测；显式启用，不访问用户历史或执行工具。

离线 oracle 已加入业务判定器与无密钥 CI，真实调用不加入自动 CI。运行方式：

```powershell
npm run check
npm test
npm run build
npm run qa:jev-oracles
# 以下会调用配置的真实 Jev，可能产生费用。
npm run qa:jev-routing
```

## 真实调用记录

| 观察 | 正确选中 | 错误选中 | 弃权 | 调用错误 | 覆盖率 | P50 / P95 |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| 首轮 26 例 | 7 | 0 | 14 | 5 | 26.9% | 424 / 993 ms |
| 增加安全诊断后的 26 例 | 7 | 0 | 18 | 1 | 26.9% | 284 / 973 ms |

原始本地证据：

- `qa/jev-routing-2026-09-21T05-49-12-028Z-f045bafb-results.json`
- `qa/jev-routing-2026-09-21T05-56-47-465Z-618d6c29-results.json`

首轮 5 项 `EVALUATION_ERROR` 缺少异常阶段，无法确定根因，不能推断成服务瞬时故障或源码热更。首轮执行期间，三项静态概念解释的 oracle 从只允许 conversation 改为也允许 task/analyst，以符合实际任务契约；这三项均弃权，不影响本表计数，但首轮缺少源码/判定器摘要，不能当作完全冻结的基准。

第二轮在冻结案例和适配器后记录源码、案例及 oracle 摘要，仍有 `injection-quoted-document` 的 `invalid-response`，发生在适配器评估阶段。没有保存响应正文，未定位具体字段。随后针对该案例的一次诊断未复现错误，仅低置信度弃权；**不算问题已修复，也不替换套件记录**。

两次观察都非全绿。7/7 只表示本小样本中被接管的七项正确，不是 26/26，也不是任意复杂任务准确率。弃权和错误应由旧 Router 接手，离线集成验证了这些分支，但此表只测 Jev 选择，不测完整最终交付。

另做一条有界混合链路检查：合成实时天气请求由真实 Jev 选择 `search-agent`，真实 DeepSeek Scheduler 生成有效计划。用时 2208 ms，2 次真实模型调用、5669 Token，无修复或回退。没有执行天气查询、工具或任务，也没有访问用户历史，因此只证明跨供应商路由链路，不证明天气答案质量。

该辅助检查的首个启动命令因 PowerShell 引号处理出错，未调用模型；第二次已调用模型，但测试命令把诊断汇总函数的两个参数传反，结果记录失败。修正测试命令后上述一次检查通过；三个日志依次保留为 `qa/jev-hybrid-live-20260921.log`、`qa/jev-hybrid-live-attempt2-20260921.log`、`qa/jev-hybrid-live-attempt3-20260921.log`。不将该过程写成首轮通过，也不用于覆盖 26 例套件中的失败。

## 最终验收状态

初次标准检查与生产构建通过；完整单测 914 项，896 通过、18 PostgreSQL 条件跳过。随后独立审查补齐企业私有 FQDN 的显式配置和请求前拒绝的调用计量，最终源码类型检查通过，单测 923 项：905 通过、0 失败、18 PostgreSQL 条件跳过。

隔离全门禁启动早于上述两项补丁，其原始标准检查不能冒充最终源码验证，因此另行保留 `qa/jev-check-freeze-20260921.log`、`qa/jev-unit-freeze-20260921.log` 和 `qa/jev-build-freeze-20260921.log`，三项通过。后续附件/目录/Graph 白名单投影补丁完成后再次验证最终源码：

- `npm run check`：通过，`qa/jev-check-privacy-final-20260921.log`。
- `npm test`：**925 项，907 通过、0 失败、18 PostgreSQL 条件跳过**，`qa/jev-unit-privacy-final-20260921.log`。
- `npm run build`：通过，`qa/jev-build-privacy-final-20260921.log`。
- `npm run qa:ci`：**12/12 阶段首次通过**，使用最终源码临时副本，不继承凭据或用户数据；阶段内部的 PostgreSQL 条件跳过仍按单测记录，不冒充现场数据库测试。证据 `qa/ci-quality/2026-09-21T06-18-24-834Z/results.json`；临时副本已清理。
- `git diff --check`：通过；对当时 86 个变更/未跟踪文件的精确 Jev key 扫描为 0 命中，`.env.local` 与备份已被 Git 忽略。本次没有 commit/push。

两次 26 例真实评测和混合链路发生在后续隐私与计量修复之前，报告保留原版本摘要；最后补丁通过离线回归，未再次调用真实模型以覆盖或掩盖早前失败。

本轮 `QA_ROUTING_REPEATS=3 npm run qa:all:local` 结果：**45 passed / 1 failed / 0 unstable / 3 skipped**，退出码 1。证据目录 `qa/production-gate/2026-09-21T06-02-00-158Z/`，启动和汇总日志 `qa/jev-all-local-20260921.log`。

- 原路由三轮评估 21/21、浏览器视觉 172/172、3D Graph 22/22、数据隔离、SSE、恢复、报告、MCP、PostgreSQL 和 MinIO 检查通过。PostgreSQL 稳定性 20/20。该总门禁早于最后外发隐私补丁启动，不是最终源码全链路通过证明。
- Nexus Loop 在线测试两次执行四个步骤且有 `12 + 30 = 42` 结果，但 `taskCompleted` 与 `sseReachedTerminal` 为 false；保留失败，不重跑整套寻求绿色结果。
- SSE 在约 12 秒后正常返回，未达到 180 秒超时；服务设计允许在等待人工处理时正常关闭 SSE，不能仅凭上述断言认定断流。交付检查先保存文本再决定是否完成，因此结果存在不证明通过验收。
- 当前测试在清理前没有记录任务状态、完整审核回执和最后事件，且随后取消并删除测试记录。证据高度符合交付检查转入人工处理，但**不能确证具体拒绝原因**；下一步先补安全诊断，再修实际问题，不自动批准或弱化断言。
- 隔离测试服务固定 `legacy`，上述 Nexus 失败不经过 Jev。日常数据库和会话未用于这批测试，原服务 PID 676 未重启。
- 三项外部跳过为 MemoryCore HTTP、MemoryCore Axiom 适配器、Harness sidecar；未配置不算通过。

本次不解决上一批仍未通过的复杂任务公式语义验收，不替换真实领域留出集，也不承诺普遍准确率。大规模接管前还需扩大中文留出样本，测量端到端成本/等待，并调查偶发协议拒绝。
