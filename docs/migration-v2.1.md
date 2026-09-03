# Axiom v2.1.0 迁移指南

本文面向从 `v2.0.0` 升级到 `v2.1.0` 的部署。此次没有破坏性数据库迁移，主要变化是 Agent Nexus 使用真实二进制附件，以及 MCP/OpenAPI 工具按任务 Top-K 路由。升级前仍应备份数据库、Artifact 与 Secret 配置。

## 1. 升级前备份

暂停 Worker、日程和写入流量，记录当前 commit、镜像与环境变量。备份 PostgreSQL 或 SQLite，并备份 `.data/artifacts/` 或当前对象存储 bucket/prefix。`.env.local` 只能进入受控 Secret 备份，不能放进源码或发布包。

## 2. 获取版本

源码部署：

```bash
git fetch --tags
git checkout v2.1.0
npm ci
npm run build
```

发布包部署：核对 `axiom-agent-control-room-v2.1.0.zip.sha256` 后解压，再运行 `npm ci --omit=dev`。

从新的 `.env.example` 合并配置，并复核：

```text
AXIOM_NEXUS_ARTIFACT_BUDGET_BYTES=20971520
AXIOM_EXTERNAL_TOOL_TOP_K=6
```

前者是单任务 Nexus 附件总预算，默认 20 MB，硬上限 64 MB；后者是每个 Agent 步骤注入的外部工具数量，默认 6，硬上限 12。

## 3. 数据与兼容性

- 业务记录继续使用 JSON 扩展，不需要删除或重建现有表；仍建议执行 `npm run db:migrate`，让当前版本确认 schema 完整。
- v2.0.0 的旧 Nexus data URL 附件会在首次测试或发布时惰性补齐摘要和编码信息。
- v2.1.0 的新上传必须使用支持 `putBinary()`/`getBinary()` 的 Artifact Store；默认文件 Store 和 S3 Store 已支持。如果部署了自定义 Store，需要先实现这两个方法，否则上传明确返回 503。
- 旧 MCP/OpenAPI 工具源在首次手动健康检查前按兼容状态恢复。检查失败后会从模型工具目录移除。
- 认证型 MCP 不会迁移或接收明文 Secret。API Key、OAuth 2 和服务账号来源保持“待授权”，等待后续加密认证代理。

## 4. 存储选择

单节点可以继续使用：

```text
AXIOM_OBJECT_STORAGE_PATH=.data/artifacts
```

多个 Worker 必须共享 MinIO、S3 或 COS。配置后运行 `npm run qa:object-storage`，验证二进制跨进程读取、租户隔离、大对象、删除和失败恢复。未配置时门禁会显示 skipped，不能视为外部存储已通过。

## 5. 验证与启动

```bash
npm run check
npm test
npm run build
npm run qa:visual
npm run qa:all
```

先启动一个 Worker，测试 Nexus 图片与文档上传、测试、发布和固定版本运行，再逐步恢复其他 Worker。能力目录中异常、待授权或 Agent 无权限的工具不应出现在模型可用工具中。

## 6. 回滚

停止所有 v2.1 Worker，保存日志与故障时间点，恢复升级前数据库和 Artifact 快照，再切换到 `v2.0.0`。v2.1 新上传的 `.bin` 文件不会被 v2.0 运行时使用，因此数据库与 Artifact 必须一起回滚，不能只回退代码。

## 7. 当前生产边界

`v2.1.0` 仍是本地或受控环境生产候选。面向外部多租户前，需要完成 OIDC/RBAC、Secret Manager、MCP 加密认证代理、租户配额、外部对象存储多 Worker 验收、OpenTelemetry、告警、备份和灾难恢复演练。
