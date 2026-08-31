import { useEffect, useMemo, useRef, type CSSProperties } from 'react';
import { Bot, ShieldCheck, X } from 'lucide-react';
import type { ChatAttachment, UserPlugin } from '../../types';
import { secureArtifactDocument } from '../../lib/chatArtifacts';

export type MiniAppAgentProgress = { content?: string; reset?: boolean; status?: string; attachment?: ChatAttachment };

type Props = {
  plugin: UserPlugin;
  onClose: () => void;
  onAgentRequest: (plugin: UserPlugin, prompt: string, signal: AbortSignal, onProgress: (progress: MiniAppAgentProgress) => void) => Promise<string>;
};

type PluginAgentRequest = { type: 'axiom.plugin.agent.request'; requestId: string; prompt: string };

export function MiniAppWindow({ plugin, onClose, onAgentRequest }: Props) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const activeRequestRef = useRef<AbortController | null>(null);
  const width = plugin.definition.width ?? 720;
  const height = plugin.definition.height ?? 520;
  const srcDoc = useMemo(() => secureArtifactDocument(plugin.definition.htmlContent ?? '', 'html'), [plugin.definition.htmlContent]);
  const style = { '--mini-app-width': `${width}px`, '--mini-app-height': `${height}px` } as CSSProperties;

  useEffect(() => {
    const post = (payload: Record<string, unknown>) => frameRef.current?.contentWindow?.postMessage(payload, '*');
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow || !event.data || typeof event.data !== 'object') return;
      const request = event.data as Partial<PluginAgentRequest>;
      if (request.type !== 'axiom.plugin.agent.request' || typeof request.requestId !== 'string') return;
      const prompt = typeof request.prompt === 'string' ? request.prompt.trim().slice(0, 8_000) : '';
      if (!plugin.definition.agentEnabled) {
        post({ type: 'axiom.plugin.agent.response', requestId: request.requestId, ok: false, error: '此插件未启用平台 Agent。' });
        return;
      }
      if (!prompt) {
        post({ type: 'axiom.plugin.agent.response', requestId: request.requestId, ok: false, error: '请求内容不能为空。' });
        return;
      }
      if (activeRequestRef.current) {
        post({ type: 'axiom.plugin.agent.response', requestId: request.requestId, ok: false, error: 'Agent 正在处理上一条请求。' });
        return;
      }
      const controller = new AbortController();
      activeRequestRef.current = controller;
      post({ type: 'axiom.plugin.agent.delta', requestId: request.requestId, status: 'Agent 正在处理' });
      void onAgentRequest(plugin, prompt, controller.signal, (progress) => {
        post({ type: 'axiom.plugin.agent.delta', requestId: request.requestId, ...progress });
      }).then((content) => {
        post({ type: 'axiom.plugin.agent.response', requestId: request.requestId, ok: true, content });
      }).catch((error) => {
        if (controller.signal.aborted) return;
        post({ type: 'axiom.plugin.agent.response', requestId: request.requestId, ok: false, error: error instanceof Error ? error.message : 'Agent 请求失败。' });
      }).finally(() => {
        if (activeRequestRef.current === controller) activeRequestRef.current = null;
      });
    };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('message', onMessage);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('message', onMessage);
      window.removeEventListener('keydown', onKeyDown);
      activeRequestRef.current?.abort(new DOMException('Plugin closed', 'AbortError'));
      activeRequestRef.current = null;
    };
  }, [onAgentRequest, onClose, plugin]);

  return <div className="mini-app-backdrop" role="presentation">
    <section className="mini-app-window" style={style} role="dialog" aria-modal="true" aria-label={plugin.name}>
      <header className="mini-app-window-bar">
        <span className="mini-app-window-mark">{plugin.definition.agentEnabled ? <Bot size={14} /> : <ShieldCheck size={14} />}</span>
        <strong>{plugin.name}</strong>
        <small>{plugin.definition.agentEnabled ? '平台 Agent 已连接' : '隔离运行'}</small>
        <button type="button" aria-label="关闭插件" onClick={onClose}><X size={17} /></button>
      </header>
      <iframe ref={frameRef} title={plugin.name} srcDoc={srcDoc} sandbox="allow-scripts" referrerPolicy="no-referrer" />
    </section>
  </div>;
}
