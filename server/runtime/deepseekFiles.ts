import { createHash } from 'node:crypto';

export type DeepSeekImageProvider = {
  apiKey: string;
  baseUrl: string;
  model: string;
};

export type DeepSeekImagePart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'file'; file: { file_id: string } };

export type DeepSeekImageMessage = {
  role: 'user' | 'assistant';
  content: string | DeepSeekImagePart[];
};

const cache = new Map<string, { fileId: string; expiresAt: number }>();

const endpoint = (baseUrl: string, suffix: string) => {
  if (baseUrl.endsWith(suffix)) return baseUrl;
  if (suffix.startsWith('/v1/') && baseUrl.endsWith('/v1')) return `${baseUrl}${suffix.slice(3)}`;
  return `${baseUrl}${suffix}`;
};

const deepSeekApiHost = (baseUrl: string) => {
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return hostname === 'api.deepseek.com' || hostname.endsWith('.deepseek.com');
  } catch {
    return false;
  }
};

const requestSignal = (signal: AbortSignal, timeoutMs: number) =>
  AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);

const dataUrlBytes = (dataUrl: string) => {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/s);
  if (!match) return null;
  const bytes = Buffer.from(match[2], 'base64');
  return bytes.byteLength ? { contentType: match[1], bytes } : null;
};

export const uploadDeepSeekImage = async (
  provider: DeepSeekImageProvider,
  dataUrl: string,
  signal: AbortSignal,
  enabled = true,
) => {
  if (!enabled || !deepSeekApiHost(provider.baseUrl)) return null;
  const decoded = dataUrlBytes(dataUrl);
  if (!decoded || decoded.bytes.byteLength > 64 * 1024 * 1024) return null;
  const digest = createHash('sha256').update(decoded.bytes).digest('hex');
  const cacheKey = `${provider.baseUrl}|${provider.model}|${digest}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.fileId;

  const form = new FormData();
  form.append('file', new Blob([decoded.bytes], { type: decoded.contentType }), `axiom-${digest.slice(0, 16)}`);
  form.append('purpose', 'user_data');
  form.append('expires_after[anchor]', 'created_at');
  form.append('expires_after[seconds]', '86400');
  const baseUrl = provider.baseUrl.replace(/\/v1$/i, '');
  const response = await fetch(endpoint(baseUrl, '/files'), {
    method: 'POST',
    headers: { Authorization: `Bearer ${provider.apiKey}` },
    body: form,
    signal: requestSignal(signal, 60_000),
  });
  const payload = await response.json().catch(() => null) as { id?: string; error?: { message?: string } } | null;
  if (!response.ok || !payload?.id) throw new Error(`DeepSeek Files API failed (${response.status}): ${payload?.error?.message ?? 'missing file id'}`);
  cache.set(cacheKey, { fileId: payload.id, expiresAt: Date.now() + 23 * 60 * 60 * 1_000 });
  if (cache.size > 64) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  return payload.id;
};

export const prepareDeepSeekImageFiles = async (
  messages: DeepSeekImageMessage[],
  provider: DeepSeekImageProvider,
  signal: AbortSignal,
  enabled = true,
) => {
  if (!enabled || !deepSeekApiHost(provider.baseUrl)) return { messages, uploaded: 0 };
  let uploaded = 0;
  const prepared = await Promise.all(messages.map(async (message) => {
    if (!Array.isArray(message.content)) return message;
    const content = await Promise.all(message.content.map(async (part) => {
      if (part.type !== 'image_url' || !part.image_url.url.startsWith('data:image/')) return part;
      try {
        const fileId = await uploadDeepSeekImage(provider, part.image_url.url, signal, enabled);
        if (!fileId) return part;
        uploaded += 1;
        return { type: 'file' as const, file: { file_id: fileId } };
      } catch {
        return part;
      }
    }));
    return { ...message, content };
  }));
  return { messages: prepared, uploaded };
};
