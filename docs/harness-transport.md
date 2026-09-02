# Harness 与 Codex Transport

更新时间：2026-09-02

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

协议级 fake sidecar 测试已覆盖消息增量、终态、跨租户丢弃、断点恢复、审批回放和重复审批拒绝。`npm run qa:harness-live` 会在配置真实命令时通过运行中的 Axiom API 检查被选择的 transport、协议兼容性、显式启用状态和能力列表；未配置命令时结果为 `skipped`，不会伪装成已接入。

2026-09-02 已使用本机 Codex CLI `0.149.1` 的原生 `codex app-server --stdio` 完成一次真实 v2 握手，返回版本 `2`，并识别 Thread start/resume、Turn start/interrupt/steer、Item 事件、审批请求和事件回放能力。该证据只证明 transport 与当前 app-server 的握手兼容，不等于真实任务、断流回放和跨 Worker 接管已经验收。

本地 `deepseek-harness` rc.8 压缩包是源码而非已构建 sidecar；其根包要求 Node `^22.19.0 || >=24.0.0`，当前机器 Node `22.14.0` 且未安装 pnpm，因此 DeepSeek ACP 现场启动仍未完成。目标环境需先构建 `@deepseek-ai/dsh-acp-demo` 或提供固定的 ACP 可执行命令。

## 现场验收边界

1. 固定 sidecar 版本、完整命令数组、workspace 和审批策略，使用 JSON 命令配置避免 shell 解析。
2. 执行真实 Thread/Turn，确认流式消息、工具、审批和 Artifact lineage 写入同一个租户任务。
3. 在活动 Turn 中执行 steer，只有 sidecar 返回 accepted 才允许 UI 显示“已应用”。
4. 杀死并重启 sidecar，验证 durable cursor 回放不重复计数，任务停在可恢复状态。
5. 使用两个 Axiom Worker 验证任务租约、恢复所有权和单一写入者，不把单进程重连当作跨 Worker 接管。
