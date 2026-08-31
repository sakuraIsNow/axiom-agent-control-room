import { useLayoutEffect, useMemo, useRef } from 'react';
import { Bot, Check, Copy, FileText, MessageSquareText, Paperclip, Pause, Play, Plus, RotateCcw, Trash2, UserCheck, X } from 'lucide-react';
import { MorphIcon } from 'morphicons/react';
import type { AgentGraph, AgentMode, AgentPhase, FileAttachment, ImageAttachment, Session, TopologyAgent } from '../../types';
import type { ReviewResultState } from './dashboardTypes';
import { AgentSignalGraph } from './AgentSignalGraph';
import { InferenceOrb } from './InferenceOrb';
import { ChatFileArtifact, ChatMessageMarkdown } from './ChatArtifact';

const modeLabel: Record<AgentMode, string> = { analyze: '分析', build: '构建', decide: '决策' };
const phaseLabel: Record<AgentPhase, string> = {
  idle: '待命', routing: '任务路由', context: '整理上下文', inference: 'Agent 执行', complete: '已完成', error: '执行异常',
};
const sendIcon = 'M5 12h14M13 6l6 6-6 6';
const stopIcon = 'M7 7h10v10H7Z';

const formatLastConversation = (timestamp: number) => {
  const value = new Date(timestamp);
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startValue = new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const time = value.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  if (startValue === startToday) return `今天 ${time}`;
  if (startValue === startToday - 86_400_000) return `昨天 ${time}`;
  return `${value.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })} ${time}`;
};

type Props = {
  sessions: Session[];
  activeSession: Session;
  provider: string;
  phase: AgentPhase;
  mode: AgentMode;
  draft: string;
  isRunning: boolean;
  agentActivity: string;
  error: string | null;
  onDraftChange: (value: string) => void;
  onModeChange: (mode: AgentMode) => void;
  onSend: () => void;
  onStop: () => void;
  onPause: () => void;
  onResume: () => void;
  onNewTask: () => void;
  onSelectSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => void;
  attachments: Array<ImageAttachment | FileAttachment>;
  onAddAttachments: (files: FileList | null) => void;
  onRemoveAttachment: (id: string) => void;
  agents: TopologyAgent[];
  graph: AgentGraph | null;
  selectedNodeId: string | null;
  onSelectAgent: (id: string) => void;
  reviewResult: ReviewResultState | null;
  reviewNote: string;
  reviewBusy: boolean;
  onReviewNoteChange: (value: string) => void;
  onRequestApprove: () => void;
  onRequestReject: () => void;
};

