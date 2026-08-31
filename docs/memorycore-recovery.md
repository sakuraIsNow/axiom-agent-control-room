# MemoryCore 持久化与恢复

更新时间：2026-08-29

## 运行边界

`TencentMemoryClient` 是 Axiom Runtime 的 MemoryCore 适配器。配置
`TDAI_MEMORY_ENDPOINT` 后，Recall 使用 L1 Atomic、L2 Scenario 和 L3 Core
三层接口；租户、用户、Agent 和会话作用域由服务端从任务身份生成，浏览器不会直接传入可覆盖的隔离字段。

正式 TencentDB MemoryCore 只需要提供兼容的 `/v3/*` API 和服务凭据：

- `TDAI_MEMORY_ENDPOINT`：MemoryCore 服务地址
- `TDAI_MEMORY_API_KEY`：服务凭据，建议由 Secret Manager 注入
- `TDAI_MEMORY_INSTANCE_ID`：实例标识，默认 `axiom-control-room`
- `AXIOM_MEMORY_MIN_CONFIDENCE`、`AXIOM_MEMORY_L1_BUDGET`、`AXIOM_MEMORY_L2_BUDGET`、`AXIOM_MEMORY_L3_BUDGET`：召回过滤和预算

## 捕获闭环

每次完整任务结果进入 `conversation/add` 前，先在 PostgreSQL/SQLite 的
`memory_capture_receipts` 写入唯一收据。唯一键为租户、用户、会话、任务和内容摘要，收据保存规范化后的有界输入/输出、游标、租约和尝试次数。

1. `claim` 以租约抢占 pending 收据；已完成收据只增加 duplicate skip。
2. MemoryCore 成功后 `complete` 清理 claim token，记录游标、数量和完成时间。
3. 网络错误或进程崩溃由 `fail`/`reclaimExpired` 转为 failed，并设置下一次重试时间。
4. `MemoryCaptureCompensationWorker` 启动时和每 15 秒扫描 retryable 收据，使用持久化载荷重放同一个幂等摘要。

跨进程/跨重启测试覆盖 SQLite 收据复用、过期租约、失败补偿和最终 completed 状态；PostgreSQL 迁移使用 `ADD COLUMN IF NOT EXISTS`，SQLite 迁移对已存在列幂等处理。

## 过期和质量过滤

Recall 在服务端响应之后统一进行：过期时间过滤、置信度下限过滤、L3/L1/L2 独立字符预算和来源标记。返回 `quality` 指标包含候选数、过期过滤数、低置信度过滤数和各层保留数量，便于运行观测和线上质量评估。

## 现场验收

本地隔离 Gateway 的 L0/L1/L3、跨租户隔离、更新删除和失败边界已有自动化验收。接入真实 TencentDB 后还需使用 `npm run qa:all` 验证跨进程重启、真实 L2 异步写入、时间游标去重、过期数据和服务端限流；未配置 endpoint 时，平台保持 MemoryCore disabled，不伪造健康状态。
