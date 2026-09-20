# 2026-09-19 受控 RSI 第一期验收

## 范围

新增“任务改进 / Task improvements”：用户选择自己的终态任务，真实模型生成复盘与改进建议，保存/忽略，再手动带入新对话草稿。允许以同一用户的上一版建议为参考进行最多五代迭代。

不新增在线调度器、不执行工具、不修改现有任务/Graph/路由权重/记忆/插件/Nexus/权限。`accepted` 仅表示用户保存建议，`qualityStatus` 始终为 `unverified`。建议的验证用例尚未执行，不冒充独立质量提升。

快照：`frontend-backup/20260919-222131-pre-controlled-rsi.zip`。原有 9 月 8–9 日未提交修改及两个 pelican HTML 文件保留，没有提交或推送仓库。版本保留 `2.3.0-rc.7`，新增功能记入 CHANGELOG 的 Unreleased；未打发布标签。

## 实现

- `server/runtime/improvementApi.ts`：只读分析旁路；绑定来源任务文本模型；有界 JSON、无工具、55 秒超时；DB 唯一键跨 Worker 幂等；记录生成中状态及超时恢复；revision 冲突；所有者、来源运行版本及父代链检查。
- `server/shared/improvement.ts`：前后端共享建议、来源及试用草稿类型。
- `businessCapabilityStore.ts`：新增 `improvement-proposal` 记录类别，复用现有 SQLite/PostgreSQL 表。
- `TaskStore.listTasks`：可选用户/状态参数，在 LIMIT 前过滤；不传参数的旧业务保持原行为。RSI 返回当前用户最近 100 个终态任务。
- `taskApi.ts`：独立 `/api/improvements` 挂载，复用来源任务加密配置的模型解析，不把任何凭据放进建议。
- `ImprovementWorkspace.tsx` 及导航：毛玻璃主题、中英切换、移动端、即时反馈、生成状态恢复、建议预览/复制/保存/忽略及草稿交接。
- 打开试用对话不会自动发送；已有未发送文字或附件时，必须明确确认已保留，再替换输入。忽略的建议可直接重新保存，不再调用模型。
- `qa:improvements` 接入完整生产门禁，RSI PostgreSQL 用例接入本地稳定性和生产门禁 PostgreSQL 阶段。

## 最终测试结果

| 检查 | 结果 |
| --- | --- |
| `npm run check` | 通过 |
| `npm test` | 696 个测试：680 passed / 0 failed / 16 条件 PostgreSQL skipped |
| `npm run build` | 通过 |
| `npm run qa:stability:local` | 18 passed / 0 failed / 0 skipped，真实临时 PostgreSQL 数据库 |
| RSI SQLite 专项 | 29 passed，已包含在完整单测中 |
| RSI PostgreSQL 专项 | 1 条综合用例通过，含跨实例幂等、revision 冲突、重建 API 后持久读取与来源过滤，包含在上述 18 项中 |
| `npm run qa:improvements` | 17 组浏览器交互检查通过，无 page error 或意外 API 调用 |
| `npm run qa:visual:local` 内调用 `npm run qa:visual` | 172 项断言全部通过，consoleErrors 0 / httpErrors 0 |
| 真实模型隔离样例 | `deepseek-chat` 返回有效草稿，6,793 ms，1,509 Token，4 条观察、4 条建议；来源任务未变化、无工具执行 |

浏览器专项挂载真实组件，接口使用明确的隔离样例。真实模型冒烟使用内存 SQLite 和人工编写的数据库选型样例，不读取真实历史；它验证模型/解析链路，不证明建议提高了任务质量。

日志与生成证据：`qa/rsi-unit-test-final.log`、`qa/rsi-build-final.log`、`qa/rsi-postgres-final.log`、`qa/rsi-ui-final.log`、`qa/rsi-visual-final.log`、`qa/improvements-results.json`、`qa/rsi-live-model-result.json`。截图 `qa/improvements-desktop.png` / `qa/improvements-mobile.png` 已检查；部分 QA 产物按仓库原有规则不提交。

本批没有重新执行完整 `qa:all:local`；没有把历史全门禁或外部 MemoryCore/Harness 等验收算入本次通过。

## 测试中实际修正的问题

1. 最初建议 ID 使用字符串前缀，不符合 PostgreSQL UUID 字段；改为由用户范围和幂等键派生的稳定 UUID。
2. 首次 PG 测试的 Promise.race 失败分支在稍后消费了 Response，导致 clone 失败；修复测试后真实 PG 18/18 通过。
3. 首次浏览器断言预期 `unverified`，实际英文为 `Not validated`；对照真实词条修正测试，最终 17/17 通过。
4. 来源列表最初先取租户最近记录再筛选本人，会挤掉自己的旧记录；改为 SQL LIMIT 前按本人和终态筛选，并新增 101 条无关记录的回归。
5. 上述“旧记录”测试初次时间并列，断言不确定；显式隔开 fixture 的生成时间后 29/29 通过，没有改变业务排序以迁就测试。
6. 只有附件没有文字时会漏掉试用替换警告；保护范围扩展到文字或附件，用户明确保留后才允许继续。

## 本地服务交接

编译产物已更新，但重启旧服务的进程操作被执行环境安全策略拦截，未改用其他命令绕过。最后检查 `8787` 仍由旧 PID `18336` 监听，未宣称新后端已加载。需要用户手动重启现有 Axiom 服务，才会加载 `/api/improvements`。

当前真实数据核对为 **21 个任务 / 12 个会话**，与本批测试前一致，21 个任务均已完成。测试没有向真实任务/会话库插入样例。

## 尚未实现

独立留出集的基线/候选质量对照、自动策略发布/灰度/回退、团队优化共享、模型训练及代码自修改都不属于本批。多用户可信登录、全平台数据/文件/工具隔离仍应先于共享学习实施。
