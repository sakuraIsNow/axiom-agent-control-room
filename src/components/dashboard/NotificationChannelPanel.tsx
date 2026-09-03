import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  BellRing,
  Check,
  CircleAlert,
  CircleCheck,
  Clock3,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Send,
  Trash2,
  Webhook,
  X,
} from 'lucide-react';
import type { InAppNotificationKind, OutboundNotificationCatalog, OutboundNotificationChannel } from '../../types';
import {
  createOutboundNotificationChannel,
  deleteOutboundNotificationChannel,
  getOutboundNotificationCatalog,
  retryOutboundNotificationDelivery,
  testOutboundNotificationChannel,
  updateOutboundNotificationChannel,
  type OutboundNotificationChannelDraft,
} from '../../lib/taskRuntime';
import { userFacingError } from '../../lib/errorPresentation';

const eventLabels: Record<InAppNotificationKind, string> = {
  approval_required: '需要确认',
  task_completed: '任务完成',
  partial_delivery: '部分交付',
  task_failed: '任务失败',
  plugin_failed: '插件失败',
  schedule_dead_letter: '日程暂停',
  artifact_cleanup_failed: '文件清理失败',
};

const defaultEvents: InAppNotificationKind[] = [
  'approval_required',
  'partial_delivery',
  'task_failed',
  'plugin_failed',
  'schedule_dead_letter',
  'artifact_cleanup_failed',
];

type Draft = OutboundNotificationChannelDraft & { endpoint: string; signingSecret: string };
const emptyDraft = (): Draft => ({
  name: '',
  endpoint: '',
  signingSecret: '',
  location: 'internet',
  eventKinds: defaultEvents,
  enabled: true,
});

const statusLabel = {
  pending: '等待发送',
  delivering: '正在发送',
  retrying: '等待重试',
  delivered: '已送达',
  dead_letter: '需要处理',
} as const;

const eventLabel = (kind: InAppNotificationKind | 'test') => kind === 'test' ? '测试消息' : eventLabels[kind];
const dateTime = (value: string) => Number.isFinite(Date.parse(value))
  ? new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value))
  : '';

