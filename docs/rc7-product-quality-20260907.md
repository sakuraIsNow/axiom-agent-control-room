# v2.3.0-rc.7 产品质量收口

本批目标：路由故障不丢复合要求、执行效率可观测、交付质量可重复评测、真实前端状态与 Agent Graph 通过回归。2026-09-07 本地验收完成，最终全量门禁为 `37 passed / 0 failed / 3 skipped`；外部依赖不计为通过。

## 最终验收

| 项目 | 结果 |
| --- | --- |
| `check` / `build` | 通过 |
| `npm test` | 644 tests，630 passed / 0 failed / 14 PostgreSQL skipped |
| 隔离 PostgreSQL 稳定性 | 16/16，补齐默认单测跳过项 |
| 路由故障 / 在线 Router-Scheduler | 137/137 / 7/7，最终在线降级率 0/7 |
| 固定交付质量 / Fake MCP | 14/14 / 44/44 |
| 有数据双语 / 真实 Graph | 10/10 / 22/22 |
| 桌面与移动视觉 | 172/172，浏览器及 HTTP 错误均为 0 |
| `qa:all:local` | 37 passed / 0 failed / 3 skipped，最终轮无重试 |

最终日志为 `qa/rc7-fullgate-final-20260907.log`，结构化报告为 `qa/production-gate-results.json`。首轮失败见下文，最终无重试不代表整个开发与验收过程一次通过。

### 实际测量

- 最终 Graph 每端持续约 30 秒，16 个可见 Agent、500 条事件、10Hz 状态更新。桌面帧 P95/P99 为 33.4/50ms，移动端为 16.7/16.8ms；固定预算为 50/100ms。交互 P95 为 29.8/18.6ms，测量的是指针处理到第二次 rAF 的绘制机会代理值，不是 INP。
- 桌面与移动端 GC 后堆分别为 10,406,060 / 10,194,264 字节，较测量前增加约 1.65 / 1.41 MB。环境为 Windows、Chromium 151、无头软件合成；仅代表实际 CSS 3D 组件的合成事件负载，不代表整个应用或任意设备容量。
- 最终真实 Runtime 用时 66,671ms，21 次模型调用，供应商返回 128,233 Token，1,073 条增量，交付 2,452 字符；测试操作者执行了一次审核批准。执行证据仍为 `partial`、人工接受为 `accepted`、事实正确性未独立评估，未计为自动首次成功。它直接创建任务，不包含前置 Router 请求，不作为普通聊天平均延迟或成本。
- 相同交接样本从 16,113 压缩到 8,107 字符，消除约 49.7% 的重复文本且保留来源；真实供应商整体 Token 降幅没有对照测量，不能据此承诺全任务节省 49.7%。
- 正式服务前后均为 19 条任务、11 个会话。两轮门禁的临时进程、数据库和工作目录均正常清理，原数据库与凭据保持不变。

## 升级范围

- 前后端共用纯降级决策与 Zod 契约。健康模型继续负责 Router/Scheduler；模型不可用或决策无效时，检索、附件和交付要求按依赖组合，不把复合任务降为单搜索。
- 原始失败输入不变：基于最新官方资料比较 PostgreSQL 与 SQLite 在多 Worker 的并发、迁移、故障恢复，提出选型并验证。故障时的最小依赖为搜索、分析、验证；简单天气、检索和问候不强制多 Agent。
- `GET /api/tasks/:taskId` 新增顶层 `executionQuality`，根据当前租户的持久事件重建。记录模型/专用服务阶段、调用、失败、重试、已知与未知用量、人工介入、审核修正和交付状态。
- `POST /api/chat/route` 新增顶层 `diagnostics`，测量 Router/Scheduler 当前请求的调用。该请求通常发生在任务创建之前，不冒充已经包含在任务存活时长中。
- 相同上游交接文本只传一次，保留完整信息、Artifact 与证据引用。审核问题未变且评分未改善时停止重复自动修正，继续遵守原有人工审批设置。
- 补有数据的中英文、动态无障碍名称与移动端交互；保留用户自定义名称和内容。旧 Graph 手工 DOM 烟测替换为实际 React 组件测试。

## 测量边界

