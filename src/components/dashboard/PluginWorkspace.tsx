import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Bot, Check, ExternalLink, History, Maximize2, Pencil, Play, Plus, RefreshCw, RotateCcw, Save, Send, ShieldAlert, ShieldCheck, Sparkles, Trash2, X } from 'lucide-react';
import type { AgentMode, PluginCompatibilityReport, PluginInputField, PluginVisualEffect, UserPlugin } from '../../types';
import { secureArtifactDocument } from '../../lib/chatArtifacts';
import { appearanceForPlugin, PluginGlyph, pluginEffects } from './PluginGlyph';

const modeLabels: Record<AgentMode, string> = { analyze: '分析', build: '构建', decide: '决策' };
const effectLabels: Record<PluginVisualEffect, string> = {
  aurora: '极光', plasma: '等离子', liquid: '液态', prism: '棱镜', solar: '日冕', nebula: '星云', chrome: '铬银', pulse: '脉冲',
};

export type PluginShellDraft = {
  name: string;
  description: string;
  visibility: 'private' | 'team';
  width: number;
  height: number;
  effect: PluginVisualEffect | 'random';
  hue: number;
};

export type PluginWorkspaceProps = {
  plugins: UserPlugin[];
  selectedPlugin: UserPlugin | null;
  busy: boolean;
  running: boolean;
  error: string | null;
  values: Record<string, string>;
  freeform: string;
  createOpen: boolean;
  shellDraft: PluginShellDraft;
  designerInput: string;
  agentLive: { user: string; status: string; progress: string; error?: string } | null;
  onRefresh: () => void;
  onSelect: (plugin: UserPlugin | null) => void;
  onOpenMiniApp: (plugin: UserPlugin) => void;
  onPublish: (plugin: UserPlugin) => void;
  onCheckCompatibility: (plugin: UserPlugin) => Promise<PluginCompatibilityReport>;
  onRollback: (plugin: UserPlugin, version: number) => Promise<void>;
  onResize: (plugin: UserPlugin, width: number, height: number) => Promise<void>;
  onDelete: (plugin: UserPlugin) => Promise<void>;
  onRun: () => void;
  onValuesChange: (values: Record<string, string>) => void;
  onFreeformChange: (value: string) => void;
  onOpenCreate: () => void;
  onCloseCreate: () => void;
  onShellDraftChange: (patch: Partial<PluginShellDraft>) => void;
  onCreateShell: () => void;
  onDesignerInputChange: (value: string) => void;
  onDesignWithAgent: () => void;
};