export function NotificationChannelPanel() {
  const [catalog, setCatalog] = useState<OutboundNotificationCatalog>({ channels: [], deliveries: [], supportedEventKinds: [] });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(emptyDraft);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const next = await getOutboundNotificationCatalog(signal);
      setCatalog(next);
      setError(null);
    } catch (caught) {
      if (!signal?.aborted) setError(userFacingError(caught, '外发通知暂时不可用。'));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);

  const supportedKinds = useMemo(() => catalog.supportedEventKinds.length ? catalog.supportedEventKinds : Object.keys(eventLabels) as InAppNotificationKind[], [catalog.supportedEventKinds]);

  const beginCreate = () => {
    setEditingId(null);
    setDraft(emptyDraft());
    setShowForm(true);
    setError(null);
    setNotice(null);
  };

  const beginEdit = (channel: OutboundNotificationChannel) => {
    setEditingId(channel.id);
    setDraft({
      name: channel.name,
      endpoint: '',
      signingSecret: '',
      location: channel.location,
      eventKinds: channel.eventKinds,
      enabled: channel.enabled,
    });
    setShowForm(true);
    setError(null);
    setNotice(null);
  };

  const closeForm = () => {
    setShowForm(false);
    setEditingId(null);
    setDraft(emptyDraft());
  };

  const toggleEvent = (kind: InAppNotificationKind) => {
    setDraft((current) => ({
      ...current,
      eventKinds: current.eventKinds.includes(kind)
        ? current.eventKinds.filter((item) => item !== kind)
        : [...current.eventKinds, kind],
    }));
  };

  const save = async () => {
    if (!draft.name.trim() || draft.eventKinds.length === 0) {
      setError('请填写渠道名称并至少选择一种事件。');
      return;
    }
    if (!editingId && (!draft.endpoint.trim() || draft.signingSecret.trim().length < 16)) {
      setError('新渠道需要填写 URL，并设置至少 16 个字符的签名密钥。');
      return;
    }
    setBusy(editingId ? `edit:${editingId}` : 'create');
    setError(null);
    setNotice(null);
    try {
      if (editingId) {
        await updateOutboundNotificationChannel(editingId, {
          name: draft.name.trim(),
          location: draft.location,
          eventKinds: draft.eventKinds,
          enabled: draft.enabled,
          ...(draft.endpoint.trim() ? { endpoint: draft.endpoint.trim() } : {}),
          ...(draft.signingSecret.trim() ? { signingSecret: draft.signingSecret.trim() } : {}),
        });
        setNotice('渠道设置已更新。');
      } else {
        await createOutboundNotificationChannel({ ...draft, name: draft.name.trim(), endpoint: draft.endpoint.trim(), signingSecret: draft.signingSecret.trim() });
        setNotice('渠道已创建，建议先发送测试消息。');
      }
      closeForm();
      await refresh();
    } catch (caught) {
      setError(userFacingError(caught, '渠道没有保存。'));
    } finally { setBusy(null); }
  };

  const toggleChannel = async (channel: OutboundNotificationChannel) => {
    setBusy(`toggle:${channel.id}`);
    setError(null);
    try {
      await updateOutboundNotificationChannel(channel.id, { enabled: !channel.enabled });
      setNotice(channel.enabled ? '渠道已暂停。' : '渠道已启用。');
      await refresh();
    } catch (caught) { setError(userFacingError(caught, '渠道状态没有更新。')); }
    finally { setBusy(null); }
  };

  const testChannel = async (channel: OutboundNotificationChannel) => {
    setBusy(`test:${channel.id}`);
    setError(null);
    setNotice(null);
    try {
      const delivery = await testOutboundNotificationChannel(channel.id);
      setNotice(delivery.status === 'delivered' ? '测试消息已送达。' : '测试消息已进入重试队列，可在投递记录中查看。');
      await refresh();
    } catch (caught) { setError(userFacingError(caught, '测试消息没有发出。')); }
    finally { setBusy(null); }
  };

  const removeChannel = async (channelId: string) => {
    if (confirmDeleteId !== channelId) {
      setConfirmDeleteId(channelId);
      return;
    }
    setBusy(`delete:${channelId}`);
    setError(null);
    try {
      await deleteOutboundNotificationChannel(channelId);
      setConfirmDeleteId(null);
      setNotice('渠道密钥已删除，历史投递审计会按保留期清理。');
      await refresh();
    } catch (caught) { setError(userFacingError(caught, '渠道没有删除。')); }
    finally { setBusy(null); }
  };

  const retryDelivery = async (deliveryId: string) => {
    setBusy(`retry:${deliveryId}`);
    setError(null);
    try {
      const delivery = await retryOutboundNotificationDelivery(deliveryId);
      setNotice(delivery.status === 'delivered' ? '消息已重新送达。' : '消息已重新进入发送队列。');
      await refresh();
    } catch (caught) { setError(userFacingError(caught, '消息没有重新发送。')); }
    finally { setBusy(null); }
  };

  return <div className="dash-channel-panel" data-testid="notification-channel-panel">
    <div className="dash-channel-intro">
      <span><Webhook size={17} /></span>
      <div><strong>离开页面也能收到结果</strong><small>通过签名 Webhook 发送任务完成、异常和人工确认消息。</small></div>
      <button type="button" onClick={beginCreate} title="新增渠道"><Plus size={16} /></button>
    </div>

    {error && <div className="dash-channel-message error"><CircleAlert size={14} />{error}</div>}
    {notice && <div className="dash-channel-message success"><CircleCheck size={14} />{notice}</div>}

    {showForm && <section className="dash-channel-form" aria-label={editingId ? '编辑通知渠道' : '新增通知渠道'}>
      <header><strong>{editingId ? '编辑渠道' : '新增 Webhook'}</strong><button type="button" onClick={closeForm} title="取消"><X size={15} /></button></header>
      <label><span>渠道名称</span><input value={draft.name} maxLength={80} placeholder="例如：团队消息" onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} /></label>
      <div className="dash-channel-location" role="group" aria-label="网络位置">
        <button type="button" className={draft.location === 'internet' ? 'active' : ''} onClick={() => setDraft((current) => ({ ...current, location: 'internet' }))}>公网 HTTPS</button>
        <button type="button" className={draft.location === 'local' ? 'active' : ''} onClick={() => setDraft((current) => ({ ...current, location: 'local' }))}>本地服务</button>
      </div>
      <label><span>接收 URL</span><input value={draft.endpoint} type="url" placeholder={editingId ? '留空保持原地址' : draft.location === 'local' ? 'http://127.0.0.1:9000/hook' : 'https://hooks.example.com/axiom'} onChange={(event) => setDraft((current) => ({ ...current, endpoint: event.target.value }))} /></label>
      <label><span>签名密钥</span><input value={draft.signingSecret} type="password" autoComplete="new-password" placeholder={editingId ? '留空保持原密钥' : '至少 16 个字符'} onChange={(event) => setDraft((current) => ({ ...current, signingSecret: event.target.value }))} /></label>
      <fieldset><legend>发送这些事件</legend><div className="dash-channel-events">
        {supportedKinds.map((kind) => <label key={kind} className={draft.eventKinds.includes(kind) ? 'selected' : ''}>
          <input type="checkbox" checked={draft.eventKinds.includes(kind)} onChange={() => toggleEvent(kind)} />
          <span>{draft.eventKinds.includes(kind) && <Check size={11} />}</span>{eventLabels[kind]}
        </label>)}
      </div></fieldset>
      <button type="button" className="dash-channel-save" disabled={busy !== null} onClick={() => void save()}>{busy?.startsWith(editingId ? 'edit:' : 'create') ? <LoaderCircle className="dash-notification-spinner" size={14} /> : <Check size={14} />}保存渠道</button>
    </section>}

    <section className="dash-channel-section">
      <header><strong>通知渠道</strong><button type="button" onClick={() => void refresh()} disabled={loading || busy !== null} title="刷新"><RefreshCw className={loading ? 'dash-notification-spinner' : ''} size={14} /></button></header>
      {loading && catalog.channels.length === 0 && <div className="dash-channel-empty"><LoaderCircle className="dash-notification-spinner" size={17} />正在读取</div>}
      {!loading && catalog.channels.length === 0 && <div className="dash-channel-empty"><BellRing size={17} />还没有外发渠道</div>}
      <div className="dash-channel-list">
        {catalog.channels.map((channel) => <article key={channel.id} className={channel.enabled ? 'enabled' : 'disabled'}>
          <button type="button" className="dash-channel-state" onClick={() => void toggleChannel(channel)} title={channel.enabled ? '暂停渠道' : '启用渠道'} aria-label={channel.enabled ? '暂停渠道' : '启用渠道'}><i /></button>
          <div><strong>{channel.name}</strong><span>{channel.endpointDisplay}</span><small>{channel.eventKinds.length} 类事件 · {channel.location === 'local' ? '本地网络' : '公网'}</small></div>
          <nav>
            <button type="button" disabled={busy !== null || !channel.enabled} onClick={() => void testChannel(channel)} title="发送测试"><Send size={14} /></button>
            <button type="button" disabled={busy !== null} onClick={() => beginEdit(channel)} title="编辑"><Pencil size={14} /></button>
            <button type="button" className={confirmDeleteId === channel.id ? 'confirm' : ''} disabled={busy !== null} onClick={() => void removeChannel(channel.id)} title={confirmDeleteId === channel.id ? '再次点击确认删除' : '删除'}>{confirmDeleteId === channel.id ? <Check size={14} /> : <Trash2 size={14} />}</button>
          </nav>
        </article>)}
      </div>
    </section>

    <section className="dash-channel-section deliveries">
      <header><strong>最近投递</strong><span>{catalog.deliveries.length ? `${catalog.deliveries.length} 条` : '暂无记录'}</span></header>
      <div className="dash-delivery-list">
        {catalog.deliveries.slice(0, 20).map((delivery) => <article key={delivery.id} className={`status-${delivery.status}`}>
          <span className="dash-delivery-icon">{delivery.status === 'delivered' ? <CircleCheck size={14} /> : delivery.status === 'dead_letter' ? <CircleAlert size={14} /> : <Clock3 size={14} />}</span>
          <div><strong>{eventLabel(delivery.eventKind)} · {delivery.channelName}</strong><small>{statusLabel[delivery.status]} · {dateTime(delivery.updatedAt)}{delivery.responseStatus ? ` · HTTP ${delivery.responseStatus}` : ''}</small>{delivery.lastError && <em>{delivery.lastError}</em>}</div>
          {delivery.status === 'dead_letter' && <button type="button" disabled={busy !== null} onClick={() => void retryDelivery(delivery.id)} title="重新投递">{busy === `retry:${delivery.id}` ? <LoaderCircle className="dash-notification-spinner" size={13} /> : <RotateCcw size={13} />}</button>}
        </article>)}
      </div>
    </section>
  </div>;
}
