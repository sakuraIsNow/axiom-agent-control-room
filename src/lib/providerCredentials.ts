import type { ProviderLocation, ProviderServiceSettings } from '../types';

export type ProviderCredentialKind = 'text' | 'vision' | 'image' | 'video';

export type ProviderCredential = {
  id: string;
  kind: ProviderCredentialKind;
  name: string;
  apiUrl: string;
  model: string;
  location: ProviderLocation;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
  hasApiKey: boolean;
};

const headers = { 'Content-Type': 'application/json' };

export async function saveProviderCredential(input: {
  kind: ProviderCredentialKind;
  name: string;
  settings: ProviderServiceSettings;
}): Promise<ProviderCredential> {
  const response = await fetch('/api/providers/credentials', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      id: input.settings.credentialId || undefined,
      kind: input.kind,
      name: input.name,
      apiUrl: input.settings.apiUrl.trim(),
      apiKey: input.settings.apiKey,
      model: input.settings.model.trim(),
      location: input.settings.location,
    }),
  });
  const body = await response.json().catch(() => null) as { credential?: ProviderCredential; error?: string } | null;
  if (!response.ok || !body?.credential) throw new Error(body?.error ?? `凭据保存失败（HTTP ${response.status}）`);
  return body.credential;
}

export async function listProviderCredentials(kind?: ProviderCredentialKind): Promise<ProviderCredential[]> {
  const query = kind ? `?kind=${encodeURIComponent(kind)}` : '';
  const response = await fetch(`/api/providers/credentials${query}`, { headers: { Accept: 'application/json' } });
  const body = await response.json().catch(() => null) as { credentials?: ProviderCredential[]; error?: string } | null;
  if (!response.ok) throw new Error(body?.error ?? `凭据读取失败（HTTP ${response.status}）`);
  return Array.isArray(body?.credentials) ? body.credentials : [];
}

export async function deleteProviderCredential(id: string): Promise<void> {
  const response = await fetch(`/api/providers/credentials/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error ?? `凭据删除失败（HTTP ${response.status}）`);
  }
}
