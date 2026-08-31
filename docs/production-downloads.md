# Production Downloads

当前代码已经可以在本机用已有 Docker 镜像运行 PostgreSQL 和 Docker sandbox，不需要额外下载才能完成本地验证。

## 已可复用

- `postgres:15` / `postgres:15-alpine`: PostgreSQL lease store。
- `ubuntu:22.04`: Docker sandbox image（当前本机 amd64 镜像）。
- `redis:7.4`: 可用于后续 scheduler/event fan-out，但当前没有强制依赖 Redis。

## 建议手动下载的可选组件

这些组件不是当前开发启动的硬依赖，网络受限时可以先手动下载或放入企业私有 npm registry。

| 组件 | 用途 | 何时需要 |
| --- | --- | --- |
| `@opentelemetry/sdk-node` | trace 自动采集 | 接入 OTLP Collector 时 |
| `@opentelemetry/exporter-trace-otlp-http` | OTLP trace exporter | 发送 trace 到 Tempo/Jaeger/Collector |
| `@opentelemetry/exporter-metrics-otlp-http` | OTLP metrics exporter | 不使用 Prometheus scrape 时 |
| `prom-client` | Node 指标注册与 Histogram | 需要更细的 runtime 指标时 |
| `@aws-sdk/client-s3` | S3/COS/MinIO Artifact 存储（项目已接入） | 离线安装依赖或更新锁文件时 |
| `@modelcontextprotocol/sdk` | MCP Tool Registry | 接入外部 MCP 工具时 |
| `bullmq` + `ioredis` | 多实例持久化定时任务 | 当前内存 scheduler 升级为集群调度时 |
| `@fastify/secure-session` 或企业 IdP SDK | OIDC/RBAC 会话 | 不使用反向代理认证时 |

## 外部服务

- TencentDB Agent Memory / MemoryCore Gateway：配置 `TDAI_MEMORY_ENDPOINT`。
- DeepSeek Harness sidecar：配置 `DEEPSEEK_HARNESS_URL`，并且必须通过 `deepseek-harness/v1` capability handshake。
- OpenTelemetry Collector + Prometheus：配置 `OTEL_EXPORTER_OTLP_ENDPOINT` 或 `PROMETHEUS_ENABLED=true`。
- S3/COS/MinIO：配置 `AXIOM_OBJECT_STORAGE_ENDPOINT`。AWS 默认可写成 `s3://bucket/prefix`；MinIO/COS 可写成 `http://minio:9000/bucket/prefix` 或服务商 HTTPS endpoint，并设置 `AXIOM_OBJECT_STORAGE_BUCKET`、区域和访问凭据。服务启动时会通过 `HeadBucket` 探测可达性，失败会显示 degraded，不会伪报 ready。

配置对象存储后运行 `npm run qa:object-storage`，它会用两份独立 Store 验证跨 Worker 读写、同名 Artifact 的租户隔离、租户级删除和约 1 MB 大对象回读。没有 endpoint 时该检查会明确标记为 skipped，不会把本地文件目录当成多实例验收结果。受网络限制时可手动下载并固定 MinIO 镜像版本，再设置 `AXIOM_OBJECT_STORAGE_ENDPOINT=http://127.0.0.1:9000/<bucket>/axiom-artifacts`、`AXIOM_OBJECT_STORAGE_ACCESS_KEY` 和 `AXIOM_OBJECT_STORAGE_SECRET_KEY`。

## 手动下载建议

```bash
npm pack @opentelemetry/sdk-node @opentelemetry/exporter-trace-otlp-http @opentelemetry/exporter-metrics-otlp-http
npm pack @aws-sdk/client-s3 @modelcontextprotocol/sdk bullmq ioredis prom-client
```

下载后的包可上传到内网制品库；不要把 API Key、数据库密码或下载包中的 `.env` 文件提交到项目。
