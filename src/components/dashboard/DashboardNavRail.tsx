import { Activity, CalendarClock, FlaskConical, FolderKanban, LayoutGrid, MessageSquareText, Telescope, Bot, Plus, Puzzle, Workflow } from 'lucide-react';
import type { DashboardNavItem } from '../../lib/useDashboardStore';

const items: Array<{ id: DashboardNavItem; label: string; icon: typeof LayoutGrid }> = [
  { id: 'tasks', label: '任务管理', icon: LayoutGrid },
  { id: 'chat', label: '对话', icon: MessageSquareText },
  { id: 'projects', label: '项目空间', icon: FolderKanban },
  { id: 'templates', label: '模板库', icon: Telescope },
  { id: 'workflows', label: 'Agent Nexus', icon: Workflow },
  { id: 'schedules', label: '日程', icon: CalendarClock },
  { id: 'agent-studio', label: '智能体工作室', icon: Bot },
  { id: 'operations', label: '运行观测', icon: Activity },
  { id: 'improvements', label: '任务改进', icon: FlaskConical },
];

export function DashboardNavRail({ nav, onNav, onNewTask }: { nav: DashboardNavItem; onNav: (item: DashboardNavItem) => void; onNewTask: () => void }) {
  return <nav className="dash-nav-rail">
    <button type="button" className="dash-nav-new" aria-label="新建任务" onClick={onNewTask}><Plus size={17} /><span>新建任务</span></button>
    <button type="button" aria-label="插件" className={nav === 'plugins' ? 'active' : ''} onClick={() => onNav('plugins')}><Puzzle size={17} /><span>插件</span></button>
    <div className="dash-nav-divider" aria-hidden="true" />
    {items.map((item) => {
    const Icon = item.icon;
    return <button key={item.id} type="button" aria-label={item.label} className={nav === item.id ? 'active' : ''} onClick={() => onNav(item.id)}>
      <Icon size={17} /><span>{item.label}</span>
    </button>;
  })}</nav>;
}
