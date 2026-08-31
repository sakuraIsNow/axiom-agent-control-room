# Harness 与 Codex Transport

更新时间：2026-08-29

## 统一边界

外部 Harness 通过 `HarnessAdapter` 接入，所有 Thread、Turn、Item、消息增量、审批、Artifact 和 checkpoint 事件先归一化为 Axiom `RuntimeEvent`，再写入 TaskStore 和 SSE。Builtin Runtime 仍是默认权威执行者；只有能力握手通过并显式启用 sidecar，任务才会被委托。

## DeepSeek ACP

`DeepSeekAcpStdioAdapter` 使用换行分帧 JSON-RPC，支持 `initialize`、`session/new`、`session/prompt`、`session/cancel`、`session/update` 和一次性审批响应。配置 `DEEPSEEK_HARNESS_COMMAND`（或 JSON 命令）并设置 `DEEPSEEK_HARNESS_ACTIVE=true` 后启用。

## Codex app-server v2

`CodexAppServerAdapter` 使用同一隔离 stdio transport，支持 `initialize`、`thread/start`、`thread/resume`、`turn/start`、`turn/interrupt`、`turn/steer`、`item/agentMessage/delta`、Item/Turn 生命周期和 `requestApproval`。配置：

- `CODEX_APP_SERVER_COMMAND` 或 `CODEX_APP_SERVER_COMMAND_JSON`
- `CODEX_APP_SERVER_CWD`
- `CODEX_APP_SERVER_TIMEOUT_MS`
- `CODEX_APP_SERVER_ACTIVE=true`

真实 Codex 版本、workspace 和审批策略由部署环境固定；没有命令时不会启动子进程，也不会把 capability handshake 当成任务已接管。

## 委托、审批和恢复

`HarnessTaskBridge` 只允许暂停任务开始外部委托，消费事件时校验 task/tenant/run 边界并按外部序列去重。异常断流会持久化 `harness.disconnected`、把任务置为 paused，并由启动恢复和 20 秒扫描从最近 `harness.connected` 事件重建 Thread、游标和输出。

外部 `approval.requested` 会重建为任务级 `ToolApproval`，包含 request ID、工具名、参数、风险等级和 requestedAt；审批决定转发给活动 sidecar，同时写入 durable `approval.resolved`。同一 request ID 只能从 pending 变为 approved/rejected 一次。重启时从事件回放 pending approval，恢复订阅和游标后再次等待人工决定。

协议级 fake sidecar 测试已覆盖消息增量、终态、跨租户丢弃、断点恢复、审批回放和重复审批拒绝。真实 DeepSeek Harness/Codex app-server 仍需在目标环境提供可执行 sidecar 后进行现场验收。
