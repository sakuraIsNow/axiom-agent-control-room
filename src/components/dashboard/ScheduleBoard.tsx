import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Bot,
  CalendarClock,
  Check,
  ChevronDown,
  ChevronUp,
  Clock3,
  History,
  Play,
  Plus,
  RotateCcw,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import {
  createSchedule,
  draftSchedule,
  listScheduleRuns,
  listSchedules,
  removeSchedule,
  resumeSchedule,
  runSchedule,
} from '../../lib/scheduleRuntime';
import type { AgentMode, ScheduleCadence, ScheduleDraft, ScheduledTrigger, WorkflowTaskSummary } from '../../types';
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

const runStatus = (status: WorkflowTaskSummary['status']) => ({
  completed: '已完成', failed: '失败', cancelled: '已取消', paused: '已暂停', waiting_for_human: '等待确认',
  awaiting_approval: '等待批准', queued: '排队中', planning: '编排中', running: '执行中', reviewing: '审核中',
})[status] ?? status;

const evidenceText = (run: WorkflowTaskSummary) => {
  if (!run.evidenceSummary) return null;
  if (run.evidenceSummary.status === 'verified') return '交付已验证';
  if (run.evidenceSummary.status === 'partial') return '部分验证';
  if (run.evidenceSummary.status === 'unverified') return '尚未验证';
  return '无需验证';
};

export function ScheduleBoard({ sessionId, modelCredentialId }: { sessionId: string; modelCredentialId?: string }) {
  const [schedules, setSchedules] = useState<ScheduledTrigger[]>([]);
  const [latestRuns, setLatestRuns] = useState<Record<string, WorkflowTaskSummary>>({});
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
      const overview = await listSchedules();
      setSchedules(overview.schedules);
      setLatestRuns(overview.latestRuns);
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

  const nextSchedule = useMemo(() => schedules
    .filter((schedule) => schedule.enabled && schedule.lastRunStatus !== 'dead-letter')
    .sort((left, right) => Date.parse(left.nextRunAt) - Date.parse(right.nextRunAt))[0], [schedules]);

  const generateDraft = async () => {
    if (!request.trim()) return;
    setBusy('draft');
    setError(null);
    setDraftResult(null);
    try {
      const result = await draftSchedule({ request: request.trim(), sessionId, modelCredentialId });
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
      await createSchedule({ sessionId, title: draft.title, input: draft.input, mode: draft.mode, cadence: draft.schedule, modelCredentialId });
      setRequest('');
      setDraftResult(null);
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
      await createSchedule({ sessionId, title, input, mode, intervalSeconds: Math.max(15, Math.round(intervalMinutes * 60)), modelCredentialId });
      setTitle('');
      setInput('');
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
        return <article key={schedule.id} className={`dash-agent-card schedule-card ${schedule.lastRunStatus === 'dead-letter' ? 'schedule-dead-letter' : ''}`}>
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
  </div>;
}
