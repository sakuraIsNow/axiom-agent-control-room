# 2026-09-06 稳定性升级

本批在 `v2.3.0-rc.5` 上修复审计发现的稳定性与交互缺陷，不调整产品定位，不重构现有视觉样式，也不宣称三个升级批次已经全部完成。

源码快照：`frontend-backup/20260906-pre-stability-rc5.zip`。本次源码同步范围仅限 Gitee，不包含 GitHub；版本保持 `v2.3.0-rc.5`，不创建新发布版本或 tag。

## 本批范围

- MCP 高风险调用在外部执行前原子占用审批，保存执行回执；已成功审批不受最近 500 条列表限制。并发重试或结果未知不会盲目再执行。
- MCP 并发槽按调用 ID 保存租约并续租，进程消失后可以回收；默认连续两次有效探测才能恢复，旧调用不能替代恢复探测。
- Webhook Outbox 可接管过期的 `delivering`；每次领取有独立 Token，旧执行不得回写新领取。领取时累计次数，连续崩溃也受五次自动尝试限制。
- 日程配置有版本保护，暂停、改期、恢复、替换和健康建议不会被旧执行结果覆盖。
- 会话按 ID 和用户归属查询，报告导出、聊天摘要读取与摘要续接不再依赖最近 100 条列表；关联清理查询全部匹配任务，并用版本条件避免删除已恢复任务。
- 浏览器使用 IndexedDB 缓存完整会话，迁移旧缓存并节流写入；配额或存储异常不应让对话页面崩溃。
- 对话与 Agent Nexus 区分输入法确认和快捷发送；打开历史直接定位底部，用户上滚后暂停自动跟随。
- Graph 状态刷新不重置用户视角或事件面板；界面语言切换保留会话的用户命名。

## 验证方式

先加入回归观察失败，再修复并验证。所有新增业务测试使用内存/Fake 服务或自动创建的隔离 PostgreSQL 数据库，不操作用户已有业务记录。

```bash
npm run check
npm test
npm run build
npm run qa:stability:local
npm run qa:mcp-business
npm run qa:frontend-stability
npm run qa:visual
```

`qa:stability:local` 创建一次性 PostgreSQL 数据库，运行后清理测试库；`qa:frontend-stability` 自动启动并关闭临时 Vite 服务，拦截业务 API，只测试真实 React 组件。两组新专项已接入完整门禁，PostgreSQL 未配置时明确跳过。

本批最终验证结果记录于下节，历史 `33/0/3` 门禁不作为本批结果。

## 验证结果

| 验证 | 最终结果 |
| --- | --- |
| `npm run check` | 通过 |
| `npm test` | 464 tests / 457 passed / 0 failed / 7 skipped |
| `npm run build` | 前端与后端生产构建通过 |
| `npm run qa:stability:local` | 9 passed / 0 failed / 0 skipped，包含上述全部 7 个 PostgreSQL 用例 |
| `npm run qa:mcp-business` | 44/44，30 个 P0 + 14 个 P1，报告按真实测试统计 |
| `npm run qa:frontend-stability` | 7/7，独立真实 React 组件与完整 App 缓存恢复 |
| `npm run qa:visual` | 170/170，控制台与 HTTP 错误均为 0 |
| `git diff --check` | 通过 |

视觉回归覆盖 1440×900 桌面与 390×844 移动端，没有横向页面溢出；主场景像素检查非空，已有布局、毛玻璃材质、3D 场景交互与 Artifact 渲染保持可用。该门禁包含主动切换会话、取消测试任务等操作，不等同于真实复杂任务交付质量评测。

本批已重启本地生产构建，保留 `http://127.0.0.1:8787` 一个入口，临时 `4300` 测试前端已关闭。未执行完整 `qa:all:local`，未重新验收 MemoryCore、Harness 或真实供应商认证。源码提交不等同于新版本发布；实际远端同步状态以 Gitee 提交记录为准。

本批日志位于 `qa/stability-unit.log`、`qa/stability-mcp.log` 和 `qa/stability-visual.log`；截图包含 `qa/dashboard-chat.png`、`qa/dashboard-chat-mobile.png`。这些是本地生成的验收文件，不携带用户模型密钥。

## 保留边界

- Webhook 是至少一次投递。每次重试沿用稳定的 `Idempotency-Key`，接收端仍需按此键去重，不能保证任意第三方严格恰好一次。
- 日程暂停阻止后续触发并保护新配置，不会撤销已经开始的远程操作。
- 高风险外部写操作在结果未知时停止自动重放，需要先核对外部执行结果；本批没有新增完整的未知结果处置界面。
- 会话删除继续保留运行中任务。已完成任务发生并发恢复或修改时不会强行删除，后续可在任务管理中取消或清理。
- 通用内置 Tool Registry 的步骤级持久执行账本、复合附件路由、证据等级、Agent 多轮工具循环和长对话结构化约束属于第二批，尚未在本批完成。
- 更全面的双语动态状态、真实任务质量与性能指标属于第三批。MemoryCore、外部 Harness 和供应商认证仍需目标环境验收。
