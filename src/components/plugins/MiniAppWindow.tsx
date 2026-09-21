import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Bot, LoaderCircle, RefreshCw, ShieldCheck, X } from 'lucide-react';
import type { ChatAttachment, UserPlugin } from '../../types';
import { secureArtifactDocument } from '../../lib/chatArtifacts';
import { getTaskHumanSnapshot } from '../../lib/taskActionRuntime';
import { miniAppTaskOutput } from '../../lib/miniAppExecution';
import { taskHasPartialDelivery } from '../../lib/taskDelivery';
import { translateUiText, useUiLanguage } from '../../lib/uiLanguage';
import { TaskActionPanel } from '../dashboard/TaskActionPanel';
import './mini-app-recovery.css';

export type MiniAppAgentProgress = { content?: string; reset?: boolean; status?: string; attachment?: ChatAttachment; taskId?: string; sequence?: number; completionStatus?: 'complete' | 'partial' };

type Props = {
  plugin: UserPlugin;
  onClose: () => void;
  onAgentRequest: (plugin: UserPlugin, prompt: string, signal: AbortSignal, onProgress: (progress: MiniAppAgentProgress) => void) => Promise<string>;
  onAgentResume?: (taskId: string, signal: AbortSignal, onProgress: (progress: MiniAppAgentProgress) => void, afterSequence?: number) => Promise<string>;
};

type PluginAgentRequest = { type: 'axiom.plugin.agent.request'; requestId: string; prompt: string };

