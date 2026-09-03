# Axiom v2.0.0 迁移指南

本文面向从 `v1.1.0` 升级到 `v2.0.0` 的已有部署。v2 的数据库变更以新增表、字段和索引为主，但 Agent Nexus 的运行规则发生了明确变化，因此升级前必须保留数据库和 Artifact 备份。

## 1. 升级前记录与备份

记录当前代码和镜像版本，并暂停所有 Worker、日程触发器和写入流量。不要在旧 Worker 仍运行时让 v2 实例连接同一数据库。

PostgreSQL 示例：

```bash
pg_dump --format=custom --file=axiom-v1.1.0.backup "$DATABASE_URL"
```

SQLite 示例：

```powershell
Copy-Item .data/axiom-control-room.sqlite .data/axiom-control-room-v1.1.0.sqlite
```

同时备份 `.data/artifacts/` 或对象存储中 Axiom 使用的 bucket/prefix。`.env.local` 含密钥，只应进入受控 Secret 备份，不能放入源码或发布包。

## 2. 获取并安装 v2

源码部署：

```bash
git fetch --tags
git checkout v2.0.0
npm ci
npm run build
```

发布包部署：解压 `axiom-agent-control-room-v2.0.0.zip`，先核对同目录 `.sha256`，再运行 `npm ci --omit=dev`。

从旧环境复制配置时，应从新的 `.env.example` 逐项迁移，不要用旧文件覆盖新模板。至少复核：

- `DATABASE_URL`、`DATABASE_SSL`、`DATABASE_POOL_SIZE`
- `AXIOM_PROVIDER_SECRET`、`AXIOM_NOTIFICATION_SECRET`
- `AXIOM_ALLOWED_ORIGINS` 与生产身份注入配置
- `ARTIFACT_S3_*` 或当前对象存储配置
- `AXIOM_PLUGIN_SIGNING_KEY` 与 `AXIOM_REQUIRE_PLUGIN_SIGNATURE`
- Harness、Codex、MemoryCore 等可选服务 endpoint

## 3. 数据库迁移

确保新旧版本没有并发写入，然后执行：

```bash
npm run db:migrate
```

迁移会创建缺失的表、字段和索引，并保留已有任务、会话、插件、日程和 Artifact 记录。先在数据库副本演练，再对正式数据库执行。

## 4. Agent Nexus 行为变化

v2 不再允许草稿直接进入正式运行：

1. 打开已有 Nexus，检查 Agent、连线、条件和 Loop。
2. 执行测试，确认输入输出、工具权限和终态。
3. 发布一个固定版本。
4. 之后的正式运行使用该发布版本；继续编辑只会改变草稿，不会悄悄影响正在运行的任务。

旧客户端如果直接运行草稿，会收到 HTTP 409。需要升级前端或改为调用测试、发布、运行的完整流程。

如果启用了插件签名强制校验，旧插件也需要在 v2 中检查并重新发布。

## 5. 启动和验证

先启动单个 Worker：

```bash
npm start
```

依次检查：

```bash
npm run check
npm test
npm run build
npm run qa:visual
npm run qa:all
```

`qa:all` 中标记为跳过的外部服务不代表通过。配置对象存储、MemoryCore 或 Harness/Codex sidecar 后，需要分别完成真实探测和跨 Worker 演练。

确认单 Worker 正常后，再逐步恢复其他 Worker、日程和外部流量。多 Worker 必须共享相同的 PostgreSQL、对象存储、`AXIOM_PROVIDER_SECRET`、通知密钥和插件签名密钥。

开发模式的 Vite 页面（默认 `4300`）会代理到独立 API（默认 `8787`）。升级后必须同时重启这两个进程；新版页面连接旧 API 会出现 404、请求校验失败或功能缺失。生产构建建议直接使用 `npm start` 的单端口服务，页面与 API 天然保持同一版本。

## 6. 回滚

出现无法在维护窗口内解决的问题时：

1. 停止所有 v2 Worker 和写入流量。
2. 保存 v2 运行日志和故障时间点，避免丢失诊断证据。
3. 恢复升级前的 PostgreSQL/SQLite 与 Artifact 快照。
4. 切换回 `v1.1.0` 代码或镜像。
5. 恢复旧版本配置，先启动单 Worker 验证，再恢复流量。

不要让 v1.1.0 直接连接已经由 v2 写入并继续运行过的数据库。即使多数迁移是加法变更，v1 也不理解 v2 新状态和 Nexus 发布契约。

## 7. 当前生产边界

`v2.0.0` 是受控环境生产候选，不等于无需部署工程即可直接暴露公网。上线前仍需完成组织自己的身份认证、权限模型、Secret 托管、HTTPS、限流、备份、审计保留、监控告警、容量测试、对象存储和灾难恢复演练。
