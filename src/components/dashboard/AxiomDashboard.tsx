import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Pause, Play, Settings2, Sparkles, Wrench } from 'lucide-react';
import { MorphIcon } from 'morphicons/react';
import { getCurrentPrincipal, getTaskStats, getTaskStatsDaily } from '../../lib/taskRuntime';
import type { TaskStats, TaskStatsDaily } from '../../types';
import { useDashboardStore } from '../../lib/useDashboardStore';
import { DashboardNavRail } from './DashboardNavRail';
import { StatCards } from './StatCards';
import { TokenTrendSparkline } from './TokenTrendSparkline';
import { TaskBoard } from './TaskBoard';
import { TaskOrbitCarousel } from './TaskOrbitCarousel';
import { TaskTimeline } from './TaskTimeline';
import { TaskDetailPanel } from './TaskDetailPanel';
import { AgentStudio } from './AgentStudio';
import { ScheduleBoard } from './ScheduleBoard';
import { DashboardChat } from './DashboardChat';
import { WorkflowStudio } from './WorkflowStudio';
import { OperationsConsole } from './OperationsConsole';
import { ProjectWorkspace } from './ProjectWorkspace';
import { ImprovementWorkspace } from './ImprovementWorkspace';
import { DeleteConfirmDialog } from './DeleteConfirmDialog';
import { ReviewConfirmDialog } from './ReviewConfirmDialog';
import { NotificationCenter } from './NotificationCenter';
import { FirstRunGuide } from './FirstRunGuide';
import { groupTaskRuns } from '../../lib/taskGrouping';
import type { DashboardProps } from './dashboardTypes';
import { ThemePicker } from '../ThemePicker';
import { LanguagePicker } from '../LanguagePicker';
import { readDashboardUrlState, subscribeDashboardUrlState, writeDashboardUrlState } from '../../lib/dashboardUrlState';
import '../../styles/dashboard.css';

const commandSendIcon = 'M5 12h14M13 6l6 6-6 6';
const commandStopIcon = 'M7 7h10v10H7Z';
const ONBOARDING_KEY = 'axiom-onboarding-seen-v2';

const modeLabel: Record<DashboardProps['mode'], string> = { analyze: '分析', build: '构建', decide: '决策' };

