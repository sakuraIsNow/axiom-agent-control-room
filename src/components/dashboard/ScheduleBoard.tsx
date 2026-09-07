import { useCallback, useEffect, useMemo, useState } from 'react';
import { completionSourceStatus, evidenceSourceLabels } from '../../lib/evidencePresentation';
import {
  Activity,
  Bot,
  CalendarDays,
  CalendarClock,
  Check,
  ChevronDown,
  ChevronUp,
  Clock3,
  History,
  Link2,
  Play,
  Plus,
  RotateCcw,
  ShieldAlert,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import {
  applyScheduleHealthAction,
  createSchedule,
  draftSchedule,
  getScheduleInsights,
  listScheduleRuns,
  listScheduleArtifactInputs,
  listSchedules,
  removeSchedule,
  resumeSchedule,
  runSchedule,
} from '../../lib/scheduleRuntime';
import type { ScheduleArtifactCandidate } from '../../lib/scheduleRuntime';
import type { AgentMode, ScheduleCadence, ScheduleDraft, ScheduleHealthActionAudit, ScheduleHealthSuggestion, ScheduleInsights, ScheduledTrigger, WorkflowTaskSummary } from '../../types';
import { userFacingError } from '../../lib/errorPresentation';

const modeLabel: Record<AgentMode, string> = { analyze: '分析', build: '构建', decide: '决策' };
const weekdayLabel = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const agentLabels: Record<string, string> = {
  'direct-responder': '对话 Agent',
  'search-agent': '搜索 Agent',
  'academic-search-agent': '论文 Agent',
  'github-research-agent': 'GitHub Agent',
  researcher: '研究 Agent',
  analyst: '分析 Agent',
  builder: '构建 Agent',
  reviewer: '审核 Agent',
  synthesizer: '交付 Agent',
  'drawing-agent': '绘图 Agent',
  'video-agent': '视频 Agent',
};

const cadenceText = (cadence: ScheduleCadence) => {
  if (cadence.kind === 'once') return `单次 · ${new Date(cadence.runAt).toLocaleString()}`;
  if (cadence.kind === 'daily') return `每天 ${cadence.timeOfDay}`;
  if (cadence.kind === 'weekly') return `${cadence.weekdays.map((day) => weekdayLabel[day]).join('、')} ${cadence.timeOfDay}`;
  if (cadence.intervalSeconds % 3_600 === 0) return `每 ${cadence.intervalSeconds / 3_600} 小时`;
  if (cadence.intervalSeconds % 60 === 0) return `每 ${cadence.intervalSeconds / 60} 分钟`;
  return `每 ${cadence.intervalSeconds} 秒`;
};

const dateKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const calendarDays = (from: string, count: number) => Array.from({ length: count }, (_, index) => {
  const date = new Date(from);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + index);
  return date;
});

const runStatus = (status: WorkflowTaskSummary['status']) => ({
  completed: '已完成', failed: '失败', cancelled: '已取消', paused: '已暂停', waiting_for_human: '等待确认',
  awaiting_approval: '等待批准', queued: '排队中', planning: '编排中', running: '执行中', reviewing: '审核中',
})[status] ?? status;

const evidenceText = (run: WorkflowTaskSummary) => {
  if (!run.evidenceSummary) return null;
  return evidenceSourceLabels[completionSourceStatus(run.evidenceSummary)];
};

const healthActionLabel: Record<ScheduleHealthActionAudit['action'], string> = {
  pause: '已确认暂停',
  resume: '已确认恢复',
  reschedule: '已确认调整时间',
};

