import { Activity, AlertTriangle, Bot, CheckCircle2, Clock3, Database, Gauge, Layers3, RefreshCw, ShieldAlert, Siren, Trash2, Wrench, XCircle } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { cleanupArtifacts, getOperationsAlerts, getOperationsSnapshot } from '../../lib/taskRuntime';
import type { OperationsAlert, OperationsAlertsSnapshot, OperationsSnapshot } from '../../types';
import { operationsAlertDetail } from '../../lib/operationsPresentation';
import { useUiLanguage } from '../../lib/uiLanguage';

const formatDuration = (ms: number) => {
  if (!ms) return '—';
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)} 秒`;
  return `${(ms / 60_000).toFixed(1)} 分钟`;
};

const formatNumber = (value: number) => new Intl.NumberFormat('zh-CN', { notation: value > 9_999 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(value);
const healthLabel = (health: OperationsSnapshot['models'][number]['health']) => health === 'healthy' ? '稳定' : health === 'degraded' ? '需关注' : '暂无数据';
const healthClass = (health: OperationsSnapshot['models'][number]['health']) => `ops-health-${health}`;
const alertLabel = (severity: OperationsAlert['severity']) => severity === 'critical' ? '立即处理' : severity === 'warning' ? '需要关注' : '提示';

export function OperationsConsole() {
  const { language } = useUiLanguage();
  const [snapshot, setSnapshot] = useState<OperationsSnapshot | null>(null);
  const [alerts, setAlerts] = useState<OperationsAlertsSnapshot | null>(null);
  const [hours, setHours] = useState(24);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [cleaning, setCleaning] = useState(false);
  const [cleanupMessage, setCleanupMessage] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    const load = async () => {
      setLoading(true);
      try {
        const [next, nextAlerts] = await Promise.all([
          getOperationsSnapshot(hours, controller.signal),
          getOperationsAlerts(hours, controller.signal),
        ]);
        if (!disposed) { setSnapshot(next); setAlerts(nextAlerts); setError(null); setUpdatedAt(Date.now()); }
      } catch (caught) {
        if (!disposed && !(caught instanceof DOMException && caught.name === 'AbortError')) setError(caught instanceof Error ? caught.message : '运行观测暂时不可用。');
      } finally {
        if (!disposed) setLoading(false);
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 20_000);
    return () => { disposed = true; controller.abort(); window.clearInterval(timer); };
  }, [hours, refreshKey]);

  const queueTotal = snapshot?.queue.totalActive ?? 0;
  const queueRows = useMemo(() => snapshot ? [
    ['排队中', snapshot.queue.queued, 'queued'],
    ['规划中', snapshot.queue.planning, 'planning'],
    ['执行中', snapshot.queue.running, 'running'],
    ['审查中', snapshot.queue.reviewing, 'reviewing'],
    ['等待确认', snapshot.queue.awaitingApproval + snapshot.queue.waitingForHuman, 'approval'],
    ['已暂停', snapshot.queue.paused, 'paused'],
  ] as const : [], [snapshot]);

  return <section className="ops-console" aria-label="运行观测">
    <div className="ops-console-head">
      <div><span className="ops-kicker"><Activity size={13} />运行观测</span><h1>系统正在怎样工作</h1><p>数据来自最近 {hours} 小时的真实任务、事件和租约。</p></div>
      <div className="ops-console-controls">
        <div className="ops-range" role="group" aria-label="统计时间范围">{([24, 72, 168] as const).map((item) => <button type="button" key={item} className={hours === item ? 'active' : ''} onClick={() => setHours(item)}>{item === 24 ? '24 小时' : item === 72 ? '3 天' : '7 天'}</button>)}</div>
        <span className="ops-updated">{loading ? '同步中…' : updatedAt ? `刚刚更新 · ${new Date(updatedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}` : '等待数据'}</span>
      </div>
    </div>
    {error && <div className="ops-error"><ShieldAlert size={15} /><span>{error}</span><button type="button" onClick={() => setRefreshKey((value) => value + 1)} title="重新加载"><RefreshCw size={14} /></button></div>}
    {!snapshot && loading ? <div className="ops-loading"><Activity size={20} /><span>正在读取运行数据</span></div> : snapshot && <>
      <div className="ops-kpi-grid">
        <article className="ops-kpi"><span><Layers3 size={15} />活动队列</span><strong>{queueTotal}</strong><small>{snapshot.queue.oldestQueuedAt ? `最早等待 ${formatDuration(snapshot.queue.oldestWaitMs)}` : '当前没有排队任务'}</small></article>
        <article className="ops-kpi"><span><Bot size={15} />Worker 租约</span><strong>{snapshot.workers.active}</strong><small>{snapshot.workers.staleLeases ? `${snapshot.workers.staleLeases} 个已过期` : '租约状态正常'}</small></article>
        <article className="ops-kpi"><span><Gauge size={15} />交付成功率</span><strong>{snapshot.sla.successRate === null ? '—' : `${snapshot.sla.successRate}%`}</strong><small>{snapshot.sla.terminalTasks ? `${snapshot.sla.terminalTasks} 个终态任务` : '暂无终态任务'}</small></article>
        <article className="ops-kpi"><span><Clock3 size={15} />P95 完成时长</span><strong>{formatDuration(snapshot.sla.p95DurationMs)}</strong><small>P50 {formatDuration(snapshot.sla.p50DurationMs)}</small></article>
      </div>
      <div className="ops-grid">
        {alerts && <article className="ops-panel ops-alert-panel"><header><div><Siren size={15} /><strong>需要处理</strong></div><span>{alerts.alerts.length ? `${alerts.alerts.length} 条提醒` : '运行正常'}</span></header>{alerts.alerts.length ? <div className="ops-alert-list">{alerts.alerts.map((alert) => <div className={`ops-alert-row severity-${alert.severity}`} key={alert.id}><span className="ops-alert-icon">{alert.severity === 'critical' ? <AlertTriangle size={14} /> : <ShieldAlert size={14} />}</span><div><strong>{alert.title}</strong><p>{operationsAlertDetail(alert, language)}</p><small>{alertLabel(alert.severity)} · {alert.metric}</small></div></div>)}</div> : <div className="ops-alert-clear"><CheckCircle2 size={18} /><span>当前窗口没有需要处理的运行异常。</span></div>}<div className="ops-alert-summary"><span>严重 {alerts.summary.critical}</span><span>关注 {alerts.summary.warning}</span><span>提示 {alerts.summary.info}</span></div></article>}
        <article className="ops-panel ops-queue-panel"><header><div><Layers3 size={15} /><strong>队列与租约</strong></div><span>{queueTotal} 个活动任务</span></header><div className="ops-queue-list">{queueRows.map(([label, value, tone]) => <div className="ops-queue-row" key={label}><span>{label}</span><div><i className={`ops-queue-bar tone-${tone}`} style={{ width: `${queueTotal ? Math.max(4, value / queueTotal * 100) : 0}%` }} /></div><b>{value}</b></div>)}</div>{snapshot.workers.leases.length > 0 ? <div className="ops-lease-list">{snapshot.workers.leases.map((lease) => <div key={lease.workerId}><span>{lease.workerId}</span><b>{lease.taskCount} 个任务</b><small>{lease.leaseExpiresAt ? `到期 ${new Date(lease.leaseExpiresAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}` : '无到期时间'}</small></div>)}</div> : <p className="ops-empty">当前没有持有租约的 Worker。</p>}</article>
        <article className="ops-panel"><header><div><Database size={15} /><strong>模型表现</strong></div><span>{snapshot.models.length} 个模型</span></header>{snapshot.models.length ? <div className="ops-table-wrap"><table className="ops-table"><thead><tr><th>模型</th><th>调用</th><th>成功率</th><th>延迟</th><th>Token</th><th>状态</th></tr></thead><tbody>{snapshot.models.map((model) => <tr key={model.model}><td title={model.model}>{model.model}</td><td>{model.calls}</td><td>{model.successRate === null ? '—' : `${model.successRate}%`}</td><td>{formatDuration(model.averageLatencyMs)}</td><td>{formatNumber(model.totalTokens)}</td><td><em className={healthClass(model.health)}>{healthLabel(model.health)}</em></td></tr>)}</tbody></table></div> : <p className="ops-empty">这段时间还没有模型调用。</p>}</article>
        <article className="ops-panel"><header><div><Wrench size={15} /><strong>工具失败分布</strong></div><span>{snapshot.tools.length} 个工具</span></header>{snapshot.tools.length ? <div className="ops-table-wrap"><table className="ops-table"><thead><tr><th>工具</th><th>调用</th><th>成功</th><th>失败</th><th>失败率</th></tr></thead><tbody>{snapshot.tools.map((tool) => <tr key={tool.name}><td title={tool.name}>{tool.name}</td><td>{tool.calls}</td><td>{tool.successes}</td><td className={tool.failures ? 'ops-danger' : ''}>{tool.failures}</td><td>{tool.failureRate}%</td></tr>)}</tbody></table></div> : <p className="ops-empty">这段时间没有工具调用。</p>}</article>
        <article className="ops-panel"><header><div><Bot size={15} /><strong>Agent 协作</strong></div><span>{snapshot.agents.length} 个 Agent</span></header>{snapshot.agents.length ? <div className="ops-agent-list">{snapshot.agents.slice(0, 8).map((agent) => <div key={agent.agentId}><span title={agent.agentId}>{agent.agentId}</span><small>{agent.role ?? '运行角色'}</small><b>{agent.successRate === null ? '—' : `${agent.successRate}%`}</b><em>{agent.completed} 完成 · {agent.failed} 失败</em></div>)}</div> : <p className="ops-empty">这段时间没有 Agent 执行记录。</p>}</article>
        <article className="ops-panel ops-review-panel"><header><div><CheckCircle2 size={15} /><strong>质量与人工接管</strong></div><span>{snapshot.reviewer.completed} 次审查</span></header><div className="ops-review-stats"><div><strong>{snapshot.reviewer.approvalRate === null ? '—' : `${snapshot.reviewer.approvalRate}%`}</strong><span>审查通过</span></div><div><strong>{snapshot.reviewer.humanTakeover}</strong><span>人工接管</span></div><div><strong>{snapshot.sla.failed + snapshot.sla.cancelled}</strong><span>失败/取消</span></div></div><div className="ops-review-foot"><span>审查启动 {snapshot.reviewer.started}</span><span className={snapshot.reviewer.rejected ? 'ops-danger' : ''}>驳回 {snapshot.reviewer.rejected}</span></div></article>
        <article className="ops-panel ops-sla-panel"><header><div><Clock3 size={15} /><strong>SLA 概览</strong></div><span>终态任务</span></header><div className="ops-sla-ring"><div><strong>{snapshot.sla.completed}</strong><span>完成</span></div><div><strong>{snapshot.sla.failed}</strong><span>失败</span></div><div><strong>{snapshot.sla.cancelled}</strong><span>取消</span></div></div><div className="ops-sla-foot"><span><CheckCircle2 size={13} />P50 {formatDuration(snapshot.sla.p50DurationMs)}</span><span><XCircle size={13} />P95 {formatDuration(snapshot.sla.p95DurationMs)}</span></div></article>
        {snapshot.contextSummaries && <article className="ops-panel ops-context-panel"><header><div><Layers3 size={15} /><strong>长对话整理</strong></div><span>{snapshot.contextSummaries.summaries} 个有效摘要</span></header>{snapshot.contextSummaries.summaries ? <><div className="ops-context-stats"><div><strong>{snapshot.contextSummaries.compressionPercent === null ? '—' : `${snapshot.contextSummaries.compressionPercent}%`}</strong><span>节省上下文</span></div><div><strong>{snapshot.contextSummaries.reuseRate === null ? '—' : `${snapshot.contextSummaries.reuseRate}%`}</strong><span>直接复用</span></div><div><strong>{snapshot.contextSummaries.averageCoveragePercent === null ? '—' : `${snapshot.contextSummaries.averageCoveragePercent}%`}</strong><span>覆盖消息</span></div></div><div className="ops-context-foot"><span>{formatNumber(snapshot.contextSummaries.sourceTokens)} → {formatNumber(snapshot.contextSummaries.summaryTokens)} Token</span><span>{snapshot.contextSummaries.exactSummaries > 0 && snapshot.contextSummaries.estimatedSummaries === 0 ? '精确计数' : '保守估算'}</span><span>重建 {snapshot.contextSummaries.rebuildCount} 次</span></div></> : <p className="ops-empty">长对话达到整理阈值后，这里会显示压缩和复用情况。</p>}</article>}
        {snapshot.artifacts && <article className="ops-panel ops-artifact-panel"><header><div><Database size={15} /><strong>Artifact 存储</strong></div><button type="button" className="ops-inline-action" disabled={cleaning} onClick={() => { setCleaning(true); setCleanupMessage(null); void cleanupArtifacts().then((result) => { setCleanupMessage(`已扫描 ${result.scanned ?? 0} 个，清理 ${result.deleted ?? 0} 个${result.failed ? `，${result.failed} 个待重试` : ''}。`); setRefreshKey((value) => value + 1); }).catch((caught) => setCleanupMessage(caught instanceof Error ? caught.message : 'Artifact 清理失败。')).finally(() => setCleaning(false)); }} title="重试清理队列"><Trash2 size={13} />{cleaning ? '清理中' : '重试清理'}</button></header><div className="ops-artifact-stats"><div><strong>{formatNumber(snapshot.artifacts.active)}</strong><span>有效</span></div><div><strong className={snapshot.artifacts.orphaned ? 'ops-danger' : ''}>{formatNumber(snapshot.artifacts.orphaned)}</strong><span>孤儿</span></div><div><strong className={snapshot.artifacts.deletePending ? 'ops-danger' : ''}>{formatNumber(snapshot.artifacts.deletePending)}</strong><span>待清理</span></div><div><strong>{formatNumber(snapshot.artifacts.totalBytes)}</strong><span>字节</span></div></div>{cleanupMessage && <p className="ops-artifact-message">{cleanupMessage}</p>}</article>}
      </div>
    </>}
  </section>;
}
