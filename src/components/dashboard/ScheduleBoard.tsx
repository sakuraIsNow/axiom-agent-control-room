import { useCallback, useEffect, useState } from 'react';
import { CalendarClock, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { createSchedule, listSchedules, removeSchedule, resumeSchedule } from '../../lib/scheduleRuntime';
import type { AgentMode, ScheduledTrigger } from '../../types';
import { userFacingError } from '../../lib/errorPresentation';

const modeLabel: Record<AgentMode, string> = { analyze: '分析', build: '构建', decide: '决策' };

export function ScheduleBoard({ sessionId }: { sessionId: string }) {
  const [schedules, setSchedules] = useState<ScheduledTrigger[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [input, setInput] = useState('');
  const [mode, setMode] = useState<AgentMode>('analyze');
  const [intervalMinutes, setIntervalMinutes] = useState(60);

  const refresh = useCallback(async () => {
    try {
      setSchedules(await listSchedules());
    } catch (caught) {
      setError(userFacingError(caught, '加载日程失败。'));
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const submit = async () => {
    if (!title.trim() || !input.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await createSchedule({ sessionId, title, input, mode, intervalSeconds: Math.max(15, Math.round(intervalMinutes * 60)) });
      setTitle('');
      setInput('');
      setCreating(false);
      await refresh();
    } catch (caught) {
      setError(userFacingError(caught, '创建日程失败。'));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setBusy(true);
    try { await removeSchedule(id); await refresh(); } catch (caught) { setError(userFacingError(caught, '删除失败。')); } finally { setBusy(false); }
  };

  const resume = async (id: string) => {
    setBusy(true);
    setError(null);
    try { await resumeSchedule(id); await refresh(); } catch (caught) { setError(userFacingError(caught, '恢复日程失败。')); } finally { setBusy(false); }
  };

  return <div className="dash-agent-studio">
    <div className="dash-agent-studio-head">
      <div><CalendarClock size={16} /><span>日程</span><small>定时重复提交任务（预测下一次触发时间）</small></div>
      <button type="button" onClick={() => setCreating((value) => !value)}><Plus size={14} />新建日程</button>
    </div>
    {error && <div className="dash-agent-studio-error">{error}</div>}
    {creating && <div className="dash-agent-studio-form">
      <div className="dash-form-row"><label>标题</label><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：每日运行时健康巡检" /></div>
      <div className="dash-form-row"><label>任务内容</label><textarea rows={3} value={input} onChange={(event) => setInput(event.target.value)} placeholder="提交给运行时的目标描述" /></div>
      <div className="dash-form-row"><label>间隔（分钟）</label><input type="number" min={1} value={intervalMinutes} onChange={(event) => setIntervalMinutes(Number(event.target.value) || 1)} /></div>
      <div className="dash-form-row">
        <label>模式</label>
        <select value={mode} onChange={(event) => setMode(event.target.value as AgentMode)}>
          <option value="analyze">分析</option>
          <option value="build">构建</option>
          <option value="decide">决策</option>
        </select>
      </div>
      <button type="button" className="dash-form-submit" disabled={busy} onClick={() => void submit()}>保存日程</button>
    </div>}
    <div className="dash-agent-studio-list">
      {schedules.length === 0 && <div className="dash-empty">暂无日程，点击"新建日程"开始。</div>}
      {schedules.map((schedule) => <div key={schedule.id} className={`dash-agent-card schedule-card ${schedule.lastRunStatus === 'dead-letter' ? 'schedule-dead-letter' : ''}`}>
        <div className="dash-agent-card-head"><strong>{schedule.title}</strong><span>{modeLabel[schedule.mode]}</span><em className={`schedule-status ${schedule.lastRunStatus ?? (schedule.enabled ? 'success' : 'paused')}`}>{schedule.lastRunStatus === 'dead-letter' ? '已暂停' : schedule.lastRunStatus === 'failed' ? `重试中 · ${schedule.failureCount}` : schedule.enabled ? '运行正常' : '已停用'}</em></div>
        <p>下一次触发：{schedule.lastRunStatus === 'dead-letter' ? '等待恢复' : new Date(schedule.nextRunAt).toLocaleString()} · 每 {Math.round(schedule.intervalSeconds / 60)} 分钟</p>
        {schedule.failureCount > 0 && <div className="schedule-health-note">
          <span>{schedule.lastRunStatus === 'dead-letter' ? `连续失败 ${schedule.failureCount} 次，已移入死信` : `最近失败 ${schedule.failureCount} 次，系统将自动重试`}</span>
          {schedule.lastError && <small title={schedule.lastError}>{schedule.lastError}</small>}
        </div>}
        <div className="dash-agent-card-actions">
          {schedule.lastRunStatus === 'dead-letter' && <button type="button" disabled={busy} onClick={() => void resume(schedule.id)}><RotateCcw size={13} />恢复运行</button>}
          <button type="button" disabled={busy} onClick={() => void remove(schedule.id)}><Trash2 size={13} />删除</button>
        </div>
      </div>)}
    </div>
  </div>;
}
