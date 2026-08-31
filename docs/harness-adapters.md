# Harness Adapter Contract

`agent-control-room` treats an external agent harness as an optional execution
provider. The built-in `WorkflowOrchestrator` remains authoritative until a
provider passes a capability handshake and an explicit transport adapter is
enabled.

## Reference baselines

- DeepSeek Harness `0.1.0-rc.8`: event-sourced sessions, per-session Agent
  Presets, provider lifecycle events, queue/steering, and durable session
  restore.
- OpenAI Codex app-server (`codex-main.zip`): thread/turn/item lifecycle,
  JSON-RPC control, parent/child Agent Graph edges, multi-agent tools,
  approvals, permission profiles, and sandbox policy.

These projects are reference runtimes. Their source trees are not imported into
the TypeScript service and their events never bypass the TaskStore boundary.

## Adapter boundary

The contract is defined in `server/runtime/harness.ts`:

- `handshake()` returns protocol, version, capabilities, and activation state.
- `startThread()` and `startTurn()` establish external identity mapping.
- `resume()`, `interrupt()`, `approve()`, and `steer()` are explicit control
  operations.
- `subscribe()` is an ordered external event stream with a caller-provided
  replay cursor.

`BuiltinHarnessAdapter` exposes the same identity surface but reports that the
orchestrator is authoritative. It deliberately returns `accepted: false` for
remote control commands; this prevents a local adapter from pretending that an
external Harness executed an operation.

`DeepSeekHarnessClient` performs capability discovery through the configured
HTTP endpoint when present. The adapter also supports the actual DeepSeek
Harness rc.8 transport: ACP JSON-RPC over a non-shell stdio sidecar. It is
still opt-in and remains inactive unless all of the following are true:

- `DEEPSEEK_HARNESS_COMMAND_JSON` (a JSON string array such as
  `["node","path/to/acp-server.mjs"]`) or `DEEPSEEK_HARNESS_COMMAND` is set;
- the sidecar answers `initialize` with protocol version `1` and identifies as
  `deepseek-harness-acp` (an absent name is accepted for compatible ACP test
  servers);
- `DEEPSEEK_HARNESS_ACTIVE=true` is set explicitly.

The stdio adapter maps `session/new`, `session/prompt`, `session/cancel`,
`session/update`, and one-shot `session/request_permission` messages into the
provider-neutral Harness events. It keeps per-session queues and replay
cursors, bounds retained events, rejects shell execution, and closes the
sidecar on transport failure. Unsupported optional commands (`resume` or
`steer`) return an explicit unavailable result instead of pretending that the
remote runtime executed them. The built-in orchestrator remains authoritative
until a caller deliberately constructs and activates this adapter.

`HarnessTaskBridge` is the explicit task delegation boundary. It is wired into
the task API but remains inactive unless the adapter passes the handshake and
`DEEPSEEK_HARNESS_ACTIVE=true` is set. To avoid a double execution race, only a
paused task can be delegated. The bridge persists `harness.connected`, all
mapped external lifecycle/delta events, and a terminal `task.completed`,
`task.failed`, or `task.paused` event through `TaskStore`; the existing SSE
endpoint therefore remains the single replay source. External event identities
are checked against the task and deduplicated before persistence. Resuming a
sidecar thread additionally requires a previously persisted thread binding for
the same task, preventing cross-task thread attachment.

The opt-in endpoints are:

```text
POST /api/tasks/:taskId/harness/start
POST /api/tasks/:taskId/harness/resume
POST /api/tasks/:taskId/harness/interrupt
```

They require the task owner or tenant administrator. The start and resume
operations return `202` only after the external Thread/Turn command has been
accepted. A missing, inactive, or incompatible sidecar returns `503` so
clients may retry after configuration or reconnection; task-state conflicts
(for example delegating a running task) return `409`. The gateway never
silently falls back to a different execution path.

## Event mapping

External identity is preserved in the `RuntimeEvent.payload.harness` object:

```text
HarnessEvent
  -> threadId / turnId / itemId / externalSequence
  -> harnessEventToRuntimeEvent()
  -> TaskStore.appendEvent()   (new tenant-scoped sequence)
  -> EventHub -> SSE -> UI
```

Model and reasoning deltas map to `model.delta`; tool lifecycle maps to the
existing `tool.*` events. Thread, turn, item, collaboration, queue, and
approval lifecycle events retain their own explicit RuntimeEvent types so the
UI and audit stream do not collapse distinct boundaries into a generic status.

`HarnessEventDeduper` rejects replayed `(threadId, eventId, sequence)` tuples and
keeps a bounded FIFO window. The external sequence is metadata, not the local
ordering authority.

## Activation rules

An external adapter must satisfy all of these conditions before execution is
delegated:

1. The advertised protocol is an exact supported version.
2. Required capabilities include turn control, ordered events, and a replay
   cursor.
3. Workspace, approval, tenant, and task identities are bound by the gateway.
4. External event IDs are deduplicated before persistence.
5. A claimed completion has a durable RuntimeEvent and, where applicable, an
   Artifact or review result.
6. Disconnects leave the task recoverable and do not silently switch execution
   semantics.

## Remaining integration work

- DeepSeek ACP/HTTP session and event transport. ACP JSON-RPC stdio and the
  opt-in TaskStore/SSE delegation bridge are implemented behind the explicit
  sidecar activation gate; a native HTTP transport still requires the
  provider's stable wire contract.
- Codex app-server JSON-RPC stdio/sidecar transport.
- Persisted parent/child thread edges with open/closed status.
- Approval replay, Artifact lineage, failure-compensation integration tests, and
  cross-restart sidecar verification against a real Harness remain pending.
