export type DashboardUrlView = 'tasks' | 'chat' | 'projects' | 'plugins' | 'templates' | 'workflows' | 'schedules' | 'agent-studio' | 'operations';

export type DashboardUrlState = {
  view?: DashboardUrlView;
  taskId?: string;
  sessionId?: string;
};

const views = new Set<DashboardUrlView>(['tasks', 'chat', 'projects', 'plugins', 'templates', 'workflows', 'schedules', 'agent-studio', 'operations']);

export const parseDashboardSearch = (search: string): DashboardUrlState => {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const view = params.get('view');
  const taskId = params.get('task');
  const sessionId = params.get('session');
  return {
    ...(view && views.has(view as DashboardUrlView) ? { view: view as DashboardUrlView } : {}),
    ...(taskId?.trim() ? { taskId: taskId.trim().slice(0, 160) } : {}),
    ...(sessionId?.trim() ? { sessionId: sessionId.trim().slice(0, 160) } : {}),
  };
};

export const serializeDashboardSearch = (state: DashboardUrlState, currentSearch = '') => {
  const params = new URLSearchParams(currentSearch.startsWith('?') ? currentSearch.slice(1) : currentSearch);
  if ('view' in state) {
    if (state.view && views.has(state.view)) params.set('view', state.view);
    else params.delete('view');
  }
  if ('taskId' in state) {
    if (state.taskId?.trim()) params.set('task', state.taskId.trim().slice(0, 160));
    else params.delete('task');
  }
  if ('sessionId' in state) {
    if (state.sessionId?.trim()) params.set('session', state.sessionId.trim().slice(0, 160));
    else params.delete('session');
  }
  const encoded = params.toString();
  return encoded ? `?${encoded}` : '';
};

export const readDashboardUrlState = (): DashboardUrlState => {
  if (typeof window === 'undefined') return {};
  return parseDashboardSearch(window.location.search);
};

export const writeDashboardUrlState = (patch: DashboardUrlState) => {
  if (typeof window === 'undefined') return;
  const search = serializeDashboardSearch(patch, window.location.search);
  const next = `${window.location.pathname}${search}${window.location.hash}`;
  if (next === `${window.location.pathname}${window.location.search}${window.location.hash}`) return;
  window.history.replaceState(window.history.state, '', next);
};

export const subscribeDashboardUrlState = (listener: (state: DashboardUrlState) => void) => {
  if (typeof window === 'undefined') return () => undefined;
  const handle = () => listener(readDashboardUrlState());
  window.addEventListener('popstate', handle);
  return () => window.removeEventListener('popstate', handle);
};
