# Reasonix Runtime 借鉴说明

AXIOM 不直接复制 DeepSeek Reasonix v2 的 Go/Wails 单机运行时，而是吸收它在 Agent 执行可靠性上的约束，并适配 AXIOM 的 Hono/Node、多 Worker、PostgreSQL/SQLite、Agent Nexus 和插件体系。

## 已落地

### 统一 DAG 计划校验

模型 Planner、恢复任务和手动 Agent Nexus 编译结果都必须满足以下规则：步骤 ID 唯一、依赖存在、不能自依赖、不能成环。`server/runtime/workflowDag.ts` 同时计算稳定的并行波次，Graph 节点通过 `executionWave` 展示服务端真实调度顺序。

### 统一事件上下文

`task_events.runtime_context_json` 保存跨入口追踪身份：租户、用户、会话、工作流、Turn、Attempt、Runtime generation、来源和提交标识。事件正文仍保持现有协议兼容，旧数据库会在启动时自动补列。

### 可核验交付回执

终态事件的 `evidenceSummary` 只统计持久化事实：完成步骤、失败/跳过步骤、验收条件、证据条目、工具回执、Artifact 引用和审核状态。它不把模型的“已完成”文字直接当作事实。

## 后续落地顺序

1. 将事件上下文提升为统一 `AgentExecutionController` 的显式对象，让普通对话、任务、Agent Nexus、插件和 Harness 共用一套 Turn 生命周期。
2. 为 Agent 写入范围增加 Writer lock、父子 Agent 互斥和并发波次限额。
3. 将 `StepResult`、`ArtifactRef`、`ReviewResult` 和工具 receipt 接入最终交付门禁。
4. 增加 Checkpoint/Rewind 的版本冲突保护，以及从旧节点创建任务分支。
5. 使用稳定的 `use_capability` 工具代理和 `result_ref` 控制大工具输出，保护 Provider Prompt Cache。

## 不照搬的部分

- 不将 AXIOM 迁移为 Go/Wails。
- 不使用 Reasonix 的本地文件快照替代 AXIOM 的 Artifact Store 和对象存储。
- 不让所有请求强制进入 Planner 或完整多 Agent 流程。
- 不允许插件任意访问主页面 Origin、Node 进程或未声明的网络能力。
