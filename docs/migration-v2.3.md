# v2.3 执行一致性迁移说明

本说明覆盖执行闭环、跨入口协作及 v2.3.0-rc.8 任务改进与预览稳定性候选版。升级前先停止接收新任务，等待正在执行的外部写入结束；保存数据库、Artifact 存储和部署配置的备份。不要通过删除数据库解决迁移问题。

## rc.8 兼容性与升级要点

- 从 rc.7 升级不新增外部服务要求。“任务改进”复用现有 SQLite/PostgreSQL 业务记录表，以 `improvement-proposal` 类别保存建议；没有新增专用数据库或模型训练服务，也不改写旧任务的执行计划。
- 继续保留并安全备份 `.env.local` 或部署密钥管理中的原有配置，特别是 `AXIOM_PROVIDER_SECRET` 及原有集成、身份和通知密钥。不要为了升级生成另一套密钥，也不要提交真实配置、数据库或用户文件到公开仓库。
- 更新源码后安装锁定依赖、执行 `npm run build`，PostgreSQL 部署执行 `npm run db:migrate`，随后**重启 Axiom 服务**。只刷新页面不能让旧后端加载新增的 `/api/improvements`；多 Worker 应统一更新构建并使用同一套原有密钥。
- 复盘使用来源任务已绑定的文本模型，可能产生模型用量；模型或原凭据不可用时明确失败，不以模板答案代替真实复盘。无需新增工具权限；记录中的来源任务和父代建议仍需满足当前所有者与版本检查。
- 用户主动生成、保存建议，不等于建议已测试、已上线或自动改善业务。试用只准备新的对话草稿，由用户检查后发送，不额外携带附件、对话历史或原 Agent Nexus 流程。已有未发送文字或附件时先保留原输入再确认替换。
- 独立 HTML/SVG/Markdown/TXT 成果可使用 `artifact.create`，不写入项目工作区；原工作区写入审批和文件访问权限仍然有效。已有成果仍依赖原 Artifact 存储备份，升级不会重新生成或恢复被删除的文件。
- 对话与 Nexus 的预览稳定性修复无需迁移历史消息。升级后重新加载前端即可使用，内容不变的作品在滚动、输入和继续输出时保留原实例。
- 文档中的 `frontend-backup/`、`qa/` 日志和历史 Windows 本机路径仅是开发验收记录，不是部署参数。请在自己的目录配置数据库、Artifact 路径、模型和服务端口，不要复制开发者本机路径作为生产配置。

本轮完整本地门禁已完成：`41 passed / 0 failed / 3 skipped`；单测 `700` 项、`684` 通过、`16` 项 PostgreSQL 条件跳过，隔离数据库专项 `18/18` 补齐。最后一整轮可运行项目无需重试；此前轮次的失败与修复保留在 [rc.8 发布验收记录](rc8-release-acceptance-20260920.md)。无需为 RSI 关闭既有安全门禁；多用户可信登录和全平台文件、数据、工具隔离仍需后续完善。

## rc.7 兼容性

- 从 rc.6 升级没有新增数据库结构迁移，不更换现有凭据加密密钥。旧事件缺少用量或路由来源时保留未知，不补造历史指标。
- `GET /api/tasks/:taskId` 增加 `executionQuality`；`POST /api/chat/route` 增加 `diagnostics`。均为附加字段，任务生命周期与路由请求耗时分别测量。
- SSE 增加 `model.failed` 阶段事件；它本身不是任务终态，仍以 `task.completed`、`task.failed`、`task.cancelled` 等任务状态判断执行结果。自建事件消费者应忽略不认识的事件，而非终止订阅。
- `qa:all:local` 默认创建独立 API、测试数据库和临时 Artifact 工作区，不再借用正式运行实例。在线文本检查仍使用已配置模型；不要在未配置供应商时把 Fake 回归当作真实模型验收。

## 配置与数据

1. 使用 Node.js 22、安装锁定依赖，执行 `npm run build`；PostgreSQL 部署执行 `npm run db:migrate`。
2. 设置随机且稳定的 `AXIOM_PROVIDER_SECRET`，建议至少 32 个字符。各 Worker 必须使用同一个值。任务会加密保存创建时的文本、视觉、绘图、视频与搜索配置；任务和事件只保存不含密钥的引用。
   单机源码部署可运行 `node scripts/setup-local-provider-secret.mjs` 生成本地密钥；已有密钥不会覆盖。多 Worker 请通过部署密钥管理分发同一值，不要各自生成。
3. 保留原有凭据加密密钥。不要随意替换，否则历史任务绑定和已保存模型凭据无法解密。更新模型设置只影响新任务，不改写已创建任务或已绑定日程的执行配置。
4. 新增持久化记录包括工具执行账本和模型配置绑定，旧任务保持兼容路径。旧任务没有的新版本回执不能补造；无法确认的外部写入需要核对。
5. 多 Worker 继续共用 PostgreSQL、相同密钥和 Artifact 存储；SQLite 适合单实例本地使用，不能当作多机共享数据库。

