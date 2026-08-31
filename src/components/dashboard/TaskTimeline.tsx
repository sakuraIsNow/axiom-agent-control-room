import { useEffect, useMemo, useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
import type { WorkflowTaskSummary } from '../../types';
import { taskStatusColor, taskStatusLabels } from '../../lib/graphPresentation';
import { taskRouteLabel, taskStageLabel } from '../../lib/taskPresentation';

const HOURS = [0, 4, 8, 12, 16, 20, 24];

const startOfLocalDay = (value: Date | number) => {
  const date = new Date(value);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
};

const shiftDay = (value: number, amount: number) => {
  const date = new Date(value);
  date.setDate(date.getDate() + amount);
  return startOfLocalDay(date);
};

const formatDay = (value: number) => new Date(value).toLocaleDateString('zh-CN', {
  month: 'long', day: 'numeric', weekday: 'short',
});

export function TaskTimeline({ tasks }: { tasks: WorkflowTaskSummary[] }) {
  const [selectedDay, setSelectedDay] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const dayStart = selectedDay ?? startOfLocalDay(now);
  const dayEnd = shiftDay(dayStart, 1);
  const isToday = dayStart === startOfLocalDay(now);
  const dailyTasks = useMemo(() => tasks
    .filter((task) => {
      const createdAt = new Date(task.createdAt).getTime();
      return createdAt >= dayStart && createdAt < dayEnd;
    })
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()), [dayEnd, dayStart, tasks]);

  return <section className="dash-timeline" aria-label="每日工作进程">
    <header className="dash-timeline-head">
      <div><CalendarDays size={14} /><span>每日工作进程</span><em>{dailyTasks.length} 个任务</em></div>
      <div className="dash-timeline-date-controls">
        <button type="button" title="前一天" onClick={() => setSelectedDay(shiftDay(dayStart, -1))}><ChevronLeft size={14} /></button>
        <strong>{formatDay(dayStart)}</strong>
        <button type="button" title="后一天" onClick={() => setSelectedDay(shiftDay(dayStart, 1))}><ChevronRight size={14} /></button>
        <button type="button" className={isToday ? 'active' : ''} onClick={() => setSelectedDay(startOfLocalDay(Date.now()))}>今天</button>
      </div>
    </header>

    <div
      className="dash-day-scroll"
      tabIndex={0}
      aria-label="当日全部工作进程，可上下滚动"
      onWheel={(event) => {
        if (!event.deltaY) return;
        event.stopPropagation();
        event.currentTarget.scrollTop += event.deltaY;
      }}
    >
      <div className="dash-day-grid">
        <div className="dash-day-axis-label">工作流</div>
        <div className="dash-day-axis">
          {HOURS.map((hour) => <span key={hour} style={{ left: `${(hour / 24) * 100}%` }}>{String(hour).padStart(2, '0')}:00</span>)}
        </div>

        {dailyTasks.length === 0 ? <div className="dash-day-empty">当日没有任务记录</div> : dailyTasks.map((task) => {
          const createdAt = Math.max(dayStart, new Date(task.createdAt).getTime());
          const finished = ['completed', 'failed', 'cancelled'].includes(task.status);
          const rawEnd = finished ? new Date(task.updatedAt).getTime() : now;
          const endedAt = Math.min(dayEnd, Math.max(createdAt, rawEnd));
          const left = Math.max(0, Math.min(100, ((createdAt - dayStart) / (dayEnd - dayStart)) * 100));
          const actualWidth = ((endedAt - createdAt) / (dayEnd - dayStart)) * 100;
          const width = Math.min(100 - left, Math.max(0.7, actualWidth));
          const tone = taskStatusColor(task.status);
          return <div className="dash-day-row" key={task.id}>
            <div className="dash-day-task">
              <strong title={task.title}>{task.title}</strong>
              <span>{taskRouteLabel(task.profile?.route ?? task.mode)} · {taskStatusLabels[task.status]}</span>
            </div>
            <div className="dash-day-track">
              {HOURS.map((hour) => <i key={hour} style={{ left: `${(hour / 24) * 100}%` }} />)}
              <span className={`dash-day-bar tone-${tone}`} style={{ left: `${left}%`, width: `${width}%` }} title={`${task.title} · ${taskStatusLabels[task.status]}`}>
                <b>{taskStageLabel(task.currentStage)}</b>
              </span>
              {isToday && <span className="dash-day-now" style={{ left: `${Math.min(100, ((now - dayStart) / (dayEnd - dayStart)) * 100)}%` }} />}
            </div>
          </div>;
        })}
      </div>
    </div>
  </section>;
}
