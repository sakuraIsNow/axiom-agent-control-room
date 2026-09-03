import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Bell,
  CalendarClock,
  CheckCheck,
  CircleCheck,
  FileWarning,
  LoaderCircle,
  RotateCcw,
  ShieldCheck,
  Wrench,
  X,
} from 'lucide-react';
import type { InAppNotification } from '../../types';
import type { DashboardNavItem } from '../../lib/useDashboardStore';
import {
  cleanupArtifacts,
  getInAppNotifications,
  markInAppNotificationsRead,
  retryWorkflowTask,
} from '../../lib/taskRuntime';
import { resumeSchedule } from '../../lib/scheduleRuntime';
import { userFacingError } from '../../lib/errorPresentation';

const kindIcon = (kind: InAppNotification['kind']) => {
  if (kind === 'approval_required') return <ShieldCheck size={16} />;
  if (kind === 'task_completed') return <CircleCheck size={16} />;
  if (kind === 'schedule_dead_letter') return <CalendarClock size={16} />;
  if (kind === 'artifact_cleanup_failed') return <FileWarning size={16} />;
  if (kind === 'partial_delivery') return <AlertTriangle size={16} />;
  return <Wrench size={16} />;
};

const relativeTime = (timestamp: string) => {
  const elapsed = Date.parse(timestamp) - Date.now();
  if (!Number.isFinite(elapsed)) return '';
  const formatter = new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' });
  const minutes = Math.round(elapsed / 60_000);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, 'minute');
  const hours = Math.round(elapsed / 3_600_000);
  if (Math.abs(hours) < 24) return formatter.format(hours, 'hour');
  return formatter.format(Math.round(elapsed / 86_400_000), 'day');
};

export function NotificationCenter({
  refreshKey,
  onNavigate,
  onOpenTask,
  onRefreshTasks,
}: {
  refreshKey: string;
  onNavigate: (view: DashboardNavItem) => void;
  onOpenTask: (taskId: string) => void;
  onRefreshTasks: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [notifications, setNotifications] = useState<InAppNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const feed = await getInAppNotifications(50, signal);
      setNotifications(feed.notifications);
      setUnreadCount(feed.unreadCount);
      setError(null);
    } catch (caught) {
      if (signal?.aborted) return;
      setError(userFacingError(caught, '通知暂时不可用。'));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, 15_000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [refresh, refreshKey]);

  useEffect(() => {
    if (!open) return;
    const closeOnPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', closeOnPointer);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnPointer);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [open]);

  const markRead = async (ids: string[]) => {
    const unreadIds = ids.filter((id) => notifications.some((item) => item.id === id && !item.read));
    if (unreadIds.length === 0) return;
    setNotifications((current) => current.map((item) => unreadIds.includes(item.id) ? { ...item, read: true } : item));
    setUnreadCount((current) => Math.max(0, current - unreadIds.length));
    try {
      const receipt = await markInAppNotificationsRead({ ids: unreadIds });
      setUnreadCount(receipt.unreadCount);
    } catch (caught) {
      setError(userFacingError(caught, '通知状态没有保存。'));
      await refresh();
    }
  };

  const markAllRead = async () => {
    if (unreadCount === 0 || busy) return;
    setBusy('all');
    setNotifications((current) => current.map((item) => ({ ...item, read: true })));
    setUnreadCount(0);
    try {
      await markInAppNotificationsRead({ all: true });
    } catch (caught) {
      setError(userFacingError(caught, '通知状态没有保存。'));
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  const navigateTo = (item: InAppNotification) => {
    if (item.target.taskId) {
      onNavigate('tasks');
      onOpenTask(item.target.taskId);
    } else {
      onNavigate(item.target.view);
    }
    setOpen(false);
  };

  const openNotification = async (item: InAppNotification) => {
    await markRead([item.id]);
    navigateTo(item);
  };

  const runAction = async (item: InAppNotification) => {
    if (busy) return;
    if (item.action.kind === 'open') {
      await openNotification(item);
      return;
    }
    setBusy(item.id);
    setError(null);
    try {
      if (item.action.kind === 'retry-task' && item.action.resourceId) {
        const retried = await retryWorkflowTask(item.action.resourceId);
        await onRefreshTasks();
        onNavigate('tasks');
        onOpenTask(retried.id);
      } else if (item.action.kind === 'resume-schedule' && item.action.resourceId) {
        await resumeSchedule(item.action.resourceId);
        onNavigate('schedules');
      } else if (item.action.kind === 'retry-artifact-cleanup') {
        await cleanupArtifacts(100);
        onNavigate('operations');
      }
      await markRead([item.id]);
      await refresh();
      setOpen(false);
    } catch (caught) {
      setError(userFacingError(caught, '操作没有完成，请查看详情后重试。'));
    } finally {
      setBusy(null);
    }
  };

  return <div className="dash-notification-center" ref={rootRef}>
    <button
      type="button"
      className={`dash-notification-trigger ${unreadCount > 0 ? 'has-unread' : ''}`}
      title="通知"
      aria-label={`通知${unreadCount > 0 ? `，${unreadCount} 条未读` : ''}`}
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={() => {
        setOpen((value) => !value);
        if (!open) void refresh();
      }}
    >
      <Bell size={15} />
      {unreadCount > 0 && <span>{unreadCount > 99 ? '99+' : unreadCount}</span>}
    </button>
    {open && <section className="dash-notification-popover" role="dialog" aria-label="站内通知">
      <header>
        <div><strong>通知</strong>{unreadCount > 0 && <span>{unreadCount} 条未读</span>}</div>
        <div>
          <button type="button" disabled={unreadCount === 0 || busy !== null} onClick={() => void markAllRead()} title="全部已读"><CheckCheck size={15} /></button>
          <button type="button" onClick={() => setOpen(false)} title="关闭"><X size={15} /></button>
        </div>
      </header>
      {error && <div className="dash-notification-error">{error}</div>}
      <div className="dash-notification-list" aria-live="polite">
        {loading && notifications.length === 0 && <div className="dash-notification-empty"><LoaderCircle className="dash-notification-spinner" size={18} />正在同步</div>}
        {!loading && notifications.length === 0 && <div className="dash-notification-empty"><CheckCheck size={18} />当前没有待办通知</div>}
        {notifications.map((item) => <article key={item.id} className={`dash-notification-item ${item.read ? 'read' : 'unread'} severity-${item.severity}`}>
          <button type="button" className="dash-notification-main" onClick={() => void openNotification(item)}>
            <span className="dash-notification-kind">{kindIcon(item.kind)}</span>
            <span className="dash-notification-copy">
              <span><strong>{item.title}</strong><time>{relativeTime(item.createdAt)}</time></span>
              <small>{item.message}</small>
            </span>
            {!item.read && <i aria-label="未读" />}
          </button>
          <button type="button" className="dash-notification-action" disabled={busy !== null} onClick={() => void runAction(item)}>
            {busy === item.id ? <LoaderCircle className="dash-notification-spinner" size={13} /> : item.action.kind !== 'open' ? <RotateCcw size={13} /> : null}
            {item.action.label}
          </button>
        </article>)}
      </div>
    </section>}
  </div>;
}
