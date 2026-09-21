import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Check, ChevronDown, ListChecks, LoaderCircle, Play, RefreshCw, RotateCcw, ShieldCheck, UserCheck, X } from 'lucide-react';
import { createPortal } from 'react-dom';
import { getToolRecovery } from '../../lib/toolRecoveryRuntime';
import { deliveryReviewSummary, getTaskHumanSnapshot, submitTaskHumanAction, TaskActionError, taskNeedsHumanAction, type TaskHumanAction } from '../../lib/taskActionRuntime';
import { useUiLanguage } from '../../lib/uiLanguage';
import type { WorkflowTask } from '../../types';
import { ToolRecoveryPanel } from './ToolRecoveryPanel';
import { ReviewConfirmDialog } from './ReviewConfirmDialog';
import './task-actions.css';

type Confirmation = { action: TaskHumanAction; approvalId?: string; revision: number };

function ActionModal({ children, onDismiss, busy }: { children: ReactNode; onDismiss: () => void; busy: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const latest = useRef({ onDismiss, busy }); latest.current = { onDismiss, busy };
  const style = useMemo(() => {
    const source = document.querySelector('.axiom-dashboard');
    if (!source) return {};
    const computed = getComputedStyle(source);
    return Object.fromEntries(['--dash-ink', '--dash-soft', '--dash-muted', '--dash-line', '--dash-line-strong', '--dash-accent', '--dash-accent-rgb', '--dash-surface-rgb', '--dash-surface-strong-rgb'].map((name) => [name, computed.getPropertyValue(name)])) as CSSProperties;
  }, []);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !latest.current.busy) { event.preventDefault(); latest.current.onDismiss(); }
      if (event.key !== 'Tab') return;
      const controls = Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not([disabled]), textarea:not([disabled]), input:not([disabled]), [tabindex="0"]') ?? []);
      const first = controls[0]; const last = controls.at(-1);
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === first || !ref.current?.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !ref.current?.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', keydown, true);
    return () => { document.removeEventListener('keydown', keydown, true); if (previous?.isConnected) previous.focus(); };
  }, []);
  return createPortal(<div ref={ref} className="task-action-modal-layer" style={style}>{children}</div>, document.body);
}
export function TaskActionPanel({ taskId, taskStatus, refreshKey, onChanged, context = 'task' }: {
  taskId: string;
  taskStatus?: string;
  refreshKey?: string | number;
  onChanged: (taskId: string, afterSequence?: number) => Promise<void>;
  context?: 'task' | 'chat' | 'nexus';
}) {
  const { language } = useUiLanguage();
  const zh = language === 'zh-CN';
  const scope = useMemo(() => ({ taskId }), [taskId]);
  const selected = useRef<typeof scope | null>(scope);
  selected.current = scope;
  const sequence = useRef(0);
  const lock = useRef<typeof scope | null>(null);
  const [loaded, setLoaded] = useState<{ scope: typeof scope; task: WorkflowTask; canManage: boolean; toolBlocked: boolean; toolResume: boolean } | null>(null);
  const [noteState, setNote] = useState<{ scope: typeof scope; value: string } | null>(null);
  const [confirmationState, setConfirmation] = useState<{ scope: typeof scope; value: Confirmation } | null>(null);
  const [busyScope, setBusy] = useState<typeof scope | null>(null);
  const [errorState, setError] = useState<{ scope: typeof scope; status: number } | null>(null);
  const [refresh, setRefresh] = useState(0);
  const task = loaded?.scope === scope ? loaded.task : null;
  const note = noteState?.scope === scope ? noteState.value : '';
  const confirmation = confirmationState?.scope === scope ? confirmationState.value : null;
  const busy = busyScope === scope || loaded?.scope === scope && !loaded.canManage;
  const error = errorState?.scope === scope ? errorState.status : null;
  const load = useCallback(async (target: typeof scope, signal?: AbortSignal) => {
    const request = ++sequence.current;
    const [snapshot, recovery] = await Promise.all([getTaskHumanSnapshot(target.taskId, signal), getToolRecovery(target.taskId, signal)]);
    const next = snapshot.task;
    if (selected.current === target && request === sequence.current && !signal?.aborted) {
      setLoaded({ scope: target, task: next, canManage: snapshot.canManage, toolBlocked: recovery.executions.some((item) => item.status === 'outcome_unknown' || item.status === 'executing'), toolResume: recovery.canResume });
      setConfirmation((current) => current?.scope === target && current.value.revision !== next.revision ? null : current);
    }
  }, []);
  useEffect(() => () => { if (selected.current === scope) selected.current = null; }, [scope]);
  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    void load(scope, controller.signal).catch((caught) => { if (!controller.signal.aborted && selected.current === scope) setError({ scope, status: caught instanceof TaskActionError ? caught.status : 0 }); });
    return () => controller.abort();
  }, [scope, taskStatus, refreshKey, refresh, load]);
  useEffect(() => {
    if (!task || !['paused', 'waiting_for_human', 'awaiting_approval'].includes(task.status)) return;
    const controller = new AbortController();
    const timer = window.setInterval(() => { if (!lock.current) void load(scope, controller.signal).catch(() => undefined); }, 15_000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [scope, task?.status, load]);
  const changed = async (id: string, afterSequence?: number) => {
    await load(scope);
    if (selected.current === scope) await onChanged(id, afterSequence);
  };
  const run = async (decision: Confirmation) => {
    if (!task || !loaded?.canManage || lock.current === scope || task.revision !== decision.revision) return;
    lock.current = scope;
    setBusy(scope); setError(null);
    try {
      const applied = await submitTaskHumanAction(task, decision.action, note, decision.approvalId);
      if (selected.current !== scope) return;
      setConfirmation(null); setNote(null);
      await changed(taskId, applied.afterSequence);
    } catch (caught) {
      if (selected.current !== scope) return;
      const status = caught instanceof TaskActionError ? caught.status : 0;
      setConfirmation(null);
      await load(scope).catch(() => undefined);
      if (selected.current === scope) setError({ scope, status });
    } finally {
      if (lock.current === scope) lock.current = null;
      if (selected.current === scope) setBusy(null);
    }
  };
  const requestAction = (action: TaskHumanAction, approvalId?: string) => {
    if (!task || busy) return;
    const value = { action, approvalId, revision: task.revision };
    // These buttons already express a scoped decision about the visible request.
    // Keep the revision, permission and in-flight checks in run; avoid asking the
    // operator to confirm an explicit Allow Once/Deny a second time.
    const criticalTool = action === 'approve-tool' && task.toolApprovals?.some((approval) => approval.id === approvalId && approval.risk === 'critical');
    if (action === 'resume' || action === 'reject-tool' || action === 'approve-tool' && !criticalTool) void run(value);
    else setConfirmation({ scope, value });
  };
  const actions = task ? taskNeedsHumanAction(task) : null;
  const delivery = task ? deliveryReviewSummary(task) : null;
  const partialDelivery = Boolean(delivery && delivery.status !== 'passed');
  const deliveryStatus = delivery?.status === 'passed' ? (zh ? '要求已复核' : 'Requirements reviewed')
    : delivery?.status === 'needs-revision' ? (zh ? '待修正' : 'Revisions needed')
      : zh ? '待核对' : 'Needs checking';
  const canResume = actions?.paused && !actions.plan && !actions.planRejected && !actions.review && !actions.tools.length && !loaded?.toolBlocked && !loaded?.toolResume;
  const visible = actions && (actions.plan || actions.planRejected || actions.review || actions.tools.length > 0 || actions.paused);
  const errorText = error === 403 || error === 401 ? (zh ? '你没有处理这项任务的权限。' : 'You do not have permission to manage this task.')
    : error === 409 ? (zh ? '任务状态已更新，请核对后重新操作。' : 'The task changed. Review its current state before acting again.')
      : zh ? '任务操作暂时不可用，请刷新后重试。' : 'Task actions are unavailable. Refresh and try again.';
  return <div className="task-action-surface" data-task-id={taskId}>
    {(visible || error !== null) && <section className="task-action-panel dash-detail-section" data-i18n-ignore="true" aria-label={zh ? '需要你处理' : 'Your Actions'}>
      <header><span><UserCheck size={16} />{zh ? '需要你处理' : 'Your Actions'}</span><button type="button" className="task-action-refresh" title={zh ? '刷新任务状态' : 'Refresh task status'} aria-label={zh ? '刷新任务状态' : 'Refresh task status'} disabled={busy} onClick={() => setRefresh((value) => value + 1)}><RefreshCw size={15} /></button></header>
      {error !== null && <p role="alert">{errorText}</p>}
      {loaded?.scope === scope && !loaded.canManage && <p>{zh ? '你可以查看此任务，处理决定需要任务管理权限。' : 'You can view this task. Decisions require task management permission.'}</p>}
      {actions?.plan && <div className="task-action-entry" data-testid="task-plan-controls">
        <strong><ListChecks size={15} />{zh ? '确认执行计划' : 'Approve the Plan'}</strong>
        <p>{task?.plan?.summary}</p>
        <details><summary>{zh ? '查看执行步骤' : 'Review Steps'}<ChevronDown size={14} /></summary><ol>{task?.plan?.steps?.map((step) => <li key={step.id}><strong>{step.title}</strong><p>{step.objective}</p></li>)}</ol></details>
        <div className="task-action-buttons"><button type="button" disabled={busy} onClick={() => requestAction('reject-plan')}><X size={14} />{zh ? '不执行此计划' : 'Reject Plan'}</button><button type="button" disabled={busy || loaded?.toolBlocked} onClick={() => requestAction('approve-plan')}><Check size={14} />{zh ? '批准计划' : 'Approve Plan'}</button></div>
      </div>}
      {actions?.planRejected && <div className="task-action-entry"><strong><ListChecks size={15} />{zh ? '计划已拒绝' : 'Plan Rejected'}</strong><p>{zh ? '补充修改意见后重新规划。' : 'Add your changes below to request a revised plan.'}</p><div className="task-action-buttons"><button type="button" disabled={busy || !note.trim() || loaded?.toolBlocked} onClick={() => requestAction('replan')}><RotateCcw size={14} />{zh ? '修改执行计划' : 'Revise Plan'}</button></div></div>}
      {actions?.tools.map((approval) => <div className="task-action-entry" key={approval.id} data-testid="task-tool-controls">
        <strong><ShieldCheck size={15} /><span>{approval.name}</span></strong>
        <p>{zh ? '执行前需要你的许可' : 'Your permission is required before execution'}</p>
        <details><summary>{zh ? '查看调用内容' : 'Inspect Request'}<ChevronDown size={14} /></summary><pre>{JSON.stringify(approval.args, null, 2)}</pre></details>
        <div className="task-action-buttons"><button type="button" disabled={busy} onClick={() => requestAction('reject-tool', approval.id)}><X size={14} />{zh ? '拒绝调用' : 'Deny'}</button><button type="button" disabled={busy || loaded?.toolBlocked} onClick={() => requestAction('approve-tool', approval.id)}><Check size={14} />{zh ? '允许此次调用' : 'Allow Once'}</button></div>
      </div>)}
      {actions?.review && <div className="task-action-entry" data-testid={context === 'chat' ? 'chat-human-review-controls' : 'human-review-controls'}>
        <strong><ListChecks size={15} />{zh ? '人工审核' : 'Human Review'}{!delivery && <small>{task?.review?.score}/100</small>}</strong>
        <p>{task?.review?.summary}</p>
        <ul>{[...new Set([...(task?.review?.requiredCorrections ?? []), ...(task?.review?.gaps ?? [])])].map((issue) => <li key={issue}>{issue}</li>)}</ul>
        <textarea aria-label={zh ? '审核意见' : 'Decision Notes'} placeholder={zh ? '补充意见（可选）' : 'Decision notes (optional)'} value={note} rows={2} maxLength={2000} disabled={busy} onChange={(event) => setNote({ scope, value: event.target.value })} />
        <div className="task-action-buttons"><button type="button" disabled={busy} onClick={() => requestAction('reject-review')}><RotateCcw size={14} />{zh ? context === 'chat' ? '继续整改' : '驳回并整改' : 'Request Revisions'}</button><button type="button" disabled={busy || loaded?.toolBlocked} onClick={() => requestAction('approve-review')}><Check size={14} />{partialDelivery ? (zh ? '接受部分结果' : 'Accept Partial Result') : zh ? context === 'chat' ? '按当前结果交付' : '批准交付' : 'Accept Result'}</button></div>
      </div>}
      {visible && !actions?.review && <textarea aria-label={zh ? '审核意见' : 'Decision Notes'} placeholder={zh ? '补充意见（可选）' : 'Decision notes (optional)'} value={note} rows={2} maxLength={2000} disabled={busy} onChange={(event) => setNote({ scope, value: event.target.value })} />}
      {canResume && <button type="button" className="task-action-resume" disabled={busy} onClick={() => requestAction('resume')}>{busy ? <LoaderCircle size={15} /> : <Play size={15} />}{zh ? '继续任务' : 'Continue Task'}</button>}
      {loaded?.toolBlocked && visible && <p>{zh ? '请先核对下方尚未确定的执行结果。' : 'Review the unresolved execution outcome below first.'}</p>}
    </section>}
    {delivery && <details className="task-review-findings task-delivery-review" data-testid="task-delivery-review" data-outcome={delivery.status} data-i18n-ignore="true">
      <summary><span><ListChecks size={15} />{zh ? '交付检查' : 'Delivery Check'}</span><span>{delivery.satisfied}/{delivery.total}<span className="task-delivery-status">{deliveryStatus}</span><ChevronDown size={14} /></span></summary>
      <p className="task-delivery-boundary">{zh ? '模型复核，事实未独立验证。' : 'Model assessment; facts are not independently verified.'}{delivery.receipt.correctionAttempts > 0 && <span>{zh ? ` 已修正 ${delivery.receipt.correctionAttempts} 次` : ` Corrections: ${delivery.receipt.correctionAttempts}`}</span>}</p>
      {(delivery.runtimeIncomplete || delivery.upstreamRejected || delivery.runtimeGaps.length > 0) && <div className="task-delivery-runtime" data-testid="task-delivery-runtime">
        {delivery.runtimeIncomplete && <p>{delivery.receipt.runtimeExecution === 'partial' ? (zh ? '执行结果尚不完整' : 'Execution is incomplete') : (zh ? '执行结果待核对' : 'Execution needs checking')}</p>}
        {delivery.upstreamRejected && <p>{zh ? '上游审查未通过' : 'Upstream review did not pass'}</p>}
        {delivery.runtimeGaps.length > 0 && <ul>{delivery.runtimeGaps.map((gap) => <li key={gap}>{gap}</li>)}</ul>}
      </div>}
      <ul>{delivery.receipt.requirements.map((requirement) => <li key={requirement.id}>
        <div><strong>{requirement.text}</strong><span>{requirement.status === 'satisfied' ? (zh ? '已满足' : 'Satisfied') : requirement.status === 'unsatisfied' ? (zh ? '未满足' : 'Not satisfied') : (zh ? '待核对' : 'Unknown')}</span></div>
        <p>{requirement.reason}</p>
        {requirement.calculation && <p className="task-delivery-calculation" data-outcome={requirement.calculation.status}>
          {zh ? '计算校验' : 'Calculation check'}: {zh ? '预期' : 'Expected'} {requirement.calculation.expected ?? (zh ? '未知' : 'unknown')} &rarr; {zh ? '实际' : 'Actual'} {requirement.calculation.actual ?? (zh ? '未知' : 'unknown')}
        </p>}
        {requirement.outputQuote && <blockquote>{requirement.outputQuote}</blockquote>}
      </li>)}</ul>
    </details>}
    {context === 'task' && task?.review && !actions?.review && <details className="task-review-findings" data-i18n-ignore="true"><summary>{zh ? '审查发现' : 'Review Findings'}{!delivery && <span>{task.review.score}/100</span>}</summary><p>{task.review.summary}</p><ul>{[...new Set([...task.review.requiredCorrections, ...task.review.gaps])].map((issue) => <li key={issue}>{issue}</li>)}</ul></details>}
    <ToolRecoveryPanel taskId={taskId} taskStatus={task?.status ?? taskStatus ?? ''} canManage={loaded?.scope === scope ? loaded.canManage : false} taskRevision={task?.revision} onResolved={() => load(scope)} onChanged={changed} />
    {confirmation && <ActionModal busy={busy} onDismiss={() => setConfirmation(null)}>{confirmation.action.endsWith('review')
      ? <ReviewConfirmDialog action={confirmation.action === 'approve-review' ? 'approve' : 'reject'} note={note} busy={busy} partial={partialDelivery} onCancel={() => setConfirmation(null)} onConfirm={() => void run(confirmation)} />
      : <div className="dash-confirm-backdrop" role="presentation"><section className="dash-confirm-dialog task-action-confirm" data-i18n-ignore="true" role="alertdialog" aria-modal="true" aria-labelledby="task-action-confirm-title"><ShieldCheck size={22} /><h2 id="task-action-confirm-title">{zh ? '确认这次决定？' : 'Confirm This Decision?'}</h2><p>{confirmation.approvalId ? actions?.tools.find((item) => item.id === confirmation.approvalId)?.name : task?.plan?.summary}</p>{note && <p>{note}</p>}<div className="dash-confirm-actions"><button type="button" autoFocus disabled={busy} onClick={() => setConfirmation(null)}>{zh ? '取消' : 'Cancel'}</button><button type="button" disabled={busy} onClick={() => void run(confirmation)}>{busy ? <LoaderCircle size={15} /> : <Check size={15} />}{zh ? '确认' : 'Confirm'}</button></div></section></div>}</ActionModal>}
  </div>;
}
