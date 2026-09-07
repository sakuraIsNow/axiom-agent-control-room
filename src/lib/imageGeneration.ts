import type {
  ImageRequest,
  ImageResponse,
  ImageProviderSettings,
} from '../types';
import { getWorkflowTask, streamWorkflowEvents } from './taskRuntime';

export async function generateImage(
  request: ImageRequest,
  provider: ImageProviderSettings,
  signal: AbortSignal,
): Promise<ImageResponse> {
  const response = await fetch('/api/images', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...request,
      provider: provider.useCustom
        ? {
            ...(provider.credentialId ? { credentialId: provider.credentialId } : { apiUrl: provider.apiUrl.trim(), apiKey: provider.apiKey }),
            model: provider.model.trim(),
            location: provider.location,
          }
        : undefined,
    }),
    signal,
  });

  const body = (await response.json().catch(() => null)) as
    | (ImageResponse & { error?: string; task?: { id?: string } })
    | null;

  if (!response.ok) {
    throw new Error(body?.error ?? `图像网关返回 HTTP ${response.status}。`);
  }

  if (response.status === 202 && body?.task?.id) {
    const taskId = body.task.id;
    const startedAt = Date.now();
    await streamWorkflowEvents(taskId, signal, () => undefined);
    const task = await getWorkflowTask(taskId, signal);
    if (task.status !== 'completed') throw new Error('绘图任务已保留，请在任务管理中查看或处理后继续。');
    const images = [...(task.result ?? '').matchAll(/!\[([^\]]*)\]\(([^\s)]+)\)/g)]
      .map((match, index) => ({ id: `${taskId}-${index}`, url: match[2], alt: match[1] || 'Agent image' }));
    if (!images.length) throw new Error('任务未提供可用图片，请在任务管理中核对结果。');
    return { images, model: provider.model || task.model || 'image-provider', durationMs: Date.now() - startedAt };
  }

  if (!body?.images?.length) {
    throw new Error('图像模型服务没有返回可用图片。');
  }

  return body;
}

export function readImageAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Unable to read the selected image.'));
    reader.onload = () => {
      if (typeof reader.result !== 'string') {
        reject(new Error('Selected image has an unsupported format.'));
        return;
      }
      resolve(reader.result);
    };
    reader.readAsDataURL(file);
  });
}