export function PluginWorkspace(props: PluginWorkspaceProps) {
  const {
    plugins, selectedPlugin, busy, running, error, values, freeform, createOpen, shellDraft, designerInput, agentLive,
    onRefresh, onSelect, onOpenMiniApp, onPublish, onCheckCompatibility, onRollback, onResize, onDelete, onRun, onValuesChange, onFreeformChange,
    onOpenCreate, onCloseCreate, onShellDraftChange, onCreateShell, onDesignerInputChange, onDesignWithAgent,
  } = props;
  const [pendingDelete, setPendingDelete] = useState<UserPlugin | null>(null);
  const [sizeEditorOpen, setSizeEditorOpen] = useState(false);
  const [lifecycleOpen, setLifecycleOpen] = useState(false);
  const [compatibility, setCompatibility] = useState<PluginCompatibilityReport | null>(null);
  const [compatibilityError, setCompatibilityError] = useState('');
  const [compatibilityBusy, setCompatibilityBusy] = useState(false);
  const [pendingRollback, setPendingRollback] = useState<number | null>(null);
  const [sizeDraft, setSizeDraft] = useState({ width: 720, height: 520 });
  const designMessagesRef = useRef<HTMLDivElement>(null);
  const selectedAppearance = useMemo(() => selectedPlugin ? appearanceForPlugin(selectedPlugin) : null, [selectedPlugin]);
  const selectedIsMiniApp = selectedPlugin?.kind === 'mini-app' && Boolean(selectedPlugin.definition.htmlContent);
  const designMessageCount = selectedPlugin?.definition.designConversation?.length ?? 0;

  useEffect(() => {
    const element = designMessagesRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
  }, [agentLive?.error, agentLive?.progress, agentLive?.status, designMessageCount, selectedPlugin?.id]);

  useEffect(() => {
    setSizeDraft({
      width: selectedPlugin?.definition.width ?? 720,
      height: selectedPlugin?.definition.height ?? 520,
    });
    setSizeEditorOpen(false);
    setLifecycleOpen(false);
    setCompatibility(null);
    setCompatibilityError('');
    setPendingRollback(null);
  }, [selectedPlugin?.id]);

  useEffect(() => {
    setCompatibility(null);
  }, [selectedPlugin?.version]);

  const checkCompatibility = async () => {
    if (!selectedPlugin || compatibilityBusy) return;
    setCompatibilityBusy(true);
    setCompatibilityError('');
    try {
      setCompatibility(await onCheckCompatibility(selectedPlugin));
    } catch (caught) {
      setCompatibilityError(caught instanceof Error ? caught.message : '插件检查失败');
    } finally {
      setCompatibilityBusy(false);
    }
  };

  const toggleLifecycle = () => {
    const next = !lifecycleOpen;
    setLifecycleOpen(next);
    if (next && !compatibility) void checkCompatibility();
  };

  const lifecyclePanel = selectedPlugin && lifecycleOpen
    ? <PluginLifecyclePanel plugin={selectedPlugin} report={compatibility} busy={busy || compatibilityBusy} error={compatibilityError} onRefresh={() => { void checkCompatibility(); }} onRollback={setPendingRollback} />
    : null;

  const sizeIsValid = Number.isInteger(sizeDraft.width) && sizeDraft.width >= 320 && sizeDraft.width <= 1_200
    && Number.isInteger(sizeDraft.height) && sizeDraft.height >= 240 && sizeDraft.height <= 900;

  if (selectedPlugin && selectedIsMiniApp && selectedAppearance) {
    const conversation = selectedPlugin.definition.designConversation ?? [];
    return <div className="dash-plugin-workspace dash-plugin-designer">
      <header className="dash-workspace-heading dash-plugin-designer-heading">
        <div><button type="button" className="dash-plugin-back" onClick={() => onSelect(null)}><ArrowLeft size={15} />返回插件</button><h1>{selectedPlugin.name}</h1></div>
        <div className="dash-workspace-actions">
          <button type="button" className="labeled" onClick={() => onOpenMiniApp(selectedPlugin)}><ExternalLink size={15} />打开</button>
          <button type="button" className="labeled" aria-expanded={sizeEditorOpen} onClick={() => setSizeEditorOpen((open) => !open)}><Maximize2 size={15} />窗口大小</button>
          <button type="button" className="labeled" aria-expanded={lifecycleOpen} onClick={toggleLifecycle}><History size={15} />版本与权限</button>
          {selectedPlugin.status === 'draft' && <button type="button" className="primary labeled" onClick={() => onPublish(selectedPlugin)} disabled={busy}><Check size={15} />发布</button>}
          <button type="button" aria-label="删除插件" title="删除" onClick={() => setPendingDelete(selectedPlugin)}><Trash2 size={15} /></button>
        </div>
      </header>
      {error && <div className="dash-plugin-error">{error}</div>}
      {sizeEditorOpen && <form className="dash-plugin-size-editor glass-panel" onSubmit={(event) => {
        event.preventDefault();
        if (!sizeIsValid || busy) return;
        void onResize(selectedPlugin, sizeDraft.width, sizeDraft.height).then(() => setSizeEditorOpen(false)).catch(() => undefined);
      }}>
        <span className="dash-plugin-size-title"><Maximize2 size={16} /><strong>窗口大小</strong></span>
        <label><span>宽度</span><input aria-label="插件窗口宽度" type="number" min={320} max={1200} step={1} value={sizeDraft.width} onChange={(event) => setSizeDraft((current) => ({ ...current, width: Number(event.target.value) }))} /><small>px</small></label>
        <label><span>高度</span><input aria-label="插件窗口高度" type="number" min={240} max={900} step={1} value={sizeDraft.height} onChange={(event) => setSizeDraft((current) => ({ ...current, height: Number(event.target.value) }))} /><small>px</small></label>
        <span className={`dash-plugin-size-range ${sizeIsValid ? '' : 'invalid'}`}>宽 320–1200 · 高 240–900</span>
        <button type="submit" className="primary labeled" disabled={busy || !sizeIsValid}><Save size={15} />{busy ? '正在保存' : '保存大小'}</button>
      </form>}
      {lifecyclePanel}
      <div className="dash-plugin-designer-layout">
        <section className="dash-plugin-design-chat glass-panel">
          <header><span><Bot size={15} />插件开发 Agent</span><small>版本 {selectedPlugin.version}</small></header>
          <div className="dash-plugin-design-messages" ref={designMessagesRef} aria-live="polite" aria-busy={Boolean(agentLive && !agentLive.error)}>
            {conversation.length === 0 && <div className="dash-plugin-design-empty"><PluginGlyph appearance={selectedAppearance} compact /><strong>描述你想实现的功能</strong><span>Agent 会生成完整插件并保留每次修改记录</span></div>}
            {conversation.map((message, index) => <article className={message.role} key={`${message.createdAt}-${index}`}><span>{message.role === 'user' ? '你' : 'Agent'}</span><p>{message.content}</p></article>)}
            {agentLive && <>
              <article className="user live"><span>你</span><p>{agentLive.user}</p></article>
              <article className={`assistant pending ${agentLive.error ? 'error' : ''}`}><span>Agent</span><p><Sparkles size={14} />{agentLive.error || agentLive.status}{agentLive.progress && !agentLive.error ? <small>{agentLive.progress}</small> : null}</p></article>
            </>}
          </div>
          <footer>
            <textarea rows={4} value={designerInput} disabled={busy} onChange={(event) => onDesignerInputChange(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); onDesignWithAgent(); } }} placeholder={conversation.length ? '说明需要增加或修改的功能' : '例如：做一个支持键盘和触屏操作的贪吃蛇游戏'} />
            <button type="button" className="primary" onClick={onDesignWithAgent} disabled={busy || designerInput.trim().length < 2}><Send size={15} />{busy ? '正在生成' : '发送'}</button>
          </footer>
        </section>
        <section className="dash-plugin-live-preview glass-panel">
          <header><span>实时预览</span><small>{selectedPlugin.definition.width ?? 720} x {selectedPlugin.definition.height ?? 520}</small></header>
          <iframe title={`${selectedPlugin.name} 预览`} srcDoc={secureArtifactDocument(selectedPlugin.definition.htmlContent ?? '', 'html')} sandbox="allow-scripts" referrerPolicy="no-referrer" />
        </section>
      </div>
      {pendingDelete && <PluginDeleteDialog plugin={pendingDelete} busy={busy} onCancel={() => setPendingDelete(null)} onConfirm={async () => { await onDelete(pendingDelete); setPendingDelete(null); }} />}
      {pendingRollback !== null && <PluginRollbackDialog plugin={selectedPlugin} version={pendingRollback} busy={busy} onCancel={() => setPendingRollback(null)} onConfirm={async () => { await onRollback(selectedPlugin, pendingRollback); setPendingRollback(null); }} />}
    </div>;
  }

  if (selectedPlugin) {
    return <div className="dash-plugin-workspace">
      <header className="dash-workspace-heading"><div><button type="button" className="dash-plugin-back" onClick={() => onSelect(null)}><ArrowLeft size={15} />返回插件</button><h1>{selectedPlugin.name}</h1></div><div className="dash-workspace-actions"><button type="button" className="labeled" aria-expanded={lifecycleOpen} onClick={toggleLifecycle}><History size={15} />版本与权限</button>{selectedPlugin.status === 'draft' && <button type="button" className="primary labeled" onClick={() => onPublish(selectedPlugin)} disabled={busy}><Check size={15} />发布</button>}<button type="button" aria-label="删除插件" title="删除" onClick={() => setPendingDelete(selectedPlugin)}><Trash2 size={15} /></button></div></header>
      {error && <div className="dash-plugin-error">{error}</div>}
      {lifecyclePanel}
      <section className="dash-plugin-run glass-panel">
        <p>{selectedPlugin.description || '填写本次任务内容，然后交给 Agent 执行。'}</p>
        <div className="dash-plugin-run-fields">
          {(selectedPlugin.definition.inputSchema?.fields ?? []).map((field) => <PluginField key={field.id} field={field} values={values} onValuesChange={onValuesChange} />)}
          <label className="wide"><span>任务内容</span><textarea rows={7} value={freeform} onChange={(event) => onFreeformChange(event.target.value)} placeholder="输入这次要处理的内容" /></label>
        </div>
        <footer><span>版本 {selectedPlugin.version} · {modeLabels[selectedPlugin.definition.mode]}</span><button type="button" className="primary" onClick={onRun} disabled={busy || running}><Play size={16} />{busy ? '正在启动' : '运行插件'}</button></footer>
      </section>
      {pendingDelete && <PluginDeleteDialog plugin={pendingDelete} busy={busy} onCancel={() => setPendingDelete(null)} onConfirm={async () => { await onDelete(pendingDelete); setPendingDelete(null); }} />}
      {pendingRollback !== null && <PluginRollbackDialog plugin={selectedPlugin} version={pendingRollback} busy={busy} onCancel={() => setPendingRollback(null)} onConfirm={async () => { await onRollback(selectedPlugin, pendingRollback); setPendingRollback(null); }} />}
    </div>;
  }

  return <div className="dash-plugin-workspace">
    <header className="dash-workspace-heading">
      <div><span>可复用工具</span><h1>插件</h1></div>
      <div className="dash-workspace-actions">
        <span>{plugins.length} 个插件</span>
        <button type="button" aria-label="刷新插件" title="刷新" onClick={onRefresh} disabled={busy}><RefreshCw size={16} className={busy ? 'spin' : ''} /></button>
        <button type="button" className="primary labeled" onClick={onOpenCreate}><Sparkles size={16} />Agent 创建</button>
      </div>
    </header>
    {error && <div className="dash-plugin-error">{error}</div>}

    {createOpen && <section className="dash-plugin-shell-create glass-panel">
      <div className="dash-plugin-section-title"><div><strong>新插件</strong><span>先确定外观和窗口，再由 Agent 完成功能</span></div><button type="button" aria-label="关闭创建表单" onClick={onCloseCreate}><X size={16} /></button></div>
      <div className="dash-plugin-shell-grid">
        <div className="dash-plugin-shell-form">
          <label><span>名称</span><input value={shellDraft.name} onChange={(event) => onShellDraftChange({ name: event.target.value })} placeholder="例如：实时天气" /></label>
          <label><span>说明</span><input value={shellDraft.description} onChange={(event) => onShellDraftChange({ description: event.target.value })} placeholder="一句话说明用途" /></label>
          <label><span>可见范围</span><select value={shellDraft.visibility} onChange={(event) => onShellDraftChange({ visibility: event.target.value as 'private' | 'team' })}><option value="private">仅自己</option><option value="team">团队共享</option></select></label>
          <div className="dash-plugin-size-row"><label><span>宽度</span><input type="number" min={320} max={1200} value={shellDraft.width} onChange={(event) => onShellDraftChange({ width: Number(event.target.value) })} /></label><label><span>高度</span><input type="number" min={240} max={900} value={shellDraft.height} onChange={(event) => onShellDraftChange({ height: Number(event.target.value) })} /></label></div>
        </div>
        <div className="dash-plugin-style-picker">
          <span>图标材质</span>
          <div>{pluginEffects.map((effect) => {
            const appearance = { effect, hue: shellDraft.hue, seed: pluginEffects.indexOf(effect) + 1 };
            return <button type="button" className={shellDraft.effect === effect ? 'selected' : ''} key={effect} onClick={() => onShellDraftChange({ effect })}><PluginGlyph appearance={appearance} compact /><span>{effectLabels[effect]}</span></button>;
          })}</div>
          <button type="button" className={`dash-plugin-random ${shellDraft.effect === 'random' ? 'selected' : ''}`} onClick={() => onShellDraftChange({ effect: 'random' })}>随机分配</button>
        </div>
      </div>
      <footer><span>创建后进入 Agent 设计对话</span><button type="button" className="primary" onClick={onCreateShell} disabled={busy || !shellDraft.name.trim()}><Plus size={16} />创建空白插件</button></footer>
    </section>}

    <section className="dash-plugin-gallery" aria-label="插件列表">
      {plugins.length === 0 ? <div className="dash-plugin-empty glass-panel"><Sparkles size={24} /><strong>还没有插件</strong><span>创建一个空白插件，再和 Agent 一起完成它</span></div> : plugins.map((plugin) => {
        const appearance = appearanceForPlugin(plugin);
        const canOpen = plugin.kind === 'mini-app' || plugin.status === 'published';
        return <article className={`dash-plugin-tile ${plugin.status}`} key={plugin.id}>
          <button type="button" className="dash-plugin-launch" aria-label={`打开插件 ${plugin.name}`} onClick={() => plugin.kind === 'mini-app' ? onOpenMiniApp(plugin) : canOpen ? onSelect(plugin) : undefined}>
            <PluginGlyph appearance={appearance} />
          </button>
          <strong>{plugin.name}</strong>
          <div className="dash-plugin-tile-actions">
            {plugin.kind === 'mini-app' && <button type="button" title="通过 Agent 修改" aria-label={`修改插件 ${plugin.name}`} onClick={() => onSelect(plugin)}><Pencil size={13} /></button>}
            {plugin.status === 'draft' && <button type="button" title="发布" aria-label={`发布插件 ${plugin.name}`} onClick={() => onPublish(plugin)}><Check size={13} /></button>}
            <button type="button" title="删除" aria-label={`删除插件 ${plugin.name}`} onClick={() => setPendingDelete(plugin)}><Trash2 size={13} /></button>
          </div>
        </article>;
      })}
    </section>
    {pendingDelete && <PluginDeleteDialog plugin={pendingDelete} busy={busy} onCancel={() => setPendingDelete(null)} onConfirm={async () => { await onDelete(pendingDelete); setPendingDelete(null); }} />}
  </div>;
}

