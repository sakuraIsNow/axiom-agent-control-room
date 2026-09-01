import { AlertTriangle, Check, CircleCheck, CircleDashed, CircleX, Compass, ListChecks, LoaderCircle, RotateCcw, Trash2, UserCheck } from 'lucide-react';
import type { TaskProfile, WorkflowTaskSummary } from '../../types';
import { latestUserInput } from '../../lib/conversationInput';
import { taskStatusLabels } from '../../lib/graphPresentation';
import { canHumanReviewTask } from '../../lib/humanReviewState';
import { localizeRuntimeText, taskDifficultyLabel, taskKindLabel, taskReasonLabel, taskRouteLabel, taskStageLabel } from '../../lib/taskPresentation';

type ReviewResult = { approved: boolean; score: number; summary: string; gaps: string[]; requiredCorrections: string[] };

const evidenceStatusLabel = {
  verified: '交付已核验',
  partial: '部分交付',
  unverified: '待核验',
  'not-required': '无需核验',
} as const;

export function TaskDetailPanel({
  task,
  sessionTopic,
  taskProfile,
  reviewResult,
  reviewApprovalTaskId,
  reviewNote,
  reviewBusy,
  onReviewNoteChange,
  onRequestApprove,
  onRequestReject,
  onResubmit,
  onDeleteTask,
}: {
  task: WorkflowTaskSummary | null;
  sessionTopic: string | null;
  taskProfile: TaskProfile | null;
  reviewResult: ReviewResult | null;
  reviewApprovalTaskId: string | null;
  reviewNote: string;
  reviewBusy: boolean;
  onReviewNoteChange: (value: string) => void;
  onRequestApprove: () => void;
  onRequestReject: () => void;
  onResubmit: (input: string) => void;
  onDeleteTask: (taskId: string) => void;
}) {
  if (!task && !taskProfile) {
    return <aside className="dash-detail-panel dash-empty"><Compass size={18} /><span>选择或提交一个任务查看详情</span></aside>;
  }
  const effectiveProfile = taskProfile ?? task?.profile ?? null;
  const reviewAvailable = canHumanReviewTask(task, reviewResult, reviewApprovalTaskId);
  const isDirect = effectiveProfile?.route === 'direct';
  const terminal = task ? ['completed', 'failed', 'cancelled'].includes(task.status) : false;
  const lifecycle = task ? [
    { label: '意图', state: task.input ? 'complete' : 'pending' },
    { label: '计划', state: task.totalSteps > 0 ? 'complete' : isDirect ? 'skipped' : ['planning', 'awaiting_approval'].includes(task.status) ? 'active' : 'pending' },
    { label: '执行', state: task.status === 'failed' || task.status === 'cancelled' ? 'failed' : task.status === 'completed' ? 'complete' : task.completedSteps > 0 || ['planning', 'running', 'reviewing', 'waiting_for_human'].includes(task.status) ? 'active' : 'pending' },
    { label: '审查', state: reviewResult || task.reviewScore !== undefined ? 'complete' : isDirect ? 'skipped' : ['reviewing', 'waiting_for_human'].includes(task.status) ? 'active' : 'pending' },
    { label: '交付', state: task.status === 'completed' ? 'complete' : task.status === 'failed' || task.status === 'cancelled' ? 'failed' : terminal ? 'pending' : 'active' },
  ] as const : [];
  const lifecycleIcon = (state: (typeof lifecycle)[number]['state']) => state === 'complete'
    ? <CircleCheck size={14} />
    : state === 'active'
      ? <LoaderCircle className="dash-lifecycle-spinner" size={14} />
      : state === 'failed'
        ? <CircleX size={14} />
        : <CircleDashed size={14} />;
  return <aside className="dash-detail-panel">
    {task && <div className="dash-detail-section dash-task-detail-summary">
      <div className="dash-detail-task-id">{task.id.slice(0, 8).toUpperCase()} <span className={`dash-detail-status status-${task.status}`}>{taskStatusLabels[task.status]}</span></div>
      <h2>{task.title}</h2>
      <p>{latestUserInput(task.input) || '暂无任务输入。'}</p>
      <dl className="dash-detail-fields">
        <div><dt>负责人</dt><dd><span className="dash-user-mark">{task.userId.slice(0, 1).toUpperCase()}</span>{task.userId}</dd></div>
        <div><dt>会话</dt><dd>{sessionTopic ?? task.title}</dd></div>
        <div><dt>阶段</dt><dd>{taskStageLabel(task.currentStage)}</dd></div>
        <div><dt>难度</dt><dd>{taskDifficultyLabel(task.profile?.difficulty ?? taskProfile?.difficulty)}</dd></div>
      </dl>
      <div className="dash-detail-pills"><span>{taskKindLabel(task.profile?.kind ?? taskProfile?.kind)}</span><span>{taskRouteLabel(task.profile?.route ?? taskProfile?.route)}</span><span>{task.tokens.total.toLocaleString()} Token</span>{task.evidenceSummary && <span className={`dash-evidence-pill ${task.evidenceSummary.status}`}>{evidenceStatusLabel[task.evidenceSummary.status]}</span>}</div>
      <div className="dash-lifecycle" aria-label="执行链">
        <div className="dash-lifecycle-head"><span>执行链</span><small>意图到交付</small></div>
        <div className="dash-lifecycle-track">
          {lifecycle.map((item, index) => <div key={item.label} className="dash-lifecycle-unit">
            <div className={`dash-lifecycle-step ${item.state}`} title={`${item.label}：${item.state === 'complete' ? '已完成' : item.state === 'active' ? '进行中' : item.state === 'failed' ? '未完成' : '未启用'}`}>
              <span className="dash-lifecycle-icon">{lifecycleIcon(item.state)}</span>
              <strong>{item.label}</strong>
            </div>
            {index < lifecycle.length - 1 && <span className={`dash-lifecycle-connector ${item.state === 'complete' ? 'complete' : ''}`} aria-hidden="true" />}
          </div>)}
        </div>
      </div>
      <div className="dash-detail-actions">
        {task.input && <button type="button" className="secondary-action dash-resubmit" onClick={() => onResubmit(latestUserInput(task.input))}><RotateCcw size={13} />重新提交</button>}
        {['completed', 'failed', 'cancelled'].includes(task.status) && <button type="button" className="dash-detail-delete" onClick={() => onDeleteTask(task.id)}><Trash2 size={13} />删除</button>}
      </div>
    </div>}
    <div className="dash-detail-section">
      <div className="dash-detail-head"><Compass size={14} /><span>路由依据</span></div>
      {effectiveProfile && effectiveProfile.reasons.length > 0
        ? <ul>{effectiveProfile.reasons.slice(0, 3).map((reason) => <li key={reason}>{taskReasonLabel(reason)}</li>)}</ul>
        : <p className="dash-detail-empty">暂无路由说明。</p>}
    </div>
    {reviewResult && <div className="dash-detail-section">
      <div className="dash-detail-head"><ListChecks size={14} /><span>审查发现</span><em className={reviewResult.approved ? 'approved' : 'rejected'}>{reviewResult.score}/100</em></div>
      {reviewResult.gaps.length > 0 && <div className="dash-detail-subgroup">
        <h4>完整性缺口</h4>
        <ul>{reviewResult.gaps.map((gap) => <li key={gap}>{localizeRuntimeText(gap)}</li>)}</ul>
      </div>}
      {reviewResult.requiredCorrections.length > 0 && <div className="dash-detail-subgroup">
        <h4><AlertTriangle size={12} /> 必须整改项</h4>
        <ul>{reviewResult.requiredCorrections.map((item) => <li key={item}>{localizeRuntimeText(item)}</li>)}</ul>
      </div>}
      {reviewResult.gaps.length === 0 && reviewResult.requiredCorrections.length === 0 && <p className="dash-detail-empty">{reviewResult.summary ? localizeRuntimeText(reviewResult.summary) : '审查员未提出具体缺口。'}</p>}
    </div>}
    {task?.evidenceSummary && <div className="dash-detail-section dash-evidence-summary">
      <div className="dash-detail-head"><ListChecks size={14} /><span>交付凭据</span><em className={task.evidenceSummary.status}>{evidenceStatusLabel[task.evidenceSummary.status]}</em></div>
      <div className="dash-evidence-grid">
        <span><strong>{task.evidenceSummary.completedSteps}/{task.evidenceSummary.totalSteps}</strong> 步骤完成</span>
        <span><strong>{task.evidenceSummary.evidenceItems}</strong> 条证据</span>
        <span><strong>{task.evidenceSummary.artifactRefs}</strong> 个 Artifact</span>
        <span><strong>{task.evidenceSummary.toolReceipts}</strong> 次工具回执</span>
      </div>
      {task.evidenceSummary.gaps.length > 0 && <ul className="dash-evidence-gaps">{task.evidenceSummary.gaps.slice(0, 3).map((gap) => <li key={gap}>{localizeRuntimeText(gap)}</li>)}</ul>}
    </div>}
    {reviewAvailable && <section className="dash-human-review" data-testid="human-review-controls" aria-labelledby="dash-human-review-title">
      <div className="dash-human-review-head">
        <span><UserCheck size={15} /><strong id="dash-human-review-title">人工审核</strong></span>
        <em>{reviewResult!.score}/100</em>
      </div>
      <textarea
        value={reviewNote}
        onChange={(event) => onReviewNoteChange(event.target.value)}
        rows={3}
        maxLength={2000}
        disabled={reviewBusy}
        aria-label="审核意见"
        placeholder="填写审核意见（可选）"
      />
      <div className="dash-human-review-actions">
        <button type="button" className="reject" onClick={onRequestReject} disabled={reviewBusy}><RotateCcw size={14} />驳回并整改</button>
        <button type="button" className="approve" onClick={onRequestApprove} disabled={reviewBusy}><Check size={15} />批准交付</button>
      </div>
    </section>}
  </aside>;
}
