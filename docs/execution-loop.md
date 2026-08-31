# Execution Loop

This document describes the production execution contract now implemented by the runtime.

## Lifecycle

```text
Task -> Triage -> Planner -> (optional human approval)
     -> dependency-ready steps -> checkpoint
     -> Builder tool calls -> tool artifacts/evidence
     -> Reviewer + Memory recall -> correction loop
     -> Synthesizer -> result artifact
```

Every transition is persisted as a versioned task event and replayed through SSE. A worker lease can expire without losing the task: the next worker resumes from `stepResults` and the last checkpoint.

`POST /api/tasks` accepts an optional `Idempotency-Key` header. Webhook triggers require one. The key is stored per tenant and returns the original task when a delivery is retried, so network retries do not create duplicate work. Scheduled triggers use a deterministic key for each scheduled occurrence.

Webhook requests are authenticated over the exact UTF-8 request body and their delivery identity. Clients send `X-Axiom-Webhook-Timestamp` as Unix seconds and `X-Axiom-Webhook-Signature` as `v1=<hex HMAC-SHA256>`. The signed bytes are the newline-joined values `v1`, timestamp, idempotency key, resolved tenant id, resolved user id, and the raw JSON body. Requests outside the default five-minute window are rejected; `AXIOM_WEBHOOK_TOLERANCE_SECONDS` can set a 30-3600 second window. Because tenant/user headers and the delivery key are signed, a captured request cannot be redirected to another tenant, and a valid retry resolves to the original durable task.

## Human controls

The task API exposes:

```text
POST /api/tasks/:taskId/approve-plan
POST /api/tasks/:taskId/reject-plan
POST /api/tasks/:taskId/replan
POST /api/tasks/:taskId/nodes/:nodeId/retry
POST /api/tasks/:taskId/nodes/:nodeId/rerun
POST /api/tasks/:taskId/nodes/:nodeId/skip
POST /api/tasks/:taskId/nodes/:nodeId/complete
```

`retry` clears the selected node and its descendants. `rerun` has the same invalidation semantics but is intended for an explicit operator rerun. `skip` and `complete` add an operator-authored `StepResult` so the dependency graph can continue without pretending that a model run happened.

## Graph, Loop, and collaboration

The right-side monitor has three views:

- `Topology` shows the live runtime actors and is useful for a quick health check.
- `Graph` shows the dependency graph produced by the Planner. It is populated for `team` and `full-workflow` routes; a `direct` route intentionally shows `Direct Response` and no dependency graph.
- `Collaboration` is the operator control surface. While a task is running, a note is persisted as `human.note` and becomes context for a later Loop iteration. Pausing saves a checkpoint; the same panel can accept a note while paused and then resume from that checkpoint.

Select a Graph node to inspect its role, dependencies, attempts, confidence, evidence, tool artifacts, and output. `Retry` invalidates the node and descendants, `Rerun` explicitly re-executes from that node, `Skip` records an operator decision and advances dependents, and `Manual complete` records an operator-authored result. These actions are persisted and replayed through the same SSE event stream as model work.

When plan approval is enabled, the task pauses after planning. Use the collaboration note field to add constraints, then approve, reject, or replan. A rejection does not silently execute the old plan.

## Token telemetry

Every server-side model call emits `model.completed` with prompt, completion, total, duration, and cumulative usage. The console aggregates these events and de-duplicates replayed events when a paused task resumes or a browser reconnects. A custom browser-side provider reports its final usage directly. `统计中` means the run has not emitted a usage event yet; `未返回` means the provider did not return token usage, rather than a zero-token execution.

## Operations snapshot

`GET /api/runtime/operations?hours=24` returns a tenant-scoped operational view built from durable `tasks` and `task_events` records. It includes active and expired Worker leases, queue depth by lifecycle state, model calls/latency/tokens/cost and event-derived health, tool failure distribution, Agent success rates, Reviewer approval and human-takeover counts, and terminal-task success plus P50/P95 duration. The window can be 1-168 hours and defaults to 24. The Dashboard's `运行观测` page polls this endpoint every 20 seconds; it does not use browser timers to invent task or Worker state.

## Tool Registry

The built-in registry is intentionally small and auditable:

- `workspace.search` -> allowlisted `rg`
- `workspace.read` -> `cat`
- `workspace.git-status` -> read-only `git status --short`
- `workspace.test` -> allowlisted `npm run <script>`

Builder agents can request up to four schema-validated calls. Calls execute only when `AXIOM_TOOL_EXECUTOR=docker`, through the no-network Docker sandbox. Each call emits `tool.started`, `tool.completed` or `tool.failed`, carries an audit id, and writes a Markdown tool-output Artifact when storage is configured. `AXIOM_OBJECT_STORAGE_ENDPOINT` enables the S3-compatible adapter for AWS S3, MinIO, or Tencent COS; `AXIOM_OBJECT_STORAGE_PATH` is the local single-node fallback. S3 and local object keys now include the task tenant scope (`prefix/<tenant>/<artifact>`); reads temporarily fall back to legacy unscoped keys for migration, while tenant-scoped deletes remove only the current tenant key to prevent cross-tenant deletion. An Artifact write failure is recorded on the completed tool event without converting an already executed tool into a retryable tool failure.

Final result Artifacts are written before the task enters a terminal state, so another Worker can read the object as soon as it observes completion. Deleting a terminal task or its owning conversation snapshots Artifact references before database cascade deletion, then removes the result and event-linked objects on a best-effort basis. Provider outages do not hide the durable database result or prevent the user from deleting task history.

## Plan policy and budgets

Tasks accept an optional execution policy:

```json
{
  "requirePlanApproval": true,
  "maxTokens": 120000,
  "maxCostUsd": 5,
  "maxDurationMs": 900000,
  "maxConcurrentSteps": 3
}
```

Model calls emit `model.completed` with a stage, span id, attempts, duration, token usage and estimated cost. The runtime restores model observations from durable task events on startup and scores configured candidates by task kind, Agent role, success rate, latency and cost. Set `AXIOM_MODEL_COSTS` to add optional `kinds` and `roles` affinity metadata. `budget.exceeded` is emitted before execution continues past a configured token or cost limit.

## Evidence and lineage

`StepResult` records evidence, confidence, attempts, duration, tool calls and Artifact references. Reviewer input includes the full evidence tree plus available MemoryCore context. Artifact events include task, step and tool-call lineage so a result can be traced back to the execution that produced it.

## Remaining deployment work

The execution contract is complete for a local or controlled single-node deployment. Multi-instance production still requires a durable scheduler queue, external object storage, tenant principal signing, MemoryCore configuration, and OpenTelemetry export. These are reported by `/api/runtime/readiness` rather than hidden behind a green status.