function PluginLifecyclePanel({ plugin, report, busy, error, onRefresh, onRollback }: {
  plugin: UserPlugin;
  report: PluginCompatibilityReport | null;
  busy: boolean;
  error: string;
  onRefresh: () => void;
  onRollback: (version: number) => void;
}) {
  const releaseLabel = report?.releaseState === 'signed' ? '签名有效'
    : report?.releaseState === 'unsigned' ? '完整性已校验'
      : report?.releaseState === 'invalid' ? '发布证明失效'
        : '尚未发布';
  const snapshots = [...plugin.history].sort((left, right) => right.version - left.version);
  return <section className="dash-plugin-lifecycle glass-panel" aria-live="polite">
    <header>
      <div><span className={report?.compatible ? 'ready' : 'blocked'}>{report?.compatible ? <ShieldCheck size={18} /> : <ShieldAlert size={18} />}</span><div><strong>{report?.compatible ? '可以发布' : report ? '需要处理' : '正在检查'}</strong><small>当前版本 {plugin.version} · {releaseLabel}</small></div></div>
      <button type="button" className="labeled" onClick={onRefresh} disabled={busy}><RefreshCw size={14} className={busy ? 'spin' : ''} />重新检查</button>
    </header>
    {error && <p className="dash-plugin-lifecycle-error">{error}</p>}
    {report && <div className="dash-plugin-lifecycle-grid">
      <div className="dash-plugin-permissions"><span>本版本权限</span>{report.permissions.length ? <div>{report.permissions.map((permission) => <span className={`risk-${permission.risk}`} key={permission.id}>{permission.label}</span>)}</div> : <strong>不申请额外权限</strong>}</div>
      <div className="dash-plugin-integrity"><span>完整性</span><strong>{report.integrity.slice(0, 18)}...</strong>{report.signatureRequired && <small>部署要求签名</small>}</div>
      {(report.errors.length > 0 || report.warnings.length > 0) && <div className="dash-plugin-findings">{report.errors.map((message) => <p className="error" key={message}>{message}</p>)}{report.warnings.map((message) => <p key={message}>{message}</p>)}</div>}
    </div>}
    <div className="dash-plugin-versions"><div><span>历史版本</span><small>恢复会创建一个新的草稿版本</small></div>{snapshots.length === 0 ? <p>修改插件后，这里会保留可恢复版本。</p> : <div>{snapshots.map((snapshot) => <article key={`${snapshot.version}-${snapshot.updatedAt}`}><span>v{snapshot.version}</span><time>{new Date(snapshot.updatedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time><button type="button" className="labeled" disabled={busy} onClick={() => onRollback(snapshot.version)}><RotateCcw size={13} />恢复</button></article>)}</div>}</div>
  </section>;
}

function PluginField({ field, values, onValuesChange }: { field: PluginInputField; values: Record<string, string>; onValuesChange: (values: Record<string, string>) => void }) {
  return <label><span>{field.label}{field.required ? ' *' : ''}</span>{field.type === 'textarea'
    ? <textarea rows={4} value={values[field.id] ?? ''} onChange={(event) => onValuesChange({ ...values, [field.id]: event.target.value })} />
    : field.type === 'select'
      ? <select value={values[field.id] ?? ''} onChange={(event) => onValuesChange({ ...values, [field.id]: event.target.value })}><option value="">请选择</option>{(field.options ?? []).map((option) => <option key={option}>{option}</option>)}</select>
      : <input type={field.type === 'number' ? 'number' : 'text'} value={values[field.id] ?? ''} onChange={(event) => onValuesChange({ ...values, [field.id]: event.target.value })} />}</label>;
}

function PluginDeleteDialog({ plugin, busy, onCancel, onConfirm }: { plugin: UserPlugin; busy: boolean; onCancel: () => void; onConfirm: () => Promise<void> }) {
  return <div className="dash-confirm-backdrop dash-plugin-delete-backdrop" role="presentation">
    <section className="dash-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="plugin-delete-title">
      <span className="dash-confirm-icon danger"><Trash2 size={20} /></span>
      <h2 id="plugin-delete-title">确认删除？</h2>
      <p>“{plugin.name}”删除后无法恢复</p>
      <div className="dash-confirm-actions"><button type="button" onClick={onCancel} disabled={busy}>取消</button><button type="button" className="danger" onClick={() => { void onConfirm(); }} disabled={busy}>{busy ? '正在删除' : '删除'}</button></div>
    </section>
  </div>;
}

function PluginRollbackDialog({ plugin, version, busy, onCancel, onConfirm }: { plugin: UserPlugin; version: number; busy: boolean; onCancel: () => void; onConfirm: () => Promise<void> }) {
  return <div className="dash-confirm-backdrop dash-plugin-delete-backdrop" role="presentation">
    <section className="dash-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="plugin-rollback-title">
      <span className="dash-confirm-icon"><RotateCcw size={20} /></span>
      <h2 id="plugin-rollback-title">恢复版本 {version}？</h2>
      <p>“{plugin.name}”会生成一个新的草稿版本，当前版本仍保留</p>
      <div className="dash-confirm-actions"><button type="button" onClick={onCancel} disabled={busy}>取消</button><button type="button" className="primary" onClick={() => { void onConfirm(); }} disabled={busy}>{busy ? '正在恢复' : '确认恢复'}</button></div>
    </section>
  </div>;
}
