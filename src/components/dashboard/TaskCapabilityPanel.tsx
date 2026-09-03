import { useEffect, useState } from 'react';
import {
  ArrowRight, BrainCircuit, Check, CirclePause, CirclePlay, Download, ExternalLink, FileCheck2, GitBranch,
  LoaderCircle, LockKeyhole, MessageSquareMore, PackagePlus, RefreshCw, ShieldCheck, Sparkles, Star,
  Timer, UnlockKeyhole,
} from 'lucide-react';
import type { EvidenceItem, WorkflowTask, WorkflowTaskSummary } from '../../types';
import {
  controlTaskAgent, executeTaskAction, getTaskActions, submitTaskFeedback, updateTaskMemoryPolicy,
  type TaskAction,
} from '../../lib/businessRuntime';
import { getWorkflowTask } from '../../lib/taskRuntime';
import { downloadReportAttachment, exportConversationReport } from '../../lib/reportExport';
import { userFacingError } from '../../lib/errorPresentation';
import { agentDisplayName } from '../../lib/agentPresentation';
import '../../styles/task-capabilities.css';

const activeStatuses = new Set(['queued', 'planning', 'running', 'reviewing', 'paused', 'waiting_for_human', 'awaiting_approval']);
const feedbackIssues = { accuracy: '准确性', completeness: '完整性', evidence: '证据', latency: '速度', routing: '路由', tool: '工具', format: '呈现' } as const;
const evidenceKindLabel: Record<EvidenceItem['kind'], string> = {
  'user-fact': '用户事实', 'tool-result': '工具结果', 'external-source': '外部来源', artifact: 'Artifact', dependency: '上游交接', 'model-inference': '模型推断',
};
const evidenceStateLabel: Record<EvidenceItem['verification'], string> = { verified: '已验证', supported: '来源支持', unverified: '未验证', contradicted: '存在冲突' };
const durationLabel = (milliseconds: number) => milliseconds < 60_000
  ? `${Math.max(1, Math.round(milliseconds / 1_000))} 秒`
  : `${Math.max(1, Math.round(milliseconds / 60_000))} 分钟`;

function EvidenceGraph({ items }: { items: EvidenceItem[] }) {
  if (!items.length) return null;
  return <section className="task-evidence-graph" aria-label="证据图">
    <div className="task-capability-head"><span><FileCheck2 size={14} />证据图</span><small>{items.length} 条</small></div>
    <div className="task-evidence-list">{items.slice(0, 24).map((item) => <article key={item.id} className={item.verification}>
      <div className="task-evidence-source"><span>{evidenceKindLabel[item.kind]}</span><strong>{item.title ?? item.source}</strong>{item.locator && <small>{item.locator}</small>}{(item.publishedAt || item.retrievedAt) && <time>{new Date(item.publishedAt ?? item.retrievedAt!).toLocaleString('zh-CN')}</time>}</div>
      <ArrowRight size={13} />
      <div className="task-evidence-claim"><span>{evidenceStateLabel[item.verification]} · {Math.round(item.confidence * 100)}%</span><p>{item.claim}</p><footer>{item.artifactId && <em>Artifact：{item.artifactId}</em>}{item.uri && <a href={item.uri} target="_blank" rel="noreferrer">查看来源<ExternalLink size={11} /></a>}</footer></div>
    </article>)}</div>
  </section>;
}

