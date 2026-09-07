import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, LoaderCircle, Play, RefreshCw, ShieldQuestion, Undo2 } from 'lucide-react';
import { getToolRecovery, resolveToolRecovery, resumeAfterToolRecovery, type ToolRecoveryRecord, type ToolRecoverySnapshot } from '../../lib/toolRecoveryRuntime';
import { useUiLanguage } from '../../lib/uiLanguage';
import './tool-recovery.css';

export function ToolRecoveryPanel({ taskId, taskStatus, onChanged, onResolved, canManage = true, taskRevision }: { taskId: string; taskStatus: string; onChanged: (taskId: string) => Promise<void>; onResolved?: () => Promise<void>; canManage?: boolean; taskRevision?: number }) {
  const { language } = useUiLanguage();
  const zh = language === 'zh-CN';
  const scope = useMemo(() => ({ taskId }), [taskId]);
  const selectedTask = useRef<typeof scope | null>(scope);
  selectedTask.current = scope;
  const latestRead = useRef(0);
  const actionLock = useRef<typeof scope | null>(null);
  const [loaded, setLoaded] = useState<{ scope: typeof scope; value: ToolRecoverySnapshot } | null>(null);
  const [noteState, setNotes] = useState<{ scope: typeof scope; values: Record<string, string> } | null>(null);
  const [failure, setFailure] = useState<{ scope: typeof scope; kind: 'load' | 'action' } | null>(null);
  const [pending, setPending] = useState<typeof scope | null>(null);
  const [revision, setRevision] = useState(0);
  const snapshot = loaded?.scope === scope ? loaded.value : null;
  const notes = noteState?.scope === scope ? noteState.values : {};
  const busy = pending === scope || !canManage;
  const error = failure?.scope !== scope ? '' : failure.kind === 'load'
    ? zh ? '执行记录暂时不可用' : 'Execution records are unavailable'
    : zh ? '操作未完成，请刷新记录后重试' : 'Action not completed. Refresh the records and try again.';
  const loadSnapshot = useCallback(async (currentScope: typeof scope, signal?: AbortSignal) => {
    const read = ++latestRead.current;
    try {
      const value = await getToolRecovery(currentScope.taskId, signal);
      if (!signal?.aborted && selectedTask.current === currentScope && latestRead.current === read) {
        setLoaded({ scope: currentScope, value });
      }
    } catch (error) {
      if (!signal?.aborted && selectedTask.current === currentScope && latestRead.current === read) throw error;
    }
  }, []);
  useEffect(() => {
    selectedTask.current = scope;
    return () => { if (selectedTask.current === scope) selectedTask.current = null; };
  }, [scope]);
  useEffect(() => {
    const controller = new AbortController();
    setFailure(null);
    void loadSnapshot(scope, controller.signal).catch(() => {
      if (!controller.signal.aborted && selectedTask.current === scope) setFailure({ scope, kind: 'load' });
    });
    return () => controller.abort();
  }, [scope, taskStatus, revision, loadSnapshot]);
  const run = async (action: () => Promise<void>, refreshTask = false) => {
    if (actionLock.current === scope || !canManage) return;
    actionLock.current = scope;
    setPending(scope);
    setFailure(null);
    try {
      await action();
      if (selectedTask.current !== scope) return;
      await loadSnapshot(scope);
      if (refreshTask && selectedTask.current === scope) await onChanged(taskId);
    } catch {
      if (selectedTask.current === scope) setFailure({ scope, kind: 'action' });
    } finally {
      if (actionLock.current === scope) actionLock.current = null;
      if (selectedTask.current === scope) setPending(null);
    }
  };
  const resolve = (record: ToolRecoveryRecord, decision: 'confirmed-completed' | 'confirmed-not-executed') => run(async () => {
    await resolveToolRecovery(taskId, record, decision, notes[record.id] ?? '');
    if (selectedTask.current !== scope) return;
    setNotes((current) => {
      if (current?.scope !== scope) return current;
      const values = { ...current.values };
      delete values[record.id];
      return { scope, values };
    });
    await onResolved?.();
  });
  const records = snapshot?.executions.filter((record) => record.status !== 'completed' || record.receiptSource === 'human-confirmed') ?? [];
  const canResume = snapshot?.canResume && ['paused', 'waiting_for_human'].includes(taskStatus);
  if (!records.length && !canResume && (!error || !['paused', 'waiting_for_human', 'failed', 'cancelled'].includes(taskStatus))) return null;
  return <section className="dash-detail-section tool-recovery" data-i18n-ignore="true" aria-label={zh ? '工具执行核对' : 'Tool execution review'}>
    <header><span><ShieldQuestion size={15} />{zh ? '执行核对' : 'Execution Review'}</span><button type="button" title={zh ? '刷新记录' : 'Refresh records'} aria-label={zh ? '刷新记录' : 'Refresh records'} disabled={busy} onClick={() => setRevision((value) => value + 1)}><RefreshCw size={14} /></button></header>
    {error && <p role="alert">{error}</p>}
    {records.map((record) => <div className="tool-recovery-entry" key={record.id}>
      <strong>{record.toolName}</strong>
      <span>{record.status === 'outcome_unknown' ? (zh ? '外部结果待核对' : 'External outcome needs review') : record.status === 'executing' ? (zh ? '执行器仍在处理' : 'An executor is still working') : record.status === 'retryable' ? record.resolution?.decision === 'confirmed-not-executed' ? (zh ? '已确认未执行' : 'Confirmed not executed') : (zh ? '可安全重试' : 'Safe to retry') : (zh ? '已人工确认完成' : 'Completion confirmed by an operator')}</span>
      {record.requiresReview && <>
        <textarea aria-label={zh ? '核对依据' : 'Verification notes'} placeholder={zh ? '填写实际核对结果' : 'Record what you verified externally'} value={notes[record.id] ?? ''} maxLength={2000} rows={2} disabled={busy} onChange={(event) => setNotes((current) => ({ scope, values: { ...(current?.scope === scope ? current.values : {}), [record.id]: event.target.value } }))} />
        <div className="tool-recovery-actions"><button type="button" disabled={busy || !notes[record.id]?.trim()} onClick={() => void resolve(record, 'confirmed-completed')}><Check size={14} />{zh ? '确认已完成' : 'Confirm Completed'}</button><button type="button" disabled={busy || !notes[record.id]?.trim()} onClick={() => void resolve(record, 'confirmed-not-executed')}><Undo2 size={14} />{zh ? '确认未执行' : 'Confirm Not Executed'}</button></div>
      </>}
    </div>)}
    {canResume && <button type="button" className="tool-recovery-resume" disabled={busy} onClick={() => void run(() => resumeAfterToolRecovery(taskId, taskRevision), true)}>{busy ? <LoaderCircle size={15} /> : <Play size={15} />}{zh ? '继续任务' : 'Continue Task'}</button>}
  </section>;
}
