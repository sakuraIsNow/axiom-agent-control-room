# DeepSeek 原生能力边界

更新时间：2026-08-26

本文件把 DeepSeek 官方 API 能力和 Axiom 的执行能力分开。DeepSeek 负责模型推理、搜索和调用意图生成；任务持久化、权限、工具执行、记忆和多 Agent 编排仍由 Axiom 负责。

## Axiom 当前路由

| 场景 | Provider/API | 说明 |
| --- | --- | --- |
| 普通聊天 | `deepseek-chat` + `/chat/completions` | 默认文本模型 |
| 联网搜索 | `deepseek-v4-flash` + `/responses` + `web_search` | 仅搜索 Agent 使用；天气、论文、GitHub、新闻、价格和其他实时外部事实都只走该路径，失败时明确报错，不调用其他搜索源 |
| 图片理解 | `deepseek-v4-flash-vision-exp` | 图片消息自动切换视觉模型 |
| 图片复用 | `/files` + `file_id` | DeepSeek Provider 会优先上传图片，失败时保留 inline `image_url` |
| PDF/DOCX/TXT/MD | 本地解析后进入文本上下文；扫描 PDF 的前两页会转图片交给视觉模型 | DeepSeek Responses 不支持通用 `input_file` |
| 绘图/编辑 | DMX/Image Provider | DeepSeek 官方 API 文档当前未提供兼容的图像生成/编辑接口 |

## DeepSeek 原生可支持的能力

### Responses API

`POST /responses` 当前支持：

- `web_search`
- `function`
- `custom_tool`
- `input_image`
- `response.output_text.delta`
- `response.reasoning_text.delta`
- `response.completed`、`response.incomplete`、`response.failed`

Responses API 是无状态的。Axiom 必须在每次请求中自行发送会话历史，并保存 Session、Task、Event、Graph 和 checkpoint。

### Vision 和 Files API

`deepseek-v4-flash-vision-exp` 支持 JPEG、PNG、GIF、WebP，可以使用 Base64、HTTP(S) URL 或 Files API `file_id`。Files API 当前面向图片，不是 PDF、DOCX 或 Excel 的通用文件输入接口。

### Function Calls 和 JSON Output

Chat Completions 支持 `tools`、`tool_choice` 和 `response_format: { type: "json_object" }`。Responses 支持 `function` 和 `custom_tool`。模型只生成调用名称和参数，Axiom 必须继续执行：

DeepSeek Function Call 的函数名不能包含 `.`。Axiom 的 Tool Registry 仍保留 `workspace.read`、`database.query` 等真实名称，只在模型请求中使用 `axiom_workspace_read`、`axiom_database_query` 这类协议别名；模型返回后立即双向还原，后续白名单、参数校验、审批、配额、沙箱、审计和 Artifact lineage 全部使用真实名称。

```text
模型调用意图
-> Tool Registry 白名单和 schema
-> 风险审批、配额和超时
-> Docker 或受限适配器执行
-> 工具结果回传模型
```

`json_object` 只保证合法 JSON，Planner 仍然需要 Zod/JSON Schema 校验。高风险工具不能因为模型使用了 function call 就绕过人工审批或沙箱。

## DeepSeek 不原生提供的能力

| 能力 | 处理方式 |
| --- | --- |
| PDF/DOCX 页面布局、页码、表格和图片统一解析 | `pdf-parse` 页码/表格/页面截图、`mammoth`、Vision 和 Artifact 引用；完整引用定位仍待补充 |
| 浏览器点击、登录态、Cookie、JavaScript 和下载 | Axiom Browser/Playwright 工具 |
| PostgreSQL、SQLite、Git、Workspace、Docker、Shell | Axiom Tool Registry 和 Docker Sandbox |
| 长期记忆和向量检索 | MemoryCore/TencentDB 或其他 Memory Provider |
| 任务队列、Worker 租约、断点恢复、SSE 重放 | Axiom TaskStore、Scheduler、EventHub |
| Planner、Reviewer、Synthesizer、Agent Graph 和协作冲突 | Axiom WorkflowOrchestrator |
| 图片生成和图片编辑 | DMX 或其他 Image Provider |
| 天气和 GitHub 仓库结构化字段 | 由 DeepSeek 原生搜索回答；不再使用 Open-Meteo、GitHub API 或其他搜索源降级 |

## 对话语义路由

每条新消息在执行前先经过 `/api/chat/route` 语义分类，再进入对应的真实执行边界：

```text
普通寒暄 -> 对话 Agent
运行时 Agent/能力查询 -> Agent Registry + AgentStore/Provider 实时快照
天气、新闻、价格、当前事实 -> DeepSeek 联网搜索 Agent
论文、DOI、arXiv -> DeepSeek 论文搜索 Agent
GitHub/开源仓库 -> DeepSeek GitHub 研究 Agent
图片生成/编辑 -> 绘图 Agent + Image Provider
图片附件 -> 视觉分析 Agent
PDF/Word/TXT/MD/CSV -> 文档分析 Agent
普通任务 -> 按难度分配 direct / single-agent / team / full-workflow
```

搜索 Agent 与普通对话 Provider 解耦。即使用户为普通对话配置了非 DeepSeek Provider，所有需要实时检索的意图也只使用服务端默认 DeepSeek `deepseek-v4-flash` 原生搜索。原生搜索未配置或实际请求失败时会明确返回失败原因，不会进入 Bing、DuckDuckGo、Open-Meteo、GitHub API 或普通对话模型等降级路径。

Agent Registry 不再返回固定目录文案。它会读取当前内置编排角色、网关专用 Agent、可见的用户自定义 Agent、当前 Provider 配置，并对当前文本 Provider 执行实时可达性探测；“已配置”与“本次已验证可达”必须明确区分。

## 官方文档

- https://api-docs.deepseek.com/api/create-response
- https://api-docs.deepseek.com/guides/responses_api
- https://api-docs.deepseek.com/guides/vision
- https://api-docs.deepseek.com/guides/files_api
- https://api-docs.deepseek.com/guides/tool_calls
- https://api-docs.deepseek.com/api/create-chat-completion
