# ✦ Axiom Agent Control Room

**English** | [简体中文](README.zh-CN.md)

> A workspace for asking questions, researching topics, creating content, and building reusable Agent tools. See who is working, follow the result, and step in when a decision is needed.

**Version: v2.3.0-rc.8** · [Release notes](CHANGELOG.md) · [Upgrade guide](docs/migration-v2.3.md)

[GitHub](https://github.com/sakuraIsNow/axiom-agent-control-room) · [Gitee](https://gitee.com/water-sim/axiom-agent-control-room)

![Axiom Control Room](docs/images/overview.png)

## 🌌 What is Axiom?

Axiom is an open-source control room for real Agent work. You do not need to learn workflow diagrams or configure a large team before asking for something. Start with a normal request:

```text
Read these documents, check the latest information, compare the options,
and prepare a report I can share with my team.
```

Axiom routes the work, assigns relevant Agents, and keeps the result connected to its sources and execution history. Simple questions stay simple; more involved requests can add research, file analysis, media generation, tools, and quality review.

The interface opens in English by default. Use the language control in the upper-right corner to switch to Simplified Chinese; the selection is remembered after refresh.

### ✨ What is new in rc.8?

- 🌱 **Learn from finished work.** Ask an Agent to review a task and suggest a better approach. Keep a suggestion, edit a new chat draft, and decide whether to try it—nothing changes behind your back.
- 🎨 **Create a shareable SVG or HTML without an unnecessary approval detour.** Standalone files are saved as task Artifacts; changing project files still follows the existing permission and approval rules.
- 🪟 **Keep interactive previews steady.** Scrolling, typing, and later streamed text no longer restart an unchanged HTML/SVG preview or reset a playing video. You can still copy or download the result.

This release builds on the existing Chat, Agent Graph, Nexus, and Mini Apps. It does not replace their execution logic or claim that model-generated suggestions are proven improvements.

### 🔬 Next-iteration development (after rc.8)

- **Try Jev for bounded Agent and Skill decisions without losing the original route.** Optional shadow and hybrid modes retain the configured text-model Scheduler and fall back to the original Router on uncertainty or errors. Text, search, vision, and media models stay unchanged. Recognized local model endpoints bypass this cloud service; private model hostnames can be declared explicitly. This is an experimental integration, not a universal accuracy or speed claim. See [configuration, rollback, and actual test results](docs/jev-routing-integration-20260921.md).
- **Check complex answers against what you actually asked for.** A source-grounded requirement list is checked against the final answer, with at most one text-only revision. Completed tools are not replayed. Unresolved work stays as a draft you can clarify or explicitly accept as partial. Chat, tasks, Nexus, and Mini Apps share the same expandable delivery checks and real progress. Changed requirements invalidate earlier acceptance; ordinary chats keep their shorter path. Model review is not a guarantee of factual accuracy. See the [implementation and test record](docs/final-delivery-verification-20260921.md).
- **Recompute declared numerical results.** Source-bound arithmetic checks compare JSON fields with server-calculated values, even when the review model approves a wrong number. This covers declared addition, subtraction, multiplication, and division, not arbitrary mathematical proofs or external truth.
- **More reliable Agent assignments.** Router and Scheduler distinguish registered Skills from descriptive labels, validate their plan, and share one bounded correction attempt. Diagnostics separate a successful model response from a valid plan, including correction time and Token usage.
- **Compare a suggestion before trying it.** Task improvements can run the same model on five independent fixed text scenarios, with and without the suggestion. Inspect checks, outputs, time and Token usage, stop a comparison, and return to its saved history.
- **Resume unfinished work, keep completed work.** A service interruption no longer records the active Agent as a completed failure, so recovery can continue from saved results without repeating finished steps.
- **Less scheduling for genuinely simple chats.** A high-confidence, validated first-turn conversation may use just the Router. Attachments, prior context, corrections, and complex tasks retain the full scheduling path.
- **Check the deliverable, not only the route.** A new 24-case local suite checks documents, reports, files, Mini App versions, Nexus, and recovery. Secret-free CI reports flaky retries as failures, and an optional, bounded live-model suite preserves every observation. See the [scope and evidence](docs/business-delivery-closure-20260921.md).

Comparisons use synthetic evidence and simulated contracts—not live search, real plugin changes, or Nexus execution. A better score only applies to those cases; no suggestion is automatically applied. Account login and private spaces are not included in this batch. The published version above remains rc.8 until the next release is finalized.

## 🏆 Why use it?

- 🚦 **Use the team the task needs.** Each turn is routed by difficulty. A follow-up can reuse work, skip unneeded Agents, or add a new specialist.
- ⚡ **Work in parallel when possible.** Independent research, analysis, and building can run together instead of waiting in one queue.
- 👀 **See actual progress.** Agent Graph shows the Agents and tools involved in the real execution, with results and review status available to inspect.
- 🔄 **Continue after an interruption.** Saved task state and execution receipts support recovery after refreshes or Worker restarts without blindly repeating uncertain actions.
- 🛡️ **Keep important decisions in your hands.** Review results, guide a running task, and approve high-impact actions before they proceed.
- 🔌 **Choose your own models.** DeepSeek is the default; text, vision, image, and video services can be configured separately, including compatible local APIs.

## 🧩 What is included?

| Area | What you can do | Requirement |
| --- | --- | --- |
| Chat and files | Stream answers over SSE; analyze images, Markdown, text, Word, PDF, SVG, and HTML | Text model; vision model for image understanding |
| Live research | Research news, papers, GitHub repositories, and time-sensitive facts while retaining sources | DeepSeek native search |
| Multi-Agent work | Route each turn through Router Agent and Scheduler Agent, then run a dynamic DAG | Built in |
| Human collaboration | Guide, pause, resume, cancel, review, retry, branch, merge, or rerun an Agent | Built in |
| Complex delivery checks | Trace requirements to their source, check the final answer, attempt one bounded revision, and retain unresolved drafts and partial acceptance across restarts | Text model; semantic assessment is not independent fact verification |
| Agent Nexus | Build reusable Agent flows with conditions, parallel paths, multiple Loops, nested Loops, and local reruns | Built in |
| Plugin Mini Apps | Create, edit, preview, review, publish, sign, install, roll back, and withdraw plugins | Built in; external tools follow permissions |
| Media and reports | Generate or edit images, request videos, and export Markdown, Word, LaTeX, or PDF reports | Configure the matching provider for media generation |
| Projects and schedules | Organize work, members, reviews, decisions, memory, and Agent-powered schedules | Built in |
| Tools and capability packs | Use custom Agents, templates, MCP/OpenAPI tools, and seven scoped capability packs | Credentials required for authenticated services |
| Feishu collaboration | Read documents, calendars, and group messages; send messages after approval | Feishu custom app |
| Recovery and operations | Inspect Token usage, cost, queue wait, leases, model/tool health, alerts, Artifacts, and delivery evidence | Built in; external backends are optional |
| Task improvements · controlled RSI | Review finished work, save suggestions, compare fixed cases, and prepare a new chat to try them | Source task's text model; comparison is user-triggered, usage may be charged, and suggestions are never automatically applied |

An integration shown in the UI is not automatically considered healthy. The system status panel probes the active model, database, sandbox, memory, storage, and optional services. Missing dependencies are shown as degraded or unavailable.

## 🔁 How a task runs

### 🌱 Learn from a task, without changing it

Open **Task improvements**, choose a finished task, and ask what could work better. Axiom reviews its recorded result and your feedback, then suggests changes and checks worth trying. Save a useful suggestion and bring it into a **new chat draft**—you decide what to send. A later task can build on the previous suggestion for another round of review.

This first, controlled RSI stage never rewrites a running Graph, publishes a plugin, changes permissions, or silently updates your memory. Saving a suggestion does **not** mean it has passed a quality comparison. See [scope, usage, and safeguards](docs/controlled-rsi.md).

In the post-rc.8 source, **Compare before deciding** adds paired checks using supplied facts and reference IDs. The cases are separate from the original task and the model's proposed tests. Unknown usage stays unknown; money and human intervention are not measured. This public, reusable suite is not a permanently blind benchmark or proof of general improvement.

Included in **v2.3.0-rc.8**. A review uses the source task's configured text model and may incur model usage. It does not execute tools or automatically test, publish, or apply the suggestion. If a new draft would replace unsent text or attachments, Axiom asks you to keep those first. See the [rc.8 acceptance record](docs/rc8-release-acceptance-20260920.md) for release checks and their limits.

### Execution path

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
Synthesizer: results, source references, and unresolved gaps
  ↓
Final answer, report, Artifact, or follow-up action
```

Long tasks use structured handoffs and Artifact references instead of repeatedly placing every intermediate result into the model context. A user can add guidance while work is running; Axiom applies it at the next safe execution point without creating a duplicate task.

### Reliable execution

- **A routing outage does not erase the rest of the request.** Shared browser and server fallback keeps research, attachments, analysis, and verification connected when needed. A simple question still takes a lightweight path.
- **Less repeated work, clearer measurements.** Duplicate handoff text is sent once. Reviews that repeat the same unresolved issues without progress stop for the configured recovery or human-review path. Task diagnostics separate measured usage, unknown usage, retries, and human intervention.
- **One request can use several inputs.** An image and a document add the required capabilities without replacing the rest of the Agent plan. Tasks keep an immutable copy of the exact turn's attachments.
- **Agents can take a useful next step.** A tool result can lead to another lookup or action. Decisions and results are checkpointed, with limits that stop repeated calls and stalled work.
- **Recovery does not blindly repeat actions.** Successful tool receipts can be reused after an interruption. When a write may have happened but its result is unknown, task details let you record what you checked, then explicitly continue.
- **Your decisions remain traceable.** Long conversations retain sourced constraints and decisions, including later changes or cancellations. Task Agents with `context.read` can retrieve the original messages when tool execution is enabled; incomplete extraction is not treated as complete memory.
- **Completion is not proof of truth.** Execution, human acceptance, and source traceability are separate. Neither a successful tool call nor a model's “verified” label establishes that every claim is correct.

### Work stays consistent across entry points

- **Your model choice follows the task.** Text, vision, image, video, and native-search settings are captured securely when work is created. Resuming a task does not silently switch providers.
- **Generated media is recoverable work.** Image generation, editing, and video requests use saved execution receipts. An uncertain write pauses for inspection instead of blindly submitting another paid request.
- **Your next action is close to the work.** Plans, tool permissions, quality reviews, and uncertain results use a shared action panel in task details, Chat, Agent Nexus, and Mini Apps.
- **Plugins follow real routing.** Simple Mini App questions stay lightweight; complex requests use durable tasks and keep their original request while waiting for your decision.
- **Status stays honest.** A pause is not a successful delivery, a truncated answer is not complete, and missing provider usage is not presented as measured zero.

Ordinary Chat, Nexus, and Mini App histories remain separate; the task board brings their execution records together. Pending decisions are available beside the work that needs your attention.

Inline Base64 media is saved as an Artifact. Provider-hosted links can still expire, and deleted completed Artifacts require a storage backup. Existing API clients should review the [HTTP 202 media contract](docs/migration-v2.3.md) before upgrading.

## 🪟 Product views

The Control Room shown above brings together active work, daily progress, task dependencies, delivery state, Token trends, and the live 3D Agent scene.

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

## 🏗️ Frontend and backend

| Part | Location | Stack |
| --- | --- | --- |
| Frontend | [`src/`](src/) | React 19, TypeScript/TSX, Vite, and Three.js |
| Backend | [`server/`](server/) | Node.js, Hono, and TypeScript |
| Database | Managed by the backend | SQLite for local development; PostgreSQL for multi-Worker deployments |

## 🚀 Quick start

### 1. Install

Requirements:

- Node.js 22 or later
- Docker for sandboxed tools and the complete local production gate

```bash
git clone https://gitee.com/water-sim/axiom-agent-control-room.git
cd axiom-agent-control-room
npm ci
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

Create the stable encryption key used for resumable tasks:

```bash
node scripts/setup-local-provider-secret.mjs
```

The script preserves an existing key and never prints it. Back up `.env.local` securely. For multiple Workers, supply the same `AXIOM_PROVIDER_SECRET` through your deployment secret manager instead of generating one per machine.

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

## 🧪 Quality gates

**Latest development checks · 2026-09-21:** the final source passed TypeScript checks and production build, with **907 tests passed, 0 failed, and 18 PostgreSQL-conditional skips**. Secret-free CI passed 12/12 locally on Windows; hosted GitHub runs are reported separately in Actions. The latest isolated full gate was **45 passed, 1 failed, and 3 external-service skips**: the Nexus Loop produced output but did not reach completion in either attempt. Visual checks passed 172/172, Agent Graph 22/22, and PostgreSQL stability 20/20. That full gate started before the final Jev privacy patch, so it is not an all-green acceptance of the final source. See the [current evidence and limitations](docs/jev-routing-integration-20260921.md).

The earlier delivery batch had 46 full-gate passes and a 24/24 deterministic delivery suite. Its four-case live-model observation improved from 3/4 to 4/4 after evaluation-harness fixes; those historical results and failures remain in the [delivery acceptance record](docs/business-delivery-closure-20260921.md). They do not override the latest failures or establish general business accuracy. This source update is **Unreleased**, not a new production release.

```bash
npm run check                 # TypeScript checks for web and server
npm test                      # Unit and runtime tests
npm run qa:ci                # Secret-free source copy, checks, tests, build and browser regressions
npm run qa:business-delivery # 24 deterministic cross-component delivery cases; no provider calls
npm run qa:business-oracles  # Independent result-checker and isolation regressions
npm run qa:business-live     # Explicit live model evaluation; may incur model usage
npm run build                 # Production web and server build
npm run qa:i18n               # English default and Chinese switch regression
npm run qa:visual             # Desktop and mobile visual regression
npm run qa:business           # Segmented business-flow evaluation
npm run qa:mcp-business       # 30 P0 + 14 P1 Fake MCP cases
npm run qa:routing-resilience # Deterministic Router/Scheduler failure cases
npm run qa:execution-quality  # Fixed delivery and review-loop quality cases
npm run qa:improvements       # Controlled RSI UI and unsent trial-draft checks
npm run qa:preview-stability  # Interactive previews survive scrolling and streaming
npm run qa:agentgraph3d       # Real component interactions and frame budgets
npm run qa:object-storage:local
npm run qa:postgres:local
npm run qa:all:local          # PostgreSQL + MinIO local release gate
```

**v2.3.0-rc.8 acceptance · 2026-09-20:** the final complete local gate passed **41 checks, with 0 failures and 3 external-service skips**.

| Check | Result |
| --- | --- |
| TypeScript checks and production build | Passed |
| Unit and runtime tests | 700 total · 684 passed · 0 failed · 16 conditional PostgreSQL skips |
| Isolated PostgreSQL checks | 18/18 passed, covering the database cases skipped above |
| Desktop/mobile visual checks · real Agent Graph · RSI interactions | 172/172 · 22/22 · 17/17 passed |
| Fake MCP · routing resilience · live routing · fixed delivery quality | 44/44 · 137/137 · 7/7 · 14/14 passed |
| English/Chinese UI | Passed |
| Clean source install, checks, tests, build, and isolated startup | Passed |

Every runnable check passed without a retry **in the final complete run**. Earlier runs exposed defects and timing issues; the [rc.8 acceptance record](docs/rc8-release-acceptance-20260920.md) preserves those failures, fixes, and measurements. The three skipped checks are MemoryCore HTTP, the MemoryCore adapter, and the Harness/Codex sidecar; they need separately configured services and are not counted as passes. The deployment ZIP also passed a clean production-dependency installation and isolated startup check, without developer secrets or task history. The production dependency audit reported **0 known vulnerabilities at the time checked**, not a complete security certification.

<details>
<summary>Previous release: v2.3.0-rc.7 acceptance · 2026-09-07</summary>

```text
npm run check          passed
npm test               644 tests / 630 passed / 0 failed / 14 PostgreSQL skipped
npm run build          passed
PostgreSQL isolation   16 passed / 0 failed / 0 skipped
Routing resilience     137 passed / 0 failed
Live Router/Scheduler  7 passed / 0 failed
Fixed delivery quality 14 passed / 0 failed
Populated bilingual UI 10 passed / 0 failed
Real Agent Graph       22 passed / 0 failed
npm run qa:visual      172 assertions passed
npm run qa:mcp-business 44 passed / 0 failed
npm run qa:all:local   37 passed / 0 failed / 3 skipped
```

The 14 PostgreSQL cases skipped by the default test command were rerun in isolation. The local full gate now creates a temporary API, a separate database for PostgreSQL contracts, and temporary Artifacts. It does not populate your regular task history. The first full run caught an English Readiness-label defect; after repair, the entire gate passed again with no retries in the final run. Both runs are documented in the [acceptance log](docs/rc7-product-quality-20260907.md).

The three skipped live checks require deployment-specific TencentDB MemoryCore and Harness/Codex sidecar configuration. A skipped check is not a pass. Fixed delivery tests validate authored requirements and exact source pairs, not the factual accuracy of arbitrary answers. Live complex tasks can still need human review and may deliver explicitly accepted partial results; these are not counted as automatic first-pass success.

</details>

Controlled RSI checks validate access boundaries, persistence, conflict handling, model-output parsing, and the unsent-draft handoff. They do **not** establish that a suggestion improves an arbitrary task. Live providers and deployment-specific services still require checks in your own environment.

## 📈 Local API baseline

Historical baseline from 2026-09-04, measured on one Windows node with 25 concurrent clients and 200 requests per endpoint. These figures measure Axiom's API, scheduler, and database path; they do not include model generation or Internet latency. The rc.7 UI and live-model measurements are recorded separately in the acceptance log and are not a production-capacity guarantee.

In the final rc.8 synthetic Agent Graph check, frame-interval P95 was **33.4 ms on desktop** and **16.7 ms on mobile** under the fixed telemetry fixture. Earlier desktop samples exceeded the unchanged 50 ms budget; see the release record for the full history. These are local browser measurements, not model-response times or a claim that a test-harness fix improved rendering performance.

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
- [Cross-entry execution and human collaboration](docs/cross-entry-consistency-20260907.md)
- [Agent Nexus control flow](docs/agent-nexus-control-flow.md)
- [Tool Registry and MCP safety](docs/tool-registry.md)
- [Business capabilities V2](docs/business-capabilities-v2.md)
- [Context windows and durable summaries](docs/context-window.md)
- [MemoryCore integration](docs/memorycore-integration.md)
- [Harness adapters](docs/harness-adapters.md)
- [Runtime business evaluation](docs/runtime-business-evaluation.md)
- [Controlled RSI: task improvements](docs/controlled-rsi.md)
- [rc.8 release acceptance](docs/rc8-release-acceptance-20260920.md)
- [Upgrade roadmap](docs/upgrade-roadmap.md)
- [Release history](CHANGELOG.md)

Most detailed engineering documents are currently written in Simplified Chinese. Their commands, API names, and configuration keys are language-independent.

## 📄 License

Axiom Agent Control Room is available under the [MIT License](LICENSE). Configure your own model services and validate your own production environment.

## 🙌 Contributing

Issues, documentation improvements, and pull requests are welcome. Changes to Agent execution, security boundaries, recovery, or tenant isolation should include focused tests or a reproducible regression script.
