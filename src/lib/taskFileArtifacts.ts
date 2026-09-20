const types = new Map([['text/html', 'html'], ['image/svg+xml', 'svg'], ['text/markdown', 'md'], ['text/plain', 'txt']]);

export function taskFileArtifactPath(value: string | undefined, origin: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value, origin);
    if (url.origin !== origin || url.username || url.password || url.search || url.hash) return null;
    return /^\/api\/tasks\/[^/]+\/artifacts\/files\/[^/]+$/.test(url.pathname) ? url.pathname : null;
  } catch { return null; }
}

export type TaskFileArtifact = { content: string; mimeType: string; filename: string };

export async function readTaskFileArtifact(path: string, signal: AbortSignal): Promise<TaskFileArtifact> {
  const response = await fetch(path, { signal, credentials: 'same-origin', redirect: 'error' });
  if (!response.ok) throw new Error('File artifact is unavailable.');
  const mimeType = response.headers.get('x-axiom-artifact-mime-type') ?? '';
  const disposition = response.headers.get('content-disposition') ?? '';
  if (response.headers.get('content-type') !== 'application/octet-stream' || !types.has(mimeType) || !/^attachment;/i.test(disposition)) throw new Error('Unsupported file artifact.');
  const limit = 512_000;
  if (Number(response.headers.get('content-length') ?? 0) > limit) throw new Error('File artifact is too large.');
  if (!response.body) throw new Error('File artifact is empty.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0;
  let content = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error('File artifact is too large.');
      content += decoder.decode(value, { stream: true });
    }
    content += decoder.decode();
  } finally { await reader.cancel().catch(() => undefined); }
  let filename = `axiom-artifact.${types.get(mimeType)}`;
  const encodedName = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
  try {
    const decoded = encodedName && decodeURIComponent(encodedName);
    if (decoded && decoded.length <= 160 && !/[\\/\u0000-\u001f\u007f]/.test(decoded) && decoded.toLowerCase().endsWith(`.${types.get(mimeType)}`)) filename = decoded;
  } catch { /* A malformed optional filename must not block a safe download. */ }
  return { content, mimeType, filename };
}
