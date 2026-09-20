import { createContext, memo, useContext, useEffect, useMemo, useState } from 'react';
import { Check, Code2, Copy, Download, FileText, LoaderCircle, MonitorPlay, RotateCw } from 'lucide-react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { TaskMedia } from './TaskMedia';
import { taskMediaPath } from '../../lib/taskMedia';
import { readTaskFileArtifact, taskFileArtifactPath, type TaskFileArtifact } from '../../lib/taskFileArtifacts';
import { useUiLanguage } from '../../lib/uiLanguage';
import type { FileAttachment } from '../../types';
import {
  artifactFileName,
  artifactKindForFile,
  artifactKindForLanguage,
  artifactMimeType,
  inferRawArtifactKind,
  rawArtifactKindAtStart,
  hasClosedArtifactFence,
  secureArtifactDocument,
  type ChatArtifactKind,
} from '../../lib/chatArtifacts';

const labels: Record<ChatArtifactKind, string> = { markdown: 'Markdown', svg: 'SVG', html: 'HTML' };
const markdownPlugins = [remarkGfm];
const MarkdownSource = createContext({ source: '', streaming: false });

const saveArtifact = (content: string, fileName: string, kind: ChatArtifactKind) => {
  const url = URL.createObjectURL(new Blob([content], { type: artifactMimeType(kind) }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = artifactFileName(fileName, kind);
  anchor.click();
  URL.revokeObjectURL(url);
};

// Renderer functions are React component types. Defining them during a render
// remounts every preview when scrolling, typing or receiving another SSE frame.
const basicMarkdownComponents: Components = {
  table: ({ children }) => <div className="dash-chat-table-wrap"><table>{children}</table></div>,
  img: ({ src, alt }) => <TaskMedia src={src} alt={alt} />,
  a: ({ children, node: _node, ...props }) => taskMediaPath(props.href, window.location.origin) ? <TaskMedia src={props.href}>{children}</TaskMedia> : <a {...props} target="_blank" rel="noreferrer">{children}</a>,
};

const BasicMarkdown = memo(function BasicMarkdown({ content }: { content: string }) { return <ReactMarkdown
  remarkPlugins={markdownPlugins}
  components={basicMarkdownComponents}
>{content}</ReactMarkdown>;
});

export const ChatArtifact = memo(function ChatArtifact({ kind, content, name = '对话内容' }: { kind: ChatArtifactKind; content: string; name?: string }) {
  const [copied, setCopied] = useState(false);
  const srcDoc = useMemo(() => kind === 'markdown' ? '' : secureArtifactDocument(content, kind), [content, kind]);
  const copy = async () => {
    await navigator.clipboard.writeText(content);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_600);
  };
  return <section className={`dash-chat-artifact ${kind}`}>
    <header>
      <span>{kind === 'markdown' ? <FileText size={14} /> : kind === 'svg' ? <Code2 size={14} /> : <MonitorPlay size={14} />}{labels[kind]}</span>
      <div>
        <button type="button" title="复制源码" aria-label={`复制 ${labels[kind]} 源码`} onClick={() => { void copy(); }}>{copied ? <Check size={14} /> : <Copy size={14} />}</button>
        <button type="button" title="下载" aria-label={`下载 ${labels[kind]}`} onClick={() => saveArtifact(content, name, kind)}><Download size={14} /></button>
      </div>
    </header>
    <div className="dash-chat-artifact-stage">
      {kind === 'markdown'
        ? <div className="dash-chat-artifact-markdown"><BasicMarkdown content={content} /></div>
        : <iframe title={`${name} ${labels[kind]} 预览`} srcDoc={srcDoc} sandbox={kind === 'html' ? 'allow-scripts' : ''} referrerPolicy="no-referrer" />}
    </div>
  </section>;
});

export function ChatFileArtifact({ attachment }: { attachment: FileAttachment }) {
  const kind = artifactKindForFile(attachment.name, attachment.mimeType);
  if (attachment.dataUrl) return <a className="dash-chat-file-attachment downloadable" href={attachment.dataUrl} download={attachment.name}>
    <FileText size={14} />
    <span><strong>{attachment.name}</strong><small>{attachment.size > 0 ? `${Math.max(1, Math.round(attachment.size / 1024))} KB` : '报告文件'}</small></span>
    <Download size={14} />
  </a>;
  if (!kind || !attachment.text) return <span className="dash-chat-file-attachment"><FileText size={14} /><span>{attachment.name}</span></span>;
  return <ChatArtifact kind={kind} content={attachment.text} name={attachment.name} />;
}

function TaskFileArtifactPreview({ path }: { path: string }) {
  const { language } = useUiLanguage();
  const zh = language === 'zh-CN';
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ path: string; attempt: number; artifact?: TaskFileArtifact; error?: boolean } | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void readTaskFileArtifact(path, controller.signal).then((artifact) => {
      if (!controller.signal.aborted) setState({ path, attempt, artifact });
    }).catch(() => { if (!controller.signal.aborted) setState({ path, attempt, error: true }); });
    return () => controller.abort();
  }, [path, attempt]);
  const current = state?.path === path && state.attempt === attempt ? state : null;
  if (!current?.artifact) return <section className="dash-chat-artifact" data-testid="task-file-artifact-status">
    <header><span role="status">{current?.error ? <FileText size={14} /> : <LoaderCircle size={14} />}{current?.error ? (zh ? '文件暂不可用' : 'File unavailable') : (zh ? '正在打开作品' : 'Opening artifact')}</span>
      {current?.error && <button type="button" onClick={() => setAttempt((value) => value + 1)}><RotateCw size={14} />{zh ? '重试' : 'Retry'}</button>}
    </header>
  </section>;
  const { content, mimeType, filename } = current.artifact;
  const kind = artifactKindForFile(filename, mimeType);
  if (kind) return <ChatArtifact kind={kind} content={content} name={filename} />;
  const download = () => {
    const url = URL.createObjectURL(new Blob([content], { type: `${mimeType};charset=utf-8` }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click(); URL.revokeObjectURL(url);
  };
  const copy = async () => { await navigator.clipboard.writeText(content); setCopied(true); window.setTimeout(() => setCopied(false), 1_600); };
  return <section className="dash-chat-artifact" data-testid="task-file-artifact-text">
    <header><span><FileText size={14} />{filename}</span><div>
      <button type="button" title={zh ? '复制' : 'Copy'} aria-label={zh ? '复制文本' : 'Copy text'} onClick={() => { void copy(); }}>{copied ? <Check size={14} /> : <Copy size={14} />}</button>
      <button type="button" title={zh ? '下载' : 'Download'} aria-label={zh ? '下载文本' : 'Download text'} onClick={download}><Download size={14} /></button>
    </div></header><pre>{content}</pre>
  </section>;
}

function PendingArtifact({ kind }: { kind: ChatArtifactKind }) {
  const { language } = useUiLanguage();
  return <section className={`dash-chat-artifact ${kind}`} data-i18n-ignore="true" data-testid="chat-artifact-generating">
    <header><span><MonitorPlay size={14} />{labels[kind]}</span></header>
    <div className="dash-chat-artifact-stage dash-chat-artifact-pending" role="status">{language === 'zh-CN' ? '正在生成作品…' : 'Creating artifact…'}</div>
  </section>;
}

const MarkdownCode: NonNullable<Components['code']> = ({ className, children, node, ...props }) => {
  const { source, streaming } = useContext(MarkdownSource);
  const language = /language-([^\s]+)/.exec(className ?? '')?.[1];
  const artifactKind = artifactKindForLanguage(language);
  const code = String(children).replace(/\n$/, '');
  if (artifactKind) {
    if (streaming && artifactKind !== 'markdown' && !hasClosedArtifactFence(source, node?.position, code)) return <PendingArtifact kind={artifactKind} />;
    return <ChatArtifact kind={artifactKind} content={code} name={`Agent-${artifactKind}`} />;
  }
  if (language) return <pre><code className={className} {...props}>{children}</code></pre>;
  return <code className={className} {...props}>{children}</code>;
};

const chatMarkdownComponents: Components = {
  ...basicMarkdownComponents,
  p: ({ node, children }) => node?.children.some((child) => child.type === 'element' && child.tagName === 'a'
    && typeof child.properties.href === 'string' && taskFileArtifactPath(child.properties.href, window.location.origin))
    ? <div className="dash-chat-artifact-paragraph">{children}</div> : <p>{children}</p>,
  a: ({ children, node: _node, ...props }) => {
    const artifactPath = taskFileArtifactPath(props.href, window.location.origin);
    if (artifactPath) return <TaskFileArtifactPreview path={artifactPath} />;
    return taskMediaPath(props.href, window.location.origin) ? <TaskMedia src={props.href}>{children}</TaskMedia> : <a {...props} target="_blank" rel="noreferrer">{children}</a>;
  },
  pre: ({ children }) => <>{children}</>,
  code: MarkdownCode,
};

export const ChatMessageMarkdown = memo(function ChatMessageMarkdown({ content, streaming = false }: { content: string; streaming?: boolean }) {
  const source = useMemo(() => ({ source: content, streaming }), [content, streaming]);
  const rawKind = inferRawArtifactKind(content);
  const pendingRawKind = streaming ? rawArtifactKindAtStart(content) : null;
  if (pendingRawKind) return <PendingArtifact kind={pendingRawKind} />;
  if (rawKind) return <ChatArtifact kind={rawKind} content={content.trim()} name="Agent 生成内容" />;
  return <MarkdownSource.Provider value={source}><div className="dash-chat-markdown" data-i18n-ignore="true"><ReactMarkdown
    remarkPlugins={markdownPlugins}
    components={chatMarkdownComponents}
  >{content}</ReactMarkdown></div></MarkdownSource.Provider>;
});
