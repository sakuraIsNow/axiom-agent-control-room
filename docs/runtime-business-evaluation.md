# Runtime 业务闭环评测

## 目标

`npm run qa:business` 不只判断最终字符串是否匹配，而是检查复杂任务在多个阶段是否保持正确。结构参考 HarnessEval-W 的分段产物方式，但指标映射到 Axiom 的 Agent 调度、恢复和人工协作，不照搬视频生成指标。

每次运行持续写入 `qa/business-eval-results.json`。报告包含运行 metadata、每个已完成阶段的 partial progress、分段探针输出和 artifact validation；即使中途失败，也能看到最后一个通过的阶段。

## 当前评测维度

| 维度 | 验证内容 |
| --- | --- |
| proportional routing | 简单问题不强制多 Agent，复杂交付才进入完整工作流 |
| drift resistance | 新一轮只选择当前需要的 Agent/Skill，旧 Graph 可以被跳过 |
| transition correctness | 执行中补充要求只应用一次；Harness 不支持 steer 时不虚报成功 |
| artifact boundary | 长结果生成 `result_ref`，普通下游不读全文，审查消费者有界读取；存储故障时数据库保留全文 |
| return/revisit consistency | 摘要跨重启恢复，来源消息变化后旧 digest 失效并重建 |
| concurrency conflict safety | stale revision 被拒绝，分支幂等，三方合并冲突必须显式处理 |

在线的按难度路由分段调用正在运行的 `/api/runtime/triage`；其余分段使用独立 SQLite 和确定性模型替身运行真实 Runtime/API 契约，不依赖外部模型稳定性。外部模型质量、检索引用准确率和真实 sidecar 故障恢复需要单独的部署环境评测，不能由这些确定性测试替代。

## 扩展规则

新增业务场景时应声明用户目标、阶段边界、关键不变量和可核验 Artifact。失败必须指向具体分段，不能只记录“最终回答不正确”。涉及外部服务的场景应区分 `passed`、`failed` 和 `skipped`，未配置依赖不能算通过。
