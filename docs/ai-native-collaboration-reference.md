# AI-native 协作参考与 Axiom 落地

本文件记录 `ai-native/` 下两份协作说明对 Axiom 的可落地结论。它们描述的是一套以 Agent 为执行主体、以人类审核为责任边界的 SDLC 闭环，不是需要整体引入的运行时框架。

## 核心原则

1. 用户原始目标先形成可读的意图，再进入规划、执行、测试、审核和交付。
2. 每个阶段都留下下一阶段可以读取的产物，产物链同时是审计线索。
3. Agent 可以自动推进常规阶段；涉及高风险或不确定性的动作停在人工门禁前。
4. 测试和评测在执行过程中持续运行，而不是只在最后做一次人工验收。
5. 维护事件可以重新进入同一条闭环，但检测必须由确定性规则触发，不能由模型自行制造告警。

## Axiom 对照

| AI-native 阶段 | Axiom 当前实现 | 说明 |
| --- | --- | --- |
| 意图 | `Task.input`、会话上下文、语义路由 | 用户原话保留，路由根据当前输入而不是固定 Agent 名称决定执行范围 |
| 规划 | `WorkflowOrchestrator.plan()`、`WorkflowPlan`、Agent Graph | Planner 生成步骤、依赖、技能和验收标准；必要时请求计划审批 |
| 执行 | 依赖就绪队列、并行 Agent、Tool Registry、Checkpoint | 只运行本轮相关 Agent；失败按策略重试、暂停或进入人工处理 |
| 测试/审查 | Reviewer、证据树、质量分数、回归测试和视觉 QA | Reviewer 不满足阈值时进入整改或人工审核，不直接伪造通过 |
| 交付 | Synthesizer、`artifact.created`、结果 Artifact | 结果绑定任务、步骤和工具 lineage，可从事件流追溯 |
| 维护 | Scheduler、Webhook、Readiness、运行指标 | 当前已有触发和探测能力，死信、跨副本指标和长期记忆仍是后续生产项 |

## 本轮界面增强

任务详情新增“执行链”，由真实任务字段推导五个阶段：

```text
意图 -> 计划 -> 执行 -> 审查 -> 交付
```

它不创建额外状态，也不改变任务协议：

- `意图` 来自任务输入；
- `计划` 来自持久化 `WorkflowPlan`；
- `执行` 来自步骤完成数和任务状态；
- `审查` 来自 Reviewer 分数或人工审核状态；
- `交付` 只在任务真正完成后标记完成。

这样普通用户可以看懂任务现在处于哪一步，工程人员仍能从 Graph、Event 和 Artifact 查看完整细节。

## 后续优先级

### P0/P1

- 为路由结果增加 `confidence`、候选意图和触发信号，并持久化 `route.decided`、`skill.selected`、`agent.handoff` 事件。
- 为计划、审查和交付产物增加统一 Artifact 引用，保留版本、覆盖范围和来源，而不是只保留最终结果。
- 保持高风险工具、生产发布和受保护路径的人类门禁；Agent 不能批准自己产生的变更。

### P1/P2

- 将失败触发器接入死信队列和指数退避，避免定时任务无限静默重试。
- 用 HarnessEval-W 的 case、证据和验收检查扩展 `qa:routing`、`qa:runtime` 与 `qa:visual`，每次模型、Skill 或路由策略变化都跑回归。
- 用 Codex / OpenAI Agents 的 parent-child thread 与 handoff 事件增强跨 Agent 协作可视化。
- 用 LiteLLM 的延迟、成功率和成本信号做 Provider 选择，但不能绕过 Axiom 的租户、审批和 Artifact 边界。

## 参考项目的边界

- `semantic-router` 适合做快速候选筛选，不能替代服务端权威路由和权限检查。
- `LangGraph` 的条件边、子图和 Checkpoint 适合映射到 Axiom Graph；Axiom 仍应由自己的 TaskStore 负责租约和事件顺序。
- DeepSeek Harness 和 Codex app-server 目前作为适配器参考，只有在实现真实 Transport、身份绑定和事件去重后才能接管执行。
- AI-native SDLC 文档强调的是流程和治理；它不能证明任何模型输出天然正确，质量仍要依靠确定性测试、证据和人工审核。
