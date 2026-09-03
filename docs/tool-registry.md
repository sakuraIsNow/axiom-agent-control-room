# Tool Registry

P1.2 adds a bounded Tool Registry to the runtime. Builder agents can request only registered tools. Every request is schema-validated, risk-classified, quota-checked, and represented by runtime events.

## Registered tools

| Tool | Risk | Approval | Execution boundary | Behavior |
| --- | --- | --- | --- | --- |
| `workspace.search` | low | no | sandbox | Read-only `rg` search inside the configured workspace |
| `workspace.read` | low | no | sandbox | Read one UTF-8 file |
| `document.read` | low | no | host-bounded | Read bounded Markdown, JSON, YAML, XML, HTML, or text documents |
| `table.read` | low | no | host-bounded | Normalize bounded CSV or JSON rows |
| `http.fetch` | medium | no | host-bounded | GET/HEAD a JSON or text endpoint on `AXIOM_HTTP_ALLOWLIST` |
| `browser.open` | medium | no | host-bounded | Read text and title from an allowlisted public HTML page |
| `database.query` | medium | no | host-bounded | Run one read-only SELECT/WITH/EXPLAIN/SHOW query |
| `workspace.git-status` | low | no | sandbox | Read repository status |
| `workspace.git-diff` | low | no | sandbox | Read the current diff |
| `workspace.git-branch` | low | no | sandbox | Read local branches and tracking state |
| `workspace.git-commits` | low | no | sandbox | Read recent commit summaries |
| `workspace.test` | medium | no | sandbox | Run an allowlisted npm script in the sandbox |
| `workspace.write` | high | yes | host-bounded | Atomically write one UTF-8 file after application path checks and approval |
| `workspace.patch` | high | yes | host-bounded | Replace an exact text fragment with an expected match count |

Workspace paths are relative to `AXIOM_AGENT_WORKSPACE_ROOT`. Absolute paths, `..` traversal, and paths outside the root are rejected. Write operations use a temporary file and rename, so a partial file is not exposed.

## MCP 与 OpenAPI 能力目录

项目空间可以按租户保存 OpenAPI 3.x 文档和 HTTP MCP endpoint。MCP 可以导入固定 `tools` 目录，也可以在保存前执行 `initialize` 与 `tools/list` 发现；可执行 shell 配置会被拒绝。每份 specification 都保存 SHA-256 和固定版本，服务重启会在任务接收前恢复仍然可用的工具源。

导入时会根据名称、说明和 operation 推导办公、研究、开发、业务、内容、运维、数据或自定义分类与能力关键词，并执行轻量健康探测。OpenAPI 使用 HEAD 连通性检查，MCP 使用真实 `initialize` 和 `tools/list`。页面可以手动重新检查；异常状态会保存在工具源记录中并阻止注册。为兼容 v2.0.0，旧记录在首次手动探测前按可用处理。

外部工具不会全量注入每个模型请求。Orchestrator 调用 `catalogForTask()`，按下面顺序筛选：

1. 当前租户中的工具必须启用、健康且不处于待授权状态。
2. 当前 Agent 必须在工具源 allowlist 中；显式指定也不能绕过权限。
3. 工具名、说明、分类和关键词必须与本轮输入及 Agent 目标相关。
4. 候选按相关度、历史成功率、探测延迟和来源风险排序。
5. 每个步骤只注入 Top-K 外部工具，默认 `AXIOM_EXTERNAL_TOOL_TOP_K=6`，运行时硬上限为 12。

因此平台适合接入多元 MCP，但不应给所有用户“一键全开大量 MCP”。当前目录提供开发与代码、研究与论文、办公协作、数据分析、内容创作、运维观测和企业业务七类能力包；前四类默认启用，其余按租户开启。用户的显式停用会持久化。运行时先按租户与能力包过滤，再按任务挑选少量操作，从而控制工具 schema Token、路由误选、第三方故障和权限风险。

动态操作不会由 UI 直接调用外部地址。模型原生工具调用仍进入 `ToolRegistry.execute()`，继续经过 Agent allowlist、JSON schema、SSRF、配额、超时、任务审批、持久审计和 Artifact lineage。本地 endpoint 必须显式使用 `location=local`，仍受地址校验约束。