export function MiniAppWindow({ plugin, onClose, onAgentRequest, onAgentResume }: Props) {
  const titleId = useId();
  const { language } = useUiLanguage();
  const zh = language === 'zh-CN';
  const frameRef = useRef<HTMLIFrameElement>(null);
  const activeRequestRef = useRef<AbortController | null>(null);
  const callbacks = useRef({ plugin, onClose, onAgentRequest, onAgentResume, language });
  callbacks.current = { plugin, onClose, onAgentRequest, onAgentResume, language };
  const activeTaskRef = useRef<{ pluginId: string; taskId: string; requestId: string; sequence: number; status?: string; completionStatus?: 'complete' | 'partial'; reconnect?: boolean } | null>(null);
  const [taskView, setTaskView] = useState<typeof activeTaskRef.current>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const width = plugin.definition.width ?? 720;
  const height = plugin.definition.height ?? 520;
  const srcDoc = useMemo(() => secureArtifactDocument(plugin.definition.htmlContent ?? '', 'html'), [plugin.definition.htmlContent]);
  const style = { '--mini-app-width': `${width}px`, '--mini-app-height': `${height}px` } as CSSProperties;
  const post = (payload: Record<string, unknown>) => frameRef.current?.contentWindow?.postMessage(payload, '*');
  const progressFor = (requestId: string, pluginId: string) => (progress: MiniAppAgentProgress) => {
    if (callbacks.current.plugin.id !== pluginId) return;
    if (progress.taskId || activeTaskRef.current?.requestId === requestId) {
      const previous = activeTaskRef.current;
      const next = { pluginId, requestId, taskId: progress.taskId ?? previous!.taskId, sequence: progress.sequence ?? previous?.sequence ?? 0, status: progress.status ?? previous?.status, completionStatus: progress.completionStatus ?? previous?.completionStatus };
      activeTaskRef.current = next; setTaskView(next);
    }
    post({ type: 'axiom.plugin.agent.delta', requestId, ...progress,
      ...(progress.status ? { status: translateUiText(progress.status, callbacks.current.language) } : {}) });
  };
  const finishRequest = async (promise: Promise<string>, controller: AbortController, requestId: string, pluginId: string) => {
    const retain = (current: NonNullable<typeof activeTaskRef.current>, status?: string) => {
      const needsReview = Boolean(status && ['paused', 'awaiting_approval', 'waiting_for_human'].includes(status));
      activeTaskRef.current = { ...current, status: status ?? 'connection-unknown', reconnect: !needsReview };
      setTaskView(activeTaskRef.current);
      post({ type: 'axiom.plugin.agent.delta', requestId, status: needsReview ? '任务等待你处理后继续' : '连接已中断，任务已保留，可重新连接' });
    };
    try {
      let content = await promise;
      if (controller.signal.aborted || callbacks.current.plugin.id !== pluginId) return;
      const current = activeTaskRef.current;
      let completionStatus = current?.completionStatus ?? 'complete';
      if (current?.requestId === requestId) {
        const snapshot = await getTaskHumanSnapshot(current.taskId, controller.signal).catch(() => null);
        if (controller.signal.aborted || callbacks.current.plugin.id !== pluginId) return;
        if (!snapshot || !['completed', 'failed', 'cancelled'].includes(snapshot.task.status)) { retain(current, snapshot?.task.status); return; }
        content = miniAppTaskOutput(snapshot.task);
        completionStatus = taskHasPartialDelivery(snapshot.task) ? 'partial' : 'complete';
      }
      post({ type: 'axiom.plugin.agent.response', requestId, ok: true, content, completionStatus });
      activeTaskRef.current = null; setTaskView(null);
    } catch (error) {
      if (controller.signal.aborted || callbacks.current.plugin.id !== pluginId) return;
      const current = activeTaskRef.current;
      if (current?.requestId === requestId) {
        const snapshot = await getTaskHumanSnapshot(current.taskId, controller.signal).catch(() => null);
        if (controller.signal.aborted || callbacks.current.plugin.id !== pluginId) return;
        if (!snapshot || !['completed', 'failed', 'cancelled'].includes(snapshot.task.status)) { retain(current, snapshot?.task.status); return; }
        if (snapshot.task.status === 'completed' && snapshot.task.result?.trim()) {
          post({ type: 'axiom.plugin.agent.response', requestId, ok: true, content: miniAppTaskOutput(snapshot.task), completionStatus: taskHasPartialDelivery(snapshot.task) ? 'partial' : 'complete' });
          activeTaskRef.current = null; setTaskView(null); return;
        }
      }
      post({ type: 'axiom.plugin.agent.response', requestId, ok: false, error: error instanceof Error ? error.message : 'Agent 请求失败。' });
      activeTaskRef.current = null; setTaskView(null);
    } finally {
      if (activeRequestRef.current === controller) activeRequestRef.current = null;
      if (callbacks.current.plugin.id === pluginId) setReconnecting(false);
    }
  };
  const resumeTask = async (taskId: string, afterSequence?: number) => {
    const current = activeTaskRef.current;
    if (!current || current.taskId !== taskId || activeRequestRef.current || !callbacks.current.onAgentResume) return;
    const controller = new AbortController(); activeRequestRef.current = controller;
    setReconnecting(true);
    void finishRequest(callbacks.current.onAgentResume(taskId, controller.signal, progressFor(current.requestId, current.pluginId), Math.max(current.sequence, afterSequence ?? 0)), controller, current.requestId, current.pluginId);
  };

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow || !event.data || typeof event.data !== 'object') return;
      const request = event.data as Partial<PluginAgentRequest>;
      if (request.type !== 'axiom.plugin.agent.request' || typeof request.requestId !== 'string') return;
      const prompt = typeof request.prompt === 'string' ? request.prompt.trim().slice(0, 8_000) : '';
      if (!callbacks.current.plugin.definition.agentEnabled) {
        post({ type: 'axiom.plugin.agent.response', requestId: request.requestId, ok: false, error: '此插件未启用平台 Agent。' });
        return;
      }
      if (!prompt) {
        post({ type: 'axiom.plugin.agent.response', requestId: request.requestId, ok: false, error: '请求内容不能为空。' });
        return;
      }
      if (activeRequestRef.current || activeTaskRef.current) {
        if (activeTaskRef.current?.requestId === request.requestId) {
          post({ type: 'axiom.plugin.agent.delta', requestId: request.requestId, status: '原任务仍保留，请先处理或重新连接' });
          return;
        }
        post({ type: 'axiom.plugin.agent.response', requestId: request.requestId, ok: false, error: 'Agent 正在处理上一条请求。' });
        return;
      }
      const controller = new AbortController();
      activeRequestRef.current = controller;
      post({ type: 'axiom.plugin.agent.delta', requestId: request.requestId, status: 'Agent 正在处理' });
      const selectedPlugin = callbacks.current.plugin;
      void finishRequest(callbacks.current.onAgentRequest(selectedPlugin, prompt, controller.signal, progressFor(request.requestId, selectedPlugin.id)), controller, request.requestId, selectedPlugin.id);
    };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape' && !document.querySelector('[role="alertdialog"]')) callbacks.current.onClose(); };
    window.addEventListener('message', onMessage);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('message', onMessage);
      window.removeEventListener('keydown', onKeyDown);
      activeRequestRef.current?.abort(new DOMException('Plugin closed', 'AbortError'));
      activeRequestRef.current = null;
      activeTaskRef.current = null;
      setTaskView(null);
    };
  }, [plugin.id, srcDoc]);

  return <div className="mini-app-backdrop" role="presentation">
    <section className={`mini-app-window ${taskView?.pluginId === plugin.id ? 'has-task-actions' : ''}`} style={style} role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <header className="mini-app-window-bar">
        <span className="mini-app-window-mark">{plugin.definition.agentEnabled ? <Bot size={14} /> : <ShieldCheck size={14} />}</span>
        <strong id={titleId} data-i18n-ignore="true">{plugin.name}</strong>
        <small>{plugin.definition.agentEnabled ? '平台 Agent 已连接' : '隔离运行'}</small>
        <button type="button" aria-label="关闭插件" onClick={onClose}><X size={17} /></button>
      </header>
      <div className="mini-app-content"><iframe ref={frameRef} title={plugin.name} data-i18n-ignore="true" srcDoc={srcDoc} sandbox="allow-scripts" referrerPolicy="no-referrer" />
      {taskView?.pluginId === plugin.id && <aside className="mini-app-task-actions">{taskView.reconnect && <div className="mini-app-reconnect" data-i18n-ignore="true"><span>{zh ? '连接中断，原任务已保留' : 'Connection lost. Your task is preserved.'}</span><button type="button" disabled={reconnecting || !onAgentResume} onClick={() => void resumeTask(taskView.taskId)}>{reconnecting ? <LoaderCircle size={14} /> : <RefreshCw size={14} />}{zh ? '重新连接' : 'Reconnect'}</button></div>}<TaskActionPanel taskId={taskView.taskId} refreshKey={taskView.status} onChanged={resumeTask} /></aside>}</div>
    </section>
  </div>;
}
