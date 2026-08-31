# MemoryCore 长期记忆接入

## 数据闭环

Axiom 在每个 Direct、Single Agent、Team 和 Full Workflow 任务进入最终完成事件前，将本轮最新用户输入与最终回答写入 MemoryCore L0。L1 原子记忆、L2 场景和 L3 核心画像仍由 MemoryCore 的抽取管线生成；普通 Agent 不会自动覆盖 L2/L3。

写入前会执行以下保护：

- 只截取格式化会话中的最后一个 `USER` 回合，避免把整段历史重复追加到 L0。
- 清洗空字节、召回上下文和常见 API Key、Bearer Token、Secret、Password。
- 使用租户、用户、会话、任务与规范化内容的 SHA-256 摘要建立幂等身份。
- PostgreSQL/SQLite `memory_capture_receipts` 原子认领写入权；多 Worker 只有一个请求会到达 MemoryCore。
- `pending` 收据使用短租约；写入失败会转为 `failed`，后续任务恢复可以再次认领。
- 成功收据保存游标、尝试次数、MemoryCore 总量和实际捕获消息数。

MemoryCore 不可用时会产生 `memory.capture.failed` 事件，但不会把已经生成成功的任务改成失败。

## 召回质量

召回同时读取 `/v3/atomic/search`、`/v3/scenario/ls` 和 `/v3/core/read`。当 L1 搜索返回空结果或不可用时，会在同一租户、用户、Agent、任务隔离范围内降级调用 `/v3/atomic/query`；查询记录没有相关性分数时使用受限的默认置信度，并标记来源为 `query (fallback)`。部分端点失败时使用其余成功层，全部失败时返回空上下文，不阻断主任务。

进入模型上下文的条目包含 `memoryId`、`layer`、`source`、`confidence`、时间与可选过期时间，并执行以下约束：

- L1 按搜索分数降序排列，默认置信度阈值为 `0.25`。
- 已过期条目不会进入上下文。
- L1/L2/L3 分别使用独立字符预算，避免长期记忆挤占当前任务上下文。
- 召回内容被标记为不可信参考，模型不得把记忆正文当成系统指令。
- `memory.recall.completed` 会记录候选数、过期过滤数、低置信度过滤数与各层命中数。

## 配置

```dotenv
TDAI_MEMORY_ENDPOINT=http://127.0.0.1:8420
TDAI_MEMORY_API_KEY=
TDAI_MEMORY_INSTANCE_ID=axiom-control-room
AXIOM_MEMORY_MIN_CONFIDENCE=0.25
AXIOM_MEMORY_L1_BUDGET=6000
AXIOM_MEMORY_L2_BUDGET=2500
AXIOM_MEMORY_L3_BUDGET=3500
```

未设置 `TDAI_MEMORY_ENDPOINT` 时，捕获会真实记录为 `memory.capture.skipped`，原因是 `disabled`；`/api/runtime/readiness` 会保持降级状态。

## 上游版本要求

生产环境不能直接使用未修复的 MemoryCore SQLite 版本。已验证的上游问题是：`/v3/atomic/update` 在传入 `record_id` 时，旧版 `queryL1Records` 会忽略 `recordIds` 过滤并取全表首条记录，合法更新可能被误报为“属于其他用户”。部署前必须使用包含精确主键查询修复的版本，或应用上游补丁；Axiom 不会在适配器中绕过该归属校验。

另外，SQLite 构建如果没有 FTS5 或 Embedding Provider，`/v3/atomic/search` 可能没有结果，此时必须保留本项目的 `/v3/atomic/query` 降级路径。该路径解决可用性问题，但不能替代生产环境的相关性检索能力验收。

## 维护 API

| API | 能力 | 权限 |
| --- | --- | --- |
| `GET /api/memory/capture-stats` | 当前用户的捕获、重试、去重统计 | 当前用户 |
| `PATCH /api/memory/atomic/:memoryId` | 更新 L1 内容与背景 | 当前用户，viewer 除外 |
| `DELETE /api/memory/atomic/:memoryId` | 删除 L1 条目 | 当前用户，viewer 除外 |
| `DELETE /api/memory/conversations` | 按消息或会话删除 L0 | 当前用户，viewer 除外 |
| `GET /api/memory/scenario` | 读取 L2 场景 | 当前用户 |
| `PUT/DELETE /api/memory/scenario` | 更新或删除 L2 场景 | owner/admin |
| `GET /api/memory/core` | 读取 L3 核心画像 | 当前用户 |
| `PUT /api/memory/core` | 覆盖 L3 核心画像 | owner/admin |

所有 MemoryCore 请求中的 `team_id` 和 `user_id` 都来自服务端验证后的 principal，不接受客户端覆盖。参考版本没有 `/v3/core/delete`，因此平台没有伪造 L3 删除语义；需要删除核心画像时，应先在 MemoryCore 侧明确合规的归档或删除协议。

## 验收边界

仓库测试覆盖并发认领、重复跳过、失败重试、租户隔离、敏感信息清洗、过期和低置信度过滤、搜索到查询的降级、部分端点降级及维护权限。正式启用仍必须对部署的 MemoryCore 实例运行一次真实 L0 写入并确认 L1/L2/L3 抽取结果，模拟 HTTP 测试不能替代该验收。