export function DashboardChat(props: Props) {
  const {
    sessions, activeSession, provider, phase, mode, draft, isRunning, agentActivity, error, onDraftChange, onModeChange,
    onSend, onStop, onPause, onResume, onNewTask, onSelectSession, onDeleteSession, attachments, onAddAttachments, onRemoveAttachment,
    agents, graph, selectedNodeId, onSelectAgent, reviewResult, reviewNote, reviewBusy, onReviewNoteChange, onRequestApprove, onRequestReject,
  } = props;
  const messageListRef = useRef<HTMLDivElement>(null);
  const sortedSessions = useMemo(() => {
    const latestById = new Map<string, Session>();
    sessions.forEach((session) => {
      const previous = latestById.get(session.id);
      if (!previous || session.updatedAt >= previous.updatedAt) latestById.set(session.id, session);
    });
    return [...latestById.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }, [sessions]);

  useLayoutEffect(() => {
    const list = messageListRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [activeSession.id, activeSession.messages]);

  const runningAgent = agents.find((agent) => agent.status === 'running');
  const pendingActivity = agentActivity || (runningAgent
    ? `${runningAgent.label}正在执行${runningAgent.title ? `“${runningAgent.title}”` : '当前步骤'}`
    : phase === 'routing'
      ? '路由 Agent 正在识别任务类型'
      : phase === 'context'
        ? '上下文 Agent 正在整理资料'
        : '执行 Agent 正在组织回答');
  const reviewIssues = reviewResult
    ? [...reviewResult.requiredCorrections, ...reviewResult.gaps].filter(Boolean).slice(0, 3)
    : [];

  return <section className="dash-chat-workspace" aria-label="对话工作区">
    <div className="dash-chat-side">
      <aside className="dash-chat-sessions">
        <div className="dash-chat-sessions-head">
          <span><MessageSquareText size={14} />最近对话</span>
          <button type="button" title="新建对话" onClick={onNewTask}><Plus size={14} /></button>
        </div>
        <div className="dash-chat-session-list">
          {sortedSessions.map((session) => <div key={session.id} data-session-id={session.id} data-updated-at={session.updatedAt} className={`dash-chat-session-item ${session.id === activeSession.id ? 'selected' : ''}`}>
            <button type="button" className="dash-chat-session-main" onClick={() => onSelectSession(session.id)}>
              <strong>{session.title || '新对话'}</strong>
              <span>{formatLastConversation(session.updatedAt)}</span>
            </button>
            <button
              type="button"
              className="dash-chat-session-delete"
              title="删除会话"
              aria-label={`删除会话 ${session.title || '新对话'}`}
              onClick={() => onDeleteSession(session.id)}
            ><Trash2 size={13} /></button>
          </div>)}
        </div>
      </aside>
      <AgentSignalGraph agents={agents} graph={graph} phase={phase} selectedNodeId={selectedNodeId} onSelectAgent={onSelectAgent} />
    </div>

    <div className="dash-chat-panel">
      <header className="dash-chat-head">
        <div><span className={`dash-chat-live ${isRunning ? 'active' : ''}`} /><div><strong>{activeSession.title || '新对话'}</strong><small>{phaseLabel[phase]}</small></div></div>
        <span className="dash-current-model"><Bot size={13} />当前模型 <strong>{provider}</strong></span>
      </header>

      <div ref={messageListRef} className="dash-chat-messages">
        {activeSession.messages.length === 0 && <div className="dash-chat-empty"><MessageSquareText size={22} /><strong>开始对话</strong></div>}
        {activeSession.messages.map((message) => <article key={message.id} className={`dash-chat-message ${message.role} ${message.pending ? 'pending' : ''}`}>
          <div className="dash-chat-message-meta"><span>{message.role === 'user' ? '你' : provider}</span><time>{new Date(message.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time></div>
          <div className="dash-chat-message-content">
            {message.attachments && message.attachments.length > 0 && <div className="dash-chat-attachments">
              {message.attachments.map((attachment) => attachment.kind === 'video'
                ? <div key={attachment.id} className="dash-chat-video-attachment"><video controls preload="metadata" src={attachment.url} poster={attachment.poster} aria-label={attachment.alt} /><a href={attachment.url} target="_blank" rel="noreferrer">打开视频</a></div>
                : attachment.kind === 'file'
                  ? <ChatFileArtifact key={attachment.id} attachment={attachment} />
                  : <a key={attachment.id} className="dash-chat-image-attachment" href={attachment.url} target="_blank" rel="noreferrer"><img src={attachment.url} alt={attachment.alt} /></a>)}
            </div>}
            {message.pending && <span className="dash-chat-thinking" role="status" aria-live="polite"><InferenceOrb size={message.content ? 34 : 46} /><span>{pendingActivity}</span></span>}
            {message.content && <ChatMessageMarkdown content={message.content} />}
          </div>
          {message.content && <button type="button" className="dash-chat-copy" title="复制" onClick={() => void navigator.clipboard.writeText(message.content)}><Copy size={12} /></button>}
        </article>)}
        {reviewResult && <section className="dash-chat-review" data-testid="chat-human-review-controls" aria-labelledby="dash-chat-review-title">
          <header>
            <span className="dash-chat-review-icon"><UserCheck size={17} /></span>
            <div><strong id="dash-chat-review-title">需要你决定下一步</strong><span>质量审查未通过，Agent 已暂停在交付前。</span></div>
            <em>{reviewResult.score}/100</em>
          </header>
          {reviewIssues.length > 0 && <ul>{reviewIssues.map((issue) => <li key={issue}>{issue}</li>)}</ul>}
          <textarea
            value={reviewNote}
            onChange={(event) => onReviewNoteChange(event.target.value)}
            rows={2}
            maxLength={2000}
            disabled={reviewBusy}
            aria-label="审核意见"
            placeholder="补充整改要求（可选）"
          />
          <div className="dash-chat-review-actions">
            <button type="button" className="revise" onClick={onRequestReject} disabled={reviewBusy}><RotateCcw size={14} />继续整改</button>
            <button type="button" className="deliver" onClick={onRequestApprove} disabled={reviewBusy}><Check size={15} />按当前结果交付</button>
          </div>
        </section>}
        {error && <div className="dash-chat-error">{error}</div>}
      </div>

      <footer className="dash-chat-composer">
        {attachments.length > 0 && <div className="dash-chat-pending-attachments">{attachments.map((attachment) => <span key={attachment.id}><FileText size={12} />{'url' in attachment ? attachment.alt : attachment.name}<button type="button" title="移除附件" onClick={() => onRemoveAttachment(attachment.id)}><X size={11} /></button></span>)}</div>}
        <textarea
          value={draft}
          rows={2}
          disabled={isRunning}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); onSend(); } }}
          placeholder={isRunning ? 'Agent 正在处理当前消息…' : '输入消息，Enter 发送，Shift + Enter 换行'}
        />
        <div className="dash-chat-composer-foot">
          <div className="dash-chat-modes">{(['analyze', 'build', 'decide'] as AgentMode[]).map((item) => <button key={item} type="button" className={item === mode ? 'active' : ''} disabled={isRunning} onClick={() => onModeChange(item)}>{modeLabel[item]}</button>)}</div>
          <div className="dash-chat-controls">
            <label className="dash-chat-attach" title="添加图片或文件"><Paperclip size={15} /><input type="file" hidden multiple accept="image/*,.txt,.md,.markdown,.svg,.html,.htm,.pdf,.doc,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" onChange={(event) => { onAddAttachments(event.target.files); event.target.value = ''; }} /></label>
            {isRunning ? <><button type="button" onClick={onPause}><Pause size={13} />暂停</button><button type="button" className="stop" onClick={onStop}>停止</button></> : <button type="button" onClick={onResume} disabled><Play size={13} />继续</button>}
            <button type="button" className="send" onClick={isRunning ? onStop : onSend} disabled={!isRunning && !draft.trim()} aria-label={isRunning ? '停止生成' : '发送消息'}><MorphIcon icon={isRunning ? stopIcon : sendIcon} size={17} strokeWidth={2} spring="snappy" reducedMotion="user" /></button>
          </div>
        </div>
      </footer>
    </div>
  </section>;
}
