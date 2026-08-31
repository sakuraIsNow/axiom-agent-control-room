# Agent Nexus 控制流

更新时间：2026-08-29

## 画布编译

Agent Nexus 画布只允许一个输入和一个输出。普通 flow/condition 边必须是无环图；循环使用带 `maxIterations` 的 loop 回边。编译器解析每个 Loop 的可达区域，拒绝交叉但非完整嵌套的区域，并限制展开后的执行步骤不超过 256。

单 Loop 继续生成兼容 ID（`agent`、`agent-loop-2`、`agent-loop-3`）。多个或嵌套 Loop 使用稳定复合 ID（例如 `review~outer-2~quality-3`），每个步骤同时保存 `loopPath`；单 Loop 额外保留旧 `loop` 字段，旧 Graph 和历史任务无需迁移。

依赖解析遵循四条规则：同一 Loop 使用同一轮；离开内层 Loop 使用内层最终轮；进入内层 Loop 时外部输入只依赖第 1 轮；Loop 回边目标第 N 轮依赖源 Agent 第 N-1 轮。这样展开结果是 DAG，运行时可以按依赖批次并行。

## 条件分支

Condition edge 的表达式是受限 DSL，不执行 JavaScript。当前支持：

- `not_empty` / `empty`
- `contains("关键词")`
- `equals("文本")`
- `confidence >= 0.7`、`confidence < 0.5` 等比较

所有条件源依赖完成后才评估。命中分支发出 `branch.selected` 并执行 Agent；未命中分支写入 skipped StepResult 和 `branch.skipped`，下游 join 将跳过结果视为已完成检查点。事件和 StepResult 持久化后，恢复任务不会重复执行已决定的分支。

## 节点级局部重跑

`POST /api/tasks/:taskId/nodes/:nodeId/rerun` 只接受已经 completed、failed 或 skipped 的 Agent。运行中、等待审批/人工处理或尚未执行的 Agent 返回 409；目标 Agent 的所有上游必须已有 completed/skipped 结果。

重跑会保留无关上游检查点，清理目标及其 descendants，重新排队任务，并记录 `rerunAttempt`、`parentCheckpoint`、`preservedUpstreamSteps` 和 `invalidatedSteps`。下游会随依赖重新执行，人工 complete/skip 和旧 retry API 保持兼容。

## 验收

自动化测试覆盖：单 Loop 兼容 ID、多个嵌套 Loop、上一轮回边依赖、条件命中/跳过、受限表达式拒绝任意代码、局部重跑前置条件和上游检查点保留。真实模型工作流仍需在部署环境补充业务 case 的成功率、人工接管率和成本评测。