当前版本不会把 API Key、OAuth Token 或服务账号 Secret 写入 specification。通用认证型 MCP/OpenAPI 仍会保存为“待授权”和禁用，直到完成 API Key 注入代理或 OAuth 2 授权。飞书是首个例外连接器：App ID/App Secret 进入独立的加密凭据仓库，工具源只保存不可逆的凭据引用；只有真实获得 `tenant_access_token` 后才注册工具。飞书 Secret 和短期 token 都不会进入 specification、日志、模型上下文或 API 响应。

飞书当前提供 `feishu.read_document`、`feishu.list_calendars`、`feishu.list_messages` 和 `feishu.send_message`。前三项为中风险读取；发送消息为高风险写操作，首次请求只创建与任务、步骤、参数签名绑定的人工审批，不会直接外发。当前身份模式是企业自建应用的服务账号，不是用户 OAuth。

GitHub 公共仓库网页、README 和公开文件无需 Key。匿名 REST API 额度较低，常见为同一 IP 每小时 60 次；高频结构化读取建议使用 Token。私有仓库必须授权，团队部署建议使用只授予 `Metadata: Read`、`Contents: Read` 及必要 Issue/PR 只读权限的 GitHub App。Axiom 当前可以通过 DeepSeek 原生搜索研究公开项目；GitHub App/Token 连接器属于后续能力。

`workspace.patch` deliberately uses exact text replacement rather than a shell patch command. The caller must provide `expectedMatches` (default `1`); a mismatch fails the tool without changing the file.

## Approval flow

High and critical risk tools never execute on the first request. The runtime persists a `ToolApproval` on the task, emits `tool.approval_requested`, and moves the task to `waiting_for_human`. The operator can then call:

```text
POST /api/tasks/:taskId/approve-tool
POST /api/tasks/:taskId/reject-tool
GET  /api/tasks/:taskId/tools/audit
GET  /api/runtime/tools
```

Approval is bound to a task, step, tool name, and canonical argument signature. If the model changes the path or content after approval, it produces a new approval request. Only the task owner, tenant owner, or tenant admin can decide the request.

Approved writes resume from the persisted checkpoint. A rejected write leaves the task paused and records the operator note. `tool.started`, `tool.completed`, `tool.failed`, approval events, and Artifact references are replayable through the same SSE stream as model work.

## Limits and audit

- `AXIOM_TOOL_MAX_CALLS_PER_TASK` limits calls per task in a rolling one-hour window; the default is `8`.
- `AXIOM_EXTERNAL_TOOL_TOP_K` limits task-relevant external MCP/OpenAPI operations exposed to one Agent step; the default is `6` and the hard maximum is `12`.
- `AXIOM_INTEGRATION_SECRET` encrypts Feishu and future integration credentials with AES-256-GCM; if omitted, the runtime falls back to `AXIOM_PROVIDER_SECRET`.
- `AXIOM_TOOL_TIMEOUT_MS` can lower the per-tool timeout; each tool also has a local upper bound.
- `AXIOM_TOOL_ALLOWED_NPM_SCRIPTS` controls `workspace.test`; the default allowlist is `test,check,build,qa:routing,qa:business,qa:runtime`.
- Tool output is capped before it is included in model context.
- Tool output Artifacts carry `taskId`, `stepId`, and `toolCallId` lineage, plus the audit ID, risk, signature, exit code, and output byte count.
- `database.query` uses `AXIOM_READONLY_DATABASE_URL` (falling back to `DATABASE_URL`), starts a `READ ONLY` transaction, rejects multiple statements and all non-read-only verbs, and caps returned rows.
- `http.fetch` and `browser.open` default to disabled until `AXIOM_HTTP_ALLOWLIST` contains an exact host or `*.example.com` suffix. Loopback, RFC1918, link-local, unique-local, IPv4-mapped private IPv6, cloud metadata IPs/hostnames, and redirects are rejected. DNS-level egress policy remains a deployment concern.
- `document.read` and `table.read` never invoke a shell command and validate extensions before reading relative paths.

## Execution boundaries

Every tool call must pass the Docker execution gate (`AXIOM_TOOL_EXECUTOR=docker`). Command-backed tools run inside `DockerSandboxExecutor` with `--network=none`, a read-only root filesystem, dropped capabilities, resource limits, and only the configured workspace mounted read-write. Handler-backed tools are explicitly marked `host-bounded`: they use bounded application APIs for atomic file writes, read-only database transactions, and allowlisted HTTP, but are not inside the container. The registry catalog exposes this boundary so operators and the Readiness endpoint cannot mistake application-layer controls for container isolation.

The current audit endpoint is derived from durable task events. The in-process registry also keeps a bounded recent audit buffer for diagnostics; it is not the source of truth.
