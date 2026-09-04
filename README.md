# ✦ Axiom Agent Control Room

**English** | [简体中文](README.zh-CN.md)

> Give Axiom one goal. It decides how difficult the work is, assigns only the Agents that are needed, shows their progress, and checks the result before delivery.

Current source version: **v2.3.0-rc.5** (bilingual interface and intranet enterprise release candidate)

![Axiom Control Room](docs/images/overview.png)

## 🌌 What is Axiom?

Axiom is an open-source control room for real Agent work. You do not need to learn workflow diagrams or configure a large team before asking for something. Start with a normal request:

```text
Research several open-source Agent projects, compare their strengths and risks,
then prepare a report I can share with my team.
```

Axiom can turn that request into a tracked execution:

```text
Understand → Route → Assign Agents → Run in parallel → Review → Deliver
```

Simple questions stay simple. Research, file analysis, image generation, tool use, or quality review adds the relevant Agent only when the current turn needs it.

The interface opens in English by default. Use the language control in the upper-right corner to switch to Simplified Chinese; the selection is remembered after refresh.

## 🏆 Why use it?

- 🚦 **Work is routed by difficulty.** A short question does not pay the latency and Token cost of a full multi-Agent workflow.
- 🧭 **Every turn is reconsidered.** A follow-up can skip old Agents, reuse verified work, or bring a new Agent into the Graph.
- ⚡ **Independent work runs in parallel.** Research, analysis, and building do not wait in one long serial queue when they have no dependency.
- ✅ **Delivery has a gate.** Reviewer findings, evidence gaps, and human approval are part of the durable run, not decorative UI states.
- 🔄 **Interrupted work can recover.** Tasks, events, leases, checkpoints, approvals, and SSE cursors survive refreshes and Worker restarts.
- 👀 **The Graph reflects execution.** Agent Graph and runtime events come from the task state that is actually running.
- 🔌 **Models are replaceable.** DeepSeek is the default; text, vision, image, and video providers can be configured separately.
- 🛡️ **Risky actions pause first.** File writes, publishing, and other high-impact tool calls can require explicit human approval.

## 🧩 What is included?

| Area | What you can do | Requirement |
| --- | --- | --- |
| Chat and files | Stream answers over SSE; analyze images, Markdown, text, Word, PDF, SVG, and HTML | Text model; vision model for image understanding |
| Live research | Research news, papers, GitHub repositories, and time-sensitive facts while retaining sources | DeepSeek native search |
| Multi-Agent work | Route each turn through Router Agent and Scheduler Agent, then run a dynamic DAG | Built in |
| Human collaboration | Guide, pause, resume, cancel, review, retry, branch, merge, or rerun an Agent | Built in |
| Agent Nexus | Build reusable Agent flows with conditions, parallel paths, multiple Loops, nested Loops, and local reruns | Built in |
| Plugin Mini Apps | Create, edit, preview, review, publish, sign, install, roll back, and withdraw plugins | Built in; external tools follow permissions |
| Media and reports | Generate or edit images; reserve a video Agent; export Markdown, Word, LaTeX, or PDF reports | Configure the matching provider |
| Projects and schedules | Organize work, members, reviews, decisions, memory, and Agent-powered schedules | Built in |
| Tools and capability packs | Use custom Agents, templates, MCP/OpenAPI tools, and seven scoped capability packs | Credentials required for authenticated services |
| Feishu collaboration | Read documents, calendars, and group messages; send messages after approval | Feishu custom app |
| Recovery and operations | Inspect Token usage, cost, queue wait, leases, model/tool health, alerts, Artifacts, and delivery evidence | Built in; external backends are optional |

An integration shown in the UI is not automatically considered healthy. The system status panel probes the active model, database, sandbox, memory, storage, and optional services. Missing dependencies are shown as degraded or unavailable.

## 🔁 How a task runs

```text
User request
  ↓
Router Agent: intent, difficulty, capabilities, and route
  ↓
Scheduler Agent: Agents, Skills, dependencies, and parallel waves
  ↓
Researcher / Analyst / Builder / controlled tools
  ↓
Reviewer: evidence, consistency, risk, and acceptance criteria
  ↓
Synthesizer: verified results only
  ↓
Final answer, report, Artifact, or follow-up action
```

