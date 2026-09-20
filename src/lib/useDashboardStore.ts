import { create } from 'zustand';
import type { TaskStats, WorkflowTaskSummary } from '../types';
import { readDashboardUrlState } from './dashboardUrlState';

export type DashboardNavItem = 'tasks' | 'chat' | 'projects' | 'plugins' | 'templates' | 'workflows' | 'schedules' | 'agent-studio' | 'operations' | 'improvements';

type DashboardState = {
  nav: DashboardNavItem;
  selectedTaskId: string | null;
  stats: TaskStats | null;
  tasks: WorkflowTaskSummary[];
  setNav: (nav: DashboardNavItem) => void;
  selectTask: (id: string | null) => void;
  setStats: (stats: TaskStats | null) => void;
  setTasks: (tasks: WorkflowTaskSummary[]) => void;
};

export const useDashboardStore = create<DashboardState>((set) => ({
  nav: readDashboardUrlState().view ?? 'tasks',
  selectedTaskId: readDashboardUrlState().taskId ?? null,
  stats: null,
  tasks: [],
  setNav: (nav) => set({ nav }),
  selectTask: (selectedTaskId) => set({ selectedTaskId }),
  setStats: (stats) => set({ stats }),
  setTasks: (tasks) => set({ tasks }),
}));
