import type { ChangeEvent } from 'react';
import { Download, FolderKanban, Plus, RefreshCw, Upload, Users } from 'lucide-react';
import type { BuiltInTemplate, WorkflowTemplate } from '../../types';

export type TemplateWorkspaceProps = {
  templates: WorkflowTemplate[];
  catalog: BuiltInTemplate[];
  busy: boolean;
  error: string | null;
  selectedTemplateId: string | null;
  onRefresh: () => void;
  onImport: (event: ChangeEvent<HTMLInputElement>) => void;
  onCreateFromCatalog: (catalogId: string) => void;
  onPublish: (templateId: string) => void;
  onShare: (template: WorkflowTemplate) => void;
  onExport: (template: WorkflowTemplate) => void;
  onUse: (template: WorkflowTemplate) => void;
};

const statusLabel: Record<WorkflowTemplate['status'], string> = {
  draft: '草稿',
  published: '可执行',
  archived: '已归档',
};

export function TemplateWorkspace(props: TemplateWorkspaceProps) {
  const {
    templates, catalog, busy, error, selectedTemplateId, onRefresh, onImport, onCreateFromCatalog,
    onPublish, onShare, onExport, onUse,
  } = props;
  const publishedCount = templates.filter((template) => template.status === 'published').length;

  return <div className="dash-template-workspace">
    <header className="dash-workspace-heading">
      <div><span>复用稳定流程</span><h1>模板库</h1></div>
      <div className="dash-workspace-actions">
        <span>{publishedCount} 个可用</span>
        <button type="button" aria-label="刷新模板" title="刷新" onClick={onRefresh} disabled={busy}>
          <RefreshCw size={16} className={busy ? 'spin' : ''} />
        </button>
        <label className="dash-template-import">
          <Upload size={16} />导入
          <input type="file" accept="application/json,.json" onChange={onImport} disabled={busy} />
        </label>
      </div>
    </header>

    {error && <div className="dash-template-error">{error}</div>}

    <section className="dash-template-section" aria-labelledby="template-catalog-title">
      <div className="dash-template-section-heading">
        <div><span>快速开始</span><h2 id="template-catalog-title">标准模板</h2></div>
        <small>{catalog.length} 个模板</small>
      </div>
      <div className="dash-template-grid">
        {catalog.map((item) => <article className="dash-template-card glass-panel" key={item.id}>
          <span className="dash-template-icon"><FolderKanban size={19} /></span>
          <div><strong>{item.name}</strong><p>{item.description}</p></div>
          <button type="button" onClick={() => onCreateFromCatalog(item.id)} disabled={busy}><Plus size={15} />创建草稿</button>
        </article>)}
        {!busy && catalog.length === 0 && <div className="dash-template-empty glass-panel"><FolderKanban size={24} /><strong>暂无标准模板</strong></div>}
      </div>
    </section>

    <section className="dash-template-section" aria-labelledby="workspace-templates-title">
      <div className="dash-template-section-heading">
        <div><span>个人与团队</span><h2 id="workspace-templates-title">我的模板</h2></div>
        <small>{templates.length} 个模板</small>
      </div>
      <div className="dash-template-list">
        {templates.length === 0 ? <div className="dash-template-empty glass-panel">
          <FolderKanban size={24} /><strong>{busy ? '正在读取模板' : '还没有模板'}</strong><span>可从标准模板创建，或导入 JSON 模板</span>
        </div> : templates.map((template) => {
          const selected = selectedTemplateId === template.id;
          return <article className={`dash-template-item glass-panel ${template.status} ${selected ? 'selected' : ''}`} key={template.id}>
            <span className={`dash-template-status ${template.status}`} />
            <div className="dash-template-copy">
              <strong data-i18n-ignore="true">{template.name}</strong>
              <small>{template.visibility === 'team' ? '团队共享' : '仅自己'} · v{template.version} · {statusLabel[template.status]}</small>
              <p data-i18n-ignore={Boolean(template.description)}>{template.description || '未填写模板说明'}</p>
            </div>
            <div className="dash-template-actions">
              {template.status === 'published' && <button type="button" className={selected ? 'selected' : 'primary'} onClick={() => onUse(template)} disabled={busy}>{selected ? '已选择' : '使用'}</button>}
              {template.status === 'draft' && <button type="button" className="primary" onClick={() => onPublish(template.id)} disabled={busy}>发布</button>}
              {template.status !== 'archived' && <button type="button" onClick={() => onShare(template)} disabled={busy}><Users size={14} />{template.visibility === 'team' ? '取消共享' : '共享'}</button>}
              <button type="button" onClick={() => onExport(template)} disabled={busy}><Download size={14} />导出</button>
            </div>
          </article>;
        })}
      </div>
    </section>
  </div>;
}
