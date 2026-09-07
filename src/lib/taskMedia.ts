export function taskMediaPath(value: string | undefined, origin: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value, origin);
    if (url.origin !== origin || url.username || url.password || url.search || url.hash) return null;
    return /^\/api\/tasks\/[^/]+\/artifacts\/media\/[^/]+$/.test(url.pathname) ? url.pathname : null;
  } catch { return null; }
}

export async function readTaskMedia(path: string, signal: AbortSignal): Promise<Blob> {
  const response = await fetch(path, { signal, credentials: 'same-origin' });
  if (!response.ok) throw new Error('Media is unavailable.');
  const type = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (!/^(image\/(png|jpeg|gif|webp|avif)|video\/(mp4|webm|quicktime))$/.test(type)) throw new Error('Unsupported media type.');
  const limit = 128 * 1024 * 1024;
  if (Number(response.headers.get('content-length') ?? 0) > limit) throw new Error('Media is too large to preview.');
  if (!response.body) throw new Error('Media is empty.');
  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error('Media is too large to preview.');
      chunks.push(new Uint8Array(value));
    }
  } finally { await reader.cancel().catch(() => undefined); }
  return new Blob(chunks, { type });
}
