# 外发 Webhook 通知

Axiom 可以把任务完成、部分交付、任务失败、需要人工确认、插件失败、日程进入死信和 Artifact 清理失败等真实站内通知推送到用户自己的 HTTP 服务。渠道在页面右上角的“通知 → 外发通知”中管理。

## 请求格式

平台使用 `POST` 发送 JSON，请求头包含：

```text
content-type: application/json
x-axiom-delivery-id: <投递 ID>
x-axiom-event: <事件类型>
x-axiom-timestamp: <ISO 8601 时间>
x-axiom-signature: v1=<HMAC-SHA256 十六进制摘要>
```

请求体结构：

```json
{
  "deliveryId": "通知投递 ID",
  "event": "task_completed",
  "notification": {
    "id": "站内通知 ID",
    "kind": "task_completed",
    "title": "任务已完成",
    "message": "交付结果已经准备好"
  }
}
```

具体 `notification` 字段可能随事件类型增加。接收端应忽略不认识的附加字段，不应仅凭通知正文执行高风险操作。

## 验证签名

签名原文是时间戳、英文句点和原始 JSON 字节的拼接：

```text
<x-axiom-timestamp>.<raw JSON body>
```

使用渠道中配置的签名密钥计算 HMAC-SHA256，然后与 `x-axiom-signature` 中 `v1=` 后的十六进制摘要做常量时间比较。必须使用收到的原始请求体，不能先解析再重新序列化 JSON。

接收端还应检查时间戳与当前时间的差距，拒绝超出自己重放窗口的请求。平台在自动重试时会产生新的签名时间戳，但会保留相同的 `x-axiom-delivery-id`。

## 幂等处理

同一业务通知对同一渠道只会在 Outbox 中创建一次投递记录，但网络超时可能导致接收方已经处理成功、平台却没有收到响应。接收端必须把 `x-axiom-delivery-id` 作为幂等键保存；重复 ID 应返回成功，而不是再次执行副作用。

HTTP `2xx` 表示投递成功。`408`、`409`、`425`、`429` 和 `5xx` 会按指数退避重试；最多 5 次后进入死信。其他不可恢复的 `4xx` 会直接进入死信。用户可以在通知中心人工重投死信记录。

## 网络边界

- 公网渠道必须使用 HTTPS。
- 平台在实际发送前重新解析 DNS，并拒绝本机、私网、链路本地和云元数据地址。
- 请求不会自动跟随重定向，单次请求超时为 10 秒。
- 本地服务地址必须显式选择“本地服务”；正式环境只允许租户 `owner/admin` 配置本地网络渠道。

这些限制用于降低 SSRF 风险，但不能替代部署层的出口防火墙和域名允许清单。

## 密钥与保留期

设置 `AXIOM_NOTIFICATION_SECRET` 后，Webhook 地址和渠道签名密钥会使用 AES-256-GCM 加密保存。所有 Worker 必须使用同一个值；修改该值之前，应先暂停渠道并制定迁移方案，否则已有密文将无法解密。未单独配置时会回退到 `AXIOM_PROVIDER_SECRET`，正式部署建议使用独立密钥。

轮换接收方签名密钥时，先让接收方在短时间内同时接受新旧密钥，再在 Axiom 中更新渠道并发送测试消息，确认成功后撤销旧密钥。

删除渠道会擦除保存的地址与密钥。脱敏的成功、失败和死信审计默认保留 90 天；`AXIOM_NOTIFICATION_RETENTION_DAYS` 可设置为 1 至 365 天。

## 当前边界

本功能面向用户级业务通知。运行观测中的平台运营告警尚未自动发送到 Grafana Alerting、PagerDuty 或邮件；通用邮件渠道也尚未实现。正式上线前仍需使用真实 HTTPS 接收端和 PostgreSQL 多 Worker 完成重复投递、超时、死信、重投与密钥轮换演练。
