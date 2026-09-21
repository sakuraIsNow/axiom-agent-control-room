import { isIP } from 'node:net';

export type ProviderLocation = 'internet' | 'local';

const exactHostname = (value: string) => {
  const hostname = value.toLowerCase();
  if (!hostname || hostname.length > 253 || !hostname.split('.').every((label) =>
    label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) return null;
  return hostname;
};

// Only deployment configuration can classify a custom DNS name as private.
const configuredLocalModelHosts = () => new Set((process.env.AXIOM_LOCAL_MODEL_HOSTS ?? '').split(',')
  .map((value) => exactHostname(value.trim())).filter((value): value is string => value !== null));

export const defaultProviderLocation = (baseUrl: string): ProviderLocation => {
  try { return isLocalProviderHostname(new URL(baseUrl).hostname) ? 'local' : 'internet'; }
  catch { return 'internet'; }
};

export const isLocalProviderHostname = (rawHostname: string) => {
  let hostname = rawHostname.toLowerCase();
  if (hostname.startsWith('[') || hostname.endsWith(']')) {
    if (!hostname.startsWith('[') || !hostname.endsWith(']') || isIP(hostname.slice(1, -1)) !== 6) return false;
    hostname = hostname.slice(1, -1);
  }
  if (!exactHostname(hostname) && isIP(hostname) !== 6) return false;
  if (configuredLocalModelHosts().has(hostname)) return true;
  if (hostname === 'localhost' || hostname === '::1' || hostname === 'host.docker.internal' || hostname.endsWith('.local')) return true;
  if (!hostname.includes('.') && !hostname.includes(':')) return true;
  if (/^127\./.test(hostname) || /^10\./.test(hostname) || /^192\.168\./.test(hostname) || /^169\.254\./.test(hostname)) return true;
  const privateV4 = hostname.match(/^172\.(\d{1,3})\./);
  if (privateV4 && Number(privateV4[1]) >= 16 && Number(privateV4[1]) <= 31) return true;
  return /^(?:fc|fd|fe8|fe9|fea|feb)[0-9a-f]*:/i.test(hostname);
};

export const normalizeProviderBaseUrl = (value: string, fallback: string, location: ProviderLocation = 'internet') => {
  const candidate = value.trim() || fallback;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error('Provider URL must be a valid http(s) URL.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Provider URL must use http or https.');
  }
  const localHost = isLocalProviderHostname(parsed.hostname);
  if (location === 'local' && !localHost) throw new Error('选择“本地服务”时，API URL 必须使用本机、局域网或本地域名。');
  if (location === 'internet' && localHost) throw new Error('当前 API URL 是本地或局域网地址，请把服务类型切换为“本地服务”。');
  return candidate.replace(/\/$/, '');
};