export function ScheduleBoard({ sessionId, modelCredentialId, providerConfig }: { sessionId: string; modelCredentialId?: string; providerConfig?: import('../../lib/taskRuntime').TaskProviderConfig }) {
  const [schedules, setSchedules] = useState<ScheduledTrigger[]>([]);
  const [latestRuns, setLatestRuns] = useState<Record<string, WorkflowTaskSummary>>({});
  const [insights, setInsights] = useState<ScheduleInsights | null>(null);
  const [healthActions, setHealthActions] = useState<ScheduleHealthActionAudit[]>([]);
  const [artifactInputs, setArtifactInputs] = useState<ScheduleArtifactCandidate[]>([]);
  const [inputArtifactTaskId, setInputArtifactTaskId] = useState('');
  const [calendarMode, setCalendarMode] = useState<'week' | 'month'>('week');
  const [confirmSuggestion, setConfirmSuggestion] = useState<ScheduleHealthSuggestion | null>(null);
  const [runs, setRuns] = useState<Record<string, WorkflowTaskSummary[]>>({});
  const [expandedSchedule, setExpandedSchedule] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [request, setRequest] = useState('');
  const [draftResult, setDraftResult] = useState<{ draft: ScheduleDraft; source: string; warning?: string } | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [input, setInput] = useState('');
  const [mode, setMode] = useState<AgentMode>('analyze');
  const [intervalMinutes, setIntervalMinutes] = useState(60);

  const refresh = useCallback(async () => {
    try {
      const [overview, insightSnapshot, artifactCandidates] = await Promise.all([
        listSchedules(),
        getScheduleInsights(35),
        listScheduleArtifactInputs().catch(() => []),
      ]);
      setSchedules(overview.schedules);
      setLatestRuns(overview.latestRuns);
      setHealthActions(overview.healthActions);
      setInsights(insightSnapshot);
      setArtifactInputs(artifactCandidates);
      setError(null);
    } catch (caught) {
      setError(userFacingError(caught, '加载日程失败。'));
    }
  }, []);

  const loadRuns = useCallback(async (scheduleId: string) => {
    try {
      const items = await listScheduleRuns(scheduleId);
      setRuns((current) => ({ ...current, [scheduleId]: items }));
      if (items[0]) setLatestRuns((current) => ({ ...current, [scheduleId]: items[0]! }));
    } catch (caught) {
      setError(userFacingError(caught, '读取运行记录失败。'));
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!expandedSchedule) return;
    const timer = window.setInterval(() => void loadRuns(expandedSchedule), 5_000);
    return () => window.clearInterval(timer);
  }, [expandedSchedule, loadRuns]);
  useEffect(() => {
    if (!confirmSuggestion) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) setConfirmSuggestion(null);
    };
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [busy, confirmSuggestion]);

  const nextSchedule = useMemo(() => schedules
    .filter((schedule) => schedule.enabled && schedule.lastRunStatus !== 'dead-letter')
    .sort((left, right) => Date.parse(left.nextRunAt) - Date.parse(right.nextRunAt))[0], [schedules]);

  const generateDraft = async () => {
    if (!request.trim()) return;
    setBusy('draft');
    setError(null);
    setDraftResult(null);
    try {
      const result = await draftSchedule({ request: request.trim(), sessionId, modelCredentialId, providerConfig });
      setDraftResult(result);
    } catch (caught) {
      setError(userFacingError(caught, '日程 Agent 未能生成草案。'));
    } finally {
      setBusy(null);
    }
  };

  const saveDraft = async () => {
    if (!draftResult) return;
    setBusy('save-draft');
    setError(null);
    try {
      const { draft } = draftResult;
      await createSchedule({ sessionId, title: draft.title, input: draft.input, mode: draft.mode, cadence: draft.schedule, modelCredentialId, providerConfig, inputArtifactTaskId: inputArtifactTaskId || undefined });
      setRequest('');
      setDraftResult(null);
      setInputArtifactTaskId('');
      await refresh();
    } catch (caught) {
      setError(userFacingError(caught, '保存日程失败。'));
    } finally {
      setBusy(null);
    }
  };

  const submitAdvanced = async () => {
    if (!title.trim() || !input.trim()) return;
    setBusy('advanced');
    setError(null);
    try {
      await createSchedule({ sessionId, title, input, mode, intervalSeconds: Math.max(15, Math.round(intervalMinutes * 60)), modelCredentialId, providerConfig, inputArtifactTaskId: inputArtifactTaskId || undefined });
      setTitle('');
      setInput('');
      setInputArtifactTaskId('');
      setAdvancedOpen(false);
      await refresh();
    } catch (caught) {
      setError(userFacingError(caught, '创建日程失败。'));
    } finally {
      setBusy(null);
    }
  };

  const runNow = async (scheduleId: string) => {
    setBusy(`run:${scheduleId}`);
    setError(null);
    try {
      await runSchedule(scheduleId);
      setExpandedSchedule(scheduleId);
      await loadRuns(scheduleId);
      await refresh();
    } catch (caught) {
      setError(userFacingError(caught, '立即运行失败。'));
    } finally {
      setBusy(null);
    }
  };

  const toggleRuns = async (scheduleId: string) => {
    if (expandedSchedule === scheduleId) {
      setExpandedSchedule(null);
      return;
    }
    setExpandedSchedule(scheduleId);
    await loadRuns(scheduleId);
  };

  const remove = async (id: string) => {
    setBusy(`delete:${id}`);
    setError(null);
    try {
      await removeSchedule(id);
      setDeleteConfirm(null);
      if (expandedSchedule === id) setExpandedSchedule(null);
      await refresh();
    } catch (caught) {
      setError(userFacingError(caught, '删除失败。'));
    } finally {
      setBusy(null);
    }
  };

  const resume = async (id: string) => {
    setBusy(`resume:${id}`);
    setError(null);
    try {
      await resumeSchedule(id);
      await refresh();
    } catch (caught) {
      setError(userFacingError(caught, '恢复日程失败。'));
    } finally {
      setBusy(null);
    }
  };

  const applySuggestion = async () => {
    if (!confirmSuggestion) return;
    setBusy(`health:${confirmSuggestion.id}`);
    setError(null);
    try {
      await applyScheduleHealthAction(confirmSuggestion.scheduleId, confirmSuggestion.id);
      setConfirmSuggestion(null);
      await refresh();
    } catch (caught) {
      setError(userFacingError(caught, '这条建议没有执行。'));
    } finally {
      setBusy(null);
    }
  };

  const visibleDays = useMemo(() => insights
    ? calendarDays(insights.range.from, calendarMode === 'week' ? 7 : 35)
    : [], [calendarMode, insights]);
  const occurrencesByDay = useMemo(() => {
    const grouped = new Map<string, NonNullable<ScheduleInsights>['occurrences']>();
    for (const occurrence of insights?.occurrences ?? []) {
      const key = dateKey(new Date(occurrence.startsAt));
      grouped.set(key, [...(grouped.get(key) ?? []), occurrence]);
    }
    return grouped;
  }, [insights]);

  return <div className="dash-agent-studio schedule-workspace">
    <div className="schedule-hero">
      <div className="schedule-hero-copy">
        <span className="schedule-kicker"><Sparkles size={14} /> 日程 Agent</span>
        <h2>什么时候，替你完成什么？</h2>
        <p>用一句话安排。保存前先确认，到点后再由 Agent 自动分工。</p>
      </div>
      <div className="schedule-next-run">
        <Clock3 size={15} />
        <span>{nextSchedule ? '下一项' : '当前'}</span>
        <strong>{nextSchedule ? nextSchedule.title : '暂无待执行日程'}</strong>
        {nextSchedule && <time>{new Date(nextSchedule.nextRunAt).toLocaleString()}</time>}
      </div>
    </div>

    <div className="schedule-agent-composer">
      <Bot size={19} />
      <textarea
        rows={2}
        value={request}
        onChange={(event) => setRequest(event.target.value)}
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); void generateDraft(); }
        }}
        placeholder="例如：每天早上 9 点搜索 Agent 行业动态，整理成 5 条摘要并保留来源"
      />
      <button type="button" disabled={busy !== null || !request.trim()} onClick={() => void generateDraft()}>
        <Sparkles size={15} />{busy === 'draft' ? '正在理解' : '生成草案'}
      </button>
    </div>

    {artifactInputs.length > 0 && <label className="schedule-artifact-link">
      <span><Link2 size={14} />接续可用结果</span>
      <select value={inputArtifactTaskId} onChange={(event) => setInputArtifactTaskId(event.target.value)}>
        <option value="">不接续，独立执行</option>
        {artifactInputs.map((artifact) => <option key={artifact.taskId} value={artifact.taskId}>{artifact.title}</option>)}
      </select>
      {inputArtifactTaskId && <small>执行时会校验来源版本；原结果变化时自动停止，不会静默使用新内容。</small>}
    </label>}

    {error && <div className="dash-agent-studio-error">{error}</div>}

    {draftResult && <section className="schedule-draft" aria-label="待确认的日程草案">
      <header>
        <span><Check size={15} />待确认</span>
        <button type="button" aria-label="关闭草案" onClick={() => setDraftResult(null)}><X size={15} /></button>
      </header>
      <div className="schedule-draft-grid">
        <div><small>日程</small><strong>{draftResult.draft.title}</strong><p>{draftResult.draft.input}</p></div>
        <div className="schedule-draft-facts">
          <span><CalendarClock size={14} />{cadenceText(draftResult.draft.schedule)}</span>
          <span><Bot size={14} />Agent 自动编排</span>
          <span>{modeLabel[draftResult.draft.mode]}</span>
        </div>
      </div>
      <p className="schedule-draft-reason">{draftResult.draft.reason}</p>
      {draftResult.warning && <p className="schedule-draft-warning">{draftResult.warning}</p>}
      <footer>
        <button type="button" className="secondary" onClick={() => setDraftResult(null)}>重新描述</button>
        <button type="button" disabled={busy !== null} onClick={() => void saveDraft()}><Check size={14} />{busy === 'save-draft' ? '保存中' : '确认并启用'}</button>
      </footer>
    </section>}

    <section className="schedule-intelligence" aria-label="日程计划">
      <header>
        <div>
          <span><CalendarDays size={15} />执行计划</span>
          <strong>{insights?.capacity.overloadedWindows ? `${insights.capacity.overloadedWindows} 个时间冲突` : '未来安排正常'}</strong>
        </div>
        <div className="schedule-view-switch" aria-label="日历范围">
          <button type="button" aria-pressed={calendarMode === 'week'} onClick={() => setCalendarMode('week')}>本周</button>
          <button type="button" aria-pressed={calendarMode === 'month'} onClick={() => setCalendarMode('month')}>未来 35 天</button>
        </div>
      </header>
      <div className="schedule-capacity-strip">
        <span><Activity size={13} />峰值负载 <strong>{insights?.capacity.peakLoad ?? 0}/{insights?.capacity.limit ?? 4}</strong></span>
        <i className={(insights?.capacity.overloadedWindows ?? 0) > 0 ? 'warning' : 'healthy'} />
        <small>{insights?.range.truncated ? '高频日程已折叠' : '按 30 分钟窗口估算'}</small>
      </div>
      <div className={`schedule-calendar ${calendarMode}`}>
        {visibleDays.map((day) => {
          const dayOccurrences = occurrencesByDay.get(dateKey(day)) ?? [];
          const overloaded = dayOccurrences.some((item) => item.capacity === 'overloaded');
          return <div key={dateKey(day)} className={`schedule-calendar-day ${overloaded ? 'overloaded' : ''}`}>
            <header><span>{weekdayLabel[day.getDay()]}</span><strong>{day.getDate()}</strong></header>
            <div>
              {dayOccurrences.slice(0, calendarMode === 'week' ? 4 : 2).map((occurrence) => <button
                type="button"
                key={occurrence.id}
                className={`schedule-occurrence ${occurrence.capacity}`}
                title={`${occurrence.title} · 预计负载 ${occurrence.windowLoad}/${insights?.capacity.limit ?? 4}`}
                onClick={() => document.getElementById(`schedule-${occurrence.scheduleId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
              >
                <time>{new Date(occurrence.startsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
                <span>{occurrence.title}</span>
              </button>)}
              {dayOccurrences.length === 0 && calendarMode === 'week' && <small>空闲</small>}
              {dayOccurrences.length > (calendarMode === 'week' ? 4 : 2) && <em>+{dayOccurrences.length - (calendarMode === 'week' ? 4 : 2)}</em>}
            </div>
          </div>;
        })}
      </div>
    </section>

    {(insights?.suggestions.length ?? 0) > 0 && <section className="schedule-health-agent" aria-label="日程健康建议">
      <header><span><ShieldAlert size={15} />健康 Agent</span><em>{insights?.suggestions.length}</em></header>
      <div>
        {insights?.suggestions.map((suggestion) => <article key={suggestion.id} className={suggestion.severity}>
          <span><strong>{suggestion.title}</strong><small>{schedules.find((item) => item.id === suggestion.scheduleId)?.title}</small></span>
          <p>{suggestion.reason}</p>
          <button type="button" disabled={busy !== null} onClick={() => setConfirmSuggestion(suggestion)}>{suggestion.actionLabel}</button>
        </article>)}
      </div>
    </section>}

    {healthActions.length > 0 && <section className="schedule-health-history" aria-label="已确认的日程调整">
      <div className="schedule-health-history-title"><Check size={15} /><span>已确认调整</span></div>
      <div className="schedule-health-history-list">
        {healthActions.slice(0, 4).map((action) => <div key={action.id} className="schedule-health-history-row">
          <span><strong>{healthActionLabel[action.action]}</strong><small>{schedules.find((item) => item.id === action.scheduleId)?.title ?? '已删除日程'}</small></span>
          <time dateTime={action.confirmedAt}>{new Date(action.confirmedAt).toLocaleString()}</time>
        </div>)}
      </div>
    </section>}

    <details className="schedule-advanced" open={advancedOpen} onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}>
      <summary><Plus size={14} />高级设置：固定间隔</summary>
      <div className="dash-agent-studio-form">
        <div className="dash-form-row"><label>标题</label><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：运行时健康巡检" /></div>
        <div className="dash-form-row"><label>任务目标</label><textarea rows={3} value={input} onChange={(event) => setInput(event.target.value)} placeholder="到点后需要完成什么" /></div>
        <div className="schedule-advanced-row">
          <div className="dash-form-row"><label>间隔（分钟）</label><input type="number" min={1} value={intervalMinutes} onChange={(event) => setIntervalMinutes(Number(event.target.value) || 1)} /></div>
          <div className="dash-form-row"><label>任务方式</label><select value={mode} onChange={(event) => setMode(event.target.value as AgentMode)}><option value="analyze">分析</option><option value="build">构建</option><option value="decide">决策</option></select></div>
        </div>
        <button type="button" className="dash-form-submit" disabled={busy !== null || !title.trim() || !input.trim()} onClick={() => void submitAdvanced()}>保存固定间隔</button>
      </div>
    </details>

    <div className="schedule-list-head"><span>已启用日程</span><em>{schedules.length}</em></div>
    <div className="dash-agent-studio-list schedule-list">
      {schedules.length === 0 && <div className="dash-empty schedule-empty"><CalendarClock size={20} /><span>还没有日程</span></div>}
      {schedules.map((schedule) => {
        const latest = latestRuns[schedule.id];
        const expanded = expandedSchedule === schedule.id;
        const completedOnce = schedule.cadence.kind === 'once' && !schedule.enabled && schedule.lastRunStatus === 'success';
        return <article id={`schedule-${schedule.id}`} key={schedule.id} className={`dash-agent-card schedule-card ${schedule.lastRunStatus === 'dead-letter' ? 'schedule-dead-letter' : ''}`}>
          <div className="schedule-card-main">
            <div className="dash-agent-card-head">
              <strong>{schedule.title}</strong>
              <span>{modeLabel[schedule.mode]}</span>
              <em className={`schedule-status ${schedule.lastRunStatus ?? (schedule.enabled ? 'success' : 'paused')}`}>
                {completedOnce ? '已完成' : schedule.lastRunStatus === 'dead-letter' ? '已暂停' : schedule.lastRunStatus === 'failed' ? `重试中 · ${schedule.failureCount}` : schedule.enabled ? '已启用' : '已停用'}
              </em>
            </div>
            <p className="schedule-objective">{schedule.input}</p>
            <div className="schedule-meta">
              <span><CalendarClock size={13} />{cadenceText(schedule.cadence)}</span>
              <span><Bot size={13} />自动编排</span>
              {schedule.inputArtifact && <span><Link2 size={13} />接续 {schedule.inputArtifact.title}</span>}
              {!completedOnce && schedule.enabled && <span>下次 {new Date(schedule.nextRunAt).toLocaleString()}</span>}
            </div>
            {latest && <div className="schedule-latest-run">
              <span className={`run-state state-${latest.status}`}>{runStatus(latest.status)}</span>
              <strong>{latest.activeAgentIds?.map((agent) => agentLabels[agent] ?? agent).join(' · ') || '等待 Agent 路由'}</strong>
              <small>{new Date(latest.updatedAt).toLocaleString()} · {latest.tokens.total.toLocaleString()} tokens{evidenceText(latest) ? ` · ${evidenceText(latest)}` : ''}</small>
            </div>}
            {schedule.failureCount > 0 && <div className="schedule-health-note"><span>{schedule.lastRunStatus === 'dead-letter' ? `连续触发失败 ${schedule.failureCount} 次，已暂停` : `触发失败 ${schedule.failureCount} 次，系统将自动重试`}</span>{schedule.lastError && <small title={schedule.lastError}>{schedule.lastError}</small>}</div>}
            <div className="dash-agent-card-actions schedule-actions">
              <button type="button" disabled={busy !== null || !schedule.enabled} onClick={() => void runNow(schedule.id)}><Play size={13} />{busy === `run:${schedule.id}` ? '启动中' : '立即运行'}</button>
              <button type="button" disabled={busy !== null} onClick={() => void toggleRuns(schedule.id)}><History size={13} />运行记录{expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}</button>
              {schedule.lastRunStatus === 'dead-letter' && <button type="button" disabled={busy !== null} onClick={() => void resume(schedule.id)}><RotateCcw size={13} />恢复</button>}
              {deleteConfirm === schedule.id
                ? <><button type="button" className="danger" disabled={busy !== null} onClick={() => void remove(schedule.id)}>确认删除</button><button type="button" disabled={busy !== null} onClick={() => setDeleteConfirm(null)}>取消</button></>
                : <button type="button" aria-label={`删除${schedule.title}`} disabled={busy !== null} onClick={() => setDeleteConfirm(schedule.id)}><Trash2 size={13} /></button>}
            </div>
          </div>
          {expanded && <div className="schedule-run-history">
            {(runs[schedule.id] ?? []).length === 0 && <div className="schedule-run-empty">还没有运行记录</div>}
            {(runs[schedule.id] ?? []).map((run) => <div key={run.id} className="schedule-run-row">
              <span className={`run-state state-${run.status}`}>{runStatus(run.status)}</span>
              <div><strong>{run.activeAgentIds?.map((agent) => agentLabels[agent] ?? agent).join(' → ') || 'Agent 正在编排'}</strong><small>{run.manual ? '手动触发' : '自动触发'} · {new Date(run.createdAt).toLocaleString()}</small></div>
              <em>{run.totalSteps ? `${run.completedSteps}/${run.totalSteps} 步` : run.currentStage}</em>
            </div>)}
          </div>}
        </article>;
      })}
    </div>
    {confirmSuggestion && <div className="schedule-confirm-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy) setConfirmSuggestion(null);
    }}>
      <section className="schedule-confirm-dialog" role="dialog" aria-modal="true" aria-label="确认日程调整">
        <header><span><ShieldAlert size={16} />确认调整</span><button type="button" aria-label="关闭日程调整" disabled={busy !== null} onClick={() => setConfirmSuggestion(null)}><X size={15} /></button></header>
        <strong>{confirmSuggestion.title}</strong>
        <p>{confirmSuggestion.reason}</p>
        <div>{confirmSuggestion.evidence.map((item) => <span key={item}>{item}</span>)}</div>
        {confirmSuggestion.proposedCadence && <small>调整后：{cadenceText(confirmSuggestion.proposedCadence)}</small>}
        <footer><button type="button" className="secondary" autoFocus disabled={busy !== null} onClick={() => setConfirmSuggestion(null)}>取消</button><button type="button" disabled={busy !== null} onClick={() => void applySuggestion()}>{busy ? '正在应用' : confirmSuggestion.actionLabel}</button></footer>
      </section>
    </div>}
  </div>;
}
