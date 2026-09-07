import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowUpCircle, Bot, Check, Download, ExternalLink, History, Maximize2, Pencil, Play, Plus, RefreshCw, RotateCcw, Save, Search, Send, ShieldAlert, ShieldCheck, ShoppingBag, Sparkles, Store, Trash2, UserRound, X } from 'lucide-react';
import type { AgentMode, PluginCompatibilityReport, PluginInputField, PluginMarketEntry, PluginMarketRelease, PluginVisualEffect, UserPlugin } from '../../types';
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
  marketEntries: PluginMarketEntry[];
  marketSubmissions: PluginMarketRelease[];
  reviewQueue: PluginMarketRelease[];
  currentUserId: string;
  canReview: boolean;
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
  onSubmitMarket: (plugin: UserPlugin) => Promise<void>;
  onReviewMarket: (release: PluginMarketRelease, decision: 'approved' | 'rejected', note: string) => Promise<void>;
  onInstall: (entry: PluginMarketEntry) => Promise<void>;
  onUpgrade: (entry: PluginMarketEntry) => Promise<void>;
  onUninstall: (entry: PluginMarketEntry) => Promise<void>;
  onRevokeMarket: (plugin: UserPlugin, version: number) => Promise<void>;
  onSearchMarket: (query: string) => Promise<void>;
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
    plugins, marketEntries, marketSubmissions, reviewQueue, currentUserId, canReview, selectedPlugin, busy, running, error, values, freeform, createOpen, shellDraft, designerInput, agentLive,
    onRefresh, onSelect, onOpenMiniApp, onPublish, onSubmitMarket, onReviewMarket, onInstall, onUpgrade, onUninstall, onRevokeMarket, onSearchMarket, onCheckCompatibility, onRollback, onResize, onDelete, onRun, onValuesChange, onFreeformChange,
    onOpenCreate, onCloseCreate, onShellDraftChange, onCreateShell, onDesignerInputChange, onDesignWithAgent,
  } = props;
  const [pendingDelete, setPendingDelete] = useState<UserPlugin | null>(null);
  const [sizeEditorOpen, setSizeEditorOpen] = useState(false);
  const [lifecycleOpen, setLifecycleOpen] = useState(false);
  const [compatibility, setCompatibility] = useState<PluginCompatibilityReport | null>(null);
  const [compatibilityError, setCompatibilityError] = useState('');
  const [compatibilityBusy, setCompatibilityBusy] = useState(false);
  const [pendingRollback, setPendingRollback] = useState<number | null>(null);
  const [section, setSection] = useState<'mine' | 'market' | 'review'>('mine');
  const [marketQuery, setMarketQuery] = useState('');
  const [pendingUninstall, setPendingUninstall] = useState<PluginMarketEntry | null>(null);
  const [pendingRevoke, setPendingRevoke] = useState<{ plugin: UserPlugin; version: number } | null>(null);
  const [pendingReview, setPendingReview] = useState<{ release: PluginMarketRelease; decision: 'approved' | 'rejected' } | null>(null);
  const [reviewNote, setReviewNote] = useState('');
  const [sizeDraft, setSizeDraft] = useState({ width: 720, height: 520 });
  const designMessagesRef = useRef<HTMLDivElement>(null);
  const selectedAppearance = useMemo(() => selectedPlugin ? appearanceForPlugin(selectedPlugin) : null, [selectedPlugin]);
  const selectedIsMiniApp = selectedPlugin?.kind === 'mini-app' && Boolean(selectedPlugin.definition.htmlContent);
  const designMessageCount = selectedPlugin?.definition.designConversation?.length ?? 0;
  const installedEntries = useMemo(() => marketEntries.filter((entry) => entry.installation), [marketEntries]);
  const minePlugins = useMemo(() => {
    const own = plugins.filter((plugin) => !currentUserId || plugin.createdBy === currentUserId);
    const ownIds = new Set(own.map((plugin) => plugin.id));
    return [...own, ...installedEntries.map((entry) => entry.release.plugin).filter((plugin) => !ownIds.has(plugin.id))];
  }, [currentUserId, installedEntries, plugins]);
  const selectedMarketEntry = selectedPlugin ? marketEntries.find((entry) => entry.release.pluginId === selectedPlugin.id) : undefined;
  const selectedMarketSubmission = selectedPlugin ? marketSubmissions.find((release) => release.pluginId === selectedPlugin.id && release.pluginVersion === selectedPlugin.version) : undefined;

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
        <div><button type="button" className="dash-plugin-back" onClick={() => onSelect(null)}><ArrowLeft size={15} />返回插件</button><h1 data-i18n-ignore="true">{selectedPlugin.name}</h1></div>
        <div className="dash-workspace-actions">
          <button type="button" className="labeled" onClick={() => onOpenMiniApp(selectedPlugin)}><ExternalLink size={15} />打开</button>
          <button type="button" className="labeled" aria-expanded={sizeEditorOpen} onClick={() => setSizeEditorOpen((open) => !open)}><Maximize2 size={15} />窗口大小</button>
          <button type="button" className="labeled" aria-expanded={lifecycleOpen} onClick={toggleLifecycle}><History size={15} />版本与权限</button>
          {selectedPlugin.status === 'draft' && <button type="button" className="primary labeled" onClick={() => onPublish(selectedPlugin)} disabled={busy}><Check size={15} />发布</button>}
          {selectedPlugin.status === 'published' && selectedPlugin.visibility === 'team' && (!selectedMarketSubmission || selectedMarketSubmission.status === 'rejected' || selectedMarketSubmission.status === 'revoked') && <button type="button" className="primary labeled" onClick={() => { void onSubmitMarket(selectedPlugin); }} disabled={busy}><Store size={15} />{selectedMarketSubmission ? '重新提交' : '提交市场'}</button>}
          {selectedMarketSubmission?.status === 'pending' && <button type="button" className="labeled" disabled><History size={15} />审核中</button>}
          {selectedMarketSubmission?.status === 'approved' && selectedMarketEntry?.release.pluginVersion === selectedPlugin.version && <button type="button" className="labeled" onClick={() => setPendingRevoke({ plugin: selectedPlugin, version: selectedPlugin.version })} disabled={busy}><ShieldAlert size={15} />撤回市场</button>}
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
      {pendingRevoke && <PluginMarketConfirmDialog title="撤回市场版本？" detail={`版本 ${pendingRevoke.version} 将立即停止新安装，已安装用户也无法继续运行。`} confirmLabel="确认撤回" busy={busy} danger onCancel={() => setPendingRevoke(null)} onConfirm={async () => { await onRevokeMarket(pendingRevoke.plugin, pendingRevoke.version); setPendingRevoke(null); }} />}
    </div>;
  }

  if (selectedPlugin) {
    return <div className="dash-plugin-workspace">
      <header className="dash-workspace-heading">
        <div><button type="button" className="dash-plugin-back" onClick={() => onSelect(null)}><ArrowLeft size={15} />返回插件</button><h1 data-i18n-ignore="true">{selectedPlugin.name}</h1></div>
        <div className="dash-workspace-actions">
          <button type="button" className="labeled" aria-expanded={lifecycleOpen} onClick={toggleLifecycle}><History size={15} />版本与权限</button>
          {selectedPlugin.status === 'draft' && <button type="button" className="primary labeled" onClick={() => onPublish(selectedPlugin)} disabled={busy}><Check size={15} />发布</button>}
          {selectedPlugin.status === 'published' && selectedPlugin.visibility === 'team' && (!selectedMarketSubmission || selectedMarketSubmission.status === 'rejected' || selectedMarketSubmission.status === 'revoked') && <button type="button" className="primary labeled" onClick={() => { void onSubmitMarket(selectedPlugin); }} disabled={busy}><Store size={15} />{selectedMarketSubmission ? '重新提交' : '提交市场'}</button>}
          {selectedMarketSubmission?.status === 'pending' && <button type="button" className="labeled" disabled><History size={15} />审核中</button>}
          {selectedMarketSubmission?.status === 'approved' && selectedMarketEntry?.release.pluginVersion === selectedPlugin.version && <button type="button" className="labeled" onClick={() => setPendingRevoke({ plugin: selectedPlugin, version: selectedPlugin.version })} disabled={busy}><ShieldAlert size={15} />撤回市场</button>}
          <button type="button" aria-label="删除插件" title="删除" onClick={() => setPendingDelete(selectedPlugin)}><Trash2 size={15} /></button>
        </div>
      </header>
      {error && <div className="dash-plugin-error">{error}</div>}
      {lifecyclePanel}
      <section className="dash-plugin-run glass-panel">
        <p data-i18n-ignore={Boolean(selectedPlugin.description)}>{selectedPlugin.description || '填写本次任务内容，然后交给 Agent 执行。'}</p>
        <div className="dash-plugin-run-fields">
          {(selectedPlugin.definition.inputSchema?.fields ?? []).map((field) => <PluginField key={field.id} field={field} values={values} onValuesChange={onValuesChange} />)}
          <label className="wide"><span>任务内容</span><textarea rows={7} value={freeform} onChange={(event) => onFreeformChange(event.target.value)} placeholder="输入这次要处理的内容" /></label>
        </div>
        <footer><span>版本 {selectedPlugin.version} · {modeLabels[selectedPlugin.definition.mode]}</span><button type="button" className="primary" onClick={onRun} disabled={busy || running}><Play size={16} />{busy ? '正在启动' : '运行插件'}</button></footer>
      </section>
      {pendingDelete && <PluginDeleteDialog plugin={pendingDelete} busy={busy} onCancel={() => setPendingDelete(null)} onConfirm={async () => { await onDelete(pendingDelete); setPendingDelete(null); }} />}
      {pendingRollback !== null && <PluginRollbackDialog plugin={selectedPlugin} version={pendingRollback} busy={busy} onCancel={() => setPendingRollback(null)} onConfirm={async () => { await onRollback(selectedPlugin, pendingRollback); setPendingRollback(null); }} />}
      {pendingRevoke && <PluginMarketConfirmDialog title="撤回市场版本？" detail={`版本 ${pendingRevoke.version} 将立即停止新安装，已安装用户也无法继续运行。`} confirmLabel="确认撤回" busy={busy} danger onCancel={() => setPendingRevoke(null)} onConfirm={async () => { await onRevokeMarket(pendingRevoke.plugin, pendingRevoke.version); setPendingRevoke(null); }} />}
    </div>;
  }

  return <div className="dash-plugin-workspace">
    <header className="dash-workspace-heading">
      <div><span>可复用工具</span><h1>{section === 'mine' ? '我的插件' : section === 'market' ? '插件市场' : '待审核插件'}</h1></div>
      <div className="dash-workspace-actions">
        <span>{section === 'mine' ? minePlugins.length : section === 'market' ? marketEntries.length : reviewQueue.length} 个</span>
        <button type="button" aria-label="刷新插件" title="刷新" onClick={onRefresh} disabled={busy}><RefreshCw size={16} className={busy ? 'spin' : ''} /></button>
        {section === 'mine' && <button type="button" className="primary labeled" onClick={onOpenCreate}><Sparkles size={16} />Agent 创建</button>}
      </div>
    </header>
    <nav className="dash-plugin-tabs glass-panel" role="tablist" aria-label="插件视图">
      <button type="button" role="tab" aria-selected={section === 'mine'} className={section === 'mine' ? 'active' : ''} onClick={() => setSection('mine')}><UserRound size={15} />我的插件</button>
      <button type="button" role="tab" aria-selected={section === 'market'} className={section === 'market' ? 'active' : ''} onClick={() => setSection('market')}><Store size={15} />插件市场</button>
      {canReview && <button type="button" role="tab" aria-selected={section === 'review'} className={section === 'review' ? 'active' : ''} onClick={() => setSection('review')}><ShieldCheck size={15} />待审核{reviewQueue.length > 0 && <small>{reviewQueue.length}</small>}</button>}
    </nav>
    {error && <div className="dash-plugin-error">{error}</div>}

    {section === 'mine' && createOpen && <section className="dash-plugin-shell-create glass-panel">
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

    {section === 'mine' && <section className="dash-plugin-gallery" aria-label="插件列表">
      {minePlugins.length === 0 ? <div className="dash-plugin-empty dash-plugin-first-run glass-panel"><ShoppingBag size={26} /><strong>从一个插件开始</strong><span>让 Agent 帮你创建，或安装团队已经审核的插件。</span><div><button type="button" className="primary labeled" onClick={onOpenCreate}><Sparkles size={15} />Agent 创建</button><button type="button" className="labeled" onClick={() => setSection('market')}><Store size={15} />浏览市场</button></div></div> : minePlugins.map((plugin) => {
        const appearance = appearanceForPlugin(plugin);
        const canOpen = plugin.kind === 'mini-app' || plugin.status === 'published';
        const installedEntry = installedEntries.find((entry) => entry.release.pluginId === plugin.id);
        const isOwned = !currentUserId || plugin.createdBy === currentUserId;
        const marketEntry = marketEntries.find((entry) => entry.release.pluginId === plugin.id);
        const submission = marketSubmissions.find((release) => release.pluginId === plugin.id && release.pluginVersion === plugin.version);
        return <article className={`dash-plugin-tile ${plugin.status}`} key={plugin.id}>
          <button type="button" className="dash-plugin-launch" aria-label={`打开插件 ${plugin.name}`} onClick={() => plugin.kind === 'mini-app' ? onOpenMiniApp(plugin) : canOpen ? onSelect(plugin) : undefined}>
            <PluginGlyph appearance={appearance} />
          </button>
          <strong data-i18n-ignore="true">{plugin.name}</strong>
          <small className="dash-plugin-version">v{installedEntry?.installation?.pluginVersion ?? plugin.version}{installedEntry ? ' · 已安装' : plugin.status === 'draft' ? ' · 草稿' : submission?.status === 'pending' ? ' · 审核中' : submission?.status === 'rejected' ? ' · 需修改' : marketEntry ? ' · 已上架' : ''}</small>
          <div className="dash-plugin-tile-actions">
            {isOwned && plugin.kind === 'mini-app' && <button type="button" title="通过 Agent 修改" aria-label={`修改插件 ${plugin.name}`} onClick={() => onSelect(plugin)}><Pencil size={13} /></button>}
            {isOwned && plugin.status === 'draft' && <button type="button" title="发布" aria-label={`发布插件 ${plugin.name}`} onClick={() => onPublish(plugin)}><Check size={13} /></button>}
            {isOwned && plugin.status === 'published' && plugin.visibility === 'team' && (!submission || submission.status === 'rejected' || submission.status === 'revoked') && <button type="button" title={submission ? '重新提交市场审核' : '提交市场审核'} aria-label={`提交市场 ${plugin.name}`} onClick={() => { void onSubmitMarket(plugin); }}><Store size={13} /></button>}
            {isOwned && submission?.status === 'approved' && marketEntry?.release.pluginVersion === plugin.version && <button type="button" title="撤回市场版本" aria-label={`撤回市场 ${plugin.name}`} onClick={() => setPendingRevoke({ plugin, version: plugin.version })}><ShieldAlert size={13} /></button>}
            {installedEntry && !isOwned && <button type="button" title="卸载" aria-label={`卸载插件 ${plugin.name}`} onClick={() => setPendingUninstall(installedEntry)}><Trash2 size={13} /></button>}
            {isOwned && <button type="button" title="删除" aria-label={`删除插件 ${plugin.name}`} onClick={() => setPendingDelete(plugin)}><Trash2 size={13} /></button>}
          </div>
        </article>;
      })}
    </section>}

    {section === 'market' && <>
      <form className="dash-plugin-market-search glass-panel" onSubmit={(event) => { event.preventDefault(); void onSearchMarket(marketQuery); }}>
        <Search size={17} /><input aria-label="搜索插件市场" value={marketQuery} onChange={(event) => setMarketQuery(event.target.value)} placeholder="搜索名称或用途" /><button type="submit" className="labeled" disabled={busy}>搜索</button>
      </form>
      <section className="dash-plugin-market-grid" aria-label="插件市场列表">
        {marketEntries.length === 0 ? <div className="dash-plugin-empty glass-panel"><Store size={26} /><strong>{marketQuery ? '没有匹配的插件' : '市场正在等待第一个插件'}</strong><span>{marketQuery ? '换个关键词再试一次。' : '团队插件通过管理员审核后会出现在这里。'}</span>{marketQuery && <button type="button" className="labeled" onClick={() => { setMarketQuery(''); void onSearchMarket(''); }}>清除搜索</button>}</div> : marketEntries.map((entry) => {
          const plugin = entry.release.plugin;
          const installed = Boolean(entry.installation);
          const restoringSafeVersion = Boolean(entry.installation && entry.installation.pluginVersion > entry.release.pluginVersion);
          return <article className="dash-plugin-market-card glass-panel" key={`${entry.release.pluginId}-${entry.release.pluginVersion}`}>
            <PluginGlyph appearance={appearanceForPlugin(plugin)} compact />
            <div className="dash-plugin-market-copy"><span><ShieldCheck size={13} />已审核</span><strong data-i18n-ignore="true">{plugin.name}</strong><p data-i18n-ignore={Boolean(plugin.description)}>{plugin.description || '团队可复用插件'}</p><small>版本 {entry.release.pluginVersion} · {entry.release.reviewedAt ? new Date(entry.release.reviewedAt).toLocaleDateString('zh-CN') : '已通过'}</small></div>
            <div className="dash-plugin-market-actions">
              {!installed && <button type="button" className="primary labeled" disabled={busy} onClick={() => { void onInstall(entry); }}><Download size={15} />安装</button>}
              {installed && entry.updateAvailable && <button type="button" className="primary labeled" disabled={busy} onClick={() => { void onUpgrade(entry); }}>{restoringSafeVersion ? <RotateCcw size={15} /> : <ArrowUpCircle size={15} />}{restoringSafeVersion ? '恢复安全版本' : '升级'}</button>}
              {installed && !entry.updateAvailable && <button type="button" className="labeled" disabled={busy} onClick={() => plugin.kind === 'mini-app' ? onOpenMiniApp(plugin) : onSelect(plugin)}><ExternalLink size={15} />打开</button>}
              {installed && <button type="button" aria-label={`卸载市场插件 ${plugin.name}`} title="卸载" disabled={busy} onClick={() => setPendingUninstall(entry)}><Trash2 size={14} /></button>}
            </div>
          </article>;
        })}
      </section>
    </>}

    {section === 'review' && canReview && <section className="dash-plugin-review-list" aria-label="插件审核列表">
      {reviewQueue.length === 0 ? <div className="dash-plugin-empty glass-panel"><ShieldCheck size={26} /><strong>没有待审核插件</strong><span>新的市场版本提交后会出现在这里。</span></div> : reviewQueue.map((release) => <article className="dash-plugin-review-card glass-panel" key={`${release.pluginId}-${release.pluginVersion}`}>
        <PluginGlyph appearance={appearanceForPlugin(release.plugin)} compact />
        <div><span>版本 {release.pluginVersion}</span><strong data-i18n-ignore="true">{release.plugin.name}</strong><p data-i18n-ignore={Boolean(release.plugin.description)}>{release.plugin.description || '未填写说明'}</p><small>提交人 <span data-i18n-ignore="true">{release.submittedBy}</span></small></div>
        <div><button type="button" className="labeled" disabled={busy} onClick={() => { setReviewNote(''); setPendingReview({ release, decision: 'rejected' }); }}><X size={15} />驳回</button><button type="button" className="primary labeled" disabled={busy} onClick={() => { setReviewNote(''); setPendingReview({ release, decision: 'approved' }); }}><Check size={15} />通过</button></div>
      </article>)}
    </section>}
    {pendingDelete && <PluginDeleteDialog plugin={pendingDelete} busy={busy} onCancel={() => setPendingDelete(null)} onConfirm={async () => { await onDelete(pendingDelete); setPendingDelete(null); }} />}
    {pendingUninstall && <PluginMarketConfirmDialog title="卸载插件？" detail={`“${pendingUninstall.release.plugin.name}”将从你的插件中移除，之后仍可重新安装。`} confirmLabel="确认卸载" busy={busy} onCancel={() => setPendingUninstall(null)} onConfirm={async () => { await onUninstall(pendingUninstall); setPendingUninstall(null); }} />}
    {pendingRevoke && <PluginMarketConfirmDialog title="撤回市场版本？" detail={`版本 ${pendingRevoke.version} 将立即停止新安装，已安装用户也无法继续运行。`} confirmLabel="确认撤回" busy={busy} danger onCancel={() => setPendingRevoke(null)} onConfirm={async () => { await onRevokeMarket(pendingRevoke.plugin, pendingRevoke.version); setPendingRevoke(null); }} />}
    {pendingReview && <PluginReviewDialog release={pendingReview.release} decision={pendingReview.decision} note={reviewNote} busy={busy} onNoteChange={setReviewNote} onCancel={() => setPendingReview(null)} onConfirm={async () => { await onReviewMarket(pendingReview.release, pendingReview.decision, reviewNote); setPendingReview(null); }} />}
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

function PluginMarketConfirmDialog({ title, detail, confirmLabel, busy, danger = false, onCancel, onConfirm }: {
  title: string;
  detail: string;
  confirmLabel: string;
  busy: boolean;
  danger?: boolean;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  return <div className="dash-confirm-backdrop dash-plugin-delete-backdrop" role="presentation">
    <section className="dash-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="plugin-market-confirm-title">
      <span className={`dash-confirm-icon ${danger ? 'danger' : ''}`}>{danger ? <ShieldAlert size={20} /> : <ShoppingBag size={20} />}</span>
      <h2 id="plugin-market-confirm-title">{title}</h2>
      <p>{detail}</p>
      <div className="dash-confirm-actions"><button type="button" onClick={onCancel} disabled={busy}>取消</button><button type="button" className={danger ? 'danger' : 'primary'} onClick={() => { void onConfirm(); }} disabled={busy}>{busy ? '正在处理' : confirmLabel}</button></div>
    </section>
  </div>;
}

function PluginReviewDialog({ release, decision, note, busy, onNoteChange, onCancel, onConfirm }: {
  release: PluginMarketRelease;
  decision: 'approved' | 'rejected';
  note: string;
  busy: boolean;
  onNoteChange: (value: string) => void;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  const approving = decision === 'approved';
  return <div className="dash-confirm-backdrop dash-plugin-delete-backdrop" role="presentation">
    <section className="dash-confirm-dialog dash-plugin-review-dialog" role="dialog" aria-modal="true" aria-labelledby="plugin-review-title">
      <span className={`dash-confirm-icon ${approving ? '' : 'danger'}`}>{approving ? <ShieldCheck size={20} /> : <ShieldAlert size={20} />}</span>
      <h2 id="plugin-review-title">{approving ? '通过市场审核？' : '驳回这个版本？'}</h2>
      <p>“{release.plugin.name}”版本 {release.pluginVersion}</p>
      <label><span>审核备注{approving ? '（可选）' : ''}</span><textarea rows={4} maxLength={1000} value={note} onChange={(event) => onNoteChange(event.target.value)} placeholder={approving ? '记录本次审核依据' : '告诉发布者需要修改什么'} /></label>
      <div className="dash-confirm-actions"><button type="button" onClick={onCancel} disabled={busy}>取消</button><button type="button" className={approving ? 'primary' : 'danger'} onClick={() => { void onConfirm(); }} disabled={busy || (!approving && note.trim().length === 0)}>{busy ? '正在提交' : approving ? '确认通过' : '确认驳回'}</button></div>
    </section>
  </div>;
}