## 用户行为变化

- 图片与视频生成使用持久任务，即使只有一个 Agent。已受理请求通过原服务标识查询，未知写入不会自动再次提交。
- 对话、任务详情、Agent Nexus 与 Mini App 的待处理状态保留原任务，不将等待审核当成完成。
- 先核对结果再继续。人工确认已完成不是供应商回执，不能当作事实已验证。
- 旧 `/api/chat` 媒体调用和 `/api/images` 均返回 HTTP `202` 的 `{ task, eventsUrl }`；自建 API 客户端须跟随任务和事件地址，不再假设立即返回文本 SSE 或同步的 `{ images }`。普通文本聊天继续使用 SSE。
- 内联 Base64 媒体保存为平台 Artifact；供应商只返回 URL 时仍使用外链，可能过期。已完成任务的 Artifact 后来被删除或损坏，暂需通过存储备份恢复，不提供自动重新生成或自助重建入口。
- 普通对话、Nexus 和插件的历史仍按入口隔离，任务管理统一查看实际执行记录。

## 验证

运行 `npm run check`、`npm test`、`npm run build`、`npm run qa:visual` 和 `npm run qa:all:local`。本版还可单独执行 `npm run qa:improvements`、`npm run qa:preview-stability`、`npm run qa:file-artifact` 和 `npm run qa:chat-tool-approval`。完整门禁使用独立 API 和 PostgreSQL 测试库，不应指向业务库执行破坏性测试。最新结果与外部依赖边界见 [rc.8 记录](rc8-release-acceptance-20260920.md)；[rc.7 记录](rc7-product-quality-20260907.md) 仅作历史对照，历史媒体契约见 [跨入口记录](cross-entry-consistency-20260907.md)。

MemoryCore、Harness/Codex sidecar、真实视频供应商和目标环境容量仍需现场验收；本地 Fake 服务通过不代表这些外部系统已验收。

本次三个门禁跳过项为 MemoryCore HTTP、MemoryCore Axiom 适配器和 Harness/Codex sidecar 真实握手。干净源码安装、检查、测试、构建及启动已通过，部署 ZIP 解压后的生产依赖安装及隔离启动也已通过；复验摘要见发布记录。`npm audit --omit=dev` 在本次检查时报告零项已知生产依赖漏洞，但不能替代身份、权限、网络与数据隔离验收。

### 干净安装与发布包复现

发布维护者可使用源码仓库中的 `scripts/release-repro-smoke.mjs`，确认其他人拿到源码或部署包后能安装、启动并读取新版接口。**测试目标必须是可丢弃的干净副本，不能是实际工作目录、现有 Git 工作区或正在使用的部署目录。** 脚本会在目标目录安装依赖；源码模式还会构建文件。

1. 将待验证的发布版本导出并解压到新建临时目录，或将对应部署 ZIP 解压到另一个新建目录。源码导出中应包含完整源码及锁文件；部署包中应包含 `dist`、`server-dist` 和锁文件。不要复制 `.git`、`.env.local`、`.env`、`.data`、项目 `.npmrc` 或用户文件，仅保留 `.env.example` 配置模板。
2. 从持有脚本的源码副本调用下列命令。将示例绝对路径替换为自己的临时目录；`--source` / `--bundle` 二选一，指向包含 `package.json` 的目录，不指向 ZIP 文件本身：

   ```powershell
   node scripts/release-repro-smoke.mjs --source "C:\Temp\axiom-rc8-source" --expected-version "2.3.0-rc.8" --report "C:\Temp\axiom-rc8-source-result.json"
   node scripts/release-repro-smoke.mjs --bundle "C:\Temp\axiom-rc8-bundle\axiom-agent-control-room-v2.3.0-rc.8" --expected-version "2.3.0-rc.8" --report "C:\Temp\axiom-rc8-bundle-result.json"
   ```

3. 源码模式执行 `npm ci`、检查、单测和构建；部署包模式执行 `npm ci --omit=dev`，不要求包内包含源码或测试工具。两种模式均检查版本一致、前端静态资源、健康与就绪状态、空任务列表和任务改进 API。需要联网下载锁定依赖，也可通过 `--npm-cache` 指定专用缓存目录。

复现进程不继承应用密钥、真实数据库或模型配置，使用临时 SQLite、Artifact 目录及随机本机端口，不调用真实模型，也不写入业务历史。没有模型 Key 时 Readiness 明确显示未配置，属于此项检查的预期结果，不等于模型已验收。脚本结束后清理其临时运行数据，安装和构建后的测试副本仍保留；确认结果后可自行回收该临时副本。`--skip-tests` 仅适合诊断，跳过单测的结果不能当作完整源码复现通过。正式部署时再按自己的环境配置模型和数据库，并执行目标环境验收。
