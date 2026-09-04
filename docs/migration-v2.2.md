# v2.2 能力包迁移指南

本文适用于从 `v2.1.0` 升级到 `v2.2.0`。这一稳定版增加按租户管理的能力包、加密集成凭据仓库、飞书服务账号连接器、PostgreSQL 多 Worker 故障接管门禁和本地 MinIO 验收，并补齐生产门禁与前端资源缓存，不改变现有任务、会话、Nexus 或 Artifact 数据格式。

## 升级步骤

1. 备份 PostgreSQL/SQLite 和 `.env.local`。源码部署安装依赖后先运行 `npm run build`；发布 ZIP 已包含 `server-dist/`，可直接安装生产依赖。
2. 为生产或长期测试环境设置不少于 32 个字符、随机且稳定的 `AXIOM_INTEGRATION_SECRET`。未设置时会回退到 `AXIOM_PROVIDER_SECRET`，回退密钥也必须满足同样长度。
3. PostgreSQL 部署先运行 `npm run db:migrate`，再启动服务。SQLite/PostgreSQL 会自动创建 `integration_credentials` 表；PostgreSQL Task Store 使用串行迁移和 schema 版本哨兵，现有业务表不会被清空。正式命令只依赖已构建的 `server-dist/`，源码调试也可使用 `npm run db:migrate:dev`。
4. 进入“项目空间 → 能力”，确认开发与代码、研究与论文、办公协作、数据分析四个推荐包已启用。
5. 在飞书开放平台创建企业自建应用，授予实际需要的只读或发送权限，再使用 App ID/App Secret 完成真实连接验证。

## 行为变化

- 外部工具不仅检查健康、授权和 Agent 权限，还会在进入模型候选前检查租户及其已安装能力包。
- 新租户默认启用四个推荐能力包；用户明确停用后会保存禁用记录，重启不会自动恢复。
- 飞书只有在开放平台真实返回 `tenant_access_token` 后才显示已连接。发送消息继续要求人工确认。
- 浏览器和业务 API 只能看到凭据名称、类型和 Secret 字段名，不能读取 App Secret 或短期 token。

## 密钥轮换

`AXIOM_INTEGRATION_SECRET` 是本地加密主密钥，不会存入数据库。直接更换会导致旧密文无法解密；当前版本尚未提供在线重加密命令。轮换前应先断开现有飞书连接，更换密钥并重启，再重新连接。正式多副本部署必须让所有 Worker 使用同一个 Secret Manager 版本。

## 升级后验收

本机安装 Docker 且 PostgreSQL 管理账号允许创建临时数据库时，运行 `npm run qa:all:local`。脚本会启动 `docker-compose.local.yml` 中固定版本的 MinIO，创建并删除独立 QA 数据库，同时执行完整门禁。目标环境使用自己的 S3/COS/MinIO 时，仍需配置对应 endpoint、bucket 和凭据后运行 `npm run qa:object-storage`。

## 尚未包含

- 飞书用户 OAuth 和个人身份委托。
- 任意 MCP/OpenAPI 的 API Key 注入和通用 OAuth 2 回调、刷新、撤销。
- GitHub App 私有仓库连接器。
- 能力包市场签名、审核、撤回、后台巡检、熔断和租户级调用预算。

这些能力未完成前，除飞书连接器以外的认证型工具源会继续显示待授权并保持禁用。
