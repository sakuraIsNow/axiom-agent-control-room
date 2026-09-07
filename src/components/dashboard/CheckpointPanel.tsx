import { useEffect, useMemo, useRef, useState } from 'react';
import { GitBranch, GitCompare, GitMerge, LoaderCircle, RefreshCw } from 'lucide-react';
import { branchWorkflowCheckpoint, compareWorkflowCheckpoint, listWorkflowCheckpoints, mergeWorkflowCheckpoint } from '../../lib/taskRuntime';
import type { WorkflowCheckpointBranch, WorkflowCheckpointDiff, WorkflowCheckpointSummary, WorkflowTaskSummary } from '../../types';
import { useUiLanguage } from '../../lib/uiLanguage';

type CheckpointState = {
  currentRevision: number;
  checkpoints: WorkflowCheckpointSummary[];
  branches: WorkflowCheckpointBranch[];
};

export function CheckpointPanel({ task, onTaskCreated }: {
  task: WorkflowTaskSummary;
  onTaskCreated: (taskId: string) => Promise<void>;
}) {
  const { t } = useUiLanguage();
  const [state, setState] = useState<CheckpointState | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [selectedBranchId, setSelectedBranchId] = useState('');
  const [instruction, setInstruction] = useState('');
  const [behavior, setBehavior] = useState<'continue' | 'replan'>('continue');
  const [diff, setDiff] = useState<WorkflowCheckpointDiff | null>(null);
  const [conflicts, setConflicts] = useState<string[]>([]);
  const [busy, setBusy] = useState<'load' | 'branch' | 'compare' | 'merge' | null>(null);
  const [message, setMessage] = useState('');
  const branchOperationRef = useRef(crypto.randomUUID());
  const mergeOperationRef = useRef(crypto.randomUUID());

  const load = async (signal?: AbortSignal) => {
    setBusy('load');
    setMessage('');
    try {
      const next = await listWorkflowCheckpoints(task.id, signal);
      const sorted = [...next.checkpoints].sort((left, right) => right.sequence - left.sequence);
      setState({ ...next, checkpoints: sorted });
      setSelectedId((current) => sorted.some((checkpoint) => checkpoint.checkpointId === current)
        ? current
        : sorted.find((checkpoint) => checkpoint.restorable)?.checkpointId ?? sorted[0]?.checkpointId ?? '');
    } catch (error) {
      if (!signal?.aborted) setMessage(error instanceof Error ? error.message : '版本记录暂不可用。');
    } finally {
      if (!signal?.aborted) setBusy(null);
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [task.id, task.revision]);

  const selected = state?.checkpoints.find((checkpoint) => checkpoint.checkpointId === selectedId) ?? null;
  const branches = useMemo(() => (state?.branches ?? []).filter((branch) => branch.checkpointId === selectedId && branch.kind === 'branch'), [selectedId, state?.branches]);

  useEffect(() => {
    setSelectedBranchId((current) => branches.some((branch) => branch.taskId === current) ? current : branches[0]?.taskId ?? '');
    setDiff(null);
    setConflicts([]);
  }, [branches, selectedId]);

  const createBranch = async () => {
    if (!selected?.restorable || !state || busy) return;
    setBusy('branch');
    setMessage('');
    try {
      const created = await branchWorkflowCheckpoint({
        taskId: task.id,
        checkpointId: selected.checkpointId,
        expectedRevision: state.currentRevision,
        instruction: instruction.trim(),
        behavior,
        operationId: branchOperationRef.current,
      });
      branchOperationRef.current = crypto.randomUUID();
      setMessage('新方案已创建，正在打开。');
      await onTaskCreated(created.id);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '无法创建新方案。');
    } finally {
      setBusy(null);
    }
  };

  const compare = async () => {
    if (!selected || !selectedBranchId || busy) return;
    setBusy('compare');
    setMessage('');
    try {
      setDiff(await compareWorkflowCheckpoint(task.id, selected.checkpointId, selectedBranchId));
      setConflicts([]);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '无法比较两个方案。');
    } finally {
      setBusy(null);
    }
  };

  const merge = async (strategy: 'manual' | 'prefer-branch' | 'prefer-current' = 'manual') => {
    if (!selected || !selectedBranchId || !state || busy) return;
    setBusy('merge');
    setMessage('');
    try {
      const created = await mergeWorkflowCheckpoint({
        taskId: task.id,
        checkpointId: selected.checkpointId,
        branchTaskId: selectedBranchId,
        expectedRevision: state.currentRevision,
        strategy,
        operationId: mergeOperationRef.current,
      });
      mergeOperationRef.current = crypto.randomUUID();
      setConflicts([]);
      setMessage('合并方案已创建，正在打开。');
      await onTaskCreated(created.id);
    } catch (error) {
      const details = error as Error & { code?: string; conflicts?: string[] };
      if (details.code === 'CHECKPOINT_MERGE_CONFLICT') setConflicts(details.conflicts ?? []);
      setMessage(details.message || '无法合并方案。');
    } finally {
      setBusy(null);
    }
  };

  return <section className="dash-detail-section dash-checkpoints" aria-label="版本与检查点">
    <div className="dash-detail-head">
      <GitBranch size={14} />
      <span>版本与检查点</span>
      <em>v{state?.currentRevision ?? task.revision}</em>
      <button type="button" title="刷新版本" aria-label="刷新版本" disabled={busy === 'load'} onClick={() => void load()}><RefreshCw size={12} /></button>
    </div>
    {busy === 'load' && !state ? <p className="dash-detail-empty"><LoaderCircle className="dash-lifecycle-spinner" size={13} />正在读取版本…</p>
      : !state?.checkpoints.length ? <p className="dash-detail-empty">任务执行后会自动保存可恢复版本。</p>
        : <>
          <select value={selectedId} onChange={(event) => setSelectedId(event.target.value)} aria-label="选择检查点">
            {state.checkpoints.map((checkpoint, index) => <option key={checkpoint.checkpointId} value={checkpoint.checkpointId}>
              {index === 0 ? '最新' : `版本 ${state.checkpoints.length - index}`} · {checkpoint.completedSteps}/{checkpoint.totalSteps} 步
            </option>)}
          </select>
          {selected && <div className="dash-checkpoint-meta">
            <span>{selected.stage === 'final-delivery' ? '交付版本' : '执行版本'}</span>
            <span>{selected.failedSteps ? `${selected.failedSteps} 项未完成` : '无失败项'}</span>
            {!selected.restorable && <span className="warning">旧版本仅可查看</span>}
          </div>}
          {selected?.restorable && <div className="dash-checkpoint-branch-form">
            <textarea rows={2} maxLength={8000} value={instruction} onChange={(event) => setInstruction(event.target.value)} placeholder="这个版本接下来需要怎样调整（可选）" />
            <div className="dash-checkpoint-actions">
              <div className="dash-checkpoint-mode">
                <button type="button" className={behavior === 'continue' ? 'active' : ''} onClick={() => setBehavior('continue')}>沿用计划</button>
                <button type="button" className={behavior === 'replan' ? 'active' : ''} onClick={() => setBehavior('replan')}>重新规划</button>
              </div>
              <button type="button" className="primary" disabled={Boolean(busy)} onClick={() => void createBranch()}><GitBranch size={12} />从此继续</button>
            </div>
          </div>}
          {branches.length > 0 && <div className="dash-checkpoint-compare">
            <select value={selectedBranchId} onChange={(event) => { setSelectedBranchId(event.target.value); setDiff(null); setConflicts([]); }} aria-label="选择分支方案">
              {branches.map((branch) => <option key={branch.taskId} value={branch.taskId} data-i18n-ignore="true">{branch.title} · {t(branch.status === 'completed' ? '已完成' : branch.status === 'paused' ? '已暂停' : '执行中')}</option>)}
            </select>
            <div className="dash-checkpoint-actions">
              <button type="button" disabled={Boolean(busy)} onClick={() => void compare()}><GitCompare size={12} />比较</button>
              <button type="button" className="primary" disabled={Boolean(busy)} onClick={() => void merge()}><GitMerge size={12} />合并方案</button>
            </div>
          </div>}
          {diff && <div className="dash-checkpoint-diff">
            <span>新增 {diff.steps.added.length}</span><span>变化 {diff.steps.changed.length}</span><span>移除 {diff.steps.removed.length}</span>{diff.planChanged && <span>计划已调整</span>}
          </div>}
          {conflicts.length > 0 && <div className="dash-checkpoint-conflict">
            <p>两个方案修改了相同内容，请选择保留方式。</p>
            <button type="button" disabled={Boolean(busy)} onClick={() => void merge('prefer-current')}>保留当前方案</button>
            <button type="button" disabled={Boolean(busy)} onClick={() => void merge('prefer-branch')}>采用分支方案</button>
          </div>}
        </>}
    {message && <p className="dash-checkpoint-message" role="status">{message}</p>}
  </section>;
}
