# v2.3 执行一致性迁移说明

本说明覆盖执行闭环、跨入口协作与 rc.7 产品质量候选版。升级前先停止接收新任务，等待正在执行的外部写入结束；保存数据库、Artifact 存储和部署配置的备份。不要通过删除数据库解决迁移问题。

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

运行 `npm run check`、`npm test`、`npm run build`、`npm run qa:visual` 和 `npm run qa:all:local`。完整门禁使用独立 API 和 PostgreSQL 测试库，不应指向业务库执行破坏性测试。最新结果与外部依赖边界见 [rc.7 记录](rc7-product-quality-20260907.md)，历史媒体契约见 [跨入口记录](cross-entry-consistency-20260907.md)。

MemoryCore、Harness/Codex sidecar、真实视频供应商和目标环境容量仍需现场验收；本地 Fake 服务通过不代表这些外部系统已验收。
