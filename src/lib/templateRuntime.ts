import type { BuiltInTemplate, WorkflowTemplate, WorkflowTemplateVisibility } from '../types';

const json = async <T>(response: Response, fallback: string) => {
  const body = await response.json().catch(() => null) as (T & { error?: string }) | null;
  if (!response.ok) throw new Error(body?.error ?? `${fallback} (${response.status})`);
  return body as T;
};

export async function listWorkflowTemplates(signal?: AbortSignal) {
  const response = await fetch('/api/templates?limit=50', { signal });
  const body = await json<{ templates?: WorkflowTemplate[] }>(response, '模板列表读取失败');
  return body.templates ?? [];
}

export async function listBuiltInTemplates(signal?: AbortSignal) {
  const response = await fetch('/api/template-catalog', { signal });
  const body = await json<{ templates?: BuiltInTemplate[] }>(response, '标准模板读取失败');
  return body.templates ?? [];
}

export async function createTemplateFromCatalog(catalogId: string, visibility: WorkflowTemplateVisibility = 'private') {
  const response = await fetch('/api/templates/from-catalog', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ catalogId, visibility }),
  });
  return (await json<{ template: WorkflowTemplate }>(response, '标准模板创建失败')).template;
}

export async function publishWorkflowTemplate(templateId: string) {
  const response = await fetch(`/api/templates/${encodeURIComponent(templateId)}/publish`, { method: 'POST' });
  return (await json<{ template: WorkflowTemplate }>(response, '模板发布失败')).template;
}

export async function shareWorkflowTemplate(templateId: string, shared: boolean) {
  const action = shared ? 'share' : 'unshare';
  const response = await fetch(`/api/templates/${encodeURIComponent(templateId)}/${action}`, { method: 'POST' });
  return (await json<{ template: WorkflowTemplate }>(response, shared ? '模板共享失败' : '模板取消共享失败')).template;
}

export async function importWorkflowTemplate(bundle: unknown) {
  const response = await fetch('/api/templates/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(bundle),
  });
  return (await json<{ template: WorkflowTemplate }>(response, '模板导入失败')).template;
}

export async function exportWorkflowTemplate(template: WorkflowTemplate) {
  const response = await fetch(`/api/templates/${encodeURIComponent(template.id)}/export`);
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(body?.error ?? `模板导出失败 (${response.status})`);
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${template.name.replace(/[^\w\u4e00-\u9fff-]+/g, '-').slice(0, 48) || 'axiom-template'}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}