Long tasks use structured handoffs and Artifact references instead of repeatedly placing every intermediate result into the model context. A user can add guidance while work is running; Axiom applies it at the next safe execution point without creating a duplicate task.

## 🪟 Product views

### 🛰️ Control Room

![Task overview](docs/images/overview.png)

See active work, daily progress, real task dependencies, delivery state, Token trends, and the current 3D Agent scene in one workspace.

### 💬 Chat and Agent Graph

![Chat and Agent Graph](docs/images/conversation.png)

Use Axiom like a normal conversation while the route, active Agents, Skills, tools, retries, and review state remain inspectable. Open any Agent to see its actual upstream context and runtime status.

### 🔗 Agent Nexus

![Agent Nexus](docs/images/agent-nexus.png)

Connect Agents into a reusable flow with branches and Loops. Test a draft, publish an immutable release, compare versions, restore a previous release as a new draft, or rerun only the affected Agent.

### 🧩 Plugin Mini Apps

![Plugin center](docs/images/plugins.png)

Create a small tool with an Agent, keep editable versions, review requested permissions, and publish it to a controlled team market. Installed releases stay pinned until the user explicitly upgrades them.

### ⚙️ Model configuration

![Model settings](docs/images/settings.png)

Use the default DeepSeek service or configure OpenAI-compatible local and Internet APIs. Text, vision, image, and video services are independent.

## 🚀 Quick start

### 1. Install

Requirements:

- Node.js 22 or later
- Docker for sandboxed tools and the complete local production gate

```bash
git clone https://gitee.com/water-sim/axiom-agent-control-room.git
cd axiom-agent-control-room
npm install
```

For isolated tool execution:

```bash
docker pull ubuntu:22.04
```

### 2. Configure a model

```bash
cp .env.example .env.local
```

Windows PowerShell:

```powershell
Copy-Item .env.example .env.local
```

Add your own key to `.env.local`:

```dotenv
DEEPSEEK_API_KEY=replace-with-your-key
```

No working model key is committed to this repository. `.env.local` is ignored by Git.

### 3. Run

```bash
npm run dev
```

- Web UI: <http://127.0.0.1:4300>
- API: <http://127.0.0.1:8787>

Local development uses SQLite and creates its database under `.data/` automatically.

## 🐘 PostgreSQL and production build

Start the provided local database:

```bash
docker compose -f docker-compose.local.yml up -d postgres
```

Set a connection string in `.env.local`:

```dotenv
DATABASE_URL=postgresql://postgres:change-me@127.0.0.1:5432/axiom
```

Build, migrate, and run the single-service deployment:

```bash
npm run build
npm run db:migrate
npm start
```

The production Hono service exposes both the API and the built frontend at <http://127.0.0.1:8787>. Use PostgreSQL for multiple Workers, durable scheduling, and controlled production deployments.

## 📦 Capability packs and Feishu

The Projects → Capabilities view groups external tools into Development, Research, Office, Data, Content, Operations, and Business packs. The Router sees only enabled packs, then filters by tenant, Agent permission, authentication, health, relevance, and Top-K limits.

To connect Feishu, create an enterprise custom app and provide its `App ID` and `App Secret`. Grant only the document, calendar, group-message, and send permissions the deployment needs. Read operations can run directly; sending a message remains a high-risk action that waits for approval.

Public GitHub pages and files can be read without a key, but anonymous API limits are low. Prefer a read-only GitHub App for stable team use and for private repositories. Write permissions should be separate and continue through human approval.

## 🧪 Quality gates

```bash
npm run check                 # TypeScript checks for web and server
npm test                      # Unit and runtime tests
npm run build                 # Production web and server build
npm run qa:i18n               # English default and Chinese switch regression
npm run qa:visual             # Desktop and mobile visual regression
npm run qa:business           # Segmented business-flow evaluation
npm run qa:mcp-business       # 30 P0 + 10 P1 Fake MCP cases
npm run qa:object-storage:local
npm run qa:postgres:local
npm run qa:all:local          # PostgreSQL + MinIO local release gate
```

Latest `v2.3.0-rc.5` baseline on 2026-09-04:

```text
npm run check          passed
npm test               433 tests / 432 passed / 0 failed / 1 skipped
npm run build          passed
npm run qa:mcp-business
                       40 passed / 0 failed
npm run qa:all:local   33 passed / 0 failed / 3 skipped
```

