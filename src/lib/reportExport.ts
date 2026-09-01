import type { FileAttachment, ReportExportDecision } from '../types';

const readError = async (response: Response) => {
  const body = await response.json().catch(() => null) as { error?: string } | null;
  return body?.error ?? `报告生成服务返回 HTTP ${response.status}。`;
};

const fileNameFromDisposition = (value: string | null, format: ReportExportDecision['format']) => {
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(value ?? '')?.[1];
  if (encoded) {
    try { return decodeURIComponent(encoded); } catch { /* fall through */ }
  }
  return `Axiom-报告.${format}`;
};

const blobAsDataUrl = (blob: Blob) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader();
  reader.onerror = () => reject(reader.error ?? new Error('报告文件读取失败。'));
  reader.onload = () => resolve(String(reader.result ?? ''));
  reader.readAsDataURL(blob);
});

export async function exportConversationReport(input: {
  sessionId: string;
  instruction: string;
  decision: ReportExportDecision;
  modelCredentialId?: string;
}, signal: AbortSignal): Promise<FileAttachment> {
  const response = await fetch('/api/reports/export', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: input.sessionId,
      instruction: input.instruction,
      scope: input.decision.scope,
      format: input.decision.format,
      title: input.decision.title,
      modelCredentialId: input.modelCredentialId,
    }),
    signal,
  });
  if (!response.ok) throw new Error(await readError(response));
  const blob = await response.blob();
  const name = fileNameFromDisposition(response.headers.get('content-disposition'), input.decision.format);
  return {
    id: crypto.randomUUID(),
    kind: 'file',
    name,
    mimeType: blob.type || response.headers.get('content-type') || 'application/octet-stream',
    size: blob.size,
    dataUrl: await blobAsDataUrl(blob),
  };
}

export function downloadReportAttachment(attachment: FileAttachment) {
  if (!attachment.dataUrl) return;
  const anchor = document.createElement('a');
  anchor.href = attachment.dataUrl;
  anchor.download = attachment.name;
  anchor.rel = 'noopener';
  anchor.click();
}
