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

## 附件与连线传递

Nexus 可以上传持久附件，也可以链接当前租户 Artifact 目录中仍有效的结果。附件记录固定工作流 ID、版本、MIME、大小、摘要和存储键；下载和链接时再次校验租户归属。浏览器内存文件不会被当成已经持久化的附件。

每条 Agent 连线可以选择 `summary`、`full`、`fields` 或 `reference`：摘要适合普通协作，全文受上下文预算限制，字段模式按声明提取结构化字段，引用模式只传 Artifact 身份。编译后的计划保留传递方式，恢复任务不会因为刷新而退回默认摘要。

## 测试、发布和恢复

草稿可以保存测试输入、期望文本和预期状态。测试运行会创建真实任务并轮询到终态，结果保存任务 ID、状态、耗时和断言，不把“成功创建任务”冒充测试通过。

发布会固定当前定义、工作流版本和内容摘要。运行已发布 Nexus 时，Task API 读取指定发布快照，不跟随之后的草稿。历史发布可比较步骤、Agent 和连线的增加、删除与修改，并能恢复为新的草稿。发布版本还可以生成固定 `workflowId + workflowVersion` 的 Workflow Plugin，继续复用 Task、Event、SSE、审批和恢复链路。

## 验收

自动化测试覆盖：单 Loop 兼容 ID、多个嵌套 Loop、上一轮回边依赖、条件命中/跳过、受限表达式拒绝任意代码、四种连线传递、附件租户隔离、真实测试终态、发布差异、恢复、Workflow Plugin、局部重跑前置条件和上游检查点保留。真实模型工作流仍需在部署环境补充业务 case 的成功率、人工接管率和成本评测。