All 33 runnable gates passed on their first attempt. The three skipped live checks require deployment-specific TencentDB MemoryCore and Harness/Codex sidecar configuration. A skipped external check is not reported as passed.

## 📈 Local API baseline

Measured on one Windows node with 25 concurrent clients and 200 requests per endpoint. These figures measure Axiom's API, scheduler, and database path; they do not include model generation or Internet latency.

| Endpoint | Throughput | P95 latency |
| --- | ---: | ---: |
| Health | 2,030.49 req/s | 21.38 ms |
| Readiness | 2,493.75 req/s | 11.77 ms |
| Task list | 2,596.16 req/s | 14.78 ms |
| Runtime operations | 1,156.45 req/s | 34.40 ms |

Run `npm run perf:smoke` to measure your own environment.

## 🔌 Optional integrations

| Capability | Main configuration | Purpose |
| --- | --- | --- |
| Text model | `DEEPSEEK_API_KEY`, `DEEPSEEK_API_BASE`, `DEEPSEEK_MODEL` | Chat and Agent execution |
| Vision model | `DEEPSEEK_VISION_*` | Image and visual document analysis |
| Native search | `DEEPSEEK_NATIVE_SEARCH`, `DEEPSEEK_NATIVE_SEARCH_MODEL` | Time-sensitive research with sources |
| Image generation | `DMX_API_KEY`, `DMX_BASE_URL`, `DMX_MODEL` | Image generation and editing |
| Video | `VIDEO_API_BASE`, `VIDEO_API_KEY`, `VIDEO_MODEL` | Local or compatible video service |
| Long-term memory | `TDAI_MEMORY_ENDPOINT`, `TDAI_MEMORY_API_KEY` | Optional MemoryCore L0-L3 adapter |
| External Agent runtime | `DEEPSEEK_HARNESS_*`, `CODEX_APP_SERVER_*` | Harness or Codex sidecar |
| MCP governance | `AXIOM_EXTERNAL_TOOL_TOP_K`, `AXIOM_MCP_CALL_TIMEOUT_MS` | Tool selection and timeout |
| Artifact storage | `AXIOM_OBJECT_STORAGE_*` | S3, COS, or MinIO storage |
| Integration encryption | `AXIOM_INTEGRATION_SECRET` | Encrypt Feishu and MCP credentials |
| Outbound notifications | `AXIOM_NOTIFICATION_SECRET` | Signed Webhook delivery and retry audit |

See [`.env.example`](.env.example) for every setting and its operational boundary.

## 🛡️ Production boundary

This repository is a local or controlled-intranet production candidate. It is not a public multi-tenant SaaS that becomes secure merely by opening port `8787`.

Before an Internet-facing deployment:

- Use PostgreSQL instead of SQLite.
- Enforce OIDC or identity from a trusted reverse proxy.
- Store model and integration secrets in a Secret Manager.
- Enable HTTPS, rate limits, centralized logs, backup, and external Artifact storage.
- Validate the Docker sandbox, MemoryCore, target S3/COS/MinIO, Harness/Codex sidecar, and multiple Workers in the target environment.

See [Launch readiness](docs/launch-readiness.md) for the exact remaining checks.

## 📚 Documentation

- [Execution loop](docs/execution-loop.md)
- [Agent Nexus control flow](docs/agent-nexus-control-flow.md)
- [Tool Registry and MCP safety](docs/tool-registry.md)
- [Business capabilities V2](docs/business-capabilities-v2.md)
- [Context windows and durable summaries](docs/context-window.md)
- [MemoryCore integration](docs/memorycore-integration.md)
- [Harness adapters](docs/harness-adapters.md)
- [Runtime business evaluation](docs/runtime-business-evaluation.md)
- [Upgrade roadmap](docs/upgrade-roadmap.md)
- [Release history](CHANGELOG.md)

Most detailed engineering documents are currently written in Simplified Chinese. Their commands, API names, and configuration keys are language-independent.

## 📄 License

Axiom Agent Control Room is available under the [MIT License](LICENSE). Configure your own model services and validate your own production environment.

## 🙌 Contributing

Issues, documentation improvements, and pull requests are welcome. Changes to Agent execution, security boundaries, recovery, or tenant isolation should include focused tests or a reproducible regression script.
