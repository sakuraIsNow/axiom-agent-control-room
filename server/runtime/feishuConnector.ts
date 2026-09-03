import type { IntegrationCredentialResolved } from './integrationCredentialStore.js';

const FEISHU_BASE = 'https://open.feishu.cn';

const feishuJson = async (path: string, init: RequestInit, fetchImpl: typeof fetch = fetch, timeoutMs = 15_000) => {
  const response = await fetchImpl(`${FEISHU_BASE}${path}`, { ...init, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  const text = (await response.text()).slice(0, 500_000);
  let body: Record<string, unknown>;
  try { body = JSON.parse(text) as Record<string, unknown>; } catch { throw new Error(`飞书返回了无法解析的响应（HTTP ${response.status}）。`); }
  if (!response.ok || Number(body.code ?? 0) !== 0) throw new Error(`飞书请求失败：${String(body.msg ?? `HTTP ${response.status}`).slice(0, 300)}`);
  return body;
};

export const acquireFeishuTenantToken = async (credential: Pick<IntegrationCredentialResolved, 'secrets'>, fetchImpl: typeof fetch = fetch) => {
  const appId = credential.secrets.appId?.trim();
  const appSecret = credential.secrets.appSecret?.trim();
  if (!appId || !appSecret) throw new Error('飞书连接缺少 App ID 或 App Secret。');
  const startedAt = Date.now();
  const payload = await feishuJson('/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  }, fetchImpl);
  const accessToken = typeof payload.tenant_access_token === 'string' ? payload.tenant_access_token : '';
  if (!accessToken) throw new Error('飞书没有返回 tenant_access_token。');
  return { accessToken, expiresIn: Number(payload.expire ?? 0), latencyMs: Date.now() - startedAt };
};

const authHeaders = (accessToken: string) => ({ Authorization: `Bearer ${accessToken}`, Accept: 'application/json' });

export const invokeFeishuOperation = async (credential: IntegrationCredentialResolved, operationId: string, args: Record<string, unknown>, fetchImpl: typeof fetch = fetch) => {
  const { accessToken } = await acquireFeishuTenantToken(credential, fetchImpl);
  const values = operationId === 'feishu.send_message' && args.body && typeof args.body === 'object' && !Array.isArray(args.body)
    ? args.body as Record<string, unknown>
    : args;
  let payload: Record<string, unknown>;
  if (operationId === 'feishu.read_document') {
    const documentId = encodeURIComponent(String(args.documentId ?? ''));
    payload = await feishuJson(`/open-apis/docx/v1/documents/${documentId}/blocks?page_size=${Math.min(500, Math.max(1, Number(args.pageSize ?? 100)))}`, { method: 'GET', headers: authHeaders(accessToken) }, fetchImpl);
  } else if (operationId === 'feishu.list_calendars') {
    const pageSize = Math.min(500, Math.max(1, Number(args.pageSize ?? 50)));
    payload = await feishuJson(`/open-apis/calendar/v4/calendars?page_size=${pageSize}`, { method: 'GET', headers: authHeaders(accessToken) }, fetchImpl);
  } else if (operationId === 'feishu.list_messages') {
    const query = new URLSearchParams({
      container_id_type: 'chat', container_id: String(args.chatId ?? ''),
      page_size: String(Math.min(50, Math.max(1, Number(args.pageSize ?? 20)))), sort_type: 'ByCreateTimeDesc',
    });
    payload = await feishuJson(`/open-apis/im/v1/messages?${query}`, { method: 'GET', headers: authHeaders(accessToken) }, fetchImpl);
  } else if (operationId === 'feishu.send_message') {
    const receiveIdType = String(values.receiveIdType ?? 'chat_id');
    const query = new URLSearchParams({ receive_id_type: receiveIdType });
    payload = await feishuJson(`/open-apis/im/v1/messages?${query}`, {
      method: 'POST', headers: { ...authHeaders(accessToken), 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ receive_id: String(values.receiveId ?? ''), msg_type: 'text', content: JSON.stringify({ text: String(values.text ?? '') }) }),
    }, fetchImpl);
  } else {
    throw new Error(`飞书连接器不支持操作 ${operationId}。`);
  }
  return { content: JSON.stringify(payload, null, 2).slice(0, 200_000), responseStatus: 200, ok: true };
};

export const feishuOpenApiSpecification = {
  openapi: '3.1.0',
  info: { title: 'Axiom 飞书协作连接器', version: '1.0.0' },
  servers: [{ url: FEISHU_BASE }],
  paths: {
    '/open-apis/docx/v1/documents/{documentId}/blocks': { get: { operationId: 'feishu.read_document', summary: '读取飞书云文档内容块', parameters: [{ name: 'documentId', in: 'path', required: true, schema: { type: 'string', maxLength: 160 } }, { name: 'pageSize', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 500 } }] } },
    '/open-apis/calendar/v4/calendars': { get: { operationId: 'feishu.list_calendars', summary: '读取可访问的飞书日历', parameters: [{ name: 'pageSize', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 500 } }] } },
    '/open-apis/im/v1/messages': {
      get: { operationId: 'feishu.list_messages', summary: '读取飞书群聊消息', parameters: [{ name: 'chatId', in: 'query', required: true, schema: { type: 'string', maxLength: 160 } }, { name: 'pageSize', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 50 } }] },
      post: { operationId: 'feishu.send_message', summary: '向飞书用户或群聊发送文本消息', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { receiveIdType: { type: 'string', enum: ['chat_id', 'open_id', 'user_id', 'union_id', 'email'] }, receiveId: { type: 'string', maxLength: 160 }, text: { type: 'string', maxLength: 20_000 } }, required: ['receiveIdType', 'receiveId', 'text'], additionalProperties: false } } } } },
    },
  },
} as const;
