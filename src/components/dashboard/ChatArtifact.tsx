import { useMemo, useState } from 'react';
import { Check, Code2, Copy, Download, FileText, MonitorPlay } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { FileAttachment } from '../../types';
import {
  artifactFileName,
  artifactKindForFile,
  artifactKindForLanguage,
  artifactMimeType,
  inferRawArtifactKind,
  secureArtifactDocument,
  type ChatArtifactKind,
} from '../../lib/chatArtifacts';

const labels: Record<ChatArtifactKind, string> = { markdown: 'Markdown', svg: 'SVG', html: 'HTML' };

const saveArtifact = (content: string, fileName: string, kind: ChatArtifactKind) => {
  const url = URL.createObjectURL(new Blob([content], { type: artifactMimeType(kind) }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = artifactFileName(fileName, kind);
  anchor.click();
  URL.revokeObjectURL(url);
};

const BasicMarkdown = ({ content }: { content: string }) => <ReactMarkdown
  remarkPlugins={[remarkGfm]}
  components={{
    table: ({ children }) => <div className="dash-chat-table-wrap"><table>{children}</table></div>,
    a: ({ children, ...props }) => <a {...props} target="_blank" rel="noreferrer">{children}</a>,
  }}
>{content}</ReactMarkdown>;

export function ChatArtifact({ kind, content, name = '对话内容' }: { kind: ChatArtifactKind; content: string; name?: string }) {
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
}

export function ChatFileArtifact({ attachment }: { attachment: FileAttachment }) {
  const kind = artifactKindForFile(attachment.name, attachment.mimeType);
  if (!kind || !attachment.text) return <span className="dash-chat-file-attachment"><FileText size={14} /><span>{attachment.name}</span></span>;
  return <ChatArtifact kind={kind} content={attachment.text} name={attachment.name} />;
}

export function ChatMessageMarkdown({ content }: { content: string }) {
  const rawKind = inferRawArtifactKind(content);
  if (rawKind) return <ChatArtifact kind={rawKind} content={content.trim()} name="Agent 生成内容" />;
  return <ReactMarkdown
    remarkPlugins={[remarkGfm]}
    components={{
      table: ({ children }) => <div className="dash-chat-table-wrap"><table>{children}</table></div>,
      a: ({ children, ...props }) => <a {...props} target="_blank" rel="noreferrer">{children}</a>,
      pre: ({ children }) => <>{children}</>,
      code: ({ className, children, ...props }) => {
        const language = /language-([^\s]+)/.exec(className ?? '')?.[1];
        const artifactKind = artifactKindForLanguage(language);
        const code = String(children).replace(/\n$/, '');
        if (artifactKind) return <ChatArtifact kind={artifactKind} content={code} name={`Agent-${artifactKind}`} />;
        if (language) return <pre><code className={className} {...props}>{children}</code></pre>;
        return <code className={className} {...props}>{children}</code>;
      },
    }}
  >{content}</ReactMarkdown>;
}
