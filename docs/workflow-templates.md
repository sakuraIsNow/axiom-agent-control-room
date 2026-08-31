# Workflow Templates

Workflow templates are durable, tenant-scoped execution recipes. They are stored in the same persistence backend as tasks: PostgreSQL in production, or the local SQLite database for single-node development. A template is private by default; `team` visibility makes it executable by other members of the same tenant.

## Lifecycle

1. `POST /api/tasks/:taskId/template` saves a completed or in-progress task as a draft. The definition captures the selected model, mode, policy, plan, agent roles, and observed tools.
2. `POST /api/templates/:templateId/publish` makes the current version executable.
3. `PATCH /api/templates/:templateId` creates a new version when the definition changes. The previous definition is retained in the bounded history list.
4. `POST /api/templates/:templateId/rollback` restores a previous history version as a new draft version. It must be reviewed and published again.
5. `POST /api/templates/:templateId/archive` prevents further edits or task creation while retaining the audit record.
6. `GET /api/templates/:templateId/export` downloads a versioned JSON bundle without tenant credentials or private history.
7. `POST /api/templates/import` imports a bundle as a new private draft. Imported templates never become executable or team-visible automatically.
8. `POST /api/templates/:templateId/share` and `/unshare` change team visibility. Only the owner or tenant administrator can change sharing, publish, archive, edit, or roll back a template.

The workspace also exposes `GET /api/template-catalog` and `POST /api/templates/from-catalog` for the built-in code review, architecture evaluation, incident analysis, and research report starters. The UI exposes these actions from **工作流模板** in the runtime card.

Only published templates can be used by `POST /api/tasks` with a `templateId`. Private templates can only be used by their creator or a tenant owner/administrator; team templates can be used by tenant members. The task stores the template id, model, policy, prompt prefix, and optional validated plan so a retry or worker handoff can recover the same execution contract.

## Definition shape

```json
{
  "mode": "build",
  "model": "deepseek-chat",
  "policy": {
    "requirePlanApproval": true,
    "maxTokens": 50000,
    "maxConcurrentSteps": 3
  },
  "agentIds": ["researcher", "builder", "reviewer"],
  "toolNames": ["workspace.test"],
  "promptPrefix": "Use evidence and show verification steps."
}
```

The API validates plan steps and bounds agent/tool lists before writing them. Tenant identity comes from the signed principal or the local development headers; template reads and writes never cross tenant boundaries.

When a Planner creates a task plan, each step can also carry `model`, `toolNames`, `maxTokens`, `maxDurationMs`, and `failureStrategy` (`retry`, `skip`, or `pause`). The runtime emits these values with `agent.spawned`, restricts builder tool calls to the step allowlist, passes the model and token ceiling to compatible providers, and enforces the duration with a step-scoped abort signal. Template definitions retain the validated plan so resumed workers use the same step contract.

## Export bundle

```json
{
  "schemaVersion": 1,
  "exportedAt": "2026-08-21T00:00:00.000Z",
  "template": {
    "name": "Architecture evaluation",
    "description": "Compare production trade-offs.",
    "definition": {
      "mode": "decide",
      "policy": { "requirePlanApproval": false },
      "agentIds": ["researcher", "analyst", "reviewer"],
      "toolNames": ["workspace.search", "workspace.read"]
    }
  },
  "source": { "templateId": "...", "version": 2 }
}
```

`source` is informational only. Import creates a new id, draft status, current tenant ownership, and private visibility.
