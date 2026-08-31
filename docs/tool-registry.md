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