export function TaskCapabilityPanel({ task, onTaskCreated }: {
  task: WorkflowTaskSummary;
  onTaskCreated: (taskId: string) => Promise<void>;
}) {
  const [detail, setDetail] = useState<WorkflowTask | null>(null);
  const [actions, setActions] = useState<TaskAction[]>([]);
  const [selectedStepId, setSelectedStepId] = useState('');
  const [replacementModel, setReplacementModel] = useState('');
  const [memoryEnabled, setMemoryEnabled] = useState(true);
  const [score, setScore] = useState(0);
  const [feedbackNote, setFeedbackNote] = useState('');
  const [feedbackIssueTypes, setFeedbackIssueTypes] = useState<string[]>([]);
  const [revisedAnswer, setRevisedAnswer] = useState('');
  const [evidenceCorrectionId, setEvidenceCorrectionId] = useState('');
  const [evidenceCorrection, setEvidenceCorrection] = useState('');
  const [reportFormat, setReportFormat] = useState<'md' | 'docx' | 'tex' | 'pdf'>('pdf');
  const [followUpSeconds, setFollowUpSeconds] = useState(86_400);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async (signal?: AbortSignal) => {
    const [nextDetail, nextActions] = await Promise.all([getWorkflowTask(task.id, signal), getTaskActions(task.id, signal)]);
    setDetail(nextDetail);
    setActions(nextActions);
    setMemoryEnabled(nextDetail.memoryPolicy?.enabled !== false);
    setSelectedStepId((current) => current && nextDetail.plan?.steps?.some((step) => step.id === current)
      ? current
      : nextDetail.plan?.steps?.[0]?.id ?? '');
  };

  useEffect(() => {
    const controller = new AbortController();
    setDetail(null);
    setActions([]);
    setMessage(null);
    setError(null);
    void load(controller.signal).catch((caught) => {
      if (!controller.signal.aborted) setError(userFacingError(caught, '任务操作读取失败。'));
    });
    return () => controller.abort();
  }, [task.id, task.updatedAt]);

  const selectedStep = detail?.plan?.steps?.find((step) => step.id === selectedStepId);
  const selectedResult = detail?.stepResults.find((result) => result.stepId === selectedStepId);
  const selectedControl = detail?.controlState?.[selectedStepId];
  const evidenceItems = detail?.stepResults.flatMap((result) => result.evidenceDetails ?? []).filter((item, index, all) => all.findIndex((candidate) => candidate.id === item.id) === index) ?? [];
  const handoffs = detail?.stepResults.flatMap((result) => result.handoff ? [{ stepId: result.stepId, agentId: result.agentId, handoff: result.handoff }] : []) ?? [];
  const canPause = Boolean(detail && activeStatuses.has(detail.status) && !selectedControl?.paused && selectedResult?.status !== 'completed');
  const canResume = Boolean(selectedControl?.paused);
  const canRerun = Boolean(selectedResult);
  const isLocked = Boolean(selectedControl?.locked);

  const run = async (key: string, operation: () => Promise<void>) => {
    if (busy) return;
    setBusy(key);
    setError(null);
    setMessage(null);
    try { await operation(); } catch (caught) { setError(userFacingError(caught, '任务操作没有完成。')); } finally { setBusy(null); }
  };

  const performAction = (action: TaskAction) => void run(action.id, async () => {
    if (action.id === 'export-report') {
      const controller = new AbortController();
      const report = await exportConversationReport({
        sessionId: detail?.sessionId ?? task.sessionId,
        instruction: '将当前会话整理为结构清晰、保留证据边界的报告。',
        decision: { scope: 'conversation', format: reportFormat, title: task.title },
      }, controller.signal);
      downloadReportAttachment(report);
      setMessage(`${reportFormat.toUpperCase()} 报告已生成。`);
      return;
    }
    if (action.id === 'rerun-step') {
      if (!selectedStepId) throw new Error('请先选择要重跑的 Agent。');
      await controlTaskAgent(task.id, selectedStepId, 'rerun', { reason: '由用户从交付面板发起局部重跑。' });
      await load();
      setMessage('已从所选 Agent 重新进入执行队列。');
      return;
    }
    const result = await executeTaskAction(task.id, action.id, action.id === 'create-schedule'
      ? { schedule: followUpSeconds === 0 ? { runAt: new Date(Date.now() + 86_400_000).toISOString() } : { intervalSeconds: followUpSeconds } }
      : {});
    const createdTaskId = typeof result.result.taskId === 'string' ? result.result.taskId : null;
    if (createdTaskId) await onTaskCreated(createdTaskId);
    setMessage(action.id === 'continue-analysis' ? '继续分析任务已进入队列。'
      : action.id === 'model-review' ? '独立复核任务已进入队列。'
        : action.id === 'save-nexus' ? '已保存为可编辑的 Agent Nexus 草稿。'
          : action.id === 'save-plugin' ? '已保存为插件草稿并完成兼容检查。'
            : action.id === 'create-schedule' ? '跟进日程已创建。'
              : Array.isArray(result.result.deliveryIds) && result.result.deliveryIds.length === 0 ? '当前没有可用通知渠道，未创建外发投递。' : '通知已进入可靠发送队列。');
  });

  const control = (action: 'pause' | 'resume' | 'rerun' | 'replace' | 'lock' | 'unlock') => void run(`control-${action}`, async () => {
    if (!selectedStepId) throw new Error('请先选择 Agent。');
    const input = action === 'replace'
      ? { replacementModel: replacementModel.trim(), reason: '用户调整执行模型。' }
      : { reason: '用户从任务详情发起操作。' };
    if (action === 'replace' && !replacementModel.trim()) throw new Error('请填写替换模型。');
    const result = await controlTaskAgent(task.id, selectedStepId, action, input);
    setDetail(result.task);
    const impact = result.affectedDescendants?.length ? `将影响 ${result.affectedDescendants.length} 个后续 Agent。` : '';
    if (result.riskIncreased) setMessage(`替换扩大了权限，已等待人工确认。${impact}`);
    else setMessage(`${action === 'pause' ? '目标 Agent 已暂停，其他并行 Agent 不受影响。' : action === 'resume' ? 'Agent 已从检查点恢复。' : action === 'replace' ? 'Agent 模型已替换并重新排队。' : action === 'rerun' ? 'Agent 已局部重跑。' : action === 'lock' ? '结果已锁定。' : '结果已解锁。'}${impact}`);
    await load();
  });

  const toggleMemory = () => void run('memory', async () => {
    const next = !memoryEnabled;
    await updateTaskMemoryPolicy(task.id, { enabled: next });
    setMemoryEnabled(next);
    setMessage(next ? '本任务已允许使用长期记忆。' : '本任务已禁用长期记忆。');
  });

  const submitFeedback = () => void run('feedback', async () => {
    if (!score) throw new Error('请先选择评分。');
    await submitTaskFeedback(task.id, {
      score,
      issueTypes: feedbackIssueTypes,
      note: feedbackNote.trim(),
      ...(revisedAnswer.trim() ? { revisedAnswer: revisedAnswer.trim() } : {}),
      ...(evidenceCorrectionId.trim() && evidenceCorrection.trim() ? { evidenceCorrections: [{ evidenceId: evidenceCorrectionId.trim(), correction: evidenceCorrection.trim() }] } : {}),
    });
    setMessage('反馈已进入路由与模型评测。');
    setFeedbackNote('');
    setFeedbackIssueTypes([]);
    setRevisedAnswer('');
    setEvidenceCorrectionId('');
    setEvidenceCorrection('');
  });

  return <div className="task-capability-panel">
    <div className="task-capability-head"><span><Sparkles size={14} />继续处理</span>{!detail && <LoaderCircle className="spin" size={13} />}</div>
    {task.estimate && <section className="task-live-estimate"><div><Timer size={13} /><span><strong>{Math.round(task.estimate.progress * 100)}%</strong> 已完成</span><em>剩余 {durationLabel(task.estimate.durationMs.low)} - {durationLabel(task.estimate.durationMs.high)}</em></div><span><i style={{ width: `${Math.max(2, Math.round(task.estimate.progress * 100))}%` }} /></span><small>{task.estimate.remainingSteps} 个步骤 · {task.estimate.confidence === 'high' ? '高可信' : task.estimate.confidence === 'medium' ? '中等可信' : '样本较少'} · 根据真实事件更新</small></section>}
    <div className="task-action-options"><label>报告<select value={reportFormat} onChange={(event) => setReportFormat(event.target.value as typeof reportFormat)}><option value="pdf">PDF</option><option value="docx">Word</option><option value="md">Markdown</option><option value="tex">LaTeX</option></select></label><label>跟进<select value={followUpSeconds} onChange={(event) => setFollowUpSeconds(Number(event.target.value))}><option value={0}>明天一次</option><option value={86_400}>每天</option><option value={604_800}>每周</option><option value={2_592_000}>每月</option></select></label></div>
    <div className="task-action-grid">{actions.map((action) => {
      const Icon = action.id === 'continue-analysis' ? MessageSquareMore : action.id === 'model-review' ? ShieldCheck : action.id === 'save-nexus' ? GitBranch : action.id === 'save-plugin' ? PackagePlus : action.id === 'export-report' ? Download : RefreshCw;
      return <button type="button" key={action.id} disabled={!action.enabled || Boolean(busy)} onClick={() => performAction(action)}><Icon size={13} />{busy === action.id ? '处理中' : action.label}</button>;
    })}</div>

    {detail?.plan?.steps?.length ? <section className="task-agent-control">
      <div className="task-capability-head"><span><BrainCircuit size={14} />Agent 干预</span><small>{detail.plan.steps.length} 个 Agent</small></div>
      <select aria-label="选择 Agent" value={selectedStepId} onChange={(event) => setSelectedStepId(event.target.value)}>{detail.plan.steps.map((step) => <option key={step.id} value={step.id}>{step.title} · {agentDisplayName(step.role)}</option>)}</select>
      {selectedStep && <p>{selectedResult ? `${selectedResult.status === 'completed' ? '已完成' : '未完成'} · ${selectedResult.durationMs} ms · ${selectedResult.tokens ?? 0} Token` : detail.status === 'paused' ? '已暂停，等待恢复' : '等待执行'}</p>}
      <div className="task-agent-buttons">
        <button type="button" disabled={!canPause || Boolean(busy)} onClick={() => control('pause')}><CirclePause size={13} />暂停</button>
        <button type="button" disabled={!canResume || Boolean(busy)} onClick={() => control('resume')}><CirclePlay size={13} />恢复</button>
        <button type="button" disabled={!canRerun || Boolean(busy)} onClick={() => control('rerun')}><RefreshCw size={13} />局部重跑</button>
        <button type="button" disabled={!selectedResult || Boolean(busy)} onClick={() => control(isLocked ? 'unlock' : 'lock')}>{isLocked ? <UnlockKeyhole size={13} /> : <LockKeyhole size={13} />}{isLocked ? '解锁' : '锁定结果'}</button>
      </div>
      <div className="task-agent-replace"><input value={replacementModel} onChange={(event) => setReplacementModel(event.target.value)} placeholder="替换模型名称" /><button type="button" disabled={!replacementModel.trim() || Boolean(busy)} onClick={() => control('replace')}>替换</button></div>
    </section> : null}

    {handoffs.length > 0 && <section className="task-handoff-list"><div className="task-capability-head"><span><GitBranch size={14} />Agent 交接</span><small>{handoffs.length} 次</small></div>{handoffs.slice(-6).map(({ stepId, agentId, handoff }) => <article key={`${stepId}-${agentId}`}><header><strong>{agentDisplayName(agentId)}</strong><span className={handoff.status}>{handoff.status === 'complete' ? '完整' : handoff.status === 'partial' ? '部分完成' : '受阻'}</span></header><p>{handoff.summary}</p><footer><span>{handoff.evidenceIds.length} 条证据</span><span>{handoff.artifactIds.length} 个 Artifact</span><span>{handoff.openQuestions.length} 个未决问题</span></footer>{handoff.openQuestions.length > 0 && <small>{handoff.openQuestions.join('；')}</small>}</article>)}</section>}

    <EvidenceGraph items={evidenceItems} />

    <section className="task-memory-policy"><span><BrainCircuit size={13} /><em>本任务长期记忆</em></span><button type="button" className={memoryEnabled ? 'toggle active' : 'toggle'} onClick={toggleMemory} disabled={Boolean(busy)} aria-label={memoryEnabled ? '关闭长期记忆' : '开启长期记忆'}><i /></button></section>

    {['completed', 'failed', 'cancelled'].includes(task.status) && <section className="task-feedback">
      <div className="task-capability-head"><span><Star size={14} />交付反馈</span></div>
      <div className="task-feedback-stars">{[1, 2, 3, 4, 5].map((value) => <button type="button" key={value} className={value <= score ? 'active' : ''} onClick={() => setScore(value)} aria-label={`${value} 星`}><Star size={15} fill={value <= score ? 'currentColor' : 'none'} /></button>)}</div>
      <div className="task-feedback-issues">{Object.entries(feedbackIssues).map(([id, label]) => <button type="button" key={id} className={feedbackIssueTypes.includes(id) ? 'active' : ''} onClick={() => setFeedbackIssueTypes((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id])}>{label}</button>)}</div>
      <div className="task-feedback-note"><input value={feedbackNote} onChange={(event) => setFeedbackNote(event.target.value)} placeholder="哪里做得好，哪里需要改进" /><button type="button" disabled={!score || Boolean(busy)} onClick={submitFeedback}><Check size={13} /></button></div>
      <textarea rows={2} value={revisedAnswer} onChange={(event) => setRevisedAnswer(event.target.value)} placeholder="修订答案（可选）" />
      {evidenceItems.length > 0 && <div className="task-evidence-correction"><select value={evidenceCorrectionId} onChange={(event) => setEvidenceCorrectionId(event.target.value)}><option value="">纠正证据（可选）</option>{evidenceItems.map((item) => <option key={item.id} value={item.id}>{item.claim.slice(0, 32)}</option>)}</select><input value={evidenceCorrection} onChange={(event) => setEvidenceCorrection(event.target.value)} placeholder="说明正确事实或来源" /></div>}
    </section>}
    {message && <p className="task-capability-message success"><Check size={12} />{message}</p>}
    {error && <p className="task-capability-message error">{error}</p>}
  </div>;
}