export function AxiomDashboard(props: DashboardProps) {
  const {
    phase, mode, onModeChange, draft, onDraftChange, onSend, onNewTask, onOpenSettings, onRefreshTemplates,
    templateWorkspace, onOpenPlugins, pluginWorkspace, onOpenReadiness, onStop, onPause, onResume, isRunning, canGuide, guidanceBusy, guidanceState, onGuidance, routeInsight, agentActivity, agents, graph, runEvents,
    selectedNodeId, onSelectAgent, taskProfile, reviewResult, reviewApprovalTaskId, reviewNote, reviewActionBusy,
    onReviewNoteChange, onApproveReview, onRejectReview, taskCatalog, onOpenTask, onDeleteTask, onRefreshTasks, sessionId,
    sessions, activeSession, onSelectSession, onDeleteSession, error, readiness, provider, textModelCredentialId, theme, onThemeChange, principalUserId: principalUserIdProp,
    attachments, onAddAttachments, onRemoveAttachment, onboardingReady, onTaskActionChanged, providerConfig, conversationHumanAction,
  } = props;
  const nav = useDashboardStore((state) => state.nav);
  const selectedTaskId = useDashboardStore((state) => state.selectedTaskId);
  const setNav = useDashboardStore((state) => state.setNav);
  const setTasks = useDashboardStore((state) => state.setTasks);
  const [stats, setStats] = useState<TaskStats | null>(null);
  const [dailyStats, setDailyStats] = useState<TaskStatsDaily[]>([]);
  const [principalUserId, setPrincipalUserId] = useState(principalUserIdProp ?? '');
  const [pendingDelete, setPendingDelete] = useState<{ kind: 'task' | 'session'; id: string; taskIds?: string[] } | null>(null);
  const [pendingReviewAction, setPendingReviewAction] = useState<'approve' | 'reject' | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [onboardingSeen, setOnboardingSeen] = useState(() => localStorage.getItem(ONBOARDING_KEY) === '1');
  const layoutRef = useRef<HTMLDivElement | null>(null);
  const workflowMainRef = useRef<HTMLElement | null>(null);
  const urlTaskOpenedRef = useRef(false);

  // Route changes reuse the same section element. Reset both scroll containers
  // so a long task page cannot reopen another workspace halfway down.
  useLayoutEffect(() => {
    layoutRef.current?.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    workflowMainRef.current?.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  }, [nav]);

  useEffect(() => {
    setTasks(taskCatalog);
  }, [setTasks, taskCatalog]);

  useEffect(() => {
    if (!taskCatalog.length) return;
    if (selectedTaskId && taskCatalog.some((task) => task.id === selectedTaskId)) return;
    const fallback = taskCatalog[0]?.id;
    if (!fallback) return;
    useDashboardStore.getState().selectTask(fallback);
    if (nav === 'tasks') onOpenTask(fallback);
  }, [nav, onOpenTask, selectedTaskId, taskCatalog]);

  useEffect(() => {
    writeDashboardUrlState({ view: nav });
  }, [nav]);

  useEffect(() => {
    writeDashboardUrlState({ taskId: selectedTaskId ?? undefined });
  }, [selectedTaskId]);

  useEffect(() => subscribeDashboardUrlState((state) => {
    if (state.view) setNav(state.view);
    if (state.taskId && state.view === 'tasks') {
      const target = taskCatalog.find((task) => task.id === state.taskId)?.id ?? taskCatalog[0]?.id;
      if (target) {
        useDashboardStore.getState().selectTask(target);
        onOpenTask(target);
      }
    }
  }), [onOpenTask, setNav, taskCatalog]);

  useEffect(() => {
    const state = readDashboardUrlState();
    if (nav !== 'tasks' || urlTaskOpenedRef.current || !state.taskId || !taskCatalog.some((task) => task.id === state.taskId)) return;
    urlTaskOpenedRef.current = true;
    onOpenTask(state.taskId);
  }, [nav, onOpenTask, taskCatalog]);

  useEffect(() => {
    const controller = new AbortController();
    const load = () => { getTaskStats(controller.signal).then(setStats).catch(() => undefined); getTaskStatsDaily(7, controller.signal).then(setDailyStats).catch(() => undefined); };
    load();
    const timer = window.setInterval(load, 20_000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [taskCatalog.length]);

  useEffect(() => {
    if (principalUserIdProp) return;
    const controller = new AbortController();
    getCurrentPrincipal(controller.signal).then((principal) => setPrincipalUserId(principal.userId)).catch(() => undefined);
    return () => controller.abort();
  }, [principalUserIdProp]);

  useEffect(() => {
    if (nav === 'plugins') onOpenPlugins();
  }, [nav, onOpenPlugins]);

  useEffect(() => {
    if (nav === 'templates') onRefreshTemplates();
  }, [nav, onRefreshTemplates]);

  useEffect(() => {
    setPendingReviewAction(null);
  }, [reviewApprovalTaskId]);

  const focusedTaskId = selectedTaskId ?? taskCatalog[0]?.id ?? null;
  const focusedTask = taskCatalog.find((task) => task.id === focusedTaskId) ?? null;
  const currentHumanAction = conversationHumanAction?.sessionId === activeSession.id ? conversationHumanAction : null;
  const conversationTaskId = currentHumanAction?.taskId ?? activeSession.activeTaskId
    ?? taskCatalog.filter((task) => task.sessionId === activeSession.id && ['paused', 'awaiting_approval', 'waiting_for_human'].includes(task.status)).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]?.id
    ?? [...activeSession.messages].reverse().find((message) => Boolean(message.taskId))?.taskId;
  const conversationTask = taskCatalog.find((task) => task.id === conversationTaskId);
  const focusedTaskRunIds = focusedTask
    ? (groupTaskRuns(taskCatalog).find((group) => group.taskIds.includes(focusedTask.id))?.taskIds ?? [focusedTask.id]).filter((id) => {
      const run = taskCatalog.find((candidate) => candidate.id === id);
      return run ? ['completed', 'failed', 'cancelled'].includes(run.status) : false;
    })
    : [];
  const sessionTopic = focusedTask ? taskCatalog.filter((task) => task.sessionId === focusedTask.sessionId).sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())[0]?.title ?? focusedTask.title : null;
  const notificationRefreshKey = taskCatalog.length > 0
    ? `${taskCatalog.length}:${taskCatalog[0]?.id}:${taskCatalog[0]?.status}:${taskCatalog[0]?.updatedAt}`
    : 'empty';
  const dismissOnboarding = () => {
    localStorage.setItem(ONBOARDING_KEY, '1');
    setOnboardingSeen(true);
  };
  const openNewConversation = () => {
    dismissOnboarding();
    onNewTask();
    setNav('chat');
  };
  const navigateFromDashboard = (destination: Parameters<typeof setNav>[0]) => {
    dismissOnboarding();
    setNav(destination);
  };
  const selectOnboardingWorkspace = (destination: 'chat' | 'plugins' | 'workflows') => {
    dismissOnboarding();
    if (destination === 'chat') openNewConversation();
    else setNav(destination);
  };
  const sendFromDashboard = () => {
    if (!draft.trim()) return;
    if (isRunning) {
      if (canGuide && !guidanceBusy) onGuidance();
      return;
    }
    setNav('chat');
    onSend();
  };
  const removeTask = async (taskId: string, taskIds?: string[]) => {
    if (await onDeleteTask(taskId, taskIds)) useDashboardStore.getState().selectTask(null);
  };
  const confirmDelete = async () => {
    if (!pendingDelete || deleteBusy) return;
    setDeleteBusy(true);
    try {
      if (pendingDelete.kind === 'task') await removeTask(pendingDelete.id, pendingDelete.taskIds);
      else await onDeleteSession(pendingDelete.id);
      setPendingDelete(null);
    } finally {
      setDeleteBusy(false);
    }
  };
  const confirmReview = async () => {
    if (!pendingReviewAction || reviewActionBusy) return;
    const succeeded = pendingReviewAction === 'approve'
      ? await onApproveReview()
      : await onRejectReview();
    if (succeeded) setPendingReviewAction(null);
  };
  const hasUserHistory = taskCatalog.length > 0 || sessions.some((session) => session.messages.length > 0 || Boolean(session.activeTaskId));
  const showOnboarding = onboardingReady && nav === 'tasks' && !onboardingSeen && !hasUserHistory;

  return <main className="axiom-dashboard" data-theme={theme} data-readiness={readiness}>
    <header className="dash-header">
      <button type="button" className="dash-brand" onClick={openNewConversation}><span className="dash-brand-mark"><Sparkles size={15} /></span><span><strong>AXIOM</strong><small>任务台</small></span></button>
      <div className="dash-header-state"><i className={`shell-state-dot ${phase}`} /><span><small>当前模型</small><strong>{provider}</strong></span></div>
      <div className="dash-header-actions">
        <NotificationCenter
          refreshKey={notificationRefreshKey}
          onNavigate={setNav}
          onOpenTask={(taskId) => {
            useDashboardStore.getState().selectTask(taskId);
            onOpenTask(taskId);
          }}
          onRefreshTasks={onRefreshTasks}
        />
        <button type="button" onClick={onOpenReadiness} title="生产就绪"><Wrench size={15} /></button>
        <button type="button" onClick={onOpenSettings} title="运行设置"><Settings2 size={15} /></button>
        <ThemePicker value={theme} onChange={onThemeChange} />
        <LanguagePicker />
      </div>
    </header>
    <div ref={layoutRef} className={`dash-layout ${nav === 'chat' ? 'chat-active' : nav === 'projects' ? 'projects-active' : nav === 'plugins' ? 'plugins-active' : nav === 'templates' ? 'templates-active' : nav === 'workflows' ? 'workflows-active' : nav === 'operations' ? 'operations-active' : nav === 'improvements' ? 'improvements-active' : ''}`}>
      <DashboardNavRail nav={nav} onNav={navigateFromDashboard} onNewTask={openNewConversation} />
      {nav === 'templates' ? <section className="dash-main dash-main-templates">{templateWorkspace}</section>
        : nav === 'plugins' ? <section className="dash-main dash-main-plugins">{pluginWorkspace}</section>
        : nav === 'projects' ? <section className="dash-main dash-main-projects"><ProjectWorkspace onUseSolution={(input, solutionMode) => { onDraftChange(input); onModeChange(solutionMode); setNav('chat'); }} /></section>
        : nav === 'workflows' ? <section ref={workflowMainRef} className="dash-main dash-main-workflows"><WorkflowStudio providerConfig={providerConfig} /></section>
        : nav === 'agent-studio' ? <section className="dash-main"><AgentStudio /></section>
        : nav === 'schedules' ? <section className="dash-main"><ScheduleBoard sessionId={sessionId} modelCredentialId={textModelCredentialId} providerConfig={providerConfig} /></section>
        : nav === 'operations' ? <section className="dash-main dash-main-operations"><OperationsConsole /></section>
        : nav === 'improvements' ? <section className="dash-main dash-main-improvements"><ImprovementWorkspace hasExistingDraft={Boolean(draft.trim() || attachments.length)} onPrepareConversation={(trial) => {
          // Detach from the existing session without changing its messages. The
          // preview guards replacement of an unsent draft; never auto-send.
          onNewTask();
          onModeChange(trial.mode);
          onDraftChange(trial.input);
          setNav('chat');
        }} /></section>
        : nav === 'chat' ? <section className="dash-main dash-main-chat"><DashboardChat key={activeSession.id}
          sessions={sessions}
          activeSession={activeSession}
          provider={provider}
          phase={phase}
          mode={mode}
          draft={draft}
          isRunning={isRunning}
          agentActivity={agentActivity}
          error={error}
          onDraftChange={onDraftChange}
          onModeChange={onModeChange}
          onSend={onSend}
          onStop={onStop}
          onPause={onPause}
          onResume={onResume}
          canGuide={canGuide}
          guidanceBusy={guidanceBusy}
          guidanceState={guidanceState}
          onGuidance={onGuidance}
          routeInsight={routeInsight}
          onNewTask={openNewConversation}
          onSelectSession={onSelectSession}
          onDeleteSession={(id) => setPendingDelete({ kind: 'session', id })}
          attachments={attachments}
          onAddAttachments={onAddAttachments}
          onRemoveAttachment={onRemoveAttachment}
          agents={agents}
          graph={graph}
          events={runEvents}
          selectedNodeId={selectedNodeId}
          onSelectAgent={onSelectAgent}
          reviewResult={reviewApprovalTaskId ? reviewResult : null}
          reviewNote={reviewNote}
          reviewBusy={reviewActionBusy}
          onReviewNoteChange={onReviewNoteChange}
          onRequestApprove={() => setPendingReviewAction('approve')}
          onRequestReject={() => setPendingReviewAction('reject')}
          actionTaskId={conversationTaskId}
          actionTaskStatus={currentHumanAction?.status ?? conversationTask?.status}
          actionRefreshKey={`${currentHumanAction?.refreshKey ?? ''}:${conversationTask?.revision ?? `${phase}:${reviewApprovalTaskId ?? ''}`}`}
          onTaskActionChanged={onTaskActionChanged ?? (async () => { await onRefreshTasks(); })}
        /></section>
        : <>
        <section className="dash-main">
          <StatCards stats={stats} tasks={taskCatalog} />
          <TokenTrendSparkline points={dailyStats} />
          <div className="dash-command">
            <div className="dash-command-copy">
              <textarea value={draft} rows={1} disabled={(isRunning && !canGuide) || guidanceBusy} onChange={(event) => onDraftChange(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendFromDashboard(); } }} placeholder={isRunning ? (canGuide ? '补充要求，将在下一步骤应用' : '当前快速回答完成后可继续提问') : '输入目标，提交给运行时'} />
              {isRunning && guidanceState && <span className={`dash-guidance-feedback ${guidanceState.status}`}><i />{guidanceState.status === 'accepted' ? '已接收，等待下一步骤' : guidanceState.delivery === 'external-harness' ? '已送达当前执行器' : '已应用到当前任务'}</span>}
            </div>
            <div className="dash-command-mode">{(['analyze', 'build', 'decide'] as const).map((item) => <button type="button" key={item} className={item === mode ? 'active' : ''} disabled={isRunning} onClick={() => onModeChange(item)}>{modeLabel[item]}</button>)}</div>
            <button type="button" className="dash-send" title={isRunning ? '加入当前任务' : '发送'} aria-label={isRunning ? '加入当前任务' : '发送'} onClick={sendFromDashboard} disabled={!draft.trim() || (isRunning && (!canGuide || guidanceBusy))}><MorphIcon icon={commandSendIcon} size={16} strokeWidth={2} spring="snappy" reducedMotion="user" /></button>
            {isRunning ? <div className="dash-command-controls"><button type="button" onClick={onPause}><Pause size={13} />暂停</button><button type="button" className="stop" onClick={onStop}><MorphIcon icon={commandStopIcon} size={13} strokeWidth={2} spring="snappy" reducedMotion="user" />停止</button></div> : <button type="button" onClick={onResume} disabled><Play size={13} />继续</button>}
          </div>
          <div className="dash-board-row">
            <TaskBoard tasks={taskCatalog} graph={graph} selectedTaskId={focusedTaskId} currentUserId={principalUserId} onSelectTask={(id) => { useDashboardStore.getState().selectTask(id); onOpenTask(id); }} onDeleteTask={(id, taskIds) => setPendingDelete({ kind: 'task', id, taskIds })} />
            <TaskOrbitCarousel tasks={taskCatalog} theme={theme} selectedTaskId={focusedTaskId} onOpenTask={(id) => { useDashboardStore.getState().selectTask(id); onOpenTask(id); }} />
          </div>
          <TaskTimeline tasks={taskCatalog} />
        </section>
        <TaskDetailPanel
          task={focusedTask}
          sessionTopic={sessionTopic}
          taskProfile={taskProfile ?? focusedTask?.profile ?? null}
          reviewResult={reviewResult}
          reviewApprovalTaskId={reviewApprovalTaskId}
          reviewNote={reviewNote}
          reviewBusy={reviewActionBusy}
          onReviewNoteChange={onReviewNoteChange}
          onRequestApprove={() => setPendingReviewAction('approve')}
          onRequestReject={() => setPendingReviewAction('reject')}
          onResubmit={(input) => { onDraftChange(input); setNav('tasks'); }}
          onDeleteTask={(id) => setPendingDelete({ kind: 'task', id, taskIds: focusedTaskRunIds.length > 0 ? focusedTaskRunIds : [id] })}
          onCheckpointTaskCreated={async (id) => {
            await onRefreshTasks();
            useDashboardStore.getState().selectTask(id);
            onOpenTask(id);
          }}
          onRecoveryChanged={async (id, afterSequence) => {
            if (onTaskActionChanged) { await onTaskActionChanged(id, afterSequence); return; }
            const selectedBeforeRefresh = useDashboardStore.getState().selectedTaskId;
            await onRefreshTasks();
            if (useDashboardStore.getState().selectedTaskId !== selectedBeforeRefresh || focusedTaskId !== id) return;
            useDashboardStore.getState().selectTask(id);
            onOpenTask(id);
          }}
        />
      </>}
    </div>
    {showOnboarding && <FirstRunGuide
      onStartConversation={() => selectOnboardingWorkspace('chat')}
      onOpenWorkspace={selectOnboardingWorkspace}
      onDismiss={dismissOnboarding}
    />}
    {pendingDelete && <DeleteConfirmDialog busy={deleteBusy} onCancel={() => setPendingDelete(null)} onConfirm={() => { void confirmDelete(); }} />}
    {pendingReviewAction && <ReviewConfirmDialog action={pendingReviewAction} note={reviewNote} busy={reviewActionBusy} onCancel={() => setPendingReviewAction(null)} onConfirm={() => { void confirmReview(); }} />}
  </main>;
}
