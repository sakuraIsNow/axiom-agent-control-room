import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Check, Copy, FlaskConical, LoaderCircle, RefreshCw, Save, Sparkles, X } from 'lucide-react';
import {
  createImprovement, ImprovementApiError, listImprovements, listImprovementSources, prepareImprovementTrial, updateImprovement,
  type ImprovementProposal, type ImprovementSource, type ImprovementTrialDraft,
} from '../../lib/improvementRuntime';
import { useUiLanguage } from '../../lib/uiLanguage';
import { ImprovementEvaluationPanel } from './ImprovementEvaluationPanel';
import '../../styles/improvements.css';

const statusText = { generating: '正在复盘', draft: '待查看', accepted: '已保存', dismissed: '已忽略', failed: '未完成' } as const;
const targetText = { prompt: '任务描述', routing: '智能体分工', workflow: '执行步骤', verification: '结果核验' } as const;

export function ImprovementWorkspace({ onPrepareConversation, hasExistingDraft = false }: {
  onPrepareConversation: (draft: ImprovementTrialDraft) => void;
  hasExistingDraft?: boolean;
}) {
  const { t, language } = useUiLanguage();
  const [sources, setSources] = useState<ImprovementSource[]>([]);
  const [proposals, setProposals] = useState<ImprovementProposal[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [taskId, setTaskId] = useState('');
  const [parentId, setParentId] = useState('');
  const [note, setNote] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [generatingRequest, setGeneratingRequest] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [prepared, setPrepared] = useState<ImprovementTrialDraft | null>(null);
  const [draftReplacementConfirmed, setDraftReplacementConfirmed] = useState(false);
  const lifetime = useRef<AbortController | null>(null);
  const busyRef = useRef(false);
  const loadSequence = useRef(0);
  const generationKey = useRef<{ signature: string; key: string } | null>(null);
  const selected = proposals.find((proposal) => proposal.id === selectedId) ?? proposals[0] ?? null;
  const generating = proposals.some((proposal) => proposal.status === 'generating');
  const parents = proposals.filter((proposal) => proposal.status === 'accepted' && proposal.generation < 5);

  const load = useCallback(async (signal: AbortSignal, foreground = true) => {
    const sequence = ++loadSequence.current;
    if (foreground) setLoading(true);
    try {
      const [nextSources, nextProposals] = await Promise.all([listImprovementSources(signal), listImprovements(signal)]);
      if (signal.aborted || sequence !== loadSequence.current) return;
      setSources(nextSources);
      setProposals(nextProposals);
      setTaskId((current) => nextSources.some((source) => source.id === current) ? current : nextSources[0]?.id ?? '');
      setSelectedId((current) => nextProposals.some((proposal) => proposal.id === current) ? current : nextProposals[0]?.id ?? '');
      if (foreground) setError('');
    } catch {
      if (!signal.aborted && sequence === loadSequence.current) setError('改进记录读取失败，请刷新重试。');
    } finally {
      if (!signal.aborted && sequence === loadSequence.current && foreground) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    void load(controller.signal);
    return () => { controller.abort(); lifetime.current = null; };
  }, [load]);

  useEffect(() => {
    if (!generating || busy) return;
    const controller = new AbortController();
    let pending = false;
    const timer = window.setInterval(() => {
      if (pending || document.hidden) return;
      pending = true;
      void load(controller.signal, false).finally(() => { pending = false; });
    }, 15_000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [busy, generating, load]);

  useEffect(() => { setPrepared(null); setCopied(false); }, [selectedId]);
  useEffect(() => { setDraftReplacementConfirmed(false); }, [selectedId, hasExistingDraft]);
  useEffect(() => { setParentId(''); }, [taskId]);

  const putProposal = (proposal: ImprovementProposal) => {
    // A completed mutation is newer than any in-flight history fetch.
    loadSequence.current += 1;
    setLoading(false);
    setProposals((current) => [proposal, ...current.filter((item) => item.id !== proposal.id)]);
    setSelectedId(proposal.id);
  };

  const run = async (action: (signal: AbortSignal) => Promise<void>) => {
    const controller = lifetime.current;
    if (!controller || controller.signal.aborted || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      await action(controller.signal);
    } catch (caught) {
      if (controller.signal.aborted) return;
      if (caught instanceof ImprovementApiError && caught.status === 409) {
        setError('建议已在其他页面更改，请刷新后重试。');
      } else if (caught instanceof ImprovementApiError && [403, 404].includes(caught.status)) {
        setError('原任务或建议已不可访问，请刷新列表。');
      } else {
        setError('操作未完成，请先刷新查看记录后重试。');
      }
    } finally {
      busyRef.current = false;
      if (!controller.signal.aborted) setBusy(false);
    }
  };

  const generate = () => {
    if (!taskId || generating) return;
    void run(async (signal) => {
      setGeneratingRequest(true);
      try {
        const signature = JSON.stringify({ taskId, parentId, note: note.trim(), language });
        if (generationKey.current?.signature !== signature) generationKey.current = { signature, key: crypto.randomUUID() };
        const proposal = await createImprovement({
          taskId, note: note.trim() || undefined, parentId: parentId || undefined, language,
          idempotencyKey: generationKey.current.key,
        }, signal);
        if (signal.aborted) return;
        // Keep the same key on an uncertain network result; an explicit new attempt
        // after a persisted failed result can safely receive a new key.
        generationKey.current = null;
        putProposal(proposal);
      } finally {
        if (!signal.aborted) setGeneratingRequest(false);
      }
    });
  };

  const changeStatus = (status: 'accepted' | 'dismissed') => {
    if (!selected) return;
    const proposal = selected;
    void run(async (signal) => {
      const next = await updateImprovement(proposal.id, proposal.revision, status, signal);
      if (!signal.aborted) { putProposal(next); setPrepared(null); }
    });
  };

  const prepare = () => {
    if (!selected) return;
    const proposal = selected;
    void run(async (signal) => {
      const result = await prepareImprovementTrial(proposal.id, proposal.revision, signal);
      if (!signal.aborted) { setPrepared(result); setDraftReplacementConfirmed(false); }
    });
  };

  const copy = () => {
    if (!selected?.analysis) return;
    const analysis = selected.analysis;
    void run(async (signal) => {
      await navigator.clipboard.writeText([
        selected.sourceTitle, analysis.summary,
        ...analysis.changes.map((change) => `${t(targetText[change.target])}: ${change.suggestion}\n${change.reason}`),
        analysis.trialInstruction,
      ].join('\n\n'));
      if (!signal.aborted) setCopied(true);
    });
  };

  const formatNumber = (value: number | null | undefined) => typeof value === 'number' ? new Intl.NumberFormat(language).format(value) : t('未记录');
  const formatDate = (value: string) => new Intl.DateTimeFormat(language, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
  const version = (generation: number) => language === 'en' ? `Version ${generation}` : `第 ${generation} 版`;
  const analysis = selected?.analysis;

  return <div className="improvement-workspace" data-testid="improvement-workspace" data-i18n-ignore="true">
    <header className="improvement-header">
      <div><h1>{t('任务改进')}</h1><p>{t('复盘、对照，再决定是否试用。现有任务保持不变。')}</p></div>
      <button type="button" className="improvement-button" aria-label={t('刷新改进记录')} disabled={loading || busy} onClick={() => { if (lifetime.current) void load(lifetime.current.signal); }}><RefreshCw size={16} />{t('刷新')}</button>
    </header>
    {error && <div className="improvement-error" role="alert"><span>{t(error)}</span><button type="button" aria-label={t('关闭提示')} onClick={() => setError('')}><X size={16} /></button></div>}
    <div className="improvement-layout">
      <aside className="improvement-sidebar">
        <form className="improvement-panel improvement-composer" onSubmit={(event) => { event.preventDefault(); generate(); }}>
          <h2>{t('从一次任务开始')}</h2>
          <label htmlFor="improvement-source">{t('最近已结束任务')}</label>
          <select id="improvement-source" value={taskId} disabled={busy || generating || loading} onChange={(event) => setTaskId(event.target.value)}>
            {!sources.length && <option value="">{t(loading ? '正在读取任务…' : '暂无可复盘的任务')}</option>}
            {sources.map((source) => <option value={source.id} key={source.id}>{source.title}</option>)}
          </select>
          <label htmlFor="improvement-note">{t('想改善什么')}<span>{t('可选')}</span></label>
          <textarea id="improvement-note" value={note} onChange={(event) => setNote(event.target.value)} maxLength={1200} rows={3} disabled={busy || generating} placeholder={t('例如：减少重复搜索，让结论更完整')} />
          {parents.length > 0 && <><label htmlFor="improvement-parent">{t('延续一份建议')}</label><select id="improvement-parent" value={parentId} disabled={busy || generating} onChange={(event) => setParentId(event.target.value)}><option value="">{t('独立复盘')}</option>{parents.map((proposal) => <option value={proposal.id} key={proposal.id}>{proposal.sourceTitle} · {version(proposal.generation)}</option>)}</select></>}
          <button type="submit" className="improvement-button primary" disabled={!taskId || busy || generating || loading}>{busy || generating ? <LoaderCircle size={17} className="improvement-spinning" /> : <Sparkles size={17} />}{t(busy || generating ? '正在处理…' : '生成改进建议')}</button>
          {(generatingRequest || generating) && <p className="improvement-muted" role="status">{t('Agent 正在复盘。可以离开页面，稍后回来查看。')}</p>}
          {!loading && !sources.length && <p className="improvement-muted">{t('先完成一次任务，再来查看如何改进。')}</p>}
        </form>
        <section className="improvement-panel improvement-history" aria-label={t('改进历史')}>
          <div className="improvement-section-heading"><h2>{t('改进历史')}</h2><span>{proposals.length}</span></div>
          {loading && !proposals.length ? <p className="improvement-muted">{t('正在读取…')}</p> : !proposals.length ? <p className="improvement-muted">{t('建议会保存在这里。')}</p> : <div className="improvement-history-list">{proposals.map((proposal) => <button type="button" key={proposal.id} aria-pressed={selected?.id === proposal.id} disabled={busy} onClick={() => setSelectedId(proposal.id)}><strong>{proposal.sourceTitle}</strong><span><em>{t(statusText[proposal.status])}</em><time dateTime={proposal.updatedAt}>{formatDate(proposal.updatedAt)}</time></span></button>)}</div>}
        </section>
      </aside>
      <article className="improvement-panel improvement-detail" aria-label={t('改进建议详情')}>
        {!selected ? <div className="improvement-empty"><FlaskConical size={30} /><h2>{t('让下一次任务更有把握')}</h2><p>{t('选一项已结束的任务，Agent 会结合执行记录提出可验证的建议。')}</p></div> : <>
          <div className="improvement-detail-heading"><div><span className="improvement-eyebrow">{t(statusText[selected.status])} · {version(selected.generation)}</span><h2>{selected.sourceTitle}</h2></div><span className="improvement-unverified">{t('尚未验证')}</span></div>
          <dl className="improvement-metrics"><div><dt>{t('原任务 Agent')}</dt><dd>{selected.baseline.agentCount}</dd></div><div><dt>{t('原任务 Token')}</dt><dd>{formatNumber(selected.baseline.tokens)}</dd></div><div><dt>{t('原任务耗时')}</dt><dd>{selected.baseline.durationMs === null ? t('未记录') : `${Math.round(selected.baseline.durationMs / 1000)} s`}</dd></div><div><dt>{t('本次复盘 Token')}</dt><dd>{formatNumber(selected.usageTokens)}</dd></div></dl>
          {selected.model && <p className="improvement-model">{t('复盘模型')} <span>{selected.model}</span></p>}
          {selected.status === 'generating' && <div className="improvement-empty" role="status"><LoaderCircle size={24} className="improvement-spinning" /><p>{t('Agent 正在复盘执行记录…')}</p></div>}
          {selected.status === 'failed' && <div className="improvement-failed" role="status"><h3>{t('这次复盘未完成')}</h3><p>{t('原任务未被修改。检查模型配置后，可重新生成建议。')}</p>{selected.error && <details><summary>{t('查看原因')}</summary><p>{selected.error}</p></details>}<button className="improvement-button" type="button" disabled={busy || generating || !sources.some((source) => source.id === selected.sourceTaskId)} onClick={() => { setTaskId(selected.sourceTaskId); setParentId(selected.parentId ?? ''); setNote(''); generationKey.current = null; }}>{t('重新选择此任务')}</button></div>}
          {analysis && <>
            <p className="improvement-summary">{analysis.summary}</p>
            <section className="improvement-findings"><h3>{t('执行记录中的线索')}</h3>{analysis.observations.map((observation, index) => <div key={index}><strong>{observation.finding}</strong><blockquote>{observation.evidence}</blockquote></div>)}</section>
            <section className="improvement-changes"><h3>{t('Agent 提出的建议')}</h3>{analysis.changes.map((change, index) => <div key={index}><span>{t(targetText[change.target])}</span><strong>{change.suggestion}</strong><p>{change.reason}</p></div>)}</section>
            <details className="improvement-tests"><summary>{t('建议测试')} <span>{t('未执行')}</span></summary>{analysis.validationCases.map((test, index) => <div key={index}><strong>{test.input}</strong><p>{t('预期行为')}：{test.expectedBehavior}</p></div>)}</details>
            {analysis.risks.length > 0 && <details className="improvement-tests"><summary>{t('需要留意')}</summary><ul>{analysis.risks.map((risk, index) => <li key={index}>{risk}</li>)}</ul></details>}
            <ImprovementEvaluationPanel key={selected.id} proposal={selected} disabled={busy} />
            <div className="improvement-actions">
              {selected.status === 'dismissed' && <button type="button" className="improvement-button primary" disabled={busy} onClick={() => changeStatus('accepted')}><Save size={16} />{t('保存建议')}</button>}
              {selected.status === 'draft' && <><button type="button" className="improvement-button primary" disabled={busy} onClick={() => changeStatus('accepted')}><Save size={16} />{t('保存建议')}</button><button type="button" className="improvement-button" disabled={busy} onClick={() => changeStatus('dismissed')}>{t('忽略建议')}</button></>}
              {selected.status === 'accepted' && <><button type="button" className="improvement-button primary" disabled={busy} onClick={prepare}><ArrowUpRight size={16} />{t('带建议新建对话')}</button><button type="button" className="improvement-button" disabled={busy} onClick={() => changeStatus('dismissed')}>{t('忽略建议')}</button></>}
              <button type="button" className="improvement-button" disabled={busy} onClick={copy}>{copied ? <Check size={16} /> : <Copy size={16} />}{t(copied ? '已复制' : '复制建议')}</button>
            </div>
            {prepared && selected.status === 'accepted' && <section className="improvement-trial" aria-label={t('新对话草稿')}><h3>{t('先检查，再发送')}</h3><p>{t('只填入新对话草稿，不自动发送，不携带附件或原 Nexus 流程。')}</p><textarea aria-label={t('新对话草稿内容')} value={prepared.input} onChange={(event) => setPrepared({ ...prepared, input: event.target.value })} rows={5} /><details><summary>{t('试用提醒')}</summary><ul>{prepared.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>
              {hasExistingDraft && <div className="improvement-draft-warning"><p>{t('你还有未发送文字或附件。继续会替换文字并清除附件，请先返回对话保留原输入和附件。')}</p><label><input type="checkbox" checked={draftReplacementConfirmed} onChange={(event) => setDraftReplacementConfirmed(event.target.checked)} />{t('我已保留原输入和附件')}</label></div>}
              <button type="button" className="improvement-button primary" disabled={busy || !prepared.input.trim() || (hasExistingDraft && !draftReplacementConfirmed)} onClick={() => onPrepareConversation(prepared)}>{t(hasExistingDraft ? '替换输入并打开新对话' : '打开新对话')}</button></section>}
          </>}
        </>}
      </article>
    </div>
  </div>;
}
