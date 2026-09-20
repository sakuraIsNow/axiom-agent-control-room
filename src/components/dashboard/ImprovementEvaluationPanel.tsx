import { useCallback, useEffect, useRef, useState } from 'react';
import { FlaskConical, LoaderCircle, RefreshCw, Square } from 'lucide-react';
import {
  cancelImprovementEvaluation, getImprovementEvaluationSuite, ImprovementApiError,
  listImprovementEvaluations, startImprovementEvaluation,
  type ImprovementEvaluation, type ImprovementEvaluationSuite, type ImprovementProposal,
} from '../../lib/improvementRuntime';
import { useUiLanguage } from '../../lib/uiLanguage';
import { improvementEvaluationText } from '../../lib/improvementPresentation';

const outcomeLabels = {
  unverified: '尚未验证', improved: '样例中有改善', 'no-clear-change': '无明显变化',
  regressed: '样例中出现退化', inconclusive: '证据不足',
} as const;
const statusLabels = { running: '正在对照', completed: '对照完成', failed: '对照未完成', cancelled: '已停止对照' } as const;

/** A separate experiment never changes the proposal's global quality or deploys it. */
export function ImprovementEvaluationPanel({ proposal, disabled = false }: { proposal: ImprovementProposal; disabled?: boolean }) {
  const { t, language } = useUiLanguage();
  const metadata = (value: string) => improvementEvaluationText(value, language);
  const [suite, setSuite] = useState<ImprovementEvaluationSuite | null>(null);
  const [evaluations, setEvaluations] = useState<ImprovementEvaluation[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const lifetime = useRef<AbortController | null>(null);
  const sequence = useRef(0);
  const mutating = useRef(false);
  const requestKey = useRef<{ revision: number; key: string } | null>(null);
  const running = evaluations.find((evaluation) => evaluation.status === 'running');
  const selected = evaluations.find((evaluation) => evaluation.id === selectedId) ?? evaluations[0];

  const refresh = useCallback(async (signal: AbortSignal, foreground = false) => {
    const request = ++sequence.current;
    if (foreground) setLoading(true);
    try {
      const [nextSuite, nextEvaluations] = await Promise.all([
        getImprovementEvaluationSuite(signal), listImprovementEvaluations(proposal.id, signal),
      ]);
      if (signal.aborted || request !== sequence.current) return;
      setSuite(nextSuite); setEvaluations(nextEvaluations); setError('');
      setSelectedId((id) => nextEvaluations.some((evaluation) => evaluation.id === id) ? id : nextEvaluations[0]?.id ?? '');
    } catch (caught) {
      if (!signal.aborted && request === sequence.current) {
        if (caught instanceof ImprovementApiError && [403, 404, 409].includes(caught.status)) {
          setEvaluations([]); setSelectedId(''); setSuite(null);
          setError('原任务或建议已更改，请刷新改进记录。');
        } else setError('对照记录读取失败，请重试。');
      }
    } finally { if (!signal.aborted && request === sequence.current) setLoading(false); }
  }, [proposal.id]);

  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    void refresh(controller.signal, true);
    return () => { controller.abort(); lifetime.current = null; };
  }, [refresh]);

  useEffect(() => {
    if (!running || busy) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (!document.hidden) await refresh(controller.signal);
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 2_000);
    };
    timer = setTimeout(() => void poll(), 2_000);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [running?.id, busy, refresh]);

  const mutate = async (cancel: boolean) => {
    const controller = lifetime.current;
    if (!controller || controller.signal.aborted || mutating.current) return;
    if (cancel ? !running : !confirmed || !suite || Boolean(running)) return;
    mutating.current = true; setBusy(true); setError('');
    // Prevent an older poll from replacing the accepted mutation.
    sequence.current += 1;
    try {
      if (!cancel && requestKey.current?.revision !== proposal.revision) requestKey.current = { revision: proposal.revision, key: crypto.randomUUID() };
      const next = cancel && running
        ? await cancelImprovementEvaluation(proposal.id, running.id, running.revision, controller.signal)
        : await startImprovementEvaluation(proposal.id, proposal.revision, requestKey.current!.key, controller.signal);
      if (controller.signal.aborted) return;
      sequence.current += 1;
      setEvaluations((current) => [next, ...current.filter((evaluation) => evaluation.id !== next.id)]);
      setSelectedId(next.id); setConfirmed(false); requestKey.current = null;
    } catch (caught) {
      if (controller.signal.aborted) return;
      // Preserve the idempotency key on uncertain network failures.
      setError(caught instanceof ImprovementApiError && caught.status === 409
        ? '建议或对照状态已更改，请刷新后重试。' : '操作未完成，请刷新查看对照状态。');
    } finally { mutating.current = false; if (!controller.signal.aborted) { setBusy(false); setLoading(false); } }
  };

  const number = (value: number | null | undefined) => typeof value === 'number' && Number.isFinite(value)
    ? new Intl.NumberFormat(language).format(value) : t('未记录');
  const duration = (value: number | null | undefined) => typeof value === 'number' ? `${(value / 1000).toFixed(1)} s` : t('未记录');
  const date = (value: string) => new Intl.DateTimeFormat(language, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
  const canRun = !disabled && !busy && !loading && Boolean(suite) && !running && ['draft', 'accepted'].includes(proposal.status);
  const summary = selected?.summary;

  return <section className="improvement-evaluation" aria-label={t('独立样例对照')} data-testid="improvement-evaluation">
    <div className="improvement-evaluation-heading"><h3><FlaskConical size={18} />{t('先对照，再决定')}</h3>
      <button type="button" className="improvement-button" aria-label={t('刷新对照记录')} disabled={busy || loading} onClick={() => { if (lifetime.current) void refresh(lifetime.current.signal, true); }}><RefreshCw size={15} /></button>
    </div>
    <p className="improvement-muted">{t('对同一固定样例分别加入或不加入建议；不是原任务重跑。')}</p>
    {error && <div role="alert" className="improvement-error">{t(error)}</div>}
    {loading && !suite && <p className="improvement-muted" role="status">{t('正在读取…')}</p>}
    {suite && <>
      <details className="improvement-tests"><summary>{t('评测范围与用量')} · {suite.cases.length} {t('个样例')}</summary>
        <p>{t('文本契约与模拟场景，不执行真实搜索、文件写入、插件或 Nexus。')}</p>
        <ul>{suite.cases.map((item) => <li key={item.id}>{metadata(item.title)}</li>)}</ul>
        <p>{t('最多模型调用')}：{suite.modelCalls} · {t('每次输出上限')}：{suite.maxOutputTokensPerCall} Token</p>
        <p>{t('固定样例可被重复使用，不是永久盲测，也不代表所有真实任务的提升。')}</p>
      </details>
      {!running && <div className="improvement-evaluation-start">
        <label><input type="checkbox" checked={confirmed} disabled={!canRun} onChange={(event) => setConfirmed(event.target.checked)} />{t('使用原任务模型进行对照，会产生模型用量。')}</label>
        <button type="button" className="improvement-button" disabled={!canRun || !confirmed} onClick={() => void mutate(false)}>{busy ? <LoaderCircle size={16} className="improvement-spinning" /> : <FlaskConical size={16} />}{t('开始对照')}</button>
      </div>}
    </>}
    {running && <div className="improvement-evaluation-progress" role="status"><span><LoaderCircle size={16} className="improvement-spinning" />{t('正在对照')} · {running.progress.completed}/{running.progress.total}</span><button type="button" className="improvement-button" disabled={busy || disabled} onClick={() => void mutate(true)}><Square size={13} />{t('停止对照')}</button><progress max={running.progress.total || 1} value={running.progress.completed} /><p className="improvement-muted">{t('可以离开页面，记录会保留。停止不会退回已经产生的模型用量。')}</p></div>}
    {evaluations.length > 0 && <label className="improvement-evaluation-history">{t('对照记录')}<select aria-label={t('选择对照记录')} value={selected?.id ?? ''} onChange={(event) => setSelectedId(event.target.value)}>{evaluations.map((item) => <option key={item.id} value={item.id}>{date(item.createdAt)} · {t(statusLabels[item.status])}</option>)}</select></label>}
    {selected && summary && <div className="improvement-evaluation-result" data-outcome={selected.qualityStatus}>
      <div className="improvement-evaluation-heading"><strong>{selected.status === 'completed' ? t(outcomeLabels[selected.qualityStatus]) : t(statusLabels[selected.status])}</strong><span className="improvement-muted">{selected.model} · {selected.suiteVersion}</span></div>
      <p className="improvement-muted">{t('结论仅适用于本次样例；未自动采用建议。')}</p>
      <div className="improvement-comparison-scroll"><table className="improvement-comparison"><caption>{t('本次对照结果')}</caption><thead><tr><th scope="col">{t('指标')}</th><th scope="col">{t('未加入建议')}</th><th scope="col">{t('加入建议')}</th></tr></thead><tbody>
        <tr><th scope="row">{t('通过检查')}</th><td>{summary.baselinePassed}/{summary.totalChecks}</td><td>{summary.candidatePassed}/{summary.totalChecks}</td></tr>
        <tr><th scope="row">Token</th><td>{number(summary.baselineTokens)}</td><td>{number(summary.candidateTokens)}</td></tr>
        <tr><th scope="row">{t('模型调用耗时')}</th><td>{duration(summary.baselineLatencyMs)}</td><td>{duration(summary.candidateLatencyMs)}</td></tr>
        <tr><th scope="row">{t('金额与人工干预')}</th><td colSpan={2}>{t('未测量，不以零代替')}</td></tr>
      </tbody></table></div>
      <p className="improvement-muted">{t('改善检查')}：{summary.improvedChecks} · {t('退化检查')}：{summary.regressedChecks}</p>
      {selected.error && <p role="status" className="improvement-muted">{metadata(selected.error)}</p>}
      <details className="improvement-tests"><summary>{t('查看逐项证据')}</summary>{selected.cases.map((item) => <div key={item.fixtureId} className="improvement-evaluation-case"><h4>{metadata(item.title)}</h4><p className="improvement-muted">{metadata(item.scope)}</p><div className="improvement-evaluation-arms">{(['baseline', 'candidate'] as const).map((armName) => {
        const arm = item[armName];
        return <div key={armName}><strong>{t(armName === 'baseline' ? '未加入建议' : '加入建议')}</strong>{!arm ? <p>{t('未执行')}</p> : <><ul>{arm.checks.map((check) => <li key={check.id}><span aria-label={t(check.passed ? '通过' : '未通过')}>{check.passed ? '✓' : '×'}</span> {metadata(check.detail)}</li>)}</ul>{arm.error && <p>{metadata(arm.error)}</p>}<details><summary>{t('查看模型原文')}</summary><pre>{arm.output || t('无输出')}</pre></details></>}</div>;
      })}</div></div>)}</details>
      <details className="improvement-tests"><summary>{t('验证边界')}</summary><ul>{selected.limitations.map((limitation, index) => <li key={index}>{metadata(limitation)}</li>)}</ul><p>{t('评测版本')}：{selected.suiteId} / {selected.suiteVersion}<br />{t('建议版本')}：{selected.proposalRevision}</p></details>
    </div>}
  </section>;
}