- `timing.elapsedMs` 是任务生命周期时间，包含等待人工及恢复；`modelCallDurationMs` 是各调用耗时之和，并行时可以大于墙钟时间。
- `firstActivityMs` 与 `firstAnswerMs` 分开；内部推理和流重置不当作用户收到的最终答案。
- `usage.measuredTokens` 仅累计供应商返回的已知用量。有未知调用或内部重试的前次用量缺失时，`totalTokens` 为 `null`，保留 `partial`/`unknown` 状态。
- 专用服务的配置、附件预检及 HTTP 失败单列 `specialistServiceFailures`；没有实际模型调用回执时不推测模型调用次数或计费。用量汇总仅代表观察到的调用，不等于供应商账单。
- `firstAttemptExecutionSuccess` 检查执行是否在没有重试、人工介入或审核修正时完成，不代表回答事实正确。生产任务的 `requirementCoverage` 没有独立标注时为 `null`。
- 固定交付评测使用明确的要求锚点和 claim/source 配对，并解析最终 Markdown 渲染树的标题及链接。模型评分、前序证据、最终引用和人工接受不互相替代。该评测不是任意内容的自动事实核验器。
- 交接效率对照只代表相同输入的重复文本消除，不据此承诺整个任务或真实供应商的 Token 降幅。
- 在线路由每例只调用一次，保留时间戳报告。完整门禁允许的整项重跑仍保留每次结果，不能把重试通过写成首次成功。

## 测试入口

```bash
npm run qa:routing-resilience
npm run qa:execution-quality
npm run qa:routing
npm run qa:agentgraph3d
npm run qa:i18n
npm run qa:all:local
```

`qa:routing-resilience` 与 `qa:execution-quality` 不调用付费模型、不触达正式任务库。Graph 和有数据双语夹具使用临时 Vite 与浏览器；完整门禁中的在线 Runtime/Router 检查会使用已配置的文本服务。

### 测试隔离

`qa:all:local` 默认创建独立 API 数据库与另一套 PostgreSQL 专项数据库。API Worker 无法领取数据库专项的队列夹具；Artifact、工作目录与备用 SQLite 均位于临时目录。正式 8787 服务和原凭据保持不变，临时 API 不向外部长期记忆写入。

可单独执行 `node scripts/local-postgres-acceptance.mjs --isolation-smoke` 验证数据库相互不可见、API 初始化与清理。Windows 清理仅针对该执行器记录的进程及子进程；进程退出后才删除已创建的临时数据库和已校验路径的临时目录。`AXIOM_QA_USE_EXISTING_SERVER=true` 是显式复用现有服务的例外，不作为默认验收方式。

## 发布与外部边界

### 开发过程中发现的问题

- 混合图片/文档比较的旧断言只接受两个解析 Agent，未验证比较结论由谁完成。保留原始 `Compare these inputs.` 输入，补分析 Agent 依赖，并验证两份真实解析结果在分析前已完成传递。
- Graph 最初真实桌面负载未达固定 50ms P95 门槛。失败测量保留；修复暂停空转、背面点击遮挡、事件区域高度以及高密度全屏绘制成本，不以提高阈值通过。普通内嵌毛玻璃与低密度动画保持。
- 人工接受与当前交付绑定：重排、局部重跑和新 Harness 委托使旧接受失效；普通外部恢复保留当前接受；创建新合并方案的溯源事件不撤销未改变原任务的接受。
- 双语复核发现仅测试空页面不能覆盖事件文案和用户原文碰撞，补运行事件来源区分及真实有数据组件回归。
- 首轮完整门禁为 `36 passed / 1 failed / 3 skipped`；唯一失败为运行观测将多个 Readiness 标签拼接后未正确翻译，两次相同失败均保留。修复限定于系统 Readiness 告警，逐项翻译服务标签，不屏蔽扫描器、不翻译用户正文。首轮报告保留在 `qa/rc7-first-production-gate-results.json`，日志为 `qa/rc7-fullgate-20260907.log`。
- 独立有数据双语复验首次发现证据计量词未成组翻译，已修复并统一证据正文的原文保护标记，保持精确原文断言与英文扫描；随后十个场景全部通过。最终完整门禁再次执行这一专项，而不是只引用独立结果。
- 专用服务错误可能发生于配置或附件预检阶段；没有模型回执时仅记录服务失败，不推测计费调用。

升级前快照为 `frontend-backup/20260907-pre-rc7-product-quality.zip`。本批无数据库结构迁移；保留现有 PostgreSQL、Artifact 与 `AXIOM_PROVIDER_SECRET` 配置。

MemoryCore、Harness/Codex sidecar、真实媒体供应商及外部 OAuth 仍需目标环境现场验收，不算本地通过。供应商外链过期与已完成媒体文件丢失仍依赖既有保留策略和存储备份。
