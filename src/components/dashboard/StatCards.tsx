import { CheckCircle2, Clock3, ListTodo, XCircle } from 'lucide-react';
import type { TaskStats, WorkflowTaskSummary } from '../../types';

const terminalFailed = (stats: TaskStats) => (stats.byStatus.failed ?? 0) + (stats.byStatus.cancelled ?? 0);
const queued = (stats: TaskStats) => (stats.byStatus.queued ?? 0) + (stats.byStatus.planning ?? 0) + (stats.byStatus.awaiting_approval ?? 0);
const active = (stats: TaskStats) => (stats.byStatus.running ?? 0) + (stats.byStatus.reviewing ?? 0) + (stats.byStatus.waiting_for_human ?? 0) + (stats.byStatus.paused ?? 0);

const trend = (last: number, prev: number) => {
  if (prev === 0) return last > 0 ? '较过去 24 小时 新增' : '与过去 24 小时持平';
  const delta = Math.round(((last - prev) / prev) * 100);
  if (delta === 0) return '与过去 24 小时持平';
  return `${delta > 0 ? '+' : ''}${delta}% 较过去 24 小时`;
};

export function StatCards({ stats, tasks = [] }: { stats: TaskStats | null; tasks?: WorkflowTaskSummary[] }) {
  if (!stats) {
    return <div className="dash-stat-cards dash-stat-cards-loading">{Array.from({ length: 4 }).map((_, index) => <div key={index} className="dash-stat-card skeleton" />)}</div>;
  }
  const cards = [
    { label: '排队中', value: queued(stats), icon: ListTodo, tone: 'queued' as const },
    { label: '运行中', value: active(stats), icon: Clock3, tone: 'running' as const },
    { label: '已完成', value: stats.byStatus.completed ?? 0, icon: CheckCircle2, tone: 'completed' as const },
    { label: '失败/取消', value: terminalFailed(stats), icon: XCircle, tone: 'failed' as const },
    { label: '审查通过率', value: stats.reviewApprovalRate === null ? '—' : `${stats.reviewApprovalRate}%`, icon: CheckCircle2, tone: 'completed' as const },
  ];
  const completed = tasks.filter((task) => task.status === 'completed' && task.durationMs > 0);
  const averageDurationMs = completed.length ? completed.reduce((sum, task) => sum + task.durationMs, 0) / completed.length : null;
  const averageDuration = averageDurationMs === null ? '暂无时长数据' : averageDurationMs < 60_000 ? `${Math.round(averageDurationMs / 1000)} 秒` : `${(averageDurationMs / 60_000).toFixed(1)} 分钟`;
  return <div className="dash-stat-cards">{cards.map((card) => {
    const Icon = card.icon;
    return <div key={card.label} className={`dash-stat-card tone-${card.tone}`}>
      <div className="dash-stat-card-head"><Icon size={16} /><span>{card.label}</span></div>
      <strong>{card.value}</strong>
      <small>{card.label === '审查通过率' ? (stats.reviewApprovalRate === null ? '暂无审查数据' : '基于真实 review.completed 事件') : card.label === '已完成' ? `平均时长 ${averageDuration}` : trend(stats.createdLast24h, stats.createdPrev24h)}</small>
    </div>;
  })}</div>;
}
